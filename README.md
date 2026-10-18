# ryro-bot

Central GitHub App service for the Ryro open source projects. The first registered
project is `ryro-hq/syrox-pkgs`. TypeScript, Effect 4 and PostgreSQL; application,
database, App identity and credentials are independent of `ryro-backend`.

The split follows [rust-lang/triagebot](https://github.com/rust-lang/triagebot#how-triagebot-works):
a central event service, explicit repository configuration and durable state.
Builds and qualification run in GitHub Actions. The service never executes
recipes, project commands, patches or natural language from comments.

Implemented: signed webhook ingestion, durable deduplication, PostgreSQL jobs with
repository leases and fencing, bounded retries, periodic reconciliation, resumable
historical discovery, central ownership, bounded version planning, isolated
preparation, evidence admission, draft PR publication and recovery. Approval,
merge, force-push, branch deletion and rule administration are absent from the
GitHub client.

The shipped registry has `publicationEnabled: false`; the default mode is
`observe`. Engine/distribution revocation across cached artifacts, dependencies,
bundles, rollback, restarts and expired offline databases is a rollout blocker.
The publication evidence checker validates structure and context; certification,
cryptographic provenance verification and real cross-platform qualification are
not inferred from that checker. See [rollout status](docs/rollout.md).

## Develop

Use Node 24–26 and npm:

```sh
npm ci --ignore-scripts
npm run verify
python3 -m unittest discover -s tests -p 'test_*.py'
TEST_DATABASE_URL=postgres://postgres:local-test-only@127.0.0.1:15439/ryro_bot_test npm run test:integration
```

The PostgreSQL tests require a dedicated disposable database. Without
`TEST_DATABASE_URL`, the integration suite is explicitly skipped. Product tests
remain in `syrox-pkgs`; developing recipes does not require the bot or GitHub.

```sh
npm run admin -- route ryro-hq/syrox-pkgs fullzer4 recipes/packages/nginx/package.srx
npm run admin -- owners ryro-hq/syrox-pkgs /absolute/project
```

Other admin commands require local access to the configured database and secret
files. There is no public administrative HTTP API. Follow [operations](docs/operations.md)
for configuration, migration, observation, backups and recovery.

## Governance

[Access and recovery](governance/ACCESS.md), [contribution and DCO](CONTRIBUTING.md),
[coordinated disclosure](SECURITY.md), [attribution](NOTICE), and
[trust boundaries](docs/trust-model.md) are part of the initial delivery.
The [OSPS matrices](governance/osps/) cover all 65 requirements in v2026.08.28
and identify evidence, owner and remaining verification per project.
[Best Practices](governance/best-practices.json) and
[Scorecard](governance/scorecard.json) are separate, unassessed reports.
There is no certification or badge claim.
