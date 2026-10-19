import { createHmac, randomUUID } from 'node:crypto';
import { Effect, Redacted } from 'effect';
import { SqlClient } from 'effect/sql';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { postgresTest } from '../support/postgres.js';
import { FakeGitHub } from '../support/github.js';
import { pilot, base, revision } from '../support/projects.js';
import { migrate } from '../../src/adapters/postgres/migrations.js';
import { builtinModules } from '../../src/app/modules.js';
import { schedule } from '../../src/kernel/scheduler.js';
import { workOnce } from '../../src/kernel/worker.js';
import { JobStore } from '../../src/kernel/contracts/persistence.js';
import { GitHubProvider } from '../../src/modules/ci/contracts.js';
import {
  CatalogStore,
  PageFetcher,
} from '../../src/modules/catalog/contracts.js';
import { webhookServer } from '../../src/adapters/http/webhooks.js';
import type { Settings } from '../../src/app/config/service.js';
import { decodeProjects } from '../../src/app/config/registry.js';

describe.skipIf(!process.env.TEST_DATABASE_URL)(
  'webhook → persistent modules → isolated Actions evidence',
  () => {
    const db = postgresTest();
    const run = db.runtime.runPromise;
    const project = {
      ...pilot(),
      repository: 'test/pilot',
      repositoryId: 7,
      aliases: [],
    };
    project.packages = { nginx: project.packages.nginx };
    const settings: Settings = {
      mode: 'prepare',
      revision,
      version: base,
      projects: [project],
      bindings: {
        [project.repository]: { repositoryId: 7, installationId: 8 },
      },
      schedulerSeconds: 300,
      appLogin: 'ryro[bot]',
      host: '127.0.0.1',
      port: 0,
      webhookSecret: Redacted.make('s'.repeat(32)),
      databaseUrl: 'unused',
      localDatabase: true,
    };
    const registry = builtinModules(settings),
      api = new FakeGitHub(project);
    const provider = GitHubProvider.of({
      configured: () => true,
      forRepository: () => api,
    });
    const execute = () =>
      run(
        workOnce(registry).pipe(
          Effect.provideService(GitHubProvider, provider),
          Effect.provideService(PageFetcher, {
            fetch: async () => ({
              body: Buffer.from(
                '<a href="nginx-2.0.0.tar.gz">stable</a><a href="nginx-2.1.0-rc1.tar.gz">pre</a>',
              ),
              headers: new Headers(),
            }),
          }),
        ),
      );
    const drain = async () => {
      for (let i = 0; i < 30; i++) if (!(await execute())) return;
      throw new Error('queue did not drain');
    };
    let server: ReturnType<typeof webhookServer>, endpoint: string;
    beforeAll(async () => {
      await db.create();
      await run(migrate);
      const jobs = await run(JobStore);
      server = webhookServer(
        settings,
        (id, repo, event, body) =>
          run(
            jobs.receive(
              id,
              repo,
              event,
              body,
              registry.webhook(repo, event, JSON.parse(body.toString())),
            ),
          ),
        () => run(jobs.healthy),
      );
      await new Promise<void>((resolve) =>
        server.listen(0, '127.0.0.1', resolve),
      );
      endpoint =
        'http://127.0.0.1:' + (server.address() as { port: number }).port;
    });
    afterAll(async () => {
      if (server)
        await new Promise<void>((resolve) => server.close(() => resolve()));
      await db.dispose();
    });
    const webhook = async (
      event: string,
      payload: unknown = {},
      id = randomUUID(),
    ) => {
      const bytes = JSON.stringify({
        repository: { id: 7, full_name: 'test/renamed' },
        installation: { id: 8 },
        ...(payload as object),
      });
      return fetch(endpoint + '/github/webhook', {
        method: 'POST',
        headers: {
          'x-github-event': event,
          'x-github-delivery': id,
          'x-hub-signature-256':
            'sha256=' +
            createHmac('sha256', 's'.repeat(32)).update(bytes).digest('hex'),
        },
        body: bytes,
      });
    };
    it('persists before acknowledging and rejects forged signatures', async () => {
      expect((await fetch(endpoint + '/healthz')).status).toBe(200);
      expect(
        (
          await fetch(endpoint + '/github/webhook', {
            method: 'POST',
            body: '{}',
          })
        ).status,
      ).toBe(401);
      const id = randomUUID();
      expect((await webhook('push', {}, id)).status).toBe(202);
      expect((await webhook('push', {}, id)).status).toBe(202);
      const deliveries = await run(
        Effect.gen(function* () {
          const sql = yield* SqlClient.SqlClient;
          return yield* sql`SELECT count(*)::int AS count FROM deliveries`;
        }),
      );
      expect(deliveries[0].count).toBe(1);
    });
    it('discovers versions, prepares once and releases the worker while CI runs', async () => {
      await run(
        schedule(registry).pipe(
          Effect.provideService(GitHubProvider, provider),
        ),
      );
      await drain();
      const batches = await run(
        Effect.flatMap(CatalogStore, (s) => s.batches(project.repository)),
      );
      expect(batches).toHaveLength(1);
      expect(batches[0]).toMatchObject({ run_id: '42', status: 'preparing' });
      expect(batches[0].intent.versions).toEqual(['2.0.0', '2.1.0-rc1']);
      expect(api.calls.filter((c) => c.startsWith('DISPATCH'))).toHaveLength(1);
      expect(api.calls).not.toContain('ARTIFACT');
      expect(await execute()).toBe(false);
      await webhook('workflow_run', { workflow_run: { id: 42 } });
      await drain();
      expect(api.calls.filter((c) => c.startsWith('DISPATCH'))).toHaveLength(1);
    });
    it('reconciles reruns and repeated completion events into one admitted evidence document', async () => {
      const [batch] = await run(
        Effect.flatMap(CatalogStore, (s) => s.batches(project.repository)),
      );
      api.complete(batch.intent, 2);
      await webhook('workflow_run', {
        workflow_run: { id: 42, run_attempt: 1, status: 'queued' },
      });
      await webhook('workflow_run', {
        workflow_run: { id: 42, run_attempt: 2, status: 'completed' },
      });
      await drain();
      const [prepared] = await run(
        Effect.flatMap(CatalogStore, (s) => s.batches(project.repository)),
      );
      expect(prepared.status).toBe('prepared');
      expect(prepared.evidence_digest).toMatch(/^[a-f0-9]{64}$/);
      const evidence = await run(
        Effect.flatMap(CatalogStore, (s) =>
          s.evidence(prepared.evidence_digest!),
        ),
      );
      expect(evidence).toMatchObject({
        batchId: batch.batch_id,
        runId: 42,
        runAttempt: 2,
        repositoryId: 7,
      });
      expect(api.calls.filter((c) => c === 'ARTIFACT')).toHaveLength(1);
      const states = await run(
        Effect.gen(function* () {
          const sql = yield* SqlClient.SqlClient;
          return yield* sql`SELECT state FROM jobs WHERE state<>'done'`;
        }),
      );
      expect(states).toEqual([]);
    });
    it('keeps the author out of review routing and allows a CI-only repository', async () => {
      api.open = [
        {
          number: 9,
          state: 'open',
          draft: false,
          body: null,
          user: { login: 'fullzer4' },
          head: { sha: 'c'.repeat(40), ref: 'human', repo: { id: 7 } },
          base: { sha: base, ref: 'main' },
        },
      ];
      await webhook('pull_request');
      await drain();
      const rows = await run(
        Effect.gen(function* () {
          const sql = yield* SqlClient.SqlClient;
          return yield* sql<{
            evidence: {
              reviewers: string[];
              independentReviewerPending: boolean;
            };
          }>`SELECT evidence FROM audit WHERE operation='review-routing' ORDER BY id DESC LIMIT 1`;
        }),
      );
      expect(rows[0].evidence).toMatchObject({
        reviewers: [],
        independentReviewerPending: true,
      });
      const [ciProject] = decodeProjects({
        schema: 2,
        projects: [
          {
            repository: 'test/ci-only',
            policy: 'ci-v1',
            fallback: ['@maintainer'],
            modules: ['ci'],
            workflows: ['test.yml'],
          },
        ],
      });
      const ciRegistry = builtinModules({
        ...settings,
        projects: [ciProject],
        bindings: {
          [ciProject.repository]: { repositoryId: 7, installationId: 8 },
        },
      });
      await run(
        schedule(ciRegistry).pipe(
          Effect.provideService(GitHubProvider, provider),
        ),
      );
      const before = api.calls.filter((c) => c.startsWith('FILE')).length;
      await run(
        workOnce(ciRegistry).pipe(
          Effect.provideService(GitHubProvider, provider),
        ),
      );
      expect(api.calls.filter((c) => c.startsWith('FILE'))).toHaveLength(
        before,
      );
    });
  },
);
