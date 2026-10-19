import { PgClient } from '@effect/sql-pg';
import { Effect, Layer } from 'effect';
import { SqlClient } from 'effect/sql';
import { CIStore } from '../../modules/ci/contracts.js';
import type { Pull, Run } from '../../modules/ci/model.js';
export const ciStoreLayer = Layer.effect(
  CIStore,
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient,
      pg = yield* PgClient.PgClient;
    const remember = (repository: string, pulls: Pull[]) =>
      Effect.gen(function* () {
        const tracked = pulls.filter((pull) =>
          pull.head.ref.startsWith('ryro-bot/'),
        );
        if (!tracked.length) return;
        yield* sql`INSERT INTO pull_history (repository,number,document)
        SELECT ${repository},(source.document->>'number')::integer,source.document
        FROM jsonb_array_elements(${pg.json(tracked)}) AS source(document) WHERE TRUE
        ON CONFLICT(repository,number) DO UPDATE SET document=EXCLUDED.document
        WHERE pull_history.document IS DISTINCT FROM EXCLUDED.document`;
      });
    return CIStore.of({
      remember,
      observe: (repository, run) =>
        Effect.asVoid(sql`INSERT INTO workflow_runs (repository,run_id,attempt,workflow_id,head_sha,document) VALUES (${repository},${run.id},${run.run_attempt ?? 1},${run.workflow_id},${run.head_sha},${pg.json(run)})
      ON CONFLICT(repository,run_id) DO UPDATE SET attempt=EXCLUDED.attempt,workflow_id=EXCLUDED.workflow_id,head_sha=EXCLUDED.head_sha,document=EXCLUDED.document,observed_at=clock_timestamp()
      WHERE EXCLUDED.attempt>workflow_runs.attempt OR (EXCLUDED.attempt=workflow_runs.attempt AND (workflow_runs.document->>'status'<>'completed' OR EXCLUDED.document->>'status'='completed'))`),
      tracked: (repository) =>
        Effect.map(
          sql<{
            document: Run;
          }>`SELECT document FROM workflow_runs WHERE repository=${repository} AND document->>'status'<>'completed' ORDER BY observed_at,run_id LIMIT 20`,
          (rows) => rows.map((r) => r.document),
        ),
      scan: (repository) =>
        Effect.gen(function* () {
          yield* sql`INSERT INTO pull_scans (repository) VALUES (${repository}) ON CONFLICT DO NOTHING`;
          const [row] = yield* sql<{
            page: number;
            complete: boolean;
          }>`SELECT page,complete FROM pull_scans WHERE repository=${repository}`;
          return row;
        }),
      page: (repository, page, pulls) =>
        sql.withTransaction(
          Effect.gen(function* () {
            yield* remember(repository, pulls);
            yield* sql`UPDATE pull_scans SET page=page+1,complete=${pulls.length < 100} WHERE repository=${repository} AND page=${page} AND complete=FALSE`;
          }),
        ),
      pulls: (repository) =>
        Effect.map(
          sql<{
            document: Pull;
          }>`SELECT document FROM pull_history WHERE repository=${repository} ORDER BY number`,
          (rows) => rows.map((r) => r.document),
        ),
    });
  }),
);
