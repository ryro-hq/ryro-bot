# ryro-bot

[![CI](https://github.com/ryro-hq/ryro-bot/actions/workflows/ci.yml/badge.svg?branch=main)](https://github.com/ryro-hq/ryro-bot/actions/workflows/ci.yml)
[![License: Apache-2.0](https://img.shields.io/badge/license-Apache--2.0-blue)](LICENSE)

GitHub App for Ryro open source maintenance: CI coordination, package catalog
updates and review routing. Built with TypeScript, Effect and PostgreSQL; the
initial pilot is `ryro-hq/srx-pkgs`. Default mode: `observe`.

For local development, use Node.js 24.12+ (supported majors: 24–26) and PostgreSQL:

```sh
npm ci --ignore-scripts
npm run hooks:install
npm run verify
```

Copy [.env.example](.env.example) to `.env`. Mount the database URL and webhook
secret as files; set `RYRO_BOT_VERSION` and `RYRO_POLICY_REVISION` to full Git SHAs.
Use `RYRO_LOCAL_DATABASE=true` only for a local database without TLS; production
uses `PG_CA_FILE`. `observe` needs no GitHub App key; write modes require the App
identity, private key and installation bindings described in the example.

```sh
npm run migrate -- apply
npm run migrate -- check
npm run dev
```

The service listens on port 8790; `GET /healthz` checks database availability.
Set `HOST=0.0.0.0` when accessing it outside localhost. Set `TEST_DATABASE_URL`
to include the PostgreSQL integration tests in `npm run verify`.

Build and run the production image locally:

```sh
docker build --build-arg RYRO_BOT_VERSION="$(git rev-parse HEAD)" -t ryro-bot:local .
docker run --rm --env-file .env --mount type=bind,src="$PWD/secrets",dst=/run/secrets,readonly \
  ryro-bot:local node dist/migrate.js apply
docker run --rm --env-file .env --mount type=bind,src="$PWD/secrets",dst=/run/secrets,readonly \
  -p 127.0.0.1:8790:8790 -e HOST=0.0.0.0 ryro-bot:local
```

Use a database hostname reachable from the container. Migrations require only
database configuration; run them before starting the service. Compiled admin
commands are available with `node dist/admin.js --help`.

Releases go through a reviewed Release Please PR, the merge queue and image
qualification. See [release setup and recovery](CONTRIBUTING.md#releases).
Deployment to the server is manual. Version and registry badges will be added
after the first verified publication.

[Contributing](CONTRIBUTING.md) · [Security](SECURITY.md) · [License](LICENSE)
