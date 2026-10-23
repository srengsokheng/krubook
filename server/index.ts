import { join, resolve } from 'node:path';
import { createApp, createHolder } from './app.ts';
import { runReminders } from './services/reports.ts';

const file = resolve(process.env.KRUBOOK_DB ?? 'data/krubook.sqlite');
const port = Number(process.env.PORT ?? 4310);
const holder = createHolder(file);
const app = createApp(holder, { staticDir: process.env.NODE_ENV === 'production' ? join(import.meta.dirname, '..', 'web', 'dist') : undefined });

app.listen(port, () => console.log(`KruBook API on http://localhost:${port} (database: ${file})`));

// Reminders: checked every 10 minutes; each reminder is sent at most once.
setInterval(() => { runReminders(holder.db).catch((e) => console.error('Reminder run failed:', e.message)); }, 10 * 60 * 1000).unref();
