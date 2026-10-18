import { PgClient } from '@effect/sql-pg';
import { Effect } from 'effect';
import { SqlClient } from 'effect/sql';
import type { Settings } from './config.js';
import { audit, claim, enqueue, finish, migrate, reap, renew } from './db.js';
import { discover } from './discovery.js';
import { reconcileProject } from './reconcile.js';
import { persistWebhook, webhookServer } from './webhook.js';

export const schedule = (settings: Settings, now = Date.now()) =>
  Effect.gen(function* () {
    const bucket = Math.floor(now / (settings.schedulerSeconds * 1000));
    yield* reap;
    for (const project of settings.projects) {
      yield* enqueue(
        project.repository,
        'reconcile',
        'schedule:' + project.repository + ':' + bucket,
        {},
      );
      // Discovery is refreshed daily and resumes unfinished scans every scheduler interval.
      const sql = yield* SqlClient.SqlClient;
      for (const [pkg, config] of Object.entries(project.packages))
        if (config.discovery) {
          const rows = yield* sql<{
            complete: boolean;
            assessed_at: Date | null;
          }>`SELECT complete,assessed_at FROM channels WHERE repository=${project.repository} AND package=${pkg}`;
          if (
            !rows.length ||
            !rows[0].complete ||
            !rows[0].assessed_at ||
            now - new Date(rows[0].assessed_at).getTime() >= 86400000
          ) {
            yield* enqueue(
              project.repository,
              'discover',
              'discovery:' + project.repository + ':' + pkg + ':' + bucket,
              { package: pkg },
            );
          }
        }
    }
  });

export const workOnce = (settings: Settings) =>
  Effect.gen(function* () {
    const job = yield* claim;
    if (!job) return false;
    const project = settings.projects.find(
      (p) => p.repository === job.repository,
    );
    if (!project) {
      yield* finish(job, 'unregistered-project');
      return true;
    }
    const operation = Effect.gen(function* () {
      yield* Effect.forkScoped(
        Effect.sleep('30 seconds').pipe(
          Effect.andThen(renew(job)),
          Effect.forever,
        ),
      );
      if (job.kind === 'reconcile')
        yield* reconcileProject(settings, project, job);
      else if (job.kind === 'discover') {
        const pkg = (job.payload as { package: string }).package,
          channel = project.packages[pkg]?.discovery;
        if (channel) yield* discover(project.repository, pkg, channel);
      } else
        yield* audit('unrecognized-job', {
          repository: project.repository,
          policyRevision: settings.revision,
          baseSha: '0'.repeat(40),
          producedSha: null,
          botVersion: settings.version,
          evidence: { kind: job.kind },
        });
    }).pipe(Effect.scoped);
    yield* operation.pipe(
      Effect.andThen(finish(job)),
      Effect.catchCause(() =>
        finish(job, 'operation-failed').pipe(
          Effect.andThen(
            Effect.logWarning('Job failed; bounded retry scheduled', {
              jobId: job.id,
              repository: job.repository,
            }),
          ),
        ),
      ),
    );
    return true;
  });

export const service = (settings: Settings) =>
  Effect.gen(function* () {
    yield* migrate;
    const sql = yield* SqlClient.SqlClient;
    const context = yield* Effect.context<
      SqlClient.SqlClient | PgClient.PgClient
    >();
    const server = webhookServer(
      settings,
      (id, repo, event, bytes) =>
        Effect.runPromise(
          persistWebhook(id, repo, event, bytes).pipe(Effect.provide(context)),
        ),
      () => Effect.runPromise(sql`SELECT 1`.pipe(Effect.provide(context))),
    );
    yield* Effect.acquireRelease(
      Effect.tryPromise(
        () =>
          new Promise<void>((resolve, reject) => {
            server.once('error', reject);
            server.listen(settings.port, settings.host, resolve);
          }),
      ),
      () =>
        Effect.promise(
          () =>
            new Promise<void>((resolve) => {
              server.close(() => resolve());
              server.closeIdleConnections();
            }),
        ),
    );
    yield* Effect.logInfo('Ryro bot ready', {
      mode: settings.mode,
      version: settings.version,
      port: settings.port,
    });
    yield* Effect.forkScoped(
      schedule(settings).pipe(
        Effect.catchCause(() => Effect.logWarning('Scheduler unavailable')),
        Effect.andThen(Effect.sleep(settings.schedulerSeconds * 1000)),
        Effect.forever,
      ),
    );
    yield* workOnce(settings).pipe(
      Effect.catchCause(() => Effect.logWarning('Worker unavailable')),
      Effect.andThen(Effect.sleep('1 second')),
      Effect.forever,
    );
  }).pipe(Effect.scoped);
