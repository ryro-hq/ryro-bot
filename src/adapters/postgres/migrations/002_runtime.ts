import { Effect } from 'effect';
import { SqlClient } from 'effect/sql';

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  for (const statement of [
    `ALTER TABLE repositories ADD COLUMN github_id bigint UNIQUE, ADD COLUMN canonical_name text, ADD COLUMN last_claimed_at timestamptz`,
    `ALTER TABLE operations DROP CONSTRAINT operations_state_check, ADD COLUMN retry_at timestamptz, ADD CONSTRAINT operations_state_check CHECK (state IN ('intent','complete','uncertain','waiting'))`,
    `ALTER TABLE jobs ADD COLUMN coalesce_key text, ADD COLUMN generation integer NOT NULL DEFAULT 1, ADD COLUMN payload_version integer NOT NULL DEFAULT 1, ADD COLUMN priority integer NOT NULL DEFAULT 10`,
    `CREATE UNIQUE INDEX jobs_coalesced ON jobs (repository,coalesce_key) WHERE coalesce_key IS NOT NULL AND state IN ('pending','running')`,
    `CREATE TABLE workflow_runs (repository text NOT NULL, run_id bigint NOT NULL, attempt integer NOT NULL, workflow_id bigint NOT NULL, head_sha text NOT NULL, document jsonb NOT NULL, observed_at timestamptz NOT NULL DEFAULT clock_timestamp(), PRIMARY KEY(repository,run_id))`,
    `CREATE TABLE pull_history (repository text NOT NULL, number integer NOT NULL, document jsonb NOT NULL, PRIMARY KEY(repository,number))`,
    `CREATE TABLE pull_scans (repository text PRIMARY KEY, page integer NOT NULL DEFAULT 1, complete boolean NOT NULL DEFAULT FALSE)`,
    `CREATE TABLE github_limits (installation_id bigint PRIMARY KEY, blocked_until timestamptz)`,
  ])
    yield* sql.unsafe(statement);
});
