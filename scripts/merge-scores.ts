// Adds scores from a freshly imported workbook database into the live database, without replacing it.
//
//   npx tsx server/import-workbook.ts <workbook.xlsx> --db /tmp/new.sqlite
//   npx tsx scripts/merge-scores.ts /tmp/new.sqlite /var/lib/krubook/krubook.sqlite            # preview
//   npx tsx scripts/merge-scores.ts /tmp/new.sqlite /var/lib/krubook/krubook.sqlite --apply    # write
//
// Students are matched by class code plus Khmer and Latin name, components by key. Only scores the live
// database does not have yet are added, through the normal save path (validation, versions, activity
// log). A score that differs from the live one is listed, never overwritten: edit it in the gradebook.
// Students, sessions or teaching records that differ are listed too; this script does not change them.
import { DatabaseSync } from 'node:sqlite';
import { DB } from '../server/db.ts';
import type { User } from '../server/auth.ts';
import { applySync } from '../server/services/records.ts';

const [fromFile, toFile] = process.argv.slice(2).filter((a) => !a.startsWith('--'));
const apply = process.argv.includes('--apply');
if (!fromFile || !toFile) { console.error('Usage: tsx scripts/merge-scores.ts <imported.sqlite> <live.sqlite> [--apply]'); process.exit(2); }

const from = new DatabaseSync(fromFile, { readOnly: true });
const db = new DB(toFile);

const SCORES = `SELECT c.code cls, s.name_km km, s.name_latin lat, g.key comp, e.id enrollmentId, g.id componentId, x.value v
  FROM enrollments e JOIN students s ON s.id = e.student_id JOIN classes c ON c.id = e.class_id
  JOIN grade_configs gc ON gc.class_id = c.id JOIN grade_components g ON g.config_id = gc.id
  LEFT JOIN scores x ON x.enrollment_id = e.id AND x.component_id = g.id`;
const key = (r: any) => `${r.cls}|${r.km ?? ''}|${r.lat ?? ''}|${r.comp}`;
const live = new Map((db.all(SCORES) as any[]).map((r) => [key(r), r]));
const incoming = (from.prepare(SCORES).all() as any[]).filter((r) => r.v != null);

const add: any[] = [], differ: string[] = [], unmatched: string[] = [];
for (const r of incoming) {
  const l = live.get(key(r));
  if (!l) unmatched.push(`${key(r)} = ${r.v}`);
  else if (l.v == null) add.push({ ...r, enrollmentId: l.enrollmentId, componentId: l.componentId });
  else if (l.v !== r.v) differ.push(`${key(r)}: app ${l.v}, workbook ${r.v}`);
}

// Other differences this script does not apply, so nothing is silently ignored.
const other: string[] = [];
const STU = `SELECT c.code || '|' || IFNULL(s.name_km,'') || '|' || IFNULL(s.name_latin,'') || '|' || s.student_code k FROM enrollments e JOIN students s ON s.id = e.student_id JOIN classes c ON c.id = e.class_id`;
const TAUGHT = `SELECT c.code || '|' || s.date || '|' || s.status || '|' || (t.id IS NOT NULL) k FROM sessions s JOIN classes c ON c.id = s.class_id LEFT JOIN teaching_records t ON t.session_id = s.id`;
for (const [label, sql] of [['students/IDs', STU], ['sessions/taught', TAUGHT]] as const) {
  const a = new Set((db.all(sql) as any[]).map((r) => r.k)), b = new Set((from.prepare(sql).all() as any[]).map((r: any) => r.k));
  const n = [...b].filter((k) => !a.has(k)).length + [...a].filter((k) => !b.has(k)).length;
  if (n) other.push(`${label}: ${n} difference(s); review and change these in the app`);
}

const show = (t: string, rows: string[]) => { if (rows.length) { console.log(`\n${t} (${rows.length}):`); rows.forEach((r) => console.log(`  ${r}`)); } };
show('Scores to add', add.map((r) => `${key(r)} = ${r.v}`));
show('Scores that differ (not changed)', differ);
show('Scores with no matching student/component (not changed)', unmatched);
show('Other differences (not changed)', other);
if (!add.length) { console.log('\nNothing to add.'); process.exit(0); }
if (!apply) { console.log(`\nPreview only. Run again with --apply to add ${add.length} score(s).`); process.exit(0); }

const owner = db.get("SELECT u.id, u.email, u.name, u.role FROM users u JOIN classes c ON c.teacher_id = u.id LIMIT 1") as any;
const u: User = { id: owner.id, email: owner.email, name: owner.name, role: owner.role };
const results = applySync(db, u, add.map((r, i) => ({ type: 'score' as const, opId: `merge:${i}`, enrollmentId: r.enrollmentId, componentId: r.componentId, value: r.v, baseVersion: null })));
const failed = results.filter((r) => r.status !== 'applied');
console.log(`\nAdded ${results.length - failed.length} of ${add.length} score(s).`);
failed.forEach((f: any) => console.log(`  not added: ${add[+f.opId.split(':')[1]] && key(add[+f.opId.split(':')[1]])}: ${f.message ?? f.status}`));
process.exit(failed.length ? 1 : 0);
