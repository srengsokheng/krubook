import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';
import type { DB } from '../server/db.ts';
import { createApp, createHolder } from '../server/app.ts';
import { addAccount, createUser } from '../server/auth.ts';
import { ensureConfig } from '../server/services/records.ts';
import { exportBackup } from '../server/services/backup.ts';

let db: DB, dir: string, server: Server, base: string, cookie = '', other = '', cls = 0;
async function login(email: string, password: string) {
  const r = await fetch(`${base}/auth/login`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ email, password }) });
  return r.headers.get('set-cookie')!.split(';')[0]!;
}
const call = async (c: string, method: string, path: string, body?: unknown) => {
  const r = await fetch(base + path, { method, headers: { 'content-type': 'application/json', ...(c ? { cookie: c } : {}) }, body: body === undefined ? undefined : JSON.stringify(body) });
  return { status: r.status, headers: r.headers, body: await r.json().catch(() => null) };
};

beforeEach(async () => {
  dir = mkdtempSync(join(tmpdir(), 'krubook-shares-'));
  const holder = createHolder(join(dir, 's.sqlite'));
  db = holder.db;
  const me = addAccount(db, 'me@example.test', 'Sreng Sokheng', 'me-pass-123');
  createUser(db, 'other@example.test', 'Other', 'other-pass-1');
  const course = db.run("INSERT INTO courses (owner_id, code, name) VALUES (?, 'WBD1', 'Web Development I')", me).id;
  const term = db.run("INSERT INTO terms (owner_id, name, start_date, end_date) VALUES (?, 'T', '2026-09-01', '2027-01-31')", me).id;
  cls = db.run("INSERT INTO classes (term_id, course_id, teacher_id, code, start_date) VALUES (?, ?, ?, 'SW43', '2026-09-07')", term, course, me).id;
  ensureConfig(db, cls);
  const mid = db.get("SELECT c.id FROM grade_components c JOIN grade_configs g ON g.id = c.config_id WHERE g.class_id = ? AND c.key = 'midterm'", cls)!.id;
  for (const [code, name, score] of [['SW43-06', 'Chung Viphob', 7.5], ['SW43-12', 'Long Sophol', null]] as const) {
    const st = db.run('INSERT INTO students (owner_id, student_code, name_latin, name_km) VALUES (?, ?, ?, ?)', me, code, name, 'ឈ្មោះ').id;
    const e = db.run("INSERT INTO enrollments (student_id, class_id, enrolled_on) VALUES (?, ?, '2026-09-07')", st, cls).id;
    if (score != null) db.run('INSERT INTO scores (enrollment_id, component_id, value) VALUES (?, ?, ?)', e, mid, score);
  }
  const gone = db.run("INSERT INTO students (owner_id, student_code, name_latin) VALUES (?, 'SW43-99', 'Dropped Student')", me).id;
  db.run("INSERT INTO enrollments (student_id, class_id, enrolled_on, status) VALUES (?, ?, '2026-09-07', 'dropped')", gone, cls);
  server = createApp(holder).listen(0);
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}/api`;
  cookie = await login('me@example.test', 'me-pass-123');
  other = await login('other@example.test', 'other-pass-1');
});
afterEach(() => { server.close(); db.close(); rmSync(dir, { recursive: true, force: true }); });

describe('score links for students', () => {
  it('shows the class’s marks without signing in, live, until the link ends', async () => {
    const s = (await call(cookie, 'POST', `/classes/${cls}/shares`, { days: 1 })).body;
    expect(s).toMatchObject({ active: true, showNames: true });
    expect(s.token).toMatch(/^[\w-]{20,}$/);

    const v = await call('', 'GET', `/public/scores/${s.token}`);
    expect(v.status).toBe(200);
    expect(v.headers.get('x-robots-tag')).toContain('noindex');
    expect(v.body).toMatchObject({ classCode: 'SW43', course: 'Web Development I', teacher: 'Sreng Sokheng', targetTotal: 100 });
    expect(v.body.columns.map((c: any) => c.name)).toContain('Midterm');
    const mid = v.body.columns.findIndex((c: any) => c.name === 'Midterm');
    expect(v.body.rows.map((r: any) => [r.code, r.nameLatin, r.values[mid], r.total])).toEqual([['SW43-06', 'Chung Viphob', 7.5, 7.5], ['SW43-12', 'Long Sophol', null, 0]]);
    expect(JSON.stringify(v.body)).not.toContain('Dropped Student');
    expect(v.body.rows[0].result).toBeNull(); // not all marks in yet

    // A mark entered later shows on the next load.
    const e = db.get("SELECT e.id FROM enrollments e JOIN students s ON s.id = e.student_id WHERE s.student_code = 'SW43-12'")!.id;
    const comp = db.get("SELECT c.id FROM grade_components c JOIN grade_configs g ON g.id = c.config_id WHERE g.class_id = ? AND c.key = 'midterm'", cls)!.id;
    db.run('INSERT INTO scores (enrollment_id, component_id, value) VALUES (?, ?, 6)', e, comp);
    expect((await call('', 'GET', `/public/scores/${s.token}`)).body.rows[1].values[mid]).toBe(6);
    expect((await call(cookie, 'GET', `/classes/${cls}/shares`)).body[0].views).toBe(2);

    // Ended: expired, or stopped by the teacher.
    db.run("UPDATE score_shares SET expires_at = datetime('now', '-1 minute') WHERE id = ?", s.id);
    expect((await call('', 'GET', `/public/scores/${s.token}`)).status).toBe(410);
    const s2 = (await call(cookie, 'POST', `/classes/${cls}/shares`, { days: 2 })).body;
    expect((await call(cookie, 'DELETE', `/shares/${s2.id}`)).status).toBe(200);
    expect((await call('', 'GET', `/public/scores/${s2.token}`)).status).toBe(404);
    expect((await call('', 'GET', '/public/scores/not-a-real-link-token')).status).toBe(404);
  });

  it('can hide names, is the teacher’s own, refuses odd lengths, and is not in backups', async () => {
    const s = (await call(cookie, 'POST', `/classes/${cls}/shares`, { days: 0.5, showNames: false })).body;
    const v = (await call('', 'GET', `/public/scores/${s.token}`)).body;
    expect(v.showNames).toBe(false);
    expect(JSON.stringify(v)).not.toMatch(/Chung|Long Sophol|ឈ្មោះ/);
    expect((await call(cookie, 'POST', `/classes/${cls}/shares`, { days: 31 })).status).toBe(422);
    expect((await call(other, 'GET', `/classes/${cls}/shares`)).status).toBe(404);
    expect((await call(other, 'POST', `/classes/${cls}/shares`, { days: 1 })).status).toBe(404);
    expect((await call(other, 'DELETE', `/shares/${s.id}`)).status).toBe(404);
    expect((await call('', 'GET', `/classes/${cls}/shares`)).status).toBe(401);
    expect(Object.keys(exportBackup(db).tables)).not.toContain('score_shares');
  });
});
