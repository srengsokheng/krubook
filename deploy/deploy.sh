#!/usr/bin/env bash
# Runs on the server as the krubook user after CI has copied the built app to /opt/krubook/app.
set -euo pipefail
cd /opt/krubook/app
npm ci --omit=dev --no-audit --no-fund --loglevel=error
sudo /usr/bin/systemctl restart krubook
for i in $(seq 1 30); do
  if curl -fs http://127.0.0.1:4310/api/auth/me >/dev/null; then echo "KruBook is up ($(cat REVISION 2>/dev/null))"; exit 0; fi
  sleep 1
done
echo "KruBook did not start; recent log:" >&2
journalctl -u krubook -n 40 --no-pager >&2 || true
exit 1
