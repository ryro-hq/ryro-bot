# Upstream patches

Keep patches and their public tracking beside the affected package. Each patch
needs a DEP-3 header: `Description`, `Origin`, `Author`, `Bug`/upstream issue when
public, `Forwarded`, `Last-Update`, `Applied-Upstream` when known, and a clear
removal condition. Preserve the original license and attribution.

Attach a minimal reproduction, a failing test on the unpatched source and a
passing test on the patched bytes, source/patch digests, environment identity
and affected package/profile versions. A maintainer reviews the report and patch
under the upstream project's contribution/security process before forwarding.
Record the upstream URL, outcome and removal release. Never forward an embargo
or private advisory into a public issue, PR, comment or discovery artifact.

The pilot does not send upstream messages, create issues or interpret comment
commands. An explicitly registered new project supplies its own adapter,
reproducible local tests, ownership and evidence requirements before activation.
