# Security and coordinated disclosure

Report vulnerabilities through [GitHub's private reporting form](https://github.com/ryro-hq/ryro-bot/security/advisories/new)
(**Security → Report a vulnerability**). Private vulnerability reporting is
enabled. If that channel is unavailable, request a private contact channel from
`@fullzer4` without publishing exploit details or secrets. No monitored security
email address or response SLA is claimed.

Include affected revisions, impact, a minimal reproduction, required privileges
and any mitigation. Keep embargoes private. The maintainer coordinates scope,
affected consumers, fixes, upstream contact, advisory publication and recovery
with the reporter before disclosure. Bots do not forward reports to upstream.

An incident can be contained by setting `RYRO_MODE=observe`, stopping the service
and revoking the runtime App key/installation tokens. If release automation is
affected, set the Actions variable `RELEASES_ENABLED=false` and revoke the
separate release App's credentials. Check audit records and all remote
branches/PRs; preserve human commits. Restore from a verified off-host backup and
resume observation before enabling operations. See [container setup](CONTRIBUTING.md#container).

Blocking a discovered package release in the bot prevents planning only; it does
not revoke installed or cached bytes. The pilot's catalog publication gate
remains disabled. This runtime gate is separate from this repository's GitHub
Releases and container publication; see [release operations](CONTRIBUTING.md#releases).
