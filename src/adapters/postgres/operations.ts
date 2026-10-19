import { PgClient } from '@effect/sql-pg';
import { Effect, Layer } from 'effect';
import { SqlClient } from 'effect/sql';
import { OperationStore } from '../../kernel/contracts/persistence.ts';
import type { Operation } from '../../kernel/contracts/persistence.ts';
export const operationStoreLayer = Layer.effect(
  OperationStore,
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient,
      pg = yield* PgClient.PgClient;
    return OperationStore.of({
      get: (key) =>
        Effect.map(
          sql<Operation>`SELECT * FROM operations WHERE operation_key=${key}`,
          (rows) => rows[0] ?? null,
        ),
      begin: (repository, batch, key, kind) =>
        Effect.map(
          sql`INSERT INTO operations (operation_key,repository,batch_id,kind,state) VALUES (${key},${repository},${batch},${kind},'intent')
      ON CONFLICT(operation_key) DO UPDATE SET state='intent',retry_at=NULL WHERE operations.state='waiting' AND operations.retry_at<=clock_timestamp() AND operations.repository=EXCLUDED.repository AND operations.batch_id=EXCLUDED.batch_id RETURNING operation_key`,
          (rows) => rows.length === 1,
        ),
      complete: (key, receipt) =>
        Effect.asVoid(
          sql`UPDATE operations SET state='complete',receipt=${pg.json(receipt)},retry_at=NULL,updated_at=clock_timestamp() WHERE operation_key=${key}`,
        ),
      uncertain: (key) =>
        Effect.asVoid(
          sql`UPDATE operations SET state='uncertain',updated_at=clock_timestamp() WHERE operation_key=${key}`,
        ),
      defer: (key, until) =>
        Effect.asVoid(
          sql`UPDATE operations SET state='waiting',retry_at=to_timestamp(${until / 1000}),updated_at=clock_timestamp() WHERE operation_key=${key}`,
        ),
    });
  }),
);
