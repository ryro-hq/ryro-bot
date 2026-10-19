import { Effect } from 'effect';
import { SqlClient } from 'effect/sql';
import { beforeAll, afterAll, describe, expect, it } from 'vitest';
import { postgresTest } from '../support/postgres.ts';
import {
  checkMigrations,
  migrate,
  migrationStatus,
} from '../../src/adapters/postgres/migrations.ts';
import initial from '../../src/adapters/postgres/migrations/001_central_bot.ts';

describe.skipIf(!process.env.TEST_DATABASE_URL)('migration lifecycle', () => {
  const db = postgresTest();
  const run = db.runtime.runPromise;
  beforeAll(db.create);
  afterAll(db.dispose);
  it('status and check never create tables in an empty database', async () => {
    expect((await run(migrationStatus)).state).toBe('pending');
    await expect(run(checkMigrations)).rejects.toThrow(
      'database-schema-pending',
    );
    const tables = await run(
      Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient;
        return yield* sql`SELECT tablename FROM pg_tables WHERE schemaname=current_schema()`;
      }),
    );
    expect(tables).toEqual([]);
  });
  it('upgrades the original schema, retaining deliveries, jobs and evidence', async () => {
    await run(
      Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient;
        yield* initial;
        yield* sql`CREATE TABLE ryro_bot_migrations (migration_id integer PRIMARY KEY, created_at timestamptz NOT NULL DEFAULT now(),name text NOT NULL)`;
        yield* sql`INSERT INTO ryro_bot_migrations(migration_id,name) VALUES (1,'central_bot')`;
        yield* sql`INSERT INTO repositories(repository) VALUES ('owner/old')`;
        yield* sql`INSERT INTO evidence(digest,repository,source,document) VALUES (${'a'.repeat(64)},'owner/old','{}','{"retained":true}')`;
      }),
    );
    await Promise.all([run(migrate), run(migrate)]);
    expect((await run(migrationStatus)).state).toBe('current');
    const rows = await run(
      Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient;
        return yield* sql`SELECT document FROM evidence`;
      }),
    );
    expect(rows).toEqual([{ document: { retained: true } }]);
    expect(await run(migrate)).toEqual([]);
  });
  it('validates the whole applied history rather than only its latest ID', async () => {
    await run(
      Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient;
        yield* sql`UPDATE ryro_bot_migrations SET name='tampered' WHERE migration_id=1`;
      }),
    );
    await expect(run(migrate)).rejects.toThrow('database-schema-incompatible');
    await expect(run(checkMigrations)).rejects.toThrow(
      'database-schema-incompatible',
    );
    await run(
      Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient;
        yield* sql`UPDATE ryro_bot_migrations SET name='central_bot' WHERE migration_id=1`;
      }),
    );
  });
});
describe.skipIf(!process.env.TEST_DATABASE_URL)(
  'concurrent first deployment',
  () => {
    const db = postgresTest();
    const run = db.runtime.runPromise;
    beforeAll(db.create);
    afterAll(db.dispose);
    it('serializes empty-database migration history creation', async () => {
      const results = await Promise.all([
        run(migrate),
        run(migrate),
        run(migrate),
      ]);
      expect(results.flat()).toHaveLength(2);
      expect((await run(migrationStatus)).applied).toEqual([
        { id: 1, name: 'central_bot' },
        { id: 2, name: 'runtime' },
      ]);
    });
    it('rolls back DDL and history together if deployment fails', async () => {
      await expect(
        run(
          Effect.gen(function* () {
            const sql = yield* SqlClient.SqlClient;
            yield* sql.withTransaction(
              Effect.gen(function* () {
                yield* sql`DELETE FROM ryro_bot_migrations WHERE migration_id=2`;
                yield* sql`CREATE TABLE rollback_probe (id integer)`;
                yield* Effect.fail(new Error('deployment interrupted'));
              }),
            );
          }),
        ),
      ).rejects.toThrow('deployment interrupted');
      expect((await run(migrationStatus)).state).toBe('current');
      const rows = await run(
        Effect.gen(function* () {
          const sql = yield* SqlClient.SqlClient;
          return yield* sql`SELECT to_regclass('rollback_probe') AS name`;
        }),
      );
      expect(rows[0]?.name).toBeNull();
    });
  },
);

describe.skipIf(!process.env.TEST_DATABASE_URL)(
  'migration transaction rollback',
  () => {
    const db = postgresTest(),
      run = db.runtime.runPromise;
    beforeAll(db.create);
    afterAll(db.dispose);
    it('rolls back initial DDL and history if the surrounding deployment is interrupted', async () => {
      await expect(
        run(
          Effect.gen(function* () {
            const sql = yield* SqlClient.SqlClient;
            yield* sql.withTransaction(
              migrate.pipe(
                Effect.andThen(
                  Effect.fail(new Error('deployment interrupted')),
                ),
              ),
            );
          }),
        ),
      ).rejects.toThrow('deployment interrupted');
      expect((await run(migrationStatus)).applied).toEqual([]);
      const tables = await run(
        Effect.gen(function* () {
          const sql = yield* SqlClient.SqlClient;
          return yield* sql`SELECT tablename FROM pg_tables WHERE schemaname=current_schema()`;
        }),
      );
      expect(tables).toEqual([]);
      await run(migrate);
      expect((await run(migrationStatus)).state).toBe('current');
    });
  },
);
