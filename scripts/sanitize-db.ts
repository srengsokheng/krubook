// Copies a database for staging with personal data replaced. Structure, dates, schedules, scores
// and attendance stay the same, so migrations and workflows can be tested realistically.
//   npx tsx scripts/sanitize-db.ts <source.sqlite> <staging.sqlite>
import { copyFileSync, existsSync, rmSync } from 'node:fs';
import { DB } from '../server/db.ts';
import { hashPassword } from '../server/auth.ts';

const [src, out] = process.argv.slice(2);
if (!src || !out) { console.error('usage: sanitize-db.ts <source> <out>'); process.exit(1); }
for (const f of [out, `${out}-wal`, `${out}-shm`]) if (existsSync(f)) rmSync(f);
copyFileSync(src, out);
const db = new DB(out);
db.tx(() => {
  for (const s of db.all('SELECT id FROM students')) {
    db.run("UPDATE students SET student_code = ?, name_km = ?, name_latin = ?, email = NULL, phone = NULL, notes = NULL, custom = '{}' WHERE id = ?",
      `STG${String(s.id).padStart(5, '0')}`, `សិស្ស ${s.id}`, `Student ${s.id}`, s.id);
  }
  db.run("UPDATE users SET email = 'staging-' || id || '@example.test', name = 'Staging user ' || id, password_hash = ?", hashPassword('staging-password'));
  db.run('DELETE FROM auth_sessions');
  db.run("DELETE FROM settings WHERE key LIKE 'notify.%'");
  db.run('UPDATE audit_log SET before_json = NULL, after_json = NULL');
  db.run('DELETE FROM notification_log');
});
db.raw.exec('VACUUM');
console.log(`Sanitised copy written to ${out}. Sign in as staging-<id>@example.test / staging-password.`);
db.close();
