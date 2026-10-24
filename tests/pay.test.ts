import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';
import type { DB } from '../server/db.ts';
import { createApp, createHolder } from '../server/app.ts';
import { addAccount, type User } from '../server/auth.ts';
import { approveMonth, markPaid, payLines, payOverview, unapprove } from '../server/services/pay.ts';
import { cancelSession, completeSession, reopenSession } from '../server/services/plan.ts';

// Deterministic fixtures: sessions on fixed dates with known durations and rates.
process.env.KRUBOOK_TODAY = '2026-10-24';

let db: DB, u: User, dir: string, server: Server, base: string, cookie = '';
let classA: number, classB: number;

function session(cls: number, date: string, start: string, end: string, makeup = false) {
  return db.run(
    "INSERT INTO sessions (class_id, week, date, start_time, end_time, kind, status, original_date, is_makeup) VALUES (?, 1, ?, ?, ?, 'lecture', 'planned', ?, ?)",
    cls, date, start, end, date, makeup ? 1 : 0,
  ).id;
}
const taught = (id: number) => completeSession(db, u, id, { parts: [] });
const hourly = (amount: number, extra = '') => db.run(`INSERT INTO rates (owner_id, mode, amount, effective_from${extra ? ', class_id' : ''}) VALUES (?, 'hourly', ?, '2026-01-01'${extra ? `, ${extra}` : ''})`, u.id, amount).id;
async function call(method: string, path: string, body?: unknown) {
  const r = await fetch(base + path, { method, headers: { 'content-type': 'application/json', cookie }, body: body === undefined ? undefined : JSON.stringify(body) });
  return { status: r.status, body: await r.json().catch(() => null) };
}

beforeEach(async () => {
  dir = mkdtempSync(join(tmpdir(), 'krubook-pay-'));
  const holder = createHolder(join(dir, 'pay.sqlite'));
  db = holder.db;
  const id = addAccount(db, 'teacher@example.test', 'Teacher', 'teacher-pass-1');
  u = { id, email: 'teacher@example.test', name: 'Teacher', role: 'admin' };
  const course = db.run("INSERT INTO courses (owner_id, code, name) VALUES (?, 'C1', 'Course 1')", id).id;
  const term = db.run("INSERT INTO terms (owner_id, name, start_date, end_date) VALUES (?, 'T', '2026-09-01', '2027-01-31')", id).id;
  classA = db.run("INSERT INTO classes (term_id, course_id, teacher_id, code, start_date, status) VALUES (?, ?, ?, 'A1', '2026-09-01', 'active')", term, course, id).id;
  classB = db.run("INSERT INTO classes (term_id, course_id, teacher_id, code, start_date, status) VALUES (?, ?, ?, 'B1', '2026-09-01', 'active')", term, course, id).id;
  server = createApp(holder).listen(0);
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}/api`;
  const r = await fetch(`${base}/auth/login`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ email: 'teacher@example.test', password: 'teacher-pass-1' }) });
  cookie = r.headers.get('set-cookie')!.split(';')[0];
});
afterEach(() => { server.close(); db.close(); rmSync(dir, { recursive: true, force: true }); });

describe('teaching pay', () => {
  it('a 2-hour taught session at $10/hour earns $20', async () => {
    expect((await call('POST', '/rates', { mode: 'hourly', amount: 10, effectiveFrom: '2026-01-01' })).status).toBe(200);
    taught(session(classA, '2026-09-07', '13:00', '15:00'));
    const p = payOverview(db, u, '2026');
    expect(p.months).toHaveLength(1);
    expect(p.months[0]).toMatchObject({ month: '2026-09', taughtSessions: 1, taughtMinutes: 120, estimated: 20, approved: 0, paid: 0, total: 20 });
  });

  it('cancelled and unrecorded sessions earn nothing; make-up sessions are paid', () => {
    hourly(10);
    cancelSession(db, u, session(classA, '2026-09-08', '13:00', '15:00'), 'Rain');
    session(classA, '2026-09-09', '13:00', '15:00'); // in the past, never recorded
    taught(session(classA, '2026-09-10', '13:00', '14:00', true));
    const p = payOverview(db, u, '2026');
    expect(p.months.find((x) => x.month === '2026-09')).toMatchObject({ taughtSessions: 1, makeupSessions: 1, estimated: 10 });
    expect(p.unrecorded).toBe(1);
  });

  it('a class with a per-session rate uses it instead of the hourly default', () => {
    hourly(10);
    db.run("INSERT INTO rates (owner_id, class_id, mode, amount, effective_from) VALUES (?, ?, 'per_session', 25, '2026-01-01')", u.id, classB);
    taught(session(classA, '2026-09-07', '13:00', '15:00'));
    taught(session(classB, '2026-09-07', '16:00', '17:30'));
    expect(payLines(db, u, '2026-09-01', '2026-09-30').map((l) => l.amount)).toEqual([20, 25]);
    expect(payOverview(db, u, '2026').months[0].estimated).toBe(45);
  });

  it('monthly totals equal the sum of the underlying sessions and adjustments', () => {
    hourly(12.5);
    for (const [d, s, e] of [['2026-10-01', '13:00', '13:50'], ['2026-10-02', '13:00', '14:30'], ['2026-10-05', '08:00', '09:10']]) taught(session(classA, d, s, e));
    db.run("INSERT INTO pay_adjustments (owner_id, month, amount, note) VALUES (?, '2026-10', -2.5, 'late')", u.id);
    const lines = payLines(db, u, '2026-10-01', '2026-10-31');
    expect(lines.map((l) => l.amount)).toEqual([10.42, 18.75, 14.58]);
    expect(payOverview(db, u, '2026').months[0].estimated).toBe(Math.round((10.42 + 18.75 + 14.58 - 2.5) * 100) / 100);
  });

  it('approving freezes amounts: a later rate change does not alter approved earnings', async () => {
    const rate = hourly(10);
    taught(session(classA, '2026-09-07', '13:00', '15:00'));
    const st = (await call('POST', '/pay/statements', { month: '2026-09' })).body;
    expect(st).toMatchObject({ status: 'approved', sessions: 1, total: 20 });
    expect((await call('PUT', `/rates/${rate}`, { amount: 50 })).status).toBe(200);
    taught(session(classA, '2026-09-14', '13:00', '15:00'));
    expect(payOverview(db, u, '2026').months[0]).toMatchObject({ approved: 20, estimated: 100, total: 120 });
    expect(payLines(db, u, '2026-09-01', '2026-09-30').map((l) => [l.amount, l.statementStatus])).toEqual([[20, 'approved'], [100, null]]);
  });

  it('a session can be paid only once, and approving twice adds nothing', async () => {
    hourly(10);
    const s = session(classA, '2026-09-07', '13:00', '15:00');
    taught(s);
    expect((await call('POST', '/pay/statements', { month: '2026-09' })).status).toBe(200);
    expect((await call('POST', '/pay/statements', { month: '2026-09' })).status).toBe(409);
    expect(() => db.run('INSERT INTO pay_statement_lines (statement_id, session_id, minutes, amount) VALUES ((SELECT id FROM pay_statements), ?, 120, 20)', s)).toThrow(/UNIQUE/);
    expect(db.get('SELECT COUNT(*) AS n FROM pay_statement_lines')!.n).toBe(1);
  });

  it('approved records are protected and paid statements cannot be undone', async () => {
    hourly(10);
    const s = session(classA, '2026-09-07', '13:00', '15:00');
    taught(s);
    const adj = (await call('POST', '/pay/adjustments', { month: '2026-09', amount: 5, note: 'Invigilation' })).body.id;
    const st = approveMonth(db, u, '2026-09');
    expect(st.total).toBe(25);
    expect(() => reopenSession(db, u, s)).toThrow(/PAY_LOCKED/);
    expect(await call('POST', `/sessions/${s}/reopen`)).toMatchObject({ status: 409, body: { error: expect.stringMatching(/approved pay statement/) } });
    expect((await call('PUT', `/pay/adjustments/${adj}`, { amount: 50 })).status).toBe(409);
    expect((await call('DELETE', `/pay/adjustments/${adj}`)).status).toBe(409);
    expect(markPaid(db, u, st.id, { paidOn: '2026-10-05' })).toMatchObject({ status: 'paid', paidAmount: 25 });
    expect((await call('POST', `/pay/statements/${st.id}/paid`, {})).status).toBe(409);
    expect(() => unapprove(db, u, st.id)).toThrow(/paid statement/);
    expect(() => db.run('DELETE FROM pay_statements WHERE id = ?', st.id)).toThrow(/PAY_PAID/);
    expect(payOverview(db, u, '2026').months[0]).toMatchObject({ paid: 25, approved: 0, estimated: 0, total: 25 });
  });

  it('undoing an unpaid approval returns its sessions and adjustments to estimates', () => {
    hourly(10);
    taught(session(classA, '2026-09-07', '13:00', '15:00'));
    db.run("INSERT INTO pay_adjustments (owner_id, month, amount, note) VALUES (?, '2026-09', 5, 'x')", u.id);
    unapprove(db, u, approveMonth(db, u, '2026-09').id);
    expect(payOverview(db, u, '2026').months[0]).toMatchObject({ estimated: 25, approved: 0 });
    expect(db.get('SELECT statement_id FROM pay_adjustments')!.statement_id).toBeNull();
  });

  it('refuses to approve unrated sessions, a future month or an invalid month', async () => {
    taught(session(classA, '2026-09-07', '13:00', '15:00'));
    expect((await call('POST', '/pay/statements', { month: '2026-09' })).status).toBe(422);
    expect((await call('POST', '/pay/statements', { month: '2026-12' })).status).toBe(422);
    expect((await call('POST', '/pay/statements', { month: '2026-13' })).status).toBe(422);
    expect(db.get('SELECT COUNT(*) AS n FROM pay_statements')!.n).toBe(0);
  });

  it('deactivated rates stop applying to estimates', async () => {
    const r = (await call('POST', '/rates', { mode: 'hourly', amount: 10, effectiveFrom: '2026-01-01' })).body.id;
    taught(session(classA, '2026-09-07', '13:00', '15:00'));
    expect((await call('PUT', `/rates/${r}`, { active: false })).status).toBe(200);
    expect(payOverview(db, u, '2026').months[0]).toMatchObject({ estimated: 0, unratedSessions: 1 });
  });

  it('validates rates and adjustments without saving partial records', async () => {
    const badRates = [
      { mode: 'hourly', amount: -1, effectiveFrom: '2026-01-01' },
      { mode: 'hourly', amount: '', effectiveFrom: '2026-01-01' },
      { mode: 'weekly', amount: 5, effectiveFrom: '2026-01-01' },
      { mode: 'hourly', amount: 5 },
      { mode: 'hourly', amount: 5, effectiveFrom: '2026-01-01', classId: classA, courseId: 1 },
    ];
    for (const bad of badRates) expect((await call('POST', '/rates', bad)).status).toBe(422);
    const badAdj = [
      { month: '2026-09', amount: 0, note: 'x' },
      { month: '2026-09', amount: 5, note: ' ' },
      { month: '2026-9', amount: 5, note: 'x' },
      { month: '2026-09', amount: 'abc', note: 'x' },
    ];
    for (const bad of badAdj) expect((await call('POST', '/pay/adjustments', bad)).status).toBe(422);
    expect(db.get('SELECT COUNT(*) AS n FROM rates')!.n).toBe(0);
    expect(db.get('SELECT COUNT(*) AS n FROM pay_adjustments')!.n).toBe(0);
    expect((await call('PUT', '/rates/999', { amount: 1 })).status).toBe(404);
    expect((await call('DELETE', '/pay/adjustments/999')).status).toBe(404);
  });

  it("pays only the teacher's own classes, even for an administrator", () => {
    hourly(10);
    const other = addAccount(db, 'other@example.test', 'Other', 'other-pass-12');
    const c = db.run("INSERT INTO classes (term_id, course_id, teacher_id, code, start_date) VALUES ((SELECT id FROM terms), (SELECT id FROM courses), ?, 'O1', '2026-09-01')", other).id;
    const s = session(c, '2026-09-07', '13:00', '15:00');
    db.run("INSERT INTO teaching_records (session_id, taught_on, minutes) VALUES (?, '2026-09-07', 120)", s);
    db.run("UPDATE sessions SET status = 'completed' WHERE id = ?", s);
    expect(payOverview(db, u, '2026').months).toHaveLength(0);
  });

  it('paginates the session lines with metadata', async () => {
    hourly(10);
    for (let d = 1; d <= 12; d++) taught(session(classA, `2026-09-${String(d).padStart(2, '0')}`, '13:00', '14:00'));
    const r = (await call('GET', '/pay/lines?year=2026&page=2&pageSize=10')).body;
    expect(r).toMatchObject({ total: 12, page: 2, pageSize: 10, pages: 2 });
    expect(r.items).toHaveLength(2);
    expect((await call('GET', '/pay/lines?pageSize=7')).status).toBe(400);
  });
});
