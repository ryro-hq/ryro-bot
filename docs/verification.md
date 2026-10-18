# Verification record

Verified locally on 2026-10-18 and in the public repository's GitHub Actions CI.
The initial published CI is [run 39175537939](https://github.com/ryro-hq/ryro-bot/actions/runs/39175537939).

- `npm run verify`: formatting, TypeScript checking, 25 unit tests and build passed.
- Real PostgreSQL 18: 7 integration tests passed, including concurrent delivery
  deduplication, transactional rollback, repository leases, stale-worker fencing,
  bounded retries, pagination recovery and durable evidence.
- Python: 4 tests passed for authenticated byte-pinned fixture retrieval and
  constrained preparation. The fixture stays tracked with its original SHA256.
- `actionlint` 1.7.12, checked against its release SHA256, accepted central and
  pilot workflows. Shell/Python syntax checks passed.
- OCI builds on the digest-pinned Node 24 image passed, including production
  dependency pruning/audit. Runtime uses an unprivileged user and read-only root.
- HTTP smoke test: invalid signature returned 401; two identical signed deliveries
  returned 202 and persisted one delivery/job. Health returned 200 with PostgreSQL
  `fsync`, `full_page_writes` and `synchronous_commit` all enabled.
- A PostgreSQL custom-format backup restored into a separate database with
  identical delivery/job/audit/evidence/release counts. Replaying the delivery on
  the restored service still left exactly one delivery and one job.
- Preserved pilot checks passed: 28 package/API cases, 39 platform cases,
  6 managed-seed cases, 9 package-template tests, 4 configured-template tests,
  5 host-qualification tests, native catalog generation/check and both lock checks.
  The catalog still contains the same 6 version/variant/system combinations.

These checks do not substitute for live App installation, human review, production
host/off-host backup provisioning, full VM rebuild qualification, independent
engine/distribution revocation tests, cryptographic provenance verification or
certification. Those remain explicit blockers in `rollout.md`.
