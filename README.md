# ryro-bot

[![CI](https://github.com/ryro-hq/ryro-bot/actions/workflows/ci.yml/badge.svg?branch=main)](https://github.com/ryro-hq/ryro-bot/actions/workflows/ci.yml)
[![DCO: required](https://img.shields.io/badge/DCO-required-blue)](CONTRIBUTING.md#commits-and-dco)
[![License: Apache-2.0](https://img.shields.io/badge/license-Apache--2.0-blue)](LICENSE)

## Repositories

The [project registry](registry/projects.json) currently configures one repository:

| Repository                                              | What the bot does                                                                                                           | Current rollout                                        |
| ------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------ |
| [ryro-hq/srx-pkgs](https://github.com/ryro-hq/srx-pkgs) | Tracks CI runs, discovers `nginx` and `hello` releases, plans catalog updates and selects reviewers based on changed paths. | `observe` by default; catalog PR publication disabled. |

In write modes, the bot can dispatch preparation and qualification workflows
and open draft PRs when the project's publication gate allows it. It never
approves or merges PRs.

For local development, container usage and contribution rules, see
[CONTRIBUTING.md](CONTRIBUTING.md).
