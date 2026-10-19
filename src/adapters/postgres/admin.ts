import { PgClient } from '@effect/sql-pg';
import { Console, Effect } from 'effect';
import { SqlClient } from 'effect/sql';
import { enqueue, registerRepository } from './jobs.ts';
import { audit } from './audit.ts';
import { BotError, requireThat } from '../../kernel/errors.ts';
import type { AdminSettings } from '../../app/config/service.ts';
import type { BatchRecord } from '../../modules/catalog/contracts.ts';
import { GitHub } from '../github/client.ts';
import { remote } from '../../kernel/operations.ts';
import {
  admitPrepared,
  unzipPrepared,
} from '../../modules/catalog/evidence.ts';

export const adminStatus = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const jobs =
    yield* sql`SELECT repository,kind,state,count(*)::int AS count FROM jobs GROUP BY repository,kind,state ORDER BY repository,kind,state`;
  const channels =
    yield* sql`SELECT repository,package,complete,cursor,last_error,assessed_at FROM channels ORDER BY repository,package`;
  const inventory =
    yield* sql`SELECT repository,package,state,count(*)::int AS count FROM releases GROUP BY repository,package,state ORDER BY repository,package,state`;
  const operations =
    yield* sql`SELECT repository,kind,state,count(*)::int AS count FROM operations GROUP BY repository,kind,state ORDER BY repository,kind,state`;
  yield* Console.log(
    JSON.stringify({ jobs, channels, inventory, operations }, null, 2),
  );
});

export const administer = (
  command: string,
  name: string,
  args: string[],
  settings: AdminSettings,
) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient,
      pg = yield* PgClient.PgClient;
    const project = settings.projects.find((p) =>
      [p.repository, p.canonicalRepository, ...(p.aliases ?? [])].includes(
        name,
      ),
    );
    requireThat(project, 'unregistered-project');
    const binding = settings.bindings[project.repository];
    const repository = yield* registerRepository(
      project.repository,
      project.repositoryId ?? binding?.repositoryId,
      project.canonicalRepository ?? project.repository,
      project.aliases ?? [],
    );
    if (command === 'reconcile')
      yield* enqueue(
        repository,
        'reconcile',
        'admin:' + crypto.randomUUID(),
        {},
      );
    else if (command === 'discover') {
      const [pkg] = args;
      requireThat(
        pkg && project.packages[pkg]?.discovery,
        'unknown-discovery-channel',
      );
      yield* enqueue(repository, 'discover', 'admin:' + crypto.randomUUID(), {
        package: pkg,
      });
    } else if (command === 'inventory') {
      let pkg = '',
        version = '';
      while (true) {
        const rows = yield* sql<{
          package: string;
          version: string;
        }>`SELECT package,version,classification,origin_ref,state,reason,discovered_at FROM releases WHERE repository=${repository} AND (package,version)>(${pkg},${version}) ORDER BY package,version LIMIT 500`;
        for (const row of rows) yield* Console.log(JSON.stringify(row));
        if (rows.length < 500) break;
        pkg = rows.at(-1)!.package;
        version = rows.at(-1)!.version;
      }
    } else if (command === 'hold') {
      const [pkg, version, state, ...reason] = args;
      requireThat(
        pkg &&
          version &&
          state &&
          ['blocked', 'revoked', 'quarantined'].includes(state) &&
          reason.join(' ').length >= 12,
        'hold-state-and-reason-required',
      );
      const changed =
        yield* sql`UPDATE releases SET state=${state},reason=${reason.join(' ')} WHERE repository=${repository} AND package=${pkg} AND version=${version} RETURNING version`;
      requireThat(changed.length === 1, 'release-not-found');
    } else if (command === 'recover-dispatch') {
      const [batchId, text] = args,
        runId = Number(text);
      requireThat(
        batchId &&
          /^[0-9a-f]{64}$/.test(batchId) &&
          Number.isSafeInteger(runId) &&
          runId > 0 &&
          binding &&
          settings.appId &&
          settings.appKey,
        'batch-run-and-app-required',
      );
      const [record] =
        yield* sql<BatchRecord>`SELECT batch_id,intent,run_id::text AS run_id,prepared_sha,branch,evidence_digest,status FROM batches WHERE batch_id=${batchId} AND repository=${repository}`;
      requireThat(
        record && (!record.run_id || Number(record.run_id) === runId),
        'recovery-context-mismatch',
      );
      const api = new GitHub(
        repository,
        binding,
        settings.appId,
        settings.appKey,
        fetch,
        {
          canonicalRepository:
            project.canonicalRepository ?? project.repository,
        },
      );
      const run = yield* remote(() => api.run(runId));
      const artifacts = yield* remote(() =>
        api.list<{
          id: number;
          name: string;
          digest: string;
          expired: boolean;
        }>('/actions/runs/' + runId + '/artifacts', 'artifacts'),
      );
      const matches = artifacts.filter(
        (a) => !a.expired && a.name === 'prepared-' + batchId + '-' + runId,
      );
      const [artifact] = matches;
      requireThat(
        matches.length === 1 && artifact,
        'recovery-artifact-missing',
      );
      const bytes = yield* remote(() =>
        api.artifact(artifact.id, artifact.digest),
      );
      // The artifact binds this run to the exact batch, environment, policy and base.
      yield* Effect.sync(() =>
        admitPrepared(
          JSON.parse(unzipPrepared(bytes).toString('utf8')),
          record.intent,
          run,
          binding.repositoryId,
          project,
        ),
      );
      const key =
        'prepare:' +
        batchId +
        ':' +
        record.intent.baseSha +
        ':' +
        record.intent.policyRevision;
      yield* sql.withTransaction(
        Effect.gen(function* () {
          const operations =
            yield* sql`UPDATE operations SET state='complete',receipt=${pg.json({ workflow_run_id: runId, recovered: true })},updated_at=clock_timestamp() WHERE operation_key=${key} AND repository=${repository} AND batch_id=${batchId} AND kind='prepare-dispatch' AND state IN ('intent','uncertain') RETURNING operation_key`;
          requireThat(
            operations.length === 1,
            'recoverable-operation-not-found',
          );
          yield* sql`UPDATE batches SET run_id=${runId},status='preparing' WHERE batch_id=${batchId}`;
          yield* audit('admin:recover-dispatch', {
            repository,
            policyRevision: settings.revision,
            baseSha: record.intent.baseSha,
            producedSha: null,
            botVersion: settings.version,
            evidence: {
              actor: process.env.USER ?? 'local-admin',
              batchId,
              runId,
            },
          });
        }),
      );
      return;
    } else return yield* new BotError({ code: 'unknown-admin-command' });
    yield* audit('admin:' + command, {
      repository,
      policyRevision: settings.revision,
      baseSha: '0'.repeat(40),
      producedSha: null,
      botVersion: settings.version,
      evidence: { actor: process.env.USER ?? 'local-admin', arguments: args },
    });
  });
