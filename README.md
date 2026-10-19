# ryro-bot

Central GitHub App for Ryro open source maintenance, built with TypeScript,
Effect and PostgreSQL. Node 24.12+ runs TypeScript directly. The initial pilot is `ryro-hq/srx-pkgs`.

```sh
npm ci --ignore-scripts
npm run hooks:install
npm run verify
```

```sh
docker build -t ryro-bot .
```

Configure with [.env.example](.env.example), supply PostgreSQL and mount the
configured secrets. The service listens on port 8790; health check: `/healthz`.
Run `node dist/migrate.js apply` before starting; use `status` or `check` to inspect
the schema. Migrations need only database configuration. Default mode: `observe`;
automatic publication is disabled.

`src/kernel` coordinates jobs; `modules` contains CI, catalog and review behavior;
`adapters` provides GitHub, PostgreSQL, HTTP and CLI. `app` wires Effect layers.
Tests mirror these boundaries. Set `TEST_DATABASE_URL` to run PostgreSQL tests.

[Contributing](CONTRIBUTING.md) · [Security](SECURITY.md) · [License](LICENSE)
