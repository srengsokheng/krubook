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
import { exportBackup, loadBackup } from '../server/services/backup.ts';

let db: DB, dir: string, server: Server, base: string, cookie = '', other = '', cls = 0, enr: number[] = [];
async function login(email: string, password: string) {
  const r = await fetch(`${base}/auth/login`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ email, password }) });
  return r.headers.get('set-cookie')!.split(';')[0]!;
}
const call = async (c: string, method: string, path: string, body?: unknown) => {
  const r = await fetch(base + path, { method, headers: { 'content-type': 'application/json', cookie: c }, body: body === undefined ? undefined : JSON.stringify(body) });
  return { status: r.status, body: await r.json().catch(() => null) };
};
const col = (key: string) => db.get('SELECT c.id FROM grade_components c JOIN grade_configs g ON g.id = c.config_id WHERE g.class_id = ? AND c.key = ?', cls, key)!.id as number;
const mark = (eid: number, key: string) => db.get('SELECT value FROM scores WHERE enrollment_id = ? AND component_id = ?', eid, col(key))?.value ?? null;

beforeEach(async () => {
  dir = mkdtempSync(join(tmpdir(), 'krubook-groups-'));
  const holder = createHolder(join(dir, 'g.sqlite'));
  db = holder.db;
  const id = addAccount(db, 'me@example.test', 'Me', 'me-pass-123');
  createUser(db, 'other@example.test', 'Other', 'other-pass-1');
  const course = db.run("INSERT INTO courses (owner_id, code, name) VALUES (?, 'CPP', 'C++')", id).id;
  const term = db.run("INSERT INTO terms (owner_id, name, start_date, end_date) VALUES (?, 'T', '2026-09-01', '2027-01-31')", id).id;
  cls = db.run("INSERT INTO classes (term_id, course_id, teacher_id, code, start_date) VALUES (?, ?, ?, 'SY9', '2026-11-16')", term, course, id).id;
  ensureConfig(db, cls);
  enr = [];
  for (let i = 1; i <= 7; i++) {
    const st = db.run('INSERT INTO students (owner_id, student_code, name_latin) VALUES (?, ?, ?)', id, `2660${i}`, `Student ${i}`).id;
    enr.push(db.run("INSERT INTO enrollments (student_id, class_id, enrolled_on) VALUES (?, ?, '2026-11-16')", st, cls).id);
  }
  server = createApp(holder).listen(0);
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}/api`;
  cookie = await login('me@example.test', 'me-pass-123');
  other = await login('other@example.test', 'other-pass-1');
});
afterEach(() => { server.close(); db.close(); rmSync(dir, { recursive: true, force: true }); });

describe('student groups', () => {
  it('splits the class into groups, each student in one group of a list', async () => {
    const set = (await call(cookie, 'POST', `/classes/${cls}/group-sets`, { name: 'Final project', componentId: col('final'), groupMax: 25 })).body;
    const split = await call(cookie, 'POST', `/group-sets/${set.id}/split`, { size: 3 });
    expect(split.body).toEqual({ groups: 2, students: 7 }); // 7 students in groups of about 3: 4 + 3, not 3 + 3 + 1
    const v = (await call(cookie, 'GET', `/classes/${cls}/groups`)).body;
    const s = v.sets[0];
    expect(s.column).toMatchObject({ name: 'Final project', max: 40, groupMax: 25, individualMax: 15 });
    expect(s.groups.map((g: any) => g.members.length)).toEqual([4, 3]);
    expect(s.unassigned).toEqual([]);
    expect((await call(cookie, 'POST', `/group-sets/${set.id}/split`, { size: 3 })).status).toBe(422);

    // Moving a student to another group takes them out of the first one.
    const [g1, g2] = s.groups;
    const moved = g1.members[0].enrollmentId;
    expect((await call(cookie, 'POST', `/groups/${g2.id}/members`, { enrollmentIds: [moved] })).status).toBe(200);
    const after = (await call(cookie, 'GET', `/classes/${cls}/groups`)).body.sets[0].groups;
    expect(after.map((g: any) => g.members.length)).toEqual([3, 4]);

    // Another list (e.g. the midterm) groups students independently.
    const mid = (await call(cookie, 'POST', `/classes/${cls}/group-sets`, { name: 'Midterm' })).body;
    expect((await call(cookie, 'GET', `/classes/${cls}/groups`)).body.sets.find((x: any) => x.id === mid.id).unassigned).toHaveLength(7);
  });

  it('gives every member the group score plus their own, in the gradebook column', async () => {
    const set = (await call(cookie, 'POST', `/classes/${cls}/group-sets`, { name: 'Final project', componentId: col('final'), groupMax: 25 })).body;
    const g = (await call(cookie, 'POST', `/group-sets/${set.id}/groups`, { name: 'Team A', topic: 'Library system', exam: 'Paper B', enrollmentIds: enr.slice(0, 3) })).body;
    const r = await call(cookie, 'PUT', `/groups/${g.id}/scores`, { groupScore: 20, individual: { [enr[0]!]: 12, [enr[1]!]: 9.5 } });
    expect(r.body).toEqual({ written: 3 });
    expect([mark(enr[0]!, 'final'), mark(enr[1]!, 'final'), mark(enr[2]!, 'final')]).toEqual([32, 29.5, 20]);

    // Changing the group score changes every member's mark; individual scores are kept.
    await call(cookie, 'PUT', `/groups/${g.id}/scores`, { groupScore: 22 });
    expect([mark(enr[0]!, 'final'), mark(enr[1]!, 'final'), mark(enr[2]!, 'final')]).toEqual([34, 31.5, 22]);
    const view = (await call(cookie, 'GET', `/classes/${cls}/groups`)).body.sets[0].groups[0];
    expect(view).toMatchObject({ name: 'Team A', topic: 'Library system', exam: 'Paper B', groupScore: 22 });
    expect(view.members.find((m: any) => m.enrollmentId === enr[0]).mark).toBe(34);

    // The parts cannot pass their share of the column, and a student outside the group is refused.
    expect((await call(cookie, 'PUT', `/groups/${g.id}/scores`, { groupScore: 26 })).status).toBe(422);
    expect((await call(cookie, 'PUT', `/groups/${g.id}/scores`, { individual: { [enr[0]!]: 16 } })).status).toBe(422);
    expect((await call(cookie, 'PUT', `/groups/${g.id}/scores`, { individual: { [enr[5]!]: 5 } })).status).toBe(422);
    expect(mark(enr[0]!, 'final')).toBe(34);

    // Clearing both parts clears the mark.
    await call(cookie, 'PUT', `/groups/${g.id}/scores`, { groupScore: null, individual: { [enr[0]!]: null, [enr[1]!]: null } });
    expect([mark(enr[0]!, 'final'), mark(enr[2]!, 'final')]).toEqual([null, null]);

    // A finalized gradebook does not change.
    await call(cookie, 'PUT', `/groups/${g.id}/scores`, { groupScore: 10 });
    db.run("UPDATE grade_configs SET status = 'finalized' WHERE class_id = ?", cls);
    expect((await call(cookie, 'PUT', `/groups/${g.id}/scores`, { groupScore: 11 })).status).toBe(409);
    expect(mark(enr[2]!, 'final')).toBe(10);
  });

  it('works without a gradebook column, refuses the attendance column, and is private', async () => {
    expect((await call(cookie, 'POST', `/classes/${cls}/group-sets`, { name: 'x', componentId: col('attendance') })).status).toBe(422);
    expect((await call(cookie, 'POST', `/classes/${cls}/group-sets`, { name: 'x', componentId: col('final'), groupMax: 41 })).status).toBe(422);
    const set = (await call(cookie, 'POST', `/classes/${cls}/group-sets`, { name: 'Presentation' })).body;
    const g = (await call(cookie, 'POST', `/group-sets/${set.id}/groups`, { enrollmentIds: [enr[0]] })).body;
    expect((await call(cookie, 'PUT', `/groups/${g.id}/scores`, { groupScore: 7 })).body).toEqual({ written: 0 });
    expect((await call(cookie, 'GET', `/classes/${cls}/groups`)).body.sets[0].groups[0]).toMatchObject({ name: 'Group 1', groupScore: 7 });

    expect((await call(other, 'GET', `/classes/${cls}/groups`)).status).toBe(404);
    expect((await call(other, 'PUT', `/groups/${g.id}/scores`, { groupScore: 1 })).status).toBe(404);
    expect((await call(other, 'DELETE', `/group-sets/${set.id}`)).status).toBe(404);

    const b = exportBackup(db);
    expect(b.tables.group_sets).toHaveLength(1);
    expect(b.tables.group_members).toHaveLength(1);
    loadBackup(JSON.parse(JSON.stringify(b))).db.close();

    expect((await call(cookie, 'DELETE', `/groups/${g.id}/members/${enr[0]}`)).status).toBe(200);
    expect((await call(cookie, 'DELETE', `/group-sets/${set.id}`)).status).toBe(200);
    expect(db.get('SELECT COUNT(*) AS n FROM student_groups')!.n).toBe(0);
  });
});
