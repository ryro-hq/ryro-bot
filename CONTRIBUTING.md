# Contributing

Discuss larger behavior changes in an issue; send small fixes as pull requests.
Include the triggering case, expected behavior and focused verification. Run
`npm run verify` and the PostgreSQL suite for persistence or reconciliation changes.
Use local product checks for recipe work. Security reports follow `SECURITY.md`.

Run `npm run hooks:install` after cloning, including when installing dependencies
with `--ignore-scripts`. Commit subjects must use `type(scope): description`,
for example `fix(queue): renew worker leases` or `chore(deps): update dependencies`.
Types: `feat`, `fix`, `chore`, `docs`, `style`, `refactor`, `perf`, `test`, `build`,
`ci`, `revert`. Scope is required and lowercase; breaking changes may use
`feat(api)!: description`. The `commit-msg` hook and PR CI check every new commit.

Each contributor certifies the [Developer Certificate of Origin 1.1](https://developercertificate.org/)
by adding their own `Signed-off-by: Name <email>` trailer (`git commit -s`).
Do not add another person's sign-off. Contributions use the repository license.
Retain upstream notices and identify copied code, sources, patches and licenses.

Review must come from a human other than the author. Resolve conversations and
obtain fresh approval after new commits. The App never approves or merges.
With only `@fullzer4` registered, their changes wait for another human; an empty
deputy or independent reviewer list is an acknowledged governance gap.

Changes to registry, workflows, permissions, rollout gates and security policy
require explicit security review. Rules for a proposed change are loaded from
its base commit. Editing `.ryro-bot.toml` in a PR does not change its own rules.

For upstream patches, include DEP-3 metadata, source and patch digests, a minimal
reproduction, tests before/after and a removal condition. Preserve attribution
and licenses. A maintainer reviews patches before forwarding them through the
upstream project's process. Keep embargoed reports private.
