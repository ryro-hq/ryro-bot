# ryro-bot

[![CI](https://github.com/ryro-hq/ryro-bot/actions/workflows/ci.yml/badge.svg?branch=main)](https://github.com/ryro-hq/ryro-bot/actions/workflows/ci.yml)
[![DCO: required](https://img.shields.io/badge/DCO-required-blue)](CONTRIBUTING.md#commits-and-dco)
[![License: Apache-2.0](https://img.shields.io/badge/license-Apache--2.0-blue)](LICENSE)

GitHub App for Ryro open source maintenance: CI coordination, package catalog
updates and review routing. Built with TypeScript, Effect and PostgreSQL; the
initial pilot is `ryro-hq/srx-pkgs`. Default mode: `observe`.

## Repositories

The [project registry](registry/projects.json) currently configures one repository:

| Repository                                              | What the bot does                                                                                                           | Current rollout                                        |
| ------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------ |
| [ryro-hq/srx-pkgs](https://github.com/ryro-hq/srx-pkgs) | Tracks CI runs, discovers `nginx` and `hello` releases, plans catalog updates and selects reviewers based on changed paths. | `observe` by default; catalog PR publication disabled. |

In write modes, the bot can dispatch preparation and qualification workflows
and open draft PRs when the project's publication gate allows it. It never
approves or merges PRs.

## Contribution rules

Contributions use scoped Conventional Commits and the author's DCO sign-off.
Pull requests require `verify` and `DCO`, resolved conversations and the merge
queue, which rebases one PR at a time. While there is one maintainer, approvals
are temporarily not required; see the [review policy](CONTRIBUTING.md#review-and-merge-queue).

The CI badge shows checks on `main`; the DCO and license badges describe project
policies. Version and image badges will be added after the first verified public
release. [Assessment records](CONTRIBUTING.md#assessment-records) track the remaining governance work.

## Local development

For local development, use Node.js 24.12+ (supported majors: 24–26) and PostgreSQL:

```sh
npm ci --ignore-scripts
npm run hooks:install
npm run verify
```

Copy [.env.example](.env.example) to `.env`. Point `DATABASE_URL_FILE` to a file
containing the database URL and `GITHUB_WEBHOOK_SECRET_FILE` to a secret file
with at least 32 characters. Use host file paths for local development; the
example's `/run/secrets` paths are for containers. Set `RYRO_BOT_VERSION` and
`RYRO_POLICY_REVISION` to full Git SHAs.

For a local database without TLS, set `RYRO_LOCAL_DATABASE=true` and remove
`PG_CA_FILE`; accepted hosts are `localhost`, `127.0.0.1`, `[::1]` and `postgres`.
Production verifies TLS; set `PG_CA_FILE` when a custom CA is needed. `observe`
needs no GitHub App key; omit `RYRO_BINDINGS_FILE` when unused. Write modes need
the runtime App identity, private key and installation bindings. The pilot's
publication gate is disabled; see [registry configuration](registry/projects.json).

```sh
npm run migrate -- apply
npm run migrate -- check
npm run dev
```

The service listens on port 8790; `GET /healthz` checks database availability.
Set `HOST=0.0.0.0` when accessing it outside localhost. Set `TEST_DATABASE_URL`
to include the PostgreSQL integration tests in `npm run verify`.

## Container

Build and run the production image locally. Use `/run/secrets/...` paths in
the container's environment, matching the mounted files:

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

Once releases are enabled, the flow is: **version PR → merge queue → GitHub
Release and tag → container build and push**. Images use
`ghcr.io/ryro-hq/ryro-bot:X.Y.Z` for Linux `amd64`, with SBOM and provenance.
The GitHub Release is created before the image finishes publishing. See
[release setup and recovery](CONTRIBUTING.md#releases). Server deployment is manual.

[Contributing](CONTRIBUTING.md) · [Security](SECURITY.md) · [License](LICENSE)
