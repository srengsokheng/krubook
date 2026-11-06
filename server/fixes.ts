// One-time data fixes asked for by the owner, run in order when the server starts. Each runs once
// (recorded in data_fixes with what it did) and only through the app's normal save paths. A fix
// that cannot tell exactly whose data it is for changes nothing and records why.
import type { DB, Row } from './db.ts';
import { seedAccount, type User } from './auth.ts';
import { completeSession, restoreStaleHolidayCancellations } from './services/plan.ts';
import { loadHolidays, unpaidHoliday } from './services/pay.ts';
import { getSetting, today } from './services/access.ts';
import { DEFAULT_TZ, durationMinutes, nowTimeIn } from '../shared/dates.ts';

interface Fix { name: string; run: (db: DB) => Record<string, unknown> }

/** The single active administrator who teaches classes, or null if there is not exactly one. */
function owner(db: DB): User | null {
  const rows = db.all<User>(`SELECT u.id, u.email, u.name, u.role FROM users u WHERE u.role = 'admin' AND u.status = 'active' AND u.password_hash <> '!'
    AND EXISTS (SELECT 1 FROM classes c WHERE c.teacher_id = u.id)`);
  return rows.length === 1 ? rows[0] : null;
}

/**
 * Records each past session as taught (planned lesson part, full length) and checked in on time,
 * except Sat 24 Oct 13:00, checked in at 13:35 (35 min late). Classes on a holiday and classes on
 * an approved statement are left alone; a session already checked in keeps its check-in.
 */
function recordAttended(db: DB, u: User, sessions: Row[], note: string) {
  const out = { recorded: 0, checkedIn: 0, late: 0, alreadyCheckedIn: 0, locked: 0, holiday: 0, failed: [] as string[] };
  const hs = loadHolidays(db, u.id);
  for (const s of sessions) {
    // A class on a holiday was not taught (the school was closed): leave it alone.
    if (unpaidHoliday(hs, { ...s, checkin: db.get('SELECT time FROM checkins WHERE session_id = ?', s.id)?.time })) { out.holiday++; continue; }
    if (db.get('SELECT 1 FROM pay_statement_lines WHERE session_id = ?', s.id)) { out.locked++; continue; }
    try {
      if (s.status === 'planned') {
        completeSession(db, u, s.id, {
          parts: s.part_id && s.activity === 'lesson' ? [{ partId: s.part_id, coverage: 'full' }] : [],
          minutes: durationMinutes(s.start_time, s.end_time),
          notes: note,
        });
        out.recorded++;
      }
      if (db.get('SELECT 1 FROM checkins WHERE session_id = ?', s.id)) { out.alreadyCheckedIn++; continue; }
      const late = s.date === '2026-10-24' && s.start_time === '13:00';
      const at = late ? '13:35' : s.start_time;
      db.run("INSERT INTO checkins (session_id, time, source, note, created_by) VALUES (?, ?, 'manual', ?, ?)", s.id, at, late ? 'Added on request: arrived 35 minutes late' : 'Added on request: on time', u.id);
      db.audit(u.id, 'checkin', s.id, 'create', undefined, { time: at, source: 'manual', fix: 'owner request' });
      out.checkedIn++;
      if (late) out.late++;
    } catch (e) {
      out.failed.push(`${s.date} ${s.start_time}: ${(e as Error).message}`);
    }
  }
  return out;
}

const FIXES: Fix[] = [
  {
    // 4 Nov 2026: "from 16 Oct till today all classes are attended and I was never late, except
    // one 35-minute late arrival on Sat 24 Oct 13:00–14:30".
    name: '2026-11-04-attended-since-16-oct',
    run(db) {
      const u = owner(db);
      if (!u) return { skipped: 'no single administrator with classes' };
      const now = today(db, u);
      const time = process.env.KRUBOOK_NOW_TIME ?? nowTimeIn(getSetting(db, u.id, 'timezone', DEFAULT_TZ));
      const sessions = db.all(
        `SELECT s.*, c.term_id FROM sessions s JOIN classes c ON c.id = s.class_id
          WHERE c.teacher_id = ? AND s.status IN ('planned','completed') AND s.date BETWEEN '2026-10-16' AND ?
            AND (s.date < ? OR s.end_time <= ?)
          ORDER BY s.date, s.start_time`,
        u.id, now, now, time,
      );
      return recordAttended(db, u, sessions as Row[], 'Recorded on request: attended (16 Oct – 4 Nov).');
    },
  },
  {
    // 5 Nov 2026: classes cancelled for an earlier, longer version of the Pchum Ben range (e.g. Thu
    // 22 Oct SW34) stayed cancelled after the range was corrected to 9–15 Oct. Restore every class
    // whose holiday no longer covers it; those from 16 Oct to 4 Nov were taught, on time.
    name: '2026-11-05-restore-classes-after-holiday-change',
    run(db) {
      const u = owner(db);
      if (!u) return { skipped: 'no single administrator with classes' };
      const restored = restoreStaleHolidayCancellations(db, u);
      const ids = restored.filter((r) => r.date >= '2026-10-16' && r.date <= '2026-11-04').map((r) => r.sessionId);
      const sessions = ids.length ? db.all(`SELECT s.*, c.term_id FROM sessions s JOIN classes c ON c.id = s.class_id WHERE s.id IN (${ids.join(',')}) ORDER BY s.date, s.start_time`) : [];
      return { restored: restored.map((r) => `${r.date} (${r.was})`), ...recordAttended(db, u, sessions, 'Recorded on request: restored after the holiday was corrected; attended.') };
    },
  },  {
    // 6 Nov 2026: the owner was locked out and was the only administrator, so nobody could reset
    // their password in the app. Add a backup administrator with a one-time password (only its
    // scrypt hash is here) that must be changed at the first sign-in; from it, Accounts › Reset
    // password works for the owner's account. Skipped if the email is already taken.
    name: '2026-11-06-backup-admin',
    run(db) {
      const email = 'admin@setecattendance.online';
      if (db.get('SELECT 1 FROM users WHERE email = ?', email)) return { skipped: 'account already exists' };
      const id = db.run("INSERT INTO users (email, name, password_hash, role, must_change_password, note) VALUES (?, 'Backup admin', ?, 'admin', 1, 'Backup administrator for password resets')",
        email, 'scrypt$ucyUt/uuZBsGrCIIsOhgsw==$v6n9/Y9Fw0/dyVUirRn3ls8DpY4rpc9mfo+fA2Jv352uCXdR9lQCJY0pDjQfGOgubRyJIq1tXwK8VCgi7sD/8w==').id;
      seedAccount(db, id);
      db.audit(null, 'user', id, 'create', undefined, { email, role: 'admin', fix: '2026-11-06' });
      return { created: email };
    },
  },
];

export function runDataFixes(db: DB) {
  for (const f of FIXES) {
    if (db.get('SELECT 1 FROM data_fixes WHERE name = ?', f.name)) continue;
    const result = db.tx(() => {
      const r = f.run(db);
      db.run('INSERT INTO data_fixes (name, result) VALUES (?, ?)', f.name, JSON.stringify(r));
      return r;
    });
    console.log(`Data fix ${f.name}: ${JSON.stringify(result)}`);
  }
}
