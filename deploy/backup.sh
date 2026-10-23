#!/usr/bin/env bash
# Daily consistent copy of the database (SQLite VACUUM INTO), keeping the last 14 days.
set -euo pipefail
umask 027
set -a; . /etc/krubook/env; set +a
out="/var/backups/krubook/krubook-$(date +%F-%H%M).sqlite"
node --no-warnings -e "const {DatabaseSync}=require('node:sqlite'); new DatabaseSync(process.env.KRUBOOK_DB).exec(\"VACUUM INTO '$out'\")"
gzip -f "$out"
find /var/backups/krubook -name 'krubook-*.sqlite.gz' -mtime +14 -delete
echo "Backup written: $out.gz"
