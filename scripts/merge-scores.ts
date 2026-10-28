// Brings an updated workbook into the live database, without replacing it. The app's Import page
// does the same from an upload; this is the server-side equivalent (rules in server/services/merge.ts).
//
//   npx tsx server/import-workbook.ts <workbook.xlsx> --db /tmp/new.sqlite
//   npx tsx scripts/merge-scores.ts /tmp/new.sqlite /var/lib/krubook/krubook.sqlite            # preview
//   npx tsx scripts/merge-scores.ts /tmp/new.sqlite /var/lib/krubook/krubook.sqlite --apply    # write
import { DB } from '../server/db.ts';
import type { User } from '../server/auth.ts';
import { applyMerge, planMerge } from '../server/services/merge.ts';

const [fromFile, toFile] = process.argv.slice(2).filter((a) => !a.startsWith('--'));
const apply = process.argv.includes('--apply');
if (!fromFile || !toFile) { console.error('Usage: tsx scripts/merge-scores.ts <imported.sqlite> <live.sqlite> [--apply]'); process.exit(2); }

const from = new DB(fromFile);
const db = new DB(toFile);
const owner = db.get('SELECT u.id, u.email, u.name, u.role FROM users u JOIN classes c ON c.teacher_id = u.id LIMIT 1') as any;
const u: User = { id: owner.id, email: owner.email, name: owner.name, role: owner.role };
const plan = planMerge(from, db, u);

const show = (t: string, rows: string[]) => { if (rows.length) { console.log(`\n${t} (${rows.length}):`); rows.forEach((r) => console.log(`  ${r}`)); } };
show('Scores to add', plan.add.map((c) => `${c.classCode} ${c.student}, ${c.component} = ${c.value}`));
show('Scores to update (never edited in the app)', plan.update.map((c) => `${c.classCode} ${c.student}, ${c.component}: ${c.old} → ${c.value}`));
show('Sessions to record as taught', plan.teach.map((s) => `${s.classCode} ${s.date}`));
show('Scores edited in the app (not changed)', plan.kept.editedInApp);
show('Attendance points now calculated from roll calls (not changed)', plan.kept.attendanceCalculated);
show('Scores with no matching student/component (not changed)', plan.kept.unmatched);
show('Other session differences (not changed)', plan.kept.sessions);
show('Student differences (not changed)', plan.kept.students);
const total = plan.add.length + plan.update.length + plan.teach.length;
if (!total) { console.log('\nNothing to change.'); process.exit(0); }
if (!apply) { console.log(`\nPreview only. Run again with --apply to make ${total} change(s).`); process.exit(0); }

const r = db.tx(() => applyMerge(db, u, plan));
r.failed.forEach((f) => console.log(`  not saved: ${f.what}: ${f.message}`));
console.log(`\nScores added ${r.added} of ${plan.add.length}, updated ${r.updated} of ${plan.update.length}; sessions recorded as taught ${r.taught} of ${plan.teach.length}.`);
process.exit(r.failed.length ? 1 : 0);
