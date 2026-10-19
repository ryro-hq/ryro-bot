import { PgMigrator } from '@effect/sql-pg';
import { Effect } from 'effect';
import { SqlClient } from 'effect/sql';
import { BotError, requireThat } from '../../kernel/errors.ts';
import initial from './migrations/001_central_bot.ts';
import runtime from './migrations/002_runtime.ts';

export const migrations = {
  '001_central_bot': initial,
  '002_runtime': runtime,
};
const manifest = Object.keys(migrations).map((key) => {
  const split = key.indexOf('_');
  return { id: Number(key.slice(0, split)), name: key.slice(split + 1) };
});

export const migrationStatus = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const [table] = yield* sql<{
    present: string | null;
  }>`SELECT to_regclass('ryro_bot_migrations')::text AS present`;
  requireThat(table, 'migration-table-status-missing');
  const applied = table.present
    ? yield* sql<{
        id: number;
        name: string;
      }>`SELECT migration_id AS id,name FROM ryro_bot_migrations ORDER BY migration_id`
    : [];
  const compatible = applied.every(
    (row, index) =>
      row.id === manifest[index]?.id && row.name === manifest[index]?.name,
  );
  return {
    state: !compatible
      ? 'incompatible'
      : applied.length === manifest.length
        ? 'current'
        : 'pending',
    applied,
    pending: compatible ? manifest.slice(applied.length) : [],
  };
});

export const checkMigrations = Effect.gen(function* () {
  const status = yield* migrationStatus;
  if (status.state !== 'current')
    return yield* new BotError({ code: 'database-schema-' + status.state });
});

// Acquire before PgMigrator creates its history table, including on an empty DB.
// The outer transaction also makes history validation and all pending DDL atomic.
export const migrate = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  return yield* sql.withTransaction(
    Effect.gen(function* () {
      yield* sql`SELECT pg_advisory_xact_lock(824794739101843262::bigint)`;
      const status = yield* migrationStatus;
      if (status.state === 'incompatible')
        return yield* new BotError({ code: 'database-schema-incompatible' });
      // PgMigrator probes with ::regclass and catches a missing table. Inside an
      // outer PostgreSQL transaction that error would poison the transaction.
      yield* sql`CREATE TABLE IF NOT EXISTS ryro_bot_migrations (
      migration_id integer primary key,
      created_at timestamp with time zone not null default now(),
      name text not null
    )`;
      const completed = yield* PgMigrator.run({
        loader: PgMigrator.fromRecord(migrations),
        table: 'ryro_bot_migrations',
      });
      yield* checkMigrations;
      return completed;
    }),
  );
});
