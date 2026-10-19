import { Effect } from 'effect';
import { SqlClient } from 'effect/sql';
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
export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  for (const statement of statements) yield* sql.unsafe(statement);
});
