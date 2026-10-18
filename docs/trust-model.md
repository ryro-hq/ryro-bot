# Trust model

The webhook secret authenticates exact request bytes. Repository name, numeric
repository ID and installation ID must match operator bindings; the receiver
commits the delivery and reconcile job in one transaction before returning 202.
Duplicate delivery IDs with different bytes are rejected. Events trigger a
fresh snapshot rather than applying stale event payloads in order. The periodic
scheduler repairs missed notifications. Request bodies, API responses and
pagination are bounded. Incomplete snapshots stop writes.

The accepted base SHA supplies `.ryro-bot.toml` and the catalog. Its policy
revision must match the deployed central revision; no PR-head configuration is
consulted. The trusted central registry supplies origin URLs, package/profile
registration, limits and routing. Upstream discovery records observations only;
pre-releases and development releases remain distinguishable, and a version is
admitted only by reviewed product changes and qualification.

Actions jobs receive read permissions and no App credentials. They execute the
project's native tools on the exact base in an isolated runner. The central
preparation workflow is pinned by SHA. Only bounded package/catalog/lock changes
are returned; default promotion and mutation/removal of existing catalog rows
are rejected. The service verifies run repository, head, event, conclusion,
attempt, referenced workflow, artifact archive digest, expanded bounds, file
digests and original blobs. Prepared files are published through GitHub's object
APIs; the service executes no returned code or shell command.

PostgreSQL owns jobs, leases, operation intentions, release observations, page
bytes, prepared documents and audit evidence. One worker owns a repository at
a time, with renewable leases and tokens fencing stale workers. Uncertain
dispatches are not automatically repeated. Backup/restore and remote snapshot
reconciliation are required before replay. Remote API calls cannot be made
transactional with PostgreSQL; idempotent object identity, deterministic branches
and conservative recovery close that gap without claiming exactly-once delivery.

Human commits, unknown branches, closed PRs and duplicate/conflicting PRs are
preserved. The bot creates drafts and requests review; it cannot approve or
merge. Qualified checks must belong to the actual head. A failed/pending run is
not dispatched again, and a grace period permits automatic PR CI to appear.

The publication evidence predicate validates completeness and byte/environment
binding declarations. A producer's assertions are not proof of cryptographic
provenance, source-license completeness or deployment revocation. Those
independent controls are mandatory rollout gates, recorded in `rollout.md`.
