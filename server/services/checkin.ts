import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import { AppError, type DB, type Row } from '../db.ts';
import type { User } from '../auth.ts';
import { getSetting, ownSession, setSetting, today } from './access.ts';
import { DEFAULT_TZ, durationMinutes, isTime, nowTimeIn } from '../../shared/dates.ts';
import { lateCutPercent, lateMinutes } from '../../shared/pay.ts';
import { loadLateRule } from './pay.ts';
import { completeSession } from './plan.ts';

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

// ---------------------------------------------------------------------------------------------
// Check-in links. The Telegram reminder carries a link that checks in to one session without
// signing in: /api/checkin-link/<session>/<token>, where the token is an HMAC of the session id
// with a secret kept in the teacher's settings. Opening it shows a button; only pressing it
// (a POST) checks in, so link previews never do. Like the dashboard button, it only works on the
// session's day and records the time it is pressed.

function linkSecret(db: DB, ownerId: number): Buffer {
  let secret = getSetting(db, ownerId, 'checkin.linkSecret', '');
  if (!secret) setSetting(db, ownerId, 'checkin.linkSecret', (secret = randomBytes(32).toString('base64url')));
  return Buffer.from(secret, 'base64url');
}

const sign = (db: DB, ownerId: number, sessionId: number) => createHmac('sha256', linkSecret(db, ownerId)).update(`checkin:${sessionId}`).digest('base64url').slice(0, 32);

/** The public address links point at: KRUBOOK_PUBLIC_URL, else the address last used to sign in. */
export function publicUrl(db: DB, ownerId: number): string | null {
  return process.env.KRUBOOK_PUBLIC_URL?.replace(/\/$/, '') || getSetting(db, ownerId, 'app.url', '') || null;
}

export function checkinLink(db: DB, u: User, sessionId: number): string | null {
  const base = publicUrl(db, u.id);
  return base ? `${base}/api/checkin-link/${sessionId}/${sign(db, u.id, sessionId)}` : null;
}

/** The session and its teacher for a check-in link, or null when the link is not valid. */
export function resolveCheckinLink(db: DB, sessionId: number, token: string): { u: User; s: Row } | null {
  const s = db.get('SELECT s.*, c.code, c.teacher_id FROM sessions s JOIN classes c ON c.id = s.class_id WHERE s.id = ?', sessionId);
  if (!s) return null;
  const u = db.get<User>('SELECT id, email, name, role FROM users WHERE id = ?', s.teacher_id);
  if (!u) return null;
  const want = Buffer.from(sign(db, u.id, s.id)), got = Buffer.from(String(token));
  return want.length === got.length && timingSafeEqual(want, got) ? { u, s } : null;
}

// ---------------------------------------------------------------------------------------------
// Sessions you checked in to and took a roll call for are recorded as taught once they end, with
// the planned lesson part and the full scheduled length (as the Review page would). Anything else
// still waits for a decision on the Review page. Off with the 'auto.recordTaught' setting.

export function autoRecordTaught(db: DB, u: User): number[] {
  if (getSetting(db, u.id, 'auto.recordTaught', '1') !== '1') return [];
  const now = today(db, u);
  const time = process.env.KRUBOOK_NOW_TIME ?? (process.env.KRUBOOK_TODAY ? '23:59' : nowTimeIn(getSetting(db, u.id, 'timezone', DEFAULT_TZ)));
  const due = db.all(
    `SELECT s.* FROM sessions s JOIN classes c ON c.id = s.class_id
      WHERE c.teacher_id = ? AND s.status = 'planned' AND (s.date < ? OR (s.date = ? AND s.end_time <= ?))
        AND EXISTS (SELECT 1 FROM checkins k WHERE k.session_id = s.id)
        AND EXISTS (SELECT 1 FROM attendance a WHERE a.session_id = s.id)
        AND NOT EXISTS (SELECT 1 FROM teaching_records r WHERE r.session_id = s.id)`,
    u.id, now, now, time,
  );
  const done: number[] = [];
  for (const s of due) {
    try {
      completeSession(db, u, s.id, {
        parts: s.part_id && s.activity === 'lesson' ? [{ partId: s.part_id, coverage: 'full' }] : [],
        minutes: durationMinutes(s.start_time, s.end_time),
        notes: 'Recorded automatically: you checked in and took the roll call.',
      });
      done.push(s.id);
    } catch (e) {
      console.error(`Auto-record of session ${s.id} failed:`, (e as Error).message);
    }
  }
  return done;
}

export function autoRecordAll(db: DB) {
  let n = 0;
  for (const u of db.all<User>('SELECT id, email, name, role FROM users')) n += autoRecordTaught(db, u).length;
  return n;
}
