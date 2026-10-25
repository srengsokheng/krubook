// Starts the built app on a fresh demo database for browser tests. Never touches real data.
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createApp, createHolder } from '../server/app.ts';
import { seedDemo } from '../server/seed.ts';

process.env.KRUBOOK_TODAY ??= '2026-10-24';
const holder = createHolder(join(mkdtempSync(join(tmpdir(), 'krubook-e2e-')), 'e2e.sqlite'));
seedDemo(holder.db);
// A student with a very long name, to catch clipping and overflow.
holder.db.run("INSERT INTO students (owner_id, student_code, name_km, name_latin) VALUES (1, '0999999', 'សុវណ្ណារ័ត្នទេពីបញ្ញាសាស្ត្រ ចន្ទ្រាវិសាលសុភក្ត្រា', 'SOVANNARATHTEPY Panhasastra Chantreavisalsopheaktra')");
holder.db.run("INSERT INTO enrollments (student_id, class_id, enrolled_on) VALUES ((SELECT id FROM students WHERE student_code = '0999999'), 1, '2026-09-07')");
const port = Number(process.env.E2E_PORT ?? 4320);
createApp(holder, { staticDir: join(import.meta.dirname, '..', 'web', 'dist') }).listen(port, '127.0.0.1', () => console.log(`e2e server on ${port}`));
