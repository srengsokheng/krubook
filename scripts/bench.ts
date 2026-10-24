// Times the main API endpoints against a copy of a real database.
//   npx tsx scripts/bench.ts data/import-test.sqlite
// The copy gets a throwaway account; the source file is never modified.
import { copyFileSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AddressInfo } from 'node:net';
import { createApp, createHolder } from '../server/app.ts';
import { addAccount } from '../server/auth.ts';

const src = process.argv[2] ?? 'data/import-test.sqlite';
const dir = mkdtempSync(join(tmpdir(), 'krubook-bench-'));
const file = join(dir, 'bench.sqlite');
copyFileSync(src, file);
process.env.KRUBOOK_TODAY ??= '2026-10-24';
const holder = createHolder(file);
if (!holder.db.get("SELECT 1 FROM users WHERE email = 'bench@example.test'")) addAccount(holder.db, 'bench@example.test', 'Bench', 'bench-password-1');
const server = createApp(holder).listen(0);
const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}/api`;
const login = await fetch(`${base}/auth/login`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ email: 'bench@example.test', password: 'bench-password-1' }) });
const cookie = login.headers.get('set-cookie')!.split(';')[0];
const cls = holder.db.get('SELECT id FROM classes ORDER BY id')!.id;
const student = holder.db.get('SELECT id FROM students ORDER BY id')!.id;
const paths = ['/dashboard', '/classes', `/classes/${cls}`, `/classes/${cls}/gradebook`, `/classes/${cls}/sessions`, `/classes/${cls}/attendance`, '/students', `/students/${student}`, '/timetable', '/pay?year=2026', '/courses'];
const rows: Array<[string, number, number]> = [];
for (const p of paths) {
  const times: number[] = [];
  let bytes = 0;
  for (let i = 0; i < 7; i++) {
    const t = performance.now();
    const r = await fetch(base + p, { headers: { cookie } });
    bytes = (await r.arrayBuffer()).byteLength;
    if (!r.ok) throw new Error(`${p} -> ${r.status}`);
    times.push(performance.now() - t);
  }
  times.sort((a, b) => a - b);
  rows.push([p, Math.round(times[3] * 10) / 10, bytes]);
}
console.table(rows.map(([path, ms, bytes]) => ({ path, 'median ms': ms, 'KB': Math.round(bytes / 102.4) / 10 })));
server.close(); holder.db.close(); rmSync(dir, { recursive: true, force: true });
