#!/usr/bin/env bash
# Encrypted off-site copy of the KruBook database, then a read-back check of what was uploaded.
#
# Settings come from /etc/krubook/env plus /etc/krubook/offsite.env (mode 640, root:krubook):
#   OFFSITE_TARGET           rclone destination, e.g. "spaces:krubook-backups/prod",
#                            or "dir:/some/path" for a plain directory (tests, mounted disks)
#   OFFSITE_PASSPHRASE_FILE  file holding the encryption passphrase (keep a copy off the server!)
#   OFFSITE_KEEP_DAYS        days to keep remote copies (default 30)
#   RCLONE_CONFIG_*          rclone remote settings as environment variables (see docs/BACKUPS.md)
#   NOTIFY_TELEGRAM_TOKEN / NOTIFY_TELEGRAM_CHAT  optional failure alerts
# The database is never uploaded unencrypted, and no credentials are written into the backup.
set -euo pipefail
umask 077

[ -f /etc/krubook/env ] && { set -a; . /etc/krubook/env; set +a; }
[ -f /etc/krubook/offsite.env ] && { set -a; . /etc/krubook/offsite.env; set +a; }
: "${KRUBOOK_DB:?KRUBOOK_DB is not set}"
: "${OFFSITE_TARGET:?OFFSITE_TARGET is not set (see docs/BACKUPS.md)}"
: "${OFFSITE_PASSPHRASE_FILE:?OFFSITE_PASSPHRASE_FILE is not set}"
KEEP_DAYS="${OFFSITE_KEEP_DAYS:-30}"
STATUS_DIR="${KRUBOOK_BACKUP_DIR:-/var/backups/krubook}"
STAMP="$(date -u +%Y-%m-%dT%H%M%SZ)"
NAME="krubook-$STAMP.sqlite.gz.enc"
WORK="$(mktemp -d)"
STARTED="$(date -u +%FT%TZ)"
trap 'rm -rf "$WORK"' EXIT

TOOL="$(dirname "$(readlink -f "$0")")/dbtool.cjs"
status() { node --no-warnings "$TOOL" status "$STATUS_DIR/status-offsite.json" "$1" "${2:-}" "$NAME" "${BYTES:-}" "${SHA:-}" "$STARTED"; }
fail() {
  echo "Off-site backup FAILED: $1" >&2
  mkdir -p "$STATUS_DIR"; status 0 "$1" || true
  if [ -n "${NOTIFY_TELEGRAM_TOKEN:-}" ] && [ -n "${NOTIFY_TELEGRAM_CHAT:-}" ]; then
    curl -fsS -m 20 "https://api.telegram.org/bot${NOTIFY_TELEGRAM_TOKEN}/sendMessage" \
      --data-urlencode "chat_id=${NOTIFY_TELEGRAM_CHAT}" --data-urlencode "text=KruBook off-site backup failed on $(hostname): $1" >/dev/null || true
  fi
  exit 1
}
trap 'fail "unexpected error on line $LINENO"' ERR

check_db() { node --no-warnings "$TOOL" check "$1" | node --no-warnings -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{const c=JSON.parse(s).counts;console.log(Object.entries(c).map(([k,v])=>k+"="+v).join(" "))})'; }

[ -s "$OFFSITE_PASSPHRASE_FILE" ] || fail "passphrase file $OFFSITE_PASSPHRASE_FILE is missing or empty"

# 1. Consistent snapshot, checked before it leaves the server.
node --no-warnings "$TOOL" snapshot "$KRUBOOK_DB" "$WORK/db.sqlite" || fail "snapshot failed"
SRC_COUNTS="$(check_db "$WORK/db.sqlite")" || fail "snapshot failed its integrity check"

# 2. Compress and encrypt (AES-256, key derived with PBKDF2).
gzip -9 -c "$WORK/db.sqlite" > "$WORK/db.sqlite.gz"
openssl enc -aes-256-cbc -pbkdf2 -iter 200000 -salt -pass "file:$OFFSITE_PASSPHRASE_FILE" -in "$WORK/db.sqlite.gz" -out "$WORK/$NAME"
SHA="$(sha256sum "$WORK/$NAME" | cut -d' ' -f1)"
BYTES="$(stat -c %s "$WORK/$NAME")"
echo "$SHA  $NAME" > "$WORK/$NAME.sha256"

# 3. Upload, then download it again and prove it decrypts to the same database.
if [[ "$OFFSITE_TARGET" == dir:* ]]; then
  DEST="${OFFSITE_TARGET#dir:}"; mkdir -p "$DEST"
  cp "$WORK/$NAME" "$WORK/$NAME.sha256" "$DEST/"
  cp "$DEST/$NAME" "$WORK/check.enc"
  find "$DEST" -name 'krubook-*.sqlite.gz.enc*' -mtime +"$KEEP_DAYS" -delete
else
  command -v rclone >/dev/null || fail "rclone is not installed"
  rclone copyto "$WORK/$NAME" "$OFFSITE_TARGET/$NAME" --s3-no-check-bucket || fail "upload failed"
  rclone copyto "$WORK/$NAME.sha256" "$OFFSITE_TARGET/$NAME.sha256" --s3-no-check-bucket || fail "checksum upload failed"
  rclone copyto "$OFFSITE_TARGET/$NAME" "$WORK/check.enc" || fail "read-back download failed"
  rclone delete "$OFFSITE_TARGET" --min-age "${KEEP_DAYS}d" --include 'krubook-*.sqlite.gz.enc*' || echo "warning: pruning old copies failed" >&2
fi
[ "$(sha256sum "$WORK/check.enc" | cut -d' ' -f1)" = "$SHA" ] || fail "the uploaded copy does not match (checksum differs)"
openssl enc -d -aes-256-cbc -pbkdf2 -iter 200000 -pass "file:$OFFSITE_PASSPHRASE_FILE" -in "$WORK/check.enc" | gunzip > "$WORK/check.sqlite" || fail "the uploaded copy does not decrypt"
CHECK_COUNTS="$(check_db "$WORK/check.sqlite")" || fail "the uploaded copy failed its integrity check"
[ "$SRC_COUNTS" = "$CHECK_COUNTS" ] || fail "the uploaded copy has different contents ($CHECK_COUNTS vs $SRC_COUNTS)"

mkdir -p "$STATUS_DIR"; status 1 ""
echo "Off-site backup OK: $NAME ($BYTES bytes, $SRC_COUNTS)"
