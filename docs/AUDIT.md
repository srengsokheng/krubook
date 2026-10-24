# KruBook audit — 25 Oct 2026

Scope: the live system at https://setecattendance.online (commit `7d13fc1`), its repository and server.
Findings marked **risk** are ordered by impact on real data.

## Highest risks

1. **risk — backups live on the same droplet as the database.** Losing the droplet loses both.
2. **risk — 21 past sessions have no teaching record** (SW33 ×3, SW34 ×5, SW43 ×2, SY14 ×3, SY33 ×4,
   SBQ3 ×4, 7–24 Oct). They count as neither taught nor paid; progress shows these classes behind.
   The workbook marked those weeks "Upcoming", so the real history is unknown and needs the teacher.
3. **risk — all 321 student IDs are placeholders** (`ASL3-07`). There is no safe way to bring in
   official IDs; editing one student at a time is error-prone.
4. **risk — attendance + activity scores are imported fixed values** that silently override the
   attendance calculation; there is no previewed, reversible way to switch to calculated scores.
5. Seven holidays are flagged "estimate" although the dates match Sub-Decree No. 167 (18 Sep 2025).
6. No health endpoint for uptime monitoring; no staging environment; no Content-Security-Policy.
7. No browser-level automated tests: UI regressions are only caught by hand.

## Checklist

### Pages (16 routes + tabs)
| Route | Purpose | Status before |
|---|---|---|
| `/` | dashboard | ok |
| `/timetable` | week grid | ok; long legend fixed earlier |
| `/classes`, `/classes/:id` (+ plan, attendance, grades, roster, setup) | class work | ok |
| `/courses`, `/courses/:id` | curriculum | ok; delete added 24 Oct |
| `/terms`, `/terms/:id` | terms, term holidays, clone | ok |
| `/students`, `/students/:id` | people | paged; ID reconciliation missing |
| `/pay` (+ sessions, rates, adjustments) | pay | ok |
| `/settings` (+ holidays, reminders, backup, activity) | admin | backup status not shown |
| `/print/{gradebook,plan,attendance,roster}/:id` | PDF | ok |
| login, 404 | | ok |
| — | reconcile unrecorded sessions | **missing** |

### API: 87 endpoints (see `server/routes.ts`)
All return 401 without a session (verified live), except `/auth/me`, `/auth/login`, `/auth/logout`
and `/auth/setup` (403 in production). Missing: `/health`, session reconciliation, student-ID
matching, attendance-score migration.

### CRUD
| Entity | C | R | U | D / deactivate |
|---|---|---|---|---|
| Course, lesson, part, material | ✓ | ✓ | ✓ | ✓ (blocked when taught/used) |
| Term, term holiday | ✓ | ✓ | ✓ | ✓ when empty / archive |
| Class, meetings | ✓ | ✓ | ✓ | archive |
| Session | make-up ✓ | ✓ | ✓ cancel/move/restore | make-up only |
| Teaching record | ✓ | ✓ | ✓ | reopen (blocked once paid) |
| Student, enrollment | ✓ | ✓ | ✓ | without history / drop, withdraw, transfer |
| Grade config, scores | ✓ | ✓ | ✓ | clear cell |
| Attendance | ✓ | ✓ | ✓ | clear |
| Holiday | ✓ | ✓ | ✓ | ✓ |
| Rate | ✓ | ✓ | ✓ | deactivate / delete |
| Adjustment | ✓ | ✓ | ✓ | ✓ until approved |
| Pay statement | approve | ✓ | mark paid | undo until paid |
| Settings | — | ✓ | ✓ | — |
| Users | CLI | CLI | CLI password | — |

### Business rules with tests
Scheduling, holidays, Lecture/Practice, re-planning, progress, gradebook maximums, missing vs zero,
attendance scoring, pay (rates, snapshots, duplicates), CRUD/permissions: 85 tests. Not covered:
reconciliation, ID matching, attendance migration, browser flows.

### Operations
TLS 1.2/1.3 only, AEAD ciphers, HSTS, redirects ✓. SSH keys only, fail2ban ✓. Backups nightly on the
droplet only (**risk**). No uptime monitoring, no staging.
