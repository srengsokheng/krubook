import express, { type Request, type Response, type Router } from 'express';
import { readFileSync } from 'node:fs';
import { AppError, translateDbError, type DB, type Row } from './db.ts';
import { addAccount, checkLoginRate, endSession, requireUser, startSession, verifyPassword, type User } from './auth.ts';
import { classScope, getSetting, ownClass, ownCourse, ownEnrollment, ownLesson, ownPart, ownSession, ownStudent, ownTerm, setSetting, today } from './services/access.ts';
import * as plan from './services/plan.ts';
import * as records from './services/records.ts';
import * as roster from './services/roster.ts';
import * as reports from './services/reports.ts';
import * as exportsSvc from './services/exports.ts';
import * as backup from './services/backup.ts';
import * as pay from './services/pay.ts';
import * as reconcile from './services/reconcile.ts';
import { pageArray, paged, readPage, readSort } from './paging.ts';
import { addDays, diffDays, isISODate, isTime, rangesOverlap, startOfWeek } from '../shared/dates.ts';
import { findOverlaps, standardTemplate, type SessionRule } from '../shared/schedule.ts';
import { cambodianHolidays } from '../shared/holidays.ts';
import { DEFAULT_TZ } from '../shared/dates.ts';

export interface DBHolder {
  db: DB;
  file: string;
  reopen(): void;
}

type Handler = (req: Request, db: DB, u: User, res: Response) => unknown | Promise<unknown>;

const num = (v: unknown, what: string): number => {
  const n = Number(v);
  if (!Number.isInteger(n) || n <= 0) throw new AppError(400, `Invalid ${what}.`);
  return n;
};
const str = (v: unknown, what: string, required = true): string | null => {
  if (v === undefined || v === null || (typeof v === 'string' && v.trim() === '')) {
    if (required) throw new AppError(422, `${what} is required.`);
    return null;
  }
  if (typeof v !== 'string') throw new AppError(422, `${what} must be text.`);
  return v.trim();
};
const date = (v: unknown, what: string, required = true): string | null => {
  if (!v) { if (required) throw new AppError(422, `${what} is required.`); return null; }
  if (!isISODate(v)) throw new AppError(422, `${what} must be a valid date.`);
  return v;
};

const optMinutes = (v: unknown): number | null => {
  if (v === undefined || v === null || v === '') return null;
  const n = Number(v);
  if (!Number.isInteger(n) || n < 1 || n > 1440) throw new AppError(422, 'Minutes must be a whole number between 1 and 1440.');
  return n;
};
const optText = (v: unknown, what: string, max = 2000): string | null => {
  if (v === undefined || v === null || v === '') return null;
  if (typeof v !== 'string') throw new AppError(422, `${what} must be text.`);
  if (v.length > max) throw new AppError(422, `${what} is too long (max ${max} characters).`);
  return v.trim() || null;
};
function list<T = unknown>(v: unknown, what: string, max = 2000): T[] {
  if (!Array.isArray(v)) throw new AppError(422, `${what} must be a list.`);
  if (v.length > max) throw new AppError(422, `Send at most ${max} ${what.toLowerCase()} at a time.`);
  return v as T[];
}

function validRule(v: unknown): SessionRule {
  const r = v as SessionRule;
  if (r?.mode === 'sequence' && Array.isArray(r.sequence) && r.sequence.length && r.sequence.every((k) => k === 'lecture' || k === 'practice')) return { mode: 'sequence', sequence: r.sequence };
  if (r?.mode === 'weekday' && r.map && Object.entries(r.map).every(([k, val]) => /^[0-6]$/.test(k) && (val === 'lecture' || val === 'practice'))) return { mode: 'weekday', map: r.map };
  throw new AppError(422, 'The Lecture/Practice rule is not valid.');
}

/** Last local and off-site backup results, written by the backup scripts. */
function backupStatus() {
  const read = (f: string) => { try { return JSON.parse(readFileSync(f, 'utf8')); } catch { return null; } };
  const dir = process.env.KRUBOOK_BACKUP_DIR ?? '/var/backups/krubook';
  return { local: read(`${dir}/status-local.json`), offsite: read(`${dir}/status-offsite.json`) };
}

export function buildRouter(holder: DBHolder): Router {
  const r = express.Router();
  const wrap = (fn: Handler, opts: { auth?: boolean } = {}) => async (req: Request, res: Response) => {
    try {
      const db = holder.db;
      const u = opts.auth === false ? (req.user as User) : requireUser(req);
      const out = await fn(req, db, u, res);
      if (!res.headersSent) res.json(out ?? { ok: true });
    } catch (e) {
      const err = e instanceof AppError ? e : translateDbError(e);
      if (err) res.status(err.status).json({ error: err.message, details: err.details });
      else {
        console.error(e);
        res.status(500).json({ error: 'Something went wrong on the server. The change was not saved.' });
      }
    }
  };
  const get = (p: string, fn: Handler, o?: { auth?: boolean }) => r.get(p, wrap(fn, o));
  const post = (p: string, fn: Handler, o?: { auth?: boolean }) => r.post(p, wrap(fn, o));
  const put = (p: string, fn: Handler) => r.put(p, wrap(fn));
  const del = (p: string, fn: Handler) => r.delete(p, wrap(fn));

  // ---- Health (public, for uptime monitors; reveals nothing about the data) ---------------------
  r.get('/health', (_req, res) => {
    try {
      holder.db.get('SELECT 1');
      res.json({ status: 'ok' });
    } catch {
      res.status(503).json({ status: 'error' });
    }
  });

  // ---- Auth ------------------------------------------------------------------------------
  // Self-service sign-up is off in production: accounts are created on the server with
  // `krubook-user add` (server/user-cli.ts). Local development keeps the first-run form.
  const signupOpen = () => process.env.NODE_ENV !== 'production' || process.env.KRUBOOK_ALLOW_SIGNUP === '1';
  get('/auth/me', (req, db) => ({ user: req.user ?? null, needsSetup: signupOpen() && !db.get("SELECT 1 FROM users WHERE password_hash <> '!' LIMIT 1") }), { auth: false });
  post('/auth/login', (req, db, _u, res) => {
    const fail = checkLoginRate(req);
    const row = db.get('SELECT * FROM users WHERE email = ?', String(req.body.email ?? '').trim());
    if (!row || !verifyPassword(String(req.body.password ?? ''), row.password_hash)) { fail(); throw new AppError(401, 'That email and password do not match an account.'); }
    startSession(db, req, res, row.id);
    return { user: { id: row.id, email: row.email, name: row.name, role: row.role } };
  }, { auth: false });
  post('/auth/setup', (req, db, _u, res) => {
    if (!signupOpen()) throw new AppError(403, 'New accounts cannot be created here. Ask the administrator.');
    if (db.get("SELECT 1 FROM users WHERE password_hash <> '!' LIMIT 1")) throw new AppError(409, 'An account already exists. Sign in instead.');
    const id = addAccount(db, str(req.body.email, 'Email')!, str(req.body.name, 'Name')!, String(req.body.password ?? ''));
    startSession(db, req, res, id);
    return { user: db.get('SELECT id, email, name, role FROM users WHERE id = ?', id) };
  }, { auth: false });
  post('/auth/logout', (req, db, _u, res) => { endSession(db, req, res); return { ok: true }; }, { auth: false });

  // ---- Settings --------------------------------------------------------------------------
  get('/settings', (_req, db, u) => ({
    timezone: getSetting(db, u.id, 'timezone', DEFAULT_TZ),
    language: getSetting(db, u.id, 'language', 'en'),
    notifyEnabled: getSetting(db, u.id, 'notify.enabled', '0') === '1',
    notifyTime: getSetting(db, u.id, 'notify.time', '18:00'),
    telegramChat: getSetting(db, u.id, 'notify.telegramChat', ''),
    hasTelegramToken: !!getSetting(db, u.id, 'notify.telegramToken', ''),
    statusLabels: JSON.parse(getSetting(db, u.id, 'statusLabels', '{}')),
    today: today(db, u),
  }));
  put('/settings', (req, db, u) => {
    const b = req.body;
    if (b.timezone !== undefined) {
      try { new Intl.DateTimeFormat('en', { timeZone: b.timezone }); } catch { throw new AppError(422, 'Unknown time zone.'); }
      setSetting(db, u.id, 'timezone', b.timezone);
    }
    if (b.language !== undefined) setSetting(db, u.id, 'language', b.language === 'km' ? 'km' : 'en');
    if (b.notifyEnabled !== undefined) setSetting(db, u.id, 'notify.enabled', b.notifyEnabled ? '1' : '0');
    if (b.notifyTime !== undefined) { if (!isTime(b.notifyTime)) throw new AppError(422, 'Reminder time must be HH:MM.'); setSetting(db, u.id, 'notify.time', b.notifyTime); }
    if (b.telegramChat !== undefined) setSetting(db, u.id, 'notify.telegramChat', String(b.telegramChat).trim());
    if (b.telegramToken) setSetting(db, u.id, 'notify.telegramToken', String(b.telegramToken).trim());
    if (b.statusLabels !== undefined) setSetting(db, u.id, 'statusLabels', JSON.stringify(b.statusLabels));
    return { ok: true };
  });
  get('/notifications/preview', (_req, db, u) => ({
    reminders: reports.buildReminders(db, u),
    sent: db.all('SELECT dedupe_key, message, status, sent_at FROM notification_log WHERE owner_id = ? ORDER BY id DESC LIMIT 20', u.id),
  }));
  post('/notifications/test', async (_req, db, u) => {
    const token = getSetting(db, u.id, 'notify.telegramToken', ''), chat = getSetting(db, u.id, 'notify.telegramChat', '');
    if (!token || !chat) throw new AppError(422, 'Add a Telegram bot token and chat ID first.');
    try { await reports.sendTelegram(token, chat, 'KruBook test message: reminders are working.'); }
    catch (e) { throw new AppError(502, `Telegram did not accept the message (${(e as Error).message}). Check the token and chat ID.`); }
    return { ok: true };
  });

  // ---- Courses & curriculum ---------------------------------------------------------------
  get('/courses', (_req, db, u) => db.all(
    `SELECT c.*, (SELECT COUNT(*) FROM lessons l WHERE l.course_id = c.id) AS lessons,
            (SELECT COUNT(*) FROM lesson_parts p JOIN lessons l ON l.id = p.lesson_id WHERE l.course_id = c.id) AS parts,
            (SELECT COUNT(*) FROM materials m JOIN lessons l ON l.id = m.lesson_id WHERE l.course_id = c.id) AS materials,
            (SELECT COUNT(*) FROM materials m JOIN lessons l ON l.id = m.lesson_id WHERE l.course_id = c.id AND m.status = 'ready') AS ready,
            (SELECT COUNT(*) FROM classes k WHERE k.course_id = c.id AND k.status IN ('active','upcoming')) AS active_classes
       FROM courses c WHERE c.owner_id = ? ORDER BY c.archived, c.code`, u.id));
  post('/courses', (req, db, u) => db.tx(() => {
    const b = req.body;
    const id = db.run('INSERT INTO courses (owner_id, code, name, name_km, description, color, weeks) VALUES (?,?,?,?,?,?,?)',
      u.id, str(b.code, 'Course code'), str(b.name, 'Course name'), str(b.nameKm, 'Khmer name', false), str(b.description, 'Description', false), b.color || '#3559c7', b.weeks ?? 17).id;
    for (const t of standardTemplate(b.weeks ?? 17)) db.run('INSERT INTO template_weeks (course_id, week, activity, checkpoint, label) VALUES (?,?,?,?,?)', id, t.week, t.activity, t.checkpoint ?? null, t.label ?? null);
    db.audit(u.id, 'course', id, 'create', undefined, b);
    return { id };
  }));
  get('/courses/:id', (req, db, u) => {
    const c = ownCourse(db, u, num(req.params.id, 'course'));
    const lessons = db.all('SELECT * FROM lessons WHERE course_id = ? ORDER BY position', c.id);
    const parts = db.all('SELECT p.* FROM lesson_parts p JOIN lessons l ON l.id = p.lesson_id WHERE l.course_id = ? ORDER BY p.position', c.id);
    const materials = db.all('SELECT m.* FROM materials m JOIN lessons l ON l.id = m.lesson_id WHERE l.course_id = ? ORDER BY m.kind, m.id', c.id);
    const used = new Set(db.all('SELECT DISTINCT rp.part_id FROM record_parts rp').map((x) => x.part_id));
    return {
      ...c, sessionRule: JSON.parse(c.session_rule),
      lessons: lessons.map((l, i) => ({ ...l, number: i + 1, parts: parts.filter((p) => p.lesson_id === l.id).map((p) => ({ ...p, taught: used.has(p.id) })), materials: materials.filter((m) => m.lesson_id === l.id) })),
      template: plan.courseTemplate(db, c.id, c.weeks),
    };
  });
  put('/courses/:id', (req, db, u) => {
    const c = ownCourse(db, u, num(req.params.id, 'course'));
    const b = req.body;
    db.run('UPDATE courses SET code=?, name=?, name_km=?, description=?, color=?, weeks=?, session_rule=?, archived=? WHERE id=?',
      str(b.code ?? c.code, 'Course code'), str(b.name ?? c.name, 'Course name'), b.nameKm ?? c.name_km, b.description ?? c.description, b.color ?? c.color, b.weeks ?? c.weeks,
      b.sessionRule ? JSON.stringify(validRule(b.sessionRule)) : c.session_rule, b.archived === undefined ? c.archived : b.archived ? 1 : 0, c.id);
    db.audit(u.id, 'course', c.id, 'update', c, b);
  });
  del('/courses/:id', (req, db, u) => {
    const c = ownCourse(db, u, num(req.params.id, 'course'));
    if (db.get('SELECT 1 FROM classes WHERE course_id = ?', c.id)) throw new AppError(409, 'Classes use this course. Archive it instead.');
    db.tx(() => { db.run('DELETE FROM courses WHERE id = ?', c.id); db.audit(u.id, 'course', c.id, 'delete', c); });
  });
  put('/courses/:id/template', (req, db, u) => {
    const c = ownCourse(db, u, num(req.params.id, 'course'));
    const weeks: Row[] = req.body.weeks;
    if (!Array.isArray(weeks) || !weeks.length) throw new AppError(422, 'Send the full list of weeks.');
    db.tx(() => {
      db.run('DELETE FROM template_weeks WHERE course_id = ?', c.id);
      weeks.forEach((w, i) => db.run('INSERT INTO template_weeks (course_id, week, activity, checkpoint, label) VALUES (?,?,?,?,?)', c.id, i + 1, w.activity, w.checkpoint || null, w.label || null));
      db.run('UPDATE courses SET weeks = ? WHERE id = ?', weeks.length, c.id);
      db.audit(u.id, 'course', c.id, 'template.update', undefined, weeks);
    });
  });
  post('/courses/:id/lessons', (req, db, u) => db.tx(() => {
    const c = ownCourse(db, u, num(req.params.id, 'course'));
    const pos = (db.get('SELECT COALESCE(MAX(position), 0) + 1 AS p FROM lessons WHERE course_id = ?', c.id) as Row).p;
    const id = db.run('INSERT INTO lessons (course_id, position, title, objectives, description, est_minutes) VALUES (?,?,?,?,?,?)', c.id, pos, str(req.body.title, 'Lesson title'), optText(req.body.objectives, 'Objectives'), optText(req.body.description, 'Description'), optMinutes(req.body.estMinutes)).id;
    const labels = req.body.parts === undefined ? ['A'] : list<string>(req.body.parts, 'Parts', 26).map((x) => str(x, 'Part label')!);
    if (!labels.length) labels.push('A');
    labels.forEach((label, i) => db.run('INSERT INTO lesson_parts (lesson_id, position, label) VALUES (?,?,?)', id, i + 1, label));
    return { id };
  }));
  put('/lessons/:id', (req, db, u) => {
    const l = ownLesson(db, u, num(req.params.id, 'lesson'));
    const b = req.body;
    db.run('UPDATE lessons SET title=?, objectives=?, description=?, est_minutes=? WHERE id=?', str(b.title ?? l.title, 'Lesson title'), b.objectives === undefined ? l.objectives : optText(b.objectives, 'Objectives'), b.description === undefined ? l.description : optText(b.description, 'Description'), b.estMinutes === undefined ? l.est_minutes : optMinutes(b.estMinutes), l.id);
  });
  del('/lessons/:id', (req, db, u) => {
    const l = ownLesson(db, u, num(req.params.id, 'lesson'));
    if (db.get('SELECT 1 FROM record_parts rp JOIN lesson_parts p ON p.id = rp.part_id WHERE p.lesson_id = ?', l.id)) throw new AppError(409, 'This lesson has already been taught in a class, so it cannot be deleted. Its history must stay intact.');
    db.tx(() => { db.run('DELETE FROM lessons WHERE id = ?', l.id); db.audit(u.id, 'lesson', l.id, 'delete', l); });
  });
  post('/lessons/:id/move', (req, db, u) => {
    const l = ownLesson(db, u, num(req.params.id, 'lesson'));
    const dir = req.body.direction === 'up' ? -1 : 1;
    const other = db.get(`SELECT * FROM lessons WHERE course_id = ? AND position ${dir < 0 ? '<' : '>'} ? ORDER BY position ${dir < 0 ? 'DESC' : 'ASC'} LIMIT 1`, l.course_id, l.position);
    if (!other) return { ok: true };
    db.tx(() => { db.run('UPDATE lessons SET position = ? WHERE id = ?', other.position, l.id); db.run('UPDATE lessons SET position = ? WHERE id = ?', l.position, other.id); });
  });
  post('/lessons/:id/parts', (req, db, u) => {
    const l = ownLesson(db, u, num(req.params.id, 'lesson'));
    const pos = (db.get('SELECT COALESCE(MAX(position), 0) + 1 AS p FROM lesson_parts WHERE lesson_id = ?', l.id) as Row).p;
    return { id: db.run('INSERT INTO lesson_parts (lesson_id, position, label, title, objectives, est_minutes) VALUES (?,?,?,?,?,?)', l.id, pos, str(req.body.label, 'Part label'), optText(req.body.title, 'Part title', 300), optText(req.body.objectives, 'Objectives'), optMinutes(req.body.estMinutes)).id };
  });
  put('/parts/:id', (req, db, u) => {
    const p = ownPart(db, u, num(req.params.id, 'part'));
    const b = req.body;
    db.run('UPDATE lesson_parts SET label=?, title=?, objectives=?, est_minutes=? WHERE id=?', str(b.label ?? p.label, 'Part label'), b.title === undefined ? p.title : optText(b.title, 'Part title', 300), b.objectives === undefined ? p.objectives : optText(b.objectives, 'Objectives'), b.estMinutes === undefined ? p.est_minutes : optMinutes(b.estMinutes), p.id);
  });
  del('/parts/:id', (req, db, u) => {
    const p = ownPart(db, u, num(req.params.id, 'part'));
    if (db.get('SELECT 1 FROM record_parts WHERE part_id = ?', p.id)) throw new AppError(409, 'This part has already been taught, so it cannot be deleted.');
    db.tx(() => { db.run('DELETE FROM lesson_parts WHERE id = ?', p.id); db.audit(u.id, 'lesson_part', p.id, 'delete', p); });
  });
  post('/parts/:id/move', (req, db, u) => {
    const p = ownPart(db, u, num(req.params.id, 'part'));
    const dir = req.body.direction === 'up' ? -1 : 1;
    const other = db.get(`SELECT * FROM lesson_parts WHERE lesson_id = ? AND position ${dir < 0 ? '<' : '>'} ? ORDER BY position ${dir < 0 ? 'DESC' : 'ASC'} LIMIT 1`, p.lesson_id, p.position);
    if (!other) return { ok: true };
    db.tx(() => { db.run('UPDATE lesson_parts SET position = ? WHERE id = ?', other.position, p.id); db.run('UPDATE lesson_parts SET position = ? WHERE id = ?', p.position, other.id); });
  });
  post('/materials', (req, db, u) => {
    const l = ownLesson(db, u, num(req.body.lessonId, 'lesson'));
    const b = req.body;
    if (b.partId) { const p = ownPart(db, u, num(b.partId, 'part')); if (p.lesson_id !== l.id) throw new AppError(422, 'That part belongs to another lesson.'); }
    return { id: db.run('INSERT INTO materials (lesson_id, part_id, kind, title, url, status) VALUES (?,?,?,?,?,?)', l.id, b.partId ?? null, b.kind ?? 'other', str(b.title, 'Material title'), b.url || null, b.status ?? 'not_started').id };
  });
  put('/materials/:id', (req, db, u) => {
    const m = db.get('SELECT * FROM materials WHERE id = ?', num(req.params.id, 'material'));
    if (!m) throw new AppError(404, 'Material not found.');
    ownLesson(db, u, m.lesson_id);
    const b = req.body;
    db.run("UPDATE materials SET kind=?, title=?, url=?, status=?, part_id=?, updated_at=datetime('now') WHERE id=?", b.kind ?? m.kind, b.title ?? m.title, b.url === undefined ? m.url : b.url || null, b.status ?? m.status, b.partId === undefined ? m.part_id : b.partId, m.id);
  });
  del('/materials/:id', (req, db, u) => {
    const m = db.get('SELECT * FROM materials WHERE id = ?', num(req.params.id, 'material'));
    if (!m) throw new AppError(404, 'Material not found.');
    ownLesson(db, u, m.lesson_id);
    db.run('DELETE FROM materials WHERE id = ?', m.id);
  });

  // ---- Terms & holidays --------------------------------------------------------------------
  get('/terms', (_req, db, u) => db.all(`SELECT t.*, (SELECT COUNT(*) FROM classes c WHERE c.term_id = t.id) AS classes FROM terms t WHERE t.owner_id = ? ORDER BY t.start_date DESC`, u.id));
  const termFields = (b: Row) => [str(b.name, 'Term name'), date(b.startDate, 'Start date'), date(b.endDate, 'End date'), date(b.midtermStart, 'Midterm start', false), date(b.midtermEnd, 'Midterm end', false), date(b.finalStart, 'Final start', false), date(b.finalEnd, 'Final end', false), b.gradeTarget ?? 100] as const;
  post('/terms', (req, db, u) => ({ id: db.run('INSERT INTO terms (owner_id, name, start_date, end_date, midterm_start, midterm_end, final_start, final_end, grade_target) VALUES (?,?,?,?,?,?,?,?,?)', u.id, ...termFields(req.body)).id }));
  get('/terms/:id', (req, db, u) => {
    const t = ownTerm(db, u, num(req.params.id, 'term'));
    return { ...t, holidays: db.all('SELECT * FROM holidays WHERE owner_id = ? AND term_id = ? ORDER BY date', u.id, t.id), classes: db.all('SELECT c.*, co.color, co.name AS course_name FROM classes c JOIN courses co ON co.id = c.course_id WHERE c.term_id = ? ORDER BY c.code', t.id) };
  });
  put('/terms/:id', (req, db, u) => {
    const t = ownTerm(db, u, num(req.params.id, 'term'));
    const status = req.body.status ?? t.status;
    db.tx(() => {
      db.run('UPDATE terms SET name=?, start_date=?, end_date=?, midterm_start=?, midterm_end=?, final_start=?, final_end=?, grade_target=?, status=? WHERE id=?', ...termFields({ name: t.name, startDate: t.start_date, endDate: t.end_date, midtermStart: t.midterm_start, midtermEnd: t.midterm_end, finalStart: t.final_start, finalEnd: t.final_end, gradeTarget: t.grade_target, ...req.body }), status, t.id);
      if (status === 'archived') db.run("UPDATE classes SET status = 'archived' WHERE term_id = ?", t.id);
      db.audit(u.id, 'term', t.id, 'update', t, req.body);
    });
  });
  del('/terms/:id', (req, db, u) => {
    const t = ownTerm(db, u, num(req.params.id, 'term'));
    if (db.get('SELECT 1 FROM classes WHERE term_id = ?', t.id)) throw new AppError(409, 'This term has classes. Archive it instead.');
    db.tx(() => { db.run('DELETE FROM terms WHERE id = ?', t.id); db.audit(u.id, 'term', t.id, 'delete', t); });
  });
  post('/terms/:id/clone', (req, db, u) => {
    const t = ownTerm(db, u, num(req.params.id, 'term'));
    const [name, start, end, ms, me, fs, fe, target] = termFields(req.body);
    const shift = diffDays(start!, t.start_date);
    return db.tx(() => {
      const nid = db.run('INSERT INTO terms (owner_id, name, start_date, end_date, midterm_start, midterm_end, final_start, final_end, grade_target, cloned_from_id) VALUES (?,?,?,?,?,?,?,?,?,?)', u.id, name, start, end, ms, me, fs, fe, target, t.id).id;
      const classes = db.all("SELECT * FROM classes WHERE term_id = ? AND status <> 'archived'", t.id);
      for (const c of classes) {
        const cid = db.run('INSERT INTO classes (term_id, course_id, teacher_id, code, name, start_date, end_date, room, weeks, session_rule, progress_tolerance, notes) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)',
          nid, c.course_id, c.teacher_id, c.code, c.name, addDays(c.start_date, shift), c.end_date ? addDays(c.end_date, shift) : null, c.room, c.weeks, c.session_rule, c.progress_tolerance, c.notes).id;
        for (const m of db.all('SELECT * FROM meetings WHERE class_id = ?', c.id)) db.run('INSERT INTO meetings (class_id, weekday, start_time, end_time, room) VALUES (?,?,?,?,?)', cid, m.weekday, m.start_time, m.end_time, m.room);
        const gc = db.get('SELECT * FROM grade_configs WHERE class_id = ?', c.id);
        if (gc) {
          const gid = db.run('INSERT INTO grade_configs (class_id, target_total, pass_mark, label_pass, label_fail, attendance_rule) VALUES (?,?,?,?,?,?)', cid, gc.target_total, gc.pass_mark, gc.label_pass, gc.label_fail, gc.attendance_rule).id;
          for (const comp of db.all('SELECT * FROM grade_components WHERE config_id = ?', gc.id)) db.run('INSERT INTO grade_components (config_id, position, key, name, max_score, kind) VALUES (?,?,?,?,?,?)', gid, comp.position, comp.key, comp.name, comp.max_score, comp.kind);
          try { db.tx(() => db.run("UPDATE grade_configs SET status = 'active' WHERE id = ?", gid)); } catch { /* an invalid configuration stays a draft */ }
        }
        for (const rt of db.all('SELECT * FROM rates WHERE class_id = ?', c.id)) db.run('INSERT INTO rates (owner_id, class_id, course_id, mode, amount, currency, effective_from) VALUES (?,?,?,?,?,?,?)', rt.owner_id, cid, rt.course_id, rt.mode, rt.amount, rt.currency, start);
      }
      db.audit(u.id, 'term', nid, 'clone', { from: t.id }, { classes: classes.length });
      return { id: nid, classes: classes.length };
    });
  });
  get('/holidays', (req, db, u) => db.all('SELECT h.*, t.name AS term_name FROM holidays h LEFT JOIN terms t ON t.id = h.term_id WHERE h.owner_id = ? ORDER BY h.date', u.id));
  post('/holidays', (req, db, u) => {
    const b = req.body;
    if (b.termId) ownTerm(db, u, num(b.termId, 'term'));
    const from = date(b.date, 'Date')!, to = date(b.endDate, 'End date', false) ?? from;
    if (to < from || diffDays(to, from) > 60) throw new AppError(422, 'Choose an end date on or after the start date, at most 60 days later.');
    let n = 0;
    db.tx(() => { for (let d = from; d <= to; d = addDays(d, 1)) { db.run('INSERT INTO holidays (owner_id, term_id, date, name, name_km, source) VALUES (?,?,?,?,?,?)', u.id, b.termId ?? null, d, str(b.name, 'Holiday name'), b.nameKm ?? null, 'user'); n++; } });
    return { created: n };
  });
  put('/holidays/:id', (req, db, u) => {
    const h = db.get('SELECT * FROM holidays WHERE id = ? AND owner_id = ?', num(req.params.id, 'holiday'), u.id);
    if (!h) throw new AppError(404, 'Holiday not found.');
    db.tx(() => {
      db.run('UPDATE holidays SET date=?, name=?, name_km=?, approx=0, verified_note=? WHERE id=?', date(req.body.date ?? h.date, 'Date'), str(req.body.name ?? h.name, 'Name'), req.body.nameKm ?? h.name_km, req.body.verifiedNote === undefined ? (h.verified_note ?? 'Confirmed by the teacher') : optText(req.body.verifiedNote, 'Source', 200), h.id);
      db.audit(u.id, 'holiday', h.id, 'update', h, req.body);
    });
  });
  del('/holidays/:id', (req, db, u) => { db.run('DELETE FROM holidays WHERE id = ? AND owner_id = ?', num(req.params.id, 'holiday'), u.id); });
  post('/holidays/check', (req, db, u) => {
    // Re-check every active class against the current holiday calendar and create proposals.
    const sc = classScope(u);
    const classes = db.all(`SELECT c.id, c.code FROM classes c WHERE ${sc.where} AND c.status IN ('active','upcoming')`, ...sc.params);
    return classes.map((c) => ({ classId: c.id, code: c.code, proposal: plan.createProposal(db, u, c.id, 'Holiday calendar re-checked') })).filter((x) => x.proposal);
  });

  // ---- Classes -----------------------------------------------------------------------------
  get('/classes', (req, db, u) => {
    const sc = classScope(u);
    const rows = db.all(
      `SELECT c.*, co.name AS course_name, co.code AS course_code, co.color, t.name AS term_name,
              (SELECT COUNT(*) FROM enrollments e WHERE e.class_id = c.id AND e.status = 'active') AS students,
              (SELECT COUNT(*) FROM sessions s WHERE s.class_id = c.id) AS sessions
         FROM classes c JOIN courses co ON co.id = c.course_id JOIN terms t ON t.id = c.term_id
        WHERE ${sc.where} ${req.query.termId ? 'AND c.term_id = ?' : ''} ORDER BY t.start_date DESC, c.code`,
      ...sc.params, ...(req.query.termId ? [Number(req.query.termId)] : []),
    );
    return rows.map((c) => ({ ...c, meetings: db.all('SELECT * FROM meetings WHERE class_id = ? ORDER BY weekday, start_time', c.id), summary: c.sessions ? plan.classSummary(db, u, c.id).progress : null }));
  });
  post('/classes', (req, db, u) => {
    const b = req.body;
    ownTerm(db, u, num(b.termId, 'term'));
    ownCourse(db, u, num(b.courseId, 'course'));
    return db.tx(() => {
      const id = db.run('INSERT INTO classes (term_id, course_id, teacher_id, code, name, start_date, end_date, room, weeks, status, notes) VALUES (?,?,?,?,?,?,?,?,?,?,?)',
        b.termId, b.courseId, u.id, str(b.code, 'Class code'), b.name ?? null, date(b.startDate, 'Start date'), date(b.endDate, 'End date', false), b.room ?? null, b.weeks ?? 17, b.status ?? 'upcoming', b.notes ?? null).id;
      records.ensureConfig(db, id);
      db.audit(u.id, 'class', id, 'create', undefined, b);
      return { id };
    });
  });
  get('/classes/:id', (req, db, u) => {
    const c = ownClass(db, u, num(req.params.id, 'class'));
    const course = db.get('SELECT * FROM courses WHERE id = ?', c.course_id)!;
    return {
      ...c, course, term: db.get('SELECT * FROM terms WHERE id = ?', c.term_id), today: today(db, u),
      rule: plan.classRule(c, course), ruleIsCustom: !!c.session_rule,
      meetings: db.all('SELECT * FROM meetings WHERE class_id = ? ORDER BY weekday, start_time', c.id),
      parts: plan.orderedParts(db, c.course_id),
      summary: plan.classSummary(db, u, c.id),
      pendingProposal: plan.listProposals(db, u, c.id).find((p) => p.status === 'pending') ?? null,
    };
  });
  put('/classes/:id', (req, db, u) => {
    const c = ownClass(db, u, num(req.params.id, 'class'));
    const b = req.body;
    db.tx(() => {
      db.run('UPDATE classes SET code=?, name=?, start_date=?, end_date=?, room=?, weeks=?, status=?, notes=?, progress_tolerance=?, session_rule=? WHERE id=?',
        str(b.code ?? c.code, 'Class code'), b.name === undefined ? c.name : b.name, date(b.startDate ?? c.start_date, 'Start date'), b.endDate === undefined ? c.end_date : date(b.endDate, 'End date', false),
        b.room === undefined ? c.room : b.room, b.weeks ?? c.weeks, b.status ?? c.status, b.notes === undefined ? c.notes : b.notes, b.progressTolerance ?? c.progress_tolerance,
        b.sessionRule === undefined ? c.session_rule : b.sessionRule === null ? null : JSON.stringify(validRule(b.sessionRule)), c.id);
      db.audit(u.id, 'class', c.id, 'update', c, b);
    });
  });
  put('/classes/:id/meetings', (req, db, u) => {
    const c = ownClass(db, u, num(req.params.id, 'class'));
    const meetings = list<Row>(req.body.meetings ?? [], 'Meetings', 14);
    for (const m of meetings) {
      if (!(Number.isInteger(m.weekday) && m.weekday >= 0 && m.weekday <= 6)) throw new AppError(422, 'Choose a weekday for every meeting.');
      if (!isTime(m.start) || !isTime(m.end) || m.end <= m.start) throw new AppError(422, 'Every meeting needs a start and end time, with the end after the start.');
    }
    for (let i = 0; i < meetings.length; i++) for (let j = i + 1; j < meetings.length; j++)
      if (meetings[i].weekday === meetings[j].weekday && rangesOverlap(meetings[i].start, meetings[i].end, meetings[j].start, meetings[j].end)) throw new AppError(422, 'Two meetings of this class overlap.');
    db.tx(() => {
      const keep = new Set(meetings.filter((m) => m.id).map((m) => m.id));
      for (const old of db.all('SELECT id FROM meetings WHERE class_id = ?', c.id)) if (!keep.has(old.id)) db.run('DELETE FROM meetings WHERE id = ?', old.id);
      for (const m of meetings) {
        if (m.id) db.run('UPDATE meetings SET weekday=?, start_time=?, end_time=?, room=? WHERE id=? AND class_id=?', m.weekday, m.start, m.end, m.room ?? null, m.id, c.id);
        else db.run('INSERT INTO meetings (class_id, weekday, start_time, end_time, room) VALUES (?,?,?,?,?)', c.id, m.weekday, m.start, m.end, m.room ?? null);
      }
      db.audit(u.id, 'class', c.id, 'meetings.update', undefined, meetings);
    });
    const others = db.all(`SELECT m.*, k.code FROM meetings m JOIN classes k ON k.id = m.class_id WHERE k.teacher_id = ? AND k.term_id = ? AND k.id <> ? AND k.status <> 'archived'`, c.teacher_id, c.term_id, c.id);
    const warnings = meetings.flatMap((m) => others.filter((o) => o.weekday === m.weekday && rangesOverlap(m.start, m.end, o.start_time, o.end_time)).map((o) => `Overlaps ${o.code} on the same day (${o.start_time}–${o.end_time}).`));
    return { warnings };
  });

  // ---- Plan & sessions ---------------------------------------------------------------------
  post('/classes/:id/plan', (req, db, u) => plan.generateForClass(db, u, num(req.params.id, 'class'), { dryRun: !!req.body.dryRun }));
  get('/classes/:id/sessions', (req, db, u) => {
    const c = ownClass(db, u, num(req.params.id, 'class'));
    return db.all(
      `SELECT s.*, r.id AS record_id, r.pace, r.minutes, r.notes AS record_notes, r.follow_up,
              (SELECT json_group_array(json_object('partId', rp.part_id, 'coverage', rp.coverage)) FROM record_parts rp WHERE rp.record_id = r.id) AS taught_parts,
              (SELECT COUNT(*) FROM attendance a WHERE a.session_id = s.id) AS attendance_marks
         FROM sessions s LEFT JOIN teaching_records r ON r.session_id = s.id WHERE s.class_id = ? ORDER BY s.date, s.start_time`, c.id,
    ).map((s) => ({ ...s, taught_parts: s.record_id ? JSON.parse(s.taught_parts) : [] }));
  });
  post('/classes/:id/sessions', (req, db, u) => plan.addSession(db, u, num(req.params.id, 'class'), req.body));
  put('/sessions/:id', (req, db, u) => plan.updateSession(db, u, num(req.params.id, 'session'), req.body));
  post('/sessions/:id/cancel', (req, db, u) => plan.cancelSession(db, u, num(req.params.id, 'session'), String(req.body.reason ?? '')));
  post('/sessions/:id/restore', (req, db, u) => plan.restoreSession(db, u, num(req.params.id, 'session')));
  post('/sessions/:id/move', (req, db, u) => plan.moveSession(db, u, num(req.params.id, 'session'), req.body));
  post('/sessions/:id/complete', (req, db, u) => plan.completeSession(db, u, num(req.params.id, 'session'), req.body));
  del('/sessions/:id', (req, db, u) => {
    const sess = ownSession(db, u, num(req.params.id, 'session'));
    if (sess.gen_key || sess.moved_from_id) throw new AppError(409, 'Only make-up or extra sessions you added can be deleted. Cancel planned sessions instead.');
    db.tx(() => { db.run('DELETE FROM sessions WHERE id = ?', sess.id); db.audit(u.id, 'session', sess.id, 'delete', sess); });
  });
  post('/sessions/:id/reopen', (req, db, u) => plan.reopenSession(db, u, num(req.params.id, 'session')));
  get('/sessions/:id/history', (req, db, u) => {
    const s = ownSession(db, u, num(req.params.id, 'session'));
    return db.all("SELECT a.*, u.name AS user_name FROM audit_log a LEFT JOIN users u ON u.id = a.user_id WHERE (a.entity = 'session' AND a.entity_id = ?) OR (a.entity = 'attendance' AND a.entity_id IN (SELECT id FROM attendance WHERE session_id = ?)) ORDER BY a.id DESC LIMIT 100", s.id, s.id);
  });
  get('/classes/:id/proposals', (req, db, u) => plan.listProposals(db, u, num(req.params.id, 'class')));
  post('/classes/:id/proposals', (req, db, u) => plan.createProposal(db, u, num(req.params.id, 'class'), String(req.body.reason ?? 'Manual re-plan')) ?? { none: true });
  post('/proposals/:id/apply', (req, db, u) => plan.applyProposal(db, u, num(req.params.id, 'proposal')));
  post('/proposals/:id/dismiss', (req, db, u) => plan.dismissProposal(db, u, num(req.params.id, 'proposal')));

  get('/timetable', (req, db, u) => {
    const from = startOfWeek(date(req.query.from ?? today(db, u), 'Week')!);
    const to = addDays(from, 6);
    const sc = classScope(u);
    const sessions = db.all(
      `SELECT s.id, s.class_id, s.date, s.start_time AS start, s.end_time AS "end", s.kind, s.activity, s.status, s.checkpoint, s.is_makeup, s.moved_from_id, s.note, s.part_id, s.week,
              c.code, c.room AS class_room, co.name AS course_name, co.color
         FROM sessions s JOIN classes c ON c.id = s.class_id JOIN courses co ON co.id = c.course_id
        WHERE ${sc.where} AND s.date BETWEEN ? AND ? AND c.status <> 'archived' ORDER BY s.date, s.start_time`,
      ...sc.params, from, to,
    );
    const partNames = new Map<number, string>();
    for (const cid of new Set(db.all(`SELECT DISTINCT c.course_id FROM classes c WHERE ${sc.where}`, ...sc.params).map((x) => x.course_id))) for (const p of plan.orderedParts(db, cid)) partNames.set(p.id, `${p.code} ${p.title ?? p.lessonTitle}`);
    const overlaps = findOverlaps(sessions.map((s) => ({ ...s, classId: s.class_id })) as any[]).map(([a, b]) => [a.id, b.id]);
    // Classes that have not started yet appear as outlines on their future meeting slots.
    const ghosts = db.all(`SELECT m.*, c.id AS class_id, c.code, c.start_date, co.color, co.name AS course_name FROM meetings m JOIN classes c ON c.id = m.class_id JOIN courses co ON co.id = c.course_id WHERE ${sc.where} AND c.start_date > ? AND c.status IN ('upcoming','active')`, ...sc.params, from)
      .map((m) => ({ classId: m.class_id, code: m.code, color: m.color, courseName: m.course_name, date: addDays(from, (m.weekday + 6) % 7), start: m.start_time, end: m.end_time, startsOn: m.start_date }))
      .filter((g) => g.date < g.startsOn && !sessions.some((s) => s.class_id === g.classId && s.date === g.date));
    return { from, to, today: today(db, u), sessions: sessions.map((s) => ({ ...s, part: s.part_id ? partNames.get(s.part_id) ?? null : null })), overlaps, ghosts };
  });

  // ---- Students & roster -------------------------------------------------------------------
  get('/students', (req, db, u) => {
    const p = readPage(req.query, 25);
    const q = `%${String(req.query.q ?? '').trim()}%`;
    const order = readSort(req.query, { code: 's.student_code', km: 's.name_km', latin: 's.name_latin COLLATE NOCASE' }, 'code');
    const where = 's.owner_id = ? AND (s.student_code LIKE ? OR s.name_latin LIKE ? OR s.name_km LIKE ? OR s.email LIKE ?)';
    const params = [u.id, q, q, q, q];
    const total = (db.get(`SELECT COUNT(*) AS n FROM students s WHERE ${where}`, ...params) as Row).n;
    const items = db.all(
      `SELECT s.id, s.student_code, s.name_km, s.name_latin, s.email,
              (SELECT group_concat(c.code, ', ') FROM enrollments e JOIN classes c ON c.id = e.class_id WHERE e.student_id = s.id AND e.status = 'active') AS classes
         FROM students s WHERE ${where} ORDER BY ${order}, s.id LIMIT ? OFFSET ?`, ...params, p.pageSize, p.offset);
    return paged(items, total, p);
  });
  post('/students', (req, db, u) => {
    const b = req.body;
    if (!b.nameKm?.trim() && !b.nameLatin?.trim()) throw new AppError(422, 'Enter a Khmer or Latin name.');
    return db.tx(() => {
      const id = db.run('INSERT INTO students (owner_id, student_code, name_km, name_latin, gender, email, phone, notes) VALUES (?,?,?,?,?,?,?,?)', u.id, str(b.code, 'Student ID'), b.nameKm?.trim() || null, b.nameLatin?.trim() || null, b.gender || null, b.email || null, b.phone || null, b.notes || null).id;
      if (b.classId) { ownClass(db, u, num(b.classId, 'class')); db.run('INSERT INTO enrollments (student_id, class_id, enrolled_on) VALUES (?,?,?)', id, b.classId, today(db, u)); }
      return { id };
    });
  });
  del('/students/:id', (req, db, u) => {
    const st = ownStudent(db, u, num(req.params.id, 'student'));
    if (db.get('SELECT 1 FROM enrollments WHERE student_id = ?', st.id)) throw new AppError(409, 'This student has class history. Mark the enrollment as dropped or withdrawn instead of deleting the student.');
    db.tx(() => { db.run('DELETE FROM students WHERE id = ?', st.id); db.audit(u.id, 'student', st.id, 'delete', st); });
  });
  get('/students/:id', (req, db, u) => {
    const s = ownStudent(db, u, num(req.params.id, 'student'));
    const enrollments = db.all(`SELECT e.*, c.code, c.id AS class_id, t.name AS term_name, co.name AS course_name FROM enrollments e JOIN classes c ON c.id = e.class_id JOIN terms t ON t.id = c.term_id JOIN courses co ON co.id = c.course_id WHERE e.student_id = ? ORDER BY e.enrolled_on DESC, e.id DESC`, s.id);
    return {
      ...s, custom: JSON.parse(s.custom || '{}'),
      enrollments: enrollments.map((e) => {
        const g = records.gradebook(db, u, e.class_id, { enrollmentIds: [e.id] }).rows[0];
        return { ...e, total: g?.total ?? null, label: g?.label ?? '', complete: g?.complete ?? false, attendance: g?.attendance ?? null };
      }),
    };
  });
  put('/students/:id', (req, db, u) => {
    const s = ownStudent(db, u, num(req.params.id, 'student'));
    const b = req.body;
    db.tx(() => {
      db.run('UPDATE students SET student_code=?, name_km=?, name_latin=?, gender=?, email=?, phone=?, notes=?, custom=? WHERE id=?',
        str(b.code ?? s.student_code, 'Student ID'), b.nameKm === undefined ? s.name_km : b.nameKm || null, b.nameLatin === undefined ? s.name_latin : b.nameLatin || null,
        b.gender === undefined ? s.gender : b.gender || null, b.email === undefined ? s.email : b.email || null, b.phone === undefined ? s.phone : b.phone || null,
        b.notes === undefined ? s.notes : b.notes || null, b.custom === undefined ? s.custom : JSON.stringify(b.custom), s.id);
      db.audit(u.id, 'student', s.id, 'update', s, b);
    });
  });
  get('/classes/:id/roster', (req, db, u) => {
    const c = ownClass(db, u, num(req.params.id, 'class'));
    return db.all(`SELECT e.id AS enrollment_id, e.status, e.enrolled_on, e.ended_on, e.note, s.* FROM enrollments e JOIN students s ON s.id = e.student_id WHERE e.class_id = ? ORDER BY CASE e.status WHEN 'active' THEN 0 ELSE 1 END, s.student_code`, c.id);
  });
  post('/classes/:id/enroll', (req, db, u) => {
    const c = ownClass(db, u, num(req.params.id, 'class'));
    const ids = list(req.body.studentIds, 'Students', 500).map((x) => num(x, 'student'));
    return db.tx(() => {
      for (const sid of ids) { ownStudent(db, u, sid); db.run('INSERT INTO enrollments (student_id, class_id, enrolled_on) VALUES (?,?,?)', sid, c.id, today(db, u)); }
      db.audit(u.id, 'class', c.id, 'enroll', undefined, ids);
      return { enrolled: ids.length };
    });
  });
  post('/enrollments/:id/transfer', (req, db, u) => roster.transferEnrollment(db, u, num(req.params.id, 'enrollment'), num(req.body.toClassId, 'class'), req.body.note));
  post('/enrollments/:id/status', (req, db, u) => roster.setEnrollmentStatus(db, u, num(req.params.id, 'enrollment'), String(req.body.status), req.body.note));
  r.post('/import/parse', express.raw({ type: '*/*', limit: '10mb' }), wrap(async (req) => roster.parseSpreadsheet(req.body as Buffer, String(req.query.filename ?? ''))));
  post('/classes/:id/import/validate', (req, db, u) => ({ issues: roster.validateImport(db, u, num(req.params.id, 'class'), list(req.body.rows, 'Rows')) }));
  post('/classes/:id/import/commit', (req, db, u) => roster.commitImport(db, u, num(req.params.id, 'class'), list(req.body.rows, 'Rows')));

  // ---- Gradebook & attendance --------------------------------------------------------------
  get('/classes/:id/gradebook', (req, db, u) => records.gradebook(db, u, num(req.params.id, 'class')));
  put('/classes/:id/grade-config', (req, db, u) => records.saveConfig(db, u, num(req.params.id, 'class'), req.body));
  post('/classes/:id/grade-config/status', (req, db, u) => records.setConfigStatus(db, u, num(req.params.id, 'class'), req.body.status));
  get('/sessions/:id/attendance', (req, db, u) => records.sessionAttendance(db, u, num(req.params.id, 'session')));
  get('/classes/:id/attendance', (req, db, u) => {
    const p = readPage(req.query, 50);
    const r = records.attendanceSummary(db, u, num(req.params.id, 'class'), { offset: p.offset, pageSize: p.pageSize, q: String(req.query.q ?? '') });
    return { ...r, page: p.page, pageSize: p.pageSize, pages: Math.max(1, Math.ceil(r.total / p.pageSize)) };
  });
  get('/audit', (req, db, u) => {
    const p = readPage(req.query, 25);
    const entity = String(req.query.entity ?? '');
    const where = `${u.role === 'admin' ? '1' : 'a.user_id = ?'} ${entity ? 'AND a.entity = ?' : ''}`;
    const params = [...(u.role === 'admin' ? [] : [u.id]), ...(entity ? [entity] : [])];
    const total = (db.get(`SELECT COUNT(*) AS n FROM audit_log a WHERE ${where}`, ...params) as Row).n;
    const items = db.all(`SELECT a.id, a.entity, a.entity_id, a.action, a.at, u.name AS user_name FROM audit_log a LEFT JOIN users u ON u.id = a.user_id WHERE ${where} ORDER BY a.id DESC LIMIT ? OFFSET ?`, ...params, p.pageSize, p.offset);
    return paged(items, total, p);
  });
  post('/sync', (req, db, u) => ({ results: records.applySync(db, u, req.body.ops) }));

  // ---- Dashboard & pay ---------------------------------------------------------------------
  get('/dashboard', (_req, db, u) => reports.dashboard(db, u));

  // ---- Reconciliation (review first, then apply) --------------------------------------------
  get('/reconcile/sessions', (_req, db, u) => reconcile.unrecordedSessions(db, u));
  post('/reconcile/sessions', (req, db, u) => reconcile.reconcileSessions(db, u, req.body.decisions, req.query.dryRun === '1'));
  post('/students/id-match', (req, db, u) => reconcile.matchStudentIds(db, u, list(req.body.rows, 'Rows', 5000)));
  post('/students/id-apply', (req, db, u) => reconcile.applyStudentIds(db, u, list(req.body.assignments, 'Changes', 5000)));
  get('/classes/:id/attendance-migration', (req, db, u) => reconcile.attendancePreview(db, u, num(req.params.id, 'class')));
  post('/classes/:id/attendance-migration', (req, db, u) => reconcile.switchToCalculated(db, u, num(req.params.id, 'class'), req.body.enrollmentIds, req.body.confirm === true));
  post('/classes/:id/attendance-migration/restore', (req, db, u) => reconcile.restoreManual(db, u, num(req.params.id, 'class')));
  get('/backup/status', (_req, _db, u) => {
    if (u.role !== 'admin') throw new AppError(403, 'Only an administrator can see backup status.');
    return backupStatus();
  });
  get('/pay', (req, db, u) => pay.payOverview(db, u, String(req.query.year ?? today(db, u).slice(0, 4))));
  get('/pay/lines', (req, db, u) => {
    const p = readPage(req.query, 25);
    const month = String(req.query.month ?? '');
    const year = String(req.query.year ?? today(db, u).slice(0, 4));
    if (month && !/^\d{4}-(0[1-9]|1[0-2])$/.test(month)) throw new AppError(400, 'month must be YYYY-MM.');
    if (!/^\d{4}$/.test(year)) throw new AppError(400, 'year must be four digits.');
    const lines = month ? pay.payLines(db, u, `${month}-01`, `${month}-31`) : pay.payLines(db, u, `${year}-01-01`, `${year}-12-31`);
    return pageArray(lines.reverse(), p);
  });
  post('/pay/statements', (req, db, u) => pay.approveMonth(db, u, String(req.body.month ?? ''), req.body.note));
  get('/pay/statements/:id', (req, db, u) => pay.statementDetail(db, u, num(req.params.id, 'statement')));
  post('/pay/statements/:id/paid', (req, db, u) => pay.markPaid(db, u, num(req.params.id, 'statement'), req.body));
  del('/pay/statements/:id', (req, db, u) => pay.unapprove(db, u, num(req.params.id, 'statement')));
  post('/rates', (req, db, u) => {
    const r = pay.validateRate(db, u, req.body);
    const id = db.run('INSERT INTO rates (owner_id, class_id, course_id, mode, amount, currency, effective_from) VALUES (?,?,?,?,?,?,?)', u.id, r.classId, r.courseId, r.mode, r.amount, r.currency, r.effectiveFrom).id;
    db.audit(u.id, 'rate', id, 'create', undefined, r);
    return { id };
  });
  put('/rates/:id', (req, db, u) => {
    const old = db.get('SELECT * FROM rates WHERE id = ? AND owner_id = ?', num(req.params.id, 'rate'), u.id);
    if (!old) throw new AppError(404, 'Rate not found.');
    const merged = { mode: old.mode, amount: old.amount, effectiveFrom: old.effective_from, classId: old.class_id, courseId: old.course_id, currency: old.currency, ...req.body };
    const r = pay.validateRate(db, u, merged);
    const active = req.body.active === undefined ? old.active : req.body.active ? 1 : 0;
    db.tx(() => {
      db.run('UPDATE rates SET class_id=?, course_id=?, mode=?, amount=?, currency=?, effective_from=?, active=? WHERE id=?', r.classId, r.courseId, r.mode, r.amount, r.currency, r.effectiveFrom, active, old.id);
      db.audit(u.id, 'rate', old.id, 'update', old, { ...r, active });
    });
  });
  del('/rates/:id', (req, db, u) => {
    const old = db.get('SELECT * FROM rates WHERE id = ? AND owner_id = ?', num(req.params.id, 'rate'), u.id);
    if (!old) throw new AppError(404, 'Rate not found.');
    db.tx(() => { db.run('DELETE FROM rates WHERE id = ?', old.id); db.audit(u.id, 'rate', old.id, 'delete', old); });
  });
  post('/pay/adjustments', (req, db, u) => {
    const a = pay.validateAdjustment(req.body);
    const id = db.run('INSERT INTO pay_adjustments (owner_id, month, amount, note) VALUES (?,?,?,?)', u.id, a.month, a.amount, a.note).id;
    db.audit(u.id, 'pay_adjustment', id, 'create', undefined, a);
    return { id };
  });
  put('/pay/adjustments/:id', (req, db, u) => {
    const old = db.get('SELECT * FROM pay_adjustments WHERE id = ? AND owner_id = ?', num(req.params.id, 'adjustment'), u.id);
    if (!old) throw new AppError(404, 'Adjustment not found.');
    const a = pay.validateAdjustment({ month: old.month, amount: old.amount, note: old.note, ...req.body });
    db.tx(() => { db.run('UPDATE pay_adjustments SET month=?, amount=?, note=? WHERE id=?', a.month, a.amount, a.note, old.id); db.audit(u.id, 'pay_adjustment', old.id, 'update', old, a); });
  });
  del('/pay/adjustments/:id', (req, db, u) => {
    const old = db.get('SELECT * FROM pay_adjustments WHERE id = ? AND owner_id = ?', num(req.params.id, 'adjustment'), u.id);
    if (!old) throw new AppError(404, 'Adjustment not found.');
    db.tx(() => { db.run('DELETE FROM pay_adjustments WHERE id = ?', old.id); db.audit(u.id, 'pay_adjustment', old.id, 'delete', old); });
  });

  // ---- Exports, backup and restore ---------------------------------------------------------
  const sendXlsx = (res: Response, name: string, buf: Buffer) => {
    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    res.setHeader('Content-Disposition', `attachment; filename="${name}"`);
    res.end(buf);
  };
  const stamp = () => new Date().toISOString().slice(0, 10);
  const codeOf = (db: DB, id: number) => String(db.get('SELECT code FROM classes WHERE id = ?', id)?.code ?? id).replace(/[^\w-]/g, '_');
  get('/export/gradebook/:id', async (req, db, u, res) => { const id = num(req.params.id, 'class'); sendXlsx(res, `gradebook-${codeOf(db, id)}-${stamp()}.xlsx`, await exportsSvc.gradebookXlsx(db, u, id)); });
  get('/export/plan/:id', async (req, db, u, res) => { const id = num(req.params.id, 'class'); sendXlsx(res, `term-plan-${codeOf(db, id)}-${stamp()}.xlsx`, await exportsSvc.termPlanXlsx(db, u, id)); });
  get('/export/roster/:id', async (req, db, u, res) => { const id = num(req.params.id, 'class'); sendXlsx(res, `students-${codeOf(db, id)}-${stamp()}.xlsx`, await exportsSvc.rosterXlsx(db, u, id)); });
  get('/export/attendance/:id', async (req, db, u, res) => { const id = num(req.params.id, 'class'); sendXlsx(res, `attendance-${codeOf(db, id)}-${stamp()}.xlsx`, await exportsSvc.attendanceXlsx(db, u, id)); });
  get('/export/pay/:year', async (req, db, u, res) => sendXlsx(res, `teaching-pay-${req.params.year}.xlsx`, await exportsSvc.payXlsx(db, u, String(req.params.year))));

  const requireAdmin = (u: User) => { if (u.role !== 'admin') throw new AppError(403, 'Only an administrator can back up or restore the whole system.'); };
  get('/backup.json', (_req, db, u, res) => {
    requireAdmin(u);
    res.setHeader('Content-Disposition', `attachment; filename="krubook-backup-${stamp()}.json"`);
    res.json(backup.exportBackup(db));
  });
  get('/backup.xlsx', async (_req, db, u, res) => { requireAdmin(u); sendXlsx(res, `krubook-backup-${stamp()}.xlsx`, await backup.exportBackupXlsx(db)); });
  r.post('/restore', wrap((req, db, u) => {
    requireAdmin(u);
    if (req.query.dryRun === '1') {
      const { db: mem, counts } = backup.loadBackup(req.body);
      mem.close();
      return { valid: true, counts };
    }
    if (holder.file === ':memory:') throw new AppError(400, 'Restore needs a file-backed database.');
    try {
      const out = backup.restoreToFile(req.body, holder.file, () => db.close());
      holder.reopen();
      return { restored: true, ...out };
    } catch (e) {
      try { holder.reopen(); } catch { /* reported below */ }
      throw e;
    }
  }));

  return r;
}
