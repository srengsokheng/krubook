import { AppError, type DB, type Row } from '../db.ts';
import { hashPassword, seedAccount, temporaryPassword, verifyPassword, type User } from '../auth.ts';
import { FEATURE_KEYS, FEATURES, accessExpired, parseFeaturesOff, type Feature } from '../../shared/accounts.ts';
import { isISODate } from '../../shared/dates.ts';
import { today } from './access.ts';

// Account administration. Administrators create teacher accounts (with a temporary password the
// teacher must change at first sign-in), suspend and reactivate them, set the last day they may
// change data (the paid-until date) and switch features off. Admins never see another teacher's
// courses, classes, students or pay; this is only the account itself plus counts.

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export function requireAdmin(u: User) {
  if (u.role !== 'admin') throw new AppError(403, 'Only an administrator can manage accounts.');
}

function accountOut(db: DB, r: Row, now: string) {
  const featuresOff = parseFeaturesOff(r.features_off);
  return {
    id: r.id, email: r.email, name: r.name, role: r.role, status: r.status, accessUntil: r.access_until,
    expired: accessExpired(r.role, r.access_until, now), featuresOff, mustChangePassword: !!r.must_change_password,
    lastLoginAt: r.last_login_at, createdAt: r.created_at, note: r.note,
    unclaimed: r.password_hash === '!',
    counts: { classes: r.classes ?? 0, students: r.students ?? 0 },
  };
}

const LIST = `SELECT u.*, (SELECT COUNT(*) FROM classes c WHERE c.teacher_id = u.id) AS classes,
    (SELECT COUNT(*) FROM students s WHERE s.owner_id = u.id) AS students FROM users u`;

export function listAccounts(db: DB, admin: User) {
  requireAdmin(admin);
  const now = today(db, admin);
  return {
    features: FEATURE_KEYS.map((k) => ({ key: k, label: FEATURES[k].label })),
    accounts: db.all(`${LIST} ORDER BY u.role = 'admin' DESC, u.name COLLATE NOCASE`).map((r) => accountOut(db, r, now)),
  };
}

function getAccount(db: DB, id: number): Row {
  const r = db.get(`${LIST} WHERE u.id = ?`, id);
  if (!r) throw new AppError(404, 'Account not found.');
  return r;
}

function cleanFeatures(v: unknown): Feature[] {
  if (v === undefined) return [];
  if (!Array.isArray(v) || v.some((k) => !FEATURE_KEYS.includes(k))) throw new AppError(422, 'Unknown feature.');
  return FEATURE_KEYS.filter((k) => v.includes(k));
}

function cleanDate(v: unknown): string | null {
  if (v === undefined || v === null || v === '') return null;
  if (!isISODate(v)) throw new AppError(422, 'Access until must be a valid date.');
  return v;
}

const activeAdmins = (db: DB) => (db.get("SELECT COUNT(*) AS n FROM users WHERE role = 'admin' AND status = 'active' AND password_hash <> '!'") as Row).n as number;

export function createAccount(db: DB, admin: User, b: Row) {
  requireAdmin(admin);
  const email = String(b.email ?? '').trim(), name = String(b.name ?? '').trim();
  if (!EMAIL_RE.test(email)) throw new AppError(422, 'Enter a valid email address.');
  if (!name) throw new AppError(422, 'Enter the teacher’s name.');
  if (db.get('SELECT 1 FROM users WHERE email = ?', email)) throw new AppError(409, 'An account with this email already exists.');
  const role = b.role === 'admin' ? 'admin' : 'teacher';
  const accessUntil = cleanDate(b.accessUntil), featuresOff = cleanFeatures(b.featuresOff);
  const password = temporaryPassword();
  return db.tx(() => {
    const id = db.run(
      'INSERT INTO users (email, name, password_hash, role, access_until, features_off, must_change_password, note) VALUES (?,?,?,?,?,?,1,?)',
      email, name, hashPassword(password), role, accessUntil, JSON.stringify(featuresOff), String(b.note ?? '').trim() || null,
    ).id;
    seedAccount(db, id);
    db.audit(admin.id, 'user', id, 'create', undefined, { email, name, role, accessUntil, featuresOff });
    return { account: accountOut(db, getAccount(db, id), today(db, admin)), temporaryPassword: password };
  });
}

export function updateAccount(db: DB, admin: User, id: number, b: Row) {
  requireAdmin(admin);
  const old = getAccount(db, id);
  const next = {
    name: b.name === undefined ? old.name : String(b.name).trim(),
    email: b.email === undefined ? old.email : String(b.email).trim(),
    role: b.role === undefined ? old.role : b.role === 'admin' ? 'admin' : 'teacher',
    status: b.status === undefined ? old.status : b.status === 'suspended' ? 'suspended' : 'active',
    accessUntil: b.accessUntil === undefined ? old.access_until : cleanDate(b.accessUntil),
    featuresOff: b.featuresOff === undefined ? parseFeaturesOff(old.features_off) : cleanFeatures(b.featuresOff),
    note: b.note === undefined ? old.note : String(b.note ?? '').trim() || null,
  };
  if (!next.name) throw new AppError(422, 'Enter the teacher’s name.');
  if (!EMAIL_RE.test(next.email)) throw new AppError(422, 'Enter a valid email address.');
  if (next.email.toLowerCase() !== String(old.email).toLowerCase() && db.get('SELECT 1 FROM users WHERE email = ? AND id <> ?', next.email, id)) throw new AppError(409, 'An account with this email already exists.');
  if (id === admin.id && (next.role !== 'admin' || next.status !== 'active')) throw new AppError(409, 'You cannot suspend your own account or remove your own administrator role.');
  if (old.role === 'admin' && old.status === 'active' && (next.role !== 'admin' || next.status !== 'active') && activeAdmins(db) <= 1) throw new AppError(409, 'This is the last administrator. Make another account an administrator first.');
  db.tx(() => {
    db.run('UPDATE users SET name = ?, email = ?, role = ?, status = ?, access_until = ?, features_off = ?, note = ? WHERE id = ?',
      next.name, next.email, next.role, next.status, next.accessUntil, JSON.stringify(next.featuresOff), next.note, id);
    if (next.status === 'suspended') db.run('DELETE FROM auth_sessions WHERE user_id = ?', id);
    db.audit(admin.id, 'user', id, 'update', { name: old.name, email: old.email, role: old.role, status: old.status, accessUntil: old.access_until, featuresOff: parseFeaturesOff(old.features_off) }, next);
  });
  return accountOut(db, getAccount(db, id), today(db, admin));
}

/** A new temporary password; the account is signed out everywhere and must choose its own. */
export function resetPassword(db: DB, admin: User, id: number) {
  requireAdmin(admin);
  const old = getAccount(db, id);
  if (id === admin.id) throw new AppError(409, 'Change your own password in Settings instead.');
  const password = temporaryPassword();
  db.tx(() => {
    db.run('UPDATE users SET password_hash = ?, must_change_password = 1 WHERE id = ?', hashPassword(password), id);
    db.run('DELETE FROM auth_sessions WHERE user_id = ?', id);
    db.run("UPDATE api_tokens SET revoked_at = datetime('now') WHERE user_id = ? AND revoked_at IS NULL", id);
    db.audit(admin.id, 'user', id, 'reset_password', undefined, { email: old.email });
  });
  return { temporaryPassword: password };
}

export function signOutEverywhere(db: DB, admin: User, id: number) {
  requireAdmin(admin);
  getAccount(db, id);
  const n = db.run('DELETE FROM auth_sessions WHERE user_id = ?', id).changes;
  db.run("UPDATE api_tokens SET revoked_at = datetime('now') WHERE user_id = ? AND revoked_at IS NULL", id);
  db.audit(admin.id, 'user', id, 'sign_out', undefined, { sessions: n });
  return { signedOut: n };
}

/** Only an account with no data can be deleted; one that has data is suspended instead. */
export function deleteAccount(db: DB, admin: User, id: number) {
  requireAdmin(admin);
  const old = getAccount(db, id);
  if (id === admin.id) throw new AppError(409, 'You cannot delete your own account.');
  const owns = db.get(`SELECT (SELECT COUNT(*) FROM courses WHERE owner_id = ?) + (SELECT COUNT(*) FROM terms WHERE owner_id = ?)
      + (SELECT COUNT(*) FROM students WHERE owner_id = ?) + (SELECT COUNT(*) FROM classes WHERE teacher_id = ?) AS n`, id, id, id, id)!.n;
  if (owns > 0) throw new AppError(409, 'This account has courses, classes or students. Suspend it instead, so its data is kept.');
  if (old.role === 'admin' && old.status === 'active' && activeAdmins(db) <= 1) throw new AppError(409, 'This is the last administrator.');
  db.tx(() => {
    for (const t of ['auth_sessions', 'settings', 'holidays', 'rates', 'pay_adjustments', 'payments', 'pay_statements', 'notification_log']) {
      db.run(`DELETE FROM ${t} WHERE ${t === 'auth_sessions' ? 'user_id' : 'owner_id'} = ?`, id);
    }
    db.run('UPDATE audit_log SET user_id = NULL WHERE user_id = ?', id);
    db.run('DELETE FROM users WHERE id = ?', id);
    db.audit(admin.id, 'user', id, 'delete', { email: old.email, name: old.name });
  });
}

/** The signed-in teacher changes their own password; other sign-ins end. */
export function changeOwnPassword(db: DB, u: User, currentToken: string | null, b: Row) {
  const row = db.get('SELECT password_hash FROM users WHERE id = ?', u.id)!;
  if (!verifyPassword(String(b.current ?? ''), row.password_hash)) throw new AppError(422, 'Your current password is not correct.');
  const next = String(b.next ?? '');
  if (next.length < 8) throw new AppError(422, 'Use a new password of at least 8 characters.');
  if (verifyPassword(next, row.password_hash)) throw new AppError(422, 'Choose a password different from the current one.');
  db.tx(() => {
    db.run('UPDATE users SET password_hash = ?, must_change_password = 0 WHERE id = ?', hashPassword(next), u.id);
    db.run('DELETE FROM auth_sessions WHERE user_id = ? AND token IS NOT ?', u.id, currentToken);
    db.run("UPDATE api_tokens SET revoked_at = datetime('now') WHERE user_id = ? AND revoked_at IS NULL", u.id);
    db.audit(u.id, 'user', u.id, 'change_password');
  });
}
