# Backups and recovery

| Copy | Where | When | Kept |
|---|---|---|---|
| Local | `/var/backups/krubook/krubook-*.sqlite.gz` on the droplet | 02:30 UTC (`krubook-backup.timer`) | 14 days |
| Off-site | your bucket, encrypted (`krubook-*.sqlite.gz.enc`) | 03:00 UTC (`krubook-offsite.timer`) | 30 days (`OFFSITE_KEEP_DAYS`) |

Each run writes `status-local.json` / `status-offsite.json` next to the local backups; **Settings → Backup**
shows both. A failed off-site run exits non-zero (the systemd unit shows *failed*), records the error,
and sends a Telegram message when `NOTIFY_TELEGRAM_*` is set.

## What the off-site job does

1. Takes a consistent SQLite snapshot (`VACUUM INTO`) and runs `integrity_check` and `foreign_key_check`.
2. Compresses and encrypts it with AES-256 (`openssl enc -aes-256-cbc -pbkdf2 -iter 200000`). The
   passphrase never leaves the server; storage only ever holds ciphertext.
3. Uploads it over HTTPS with `rclone`, with a `.sha256` file.
4. Downloads it again, compares the checksum, decrypts it, and checks integrity and row counts against
   the snapshot. Only then is the run marked OK.
5. Deletes remote copies older than the retention period.

The database contains everything (courses, classes, students, grades, attendance, schedules, pay,
holidays, audit log). There are no uploaded files to back up. Server secrets in `/etc/krubook` are
not included.

## One-time setup (DigitalOcean Spaces)

Needs your DigitalOcean account; nothing here is done without it.

1. In DigitalOcean: **Spaces Object Storage → Create bucket**, e.g. `krubook-backups` in `sgp1`. Keep
   it private. Optionally enable versioning. Then **API → Spaces Keys → Generate** a key limited to
   that bucket.
2. On the server, as root:

   ```bash
   apt-get install -y rclone
   head -c 48 /dev/urandom | base64 > /etc/krubook/backup.key
   chown root:krubook /etc/krubook/backup.key && chmod 640 /etc/krubook/backup.key
   cat /etc/krubook/backup.key     # store this passphrase in your password manager NOW
   cat > /etc/krubook/offsite.env <<'EOF'
   OFFSITE_TARGET=spaces:krubook-backups/prod
   OFFSITE_PASSPHRASE_FILE=/etc/krubook/backup.key
   OFFSITE_KEEP_DAYS=30
   RCLONE_CONFIG_SPACES_TYPE=s3
   RCLONE_CONFIG_SPACES_PROVIDER=DigitalOcean
   RCLONE_CONFIG_SPACES_ENDPOINT=sgp1.digitaloceanspaces.com
   RCLONE_CONFIG_SPACES_ACCESS_KEY_ID=<key>
   RCLONE_CONFIG_SPACES_SECRET_ACCESS_KEY=<secret>
   # optional failure alerts
   NOTIFY_TELEGRAM_TOKEN=
   NOTIFY_TELEGRAM_CHAT=
   EOF
   chown root:krubook /etc/krubook/offsite.env && chmod 640 /etc/krubook/offsite.env
   install -m 644 /opt/krubook/app/deploy/krubook-offsite.service /opt/krubook/app/deploy/krubook-offsite.timer /etc/systemd/system/
   systemctl daemon-reload && systemctl enable --now krubook-offsite.timer
   systemctl start krubook-offsite.service && journalctl -u krubook-offsite -n 5 --no-pager
   ```

3. Confirm **Settings → Backup** shows the off-site copy as *ok*.

Without the passphrase the off-site copies cannot be decrypted. Keep it outside the droplet.

Any S3-compatible store (Backblaze B2, Cloudflare R2, AWS S3) works by changing the `RCLONE_CONFIG_*`
lines; a mounted disk works with `OFFSITE_TARGET=dir:/mnt/backup`.

## Restore

Check any backup in isolation first. This never touches the live database:

```bash
bash /opt/krubook/app/deploy/restore-check.sh /var/backups/krubook/krubook-2026-10-24-1603.sqlite.gz
rclone copyto spaces:krubook-backups/prod/<file>.enc /tmp/b.enc
bash /opt/krubook/app/deploy/restore-check.sh /tmp/b.enc /etc/krubook/backup.key
```

It prints integrity, broken links, orphaned records, schema version and row counts, and the path of
the restored copy. To make it live:

```bash
systemctl stop krubook
cp /var/lib/krubook/krubook.sqlite /var/lib/krubook/krubook.sqlite.before-restore-$(date +%F-%H%M)
install -m 640 -o krubook -g krubook <restored copy> /var/lib/krubook/krubook.sqlite
rm -f /var/lib/krubook/krubook.sqlite-wal /var/lib/krubook/krubook.sqlite-shm
systemctl start krubook
```

On first start the app upgrades an older backup to the current schema. Sign in and check a class
gradebook, attendance and **Pay**.

## Verified

25 Oct 2026, on a copy on a separate machine (never the live database):

- Production backup `krubook-2026-10-24-1603.sqlite.gz`: integrity ok, 0 broken links, 0 orphans,
  321 students, 321 enrollments, 320 sessions, 59 teaching records, 230 scores, 1 rate, schema 2.
  After upgrading to schema 3: still ok, 21 holidays verified, the app answered every endpoint.
- Off-site job against a directory target: upload, read-back, decrypt and integrity all passed. A wrong
  passphrase, a tampered file, a missing database and a missing passphrase file each failed and wrote
  a failure status.
- **Not yet verified against real off-site storage**: no Spaces/S3 credentials are configured.
