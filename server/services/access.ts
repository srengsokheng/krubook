import { AppError, type DB, type Row } from '../db.ts';
import type { User } from '../auth.ts';
import { DEFAULT_TZ, todayIn } from '../../shared/dates.ts';
import { DEFAULT_PAY_START_DAY } from '../../shared/pay.ts';

// Every lookup is scoped to the signed-in teacher. Admins can see everything. A record that exists
// but belongs to someone else is reported as "not found" so IDs cannot be probed.

const isAdmin = (u: User) => u.role === 'admin';

function found(row: Row | undefined, what: string): Row {
  if (!row) throw new AppError(404, `${what} not found.`);
  return row;
}

export function ownCourse(db: DB, u: User, id: number): Row {
  return found(db.get('SELECT * FROM courses WHERE id = ? AND (owner_id = ? OR ?)', id, u.id, isAdmin(u) ? 1 : 0), 'Course');
}

export function ownTerm(db: DB, u: User, id: number): Row {
  return found(db.get('SELECT * FROM terms WHERE id = ? AND (owner_id = ? OR ?)', id, u.id, isAdmin(u) ? 1 : 0), 'Term');
}

export function ownClass(db: DB, u: User, id: number): Row {
  return found(db.get('SELECT * FROM classes WHERE id = ? AND (teacher_id = ? OR ?)', id, u.id, isAdmin(u) ? 1 : 0), 'Class');
}

export function ownStudent(db: DB, u: User, id: number): Row {
  return found(db.get('SELECT * FROM students WHERE id = ? AND (owner_id = ? OR ?)', id, u.id, isAdmin(u) ? 1 : 0), 'Student');
}

export function ownSession(db: DB, u: User, id: number): Row {
  const s = found(db.get('SELECT * FROM sessions WHERE id = ?', id), 'Session');
  ownClass(db, u, s.class_id);
  return s;
}

export function ownEnrollment(db: DB, u: User, id: number): Row {
  const e = found(db.get('SELECT * FROM enrollments WHERE id = ?', id), 'Enrollment');
  ownClass(db, u, e.class_id);
  return e;
}

export function ownLesson(db: DB, u: User, id: number): Row {
  const l = found(db.get('SELECT * FROM lessons WHERE id = ?', id), 'Lesson');
  ownCourse(db, u, l.course_id);
  return l;
}

export function ownPart(db: DB, u: User, id: number): Row {
  const p = found(db.get('SELECT p.*, l.course_id FROM lesson_parts p JOIN lessons l ON l.id = p.lesson_id WHERE p.id = ?', id), 'Lesson part');
  ownCourse(db, u, p.course_id);
  return p;
}

export function classScope(u: User): { where: string; params: number[] } {
  return isAdmin(u) ? { where: '1', params: [] } : { where: 'c.teacher_id = ?', params: [u.id] };
}

export function getSetting(db: DB, ownerId: number, key: string, fallback: string): string {
  return db.get<{ value: string }>('SELECT value FROM settings WHERE owner_id = ? AND key = ?', ownerId, key)?.value ?? fallback;
}

export function setSetting(db: DB, ownerId: number, key: string, value: string) {
  db.run('INSERT INTO settings (owner_id, key, value) VALUES (?,?,?) ON CONFLICT(owner_id, key) DO UPDATE SET value = excluded.value', ownerId, key, value);
}

/** Day of the month a pay period starts on (16 = 16th of last month to 15th of this month; 1 = calendar month). */
export function payStartDay(db: DB, u: User): number {
  const n = Number(getSetting(db, u.id, 'pay.periodStart', String(DEFAULT_PAY_START_DAY)));
  return Number.isInteger(n) && n >= 1 && n <= 28 ? n : DEFAULT_PAY_START_DAY;
}

/** "Today" for the teacher, in their configured time zone. Overridable for tests and demos. */
export function today(db: DB, u: User): string {
  if (process.env.KRUBOOK_TODAY) return process.env.KRUBOOK_TODAY;
  return todayIn(getSetting(db, u.id, 'timezone', DEFAULT_TZ));
}
