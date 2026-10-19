import { randomUUID } from 'node:crypto';
import { NodeServices } from '@effect/platform-node';
import { PgClient } from '@effect/sql-pg';
import { Effect, Layer, ManagedRuntime, Redacted } from 'effect';
import { SqlClient } from 'effect/sql';
import { databaseLayer } from '../../src/adapters/postgres/client.js';
import { persistenceLayer } from '../../src/adapters/postgres/layers.js';
import { pageFetcherLayer } from '../../src/adapters/http/client.js';
import {
  pullTrackerLayer,
  workflowDispatchLayer,
} from '../../src/modules/ci/service.js';

// Every suite owns a separate schema, even when files run concurrently.
export function postgresTest() {
  const url =
    process.env.TEST_DATABASE_URL ?? 'postgres://postgres:test@127.0.0.1/test';
  const schema = 'test_' + randomUUID().replaceAll('-', '');
  const management = ManagedRuntime.make(databaseLayer(url, undefined, true));
  const database = Layer.merge(
    PgClient.layerFrom(
      PgClient.make({
        url: Redacted.make(url),
        ssl: false,
        maxConnections: 10,
        startupParameters: { search_path: schema, synchronous_commit: 'on' },
      }),
    ),
    NodeServices.layer,
  );
  const persistence = Layer.provideMerge(persistenceLayer, database);
  const runtime = ManagedRuntime.make(
    Layer.provideMerge(
      Layer.mergeAll(pullTrackerLayer, workflowDispatchLayer, pageFetcherLayer),
      persistence,
    ),
  );
  const create = () =>
    management.runPromise(
      Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient;
        yield* sql`CREATE SCHEMA ${sql(schema)}`;
      }),
    );
  const dispose = async () => {
    await runtime.dispose();
    await management.runPromise(
      Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient;
        yield* sql`DROP SCHEMA ${sql(schema)} CASCADE`;
      }),
    );
    await management.dispose();
  };
  return { runtime, create, dispose };
}
