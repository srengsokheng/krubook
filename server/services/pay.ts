import { AppError, type DB, type Row } from '../db.ts';
import type { User } from '../auth.ts';
import { ownClass, ownCourse, today } from './access.ts';
import { durationMinutes, isISODate, monthOf } from '../../shared/dates.ts';
import { resolveRate, sessionPay, type Rate } from '../../shared/pay.ts';

// Pay is personal: it always covers the signed-in teacher's own classes, even for admins.
//
// Lifecycle of a month:
//   estimated  taught sessions (with a teaching record) priced with the current rates
//   approved   a statement freezes those sessions, minutes, rates and amounts
//   paid       the statement is marked paid; it can no longer be undone
// Cancelled sessions and sessions without a teaching record are never payable. Make-up sessions
// are payable like any other taught session. Each session can be on one statement only.

const r2 = (n: number) => Math.round(n * 100) / 100;
const MONTH_RE = /^\d{4}-(0[1-9]|1[0-2])$/;

export function loadRates(db: DB, ownerId: number, includeInactive = false): Array<Rate & { currency: string; active: boolean }> {
  return db.all(`SELECT * FROM rates WHERE owner_id = ? ${includeInactive ? '' : 'AND active = 1'} ORDER BY effective_from, id`, ownerId).map((r) => ({
    id: r.id, classId: r.class_id, courseId: r.course_id, mode: r.mode, amount: r.amount, effectiveFrom: r.effective_from, currency: r.currency, active: !!r.active,
  }));
}

export interface PayLine {
  sessionId: number;
  date: string;
  start: string;
  classId: number;
  code: string;
  courseName: string;
  minutes: number;
  isMakeup: boolean;
  rate: string | null;
  amount: number;
  statementId: number | null;
  statementStatus: 'approved' | 'paid' | null;
}

const rateLabel = (mode: string | null, amount: number | null) => (mode == null || amount == null ? null : mode === 'hourly' ? `${amount}/h` : `${amount}/session`);

/** Taught sessions in a period, priced from their statement if approved, else with current rates. */
export function payLines(db: DB, u: User, from: string, to: string): PayLine[] {
  const rates = loadRates(db, u.id);
  const rows = db.all(
    `SELECT s.id, s.class_id, s.date, s.start_time, s.is_makeup, c.code, c.course_id, co.name AS course_name, r.minutes,
            l.statement_id, l.minutes AS line_minutes, l.rate_mode, l.rate_amount, l.amount AS line_amount, ps.status AS statement_status
       FROM teaching_records r
       JOIN sessions s ON s.id = r.session_id
       JOIN classes c ON c.id = s.class_id
       JOIN courses co ON co.id = c.course_id
       LEFT JOIN pay_statement_lines l ON l.session_id = s.id
       LEFT JOIN pay_statements ps ON ps.id = l.statement_id
      WHERE c.teacher_id = ? AND s.status = 'completed' AND s.date BETWEEN ? AND ?
      ORDER BY s.date, s.start_time, s.id`,
    u.id, from, to,
  );
  return rows.map((x) => {
    if (x.statement_id) {
      return { sessionId: x.id, date: x.date, start: x.start_time, classId: x.class_id, code: x.code, courseName: x.course_name, minutes: x.line_minutes, isMakeup: !!x.is_makeup, rate: rateLabel(x.rate_mode, x.rate_amount), amount: x.line_amount, statementId: x.statement_id, statementStatus: x.statement_status };
    }
    const rate = resolveRate(rates, { classId: x.class_id, courseId: x.course_id, date: x.date });
    return { sessionId: x.id, date: x.date, start: x.start_time, classId: x.class_id, code: x.code, courseName: x.course_name, minutes: x.minutes, isMakeup: !!x.is_makeup, rate: rate ? rateLabel(rate.mode, rate.amount) : null, amount: sessionPay(rate, x.minutes), statementId: null, statementStatus: null };
  });
}

export interface MonthSummary {
  month: string;
  taughtSessions: number;
  taughtMinutes: number;
  makeupSessions: number;
  unratedSessions: number;
  estimated: number;      // not yet on any statement (sessions + loose adjustments)
  approved: number;       // on approved statements, not yet paid
  paid: number;           // amount actually recorded as paid
  total: number;          // estimated + approved + paid-statement totals
  expected: number;       // planned future sessions, if they run
  plannedSessions: number;
}

export function payOverview(db: DB, u: User, year: string) {
  if (!/^\d{4}$/.test(year)) throw new AppError(422, 'Year must be four digits.');
  const now = today(db, u);
  const from = `${year}-01-01`, to = `${year}-12-31`;
  const lines = payLines(db, u, from, to);
  const rates = loadRates(db, u.id);
  const months = new Map<string, MonthSummary>();
  const get = (m: string) => {
    if (!months.has(m)) months.set(m, { month: m, taughtSessions: 0, taughtMinutes: 0, makeupSessions: 0, unratedSessions: 0, estimated: 0, approved: 0, paid: 0, total: 0, expected: 0, plannedSessions: 0 });
    return months.get(m)!;
  };
  for (const l of lines) {
    const m = get(monthOf(l.date));
    m.taughtSessions++;
    m.taughtMinutes += l.minutes;
    if (l.isMakeup) m.makeupSessions++;
    if (l.rate == null) m.unratedSessions++;
    if (!l.statementId) m.estimated += l.amount;
  }
  const adjustments = db.all('SELECT * FROM pay_adjustments WHERE owner_id = ? AND substr(month, 1, 4) = ? ORDER BY month, id', u.id, year);
  for (const a of adjustments) if (!a.statement_id) get(a.month).estimated += a.amount;
  const statements = db.all('SELECT * FROM pay_statements WHERE owner_id = ? AND substr(month, 1, 4) = ? ORDER BY month, id', u.id, year);
  for (const s of statements) {
    const m = get(s.month);
    if (s.status === 'paid') m.paid += s.paid_amount ?? s.total;
    else m.approved += s.total;
    m.total += s.total;
  }
  // Planned sessions still ahead: shown as "expected", never as earned.
  const planned = db.all(
    `SELECT s.date, s.start_time, s.end_time, s.class_id, c.course_id FROM sessions s JOIN classes c ON c.id = s.class_id
      WHERE c.teacher_id = ? AND s.status = 'planned' AND s.date >= ? AND s.date BETWEEN ? AND ?`,
    u.id, now, from, to,
  );
  for (const p of planned) {
    const m = get(monthOf(p.date));
    m.plannedSessions++;
    m.expected += sessionPay(resolveRate(rates, { classId: p.class_id, courseId: p.course_id, date: p.date }), durationMinutes(p.start_time, p.end_time));
  }
  const unrecorded = (db.get(
    `SELECT COUNT(*) AS n FROM sessions s JOIN classes c ON c.id = s.class_id WHERE c.teacher_id = ? AND s.status = 'planned' AND s.date < ? AND s.date BETWEEN ? AND ?`,
    u.id, now, from, to,
  ) as Row).n;
  const list = [...months.values()].map((m) => ({ ...m, estimated: r2(m.estimated), approved: r2(m.approved), paid: r2(m.paid), expected: r2(m.expected), total: r2(m.total + m.estimated) })).sort((a, b) => a.month.localeCompare(b.month));
  const sum = (k: keyof MonthSummary) => r2(list.reduce((s, m) => s + (m[k] as number), 0));
  return {
    year,
    currency: rates[0]?.currency ?? 'USD',
    months: list,
    totals: { taughtSessions: sum('taughtSessions'), taughtMinutes: sum('taughtMinutes'), estimated: sum('estimated'), approved: sum('approved'), paid: sum('paid'), total: sum('total'), expected: sum('expected') },
    statements: statements.map(statementOut),
    rates: loadRates(db, u.id, true),
    adjustments: adjustments.map((a) => ({ id: a.id, month: a.month, amount: a.amount, note: a.note, locked: !!a.statement_id })),
    unrecorded,
    unrated: list.reduce((s, m) => s + m.unratedSessions, 0),
  };
}

const statementOut = (s: Row) => ({ id: s.id, month: s.month, status: s.status, sessions: s.sessions, minutes: s.minutes, earned: s.earned, adjustments: s.adjustments, total: s.total, approvedAt: s.approved_at, paidOn: s.paid_on, paidAmount: s.paid_amount, note: s.note, currency: s.currency });

// ---------------------------------------------------------------------------------------------
// Statements

/** Freezes every taught, not-yet-approved session (and loose adjustment) of a month. */
export function approveMonth(db: DB, u: User, month: string, note?: string) {
  if (!MONTH_RE.test(month)) throw new AppError(422, 'Choose a month as YYYY-MM.');
  if (month > monthOf(today(db, u))) throw new AppError(422, 'A month can only be approved once it has started.');
  return db.tx(() => {
    const lines = payLines(db, u, `${month}-01`, `${month}-31`).filter((l) => !l.statementId);
    const adjustments = db.all('SELECT * FROM pay_adjustments WHERE owner_id = ? AND month = ? AND statement_id IS NULL', u.id, month);
    if (!lines.length && !adjustments.length) throw new AppError(409, 'Nothing new to approve for this month: every taught session is already on a statement.');
    const unrated = lines.filter((l) => l.rate == null);
    if (unrated.length) throw new AppError(422, `${unrated.length} taught session(s) have no pay rate. Add a rate first.`, { sessions: unrated.map((l) => l.sessionId) });
    const earned = r2(lines.reduce((s, l) => s + l.amount, 0));
    const adj = r2(adjustments.reduce((s, a) => s + a.amount, 0));
    const currency = loadRates(db, u.id)[0]?.currency ?? 'USD';
    const id = db.run(
      'INSERT INTO pay_statements (owner_id, month, currency, sessions, minutes, earned, adjustments, total, note) VALUES (?,?,?,?,?,?,?,?,?)',
      u.id, month, currency, lines.length, lines.reduce((s, l) => s + l.minutes, 0), earned, adj, r2(earned + adj), note?.trim() || null,
    ).id;
    const rates = loadRates(db, u.id);
    for (const l of lines) {
      const s = db.get('SELECT s.class_id, c.course_id FROM sessions s JOIN classes c ON c.id = s.class_id WHERE s.id = ?', l.sessionId)!;
      const rate = resolveRate(rates, { classId: s.class_id, courseId: s.course_id, date: l.date })!;
      db.run('INSERT INTO pay_statement_lines (statement_id, session_id, minutes, rate_mode, rate_amount, amount) VALUES (?,?,?,?,?,?)', id, l.sessionId, l.minutes, rate.mode, rate.amount, l.amount);
    }
    for (const a of adjustments) db.run('UPDATE pay_adjustments SET statement_id = ? WHERE id = ?', id, a.id);
    db.audit(u.id, 'pay_statement', id, 'approve', undefined, { month, sessions: lines.length, total: r2(earned + adj) });
    return statementOut(db.get('SELECT * FROM pay_statements WHERE id = ?', id)!);
  });
}

function ownStatement(db: DB, u: User, id: number): Row {
  const s = db.get('SELECT * FROM pay_statements WHERE id = ? AND owner_id = ?', id, u.id);
  if (!s) throw new AppError(404, 'Pay statement not found.');
  return s;
}

export function markPaid(db: DB, u: User, id: number, body: { paidOn?: string; amount?: number; note?: string }) {
  const s = ownStatement(db, u, id);
  if (s.status === 'paid') throw new AppError(409, 'This statement is already marked paid.');
  const paidOn = body.paidOn || today(db, u);
  if (!isISODate(paidOn)) throw new AppError(422, 'Choose a valid payment date.');
  const amount = body.amount === undefined || body.amount === null || (body.amount as any) === '' ? s.total : Number(body.amount);
  if (!Number.isFinite(amount) || amount < 0) throw new AppError(422, 'The amount paid must be 0 or more.');
  db.tx(() => {
    db.run("UPDATE pay_statements SET status = 'paid', paid_on = ?, paid_amount = ?, note = COALESCE(?, note) WHERE id = ?", paidOn, r2(amount), body.note?.trim() || null, id);
    db.audit(u.id, 'pay_statement', id, 'paid', { status: s.status }, { paidOn, amount: r2(amount) });
  });
  return statementOut(db.get('SELECT * FROM pay_statements WHERE id = ?', id)!);
}

/** Undoes an approval that has not been paid; its sessions become estimates again. */
export function unapprove(db: DB, u: User, id: number) {
  const s = ownStatement(db, u, id);
  if (s.status === 'paid') throw new AppError(409, 'A paid statement cannot be undone.');
  db.tx(() => {
    db.run('UPDATE pay_adjustments SET statement_id = NULL WHERE statement_id = ?', id);
    db.run('DELETE FROM pay_statements WHERE id = ?', id);
    db.audit(u.id, 'pay_statement', id, 'unapprove', s, undefined);
  });
}

export function statementDetail(db: DB, u: User, id: number) {
  const s = ownStatement(db, u, id);
  const lines = db.all(
    `SELECT l.*, s.date, s.start_time, c.code FROM pay_statement_lines l JOIN sessions s ON s.id = l.session_id JOIN classes c ON c.id = s.class_id
      WHERE l.statement_id = ? ORDER BY s.date, s.start_time`, id,
  );
  return { ...statementOut(s), lines: lines.map((l) => ({ sessionId: l.session_id, date: l.date, start: l.start_time, code: l.code, minutes: l.minutes, rate: rateLabel(l.rate_mode, l.rate_amount), amount: l.amount })), adjustments: db.all('SELECT id, amount, note FROM pay_adjustments WHERE statement_id = ?', id) };
}

// ---------------------------------------------------------------------------------------------
// Rates and adjustments

export function validateRate(db: DB, u: User, b: Row) {
  const mode = b.mode === 'per_session' ? 'per_session' : b.mode === 'hourly' ? 'hourly' : null;
  if (!mode) throw new AppError(422, 'Choose hourly or per-session.');
  const amount = Number(b.amount);
  if (b.amount === '' || b.amount == null || !Number.isFinite(amount) || amount < 0) throw new AppError(422, 'The rate must be a number of 0 or more.');
  if (!isISODate(b.effectiveFrom)) throw new AppError(422, 'Choose the date the rate starts.');
  const classId = b.classId ? Number(b.classId) : null, courseId = b.courseId ? Number(b.courseId) : null;
  if (classId && courseId) throw new AppError(422, 'A rate applies to a class or a course, not both.');
  if (classId) ownClass(db, u, classId);
  if (courseId) ownCourse(db, u, courseId);
  const currency = String(b.currency || 'USD').toUpperCase();
  if (!/^[A-Z]{3}$/.test(currency)) throw new AppError(422, 'Currency must be a 3-letter code such as USD or KHR.');
  return { mode, amount: r2(amount), effectiveFrom: b.effectiveFrom as string, classId, courseId, currency };
}

export function validateAdjustment(b: Row) {
  const month = String(b.month ?? '');
  if (!MONTH_RE.test(month)) throw new AppError(422, 'Choose a month.');
  const amount = Number(b.amount);
  if (b.amount === '' || b.amount == null || !Number.isFinite(amount) || amount === 0) throw new AppError(422, 'Enter an amount other than 0 (negative to deduct).');
  const note = String(b.note ?? '').trim();
  if (!note) throw new AppError(422, 'Explain the adjustment in the note.');
  return { month, amount: r2(amount), note };
}
