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

The `Release Please` workflow runs on pushes to `main` and maintains a version
PR from Conventional Commits. The first proposal is `0.1.0`; subsequent versions
follow `fix` → patch, `feat` → minor and breaking changes → major. It updates the
package, lockfile and version manifest; notes stay in the PR and GitHub Release
with `skip-changelog: true`.

Create a dedicated GitHub App installed **only on `ryro-hq/ryro-bot`**, with
**Contents: read/write** and **Pull requests: read/write**. Store its client ID as
Actions variable `RELEASE_APP_CLIENT_ID` and its PEM private key as secret
`RELEASE_APP_PRIVATE_KEY`. Set variable `RELEASES_ENABLED=true` to enable both
workflows. The official token Action creates temporary tokens; the App needs
no package permissions or ruleset bypass.

The proposal is formatted and committed with the App's identity and DCO
sign-off as `chore(release): X.Y.Z`. Review it and use the existing merge queue;
CI and DCO checks remain required. The App never approves or merges the PR.
After integration, Release Please creates the `vX.Y.Z` tag and GitHub Release.
Its App token allows the tag push to trigger the separate container workflow.

`Publish container` checks out that tag, logs into GHCR with `GITHUB_TOKEN` and
uses the official Docker metadata and build/push Actions to publish
`ghcr.io/ryro-hq/ryro-bot:X.Y.Z` for Linux `amd64`. Buildx attaches SBOM and
provenance to the image. SemVer is in OCI metadata; `RYRO_BOT_VERSION` contains
the full source SHA. Application and image checks run in the existing CI.

The GitHub Release exists before image publication finishes. If publishing
fails, use **Re-run failed jobs** on that tag's `Publish container` run; this
builds and pushes the image again. Keep published Git tags fixed.

After the first push, change the GHCR package visibility to **Public** in its
settings and verify that an anonymous `docker pull` succeeds. Deployment and
production migrations remain manual.

Keep external Actions pinned by SHA. Validate workflow edits with `actionlint`
and follow the existing `npm run verify` checks.
