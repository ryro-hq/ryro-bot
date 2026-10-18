# Operations

Provision an independent Linux host, TLS reverse proxy and off-host encrypted
backup destination. Domain selection and infrastructure purchasing are operator
tasks. Expose only HTTPS webhook traffic; PostgreSQL stays on the private Compose
network. Set body limits and a 15-second request timeout at the proxy.

Create the App from `deploy/github-app-manifest.json` after replacing the webhook
domain. Install on **only** `ryro-hq/syrox-pkgs` (numeric repository ID
`1380346000`, reverify before installation). Do not grant administration or bypass.
Record the resulting installation ID in an operator-owned
`deploy/bindings.json`, for example:

```json
{
  "ryro-hq/syrox-pkgs": { "repositoryId": 1380346000, "installationId": 123456 }
}
```

`123456` is an example, not a live installation. An empty `{}` is supported during
bootstrap; unbound repository webhooks are rejected. Copy `.env.example` to
`.env`, set the full reviewed source/policy revision, App ID and App bot login.
Place secrets in `secrets/`: `postgres-password`, `database-url`, `webhook-secret`
and `app.pem`. The database URL uses `postgres://ryro_bot:PASSWORD@postgres:5432/ryro_bot`.
Use at least 32 random bytes for the webhook secret. The URL must encode password
special characters. Restrict the directory to the operator and give the container
UID/GID 1000 read access without making files world-readable. Set
`GITHUB_APP_KEY_FILE=/etc/ryro-bot/secrets/app.pem` only when configured.

```sh
docker compose build
docker compose up -d
docker compose exec bot node dist/admin.js status
docker compose exec bot node dist/admin.js reconcile ryro-hq/syrox-pkgs
docker compose exec bot node dist/admin.js discover ryro-hq/syrox-pkgs nginx
docker compose exec bot node dist/admin.js inventory ryro-hq/syrox-pkgs
```

The service runs versioned migrations on startup under the PostgreSQL migrator
lock and refuses PostgreSQL configurations without fsync, full-page writes and
synchronous commits. `/healthz` checks database reachability. Start in observation and inspect
audit, incomplete channels, dead jobs and remote state before moving to
preparation. The admin CLI has local OS/database authentication; do not mount
these credentials into build runners. For a remote PostgreSQL server, disable
`RYRO_LOCAL_DATABASE` and configure `PG_CA_FILE` for certificate verification.

Every source page commits its bytes, observations and cursor atomically. An
interrupted scan resumes the cursor; an exhausted page budget reports incomplete.
Completed scans refresh after a day, retaining prior generations. Inventory
export uses 500-row cursor pages and does not promote discovered versions into
the product catalog. Plan limits stop catalog growth before its byte/combination
limits. Keep the PostgreSQL volume and evidence outside product Git repositories;
monitor disk growth, failed jobs and incomplete scans. Do not prune audit,
preparation evidence or discovery pages without an explicit retention decision.

If a dispatch times out, its durable intention blocks resubmission. Inspect the
actual Actions run in the bound repository and recover only that run:

```sh
docker compose exec bot node dist/admin.js recover-dispatch ryro-hq/syrox-pkgs BATCH_ID RUN_ID
```

The CLI checks base, repository, workflow and policy before adoption. A failed
preparation remains visible rather than being endlessly dispatched. If the base
moves, reconcile and replan; human commits and closed PRs are never overwritten.
Use `hold REPOSITORY PACKAGE VERSION revoked REASON...` to stop bot planning;
that command is not installed-artifact revocation.

Run `scripts/backup.sh /external/path/backup.age` with `BACKUP_AGE_RECIPIENT` and
`age` installed. Copy encrypted bytes plus SHA256 to independent storage; monitor
success. Back up daily and before migrations; retain at least 30 daily snapshots
and the last pre-migration snapshot. App keys and recovery material need a
separate encrypted custody procedure. An off-host backup job and second
custodian have not been provisioned by this repository.

Rehearse restore in an isolated PostgreSQL instance: verify the encrypted digest,
decrypt into a restricted temporary directory, `pg_restore --exit-on-error` into
a fresh database, run migrations, compare delivery/job/audit/evidence counts and
digests, and start `observe`. Check pending/dead jobs, expired leases, uncertain
operations and actual remote refs/PRs before enabling preparation. Replayed
delivery IDs must leave counts unchanged; stale workers must fail lease renewal.
Never restore a snapshot over an active writer or automatically replay uncertain
remote writes. Resume on the verified restored database only after review.
