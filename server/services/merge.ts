import { createHash } from 'node:crypto';
import { AppError, DB, type Row } from '../db.ts';
import type { User } from '../auth.ts';
import { getSetting, today } from './access.ts';
import { applySync } from './records.ts';
import { reconcileSessions } from './reconcile.ts';
import { importWorkbook } from './workbook.ts';
import { DEFAULT_TZ } from '../../shared/dates.ts';

// Brings an updated copy of the teaching workbook into the live database without replacing it.
// The workbook is read into a scratch in-memory database, then compared with the teacher's own
// classes. Students are matched by class code plus Khmer and Latin name, grade columns by key,
// sessions by class and date. Only three kinds of change are made, all through the normal save
// paths (validation, versions, activity log):
//   - scores the app does not have yet are added;
//   - scores that changed in the workbook are updated, but only if nobody edited them in the app
//     (version 1); a score edited in the app is listed, never overwritten;
//   - sessions the workbook marks as taught that are still planned and not in the future are
//     recorded as taught, the same way the Review page does.
// Everything else (new or missing students, sessions taught only in the app, attendance points the
// app now calculates from roll calls) is listed and left alone.

export interface ScoreChange { classCode: string; student: string; studentCode: string; component: string; enrollmentId: number; componentId: number; value: number; old: number | null; base: number | null }
export interface SessionChange { sessionId: number; classCode: string; date: string; start: string }
export interface MergePlan {
  add: ScoreChange[];
  update: ScoreChange[];
  teach: SessionChange[];
  kept: { editedInApp: string[]; attendanceCalculated: string[]; unmatched: string[]; sessions: string[]; students: string[] };
  fingerprint: string;
}

const SCORES = (own: boolean) => `SELECT c.code cls, s.name_km km, s.name_latin lat, s.student_code sc, g.key comp, g.name comp_name, g.kind, e.id enrollmentId, g.id componentId, x.value v, x.version ver,
    EXISTS (SELECT 1 FROM score_archive a WHERE a.enrollment_id = e.id AND a.component_id = g.id AND a.restored_at IS NULL) archived
  FROM enrollments e JOIN students s ON s.id = e.student_id JOIN classes c ON c.id = e.class_id
  JOIN grade_configs gc ON gc.class_id = c.id JOIN grade_components g ON g.config_id = gc.id
  LEFT JOIN scores x ON x.enrollment_id = e.id AND x.component_id = g.id ${own ? 'WHERE c.teacher_id = ?' : ''}`;
const SESS = (own: boolean) => `SELECT s.id, c.code cls, s.date, s.start_time, s.status, (t.id IS NOT NULL) taught FROM sessions s JOIN classes c ON c.id = s.class_id LEFT JOIN teaching_records t ON t.session_id = s.id ${own ? 'WHERE c.teacher_id = ?' : ''}`;
const STU = (own: boolean) => `SELECT c.code || '|' || IFNULL(s.name_km,'') || '|' || IFNULL(s.name_latin,'') k FROM enrollments e JOIN students s ON s.id = e.student_id JOIN classes c ON c.id = e.class_id ${own ? 'WHERE c.teacher_id = ?' : ''}`;

const key = (r: Row) => `${r.cls}|${r.km ?? ''}|${r.lat ?? ''}|${r.comp}`;
const who = (r: Row) => [r.km, r.lat].filter(Boolean).join(' · ');
const label = (k: string) => k.split('|').filter(Boolean).join(' · ');

/** Compares a scratch database (read from the workbook) with the teacher's classes in `db`. */
export function planMerge(from: DB, db: DB, u: User): MergePlan {
  const kept: MergePlan['kept'] = { editedInApp: [], attendanceCalculated: [], unmatched: [], sessions: [], students: [] };
  const add: ScoreChange[] = [], update: ScoreChange[] = [];
  const live = new Map(db.all(SCORES(true), u.id).map((r) => [key(r), r]));
  for (const r of from.all(SCORES(false)).filter((x) => x.v != null)) {
    const l = live.get(key(r));
    if (!l) { kept.unmatched.push(`${r.cls} ${who(r)}: ${r.comp_name} = ${r.v}`); continue; }
    const change = { classCode: l.cls, student: who(l), studentCode: l.sc, component: l.comp_name, enrollmentId: l.enrollmentId, componentId: l.componentId, value: r.v, old: l.v };
    if (l.v == null && l.kind === 'attendance' && l.archived) kept.attendanceCalculated.push(`${l.cls} ${who(l)}: workbook ${r.v}`);
    else if (l.v == null) add.push({ ...change, base: null });
    else if (l.v !== r.v && l.ver === 1) update.push({ ...change, base: 1 });
    else if (l.v !== r.v) kept.editedInApp.push(`${l.cls} ${who(l)}, ${l.comp_name}: app ${l.v}, workbook ${r.v}`);
  }

  const now = today(db, u);
  const liveSess = new Map(db.all(SESS(true), u.id).map((r) => [`${r.cls}|${r.date}`, r]));
  const wbSess = new Map(from.all(SESS(false)).map((r) => [`${r.cls}|${r.date}`, r]));
  const teach: SessionChange[] = [];
  for (const [k, w] of wbSess) {
    const l = liveSess.get(k);
    if (!w.taught || l?.taught) continue;
    if (!l) kept.sessions.push(`${label(k)}: taught in the workbook, but the app has no session that day`);
    else if (l.status !== 'planned') kept.sessions.push(`${label(k)}: taught in the workbook, but ${l.status} in the app`);
    else if (l.date > now) kept.sessions.push(`${label(k)}: taught in the workbook, but in the future`);
    else teach.push({ sessionId: l.id, classCode: l.cls, date: l.date, start: l.start_time });
  }
  const wbClasses = new Set([...wbSess.values()].map((r) => r.cls));
  for (const [k, l] of liveSess) if (l.taught && wbClasses.has(l.cls) && !wbSess.get(k)?.taught) kept.sessions.push(`${label(k)}: taught in the app, not in the workbook (kept)`);

  const a = new Set(db.all(STU(true), u.id).map((r) => r.k)), b = new Set(from.all(STU(false)).map((r) => r.k));
  const liveClasses = new Set([...a].map((k) => k.split('|')[0]));
  kept.students = [
    ...[...b].filter((k) => !a.has(k)).map((k) => `${label(k)}: in the workbook, not in the app${liveClasses.has(k.split('|')[0]) ? '' : ' (no such class in the app)'}`),
    ...[...a].filter((k) => !b.has(k) && wbClasses.has(k.split('|')[0])).map((k) => `${label(k)}: in the app, not in the workbook (kept)`),
  ];

  teach.sort((x, y) => x.classCode.localeCompare(y.classCode) || x.date.localeCompare(y.date));
  const fingerprint = createHash('sha256').update(JSON.stringify([add.map((c) => [c.enrollmentId, c.componentId, c.value]), update.map((c) => [c.enrollmentId, c.componentId, c.old, c.value]), teach.map((s) => s.sessionId)])).digest('hex').slice(0, 16);
  return { add, update, teach, kept, fingerprint };
}

export function applyMerge(db: DB, u: User, plan: MergePlan) {
  const scoreOps = [...plan.add, ...plan.update];
  const results = scoreOps.length ? applySync(db, u, scoreOps.map((c, i) => ({ type: 'score' as const, opId: `merge:${i}`, enrollmentId: c.enrollmentId, componentId: c.componentId, value: c.value, baseVersion: c.base }))) : [];
  const failed = results.flatMap((r, i) => (r.status === 'applied' ? [] : [{ what: `${scoreOps[i].classCode} ${scoreOps[i].student}, ${scoreOps[i].component}`, message: (r as any).message ?? r.status }]));
  const failedAdd = results.slice(0, plan.add.length).filter((r) => r.status !== 'applied').length;
  let taught = 0;
  if (plan.teach.length) {
    const r = reconcileSessions(db, u, plan.teach.map((s) => ({ sessionId: s.sessionId, action: 'taught' as const, note: 'Marked completed in the workbook' })), false);
    taught = r.results.filter((x: any) => x.action === 'taught').length;
  }
  return { added: plan.add.length - failedAdd, updated: plan.update.length - (failed.length - failedAdd), taught, failed };
}

/** Reads an uploaded workbook and shows what merging it would change. Nothing is saved. */
export async function previewWorkbook(db: DB, u: User, file: Buffer) {
  if (!file?.length) throw new AppError(422, 'Choose the workbook file (.xlsx) to upload.');
  const scratch = new DB(':memory:');
  try {
    const holidays = db.all('SELECT * FROM holidays WHERE owner_id = ? AND term_id IS NULL', u.id).map((h) => ({ date: h.date, endDate: h.end_date, name: h.name, nameKm: h.name_km, source: h.source, approx: h.approx, verifiedNote: h.verified_note }));
    const read = await importWorkbook(scratch, file, { today: today(db, u), timezone: getSetting(db, u.id, 'timezone', DEFAULT_TZ), holidays: holidays.length ? holidays : undefined });
    return { plan: planMerge(scratch, db, u), notes: read.report, summary: read.summary };
  } finally {
    scratch.close();
  }
}

/** Applies the same file, but only if the changes still match the preview the teacher approved. */
export async function applyWorkbook(db: DB, u: User, file: Buffer, fingerprint: string) {
  const { plan } = await previewWorkbook(db, u, file);
  if (plan.fingerprint !== fingerprint) throw new AppError(409, 'The data changed since the preview (an edit in the app, or a different file). Preview the workbook again.');
  if (!plan.add.length && !plan.update.length && !plan.teach.length) throw new AppError(409, 'Nothing to change: the app already matches this workbook.');
  return db.tx(() => {
    const out = applyMerge(db, u, plan);
    db.audit(u.id, 'workbook', null, 'merge', undefined, { added: out.added, updated: out.updated, taught: out.taught, failed: out.failed.length });
    return out;
  });
}
