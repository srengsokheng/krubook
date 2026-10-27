// Brings an updated workbook into the live database, without replacing it.
//
//   npx tsx server/import-workbook.ts <workbook.xlsx> --db /tmp/new.sqlite
//   npx tsx scripts/merge-scores.ts /tmp/new.sqlite /var/lib/krubook/krubook.sqlite            # preview
//   npx tsx scripts/merge-scores.ts /tmp/new.sqlite /var/lib/krubook/krubook.sqlite --apply    # write
//
// Students are matched by class code plus Khmer and Latin name, components by key, sessions by class
// and date. Through the app's normal save paths (validation, versions, activity log) it:
//   - adds scores the live database does not have yet;
//   - updates scores that changed in the workbook, but only if nobody edited them in the app
//     (version 1); a score edited in the app is listed, never overwritten;
//   - records sessions the workbook marks as taught that are still planned and not in the future,
//     the same way the Review page does (planned lesson part, full duration).
// Students added or missing, and sessions taught in the app but not in the workbook, are listed only.
import { DatabaseSync } from 'node:sqlite';
import { DB } from '../server/db.ts';
import type { User } from '../server/auth.ts';
import { applySync } from '../server/services/records.ts';
import { reconcileSessions } from '../server/services/reconcile.ts';
import { today } from '../server/services/access.ts';

const [fromFile, toFile] = process.argv.slice(2).filter((a) => !a.startsWith('--'));
const apply = process.argv.includes('--apply');
if (!fromFile || !toFile) { console.error('Usage: tsx scripts/merge-scores.ts <imported.sqlite> <live.sqlite> [--apply]'); process.exit(2); }

const from = new DatabaseSync(fromFile, { readOnly: true });
const db = new DB(toFile);
const owner = db.get('SELECT u.id, u.email, u.name, u.role FROM users u JOIN classes c ON c.teacher_id = u.id LIMIT 1') as any;
const u: User = { id: owner.id, email: owner.email, name: owner.name, role: owner.role };

// ---- Scores
const SCORES = `SELECT c.code cls, s.name_km km, s.name_latin lat, g.key comp, e.id enrollmentId, g.id componentId, x.value v, x.version ver
  FROM enrollments e JOIN students s ON s.id = e.student_id JOIN classes c ON c.id = e.class_id
  JOIN grade_configs gc ON gc.class_id = c.id JOIN grade_components g ON g.config_id = gc.id
  LEFT JOIN scores x ON x.enrollment_id = e.id AND x.component_id = g.id`;
const key = (r: any) => `${r.cls}|${r.km ?? ''}|${r.lat ?? ''}|${r.comp}`;
const live = new Map((db.all(SCORES) as any[]).map((r) => [key(r), r]));
const incoming = (from.prepare(SCORES).all() as any[]).filter((r) => r.v != null);

const add: any[] = [], update: any[] = [], edited: string[] = [], unmatched: string[] = [];
for (const r of incoming) {
  const l = live.get(key(r));
  if (!l) unmatched.push(`${key(r)} = ${r.v}`);
  else if (l.v == null) add.push({ ...r, enrollmentId: l.enrollmentId, componentId: l.componentId, base: null });
  else if (l.v !== r.v && l.ver === 1) update.push({ ...r, enrollmentId: l.enrollmentId, componentId: l.componentId, base: 1, old: l.v });
  else if (l.v !== r.v) edited.push(`${key(r)}: app ${l.v} (edited in the app), workbook ${r.v}`);
}

// ---- Sessions the workbook marks as taught
const now = today(db, u);
const SESS = `SELECT s.id, c.code cls, s.date, s.status, (t.id IS NOT NULL) taught FROM sessions s JOIN classes c ON c.id = s.class_id LEFT JOIN teaching_records t ON t.session_id = s.id`;
const liveSess = new Map((db.all(SESS) as any[]).map((r) => [`${r.cls}|${r.date}`, r]));
const wbSess = new Map((from.prepare(SESS).all() as any[]).map((r: any) => [`${r.cls}|${r.date}`, r]));
const teach: any[] = [], sessNotes: string[] = [];
for (const [k, w] of wbSess) {
  const l = liveSess.get(k);
  if (!w.taught || l?.taught) continue;
  if (!l) sessNotes.push(`${k}: taught in the workbook but not in the app's plan`);
  else if (l.status !== 'planned') sessNotes.push(`${k}: taught in the workbook but ${l.status} in the app`);
  else if (l.date > now) sessNotes.push(`${k}: taught in the workbook but in the future`);
  else teach.push(l);
}
for (const [k, l] of liveSess) if (l.taught && !wbSess.get(k)?.taught) sessNotes.push(`${k}: taught in the app, not in the workbook (kept)`);

// ---- Students (listed only)
const STU = `SELECT c.code || '|' || IFNULL(s.name_km,'') || '|' || IFNULL(s.name_latin,'') k FROM enrollments e JOIN students s ON s.id = e.student_id JOIN classes c ON c.id = e.class_id`;
const a = new Set((db.all(STU) as any[]).map((r) => r.k)), b = new Set((from.prepare(STU).all() as any[]).map((r: any) => r.k));
const students = [...[...b].filter((k) => !a.has(k)).map((k) => `${k}: in the workbook, not in the app`), ...[...a].filter((k) => !b.has(k)).map((k) => `${k}: in the app, not in the workbook (kept)`)];

const show = (t: string, rows: string[]) => { if (rows.length) { console.log(`\n${t} (${rows.length}):`); rows.forEach((r) => console.log(`  ${r}`)); } };
show('Scores to add', add.map((r) => `${key(r)} = ${r.v}`));
show('Scores to update (never edited in the app)', update.map((r) => `${key(r)}: ${r.old} → ${r.v}`));
show('Sessions to record as taught', teach.map((s) => `${s.cls} ${s.date}`));
show('Scores edited in the app (not changed)', edited);
show('Scores with no matching student/component (not changed)', unmatched);
show('Other session differences (not changed)', sessNotes);
show('Student differences (not changed)', students);
const total = add.length + update.length + teach.length;
if (!total) { console.log('\nNothing to change.'); process.exit(0); }
if (!apply) { console.log(`\nPreview only. Run again with --apply to make ${total} change(s).`); process.exit(0); }

const scoreOps = [...add, ...update];
const results = scoreOps.length ? applySync(db, u, scoreOps.map((r, i) => ({ type: 'score' as const, opId: `merge:${i}`, enrollmentId: r.enrollmentId, componentId: r.componentId, value: r.v, baseVersion: r.base }))) : [];
const failed = results.filter((r) => r.status !== 'applied');
failed.forEach((f: any) => console.log(`  score not saved: ${key(scoreOps[+f.opId.split(':')[1]])}: ${f.message ?? f.status}`));
let taught = 0;
if (teach.length) {
  const r = reconcileSessions(db, u, teach.map((s) => ({ sessionId: s.id, action: 'taught' as const, note: 'Marked completed in the workbook' })), false);
  taught = r.results.filter((x: any) => x.action === 'taught').length;
}
console.log(`\nScores added ${add.length - failed.filter((f: any) => +f.opId.split(':')[1] < add.length).length} of ${add.length}, updated ${update.length - failed.filter((f: any) => +f.opId.split(':')[1] >= add.length).length} of ${update.length}; sessions recorded as taught ${taught} of ${teach.length}.`);
process.exit(failed.length ? 1 : 0);
