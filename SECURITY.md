# Security and coordinated disclosure

Report vulnerabilities privately using the repository's **Security → Report a
vulnerability** feature. Enable private vulnerability reporting before public
rollout. If that channel is unavailable, request a private contact channel from
`@fullzer4` without publishing exploit details or secrets. No monitored security
email address or response SLA is claimed.

Include affected revisions, impact, a minimal reproduction, required privileges
and any mitigation. Keep embargoes private. The maintainer coordinates scope,
affected consumers, fixes, upstream contact, advisory publication and recovery
with the reporter before disclosure. Bots do not forward reports to upstream.

An incident can be contained by setting `RYRO_MODE=observe`, stopping the service
and revoking the App key/installation tokens. Check audit records and all remote
branches/PRs; preserve human commits. Restore from a verified off-host backup and
resume observation before enabling operations. See [container setup](README.md#container).

Blocking a discovered release in the bot prevents planning only. It does not
revoke installed/cached bytes. Production publication remains disabled until
independent engine/distribution controls and their tests cover those paths.
