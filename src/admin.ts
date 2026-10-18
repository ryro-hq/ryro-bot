import { readFileSync, mkdirSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { NodeRuntime, NodeServices } from '@effect/platform-node';
import { PgClient } from '@effect/sql-pg';
import { Console, Effect } from 'effect';
import { SqlClient } from 'effect/sql';
import { loadSettings } from './config.js';
import { audit, databaseLayer, enqueue, migrate } from './db.js';
import { BotError, requireThat } from './domain.js';
import type { Project } from './domain.js';
import { ownershipArtifacts, route, validateProject } from './policy.js';
import { GitHub } from './github.js';
import { remote } from './reconcile.js';

const [command, repository, ...args] = process.argv.slice(2);
if (command === 'owners' || command === 'route') {
  const registry = JSON.parse(
    readFileSync('registry/projects.json', 'utf8'),
  ) as {
    projects: Project[];
  };
  const project = registry.projects.find((p) => p.repository === repository);
  requireThat(project, 'unregistered-project');
  validateProject(project);
  if (command === 'route')
    console.log(
      JSON.stringify(route(project, args.slice(1), args[0]), null, 2),
    );
  else {
    requireThat(args[0], 'destination-required');
    for (const [path, bytes] of Object.entries(ownershipArtifacts(project))) {
      const destination = resolve(args[0], path);
      mkdirSync(resolve(destination, '..'), { recursive: true });
      writeFileSync(destination, bytes);
    }
  }
} else
  NodeRuntime.runMain(
    Effect.gen(function* () {
      const settings = yield* Effect.try({
        try: () => loadSettings(),
        catch: () => new BotError({ code: 'invalid-admin-configuration' }),
      });
      const run = Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient,
          pg = yield* PgClient.PgClient;
        if (command === 'migrate') {
          yield* migrate;
          yield* Console.log('Migrations complete');
          return;
        }
        if (command === 'status') {
          const jobs =
            yield* sql`SELECT repository,kind,state,count(*)::int AS count FROM jobs GROUP BY repository,kind,state ORDER BY repository,kind,state`;
          const channels =
            yield* sql`SELECT repository,package,complete,cursor,last_error,assessed_at FROM channels ORDER BY repository,package`;
          const counts =
            yield* sql`SELECT repository,package,state,count(*)::int AS count FROM releases GROUP BY repository,package,state ORDER BY repository,package,state`;
          yield* Console.log(
            JSON.stringify(
              { mode: settings.mode, jobs, channels, inventory: counts },
              null,
              2,
            ),
          );
          return;
        }
        const project = settings.projects.find(
          (p) => p.repository === repository,
        );
        requireThat(project, 'unregistered-project');
        if (command === 'reconcile')
          yield* enqueue(
            repository,
            'reconcile',
            'admin:' + crypto.randomUUID(),
            {},
          );
        else if (command === 'discover') {
          requireThat(
            project.packages[args[0]]?.discovery,
            'unknown-discovery-channel',
          );
          yield* enqueue(
            repository,
            'discover',
            'admin:' + crypto.randomUUID(),
            {
              package: args[0],
            },
          );
        } else if (command === 'inventory') {
          // Cursor pagination keeps the historical inventory independent of catalog/Actions limits.
          let lastPackage = '',
            lastVersion = '';
          while (true) {
            const rows = yield* sql<{
              package: string;
              version: string;
            }>`SELECT package,version,classification,origin_ref,state,reason,discovered_at FROM releases
          WHERE repository=${repository} AND (package,version)>(${lastPackage},${lastVersion}) ORDER BY package,version LIMIT 500`;
            for (const row of rows) yield* Console.log(JSON.stringify(row));
            if (rows.length < 500) break;
            lastPackage = rows.at(-1)!.package;
            lastVersion = rows.at(-1)!.version;
          }
        } else if (command === 'hold') {
          const [pkg, version, state, ...reason] = args;
          requireThat(
            ['blocked', 'revoked', 'quarantined'].includes(state) &&
              reason.join(' ').length >= 12,
            'hold-state-and-reason-required',
          );
          const changed =
            yield* sql`UPDATE releases SET state=${state},reason=${reason.join(' ')} WHERE repository=${repository} AND package=${pkg} AND version=${version} RETURNING version`;
          requireThat(changed.length === 1, 'release-not-found');
        } else if (command === 'recover-dispatch') {
          const [batchId, runIdText] = args,
            runId = Number(runIdText);
          requireThat(
            /^[0-9a-f]{64}$/.test(batchId) &&
              Number.isSafeInteger(runId) &&
              settings.appId &&
              settings.appKey,
            'batch-run-and-app-required',
          );
          const binding = settings.bindings[repository],
            api = new GitHub(
              repository,
              binding,
              settings.appId,
              settings.appKey,
            );
          const run = yield* remote(() => api.run(runId));
          const records = yield* sql<{
            base_sha: string;
            policy_revision: string;
          }>`SELECT base_sha,policy_revision FROM batches WHERE batch_id=${batchId} AND repository=${repository}`;
          requireThat(
            records.length === 1 &&
              run.head_sha === records[0].base_sha &&
              run.repository.id === binding.repositoryId &&
              run.event === 'workflow_dispatch' &&
              run.path === '.github/workflows/' + project.preparationWorkflow &&
              run.referenced_workflows?.some(
                (w) => w.sha === records[0].policy_revision,
              ),
            'recovery-context-mismatch',
          );
          yield* sql`UPDATE batches SET run_id=${runId},status='preparing' WHERE batch_id=${batchId} AND run_id IS NULL`;
          yield* sql`UPDATE operations SET state='complete',receipt=${pg.json({ runId, recovered: true })} WHERE batch_id=${batchId} AND kind='prepare-dispatch'`;
        } else
          throw new BotError({
            code: 'usage-admin-migrate-status-owners-route-reconcile-discover-inventory-hold-recover-dispatch',
          });
        yield* audit('admin:' + command, {
          repository,
          policyRevision: settings.revision,
          baseSha: '0'.repeat(40),
          producedSha: null,
          botVersion: settings.version,
          evidence: {
            actor: process.env.USER ?? 'local-admin',
            arguments: args,
          },
        });
      });
      yield* run.pipe(
        Effect.provide(
          databaseLayer(
            settings.databaseUrl,
            settings.databaseCa,
            settings.localDatabase,
          ),
        ),
      );
    }).pipe(Effect.provide(NodeServices.layer)),
  );
