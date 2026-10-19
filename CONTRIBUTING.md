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
`feat(api)!: description`. The `commit-msg` hook and PR CI check every new commit.

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

Review must come from a human other than the author. Resolve conversations and
obtain fresh approval after new commits. The App never approves or merges.
With only `@fullzer4` registered, their changes wait for another human; an empty
deputy or independent reviewer list is an acknowledged governance gap.

After approval, add the PR to the merge queue. Quality, tests and the production
build run against the combined SHA before the queue rebases one PR at a time.
DCO sign-offs and individual commit messages are preserved; squash and merge commits are disabled.
DCO and commit subjects are checked on each PR before queue admission.
DCO2 reports success on merge groups based on admission; it does not revalidate
their commits. The required App check and absence of ruleset bypasses are essential.
CodeQL results are required; high or critical security findings and errors
block integration.

Changes to registry, workflows, permissions, rollout gates and security policy
require explicit security review. Rules for a proposed change are loaded from
its base commit. Editing `.ryro-bot.toml` in a PR does not change its own rules.

For upstream patches, include DEP-3 metadata, source and patch digests, a minimal
reproduction, tests before/after and a removal condition. Preserve attribution
and licenses. A maintainer reviews patches before forwarding them through the
upstream project's process. Keep embargoed reports private.
