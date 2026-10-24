// Small database helper for the backup shell scripts (plain Node, no dependencies).
//   node dbtool.cjs snapshot <db> <out>   consistent copy via VACUUM INTO
//   node dbtool.cjs check <db>            integrity, broken links, orphans and row counts; exit 1 on problems
//   node dbtool.cjs status <file> <ok 1|0> [error] [backup file] [bytes] [sha256] [startedAt]
const fs = require('node:fs');
const { DatabaseSync } = require('node:sqlite');
const [cmd, ...args] = process.argv.slice(2);

if (cmd === 'snapshot') {
  const [db, out] = args;
  if (fs.existsSync(out)) fs.rmSync(out);
  new DatabaseSync(db, { readOnly: true }).exec(`VACUUM INTO '${out.replace(/'/g, "''")}'`);
} else if (cmd === 'check') {
  const d = new DatabaseSync(args[0], { readOnly: true });
  const integrity = d.prepare('PRAGMA integrity_check').get().integrity_check;
  const brokenLinks = d.prepare('PRAGMA foreign_key_check').all().length;
  const has = new Set(d.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all().map((r) => r.name));
  const tables = ['users', 'courses', 'classes', 'sessions', 'teaching_records', 'students', 'enrollments', 'scores', 'attendance', 'rates', 'pay_statements', 'pay_adjustments', 'holidays', 'audit_log'];
  const counts = Object.fromEntries(tables.filter((t) => has.has(t)).map((t) => [t, d.prepare(`SELECT COUNT(*) AS n FROM ${t}`).get().n]));
  const orphans = d.prepare(`SELECT
      (SELECT COUNT(*) FROM enrollments e LEFT JOIN students s ON s.id = e.student_id WHERE s.id IS NULL) +
      (SELECT COUNT(*) FROM scores x LEFT JOIN enrollments e ON e.id = x.enrollment_id WHERE e.id IS NULL) +
      (SELECT COUNT(*) FROM attendance a LEFT JOIN sessions s ON s.id = a.session_id WHERE s.id IS NULL) AS n`).get().n;
  const schemaVersion = d.prepare('SELECT version FROM schema_meta').get().version;
  console.log(JSON.stringify({ integrity, brokenLinks, orphans, schemaVersion, counts }));
  if (integrity !== 'ok' || brokenLinks || orphans) process.exit(1);
} else if (cmd === 'status') {
  const [file, ok, error, backup, bytes, sha256, startedAt] = args;
  fs.writeFileSync(file, JSON.stringify({ ok: ok === '1', startedAt: startedAt || null, finishedAt: new Date().toISOString(), file: backup || null, bytes: Number(bytes) || null, sha256: sha256 || null, error: error || null }, null, 2));
} else {
  console.error('usage: dbtool.cjs snapshot|check|status …');
  process.exit(2);
}
