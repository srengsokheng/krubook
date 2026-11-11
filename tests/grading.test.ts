import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';
import type { DB } from '../server/db.ts';
import { createApp, createHolder } from '../server/app.ts';
import { addAccount } from '../server/auth.ts';

let db: DB, dir: string, server: Server, base: string, cookie = '', term = 0, cpp = 0, web = 0;
const call = async (method: string, path: string, body?: unknown) => {
  const r = await fetch(base + path, { method, headers: { 'content-type': 'application/json', cookie }, body: body === undefined ? undefined : JSON.stringify(body) });
  return { status: r.status, body: await r.json().catch(() => null) };
};
const newClass = async (code: string, course: number) => (await call('POST', '/classes', { termId: term, courseId: course, code, startDate: '2026-11-16' })).body.id as number;
const setup = async (id: number) => (await call('GET', `/classes/${id}/gradebook`)).body.config;
const maxes = async (id: number) => Object.fromEntries((await setup(id)).components.map((c: any) => [c.key, c.max]));
/** The class's setup with midterm and attendance set to the given maximums. */
const withMidterm = async (id: number, mid: number, att: number) => {
  const c = await setup(id);
  return { targetTotal: c.targetTotal, passMark: c.passMark, labelPass: c.labelPass, labelFail: c.labelFail, attendanceRule: c.attendanceRule,
    components: c.components.map((x: any) => ({ ...x, max: x.key === 'midterm' ? mid : x.kind === 'attendance' ? att : x.max })) };
};

beforeEach(async () => {
  dir = mkdtempSync(join(tmpdir(), 'krubook-grading-'));
  const holder = createHolder(join(dir, 'g.sqlite'));
  db = holder.db;
  const me = addAccount(db, 'me@example.test', 'Me', 'me-pass-123');
  cpp = db.run("INSERT INTO courses (owner_id, code, name) VALUES (?, 'CPP', 'C++ Programming')", me).id;
  web = db.run("INSERT INTO courses (owner_id, code, name) VALUES (?, 'WBD1', 'Web Development I')", me).id;
  term = db.run("INSERT INTO terms (owner_id, name, start_date, end_date) VALUES (?, 'T', '2026-09-01', '2027-03-31')", me).id;
  server = createApp(holder).listen(0);
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}/api`;
  const r = await fetch(`${base}/auth/login`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ email: 'me@example.test', password: 'me-pass-123' }) });
  cookie = r.headers.get('set-cookie')!.split(';')[0]!;
});
afterEach(() => { server.close(); db.close(); rmSync(dir, { recursive: true, force: true }); });

describe('grading setup per course', () => {
  it('applies one class’s setup to the other classes of the same course only', async () => {
    const [a, b, c] = [await newClass('SY9', cpp), await newClass('SY11', cpp), await newClass('SY20', cpp)];
    const w = await newClass('SW33', web);
    db.run("UPDATE grade_configs SET status = 'finalized' WHERE class_id = ?", c);
    expect((await call('PUT', `/classes/${a}/grade-config`, await withMidterm(a, 25, 15))).status).toBe(200);
    const r = await call('POST', `/classes/${a}/grade-config/apply-to-course`, {});
    expect(r.body).toEqual({ updated: ['SY11'], skipped: [{ code: 'SY20', reason: 'gradebook is finalized' }] });
    expect(await maxes(b)).toMatchObject({ midterm: 25, attendance: 15 });
    expect((await setup(b)).status).toBe('active');
    expect(await maxes(c)).toMatchObject({ midterm: 20, attendance: 20 });
    expect(await maxes(w)).toMatchObject({ midterm: 20, attendance: 20 }); // another course
  });

  it('starts a new class with its course’s setup', async () => {
    const a = await newClass('SY9', cpp);
    await call('PUT', `/classes/${a}/grade-config`, await withMidterm(a, 25, 15));
    const b = await newClass('SY11', cpp);
    expect(await maxes(b)).toMatchObject({ midterm: 25, attendance: 15 });
    expect((await setup(b)).status).toBe('active');
    expect(await maxes(await newClass('SW33', web))).toMatchObject({ midterm: 20, attendance: 20 });
  });

  it('refuses a maximum below a mark already given, and keeps a total other than 100 as a draft', async () => {
    const a = await newClass('SW43', web);
    const st = db.run("INSERT INTO students (owner_id, student_code, name_latin) VALUES (1, 'S1', 'One')").id;
    const e = db.run("INSERT INTO enrollments (student_id, class_id, enrolled_on) VALUES (?, ?, '2026-11-16')", st, a).id;
    const mid = (await setup(a)).components.find((c: any) => c.key === 'midterm');
    db.run('INSERT INTO scores (enrollment_id, component_id, value) VALUES (?, ?, 18)', e, mid.id);
    const low = await call('PUT', `/classes/${a}/grade-config`, await withMidterm(a, 15, 25));
    expect(low.status).toBe(422);
    expect(low.body.error).toMatch(/Midterm cannot be out of 15: S1 already has 18/);
    const off = await call('PUT', `/classes/${a}/grade-config`, await withMidterm(a, 20, 15));
    expect(off.status).toBe(200);
    expect(off.body.check).toMatchObject({ valid: false, total: 95 });
    expect(off.body.config.status).toBe('draft');
  });
});
