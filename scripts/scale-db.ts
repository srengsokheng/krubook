// Makes a large test database from a real one: ~10x students, attendance for every taught
// session, and audit history. Used only with scripts/bench.ts.
//   npx tsx scripts/scale-db.ts data/import-test.sqlite data/scale-test.sqlite
import { copyFileSync, existsSync, rmSync } from 'node:fs';
import { DB } from '../server/db.ts';

const [src = 'data/import-test.sqlite', out = 'data/scale-test.sqlite'] = process.argv.slice(2);
for (const f of [out, out + '-wal', out + '-shm']) if (existsSync(f)) rmSync(f);
copyFileSync(src, out);
const db = new DB(out);
const owner = db.get('SELECT id FROM users ORDER BY id')!.id;
const classes = db.all("SELECT id, start_date FROM classes");
let seq = 0;
db.tx(() => {
  for (const c of classes) {
    const comps = db.all('SELECT c.id, c.max_score, c.kind FROM grade_components c JOIN grade_configs g ON g.id = c.config_id WHERE g.class_id = ?', c.id);
    const held = db.all("SELECT id FROM sessions WHERE class_id = ? AND status = 'completed'", c.id);
    for (let i = 0; i < 360; i++) {
      const sid = db.run('INSERT INTO students (owner_id, student_code, name_km, name_latin) VALUES (?,?,?,?)', owner, `S${String(++seq).padStart(6, '0')}`, `សិស្ស ${seq}`, `Student ${seq}`).id;
      const eid = db.run('INSERT INTO enrollments (student_id, class_id, enrolled_on) VALUES (?,?,?)', sid, c.id, c.start_date).id;
      for (const comp of comps) if (comp.kind === 'manual' && (seq + comp.id) % 3 === 0) db.run('INSERT INTO scores (enrollment_id, component_id, value) VALUES (?,?,?)', eid, comp.id, Math.min(comp.max_score, (seq % 5) + 1));
      for (const s of held) db.run('INSERT INTO attendance (session_id, enrollment_id, status) VALUES (?,?,?)', s.id, eid, ['present', 'present', 'late', 'absent'][(seq + s.id) % 4]);
    }
  }
  for (let i = 0; i < 20000; i++) db.run("INSERT INTO audit_log (user_id, entity, entity_id, action) VALUES (?, 'score', ?, 'update')", owner, i);
});
for (const t of ['students', 'enrollments', 'attendance', 'scores', 'audit_log']) console.log(t, db.get(`SELECT COUNT(*) n FROM ${t}`)!.n);
db.close();
