import { AppError, type DB, type Row } from '../db.ts';
import type { User } from '../auth.ts';
import { getSetting, ownClass, ownCourse, payStartDay, today } from './access.ts';
import { diffDays, durationMinutes, isISODate } from '../../shared/dates.ts';

const durationDays = (from: string, to: string) => diffDays(to, from);
import { lateDeduction, lateMinutes, parseLateRule, payMonthOf, payPeriod, resolveRate, sessionPay, type LateRule, type Rate } from '../../shared/pay.ts';

// Pay is personal: it always covers the signed-in teacher's own classes, even for admins.
//
// Pay months follow the teacher's pay period (default 16th of last month to 15th of this month; see
// payPeriod in shared/pay.ts), not calendar months.
//
// Lifecycle of a month:
//   estimated  taught sessions (with a teaching record) priced with the current rates
//   approved   a statement freezes those sessions, minutes, rates and amounts
//   paid       the statement is marked paid; it can no longer be undone
// Cancelled sessions and sessions without a teaching record are never payable. Make-up sessions
// are payable like any other taught session. Each session can be on one statement only.
// A session counts as worked once it is recorded as taught or the teacher checked in to it (on or
// before today). A check-in after the scheduled start is late; the late rule (Pay › Rates) sets
// what share of that session's pay is cut. Approved statements keep the lateness and cut they
// were approved with.
//
// Each month also shows what it is worth if everything scheduled runs: every session in the pay
// period that is not cancelled, at full rate and scheduled length.
//
// Holidays: a session on one of the teacher's holidays is never paid or expected, even if it was
// recorded as taught (e.g. imported from the old workbook before the holiday was entered), unless
// it is marked as taught on a holiday (holiday_exception) or has a check-in. Approved statements
// keep what they were approved with.

const r2 = (n: number) => Math.round(n * 100) / 100;
const MONTH_RE = /^\d{4}-(0[1-9]|1[0-2])$/;

export function loadRates(db: DB, ownerId: number, includeInactive = false): Array<Rate & { currency: string; active: boolean }> {
  return db.all(`SELECT * FROM rates WHERE owner_id = ? ${includeInactive ? '' : 'AND active = 1'} ORDER BY effective_from, id`, ownerId).map((r) => ({
    id: r.id, classId: r.class_id, courseId: r.course_id, mode: r.mode, amount: r.amount, effectiveFrom: r.effective_from, currency: r.currency, active: !!r.active,
  }));
}

export interface HolidaySpan { from: string; to: string; name: string; termId: number | null }
export function loadHolidays(db: DB, ownerId: number): HolidaySpan[] {
  return db.all('SELECT date, COALESCE(end_date, date) AS end_date, name, term_id FROM holidays WHERE owner_id = ?', ownerId)
    .map((h) => ({ from: h.date, to: h.end_date, name: h.name, termId: h.term_id }));
}
/** The holiday a session's date falls on (for its class's term), if any. */
export function holidayOn(hs: HolidaySpan[], date: string, termId: number | null): HolidaySpan | null {
  return hs.find((h) => date >= h.from && date <= h.to && (h.termId == null || h.termId === termId)) ?? null;
}
/** True when a session on a holiday is not paid: not marked as taught on a holiday and no check-in. */
export const unpaidHoliday = (hs: HolidaySpan[], s: Row) =>
  !s.holiday_exception && !s.checkin && !!holidayOn(hs, s.date, s.term_id);

export function loadLateRule(db: DB, ownerId: number): LateRule {
  return parseLateRule(getSetting(db, ownerId, 'pay.lateRule', ''));
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
  recorded: boolean;      // has a teaching record (otherwise counted from the check-in alone)
  checkin: string | null; // HH:MM the teacher checked in, if they did
  late: number;           // minutes after the scheduled start
  deduction: number;      // taken off for arriving late (already subtracted from amount)
  amount: number;
  statementId: number | null;
  statementStatus: 'approved' | 'paid' | null;
}

const rateLabel = (mode: string | null, amount: number | null) => (mode == null || amount == null ? null : mode === 'hourly' ? `${amount}/h` : `${amount}/session`);

/** Worked sessions in a period, priced from their statement if approved, else with current rates. */
export function payLines(db: DB, u: User, from: string, to: string): PayLine[] {
  const rates = loadRates(db, u.id);
  const rule = loadLateRule(db, u.id);
  const rows = db.all(
    `SELECT s.id, s.class_id, s.date, s.start_time, s.end_time, s.is_makeup, s.holiday_exception, c.code, c.course_id, c.term_id, co.name AS course_name, r.id AS record_id, r.minutes, k.time AS checkin,
            l.statement_id, l.minutes AS line_minutes, l.rate_mode, l.rate_amount, l.amount AS line_amount, l.late_minutes, l.deduction AS line_deduction, ps.status AS statement_status
       FROM sessions s
       JOIN classes c ON c.id = s.class_id
       JOIN courses co ON co.id = c.course_id
       LEFT JOIN teaching_records r ON r.session_id = s.id
       LEFT JOIN checkins k ON k.session_id = s.id
       LEFT JOIN pay_statement_lines l ON l.session_id = s.id
       LEFT JOIN pay_statements ps ON ps.id = l.statement_id
      WHERE c.teacher_id = ? AND s.date BETWEEN ? AND ?
        AND ((r.id IS NOT NULL AND s.status = 'completed') OR (k.id IS NOT NULL AND s.status IN ('planned','completed') AND s.date <= ?) OR l.id IS NOT NULL)
      ORDER BY s.date, s.start_time, s.id`,
    u.id, from, to, today(db, u),
  );
  const hs = loadHolidays(db, u.id);
  return rows.filter((x) => x.statement_id || !unpaidHoliday(hs, x)).map((x) => {
    if (x.statement_id) {
      return { sessionId: x.id, date: x.date, start: x.start_time, classId: x.class_id, code: x.code, courseName: x.course_name, minutes: x.line_minutes, isMakeup: !!x.is_makeup, rate: rateLabel(x.rate_mode, x.rate_amount), recorded: x.record_id != null, checkin: x.checkin, late: x.late_minutes, deduction: x.line_deduction, amount: x.line_amount, statementId: x.statement_id, statementStatus: x.statement_status };
    }
    const rate = resolveRate(rates, { classId: x.class_id, courseId: x.course_id, date: x.date });
    const minutes = x.minutes ?? durationMinutes(x.start_time, x.end_time);
    const late = lateMinutes(x.start_time, x.checkin);
    const pay = sessionPay(rate, minutes);
    const cut = lateDeduction(pay, late, rule);
    return { sessionId: x.id, date: x.date, start: x.start_time, classId: x.class_id, code: x.code, courseName: x.course_name, minutes, isMakeup: !!x.is_makeup, rate: rate ? rateLabel(rate.mode, rate.amount) : null, recorded: x.record_id != null, checkin: x.checkin, late, deduction: cut.amount, amount: r2(pay - cut.amount), statementId: null, statementStatus: null };
  });
}

export interface MonthSummary {
  month: string;
  from: string;           // first teaching date counted in this pay month
  to: string;             // last teaching date counted
  taughtSessions: number;
  taughtMinutes: number;
  makeupSessions: number;
  unratedSessions: number;
  lateSessions: number;   // taught sessions checked in after the scheduled start
  deductions: number;     // taken off for late arrivals
  estimated: number;      // not yet on any statement (sessions + loose adjustments)
  approved: number;       // on approved statements, not yet paid
  paid: number;           // amount actually recorded as paid
  total: number;          // estimated + approved + paid-statement totals
  expected: number;       // planned future sessions, if they run
  plannedSessions: number;
  scheduledSessions: number; // every session in the period that is not cancelled
  scheduledMinutes: number;
  scheduledPay: number;      // those sessions at full rate and scheduled length
  adjustments: number;       // the month's adjustments (approved or not)
  expectedTotal: number;     // scheduledPay + adjustments
  holidayPay: number;        // full pay of classes lost to holidays
  breakdown?: Breakdown;
}

// Where a month's money goes: the full timetable at full rate, minus classes lost to holidays (by
// holiday), other cancelled classes, late cuts, classes not recorded yet and classes still to come,
// plus adjustments. Whatever is left over (minutes recorded shorter than scheduled, amounts frozen
// on an approved statement) is "other", so the steps always add up to Actual.
export interface Breakdown {
  timetable: { sessions: number; minutes: number; pay: number };
  holidays: Array<{ name: string; sessions: number; minutes: number; pay: number }>;
  cancelled: { sessions: number; pay: number };
  lateCuts: { sessions: number; pay: number };
  notRecorded: { sessions: number; pay: number };
  toGo: { sessions: number; pay: number };
  adjustments: number;
  other: number;
  actual: number;
}

function newBreakdown(): Breakdown {
  return { timetable: { sessions: 0, minutes: 0, pay: 0 }, holidays: [], cancelled: { sessions: 0, pay: 0 }, lateCuts: { sessions: 0, pay: 0 }, notRecorded: { sessions: 0, pay: 0 }, toGo: { sessions: 0, pay: 0 }, adjustments: 0, other: 0, actual: 0 };
}

/** Breakdowns per key (pay month) for the sessions dated from..to; `lines` are payLines for the same span. */
function breakdowns(db: DB, u: User, from: string, to: string, lines: PayLine[], keyOf: (date: string) => string): Map<string, Breakdown> {
  const now = today(db, u);
  const rates = loadRates(db, u.id);
  const hs = loadHolidays(db, u.id);
  const worked = new Map(lines.map((l) => [l.sessionId, l]));
  const rows = db.all(
    `SELECT s.id, s.date, s.start_time, s.end_time, s.status, s.note, s.holiday_exception, s.class_id, c.course_id, c.term_id, k.time AS checkin
       FROM sessions s JOIN classes c ON c.id = s.class_id LEFT JOIN checkins k ON k.session_id = s.id
      WHERE c.teacher_id = ? AND s.status <> 'moved' AND s.date BETWEEN ? AND ?`,
    u.id, from, to,
  );
  const out = new Map<string, Breakdown>();
  const get = (k: string) => { if (!out.has(k)) out.set(k, newBreakdown()); return out.get(k)!; };
  for (const s of rows) {
    const b = get(keyOf(s.date));
    const minutes = durationMinutes(s.start_time, s.end_time);
    const full = sessionPay(resolveRate(rates, { classId: s.class_id, courseId: s.course_id, date: s.date }), minutes);
    b.timetable.sessions++; b.timetable.minutes += minutes; b.timetable.pay += full;
    const l = worked.get(s.id);
    if (l) { if (l.deduction > 0) { b.lateCuts.sessions++; b.lateCuts.pay += l.deduction; } continue; }
    const held = s.status === 'planned' || s.status === 'completed';
    const holidayName = held
      ? (unpaidHoliday(hs, s) ? holidayOn(hs, s.date, s.term_id)?.name : null)
      : /^Holiday:/.test(s.note ?? '') && holidayOn(hs, s.date, s.term_id) ? String(s.note).replace(/^Holiday:\s*/, '') : null;
    if (holidayName) {
      let h = b.holidays.find((x) => x.name === holidayName);
      if (!h) b.holidays.push((h = { name: holidayName, sessions: 0, minutes: 0, pay: 0 }));
      h.sessions++; h.minutes += minutes; h.pay += full;
    } else if (!held) { b.cancelled.sessions++; b.cancelled.pay += full; }
    else if (s.date >= now) { b.toGo.sessions++; b.toGo.pay += full; }
    else { b.notRecorded.sessions++; b.notRecorded.pay += full; }
  }
  return out;
}

/** Rounds a breakdown and closes it against the month's actual total and adjustments. */
function finishBreakdown(b: Breakdown, actual: number, adjustments: number): Breakdown {
  const lost = b.holidays.reduce((x, h) => x + h.pay, 0) + b.cancelled.pay + b.lateCuts.pay + b.notRecorded.pay + b.toGo.pay;
  b.adjustments = r2(adjustments);
  b.actual = r2(actual);
  b.other = r2(actual - (b.timetable.pay - lost + adjustments));
  b.timetable.pay = r2(b.timetable.pay);
  for (const h of b.holidays) h.pay = r2(h.pay);
  for (const k of ['cancelled', 'lateCuts', 'notRecorded', 'toGo'] as const) b[k].pay = r2(b[k].pay);
  return b;
}

export function payOverview(db: DB, u: User, year: string) {
  if (!/^\d{4}$/.test(year)) throw new AppError(422, 'Year must be four digits.');
  const now = today(db, u);
  const sd = payStartDay(db, u);
  const from = payPeriod(`${year}-01`, sd).from, to = payPeriod(`${year}-12`, sd).to;
  const lines = payLines(db, u, from, to);
  const rates = loadRates(db, u.id);
  const months = new Map<string, MonthSummary>();
  const get = (m: string) => {
    if (!months.has(m)) months.set(m, { month: m, ...payPeriod(m, sd), taughtSessions: 0, taughtMinutes: 0, makeupSessions: 0, unratedSessions: 0, lateSessions: 0, deductions: 0, estimated: 0, approved: 0, paid: 0, total: 0, expected: 0, plannedSessions: 0, scheduledSessions: 0, scheduledMinutes: 0, scheduledPay: 0, adjustments: 0, expectedTotal: 0, holidayPay: 0 });
    return months.get(m)!;
  };
  for (const l of lines) {
    const m = get(payMonthOf(l.date, sd));
    m.taughtSessions++;
    m.taughtMinutes += l.minutes;
    if (l.isMakeup) m.makeupSessions++;
    if (l.rate == null) m.unratedSessions++;
    if (l.late > 0) m.lateSessions++;
    m.deductions += l.deduction;
    if (!l.statementId) m.estimated += l.amount;
  }
  const adjustments = db.all('SELECT * FROM pay_adjustments WHERE owner_id = ? AND substr(month, 1, 4) = ? ORDER BY month, id', u.id, year);
  for (const a of adjustments) {
    get(a.month).adjustments += a.amount;
    if (!a.statement_id) get(a.month).estimated += a.amount;
  }
  const statements = db.all('SELECT * FROM pay_statements WHERE owner_id = ? AND substr(month, 1, 4) = ? ORDER BY month, id', u.id, year);
  for (const s of statements) {
    const m = get(s.month);
    if (s.status === 'paid') m.paid += s.paid_amount ?? s.total;
    else m.approved += s.total;
    m.total += s.total;
  }
  // Everything scheduled (holidays and other cancellations excluded) at full rate: what the month is
  // worth if every session runs. Planned sessions still ahead are also shown as "expected".
  const scheduled = db.all(
    `SELECT s.id, s.date, s.start_time, s.end_time, s.status, s.holiday_exception, s.class_id, c.course_id, c.term_id, k.time AS checkin,
            EXISTS (SELECT 1 FROM pay_statement_lines l WHERE l.session_id = s.id) AS on_statement
       FROM sessions s JOIN classes c ON c.id = s.class_id LEFT JOIN checkins k ON k.session_id = s.id
      WHERE c.teacher_id = ? AND s.status IN ('planned','completed') AND s.date BETWEEN ? AND ?`,
    u.id, from, to,
  );
  const hs = loadHolidays(db, u.id);
  for (const p of scheduled) {
    if (!p.on_statement && unpaidHoliday(hs, p)) continue;
    const m = get(payMonthOf(p.date, sd));
    const minutes = durationMinutes(p.start_time, p.end_time);
    const full = sessionPay(resolveRate(rates, { classId: p.class_id, courseId: p.course_id, date: p.date }), minutes);
    m.scheduledSessions++;
    m.scheduledMinutes += minutes;
    m.scheduledPay += full;
    if (p.status === 'planned' && p.date >= now) { m.plannedSessions++; m.expected += full; }
  }
  // Past sessions with neither a teaching record nor a check-in (and not on a holiday) are not paid
  // until decided.
  const unrecorded = scheduled.filter((p) => p.status === 'planned' && p.date < now && !p.checkin && !p.on_statement && !unpaidHoliday(hs, p)).length;
  const bd = breakdowns(db, u, from, to, lines, (d) => payMonthOf(d, sd));
  for (const k of bd.keys()) get(k);
  const list = [...months.values()].map((m) => ({ ...m, estimated: r2(m.estimated), deductions: r2(m.deductions), approved: r2(m.approved), paid: r2(m.paid), expected: r2(m.expected), scheduledPay: r2(m.scheduledPay), adjustments: r2(m.adjustments), expectedTotal: r2(m.scheduledPay + m.adjustments), total: r2(m.total + m.estimated) })).sort((a, b) => a.month.localeCompare(b.month))
    .map((m) => {
      const breakdown = finishBreakdown(bd.get(m.month) ?? newBreakdown(), m.total, m.adjustments);
      return { ...m, breakdown, holidayPay: r2(breakdown.holidays.reduce((x, h) => x + h.pay, 0)) };
    });
  const sum = (k: keyof MonthSummary) => r2(list.reduce((s, m) => s + (m[k] as number), 0));
  return {
    year,
    payStartDay: sd,
    currentMonth: payMonthOf(now, sd),
    currency: rates[0]?.currency ?? 'USD',
    months: list,
    totals: { taughtSessions: sum('taughtSessions'), taughtMinutes: sum('taughtMinutes'), lateSessions: sum('lateSessions'), deductions: sum('deductions'), estimated: sum('estimated'), approved: sum('approved'), paid: sum('paid'), total: sum('total'), expected: sum('expected'), scheduledMinutes: sum('scheduledMinutes'), scheduledPay: sum('scheduledPay'), expectedTotal: sum('expectedTotal'), holidayPay: sum('holidayPay') },
    statements: statements.map(statementOut),
    rates: loadRates(db, u.id, true),
    lateRule: loadLateRule(db, u.id),
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
  const sd = payStartDay(db, u);
  if (month > payMonthOf(today(db, u), sd)) throw new AppError(422, 'A month can only be approved once its pay period has started.');
  const { from, to } = payPeriod(month, sd);
  return db.tx(() => {
    const lines = payLines(db, u, from, to).filter((l) => !l.statementId);
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
      db.run('INSERT INTO pay_statement_lines (statement_id, session_id, minutes, rate_mode, rate_amount, amount, late_minutes, deduction) VALUES (?,?,?,?,?,?,?,?)', id, l.sessionId, l.minutes, rate.mode, rate.amount, l.amount, l.late, l.deduction);
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
    `SELECT l.*, s.date, s.start_time, c.code, k.time AS checkin FROM pay_statement_lines l LEFT JOIN checkins k ON k.session_id = l.session_id JOIN sessions s ON s.id = l.session_id JOIN classes c ON c.id = s.class_id
      WHERE l.statement_id = ? ORDER BY s.date, s.start_time`, id,
  );
  return { ...statementOut(s), lines: lines.map((l) => ({ sessionId: l.session_id, date: l.date, start: l.start_time, code: l.code, minutes: l.minutes, rate: rateLabel(l.rate_mode, l.rate_amount), checkin: l.checkin, late: l.late_minutes, deduction: l.deduction, amount: l.amount })), adjustments: db.all('SELECT id, amount, note FROM pay_adjustments WHERE statement_id = ?', id) };
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

// ---------------------------------------------------------------------------------------------
// Payslip: one pay month, every session in it and what happened to it, to check against what the
// school actually paid.

/**
 * Every class from `from` to `to` and what happened to it for pay: worked (paid, with arrival and
 * late cut), not held (holiday or cancelled, with the reason), not recorded yet, or planned.
 */
export function periodRows(db: DB, u: User, from: string, to: string) {
  const now = today(db, u);
  const rates = loadRates(db, u.id);
  const worked = new Map(payLines(db, u, from, to).map((l) => [l.sessionId, l]));
  const sessions = db.all(
    `SELECT s.id, s.date, s.start_time, s.end_time, s.status, s.note, s.kind, s.class_id, s.holiday_exception, c.code, c.course_id, c.term_id, k.time AS checkin
       FROM sessions s JOIN classes c ON c.id = s.class_id LEFT JOIN checkins k ON k.session_id = s.id
      WHERE c.teacher_id = ? AND s.date BETWEEN ? AND ? AND s.status <> 'moved' ORDER BY s.date, s.start_time, s.id`,
    u.id, from, to,
  );
  const hs = loadHolidays(db, u.id);
  const rows = sessions.map((s) => {
    const minutes = durationMinutes(s.start_time, s.end_time);
    const full = sessionPay(resolveRate(rates, { classId: s.class_id, courseId: s.course_id, date: s.date }), minutes);
    const l = worked.get(s.id);
    const holiday = !l && unpaidHoliday(hs, s) ? holidayOn(hs, s.date, s.term_id) : null;
    const state = l ? 'worked' : holiday || s.status === 'cancelled' || s.status === 'skipped' ? 'not held' : s.date >= now ? 'planned' : 'not recorded';
    return {
      sessionId: s.id, classId: s.class_id, date: s.date, start: s.start_time, end: s.end_time, code: s.code, kind: s.kind, state,
      reason: state !== 'not held' ? null : holiday && s.status !== 'cancelled' ? `Holiday: ${holiday.name}${s.status === 'completed' ? ' (recorded as taught, not paid)' : ''}`
        : /^Holiday:/.test(s.note ?? '') && !holidayOn(hs, s.date, s.term_id) ? 'Cancelled for a holiday that is no longer on your list. Use “Check classes against holidays” to restore it.' : s.note,
      scheduledMinutes: minutes, fullPay: state === 'not held' ? 0 : full,
      minutes: l?.minutes ?? null, rate: l?.rate ?? null, recorded: l?.recorded ?? false,
      checkin: l?.checkin ?? s.checkin ?? null, late: l?.late ?? 0, cut: l?.deduction ?? 0, amount: l?.amount ?? 0,
      statementStatus: l?.statementStatus ?? null,
      // An arrival can be added or changed for a class that took place (or today's), unless it is on an approved statement.
      canEditArrival: !l?.statementStatus && state !== 'not held' && s.date <= now,
    };
  });
  return { rows, worked, currency: rates[0]?.currency ?? 'USD' };
}

/** Any span of up to two months, for the Sessions list and calendar. */
export function payPeriodView(db: DB, u: User, from: string, to: string) {
  if (!isISODate(from) || !isISODate(to) || to < from) throw new AppError(422, 'Choose a valid period.');
  if (durationDays(from, to) > 62) throw new AppError(422, 'Choose a period of at most two months.');
  const { rows, currency } = periodRows(db, u, from, to);
  const worked = rows.filter((r) => r.state === 'worked');
  return {
    from, to, today: today(db, u), currency, rows,
    totals: {
      sessions: rows.filter((r) => r.state !== 'not held').length,
      worked: worked.length,
      minutes: worked.reduce((x, r) => x + (r.minutes ?? 0), 0),
      amount: r2(worked.reduce((x, r) => x + r.amount, 0)),
      lateCuts: r2(worked.reduce((x, r) => x + r.cut, 0)),
      late: worked.filter((r) => r.late > 0).length,
      notRecorded: rows.filter((r) => r.state === 'not recorded').length,
    },
  };
}

export function payslip(db: DB, u: User, month: string) {
  if (!MONTH_RE.test(month)) throw new AppError(422, 'Choose a month as YYYY-MM.');
  const sd = payStartDay(db, u);
  const { from, to } = payPeriod(month, sd);
  const { rows, worked } = periodRows(db, u, from, to);
  const rates = loadRates(db, u.id);
  const adjustments = db.all('SELECT id, amount, note, statement_id FROM pay_adjustments WHERE owner_id = ? AND month = ? ORDER BY id', u.id, month);
  const statements = db.all('SELECT * FROM pay_statements WHERE owner_id = ? AND month = ? ORDER BY id', u.id, month).map(statementOut);
  const adj = r2(adjustments.reduce((s, a) => s + a.amount, 0));
  const sum = (f: (r: (typeof rows)[number]) => number) => r2(rows.reduce((s, r) => s + f(r), 0));
  const actual = r2(sum((r) => r.amount) + adj);
  const paid = statements.filter((s) => s.status === 'paid');
  const paidAmount = paid.length ? r2(paid.reduce((s, x) => s + (x.paidAmount ?? x.total), 0)) : null;
  const paidStatementTotal = r2(paid.reduce((s, x) => s + x.total, 0));
  const breakdown = finishBreakdown(breakdowns(db, u, from, to, [...worked.values()], () => month).get(month) ?? newBreakdown(), actual, adj);
  return {
    month, from, to, teacher: u.name, breakdown, currency: rates[0]?.currency ?? 'USD', lateRule: loadLateRule(db, u.id),
    rows,
    adjustments: adjustments.map((a) => ({ id: a.id, amount: a.amount, note: a.note })),
    statements,
    totals: {
      scheduledSessions: rows.filter((r) => r.state !== 'not held').length,
      scheduledMinutes: rows.filter((r) => r.state !== 'not held').reduce((s, r) => s + r.scheduledMinutes, 0),
      expected: r2(sum((r) => r.fullPay) + adj),
      workedSessions: rows.filter((r) => r.state === 'worked').length,
      workedMinutes: rows.reduce((s, r) => s + (r.minutes ?? 0), 0),
      lateCuts: sum((r) => r.cut),
      notHeld: rows.filter((r) => r.state === 'not held').length,
      notRecorded: rows.filter((r) => r.state === 'not recorded').length,
      planned: rows.filter((r) => r.state === 'planned').length,
      adjustments: adj,
      actual,
      // What the school paid against what its paid statements said it would pay.
      paid: paidAmount,
      difference: paidAmount == null ? null : r2(paidAmount - paidStatementTotal),
    },
  };
}
