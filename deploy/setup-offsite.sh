#!/usr/bin/env bash
# One-time setup of the encrypted off-site backup to DigitalOcean Spaces (or any S3 store).
# Run on the server as root, after creating a private bucket and a Spaces key limited to it:
#
#   sudo bash /opt/krubook/app/deploy/setup-offsite.sh
#
# It asks for the bucket, region and key, installs rclone, creates the encryption passphrase (once),
# writes /etc/krubook/offsite.env, enables the nightly timer and runs the first backup with its
# read-back check. Nothing is uploaded unencrypted. Details: docs/BACKUPS.md.
set -euo pipefail
[ "$(id -u)" = 0 ] || { echo "Run this as root: sudo bash $0" >&2; exit 1; }
APP=/opt/krubook/app
ENV=/etc/krubook/offsite.env
KEY=/etc/krubook/backup.key

ask() { local p="$1" d="${2:-}" v; read -r -p "$p${d:+ [$d]}: " v; echo "${v:-$d}"; }
asksecret() { local v; read -r -s -p "$1: " v; echo >&2; echo "$v"; }

echo "KruBook off-site backup setup"
BUCKET="$(ask 'Bucket name' 'krubook-backups')"
REGION="$(ask 'Region (sgp1, nyc3, fra1, ...)' 'sgp1')"
PREFIX="$(ask 'Folder inside the bucket' 'prod')"
ACCESS="$(ask 'Spaces access key')"
SECRET="$(asksecret 'Spaces secret key (hidden)')"
TG_TOKEN="$(ask 'Telegram bot token for failure alerts (optional)' '')"
TG_CHAT=""; [ -n "$TG_TOKEN" ] && TG_CHAT="$(ask 'Telegram chat ID')"
[ -n "$ACCESS" ] && [ -n "$SECRET" ] || { echo "The access key and secret are required." >&2; exit 1; }

command -v rclone >/dev/null || { echo "Installing rclone..."; apt-get install -yq rclone >/dev/null; }

NEWKEY=0
if [ ! -s "$KEY" ]; then
  head -c 48 /dev/urandom | base64 > "$KEY"
  NEWKEY=1
fi
chown root:krubook "$KEY" && chmod 640 "$KEY"

umask 027
cat > "$ENV" <<CONF
OFFSITE_TARGET=spaces:${BUCKET}/${PREFIX}
OFFSITE_PASSPHRASE_FILE=${KEY}
OFFSITE_KEEP_DAYS=30
RCLONE_CONFIG_SPACES_TYPE=s3
RCLONE_CONFIG_SPACES_PROVIDER=DigitalOcean
RCLONE_CONFIG_SPACES_ENDPOINT=${REGION}.digitaloceanspaces.com
RCLONE_CONFIG_SPACES_ACCESS_KEY_ID=${ACCESS}
RCLONE_CONFIG_SPACES_SECRET_ACCESS_KEY=${SECRET}
NOTIFY_TELEGRAM_TOKEN=${TG_TOKEN}
NOTIFY_TELEGRAM_CHAT=${TG_CHAT}
CONF
chown root:krubook "$ENV" && chmod 640 "$ENV"

install -m 644 "$APP/deploy/krubook-offsite.service" "$APP/deploy/krubook-offsite.timer" /etc/systemd/system/
systemctl daemon-reload
systemctl enable --now krubook-offsite.timer >/dev/null

echo "Running the first off-site backup (upload, read back, decrypt, check)..."
if systemctl start krubook-offsite.service; then
  journalctl -u krubook-offsite -n 3 --no-pager
  echo
  echo "Off-site backup is working. It runs every night at 03:00 UTC; Settings > Backup shows the result."
else
  journalctl -u krubook-offsite -n 20 --no-pager
  echo
  echo "The first backup FAILED (see above). Check the bucket name, region and key, then run this script again." >&2
  exit 1
fi
if [ "$NEWKEY" = 1 ]; then
  echo
  echo "=== Encryption passphrase: store it in your password manager NOW ==="
  cat "$KEY"
  echo "Without it, the off-site copies cannot be decrypted (for example if this server is lost)."
fi
