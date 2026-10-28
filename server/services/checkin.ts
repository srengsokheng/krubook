import { AppError, type DB, type Row } from '../db.ts';
import type { User } from '../auth.ts';
import { getSetting, ownSession, today } from './access.ts';
import { DEFAULT_TZ, isTime, nowTimeIn } from '../../shared/dates.ts';
import { lateCutPercent, lateMinutes } from '../../shared/pay.ts';
import { loadLateRule } from './pay.ts';

// The teacher's own arrival for a session. "Check in" on the day records the current local time;
// a time typed in afterwards is kept as a manual entry. A check-in makes the session count as worked
// for pay, and lateness cuts its pay by the late rule (see pay.ts).

const NOT_HELD = ['cancelled', 'moved', 'skipped'];

function out(db: DB, u: User, s: Row, k: Row | undefined) {
  const rule = loadLateRule(db, u.id);
  const late = lateMinutes(s.start_time, k?.time);
  const locked = !!db.get('SELECT 1 FROM pay_statement_lines WHERE session_id = ?', s.id);
  return {
    sessionId: s.id,
    start: s.start_time,
    time: k?.time ?? null,
    source: k?.source ?? null,
    note: k?.note ?? null,
    late,
    cutPercent: lateCutPercent(late, rule),
    locked,
    canTap: !k && s.date === today(db, u) && !NOT_HELD.includes(s.status),
    editable: !locked && !NOT_HELD.includes(s.status) && s.date <= today(db, u),
  };
}

export function getCheckIn(db: DB, u: User, sessionId: number) {
  const s = ownSession(db, u, sessionId);
  return out(db, u, s, db.get('SELECT * FROM checkins WHERE session_id = ?', s.id));
}

/** Checks in now (no time given, on the session's day) or records the time typed in. */
export function checkIn(db: DB, u: User, sessionId: number, body: { time?: unknown; note?: unknown }) {
  const s = ownSession(db, u, sessionId);
  if (NOT_HELD.includes(s.status)) throw new AppError(422, `This session is ${s.status}, so there is nothing to check in to.`);
  const now = today(db, u);
  if (s.date > now) throw new AppError(422, 'You can check in on the day of the session.');
  const typed = body.time !== undefined && body.time !== null && body.time !== '';
  if (typed && !isTime(body.time)) throw new AppError(422, 'Enter the arrival time as HH:MM.');
  if (!typed && s.date !== now) throw new AppError(422, 'This session was on another day. Enter the time you arrived.');
  const time = typed ? (body.time as string) : process.env.KRUBOOK_NOW_TIME ?? nowTimeIn(getSetting(db, u.id, 'timezone', DEFAULT_TZ));
  const note = typeof body.note === 'string' && body.note.trim() ? body.note.trim().slice(0, 500) : null;
  const source = typed ? 'manual' : 'tap';
  const old = db.get('SELECT * FROM checkins WHERE session_id = ?', s.id);
  db.tx(() => {
    if (old) db.run("UPDATE checkins SET time = ?, source = ?, note = ?, updated_at = datetime('now') WHERE id = ?", time, source, note, old.id);
    else db.run('INSERT INTO checkins (session_id, time, source, note, created_by) VALUES (?,?,?,?,?)', s.id, time, source, note, u.id);
    db.audit(u.id, 'checkin', s.id, old ? 'update' : 'create', old ? { time: old.time, source: old.source } : undefined, { time, source });
  });
  return getCheckIn(db, u, s.id);
}

export function clearCheckIn(db: DB, u: User, sessionId: number) {
  const s = ownSession(db, u, sessionId);
  const old = db.get('SELECT * FROM checkins WHERE session_id = ?', s.id);
  if (!old) return getCheckIn(db, u, s.id);
  db.tx(() => {
    db.run('DELETE FROM checkins WHERE id = ?', old.id);
    db.audit(u.id, 'checkin', s.id, 'delete', { time: old.time, source: old.source });
  });
  return getCheckIn(db, u, s.id);
}
