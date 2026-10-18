#!/bin/sh
set -eu
umask 077
: "${BACKUP_AGE_RECIPIENT:?Set the off-host age recipient}"
: "${1:?Supply a new backup path outside the repository}"
test ! -e "$1"
temporary="$1.partial"
test ! -e "$temporary"
dump=$(mktemp "${1}.dump.XXXXXX")
trap 'rm -f "$temporary" "$dump"' EXIT HUP INT TERM
# PostgreSQL custom format provides a consistent snapshot, including audit/evidence.
# Do not log secret values or place plaintext dumps in Git/product directories.
docker compose exec -T postgres pg_dump -U ryro_bot -d ryro_bot -Fc > "$dump"
age -r "$BACKUP_AGE_RECIPIENT" -o "$temporary" "$dump"
rm -f "$dump"
mv "$temporary" "$1"
sha256sum "$1" > "$1.sha256"
printf '%s\n' 'Encrypted backup complete; copy it and its digest to independent off-host storage.'
