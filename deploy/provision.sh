#!/usr/bin/env bash
# One-time server setup for KruBook on Ubuntu 24.04. Run as root. Safe to re-run.
set -euo pipefail
HOST="${KRUBOOK_HOST:?set KRUBOOK_HOST, e.g. 159-89-199-180.sslip.io}"
CI_PUBKEY="${CI_PUBKEY:?set CI_PUBKEY to the public deploy key}"

# 1 GB swap: the droplet has 512 MB of RAM, which npm alone can exhaust.
if ! swapon --show | grep -q /swapfile; then
  fallocate -l 1G /swapfile && chmod 600 /swapfile && mkswap /swapfile && swapon /swapfile
  grep -q /swapfile /etc/fstab || echo '/swapfile none swap sw 0 0' >> /etc/fstab
fi

export DEBIAN_FRONTEND=noninteractive
apt-get update -q
apt-get install -yq ca-certificates curl gnupg rsync ufw debian-keyring debian-archive-keyring apt-transport-https

# Node.js 22 (NodeSource)
if ! node -v 2>/dev/null | grep -q '^v22'; then
  curl -fsSL https://deb.nodesource.com/setup_22.x | bash -
  apt-get install -yq nodejs
fi

# Caddy (official repository): HTTPS certificates are obtained and renewed automatically.
if ! command -v caddy >/dev/null; then
  curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/gpg.key' | gpg --dearmor -o /usr/share/keyrings/caddy-stable-archive-keyring.gpg
  curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/debian.deb.txt' > /etc/apt/sources.list.d/caddy-stable.list
  apt-get update -q && apt-get install -yq caddy
fi

ufw allow OpenSSH >/dev/null; ufw allow 80/tcp >/dev/null; ufw allow 443/tcp >/dev/null; ufw --force enable >/dev/null

# App user, folders and secrets
id krubook >/dev/null 2>&1 || useradd --system --create-home --home-dir /home/krubook --shell /bin/bash krubook
install -d -o krubook -g krubook /opt/krubook/app
install -d -m 750 -o krubook -g krubook /var/lib/krubook /var/backups/krubook
install -d -m 700 -o krubook -g krubook /home/krubook/.ssh
touch /home/krubook/.ssh/authorized_keys
grep -qF "$CI_PUBKEY" /home/krubook/.ssh/authorized_keys || echo "$CI_PUBKEY" >> /home/krubook/.ssh/authorized_keys
chown krubook:krubook /home/krubook/.ssh/authorized_keys && chmod 600 /home/krubook/.ssh/authorized_keys

install -d -m 750 -o root -g krubook /etc/krubook
if [ ! -f /etc/krubook/env ]; then
  cat > /etc/krubook/env <<ENV
NODE_ENV=production
PORT=4310
KRUBOOK_DB=/var/lib/krubook/krubook.sqlite
KRUBOOK_SETUP_TOKEN=$(head -c 18 /dev/urandom | base64 | tr -d '/+=' | cut -c1-20)
ENV
  chmod 640 /etc/krubook/env && chown root:krubook /etc/krubook/env
fi

# The deploy user may restart only this service.
echo 'krubook ALL=(root) NOPASSWD: /usr/bin/systemctl restart krubook, /usr/bin/systemctl is-active krubook' > /etc/sudoers.d/krubook
chmod 440 /etc/sudoers.d/krubook

install -m 644 /tmp/krubook-deploy/krubook.service /etc/systemd/system/krubook.service
install -m 644 /tmp/krubook-deploy/krubook-backup.service /etc/systemd/system/krubook-backup.service
install -m 644 /tmp/krubook-deploy/krubook-backup.timer /etc/systemd/system/krubook-backup.timer
sed "s/__HOST__/$HOST/g" /tmp/krubook-deploy/Caddyfile > /etc/caddy/Caddyfile
systemctl daemon-reload
systemctl enable krubook krubook-backup.timer >/dev/null
systemctl start krubook-backup.timer
systemctl reload caddy || systemctl restart caddy
echo "Provisioned. Setup code: $(grep KRUBOOK_SETUP_TOKEN /etc/krubook/env | cut -d= -f2)"
