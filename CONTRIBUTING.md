# Contributing

Discuss larger behavior changes in an issue; send small fixes as pull requests.
Include the triggering case, expected behavior and focused verification. Run
`npm run verify` (formatting, lint, types, tests and build) and the PostgreSQL suite for persistence or reconciliation changes.
Use local product checks for recipe work. Security reports follow `SECURITY.md`.

Hooks are managed by `simple-git-hooks` in `package.json` and installed by
`npm install`. After `npm ci --ignore-scripts`, run `npm run hooks:install`.
The pre-commit hook runs `npm run quality`; CI requires the same formatting,
type-aware Oxlint and TypeScript checks. Use `npm run format` and `npm run lint:fix`
for automatic fixes. Commitlint checks subjects locally and in CI: `type(scope): description`,
for example `fix(queue): renew worker leases` or `chore(deps): update dependencies`.
Types: `feat`, `fix`, `chore`, `docs`, `style`, `refactor`, `perf`, `test`, `build`,
`ci`, `revert`. Scope is required and lowercase; breaking changes may use
`feat(api)!: description`. The `commit-msg` hook checks new commits locally;
CI's `quality` job checks every commit introduced by a PR.

Each contributor certifies the [Developer Certificate of Origin 1.1](https://developercertificate.org/)
by adding their own `Signed-off-by: Name <email>` trailer (`git commit -s`).
The [CNCF DCO2 App](https://github.com/cncf/dco2) validates sign-offs. Repository
rules require its `DCO` check from that App. It exempts bots and merge commits;
keep bot sign-offs and fix missing sign-offs instead of overriding the check.
`.github/dco.yml` requires member sign-offs, disables remediation and disables
the App's override action. DCO2 reads this file from the default branch and may
cache it for an hour, so configuration changes take effect after merging there
and cache expiry.
Do not add another person's sign-off. Contributions use the repository license.
Retain upstream notices and identify copied code, sources, patches and licenses.

While `@fullzer4` is the only maintainer, `ryro-bot` temporarily requires zero
approvals; CODEOWNER and last-push approval requirements are disabled. Resolve
conversations and use the merge queue with all required checks. Restore one
independent human approval, CODEOWNER review and last-push approval when another
maintainer can review. The App never approves or merges. The missing independent
reviewer and deputy remain acknowledged governance gaps.

Once required checks pass, add the PR to the merge queue. Quality, tests and the production
build run against the combined SHA before the queue rebases one PR at a time.
DCO sign-offs and individual commit messages are preserved; squash and merge commits are disabled.
DCO and commit subjects are checked on each PR before queue admission.
DCO2 reports success on merge groups based on admission; it does not revalidate
their commits. The required App check and absence of ruleset bypasses are essential.

Changes to registry, workflows, permissions, rollout gates and security policy
require explicit security review. Rules for a proposed change are loaded from
its base commit. Editing `.ryro-bot.toml` in a PR does not change its own rules.

For upstream patches, include DEP-3 metadata, source and patch digests, a minimal
reproduction, tests before/after and a removal condition. Preserve attribution
and licenses. A maintainer reviews patches before forwarding them through the
upstream project's process. Keep embargoed reports private.

## Releases

The `Release` workflow runs after successful **push** CI on `main`, independently
of CI and merge groups. Automation stays disabled until the repository variable
`RELEASES_ENABLED` is `true`. The first proposal is `0.1.0`; subsequent versions
follow Conventional Commits (`fix` → patch, `feat` → minor, breaking changes →
major). Release Please updates the package, lockfile and version manifest, with
notes in the PR and GitHub Release; `skip-changelog` avoids a generated Markdown
file. Do not use a permanent `release-as` override for the first version.

Create a dedicated GitHub App and install it **only on `ryro-hq/ryro-bot`**. Grant
repository **Contents: read/write** and **Pull requests: read/write**; metadata
read access is implicit. It needs no package permissions, merge permission,
ruleset bypass or webhook subscription. Store its client ID as the Actions
variable `RELEASE_APP_CLIENT_ID` and its PEM private key as the Actions secret
`RELEASE_APP_PRIVATE_KEY`. Then enable `RELEASES_ENABLED`. The official App token
Action creates scoped, temporary tokens and revokes them at job completion.

Release Please's official Action is pinned by SHA. After each proposal update,
the workflow formats the generated JSON and amends its single commit,
using the App's actual bot login and numeric user ID for both author and DCO
trailer. The subject is `chore(release): X.Y.Z`, compatible with commitlint.
Pushing the amended commit triggers fresh PR checks. Review the generated version, notes,
lockfile, DCO and quality results, then add the PR to the existing merge queue.
Rebase preserves the commit and sign-off. The App never approves or merges it.

After that merge, Release Please creates a **draft** and immediately fixes its
lightweight `vX.Y.Z` tag. Tags and draft contents are release state: do not move
or delete them. Each publication rechecks that the tag points to the full target
SHA, that this commit belongs to `main`, that all three version files agree and
that `CI` completed successfully for a `push` of that exact SHA on `main`.

GitHub CLI handles draft inspection, asset downloads/uploads and publication
directly in the workflow; there is no custom release program.

The workflow builds Linux `amd64` with an SPDX SBOM and SLSA provenance, pushing
a candidate to `ghcr.io/ryro-hq/ryro-bot`. Only `GITHUB_TOKEN` writes images.
`candidate.json`, attached to the draft before testing, fixes the image digest,
source SHA, version and build run. The downloaded digest must pass the compiled
CLI checks, PostgreSQL migrations (including repeat application and schema check)
and `/healthz` in `observe` mode. The same image index, including its attestations,
is promoted to `ghcr.io/ryro-hq/ryro-bot:X.Y.Z` without a rebuild. The runtime's
`RYRO_BOT_VERSION` remains the full source SHA; SemVer lives in the image's OCI
labels and release metadata.

**First registry push:** GHCR packages start private. When the candidate appears,
open the package's settings in GitHub and change its visibility to **Public**.
The publication gate checks the version tag anonymously and pulls the digest
with an empty Docker credential configuration. Until this succeeds, the release
remains a draft. No version/image badge advertises a release before this check.

To recover a failed run, select **Release → Run workflow**, branch `main`, and
supply the existing draft tag, for example `v0.1.0`. The workflow reuses the
digest from `candidate.json` and reuses completed qualification when all evidence
and `sha256sum --check` verifies the attached evidence. Incomplete qualification
resumes with the same digest and may replace partial evidence in the draft.
It accepts a preexisting version tag only if its
digest matches. Missing evidence, failed migrations, private packages and
conflicting tags stop publication. Published versions cannot be resumed or
overwritten; corrections require another release PR. If a failure precedes
`candidate.json`, no digest was committed and the candidate may be rebuilt.

Before publishing the draft, the App attaches `sbom.spdx.json`, `provenance.json`,
`release.json` (source SHA, digests, build/CI/qualification runs) and
`SHA256SUMS` (standard SHA-256 checksums for these files and `candidate.json`).
Failed smoke logs are retained in the workflow's evidence artifact. Releases
and GHCR are the distribution channels; deployment and applying production
migrations are manual.

Run `npm run verify` before changing release automation and validate workflow
changes with `actionlint`. Keep every external Action pinned by SHA. Image
checks run in named Actions steps using a temporary PostgreSQL service.
Activation, the human merge of the first release PR and the public
GHCR check require the configured GitHub services; local checks do not publish.
