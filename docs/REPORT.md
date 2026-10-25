# Audit, improvement and end-to-end testing: report

26 Oct 2026. Covers commits `07b4955`…`eab09aa` (on `development`; **not yet on `main` / production**).
Full audit checklist: `docs/AUDIT.md`.

## 1. Important bugs found

| Bug | Found by | Status |
|---|---|---|
| New CSP blocked the fonts Vite inlines as `data:` URIs (some Khmer/heading weights would not load) | Playwright console check | Fixed before reaching production |
| Phones: Review decision, Pay **Approve**, holiday status/delete sat off-screen in sideways-scrolling tables | Screenshot review | Fixed |
| Phones: sticky Review *Apply* bar slid under the bottom navigation | Screenshot review | Fixed |
| Printable PDF pages widened the whole page on tablet/phone | Overflow check | Fixed |
| "1 past sessions need…", "session(s)" wording | Screenshot review | Fixed |
| Holiday help text referred to a "check" label that no longer exists | Screenshot review | Fixed |
| 21 past sessions silently uncounted (no way to resolve them) | Audit | Review workflow added; awaiting your decisions |
| Backups only on the same droplet | Audit | Off-site job built and verified locally; awaiting storage credentials |
| No health endpoint, no CSP, no browser tests | Audit | Added |

A test bug was also caught: the first browser run "passed" while every page was the sign-in screen
(the saved session was written too early). Each page test now fails if it lands on sign-in.

## 2. Pages and UI issues fixed

- New **Review** page (past sessions, student IDs), linked from Dashboard and Pay.
- Gradebook: *Use calculated attendance…* dialog with before/after per student.
- Settings: holiday badges *estimate / verified / national / yours*; Backup tab shows local and off-site status.
- Phone layout: tables with actions become labelled cards (`.table.stack`) on Review and Pay, and in Settings → Holidays.
- Print sheets scroll inside their box on small screens; print output unchanged.
- Pages load on demand (code splitting); see §11.

## 3. Backend and database changes

- **Migration 3** (`server/schema.ts`): `holidays.verified_note`; `score_archive` table + index; marks the
  21 national 2026 holidays verified against Sub-Decree No. 167 (18 Sep 2025).
- `server/services/reconcile.ts`: session reconciliation, student-ID matching/applying, attendance migration
  (all preview-first, transactional, audited).
- Routes: `/reconcile/*`, `/backup/status` (admin), public `/health` (`{"status":"ok"}` only).
- Security headers: Content-Security-Policy, Permissions-Policy, Cross-Origin-Opener-Policy.
- Dashboard at-risk results cached with exact invalidation.

## 4. Backup and restore verification

- Restored real production backup `krubook-2026-10-24-1603.sqlite.gz` on a separate machine: integrity ok,
  0 broken links, 0 orphans, 321 students/enrollments, 320 sessions, 59 teaching records, 230 scores.
  Upgraded to schema 3 and served by the app. The copy has since been deleted.
- Off-site job tested against a directory target: success, wrong passphrase, tampered file, missing
  database and missing key all behave correctly and write a status.
- **Off-site backups are not operational yet**: no Spaces/S3 credentials. Setup steps: `docs/BACKUPS.md`.

## 5. Student IDs and past sessions

- **Past sessions**: the data cannot show whether the 21 sessions were taught, so none were changed.
  They wait on the Review page for your decision (taught / not taught / skipped / leave), with a
  before/after preview of progress and pay.
- **Student IDs**: matching and apply workflow is built and tested. **Waiting for the official student
  export**; existing IDs are unchanged.

## 6. Holidays

21 national 2026 dates verified against Sub-Decree No. 167 (cross-checked with a second source; one
disagreeing source judged unreliable). 0 estimates remain for 2026. Takes effect with migration 3.

## 7. Pay calculation tests

Deterministic unit tests (hourly, per-session, cancelled = $0, duplicates, rate changes after approval,
monthly totals = sum of lines, paid records locked) all pass. Browser flow: approve a month, see the
approved amount, undo the approval.

## 8. CRUD tests

`npm test`: **102 passed, 0 failed** (6 files; includes 17 reconciliation tests). Browser flows verify
persistence through reload for attendance and grades, plus holiday create/delete, review apply and pay approve/undo.

## 9. Browser automation

Playwright (`npm run e2e`), fresh demo database, now also in CI before any deploy.
**119 passed, 0 failed**: 7 flows + 28 routes × 4 views (1366 desktop, 768 tablet, Pixel 7 phone,
dark). Every route fails on: console error, CSP violation, failed API call, error page, sign-in redirect,
or sideways page scrolling.

## 10. Visual inspection

Screenshots for all 28 routes in all 4 views were taken (`e2e-results/screens/`, not committed) and the
denser pages inspected by eye (Review, Pay, Gradebook, Attendance, Students, Holidays, Dashboard,
dark Dashboard, tablet Gradebook). Issues found are in §1; all fixed and re-tested. Long Khmer/Latin
names truncate cleanly.

## 11. Performance

| Measurement | Before | After |
|---|---|---|
| Dashboard API, 10× data (~3,200 students), warm | 77–91 ms | 19 ms |
| Dashboard API, real data size | — | ~13.6 ms |
| Gradebook API | 14.5 ms | ~10.9 ms |
| Main JS bundle | 455 KB (129 KB gzip) | 292 KB (93 KB gzip) + per-page chunks |

The first dashboard load after a change still computes in full; repeat loads use the cache.

## 12. TLS and deployment (read-only checks, 26 Oct 2026)

TLS 1.0/1.1 refused; 1.2 and 1.3 with AEAD ciphers; certificate valid to 21 Jan 2027 for both hostnames;
HTTP → HTTPS 301; HSTS on; API returns 401 without sign-in. `/api/health` and the CSP header are **not
live yet** (they ship with the next `main` deploy). Nothing on the server was changed in this phase.

## 13. Files changed and migrations

Migration 3 only. Main files: `server/services/reconcile.ts`, `server/schema.ts`, `server/routes.ts`,
`server/app.ts`, `web/src/pages/Review.tsx`, `web/src/App.tsx`, `deploy/offsite-backup.sh`,
`deploy/restore-check.sh`, `deploy/dbtool.cjs`, `deploy/krubook-offsite.*`, `scripts/sanitize-db.ts`,
`e2e/*`, `playwright.config.ts`, `.github/workflows/ci.yml`, `docs/*`.

## 14. Remaining risks and what needs you

1. **Deploy to production**: merge to `main` runs migration 3 (adds a column and a table, marks 2026
   holidays verified; no data removed). Needs your go-ahead.
2. **Off-site storage**: create a Spaces bucket + key, then follow `docs/BACKUPS.md`. Until then, backups
   remain on the droplet only.
3. **21 past sessions**: decide them on the Review page.
4. **Official student export**: needed to replace placeholder IDs.
5. **Uptime monitor**: needs your UptimeRobot (or similar) account; steps in `docs/OPERATIONS.md`.
6. **Staging**: needs a DNS record and approval; plan in `docs/OPERATIONS.md`.
7. Holiday delete has no confirmation (one click); low impact, easy to re-add.
