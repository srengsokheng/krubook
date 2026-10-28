# Monitoring and staging

## Uptime monitoring

`GET https://setecattendance.online/api/health` is public and returns only `{"status":"ok"}` (HTTP 200)
when the app and its database answer, or `{"status":"error"}` (HTTP 503) when the database does not.
It reveals no data, versions or counts.

Free setup with UptimeRobot (or Better Stack, Healthchecks.io); needs your own account:

1. Add an **HTTP(s) – Keyword** monitor for `https://setecattendance.online/api/health`, keyword
   `"ok"`, interval 5 minutes. This catches downtime, 5xx errors and database failures.
2. Add an **HTTP(s)** monitor for `https://setecattendance.online/` (nginx, TLS and the app shell).
3. Turn on certificate-expiry alerts (UptimeRobot: SSL monitoring) as a second check on renewal.
4. Alert contacts: your email and/or Telegram. Alert after 2 failed checks to avoid noise.

Backup failures alert separately (see `docs/BACKUPS.md`).

## Staging

There is no staging server yet. Running one on the same droplet is supported and keeps production
apart:

| | Production | Staging |
|---|---|---|
| Address | setecattendance.online | staging.setecattendance.online (DNS A record → 159.89.199.180) |
| Service | `krubook` on 127.0.0.1:4310 | `krubook-staging` on 127.0.0.1:4311 |
| Code | `/opt/krubook/app` (branch `main`) | `/opt/krubook/staging` (branch `development`) |
| Database | `/var/lib/krubook/krubook.sqlite` | `/var/lib/krubook-staging/krubook.sqlite`, **sanitised** |
| Settings | `/etc/krubook/env` | `/etc/krubook/staging.env` |

Staging never reads production paths; its env file sets its own `KRUBOOK_DB`, so migrations there run
only on the staging copy.

Make the staging data from the latest backup with personal details removed:

```bash
gunzip -c /var/backups/krubook/<latest>.sqlite.gz > /tmp/prod-copy.sqlite
npx tsx scripts/sanitize-db.ts /tmp/prod-copy.sqlite /var/lib/krubook-staging/krubook.sqlite && rm /tmp/prod-copy.sqlite
```

`sanitize-db.ts` replaces every student ID, Khmer and Latin name, email and phone, resets account
emails and passwords (`staging-<id>@example.test` / `staging-password`), clears notification
settings and blanks old/new values in the audit log. Schedules, grades, attendance and pay keep their
shape, so migrations and workflows are tested realistically.

Release flow: push to `development` → CI tests → deploy to staging → check the changed pages →
merge to `main` → CI deploys production.

Setting staging up needs a DNS record and a second service and nginx site, so it is left for your
go-ahead. Until then, migrations are tested by restoring a production backup on a separate machine
(see `docs/BACKUPS.md`, *Verified*).

## Updating from the Excel workbook

Normally: open **Update from Excel** in the app, drop the workbook, check the preview and apply. No server
access is needed, and nothing is saved until you apply.

The same merge can run on the server. The workbook import builds a new database, so never run it against
the live one; import into a scratch file and merge from there:

```bash
npx tsx server/import-workbook.ts Teaching_Schedule_and_Progress.xlsx --db /tmp/new.sqlite
npx tsx scripts/merge-scores.ts /tmp/new.sqlite /var/lib/krubook/krubook.sqlite            # preview
systemctl start krubook-backup.service                                                    # backup first
sudo -u krubook npx tsx scripts/merge-scores.ts /tmp/new.sqlite /var/lib/krubook/krubook.sqlite --apply
rm /tmp/new.sqlite
```

Scores edited in the app are never overwritten (differences are listed for you to fix in the gradebook),
and running it twice changes nothing. New scores are added, scores changed only in the workbook are
updated, and weeks marked Completed are recorded as taught; other differences are listed, not applied.
