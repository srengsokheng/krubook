// One-time data fixes asked for by the owner, run in order when the server starts. Each runs once
// (recorded in data_fixes with what it did) and only through the app's normal save paths. A fix
// that cannot tell exactly whose data it is for changes nothing and records why.
import type { DB, Row } from './db.ts';
import type { User } from './auth.ts';
import { completeSession } from './services/plan.ts';
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
      const out = { recorded: 0, checkedIn: 0, late: 0, alreadyCheckedIn: 0, locked: 0, holiday: 0, failed: [] as string[] };
      const hs = loadHolidays(db, u.id);
      for (const s of sessions as Row[]) {
        // A class on a holiday was not taught (the school was closed): leave it alone.
        if (unpaidHoliday(hs, { ...s, checkin: db.get('SELECT time FROM checkins WHERE session_id = ?', s.id)?.time })) { out.holiday++; continue; }
        const locked = !!db.get('SELECT 1 FROM pay_statement_lines WHERE session_id = ?', s.id);
        if (locked) { out.locked++; continue; }
        try {
          if (s.status === 'planned') {
            completeSession(db, u, s.id, {
              parts: s.part_id && s.activity === 'lesson' ? [{ partId: s.part_id, coverage: 'full' }] : [],
              minutes: durationMinutes(s.start_time, s.end_time),
              notes: 'Recorded on request: attended (16 Oct – 4 Nov).',
            });
            out.recorded++;
          }
          if (db.get('SELECT 1 FROM checkins WHERE session_id = ?', s.id)) { out.alreadyCheckedIn++; continue; }
          const late = s.date === '2026-10-24' && s.start_time === '13:00';
          const at = late ? '13:35' : s.start_time;
          db.run("INSERT INTO checkins (session_id, time, source, note, created_by) VALUES (?, ?, 'manual', ?, ?)", s.id, at, late ? 'Added on request: arrived 35 minutes late' : 'Added on request: on time', u.id);
          db.audit(u.id, 'checkin', s.id, 'create', undefined, { time: at, source: 'manual', fix: '2026-11-04' });
          out.checkedIn++;
          if (late) out.late++;
        } catch (e) {
          out.failed.push(`${s.date} ${s.start_time}: ${(e as Error).message}`);
        }
      }
      return out;
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
