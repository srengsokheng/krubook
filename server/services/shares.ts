import { randomBytes } from 'node:crypto';
import { AppError, type DB, type Row } from '../db.ts';
import type { User } from '../auth.ts';
import { ownClass } from './access.ts';
import { gradebook } from './records.ts';

// Score links: a teacher shares a class's marks with its students through a link that needs no
// sign-in and stops working after a day or two (or when the teacher stops it). Anyone with the link
// sees the class list's marks, so the link is short-lived, unguessable, and never listed by search
// engines. It shows only the class's marks: no other class, no teacher pages.

const MAX_DAYS = 30;

const shareOut = (s: Row) => ({
  id: s.id, token: s.token, showNames: !!s.show_names, createdAt: s.created_at, expiresAt: s.expires_at, revokedAt: s.revoked_at,
  views: s.views, lastViewedAt: s.last_viewed_at, active: !!s.active,
});
const COLS = "*, (revoked_at IS NULL AND expires_at > datetime('now')) AS active";

export function listShares(db: DB, u: User, classId: number) {
  ownClass(db, u, classId);
  return db.all(`SELECT ${COLS} FROM score_shares WHERE class_id = ? ORDER BY created_at DESC, id DESC`, classId).map(shareOut);
}

export function createShare(db: DB, u: User, classId: number, b: Row) {
  ownClass(db, u, classId);
  const days = Number(b.days ?? 1);
  if (!(days > 0 && days <= MAX_DAYS)) throw new AppError(422, `A link can last from a few hours up to ${MAX_DAYS} days.`);
  const token = randomBytes(18).toString('base64url');
  const id = db.tx(() => {
    const id = db.run("INSERT INTO score_shares (class_id, token, show_names, created_by, expires_at) VALUES (?,?,?,?, datetime('now', ?))",
      classId, token, b.showNames === false ? 0 : 1, u.id, `+${Math.round(days * 24 * 60)} minutes`).id;
    db.audit(u.id, 'score_share', id, 'create', undefined, { classId, days, showNames: b.showNames !== false });
    return id;
  });
  return shareOut(db.get(`SELECT ${COLS} FROM score_shares WHERE id = ?`, id)!);
}

export function stopShare(db: DB, u: User, id: number) {
  const s = db.get('SELECT * FROM score_shares WHERE id = ?', id);
  if (!s) throw new AppError(404, 'Link not found.');
  ownClass(db, u, s.class_id);
  db.tx(() => {
    db.run("UPDATE score_shares SET revoked_at = COALESCE(revoked_at, datetime('now')) WHERE id = ?", s.id);
    db.audit(u.id, 'score_share', s.id, 'stop', { classId: s.class_id });
  });
}

/** What a student sees through a link: the class's marks, no sign-in. */
export function publicScores(db: DB, token: string) {
  const s = db.get(`SELECT ${COLS} FROM score_shares WHERE token = ?`, token);
  if (!s || s.revoked_at) throw new AppError(404, 'This link does not exist or was stopped by the teacher.');
  if (!s.active) throw new AppError(410, 'This link has ended. Ask your teacher for a new one.');
  const cls = db.get('SELECT c.*, co.name AS course_name, u.id AS uid, u.email, u.name AS teacher, u.role FROM classes c JOIN courses co ON co.id = c.course_id JOIN users u ON u.id = c.teacher_id WHERE c.id = ?', s.class_id)!;
  const teacher: User = { id: cls.uid, email: cls.email, name: cls.teacher, role: cls.role };
  const gb = gradebook(db, teacher, cls.id);
  db.run("UPDATE score_shares SET views = views + 1, last_viewed_at = datetime('now') WHERE id = ?", s.id);
  const columns = gb.config.components.map((c) => ({ id: c.id, name: c.name, max: c.max }));
  const rows = gb.rows
    .filter((r: any) => r.enrollmentStatus === 'active' || r.enrollmentStatus === 'completed')
    .map((r: any) => ({
      code: r.code,
      ...(s.show_names ? { nameKm: r.nameKm, nameLatin: r.nameLatin } : {}),
      values: columns.map((c) => r.values?.[c.id] ?? null),
      total: r.total,
      result: r.complete && gb.check.valid ? r.result : null,
      label: r.complete && gb.check.valid ? r.label : '',
    }));
  return {
    classCode: cls.code, course: cls.course_name, teacher: cls.teacher, showNames: !!s.show_names,
    targetTotal: gb.config.targetTotal, passMark: gb.config.passMark,
    columns, rows, expiresAt: s.expires_at, now: db.get("SELECT datetime('now') AS n")!.n,
  };
}
