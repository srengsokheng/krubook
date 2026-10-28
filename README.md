# KruBook · សៀវភៅគ្រូ

A teaching management system that replaces the Excel workbook: courses and curriculum, terms and
classes, an automatic term-plan generator, a weekly timetable, teaching progress, rosters,
attendance, a spreadsheet-style gradebook, teaching hours and pay, exports and backups.
Everything that Excel used to calculate by hand (dates, Lecture/Practice, progress, totals,
pass/fail, attendance scores, pay) is calculated from recorded data.

## Run it

Requires Node.js 22.13 or newer (it uses the built-in `node:sqlite`, so there are no native modules).

```bash
npm install
npm run seed      # optional: demo data in data/demo.sqlite
npm run build
npm run demo      # serves the demo database on http://localhost:4310
```

Demo sign-in: `teacher@krubook.test` / `krubook-demo` (demo data only).

For your own data, `npm run build && npm start` uses `data/krubook.sqlite`. In production there is
no sign-up page: create accounts with `npx tsx server/user-cli.ts add <email> <name>` (on the
server, `sudo krubook-user add …`). Outside production the first visit offers a first-run form.

Development with hot reload: `npm run dev` (API on :4310, Vite on :5173), or `npm run dev:demo`.

| Command | What it does |
|---|---|
| `npm test` | 53 tests: scheduling, gradebook rules, attendance, API workflows, exports, backup/restore, offline queue |
| `npm run typecheck` | TypeScript check of server, shared logic and web app |
| `npm run seed` | Writes demo data to `data/demo.sqlite` (refuses a database that already has users) |

Environment: `KRUBOOK_DB` (database file), `PORT` (default 4310), `KRUBOOK_TODAY` (pins “today”, for tests and demos).

## Architecture

```
shared/     Pure domain logic used by both server and browser (no duplicated rules)
  dates.ts      ISO dates via day numbers: no host time-zone or DST drift; Asia/Phnom_Penh "today"
  schedule.ts   term-plan generator, Lecture/Practice rule, re-plan proposals, double-booking
  grades.ts     configuration checks, score parsing (incl. Khmer digits), totals, pass/fail, at-risk
  progress.ts   ahead / on schedule / behind, with the reason
  pay.ts        rate resolution and monthly pay
  holidays.ts   starting Cambodian holiday calendar
server/     Express 5 + SQLite (node:sqlite)
  schema.ts     migrations, constraints and integrity triggers
  services/     plan, records (gradebook, attendance, sync), roster/import, reports, exports, backup
  routes.ts     JSON API under /api, every query scoped to the signed-in teacher
web/        React 19 + Vite PWA
  src/offline.ts  IndexedDB queue for attendance and grade edits, with conflict handling
  public/sw.js    service worker: offline app shell, last-known API data
tests/      Vitest
```

### Data model

Users → courses → lessons → lesson parts → materials; courses also have a week-by-week template.
Terms hold dates, exam windows and term-only holidays. Classes belong to a term and course, with
their own start date, meeting times and optional Lecture/Practice rule. Sessions are real dated
rows generated from those (`gen_key` makes generation repeatable without duplicates). Teaching
records (one per session, with the parts covered fully or partially) are the source of “actual”
progress. Students have enrollments, so a transfer ends one enrollment and starts another; grades
(`scores`) and `attendance` belong to the enrollment, never to the student directly. Grade configs
and components per class; rates, adjustments and payments for pay; `audit_log` for history.

Rules enforced in the database itself (triggers and constraints), not only the API:

- a score can never exceed its component maximum, or belong to another class’s component;
- a grading setup cannot be activated or finalized unless its maximums equal the target total (e.g. midterm 25 → 105 is refused);
- a finalized gradebook cannot be changed; lowering a maximum below existing scores is refused;
- attendance must reference a session of the same class that was not cancelled, moved or skipped;
- completed sessions, and sessions with attendance, cannot be deleted; one active enrollment per student per class.

### Scheduling

- Week 1 starts on the Monday of the class’s first day; each class has its own calendar.
- The rule labels the 1st, 2nd… *eligible* meeting of each week (default Lecture then Practice), or uses a weekday map. Holidays are not eligible, so after a Monday holiday the Wednesday becomes the Lecture. Manual overrides win and are kept.
- Lesson weeks take the next curriculum part; Practice practises the preceding Lecture’s part. Exam windows on the term become exam sessions; LAB checkpoints sit on the week’s practice.
- Cancelling, moving, adding a make-up, recording an early finish or a partial lesson, adding a holiday or changing the rule never rewrites the plan directly. It produces a **proposal** that lists every affected session, which lessons change date (old → new) and any overflow. Nothing changes until the teacher applies it, and completed or confirmed sessions are never touched. A proposal goes stale if the schedule changed after it was made.
- The original plan (`original_date`, `original_part_id`), the current approved plan, and what was actually taught (teaching records) are kept apart.

### Offline

The service worker caches the app and the last response for every page the teacher opened.
Attendance and grade edits go into an IndexedDB queue keyed by cell, carrying the version the
teacher last saw. On reconnect they are sent to `/api/sync`; if someone changed the same cell in the
meantime, the edit is shown as a conflict with “Keep saved” / “Use mine”. Rejected edits are
listed, never dropped. Verified by stopping the server, taking attendance, restarting it and
resolving the resulting conflict in the browser, plus `tests/offline.test.ts`.

## Exports and printing

Excel exports (gradebook, term plan, attendance, student list, payment report) keep real types:
dates are Excel dates, scores are numbers, and student IDs are text so leading zeros survive. Each
has class/term/export-date metadata, a frozen header and repeating print titles.

PDF: every class has print views (`/print/gradebook/:id`, `plan`, `attendance`, `roster`) laid
out for A4 landscape with repeating table headers. Use **Print or save as PDF**. The browser shapes
Khmer text with the bundled Kantumruy Pro font. A server-side PDF library was avoided on purpose:
none of the common ones shape Khmer script correctly.

## Backup and restore

**Settings → Backup** (administrator only):

- `.json`: the full backup. `{ format: "krubook-backup", schemaVersion, exportedAt, counts, checksum, tables }`. `checksum` is the SHA-256 of `JSON.stringify(tables)`. It contains every table except login sessions, including password hashes, so keep it private.
- `.xlsx`: a readable copy, one sheet per table. It cannot be restored from.

Restore procedure:

1. Settings → Backup → choose the `.json` file.
2. KruBook validates it without touching your data. It checks the format, schema version and checksum, then loads every row into a separate in-memory database with all constraints and triggers on. It also checks each table’s row count and runs `foreign_key_check` and `integrity_check`. Any failure is reported and nothing changes.
3. Confirm. The live database file is renamed to `krubook.sqlite.before-restore-<time>` and the validated copy takes its place. Sign in again.

To undo a restore, stop the server and rename the `before-restore` file back.

## Known limits

- Reminders are sent through Telegram (bot token + chat ID). Email is not implemented.
- The Khmer interface covers navigation, headings, statuses and common actions; longer help text is English.
- Lunar holidays for 2026 are estimates marked “check”; confirm them against the official royal decree in Settings → Holidays. Fixed-date holidays are seeded for 2026 and 2027.
- One school per installation. Role-based scoping (admin / teacher) is in place for adding teachers, but there is no user-management screen yet; extra users can only be created with `createUser` in `server/auth.ts`.
- Offline editing covers attendance and grades only, and only for pages opened on that device while online.
- Not built (future): student portal, QR check-in, lab submissions, announcements, multi-school.

## Production and CI/CD

Live at **https://setecattendance.online** (DigitalOcean droplet `159.89.199.180`, Ubuntu 24.04).
nginx serves HTTPS with Let's Encrypt certificates from certbot; `www.`, plain HTTP, the bare IP and
the old `https://159-89-199-180.sslip.io` address all redirect to the domain.

DNS at Namecheap (Advanced DNS): `A @ 159.89.199.180` and `CNAME www setecattendance.online.`.
Provisioning takes both names: `KRUBOOK_DOMAIN=setecattendance.online KRUBOOK_HOST=159-89-199-180.sslip.io`.

| Piece | Where |
|---|---|
| App | `/opt/krubook/app`, systemd unit `krubook` (user `krubook`, port 4310, 350 MB memory cap) |
| HTTPS | nginx (`/etc/nginx/sites-available/krubook`, generated) + certbot. `krubook-certs.timer` runs `deploy/krubook-certs.sh` every 15 min: it requests a certificate for any name in `/etc/krubook/domains` that points at the server and rewrites the nginx site. `certbot.timer` renews; a deploy hook reloads nginx |
| Database | `/var/lib/krubook/krubook.sqlite` |
| Settings and secrets | `/etc/krubook/env` |
| Accounts | No public sign-up. On the server: `sudo krubook-user add <email> <name>`, `sudo krubook-user passwd <email>`, `sudo krubook-user list` (passwords are typed at a hidden prompt) |
| Backups | daily at 02:30, `/var/backups/krubook/*.sqlite.gz`, kept 14 days (`krubook-backup.timer`) |
| Firewall | ufw: 22, 80, 443 only |
| SSH | keys only; root by key only; no X11; 3 tries per connection; fail2ban bans IPs after 5 failures in 10 min (1 h, growing). With many keys in an SSH agent, connect with `-o IdentitiesOnly=yes -i <key>` |

`deploy/provision.sh` builds the server from scratch and is safe to re-run.

**Pipeline** (`.github/workflows/ci.yml`): every push and pull request to `main` or `development`
runs the typecheck, the tests and the build. Pushes to `main` then deploy. The workflow rsyncs the
release to the droplet as the `krubook` user, runs `deploy/deploy.sh` (`npm ci --omit=dev`, restart,
health check) and fails if the app does not come back. Repository secrets: `DEPLOY_SSH_KEY` (a key
used only for deploys; the `krubook` user can only restart its own service), `DEPLOY_HOST` and
`DEPLOY_KNOWN_HOSTS`.

Useful commands on the server: `journalctl -u krubook -f`, `systemctl restart krubook`,
`systemctl start krubook-backup`. To restore a nightly backup: `systemctl stop krubook`, then
`gunzip` the file over `/var/lib/krubook/krubook.sqlite` (owned by `krubook`), then `systemctl start krubook`.

## Importing the old workbook

`server/import-workbook.ts` reads `Teaching_Schedule_and_Progress.xlsx` into a new database file:

```bash
npx tsx server/import-workbook.ts "D:/Work/Teaching/Teaching_Schedule_and_Progress.xlsx" --db data/krubook-import.sqlite --materials "D:/Work/Teaching"
```

It creates one term per intake (each with its own exam windows), the C++ and WBD I curricula and
19-week templates taken from the term-plan sheets, meeting times from the Weekly Schedule, every
roster and score, and a teaching record for each week marked Completed. The Attendance + Class
Activity points are imported as manual values, because the workbook has no roll calls. It also
lists the lesson files in `cpp/lessonNN` and `nodejs/lessonNN` as ready materials. The workbook has no student IDs,
so students get placeholder IDs such as `ASL3-07`. Edit them on each student's page. The data
belongs to an unclaimed account; the first account created with `krubook-user add` claims it.

### Updating from a newer copy of the workbook

**Update from Excel** in the app takes the workbook as an upload (drag and drop). The server reads it
into a scratch in-memory database, compares it with the signed-in teacher's classes and shows the
changes; nothing is saved until **Apply**, which re-reads the same file and refuses if the result no
longer matches the preview. It adds scores the app does not have, updates scores that changed in the
workbook if nobody edited them in the app, and records sessions the workbook marks Completed that are
still planned and not in the future. Everything else (scores edited in the app, students in only one
place, attendance points the app now calculates from roll calls, other session differences) is listed
and left alone. Rules: `server/services/merge.ts`. The same merge runs from the command line with
`scripts/merge-scores.ts` (see `docs/OPERATIONS.md`). The workbook omits years, so its dates are read as
Aug–Dec 2026 and Jan–Jul 2027; that mapping in `server/services/workbook.ts` needs updating for the next
school year.

## Teaching pay

Pay counts only sessions recorded as taught (a teaching record) in the teacher's own classes.
Cancelled sessions and past sessions without a record earn nothing; make-up sessions are paid like
any other. Each session is priced with the most specific active rate in force on its date (class,
then course, then all classes), hourly or per session, rounded to the cent per session.

A month moves through three states:

| State | Meaning | Changes allowed |
|---|---|---|
| Estimated | taught sessions not on a statement, priced with current rates | rates and adjustments may change it |
| Approved | **Approve** freezes the month's sessions, minutes, rates, amounts and adjustments into a statement | **Undo approval** returns it to estimated |
| Paid | **Mark as paid** records the date and amount received | none (enforced by database triggers) |

A session can appear on only one statement (unique index), so it can never be paid twice. Sessions
recorded after a month was approved show as "not approved" and can be approved separately. The old
`payments` table is kept for old backups but is no longer used.

### Check-in, expected and actual pay

The teacher taps **Check in** on the dashboard when they arrive (or types the arrival time in a
session's dialog afterwards). A session counts as worked, and is paid, once it is checked in to or
recorded as taught. Minutes after the scheduled start are late, and the late rule on **Pay › Rates**
cuts that session's pay in steps. The default: up to 10 minutes late, no cut; more than 10, half;
more than 30, the whole session. The highest step reached applies.

Each pay month shows two figures. **Expected** is every session scheduled in the period that is not
cancelled (holidays cancel sessions), at full rate and scheduled length, plus adjustments. **Actual**
is what was worked, after late cuts, plus adjustments. An approved statement stores each session's
late minutes and cut, so later rule changes only affect months not yet approved, and a check-in on an
approved statement cannot be changed. A session with a check-in cannot be cancelled or moved until the
check-in is removed.

## Attendance

A roll call is one tick per student: ticked came, unticked did not. Once any student in a session is
marked, everyone left unticked is saved as absent, so the record matches the screen; **Clear** removes
the whole roll call. Sessions with no roll call are not counted. Late and excused marks from older
records are still shown and scored by the class's attendance rule.

## Paging

Large lists are paged on the server with `?page=1&pageSize=25` (10, 25, 50 or 100) and return
`{ items, total, page, pageSize, pages }`; invalid values return 400. Paged: students (`q`, `sort`
= code/km/latin, `dir`), class attendance summary (`q`), pay sessions (`year`/`month`) and the
activity log (`entity`). Class gradebooks (about 50 students) and term plans (about 40 sessions)
are not paged, so spreadsheet keyboard entry and paste keep working across the whole class.

## Performance check

`npx tsx scripts/scale-db.ts data/import-test.sqlite data/scale-test.sqlite` builds a 10x copy of
the real data (3,201 students, 21,240 attendance marks, 20,313 audit rows); `npx tsx scripts/bench.ts
<db>` reports the median time and size of the main endpoints.

## TLS

`deploy/krubook-certs.sh` generates the nginx site: TLS 1.2 and 1.3 only, TLS 1.2 limited to
forward-secret AEAD ciphers (Mozilla intermediate), session tickets off, HSTS for one year on the
domain and `www` only (no `includeSubDomains`), `X-Frame-Options DENY`. Provisioning also sets the
global `nginx.conf` default to TLS 1.2/1.3 and turns off `server_tokens`. Check a host with
`bash deploy/tlscheck.sh setecattendance.online` (protocols, weak ciphers, certificate, chain).
