#!/usr/bin/env bash
# Restores a backup into an isolated folder and checks it. Never touches the live database.
#   restore-check.sh <backup file: .sqlite, .sqlite.gz or .sqlite.gz.enc> [passphrase file]
# Prints row counts for the important tables; exits non-zero if anything is wrong.
set -euo pipefail
umask 077
src="$1"; key="${2:-${OFFSITE_PASSPHRASE_FILE:-}}"
out="$(mktemp -d)/restored.sqlite"
case "$src" in
  *.enc) [ -n "$key" ] || { echo "Give the passphrase file for an encrypted backup." >&2; exit 2; }
         openssl enc -d -aes-256-cbc -pbkdf2 -iter 200000 -pass "file:$key" -in "$src" | gunzip > "$out" ;;
  *.gz)  gunzip -c "$src" > "$out" ;;
  *)     cp "$src" "$out" ;;
esac
node --no-warnings "$(dirname "$(readlink -f "$0")")/dbtool.cjs" check "$out"
echo "Restored copy (isolated): $out"
