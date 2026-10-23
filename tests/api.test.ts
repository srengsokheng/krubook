import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import ExcelJS from 'exceljs';
import { createApp, createHolder } from '../server/app.ts';
import { seedDemo, DEMO_LOGIN } from '../server/seed.ts';
import type { DBHolder } from '../server/routes.ts';

process.env.KRUBOOK_TODAY = '2026-10-24';

let server: Server, base: string, cookie = '', holder: DBHolder, dir: string;

async function api(method: string, path: string, body?: unknown, raw = false): Promise<any> {
  const res = await fetch(base + '/api' + path, {
    method,
    headers: { 'content-type': 'application/json', cookie },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const set = res.headers.get('set-cookie');
  if (set) cookie = set.split(';')[0];
  if (raw) return res;
  const json = await res.json().catch(() => null);
  return { status: res.status, ...(json ?? {}), body: json };
}

beforeAll(async () => {
  dir = mkdtempSync(join(tmpdir(), 'krubook-'));
  holder = createHolder(join(dir, 'test.sqlite'));
  seedDemo(holder.db);
  server = createApp(holder).listen(0);
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
afterAll(() => { server.close(); holder.db.close(); rmSync(dir, { recursive: true, force: true }); });

const cls = (code: string) => holder.db.get('SELECT * FROM classes WHERE code = ?', code)!;

describe('auth and access', () => {
  it('rejects unauthenticated requests and wrong passwords', async () => {
    expect((await api('GET', '/classes')).status).toBe(401);
    expect((await api('POST', '/auth/login', { email: DEMO_LOGIN.email, password: 'nope' })).status).toBe(401);
    expect((await api('POST', '/auth/login', DEMO_LOGIN)).status).toBe(200);
  });
});

describe('scheduling', () => {
  it('classes keep independent start dates', async () => {
    const a = await api('GET', `/classes/${cls('ASL3').id}/sessions`);
    const b = await api('GET', `/classes/${cls('SY14').id}/sessions`);
    expect(a.body[0].date).toBe('2026-09-07');
    expect(b.body[0].date).toBe('2026-09-29');
  });

  it('regenerating an untouched class does not duplicate sessions', async () => {
    const id = cls('SBQ3').id;
    const before = (await api('GET', `/classes/${id}/sessions`)).body.length;
    const r = await api('POST', `/classes/${id}/plan`, {});
    expect(r.created).toBe(0);
    expect((await api('GET', `/classes/${id}/sessions`)).body.length).toBe(before);
  });

  it('refuses to regenerate over teaching records', async () => {
    expect((await api('POST', `/classes/${cls('ASL3').id}/plan`, {})).status).toBe(409);
  });

  it('skips holidays: Pchum Ben Monday is cancelled for ASL3', async () => {
    const s = (await api('GET', `/classes/${cls('ASL3').id}/sessions`)).body.find((x: any) => x.date === '2026-10-12');
    expect(s.status).toBe('cancelled');
    expect(s.note).toMatch(/Pchum Ben/);
  });

  it('cancelling proposes a re-plan, and nothing changes until it is approved', async () => {
    const id = cls('SY33').id;
    const sessions = (await api('GET', `/classes/${id}/sessions`)).body;
    const target = sessions.find((s: any) => s.status === 'planned' && s.kind === 'lecture' && s.date > '2026-11-01');
    const nextLecture = sessions.find((s: any) => s.status === 'planned' && s.kind === 'lecture' && s.date > target.date);
    const r = await api('POST', `/sessions/${target.id}/cancel`, { reason: 'Staff meeting' });
    expect(r.proposal.changes.length).toBeGreaterThan(0);
    const shift = r.proposal.partShifts.find((p: any) => p.partId === target.part_id);
    expect(shift.oldDate).toBe(target.date);
    const still = (await api('GET', `/classes/${id}/sessions`)).body.find((s: any) => s.id === nextLecture.id);
    expect(still.part_id).toBe(nextLecture.part_id);
    expect((await api('POST', `/proposals/${r.proposal.id}/apply`)).applied).toBeGreaterThan(0);
    // The same week's Saturday meeting becomes the lecture and takes over the cancelled lesson.
    const after = (await api('GET', `/classes/${id}/sessions`)).body.find((s: any) => s.status === 'planned' && s.kind === 'lecture' && s.date > target.date);
    expect(after).toMatchObject({ week: target.week, part_id: target.part_id });
  });

  it('marks a stale proposal when the schedule changed after it was made', async () => {
    const id = cls('SY33').id;
    const sessions = (await api('GET', `/classes/${id}/sessions`)).body.filter((s: any) => s.status === 'planned' && s.date > '2026-11-01' && s.kind === 'lecture');
    const p = (await api('POST', `/sessions/${sessions[0].id}/cancel`, { reason: 'x' })).proposal;
    const changed = p.changes[p.changes.length - 1].sessionId;
    await api('PUT', `/sessions/${changed}`, { note: 'edited' });
    expect((await api('POST', `/proposals/${p.id}/apply`)).status).toBe(409);
  });

  it('moving a session keeps the original record', async () => {
    const id = cls('SY14').id;
    const s = (await api('GET', `/classes/${id}/sessions`)).body.find((x: any) => x.status === 'planned' && x.date > '2026-11-10');
    const r = await api('POST', `/sessions/${s.id}/move`, { date: '2026-11-21', start: '08:00', end: '09:30' });
    const list = (await api('GET', `/classes/${id}/sessions`)).body;
    expect(list.find((x: any) => x.id === s.id).status).toBe('moved');
    const moved = list.find((x: any) => x.id === r.id);
    expect(moved).toMatchObject({ date: '2026-11-21', moved_from_id: s.id, part_id: s.part_id, original_date: s.original_date });
  });

  it('detects double-booking on the timetable', async () => {
    const id = cls('ASL3').id;
    const r = await api('POST', `/classes/${id}/sessions`, { date: '2026-11-18', start: '15:30', end: '16:30', makeup: true });
    expect(r.overlaps.map((o: any) => o.code)).toContain('SY33');
    const tt = await api('GET', '/timetable?from=2026-11-16');
    expect(tt.overlaps.some((pair: number[]) => pair.includes(r.id))).toBe(true);
  });

  it('cancelled sessions do not count as taught, and future sessions cannot be completed', async () => {
    const id = cls('ASL3').id;
    const list = (await api('GET', `/classes/${id}/sessions`)).body;
    const cancelled = list.find((s: any) => s.status === 'cancelled');
    expect((await api('POST', `/sessions/${cancelled.id}/complete`, { parts: [] })).status).toBe(409);
    const future = list.find((s: any) => s.status === 'planned' && s.date > '2026-10-24');
    expect((await api('POST', `/sessions/${future.id}/complete`, { parts: [] })).status).toBe(422);
  });

  it('finishing early updates progress and the next lesson', async () => {
    const id = cls('SY33').id;
    const before = (await api('GET', `/classes/${id}`)).summary;
    const s = (await api('GET', `/classes/${id}/sessions`)).body.find((x: any) => x.date === '2026-10-24');
    const parts = (await api('GET', `/classes/${id}`)).parts;
    const idx = parts.findIndex((p: any) => p.id === before.progress.nextPartId);
    const r = await api('POST', `/sessions/${s.id}/complete`, { parts: [{ partId: parts[idx].id, coverage: 'full' }, { partId: parts[idx + 1].id, coverage: 'full' }], pace: 'early' });
    expect(r.summary.progress.actual).toBe(before.progress.actual + 2);
    expect(r.summary.nextPart.id).toBe(parts[idx + 2].id);
    expect(r.proposal).not.toBeNull();
  });
});

describe('gradebook', () => {
  it('a 105-point configuration is a draft and cannot be activated', async () => {
    const id = cls('SW33').id;
    const g = await api('GET', `/classes/${id}/gradebook`);
    expect(g.check).toMatchObject({ total: 105, valid: false });
    expect(g.config.status).toBe('draft');
    expect((await api('POST', `/classes/${id}/grade-config/status`, { status: 'active' })).status).toBe(422);
    // The database refuses it even if the API check were bypassed.
    expect(() => holder.db.run("UPDATE grade_configs SET status = 'active' WHERE class_id = ?", id)).toThrow(/GRADE_TOTAL_MISMATCH/);
  });

  it('becomes valid once the midterm is corrected to 20', async () => {
    const id = cls('SW33').id;
    const g = await api('GET', `/classes/${id}/gradebook`);
    const fixed = await api('PUT', `/classes/${id}/grade-config`, { ...g.config, components: g.config.components.map((c: any) => ({ ...c, max: c.key === 'midterm' ? 20 : c.max })) });
    expect(fixed.check.valid).toBe(true);
    const act = await api('POST', `/classes/${id}/grade-config/status`, { status: 'active' });
    expect(act.config.status).toBe('active');
  });

  it('rejects scores above the maximum, keeps empty distinct from zero, and updates totals', async () => {
    const id = cls('ASL3').id;
    const g = await api('GET', `/classes/${id}/gradebook`);
    const row = g.rows[0], lab3 = g.config.components.find((c: any) => c.key === 'lab3');
    const over = await api('POST', '/sync', { ops: [{ opId: 'a', type: 'score', enrollmentId: row.enrollmentId, componentId: lab3.id, value: 6, baseVersion: null }] });
    expect(over.results[0].status).toBe('error');
    expect(() => holder.db.run('INSERT INTO scores (enrollment_id, component_id, value) VALUES (?,?,?)', row.enrollmentId, lab3.id, 9)).toThrow(/SCORE_ABOVE_MAX/);
    const zero = await api('POST', '/sync', { ops: [{ opId: 'b', type: 'score', enrollmentId: row.enrollmentId, componentId: lab3.id, value: 0, baseVersion: null }] });
    expect(zero.results[0]).toMatchObject({ status: 'applied', version: 1 });
    const g2 = await api('GET', `/classes/${id}/gradebook`);
    const r2 = g2.rows.find((r: any) => r.enrollmentId === row.enrollmentId);
    expect(r2.values[lab3.id]).toBe(0);
    expect(r2.missing).not.toContain(lab3.id);
    expect(r2.total).toBe(row.total);
  });

  it('reports a conflict instead of overwriting a newer value', async () => {
    const id = cls('ASL3').id;
    const g = await api('GET', `/classes/${id}/gradebook`);
    const row = g.rows[1], lab4 = g.config.components.find((c: any) => c.key === 'lab4');
    await api('POST', '/sync', { ops: [{ opId: 'c1', type: 'score', enrollmentId: row.enrollmentId, componentId: lab4.id, value: 4, baseVersion: null }] });
    // A second device that still thinks the cell is empty tries to write 3.
    const r = await api('POST', '/sync', { ops: [{ opId: 'c2', type: 'score', enrollmentId: row.enrollmentId, componentId: lab4.id, value: 3, baseVersion: null }] });
    expect(r.results[0]).toMatchObject({ status: 'conflict', server: { value: 4, version: 1 } });
  });
});

describe('students and attendance', () => {
  it('import validation catches duplicate IDs and missing names', async () => {
    const id = cls('SBQ3').id;
    const r = await api('POST', `/classes/${id}/import/validate`, { rows: [
      { row: 2, student_code: '0990001', name_latin: 'NEW Student' },
      { row: 3, student_code: '0990001', name_km: 'សុខ ដារ៉ា' },
      { row: 4, student_code: '0990002' },
    ] });
    expect(r.issues.filter((i: any) => i.level === 'error').map((i: any) => i.row)).toEqual([3, 4]);
    expect((await api('POST', `/classes/${id}/import/commit`, { rows: [{ row: 2, student_code: '0990001', name_latin: 'A' }, { row: 3, student_code: '0990001', name_latin: 'B' }] })).status).toBe(422);
    const ok = await api('POST', `/classes/${id}/import/commit`, { rows: [{ row: 2, student_code: '00990003', name_km: 'ចាន់ សុភា', name_latin: 'CHAN Sophea' }] });
    expect(ok).toMatchObject({ created: 1, enrolled: 1 });
    expect(holder.db.get("SELECT student_code FROM students WHERE student_code = '00990003'")).toBeTruthy();
  });

  it('transferring keeps old grades and attendance with the old class', async () => {
    const from = cls('ASL3').id, to = cls('SY33').id;
    const g = await api('GET', `/classes/${from}/gradebook`);
    const row = g.rows.find((r: any) => r.total > 0);
    const r = await api('POST', `/enrollments/${row.enrollmentId}/transfer`, { toClassId: to });
    const old = (await api('GET', `/classes/${from}/gradebook`)).rows.find((x: any) => x.enrollmentId === row.enrollmentId);
    expect(old).toMatchObject({ enrollmentStatus: 'transferred', total: row.total });
    const fresh = (await api('GET', `/classes/${to}/gradebook`)).rows.find((x: any) => x.enrollmentId === r.enrollmentId);
    expect(fresh.total).toBe(0);
    expect(fresh.attendance.counted).toBe(0);
  });

  it('refuses attendance for cancelled sessions and for another class', async () => {
    const id = cls('ASL3').id;
    const list = (await api('GET', `/classes/${id}/sessions`)).body;
    const cancelled = list.find((s: any) => s.status === 'cancelled');
    const e = holder.db.get("SELECT id FROM enrollments WHERE class_id = ? AND status = 'active'", id)!;
    const r = await api('POST', '/sync', { ops: [{ opId: 'x', type: 'attendance', sessionId: cancelled.id, enrollmentId: e.id, status: 'absent', baseVersion: null }] });
    expect(r.results[0].status).toBe('error');
    const other = holder.db.get("SELECT id FROM enrollments WHERE class_id = ?", cls('SW33').id)!;
    const done = list.find((s: any) => s.status === 'completed');
    const r2 = await api('POST', '/sync', { ops: [{ opId: 'y', type: 'attendance', sessionId: done.id, enrollmentId: other.id, status: 'present', baseVersion: null }] });
    expect(r2.results[0].status).toBe('error');
    expect((await api('GET', `/sessions/${cancelled.id}/attendance`)).editable).toBe(false);
  });

  it('attendance score follows the configured late/excused policy', async () => {
    const id = cls('SY14').id;
    const before = (await api('GET', `/classes/${id}/attendance`)).students.find((s: any) => s.late > 0);
    const g = await api('GET', `/classes/${id}/gradebook`);
    await api('PUT', `/classes/${id}/grade-config`, { ...g.config, attendanceRule: { lateCredit: 1, excused: 'exclude' } });
    const after = (await api('GET', `/classes/${id}/attendance`)).students.find((s: any) => s.enrollmentId === before.enrollmentId);
    expect(after.score).toBeGreaterThan(before.score);
  });
});

describe('reports, exports and backup', () => {
  it('dashboard and pay come from recorded data', async () => {
    const d = await api('GET', '/dashboard');
    expect(d.today).toBe('2026-10-24');
    expect(d.progress.length).toBe(6);
    const pay = await api('GET', '/pay?year=2026');
    const recorded = holder.db.get("SELECT COUNT(*) AS n FROM teaching_records r JOIN sessions s ON s.id = r.session_id WHERE s.date LIKE '2026-%'")!.n;
    expect(pay.months.reduce((s: number, m: any) => s + m.taughtSessions, 0)).toBe(recorded);
  });

  it('exported gradebook totals match the gradebook and keep IDs as text', async () => {
    const id = cls('ASL3').id;
    const g = await api('GET', `/classes/${id}/gradebook`);
    const res = await api('GET', `/export/gradebook/${id}`, undefined, true);
    const wb = new ExcelJS.Workbook();
    await wb.xlsx.load(await res.arrayBuffer());
    const ws = wb.worksheets[0];
    const header = ws.getRow(7);
    const totalCol = (header.values as any[]).findIndex((v) => String(v).startsWith('Total'));
    const first = ws.getRow(8);
    expect(first.getCell(2).value).toBe(g.rows[0].code);
    expect(typeof first.getCell(2).value).toBe('string');
    expect(first.getCell(totalCol).value).toBe(g.rows[0].total);
    expect(first.getCell(3).value).toBe(g.rows[0].nameKm);
  });

  it('term plan export uses real dates', async () => {
    const res = await api('GET', `/export/plan/${cls('ASL3').id}`, undefined, true);
    const wb = new ExcelJS.Workbook();
    await wb.xlsx.load(await res.arrayBuffer());
    expect(wb.worksheets[0].getRow(7).getCell(2).value).toBeInstanceOf(Date);
  });

  it('backup round-trips with every relationship intact', async () => {
    const b = (await api('GET', '/backup.json')).body;
    expect(b.counts.attendance).toBeGreaterThan(1000);
    const dry = await api('POST', '/restore?dryRun=1', b);
    expect(dry).toMatchObject({ valid: true });
    expect(dry.counts).toEqual(b.counts);
    const tampered = { ...b, tables: { ...b.tables, scores: b.tables.scores.slice(1) } };
    expect((await api('POST', '/restore?dryRun=1', tampered)).status).toBe(422);
    const real = await api('POST', '/restore', b);
    expect(real.restored).toBe(true);
    // Login sessions are not part of a backup, so the teacher signs in again.
    expect((await api('GET', '/classes')).status).toBe(401);
    await api('POST', '/auth/login', DEMO_LOGIN);
    const g = await api('GET', `/classes/${cls('ASL3').id}/gradebook`);
    expect(g.rows.length).toBeGreaterThan(40);
  });
});
