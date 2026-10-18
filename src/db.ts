import { randomUUID } from 'node:crypto';
import { PgClient, PgMigrator } from '@effect/sql-pg';
import { Effect, Layer, Redacted } from 'effect';
import { SqlClient } from 'effect/sql';
import { BotError, canonical, requireThat, sha256 } from './domain.js';
import type { AuditContext } from './domain.js';

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

const statements = [
  `CREATE TABLE repositories (repository text PRIMARY KEY, lease_token uuid, lease_until timestamptz)`,
  `CREATE TABLE deliveries (delivery_id text PRIMARY KEY, repository text NOT NULL REFERENCES repositories, event text NOT NULL,
    digest char(64) NOT NULL, payload jsonb NOT NULL, received_at timestamptz NOT NULL DEFAULT clock_timestamp())`,
  `CREATE TABLE jobs (id uuid PRIMARY KEY, repository text NOT NULL REFERENCES repositories, kind text NOT NULL,
    dedup_key text UNIQUE NOT NULL, payload jsonb NOT NULL, state text NOT NULL DEFAULT 'pending' CHECK (state IN ('pending','running','done','dead')),
    attempts integer NOT NULL DEFAULT 0, max_attempts integer NOT NULL DEFAULT 5 CHECK (max_attempts BETWEEN 1 AND 10),
    available_at timestamptz NOT NULL DEFAULT clock_timestamp(), lease_token uuid, lease_until timestamptz, last_error text,
    created_at timestamptz NOT NULL DEFAULT clock_timestamp())`,
  `CREATE INDEX jobs_ready ON jobs (available_at,created_at) WHERE state IN ('pending','running')`,
  `CREATE TABLE audit (id bigserial PRIMARY KEY, repository text NOT NULL, operation text NOT NULL,
    policy_revision char(40) NOT NULL, base_sha char(40) NOT NULL, produced_sha char(40), bot_version text NOT NULL,
    evidence jsonb NOT NULL, occurred_at timestamptz NOT NULL DEFAULT clock_timestamp())`,
  `CREATE TABLE operations (operation_key text PRIMARY KEY, repository text NOT NULL, batch_id char(64) NOT NULL,
    kind text NOT NULL, state text NOT NULL CHECK (state IN ('intent','complete','uncertain')), receipt jsonb,
    updated_at timestamptz NOT NULL DEFAULT clock_timestamp())`,
  `CREATE TABLE batches (batch_id char(64) PRIMARY KEY, repository text NOT NULL, base_sha char(40) NOT NULL,
    policy_revision char(40) NOT NULL, intent jsonb NOT NULL, prepared_sha char(40), branch text, run_id bigint,
    status text NOT NULL DEFAULT 'planned', evidence_digest char(64), updated_at timestamptz NOT NULL DEFAULT clock_timestamp())`,
  `CREATE TABLE evidence (digest char(64) PRIMARY KEY, repository text NOT NULL, source jsonb NOT NULL, document jsonb NOT NULL,
    created_at timestamptz NOT NULL DEFAULT clock_timestamp())`,
  `CREATE TABLE channels (repository text NOT NULL, package text NOT NULL, policy_digest char(64) NOT NULL,
    generation uuid NOT NULL, cursor text, complete boolean NOT NULL DEFAULT FALSE, last_error text,
    assessed_at timestamptz, PRIMARY KEY (repository,package))`,
  `CREATE TABLE discovery_pages (repository text NOT NULL, package text NOT NULL, generation uuid NOT NULL,
    url text NOT NULL, digest char(64) NOT NULL, body bytea NOT NULL, PRIMARY KEY (repository,package,generation,url))`,
  `CREATE TABLE releases (repository text NOT NULL, package text NOT NULL, version text NOT NULL,
    classification text NOT NULL, origin_ref text NOT NULL, state text NOT NULL DEFAULT 'discovered'
      CHECK (state IN ('discovered','blocked','revoked','quarantined')),
    security_fix boolean NOT NULL DEFAULT FALSE, reason text, discovered_at timestamptz NOT NULL DEFAULT clock_timestamp(),
    PRIMARY KEY (repository,package,version))`,
];
export const migrate = PgMigrator.run({
  loader: PgMigrator.fromRecord({
    '001_central_bot': Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      const pg = yield* PgClient.PgClient;
      for (const statement of statements) yield* sql.unsafe(statement);
    }),
  }),
  table: 'ryro_bot_migrations',
});

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

export const enqueue = (
  repository: string,
  kind: string,
  key: string,
  payload: unknown,
) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    const pg = yield* PgClient.PgClient;
    yield* sql`INSERT INTO repositories (repository) VALUES (${repository}) ON CONFLICT DO NOTHING`;
    yield* sql`INSERT INTO jobs (id,repository,kind,dedup_key,payload) VALUES (${randomUUID()},${repository},${kind},${key},${pg.json(payload)}) ON CONFLICT (dedup_key) DO NOTHING`;
  });

export const receive = (
  delivery: string,
  repository: string,
  event: string,
  body: Buffer,
) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    const pg = yield* PgClient.PgClient;
    const digest = sha256(body),
      payload: unknown = JSON.parse(body.toString('utf8'));
    return yield* sql.withTransaction(
      Effect.gen(function* () {
        yield* sql`INSERT INTO repositories (repository) VALUES (${repository}) ON CONFLICT DO NOTHING`;
        const inserted = yield* sql<{
          delivery_id: string;
        }>`INSERT INTO deliveries (delivery_id,repository,event,digest,payload)
      VALUES (${delivery},${repository},${event},${digest},${pg.json(payload)}) ON CONFLICT DO NOTHING RETURNING delivery_id`;
        if (!inserted.length) {
          const rows = yield* sql<{
            digest: string;
            event: string;
            repository: string;
          }>`SELECT digest,event,repository FROM deliveries WHERE delivery_id=${delivery}`;
          if (
            rows[0].digest !== digest ||
            rows[0].event !== event ||
            rows[0].repository !== repository
          )
            return yield* new BotError({ code: 'delivery-id-collision' });
          return false;
        }
        yield* enqueue(repository, 'reconcile', 'delivery:' + delivery, {
          event,
        });
        return true;
      }),
    );
  });

export interface Job {
  id: string;
  repository: string;
  kind: string;
  payload: unknown;
  lease_token: string;
  attempts: number;
}
export const claim = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const pg = yield* PgClient.PgClient;
  return yield* sql.withTransaction(
    Effect.gen(function* () {
      // A repository row serializes remote operations across workers and scheduler jobs.
      const repos = yield* sql<{
        repository: string;
      }>`SELECT repository FROM repositories r
      WHERE (lease_until IS NULL OR lease_until < clock_timestamp()) AND EXISTS (
        SELECT 1 FROM jobs j WHERE j.repository=r.repository AND j.attempts<j.max_attempts AND j.available_at<=clock_timestamp()
        AND (j.state='pending' OR (j.state='running' AND j.lease_until<clock_timestamp())))
      ORDER BY repository FOR UPDATE SKIP LOCKED LIMIT 1`;
      if (!repos.length) return null;
      const token = randomUUID();
      const jobs =
        yield* sql<Job>`UPDATE jobs SET state='running', attempts=attempts+1,lease_token=${token},lease_until=clock_timestamp()+interval '5 minutes'
      WHERE id=(SELECT id FROM jobs WHERE repository=${repos[0].repository} AND attempts<max_attempts AND available_at<=clock_timestamp()
      AND (state='pending' OR (state='running' AND lease_until<clock_timestamp())) ORDER BY available_at,created_at LIMIT 1 FOR UPDATE SKIP LOCKED)
      RETURNING id,repository,kind,payload,lease_token,attempts`;
      if (!jobs.length) return null;
      yield* sql`UPDATE repositories SET lease_token=${token},lease_until=clock_timestamp()+interval '5 minutes' WHERE repository=${repos[0].repository}`;
      return jobs[0];
    }),
  );
});

export const renew = (job: Job) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    const pg = yield* PgClient.PgClient;
    yield* sql.withTransaction(
      Effect.gen(function* () {
        const rows =
          yield* sql`UPDATE repositories SET lease_until=clock_timestamp()+interval '5 minutes'
      WHERE repository=${job.repository} AND lease_token=${job.lease_token} AND lease_until>clock_timestamp() RETURNING repository`;
        if (!rows.length) return yield* new BotError({ code: 'lost-lease' });
        yield* sql`UPDATE jobs SET lease_until=clock_timestamp()+interval '5 minutes' WHERE id=${job.id} AND lease_token=${job.lease_token} AND state='running'`;
      }),
    );
  });

export const finish = (job: Job, error?: string) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    const pg = yield* PgClient.PgClient;
    yield* sql.withTransaction(
      Effect.gen(function* () {
        yield* sql`UPDATE jobs SET state=CASE WHEN ${error !== undefined} THEN CASE WHEN attempts>=max_attempts THEN 'dead' ELSE 'pending' END ELSE 'done' END,
      last_error=${error ?? null},available_at=clock_timestamp()+make_interval(secs=>LEAST(3600,power(2,attempts)::int)),lease_until=NULL
      WHERE id=${job.id} AND lease_token=${job.lease_token} AND state='running'`;
        yield* sql`UPDATE repositories SET lease_token=NULL,lease_until=NULL WHERE repository=${job.repository} AND lease_token=${job.lease_token}`;
      }),
    );
  });

export const reap = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const pg = yield* PgClient.PgClient;
  yield* sql`UPDATE jobs SET state='dead',last_error='lease-expired-at-attempt-limit' WHERE state='running' AND lease_until<clock_timestamp() AND attempts>=max_attempts`;
});

export const audit = (operation: string, context: AuditContext) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    const pg = yield* PgClient.PgClient;
    yield* sql`INSERT INTO audit (repository,operation,policy_revision,base_sha,produced_sha,bot_version,evidence)
    VALUES (${context.repository},${operation},${context.policyRevision},${context.baseSha},${context.producedSha},${context.botVersion},${pg.json(context.evidence)})`;
  });

export const saveEvidence = (
  repository: string,
  document: unknown,
  source: unknown,
) =>
  Effect.gen(function* () {
    const pg = yield* PgClient.PgClient;
    const sql = yield* SqlClient.SqlClient,
      digest = sha256(canonical(document));
    yield* sql`INSERT INTO evidence (digest,repository,source,document) VALUES (${digest},${repository},${pg.json(source)},${pg.json(document)}) ON CONFLICT DO NOTHING`;
    return digest;
  });

export const noDatabase = Layer.empty;
