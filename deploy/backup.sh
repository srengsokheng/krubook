#!/usr/bin/env bash
# Daily consistent copy of the database (SQLite VACUUM INTO), keeping the last 14 days.
set -euo pipefail
umask 027
set -a; . /etc/krubook/env; set +a
out="/var/backups/krubook/krubook-$(date +%F-%H%M).sqlite"
TOOL="$(dirname "$(readlink -f "$0")")/dbtool.cjs"
node --no-warnings "$TOOL" snapshot "$KRUBOOK_DB" "$out"
gzip -f "$out"
find /var/backups/krubook -name 'krubook-*.sqlite.gz' -mtime +14 -delete
# Status for Settings -> Backup and for monitoring.
node --no-warnings "$TOOL" status /var/backups/krubook/status-local.json 1 "" "$out.gz"
echo "Backup written: $out.gz"
