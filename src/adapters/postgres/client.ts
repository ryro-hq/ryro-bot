import { PgClient } from '@effect/sql-pg';
import { Effect, Redacted } from 'effect';
import { SqlClient } from 'effect/sql';
import { BotError, requireThat } from '../../kernel/errors.js';
export function databaseLayer(url: string, ca?: string, local = false) {
  const parsed = new URL(url);
  requireThat(
    ['postgres:', 'postgresql:'].includes(parsed.protocol) &&
      parsed.username &&
      parsed.pathname.length > 1,
    'invalid-database-url',
  );
  requireThat(
    !local ||
      ['127.0.0.1', 'localhost', 'postgres', '[::1]'].includes(parsed.hostname),
    'local-database-only',
  );
  return PgClient.layerFrom(
    PgClient.make({
      url: Redacted.make(url),
      ssl: local ? false : { rejectUnauthorized: true, ca },
      applicationName: 'ryro-bot',
      maxConnections: 10,
      connectTimeout: '5 seconds',
      startupParameters: {
        synchronous_commit: 'on',
        statement_timeout: '15000',
        lock_timeout: '5000',
        idle_in_transaction_session_timeout: '20000',
      },
    }),
  );
}

export const checkDurability = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const [settings] = yield* sql<{
    fsync: string;
    full_page_writes: string;
    synchronous_commit: string;
  }>`SELECT current_setting('fsync') AS fsync,
    current_setting('full_page_writes') AS full_page_writes,current_setting('synchronous_commit') AS synchronous_commit`;
  if (
    settings.fsync !== 'on' ||
    settings.full_page_writes !== 'on' ||
    settings.synchronous_commit !== 'on'
  ) {
    return yield* new BotError({
      code: 'unsafe-postgresql-durability-settings',
    });
  }
});
