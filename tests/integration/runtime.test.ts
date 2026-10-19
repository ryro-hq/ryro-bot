import { randomUUID } from 'node:crypto';
import { Effect } from 'effect';
import { SqlClient } from 'effect/sql';
import { beforeAll, afterAll, describe, expect, it } from 'vitest';
import { postgresTest } from '../support/postgres.ts';
import { migrate } from '../../src/adapters/postgres/migrations.ts';
import {
  claim,
  request,
  finish,
  registerRepository,
} from '../../src/adapters/postgres/jobs.ts';
import { CIStore, WorkflowDispatch } from '../../src/modules/ci/contracts.ts';
import type { GitHubAPI, Run } from '../../src/modules/ci/model.ts';
import { OperationStore } from '../../src/kernel/contracts/persistence.ts';
import { DeferredError } from '../../src/kernel/operations.ts';
import { base } from '../support/projects.ts';

describe.skipIf(!process.env.TEST_DATABASE_URL)(
  'persistent coordination',
  () => {
    const db = postgresTest();
    const run = db.runtime.runPromise;
    beforeAll(async () => {
      await db.create();
      await run(migrate);
    });
    afterAll(db.dispose);
    it('coalesces pending events and retains another round for events received during execution', async () => {
      const repository = 'coalesce/' + randomUUID();
      await Promise.all(
        Array.from({ length: 12 }, () =>
          run(request(repository, { kind: 'ci.reconcile', payload: {} })),
        ),
      );
      const first = await run(claim);
      expect(first?.generation).toBe(12);
      await run(
        request(repository, { kind: 'ci.reconcile', payload: { runId: 7 } }),
      );
      await run(finish(first!));
      const second = await run(claim);
      expect(second?.id).toBe(first?.id);
      expect(second?.generation).toBe(13);
      expect(second?.payload).toEqual({ runId: 7 });
      await run(finish(second!));
      expect(await run(claim)).toBeNull();
    });
    it('gives another repository a turn before draining one busy repository', async () => {
      const a = 'fair/a-' + randomUUID(),
        b = 'fair/b-' + randomUUID();
      for (const kind of [
        'ci.reconcile',
        'catalog.discover',
        'reviews.reconcile',
      ])
        await run(request(a, { kind, payload: {} }));
      await run(request(b, { kind: 'ci.reconcile', payload: {} }));
      const first = await run(claim);
      await run(finish(first!));
      const second = await run(claim);
      expect(second?.repository).not.toBe(first?.repository);
      await run(finish(second!));
      for (let i = 0; i < 2; i++) {
        const next = await run(claim);
        await run(finish(next!));
      }
    });
    it('preserves repository storage keys through a rename and rejects identity collisions', async () => {
      await run(request('owner/old', { kind: 'ci.reconcile', payload: {} }));
      expect(
        await run(
          registerRepository('owner/new', 123, 'owner/new', ['owner/old']),
        ),
      ).toBe('owner/old');
      expect(
        await run(
          registerRepository('owner/newer', 123, 'owner/newer', ['owner/new']),
        ),
      ).toBe('owner/old');
      await expect(
        run(registerRepository('owner/old', 456, 'owner/old', [])),
      ).rejects.toThrow('repository-identity-conflict');
      const job = await run(claim);
      expect(job?.repository).toBe('owner/old');
      await run(finish(job!));
    });
    it('never regresses a completed run or a newer rerun attempt', async () => {
      const document: Run = {
        id: 7,
        run_attempt: 1,
        head_sha: base,
        event: 'pull_request',
        status: 'completed',
        conclusion: 'success',
        path: '.github/workflows/test.yml',
        workflow_id: 9,
        repository: { id: 123 },
        head_repository: { id: 123 },
      };
      await run(
        Effect.gen(function* () {
          const store = yield* CIStore;
          yield* store.observe('owner/ci', document);
          yield* store.observe('owner/ci', {
            ...document,
            status: 'queued',
            conclusion: null,
          });
          expect(yield* store.tracked('owner/ci')).toEqual([]);
          yield* store.observe('owner/ci', {
            ...document,
            run_attempt: 2,
            status: 'in_progress',
            conclusion: null,
          });
          yield* store.observe('owner/ci', document);
          expect(yield* store.tracked('owner/ci')).toMatchObject([
            { run_attempt: 2, status: 'in_progress' },
          ]);
        }),
      );
    });
    it('does not repeat an uncertain remote dispatch after a restart', async () => {
      let calls = 0;
      const api = {
        dispatch: async () => {
          calls++;
          throw new Error('connection lost after sending');
        },
      } as unknown as GitHubAPI;
      const spec = {
        repository: 'owner/ci',
        batchId: 'a'.repeat(64),
        key: 'uncertain',
        kind: 'prepare-dispatch',
        workflow: 'prepare.yml',
        ref: 'main',
        inputs: {},
      };
      await expect(
        run(Effect.flatMap(WorkflowDispatch, (s) => s.once(spec, api))),
      ).rejects.toThrow('remote-operation-failed');
      expect(
        await run(Effect.flatMap(OperationStore, (s) => s.get(spec.key))),
      ).toMatchObject({ state: 'uncertain' });
      expect(
        await run(Effect.flatMap(WorkflowDispatch, (s) => s.once(spec, api))),
      ).toBeNull();
      expect(calls).toBe(1);
    });
    it('reuses receipts and safely retries explicit rate-limit rejections', async () => {
      let calls = 0;
      const until = Date.now() + 60000;
      const api = {
        dispatch: async () => {
          calls++;
          if (calls === 1) throw new DeferredError(until);
          return { workflow_run_id: 42 };
        },
      } as unknown as GitHubAPI;
      const spec = {
        repository: 'owner/ci',
        batchId: 'b'.repeat(64),
        key: 'rate',
        kind: 'prepare-dispatch',
        workflow: 'prepare.yml',
        ref: 'main',
        inputs: {},
      };
      await expect(
        run(Effect.flatMap(WorkflowDispatch, (s) => s.once(spec, api))),
      ).rejects.toThrow('github-rate-limited');
      expect(
        await run(Effect.flatMap(OperationStore, (s) => s.get(spec.key))),
      ).toMatchObject({ state: 'waiting' });
      await run(
        Effect.gen(function* () {
          const sql = yield* SqlClient.SqlClient;
          yield* sql`UPDATE operations SET retry_at=clock_timestamp()-interval '1 second' WHERE operation_key='rate'`;
        }),
      );
      expect(
        await run(Effect.flatMap(WorkflowDispatch, (s) => s.once(spec, api))),
      ).toBe(42);
      expect(
        await run(Effect.flatMap(WorkflowDispatch, (s) => s.once(spec, api))),
      ).toBe(42);
      expect(calls).toBe(2);
    });
  },
);

describe.skipIf(!process.env.TEST_DATABASE_URL)('pull history recovery', () => {
  const db = postgresTest(),
    run = db.runtime.runPromise;
  beforeAll(async () => {
    await db.create();
    await run(migrate);
  });
  afterAll(db.dispose);
  it('resumes historical pagination and remembers a new PR that later closes offline', async () => {
    const { FakeGitHub } = await import('../support/github.ts');
    const { pilot } = await import('../support/projects.ts');
    const { PullTracker } = await import('../../src/modules/ci/contracts.ts');
    const project = pilot(),
      api = new FakeGitHub(project);
    const pull = (number: number, state: 'open' | 'closed') => ({
      number,
      state,
      draft: true,
      body: null,
      user: { login: 'ryro[bot]' },
      head: {
        sha: base,
        ref: 'ryro-bot/' + number.toString(16).padStart(64, '0'),
        repo: { id: project.repositoryId! },
      },
      base: { sha: base, ref: 'main' },
    });
    api.history = Array.from({ length: 305 }, (_, i) => pull(i + 1, 'closed'));
    const snapshot = () =>
      run(
        Effect.flatMap(PullTracker, (s) => s.snapshot(project.repository, api)),
      );
    expect((await snapshot()).complete).toBe(false);
    expect((await snapshot()).complete).toBe(true);
    expect(api.calls.some((c) => c.includes('page=3'))).toBe(true);
    api.open = [pull(500, 'open')];
    await snapshot();
    api.open = [];
    api.history.push(pull(500, 'closed'));
    expect((await snapshot()).pulls.find((p) => p.number === 500)?.state).toBe(
      'closed',
    );
    const before = api.calls.length;
    await snapshot();
    expect(
      api.calls
        .slice(before)
        .some((c) => c.endsWith('/pulls/500') || c.includes('state=all')),
    ).toBe(false);
  });
});
