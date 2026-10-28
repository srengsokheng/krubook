// One-off import of the old "Teaching_Schedule_and_Progress.xlsx" workbook into a new database.
//
//   npx tsx server/import-workbook.ts <workbook.xlsx> --db data/krubook.sqlite [--materials D:\Work\Teaching]
//
// The first account created with `krubook-user add` claims the imported data. To bring a newer
// copy of the workbook into a live database, upload it on the app's Import page instead (or see
// scripts/merge-scores.ts).
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { DB } from './db.ts';
import { importWorkbook } from './services/workbook.ts';

const args = process.argv.slice(2);
const opt = (name: string) => { const i = args.indexOf(name); return i >= 0 ? args[i + 1] : undefined; };
const workbookPath = args.find((a) => /\.xlsx$/i.test(a));
const dbPath = resolve(opt('--db') ?? 'data/krubook.sqlite');
if (!workbookPath) { console.error('Usage: tsx server/import-workbook.ts <workbook.xlsx> --db <file> [--materials <dir>]'); process.exit(1); }
if (existsSync(dbPath)) { console.error(`${dbPath} already exists. Import into a new database file.`); process.exit(1); }

const today = process.env.KRUBOOK_TODAY ?? new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Phnom_Penh' }).format(new Date());
const db = new DB(dbPath);
importWorkbook(db, workbookPath, { today, materialsDir: opt('--materials') }).then(({ report, summary }) => {
  db.close();
  for (const line of summary) console.log(line);
  console.log(`\nDatabase written to ${dbPath}`);
  if (report.length) console.log(`\nNeeds your attention:\n- ${report.join('\n- ')}`);
}).catch((e) => { console.error(e.message ?? e); process.exit(1); });
