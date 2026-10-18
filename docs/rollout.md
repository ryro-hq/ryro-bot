# Rollout and evidence status

The initial registry disables publication. No App installation, production host,
domain, administrator rule change, artifact release or automatic PR activation
is performed merely by deploying this source.

| Stage                | Delivered                                                                                                                         | Remaining evidence / dependency                                                                                                                                                                                                |
| -------------------- | --------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Foundation           | Central registry, ownership generation, contribution/DCO, access/recovery, disclosure, attribution, complete OSPS maps            | Independent reviewer, deputy and recovery custodian; MFA and effective GitHub policy evidence                                                                                                                                  |
| CI / bootstrap       | SHA-pinned Actions, isolated preparation, existing Debian/Ubuntu GNU/musl qualification retained, fixture distribution contract   | Authenticated fixture endpoint serving identical bytes plus corresponding source/license history; fixture remains tracked                                                                                                      |
| Inventory            | Durable page bytes, complete/incomplete state, resumable cursor/generation, historical and prerelease discovery, CLI JSONL export | Live App-bound scans and operator storage sizing/retention                                                                                                                                                                     |
| Reconciliation       | Five versions per package/profile; four open App PRs; draft creation; closed/human/orphan/base/check handling                     | Live App installation and staged observation/preparation evidence; independent review                                                                                                                                          |
| Security/publication | Planning holds; publication evidence admission; default publication gate closed                                                   | Engine/distribution enforcement for cached Store objects, dependency closure, bundles, rollback, restarts, monotonic authenticated offline databases and expiry; actual SBOM, source, patch, license and provenance validation |
| Upstream/expansion   | DEP-3 process and explicit registry registration                                                                                  | Human-reviewed upstream submissions; project-specific adapters/tests for each new repository                                                                                                                                   |

Rollout order is `observe` → `prepare` → `publish`. Observation reads GitHub and
persists reports; preparation additionally dispatches isolated Actions work and
stores verified changes without publishing a branch or PR. Publication requires
a reviewed central registry change, at least one independent reviewer, verified
effective rules and all external security/publication evidence above. Do not
set `publicationEnabled` while any security dependency is pending.

The product's release workflow has an additional registry-variable gate and
protected environment. Creating a draft release is not permission to publish
unqualified bytes. No security certification, Best Practices badge, Scorecard
score, distribution-kernel support or new platform support is asserted.
