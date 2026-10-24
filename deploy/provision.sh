#!/usr/bin/env bash
# One-time server setup for KruBook on Ubuntu 24.04. Run as root. Safe to re-run.
set -euo pipefail
HOST="${KRUBOOK_HOST:?set KRUBOOK_HOST, e.g. 159-89-199-180.sslip.io}"
DOMAIN="${KRUBOOK_DOMAIN:?set KRUBOOK_DOMAIN, e.g. setecattendance.online}"
CI_PUBKEY="${CI_PUBKEY:?set CI_PUBKEY to the public deploy key}"

# 1 GB swap: the droplet has 512 MB of RAM, which npm alone can exhaust.
if ! swapon --show | grep -q /swapfile; then
  fallocate -l 1G /swapfile && chmod 600 /swapfile && mkswap /swapfile && swapon /swapfile
  grep -q /swapfile /etc/fstab || echo '/swapfile none swap sw 0 0' >> /etc/fstab
fi

# HTTPS: nginx in front of the app, certificates from Let's Encrypt via certbot. Older installs
# used Caddy, which must release ports 80/443 before nginx is installed.
if systemctl is-enabled caddy >/dev/null 2>&1; then systemctl disable --now caddy; fi

export DEBIAN_FRONTEND=noninteractive
apt-get update -q
apt-get install -yq ca-certificates curl gnupg rsync ufw dnsutils nginx certbot fail2ban

# Node.js 22 (NodeSource)
if ! node -v 2>/dev/null | grep -q '^v22'; then
  curl -fsSL https://deb.nodesource.com/setup_22.x | bash -
  apt-get install -yq nodejs
fi


# SSH: keys only, root by key only, no X11, few tries per connection.
cat > /etc/ssh/sshd_config.d/10-krubook-hardening.conf <<SSHD
PermitRootLogin prohibit-password
PasswordAuthentication no
KbdInteractiveAuthentication no
X11Forwarding no
MaxAuthTries 3
SSHD
sshd -t && systemctl reload ssh

# fail2ban: ban IPs that keep failing SSH (Ubuntu 24.04 logs sshd under ssh.service).
cat > /etc/fail2ban/jail.local <<F2B
[DEFAULT]
backend = systemd
bantime = 1h
findtime = 10m
maxretry = 5
bantime.increment = true

[sshd]
enabled = true
journalmatch = _SYSTEMD_UNIT=ssh.service
F2B
systemctl enable fail2ban >/dev/null 2>&1 && systemctl restart fail2ban

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
ENV
  chmod 640 /etc/krubook/env && chown root:krubook /etc/krubook/env
fi

# The deploy user may restart only this service.
echo 'krubook ALL=(root) NOPASSWD: /usr/bin/systemctl restart krubook, /usr/bin/systemctl is-active krubook' > /etc/sudoers.d/krubook
chmod 440 /etc/sudoers.d/krubook

install -m 644 /tmp/krubook-deploy/krubook.service /etc/systemd/system/krubook.service
install -m 644 /tmp/krubook-deploy/krubook-backup.service /etc/systemd/system/krubook-backup.service
install -m 644 /tmp/krubook-deploy/krubook-backup.timer /etc/systemd/system/krubook-backup.timer
install -m 644 /tmp/krubook-deploy/krubook-certs.service /etc/systemd/system/krubook-certs.service
install -m 644 /tmp/krubook-deploy/krubook-certs.timer /etc/systemd/system/krubook-certs.timer
printf 'DOMAIN=%s
HOST=%s
' "$DOMAIN" "$HOST" > /etc/krubook/domains
install -d /etc/letsencrypt/renewal-hooks/deploy
printf '#!/bin/sh
systemctl reload nginx
' > /etc/letsencrypt/renewal-hooks/deploy/reload-nginx.sh
chmod 755 /etc/letsencrypt/renewal-hooks/deploy/reload-nginx.sh
# Global nginx defaults: no TLS 1.0/1.1 anywhere, and no version number in responses.
sed -i -E 's/^\s*ssl_protocols .*/	ssl_protocols TLSv1.2 TLSv1.3;/; s/^\s*ssl_prefer_server_ciphers on;/	ssl_prefer_server_ciphers off;/; s/^\s*# server_tokens off;/	server_tokens off;/' /etc/nginx/nginx.conf
systemctl daemon-reload
systemctl enable --now nginx krubook-backup.timer krubook-certs.timer certbot.timer >/dev/null
systemctl enable krubook >/dev/null
bash /tmp/krubook-deploy/krubook-certs.sh
sed -i '/^KRUBOOK_SETUP_TOKEN=/d' /etc/krubook/env   # sign-up codes are no longer used
install -m 755 /tmp/krubook-deploy/krubook-user /usr/local/bin/krubook-user
echo "Provisioned. Create an account with: sudo krubook-user add <email> <name>"
