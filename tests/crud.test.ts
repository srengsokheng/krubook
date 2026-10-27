import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createApp, createHolder } from '../server/app.ts';
import { createUser } from '../server/auth.ts';
import { seedDemo, DEMO_LOGIN } from '../server/seed.ts';
import type { DBHolder } from '../server/routes.ts';

// Create / read / update / delete for every entity through the real HTTP API and database.
process.env.KRUBOOK_TODAY = '2026-10-24';

let server: Server, base: string, holder: DBHolder, dir: string;
const jars: Record<string, string> = {};

async function call(method: string, path: string, body?: unknown, who = 'admin', rawBody?: string, headers: Record<string, string> = {}) {
  const r = await fetch(base + path, { method, headers: { 'content-type': 'application/json', cookie: jars[who] ?? '', ...headers }, body: rawBody ?? (body === undefined ? undefined : JSON.stringify(body)) });
  const set = r.headers.get('set-cookie');
  if (set) jars[who] = set.split(';')[0];
  return { status: r.status, body: await r.json().catch(() => null), setCookie: set };
}
const ok = (r: { status: number; body: any }) => { expect(r.status, JSON.stringify(r.body)).toBe(200); return r.body; };

beforeAll(async () => {
  dir = mkdtempSync(join(tmpdir(), 'krubook-crud-'));
  holder = createHolder(join(dir, 'crud.sqlite'));
  seedDemo(holder.db);
  createUser(holder.db, 'second@example.test', 'Second Teacher', 'second-pass-1', 'teacher');
  server = createApp(holder).listen(0);
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}/api`;
  ok(await call('POST', '/auth/login', DEMO_LOGIN));
  ok(await call('POST', '/auth/login', { email: 'second@example.test', password: 'second-pass-1' }, 'second'));
});
afterAll(() => { server.close(); holder.db.close(); rmSync(dir, { recursive: true, force: true }); });

describe('courses, lessons, parts and materials', () => {
  let course: number, lesson: number, part: number, material: number;
  it('create, read, update', async () => {
    course = ok(await call('POST', '/courses', { code: 'NEW1', name: 'New course', color: '#123456' })).id;
    expect(ok(await call('GET', `/courses/${course}`))).toMatchObject({ code: 'NEW1', template: expect.any(Array) });
    ok(await call('PUT', `/courses/${course}`, { name: 'Renamed' }));
    expect(ok(await call('GET', `/courses/${course}`)).name).toBe('Renamed');
    lesson = ok(await call('POST', `/courses/${course}/lessons`, { title: 'Intro', parts: ['A', 'B'], estMinutes: 90 })).id;
    ok(await call('PUT', `/lessons/${lesson}`, { title: 'Introduction' }));
    const c = ok(await call('GET', `/courses/${course}`));
    expect(c.lessons[0]).toMatchObject({ title: 'Introduction', est_minutes: 90 });
    expect(c.lessons[0].parts.map((p: any) => p.label)).toEqual(['A', 'B']);
    part = c.lessons[0].parts[1].id;
    ok(await call('PUT', `/parts/${part}`, { title: 'Applied', estMinutes: 45 }));
    ok(await call('POST', `/parts/${part}/move`, { direction: 'up' }));
    expect(ok(await call('GET', `/courses/${course}`)).lessons[0].parts[0]).toMatchObject({ id: part, title: 'Applied' });
    material = ok(await call('POST', '/materials', { lessonId: lesson, kind: 'slides', title: 'Deck', status: 'in_progress' })).id;
    ok(await call('PUT', `/materials/${material}`, { status: 'ready' }));
    expect(ok(await call('GET', `/courses/${course}`)).lessons[0].materials[0].status).toBe('ready');
  });
  it('validates input', async () => {
    expect((await call('POST', '/courses', { code: '', name: 'x' })).status).toBe(422);
    expect((await call('POST', '/courses', { code: 'NEW1', name: 'dup' })).status).toBe(409);
    expect((await call('POST', `/courses/${course}/lessons`, { title: 'x', estMinutes: -5 })).status).toBe(422);
    expect((await call('POST', `/courses/${course}/lessons`, { title: 'x', parts: 'A' })).status).toBe(422);
    expect((await call('PUT', `/courses/${course}`, { color: 'red' })).status).toBe(422);
  });
  it('delete', async () => {
    ok(await call('DELETE', `/materials/${material}`));
    ok(await call('DELETE', `/parts/${part}`));
    ok(await call('DELETE', `/lessons/${lesson}`));
    ok(await call('DELETE', `/courses/${course}`));
    expect((await call('GET', `/courses/${course}`)).status).toBe(404);
    const used = holder.db.get('SELECT course_id FROM classes LIMIT 1')!.course_id;
    expect((await call('DELETE', `/courses/${used}`)).status).toBe(409);
    const taughtLesson = holder.db.get('SELECT p.lesson_id FROM record_parts rp JOIN lesson_parts p ON p.id = rp.part_id LIMIT 1')!.lesson_id;
    expect((await call('DELETE', `/lessons/${taughtLesson}`)).status).toBe(409);
  });
});

describe('terms, holidays and classes', () => {
  let term: number, cls: number;
  it('terms: create, update, clone, delete rules', async () => {
    term = ok(await call('POST', '/terms', { name: 'Test term', startDate: '2027-02-01', endDate: '2027-06-30' })).id;
    ok(await call('PUT', `/terms/${term}`, { midtermStart: '2027-04-01', midtermEnd: '2027-04-05' }));
    expect(ok(await call('GET', `/terms/${term}`))).toMatchObject({ midterm_start: '2027-04-01' });
    expect((await call('POST', '/terms', { name: 'Bad', startDate: '2027-02-01', endDate: '2027-01-01' })).status).toBe(422);
    const src = holder.db.get('SELECT id FROM terms ORDER BY id LIMIT 1')!.id;
    const clone = ok(await call('POST', `/terms/${src}/clone`, { name: 'Clone', startDate: '2027-02-08', endDate: '2027-06-30' }));
    expect(clone.classes).toBeGreaterThan(0);
    expect(holder.db.get('SELECT COUNT(*) AS n FROM enrollments e JOIN classes c ON c.id = e.class_id WHERE c.term_id = ?', clone.id)!.n).toBe(0);
    expect((await call('DELETE', `/terms/${clone.id}`)).status).toBe(409);
  });
  it('preferences: saved per account, validated, language kept in settings', async () => {
    expect(ok(await call('GET', '/prefs')).lang).toBe('en');
    expect(ok(await call('PUT', '/prefs', { 'pageSize.students': 25, 'sort.students': 'name', lang: 'km' }))).toMatchObject({ 'pageSize.students': 25, 'sort.students': 'name', lang: 'km' });
    expect(ok(await call('GET', '/prefs'))).toMatchObject({ 'pageSize.students': 25, lang: 'km' });
    expect(ok(await call('GET', '/settings')).language).toBe('km');
    expect((await call('PUT', '/prefs', { 'pageSize.students': 30 })).status).toBe(422);
    expect((await call('PUT', '/prefs', { theme: 'dark' })).status).toBe(422);
    expect((await call('PUT', '/prefs', { lang: 'fr' })).status).toBe(422);
    ok(await call('PUT', '/prefs', { lang: 'en', 'pageSize.students': 10 }));
  });
  it('lists default to 10 rows per page', async () => {
    expect(ok(await call('GET', '/students')).pageSize).toBe(10);
    expect(ok(await call('GET', '/audit')).pageSize).toBe(10);
  });
  it('holidays: a range is one entry; edit, overlap, delete', async () => {
    const r = ok(await call('POST', '/holidays', { date: '2027-03-01', endDate: '2027-03-03', name: 'Break', termId: term }));
    expect(r.days).toBe(3);
    expect(holder.db.get("SELECT COUNT(*) AS n FROM holidays WHERE name = 'Break'")!.n).toBe(1);
    expect(holder.db.get('SELECT date, end_date FROM holidays WHERE id = ?', r.id)).toEqual({ date: '2027-03-01', end_date: '2027-03-03' });
    // A range may cover another holiday; a second holiday starting on the same day is a duplicate.
    const inside = ok(await call('POST', '/holidays', { date: '2027-03-02', name: 'Inside day', termId: term })).id;
    expect((await call('POST', '/holidays', { date: '2027-03-01', name: 'Same start', termId: term })).status).toBe(409);
    ok(await call('DELETE', `/holidays/${inside}`));
    ok(await call('PUT', `/holidays/${r.id}`, { name: 'Spring break', endDate: '2027-03-07' }));
    expect(holder.db.get('SELECT name, end_date FROM holidays WHERE id = ?', r.id)).toEqual({ name: 'Spring break', end_date: '2027-03-07' });
    ok(await call('PUT', `/holidays/${r.id}`, { endDate: null }));
    expect(holder.db.get('SELECT end_date FROM holidays WHERE id = ?', r.id)!.end_date).toBeNull();
    ok(await call('DELETE', `/holidays/${r.id}`));
    expect(holder.db.get("SELECT COUNT(*) AS n FROM holidays WHERE name IN ('Break','Spring break')")!.n).toBe(0);
    expect((await call('POST', '/holidays', { date: '2027-03-01', endDate: '2027-02-01', name: 'x' })).status).toBe(422);
    expect((await call('POST', '/holidays', { date: '2027-03-01', endDate: '2027-06-01', name: 'x' })).status).toBe(422);
  });
  it('classes: create, meetings, update, plan, delete term when empty', async () => {
    const course = holder.db.get('SELECT id FROM courses LIMIT 1')!.id;
    cls = ok(await call('POST', '/classes', { termId: term, courseId: course, code: 'TST1', startDate: '2027-02-01' })).id;
    expect((await call('PUT', `/classes/${cls}/meetings`, { meetings: [{ weekday: 1, start: '09:00', end: '08:00' }] })).status).toBe(422);
    expect((await call('PUT', `/classes/${cls}/meetings`, { meetings: [{ weekday: 1, start: '08:00', end: '10:00' }, { weekday: 1, start: '09:00', end: '11:00' }] })).status).toBe(422);
    ok(await call('PUT', `/classes/${cls}/meetings`, { meetings: [{ weekday: 1, start: '08:00', end: '10:00' }, { weekday: 3, start: '08:00', end: '10:00' }] }));
    ok(await call('PUT', `/classes/${cls}`, { room: 'B12', progressTolerance: 1 }));
    expect(ok(await call('GET', `/classes/${cls}`))).toMatchObject({ room: 'B12', progress_tolerance: 1 });
    expect(ok(await call('POST', `/classes/${cls}/plan`, {})).created).toBeGreaterThan(30);
    expect((await call('POST', '/classes', { termId: term, courseId: course, code: 'TST1', startDate: '2027-02-01' })).status).toBe(409);
  });
  it('sessions: add, edit, cancel, restore, move, delete only what is allowed', async () => {
    const make = ok(await call('POST', `/classes/${cls}/sessions`, { date: '2027-02-06', start: '08:00', end: '09:00', makeup: true }));
    ok(await call('PUT', `/sessions/${make.id}`, { note: 'Saturday make-up' }));
    expect(holder.db.get('SELECT note FROM sessions WHERE id = ?', make.id)!.note).toBe('Saturday make-up');
    ok(await call('DELETE', `/sessions/${make.id}`));
    expect(holder.db.get('SELECT 1 FROM sessions WHERE id = ?', make.id)).toBeUndefined();
    const gen = holder.db.get("SELECT id FROM sessions WHERE class_id = ? AND gen_key IS NOT NULL AND status = 'planned' ORDER BY date LIMIT 1", cls)!.id;
    expect((await call('DELETE', `/sessions/${gen}`)).status).toBe(409);
    ok(await call('POST', `/sessions/${gen}/cancel`, { reason: 'Test' }));
    ok(await call('POST', `/sessions/${gen}/restore`));
    expect(holder.db.get('SELECT status FROM sessions WHERE id = ?', gen)!.status).toBe('planned');
    expect((await call('POST', `/sessions/${gen}/move`, { date: 'not-a-date', start: '08:00', end: '09:00' })).status).toBe(422);
  });
});

describe('students and enrollments', () => {
  it('create, search in Khmer, update, delete only without history', async () => {
    const cls = holder.db.get("SELECT id FROM classes WHERE status = 'active' LIMIT 1")!.id;
    const id = ok(await call('POST', '/students', { code: '000777', nameKm: 'សុខ ពិសិដ្ឋ', nameLatin: 'SOK Piseth' })).id;
    const found = ok(await call('GET', `/students?q=${encodeURIComponent('ពិសិដ្ឋ')}`));
    expect(found.items.map((s: any) => s.student_code)).toContain('000777');
    ok(await call('PUT', `/students/${id}`, { email: 'piseth@example.test' }));
    expect(ok(await call('GET', `/students/${id}`))).toMatchObject({ email: 'piseth@example.test', student_code: '000777' });
    expect((await call('POST', '/students', { code: '000777', nameLatin: 'Dup' })).status).toBe(409);
    expect((await call('POST', '/students', { code: '000778' })).status).toBe(422);
    ok(await call('POST', `/classes/${cls}/enroll`, { studentIds: [id] }));
    expect((await call('POST', `/classes/${cls}/enroll`, { studentIds: [id] })).status).toBe(409);
    expect((await call('DELETE', `/students/${id}`)).status).toBe(409);
    const e = holder.db.get('SELECT id FROM enrollments WHERE student_id = ?', id)!.id;
    ok(await call('POST', `/enrollments/${e}/status`, { status: 'dropped', note: 'left' }));
    expect(holder.db.get('SELECT status FROM enrollments WHERE id = ?', e)!.status).toBe('dropped');
    const lonely = ok(await call('POST', '/students', { code: '000779', nameLatin: 'No Class' })).id;
    ok(await call('DELETE', `/students/${lonely}`));
    expect((await call('GET', `/students/${lonely}`)).status).toBe(404);
  });
});

describe('pagination', () => {
  it('pages, sizes, sorting and search work across the whole list', async () => {
    const total = holder.db.get('SELECT COUNT(*) AS n FROM students')!.n;
    const p1 = ok(await call('GET', '/students?page=1&pageSize=10&sort=code'));
    expect(p1).toMatchObject({ total, page: 1, pageSize: 10, pages: Math.ceil(total / 10) });
    expect(p1.items).toHaveLength(10);
    const p2 = ok(await call('GET', '/students?page=2&pageSize=10&sort=code'));
    expect(p2.items[0].student_code > p1.items[9].student_code).toBe(true);
    const last = ok(await call('GET', `/students?page=${p1.pages}&pageSize=10&sort=code`));
    expect(last.items.length).toBe(total - (p1.pages - 1) * 10);
    const desc = ok(await call('GET', '/students?pageSize=10&sort=code&dir=desc'));
    const all = holder.db.all('SELECT student_code FROM students ORDER BY student_code DESC LIMIT 1');
    expect(desc.items[0].student_code).toBe(all[0].student_code);
    expect(ok(await call('GET', '/students?page=999&pageSize=10')).items).toEqual([]);
    expect(ok(await call('GET', '/students?q=zzzz-no-match')).total).toBe(0);
    for (const bad of ['page=0', 'page=-1', 'page=abc', 'pageSize=7', 'pageSize=1000']) expect((await call('GET', `/students?${bad}`)).status).toBe(400);
  });
  it('attendance summary and audit log are paged', async () => {
    const cls = holder.db.get("SELECT id FROM classes WHERE status = 'active' LIMIT 1")!.id;
    const a = ok(await call('GET', `/classes/${cls}/attendance?page=2&pageSize=10`));
    expect(a).toMatchObject({ page: 2, pageSize: 10 });
    expect(a.students).toHaveLength(10);
    expect(new Set(a.cells.map((c: any) => c.enrollment_id)).size).toBeLessThanOrEqual(10);
    const log = ok(await call('GET', '/audit?pageSize=10'));
    expect(log.items.length).toBe(10);
    expect(log.total).toBeGreaterThan(10);
  });
});

describe('security', () => {
  it('rejects anonymous requests and hides other teachers’ records', async () => {
    expect((await call('GET', '/classes', undefined, 'nobody')).status).toBe(401);
    const cls = holder.db.get('SELECT id FROM classes LIMIT 1')!.id;
    expect((await call('GET', `/classes/${cls}`, undefined, 'second')).status).toBe(404);
    expect((await call('GET', `/classes/${cls}/gradebook`, undefined, 'second')).status).toBe(404);
    expect(ok(await call('GET', '/students', undefined, 'second')).total).toBe(0);
    const e = holder.db.get('SELECT id FROM enrollments LIMIT 1')!.id;
    const comp = holder.db.get('SELECT id FROM grade_components LIMIT 1')!.id;
    const r = ok(await call('POST', '/sync', { ops: [{ opId: 'x', type: 'score', enrollmentId: e, componentId: comp, value: 1, baseVersion: null }] }, 'second'));
    expect(r.results[0].status).toBe('error');
    expect((await call('GET', '/backup.json', undefined, 'second')).status).toBe(403);
  });
  it('answers malformed JSON with a JSON error', async () => {
    const r = await call('POST', '/courses', undefined, 'admin', '{"code":');
    expect(r.status).toBe(400);
    expect(r.body.error).toMatch(/not valid JSON/);
  });
  it('marks the session cookie Secure behind the HTTPS proxy, and not on plain local HTTP', async () => {
    const proxied = await call('POST', '/auth/login', DEMO_LOGIN, 'proxy', undefined, { 'x-forwarded-proto': 'https' });
    expect(proxied.setCookie).toMatch(/; Secure/);
    expect(proxied.setCookie).toMatch(/HttpOnly/);
    expect(proxied.setCookie).toMatch(/SameSite=Lax/);
    const plain = await call('POST', '/auth/login', DEMO_LOGIN, 'plain');
    expect(plain.setCookie).not.toMatch(/Secure/);
  });
  it('rate-limits repeated failed sign-ins', async () => {
    let last = 0;
    for (let i = 0; i < 11; i++) last = (await call('POST', '/auth/login', { email: 'x@example.test', password: 'wrong' }, 'brute')).status;
    expect(last).toBe(429);
  });
});

describe('settings', () => {
  it('saves valid settings and rejects invalid ones', async () => {
    ok(await call('PUT', '/settings', { notifyTime: '07:30', statusLabels: { completed: 'Done' } }));
    expect(ok(await call('GET', '/settings'))).toMatchObject({ notifyTime: '07:30', statusLabels: { completed: 'Done' } });
    expect((await call('PUT', '/settings', { timezone: 'Mars/Base' })).status).toBe(422);
    expect((await call('PUT', '/settings', { notifyTime: '25:00' })).status).toBe(422);
  });
});
