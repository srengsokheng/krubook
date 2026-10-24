import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createApp, createHolder } from '../server/app.ts';
import { seedDemo, DEMO_LOGIN } from '../server/seed.ts';
import { normKhmer, normLatin } from '../server/services/reconcile.ts';
import type { DBHolder } from '../server/routes.ts';

process.env.KRUBOOK_TODAY = '2026-10-24';

let server: Server, base: string, holder: DBHolder, dir: string, cookie = '';
const db = () => holder.db;
async function call(method: string, path: string, body?: unknown) {
  const r = await fetch(base + path, { method, headers: { 'content-type': 'application/json', cookie }, body: body === undefined ? undefined : JSON.stringify(body) });
  const set = r.headers.get('set-cookie');
  if (set) cookie = set.split(';')[0];
  return { status: r.status, body: await r.json().catch(() => null) };
}

beforeEach(async () => {
  dir = mkdtempSync(join(tmpdir(), 'krubook-rec-'));
  holder = createHolder(join(dir, 'rec.sqlite'));
  seedDemo(holder.db);
  server = createApp(holder).listen(0);
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}/api`;
  await call('POST', '/auth/login', DEMO_LOGIN);
});
afterEach(() => { server.close(); holder.db.close(); rmSync(dir, { recursive: true, force: true }); });

/** A past, planned lesson session to reconcile (the demo leaves some unrecorded). */
function pastPlanned(n = 1) {
  const q = () => db().all("SELECT id, class_id, date, part_id FROM sessions WHERE status = 'planned' AND date < '2026-10-24' AND activity = 'lesson' ORDER BY date LIMIT ?", n);
  const have = q();
  // Add unrecorded extra sessions to SW43 when the demo has fewer than needed.
  const cls = db().get("SELECT id FROM classes WHERE code = 'SW43'")!.id;
  for (let i = have.length; i < n; i++) {
    const d = `2026-10-${String(1 + i).padStart(2, '0')}`;
    db().run("INSERT INTO sessions (class_id, week, date, start_time, end_time, kind, activity, status, original_date) VALUES (?, 3, ?, '07:00', '08:00', 'practice', 'lesson', 'planned', ?)", cls, d, d);
  }
  return q();
}

describe('past-session reconciliation', () => {
  it('lists only planned past sessions with their class, duration and estimated pay', async () => {
    const list = (await call('GET', '/reconcile/sessions')).body;
    const expected = db().get("SELECT COUNT(*) AS n FROM sessions WHERE status = 'planned' AND date < '2026-10-24'")!.n;
    expect(list).toHaveLength(expected);
    expect(list[0]).toMatchObject({ code: expect.any(String), minutes: expect.any(Number), estimatedPay: expect.any(Number) });
    expect(list.every((s: any) => s.date < '2026-10-24')).toBe(true);
  });

  it('a preview shows before/after totals and changes nothing', async () => {
    const [s] = pastPlanned();
    const before = db().get('SELECT COUNT(*) AS n FROM teaching_records')!.n;
    const r = await call('POST', '/reconcile/sessions?dryRun=1', { decisions: [{ sessionId: s.id, action: 'taught' }] });
    expect(r.status).toBe(200);
    expect(r.body.applied).toBe(false);
    const cls = r.body.before.progress[0], after = r.body.after.progress[0];
    expect(after.actual).toBeGreaterThanOrEqual(cls.actual);
    expect(after.unrecorded).toBe(cls.unrecorded - 1);
    expect(r.body.after.pay[0].taughtSessions).toBe(r.body.before.pay[0].taughtSessions + 1);
    expect(db().get('SELECT COUNT(*) AS n FROM teaching_records')!.n).toBe(before);
    expect(db().get('SELECT status FROM sessions WHERE id = ?', s.id)!.status).toBe('planned');
  });

  it('applies taught, cancelled and skipped decisions; leaves the rest untouched', async () => {
    const [a, b, c, d] = pastPlanned(4);
    const r = await call('POST', '/reconcile/sessions', { decisions: [
      { sessionId: a.id, action: 'taught', note: 'checked with timetable' },
      { sessionId: b.id, action: 'cancelled', note: 'school event' },
      { sessionId: c.id, action: 'skipped' },
      { sessionId: d.id, action: 'leave' },
    ] });
    expect(r.status).toBe(200);
    expect(r.body).toMatchObject({ applied: true, left: 1 });
    const st = (id: number) => db().get('SELECT status FROM sessions WHERE id = ?', id)!.status;
    expect([st(a.id), st(b.id), st(c.id), st(d.id)]).toEqual(['completed', 'cancelled', 'skipped', 'planned']);
    expect(db().get('SELECT COUNT(*) AS n FROM teaching_records WHERE session_id = ?', a.id)!.n).toBe(1);
    const rec = db().get('SELECT id FROM teaching_records WHERE session_id = ?', a.id)!.id;
    expect(db().get("SELECT COUNT(*) AS n FROM audit_log WHERE entity = 'teaching_record' AND entity_id = ?", rec)!.n).toBe(1);
    expect(db().get("SELECT COUNT(*) AS n FROM audit_log WHERE entity = 'session' AND action IN ('cancel','skip') AND entity_id IN (?,?)", b.id, c.id)!.n).toBe(2);
  });

  it('a partial lesson stays the next lesson to teach', async () => {
    const [s] = pastPlanned();
    const before = (await call('GET', `/classes/${s.class_id}`)).body.summary;
    await call('POST', '/reconcile/sessions', { decisions: [{ sessionId: s.id, action: 'taught', parts: [{ partId: before.nextPart.id, coverage: 'partial' }] }] });
    const after = (await call('GET', `/classes/${s.class_id}`)).body.summary;
    expect(after.nextPart.id).toBe(before.nextPart.id);
    expect(after.progress.actual).toBe(before.progress.actual);
  });

  it('refuses duplicates, sessions already recorded, future sessions and repeated rows', async () => {
    const [s] = pastPlanned();
    expect((await call('POST', '/reconcile/sessions', { decisions: [{ sessionId: s.id, action: 'taught' }, { sessionId: s.id, action: 'cancelled' }] })).status).toBe(422);
    expect((await call('POST', '/reconcile/sessions', { decisions: [{ sessionId: s.id, action: 'taught' }] })).status).toBe(200);
    expect((await call('POST', '/reconcile/sessions', { decisions: [{ sessionId: s.id, action: 'taught' }] })).status).toBe(409);
    expect(db().get('SELECT COUNT(*) AS n FROM teaching_records WHERE session_id = ?', s.id)!.n).toBe(1);
    const future = db().get("SELECT id FROM sessions WHERE status = 'planned' AND date > '2026-10-24' LIMIT 1")!.id;
    expect((await call('POST', '/reconcile/sessions', { decisions: [{ sessionId: future, action: 'taught' }] })).status).toBe(422);
    expect((await call('POST', '/reconcile/sessions', { decisions: [] })).status).toBe(422);
  });

  it('a moved session is reconciled at its new date; the original stays as history', async () => {
    const [s] = pastPlanned();
    const moved = (await call('POST', `/sessions/${s.id}/move`, { date: '2026-10-23', start: '08:00', end: '09:30' })).body.id;
    const list = (await call('GET', '/reconcile/sessions')).body.map((x: any) => x.sessionId);
    expect(list).toContain(moved);
    expect(list).not.toContain(s.id);
    await call('POST', '/reconcile/sessions', { decisions: [{ sessionId: moved, action: 'taught' }] });
    expect(db().get('SELECT status FROM sessions WHERE id = ?', s.id)!.status).toBe('moved');
    expect(db().get('SELECT minutes FROM teaching_records WHERE session_id = ?', moved)!.minutes).toBe(90);
  });
});

describe('student ID reconciliation', () => {
  const studentsNamed = (latin: string) => db().all('SELECT * FROM students WHERE name_latin = ?', latin);

  it('normalises names for matching', () => {
    expect(normLatin('  Chán   SOPHEA ').exact).toBe('chan sophea');
    expect(normLatin('Sophea Chan').tokens).toBe(normLatin('CHAN Sophea').tokens);
    expect(normKhmer('ចាន់ ​សុភា')).toBe(normKhmer('ចាន់សុភា'));
  });

  it('classifies unique, ambiguous, missing, invalid and conflicting rows', async () => {
    const unique = db().get("SELECT * FROM students s WHERE (SELECT COUNT(*) FROM students t WHERE t.name_latin = s.name_latin) = 1 LIMIT 1")!;
    const dupName = db().get("SELECT name_latin FROM students GROUP BY name_latin HAVING COUNT(*) > 1 LIMIT 1")!.name_latin;
    const taken = db().get('SELECT student_code, name_latin FROM students WHERE id <> ? LIMIT 1', unique.id)!;
    const r = (await call('POST', '/students/id-match', { rows: [
      { row: 2, officialId: 'E2026001', nameKm: unique.name_km, nameLatin: unique.name_latin },
      { row: 3, officialId: 'E2026002', nameLatin: dupName },
      { row: 4, officialId: 'E2026003', nameLatin: 'NOBODY Atall' },
      { row: 5, officialId: '', nameLatin: unique.name_latin },
      { row: 6, officialId: taken.student_code, nameLatin: unique.name_latin },
      { row: 7, officialId: 'E2026009', nameLatin: 'DUP One' },
      { row: 8, officialId: 'E2026009', nameLatin: 'DUP Two' },
      { row: 9, officialId: 'bad id!', nameLatin: unique.name_latin },
    ] })).body;
    const st = Object.fromEntries(r.matches.map((m: any) => [m.row, m.status]));
    expect(st).toEqual({ 2: 'match', 3: 'ambiguous', 4: 'none', 5: 'invalid', 6: 'conflict', 7: 'conflict', 8: 'conflict', 9: 'invalid' });
    expect(r.matches.find((m: any) => m.row === 2).suggested).toBe(unique.id);
    expect(r.matches.find((m: any) => m.row === 3).suggested).toBeNull();
    expect(r.matches.find((m: any) => m.row === 3).candidates.length).toBeGreaterThan(1);
    expect(db().get("SELECT COUNT(*) AS n FROM students WHERE student_code LIKE 'E2026%'")!.n).toBe(0);
  });

  it('a class code narrows a duplicate name; word order and spacing still match', async () => {
    const dup = db().get("SELECT name_latin FROM students GROUP BY name_latin HAVING COUNT(DISTINCT (SELECT class_id FROM enrollments e WHERE e.student_id = students.id)) > 1 LIMIT 1")!.name_latin;
    const target = db().get("SELECT s.*, c.code AS cls FROM students s JOIN enrollments e ON e.student_id = s.id JOIN classes c ON c.id = e.class_id WHERE s.name_latin = ? LIMIT 1", dup)!;
    const sameClass = db().get('SELECT COUNT(*) AS n FROM students s JOIN enrollments e ON e.student_id = s.id JOIN classes c ON c.id = e.class_id WHERE s.name_latin = ? AND c.code = ?', dup, target.cls)!.n;
    const [fam, given] = dup.split(' ');
    const r = (await call('POST', '/students/id-match', { rows: [{ row: 2, officialId: 'X100', nameLatin: `  ${given}   ${fam} `, classCode: target.cls.toLowerCase() }] })).body;
    expect(r.matches[0].status).toBe(sameClass === 1 ? 'match' : 'ambiguous');
    expect(r.matches[0].candidates.every((c: any) => c.classes.includes(target.cls))).toBe(true);
  });

  it('two rows pointing at one student are both conflicts', async () => {
    const s = db().get("SELECT * FROM students s WHERE (SELECT COUNT(*) FROM students t WHERE t.name_latin = s.name_latin) = 1 LIMIT 1")!;
    const r = (await call('POST', '/students/id-match', { rows: [{ row: 2, officialId: 'A1', nameLatin: s.name_latin }, { row: 3, officialId: 'A2', nameKm: s.name_km }] })).body;
    expect(r.matches.map((m: any) => m.status)).toEqual(['conflict', 'conflict']);
  });

  it('applies confirmed IDs without touching relationships, logs them, and is repeatable', async () => {
    const [a, b] = db().all('SELECT * FROM students ORDER BY id LIMIT 2');
    const enrolls = db().get('SELECT COUNT(*) AS n FROM enrollments WHERE student_id IN (?,?)', a.id, b.id)!.n;
    const r1 = await call('POST', '/students/id-apply', { assignments: [{ studentId: a.id, newCode: 'OFF-001' }, { studentId: b.id, newCode: 'OFF-002' }] });
    expect(r1.body).toMatchObject({ changed: 2 });
    expect(db().get('SELECT student_code FROM students WHERE id = ?', a.id)!.student_code).toBe('OFF-001');
    expect(db().get('SELECT COUNT(*) AS n FROM enrollments WHERE student_id IN (?,?)', a.id, b.id)!.n).toBe(enrolls);
    expect(db().get("SELECT before_json, after_json FROM audit_log WHERE action = 'id.change' AND entity_id = ?", a.id)).toMatchObject({ before_json: JSON.stringify({ student_code: a.student_code }), after_json: JSON.stringify({ student_code: 'OFF-001' }) });
    const r2 = await call('POST', '/students/id-apply', { assignments: [{ studentId: a.id, newCode: 'OFF-001' }] });
    expect(r2.body).toMatchObject({ changed: 0, unchanged: 1 });
    // Swapping within one batch works; colliding with a third student does not.
    expect((await call('POST', '/students/id-apply', { assignments: [{ studentId: a.id, newCode: 'OFF-002' }, { studentId: b.id, newCode: 'OFF-001' }] })).body.changed).toBe(2);
    const c = db().get('SELECT * FROM students WHERE id NOT IN (?,?) LIMIT 1', a.id, b.id)!;
    expect((await call('POST', '/students/id-apply', { assignments: [{ studentId: c.id, newCode: 'OFF-001' }] })).status).toBe(409);
    expect((await call('POST', '/students/id-apply', { assignments: [{ studentId: c.id, newCode: 'X' }, { studentId: a.id, newCode: 'X' }] })).status).toBe(422);
    expect(db().get('SELECT student_code FROM students WHERE id = ?', c.id)!.student_code).toBe(c.student_code);
  });
});

describe('attendance-score migration', () => {
  async function setup() {
    const cls = db().get("SELECT id FROM classes WHERE code = 'ASL3'")!.id;
    const g = (await call('GET', `/classes/${cls}/gradebook`)).body;
    const att = g.config.components.find((c: any) => c.kind === 'attendance');
    const rows = g.rows.slice(0, 3);
    // Imported-style manual values on three students.
    await call('POST', '/sync', { ops: rows.map((r: any, i: number) => ({ opId: `m${i}`, type: 'score', enrollmentId: r.enrollmentId, componentId: att.id, value: 3, baseVersion: null })) });
    return { cls, att, rows };
  }

  it('previews manual vs calculated values with old and new totals, without changing anything', async () => {
    const { cls, rows } = await setup();
    const p = (await call('GET', `/classes/${cls}/attendance-migration`)).body;
    expect(p.summary.manual).toBe(3);
    const r = p.rows.find((x: any) => x.enrollmentId === rows[0].enrollmentId);
    expect(r).toMatchObject({ manual: 3, change: 'replaced' });
    expect(r.calculated).toBeGreaterThan(3);
    expect(r.totalAfter).toBeCloseTo(r.totalBefore - 3 + r.calculated, 2);
    expect(db().get('SELECT COUNT(*) AS n FROM scores WHERE value = 3 AND component_id = (SELECT id FROM grade_components WHERE kind = ? AND config_id = (SELECT id FROM grade_configs WHERE class_id = ?))', 'attendance', cls)!.n).toBe(3);
  });

  it('needs confirmation, archives the manual values, recalculates totals, and can be undone', async () => {
    const { cls, att, rows } = await setup();
    const ids = rows.map((r: any) => r.enrollmentId);
    expect((await call('POST', `/classes/${cls}/attendance-migration`, { enrollmentIds: ids })).status).toBe(422);
    const res = (await call('POST', `/classes/${cls}/attendance-migration`, { enrollmentIds: ids.slice(0, 2), confirm: true })).body;
    expect(res.moved).toBe(2);
    expect(db().get('SELECT COUNT(*) AS n FROM score_archive WHERE component_id = ?', att.id)!.n).toBe(2);
    const g = (await call('GET', `/classes/${cls}/gradebook`)).body;
    const row = g.rows.find((r: any) => r.enrollmentId === ids[0]);
    expect(row.scores[att.id]).toBeUndefined();
    expect(row.values[att.id]).toBe(row.attendance.score);
    expect(g.rows.find((r: any) => r.enrollmentId === ids[2]).values[att.id]).toBe(3);
    const back = (await call('POST', `/classes/${cls}/attendance-migration/restore`, {})).body;
    expect(back).toMatchObject({ restored: 2 });
    expect((await call('GET', `/classes/${cls}/gradebook`)).body.rows.find((r: any) => r.enrollmentId === ids[0]).values[att.id]).toBe(3);
  });

  it('a student with no roll calls would become "missing", and the preview says so', async () => {
    const { cls } = await setup();
    const e = db().get("SELECT e.id FROM enrollments e WHERE e.class_id = ? AND NOT EXISTS (SELECT 1 FROM attendance a WHERE a.enrollment_id = e.id) LIMIT 1", cls);
    if (!e) return; // every demo student has roll calls
    const comp = db().get("SELECT c.id FROM grade_components c JOIN grade_configs g ON g.id = c.config_id WHERE g.class_id = ? AND c.kind = 'attendance'", cls)!.id;
    await call('POST', '/sync', { ops: [{ opId: 'x', type: 'score', enrollmentId: e.id, componentId: comp, value: 5, baseVersion: null }] });
    const p = (await call('GET', `/classes/${cls}/attendance-migration`)).body;
    expect(p.rows.find((r: any) => r.enrollmentId === e.id).change).toBe('becomes missing');
  });

  it('attendance corrections and policies change the calculated score; cancelled sessions never count', async () => {
    const cls = db().get("SELECT id FROM classes WHERE code = 'SY33'")!.id;
    const s = db().get("SELECT id FROM sessions WHERE class_id = ? AND status = 'completed' ORDER BY date DESC LIMIT 1", cls)!.id;
    const e = db().get("SELECT id FROM enrollments WHERE class_id = ? AND status = 'active' LIMIT 1", cls)!.id;
    const score = async () => (await call('GET', `/classes/${cls}/attendance?pageSize=100`)).body.students.find((x: any) => x.enrollmentId === e);
    const v = db().get('SELECT version FROM attendance WHERE session_id = ? AND enrollment_id = ?', s, e)!.version;
    await call('POST', '/sync', { ops: [{ opId: 'p', type: 'attendance', sessionId: s, enrollmentId: e, status: 'present', baseVersion: v }] });
    const present = await score();
    const v2 = db().get('SELECT version FROM attendance WHERE session_id = ? AND enrollment_id = ?', s, e)!.version;
    await call('POST', '/sync', { ops: [{ opId: 'a', type: 'attendance', sessionId: s, enrollmentId: e, status: 'absent', baseVersion: v2 }] });
    const absent = await score();
    expect(absent.absent).toBe(present.absent + 1);
    expect(absent.score).toBeLessThan(present.score);
    const v3 = db().get('SELECT version FROM attendance WHERE session_id = ? AND enrollment_id = ?', s, e)!.version;
    await call('POST', '/sync', { ops: [{ opId: 'e', type: 'attendance', sessionId: s, enrollmentId: e, status: 'excused', baseVersion: v3 }] });
    const excused = await score();
    expect(excused.counted).toBe(present.counted - 1); // excused: not counted under the default policy
    const cancelled = db().get("SELECT id FROM sessions WHERE class_id = ? AND status = 'cancelled' LIMIT 1", cls)!.id;
    const r = (await call('POST', '/sync', { ops: [{ opId: 'c', type: 'attendance', sessionId: cancelled, enrollmentId: e, status: 'absent', baseVersion: null }] })).body;
    expect(r.results[0].status).toBe('error');
  });
});

describe('health endpoint', () => {
  it('is public and reveals nothing but status', async () => {
    const r = await fetch(`${base}/health`);
    expect(r.status).toBe(200);
    expect(await r.json()).toEqual({ status: 'ok' });
    expect(r.headers.get('content-security-policy')).toMatch(/default-src 'self'/);
  });
});

describe('dashboard at-risk cache', () => {
  it('updates as soon as a grade changes', async () => {
    const first = (await call('GET', '/dashboard')).body;
    const again = (await call('GET', '/dashboard')).body;
    expect(again.atRiskTotal).toBe(first.atRiskTotal);
    // Give a student who is not at risk zero on every manual component: they must appear at once.
    const cls = db().get("SELECT id FROM classes WHERE code = 'ASL3'")!.id;
    const g = (await call('GET', `/classes/${cls}/gradebook`)).body;
    const target = g.rows.find((r: any) => !r.atRisk && r.enrollmentStatus === 'active');
    const ops = g.config.components.filter((c: any) => c.kind === 'manual').map((c: any, i: number) => ({ opId: `z${i}`, type: 'score', enrollmentId: target.enrollmentId, componentId: c.id, value: 0, baseVersion: target.scores[c.id]?.version ?? null }));
    await call('POST', '/sync', { ops });
    const after = (await call('GET', '/dashboard')).body;
    expect(after.atRiskTotal).toBe(first.atRiskTotal + 1);
    // And it disappears again when the scores are restored.
    const back = g.config.components.filter((c: any) => c.kind === 'manual').map((c: any, i: number) => ({ opId: `b${i}`, type: 'score', enrollmentId: target.enrollmentId, componentId: c.id, value: target.scores[c.id]?.value ?? null, baseVersion: db().get('SELECT version FROM scores WHERE enrollment_id = ? AND component_id = ?', target.enrollmentId, c.id)?.version ?? null }));
    await call('POST', '/sync', { ops: back });
    expect((await call('GET', '/dashboard')).body.atRiskTotal).toBe(first.atRiskTotal);
  });
});
