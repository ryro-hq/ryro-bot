# Access, responsibility and recovery

`registry/projects.json` is the authoritative declaration of categories, package
owners, deputies and exceptions. Initially every category names `@fullzer4`;
deputies and independent reviewers are empty. Declarations do not verify GitHub
membership, MFA, recovery custody or reviewer independence.

Grant human access explicitly at the lowest useful role. Require MFA on the
organization, protect the default branch from direct pushes, deletion and force
pushes, require CODEOWNERS, a non-author human approval, approval dismissal after
new commits, last-push approval, resolved conversations and strict required
checks. No bypass actor, including the App, is permitted. The service verifies
effective rules before draft publication; a repository administrator must apply
and independently verify the proposed ruleset.

The App is installed only on the pilot. Permissions are contents write, pull
requests write, actions write, checks read and metadata read; no administration,
organization permission, status write or rules bypass. Token requests narrow
repository IDs and permissions per operation. `pull_requests:write` can approve
at the platform level: the independent branch rules remain essential even
though this client exposes no approval method.

The operator controls the Linux host, database and secret files. Admin CLI
authentication is possession of local OS access and the database credential;
restrict these to the operator, use a separate runtime host/database and do not
expose PostgreSQL or the CLI over HTTP. Keep App keys, webhook secrets, database
passwords and encrypted off-host backup credentials outside Git. Review access
after membership changes and at least every 90 days.

Recovery procedure: contain operations; revoke affected keys; preserve audit and
remote state; restore an encrypted backup to an isolated database; inspect dead
jobs and uncertain operations; reconcile in observation; verify human branch
protections and external security evidence; resume preparation, then publication.
Do not blindly replay dispatches or rewrite App branches. A second recovery
custodian and a rehearsed operator recovery without `@fullzer4` remain pending.
