import { join, resolve } from 'node:path';
import { createApp, createHolder } from './app.ts';
import { runReminders } from './services/reports.ts';
import { autoRecordAll } from './services/checkin.ts';

const file = resolve(process.env.KRUBOOK_DB ?? 'data/krubook.sqlite');
const port = Number(process.env.PORT ?? 4310);
const holder = createHolder(file);
const app = createApp(holder, { staticDir: process.env.NODE_ENV === 'production' ? join(import.meta.dirname, '..', 'web', 'dist') : undefined });

// In production only nginx on this machine talks to the app, so it listens on loopback only.
const host = process.env.HOST ?? (process.env.NODE_ENV === 'production' ? '127.0.0.1' : '0.0.0.0');
const server = app.listen(port, host, () => console.log(`KruBook API on http://${host}:${port} (database: ${file})`));
server.requestTimeout = 120_000;
server.headersTimeout = 30_000;

// Every 5 minutes: record finished sessions you checked in to and took a roll call for, then send
// any reminders that are due (check-in reminders go out before each class; each is sent once).
setInterval(() => {
  try { autoRecordAll(holder.db); } catch (e) { console.error('Auto-record failed:', (e as Error).message); }
  runReminders(holder.db).catch((e) => console.error('Reminder run failed:', e.message));
}, 5 * 60 * 1000).unref();
