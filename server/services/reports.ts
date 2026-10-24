import type { DB } from '../db.ts';
import type { User } from '../auth.ts';
import { classScope, getSetting, today } from './access.ts';
import { classSummary, orderedParts } from './plan.ts';
import { gradebook } from './records.ts';
import { addDays, DEFAULT_TZ, durationMinutes, formatDate, monthOf, nowTimeIn, todayIn, weekday } from '../../shared/dates.ts';
import { payOverview } from './pay.ts';

// ---------------------------------------------------------------------------------------------
// Dashboard

export function dashboard(db: DB, u: User) {
  const sc = classScope(u);
  const now = today(db, u);
  const tz = getSetting(db, u.id, 'timezone', DEFAULT_TZ);
  const time = process.env.KRUBOOK_TODAY ? '00:00' : nowTimeIn(tz);
  const classes = db.all(
    `SELECT c.*, co.name AS course_name, co.color, co.code AS course_code, t.name AS term_name FROM classes c
       JOIN courses co ON co.id = c.course_id JOIN terms t ON t.id = c.term_id
      WHERE ${sc.where} AND c.status IN ('active','upcoming') ORDER BY c.code`,
    ...sc.params,
  );
  const ids = classes.map((c) => c.id);
  const byId = new Map(classes.map((c) => [c.id, c]));
  const partNames = new Map<number, { code: string; title: string | null; lessonId: number }>();
  for (const cid of new Set(classes.map((c) => c.course_id))) for (const p of orderedParts(db, cid)) partNames.set(p.id, { code: p.code, title: p.title ?? p.lessonTitle, lessonId: p.lessonId });

  const inList = ids.length ? ids.join(',') : '0';
  const window = db.all(
    `SELECT * FROM sessions WHERE class_id IN (${inList}) AND date BETWEEN ? AND ? AND status IN ('planned','completed','cancelled') ORDER BY date, start_time`,
    now, addDays(now, 21),
  );
  const materialsFor = (partId: number | null) => {
    if (!partId) return [];
    const p = partNames.get(partId);
    return p ? db.all('SELECT id, kind, title, status, url FROM materials WHERE lesson_id = ? AND (part_id IS NULL OR part_id = ?) ORDER BY kind', p.lessonId, partId) : [];
  };
  const decorate = (s: any) => {
    const c = byId.get(s.class_id)!;
    return { id: s.id, classId: s.class_id, code: c.code, courseName: c.course_name, color: c.color, date: s.date, start: s.start_time, end: s.end_time, kind: s.kind, activity: s.activity, status: s.status, checkpoint: s.checkpoint, note: s.note, part: s.part_id ? partNames.get(s.part_id) ?? null : null, partId: s.part_id, materials: materialsFor(s.part_id) };
  };
  const todays = window.filter((s) => s.date === now).map(decorate);
  const next = window.find((s) => s.status === 'planned' && (s.date > now || (s.date === now && s.start_time >= time)));
  const soon = window.filter((s) => s.status === 'planned' && s.date <= addDays(now, 7)).map(decorate);
  const notReady = soon.flatMap((s) => s.materials.filter((m: any) => m.status !== 'ready').map((m: any) => ({ ...m, sessionId: s.id, classId: s.classId, code: s.code, date: s.date, part: s.part?.code })));
  const milestones = window.filter((s) => s.status === 'planned' && (s.checkpoint || s.kind === 'exam')).map(decorate);

  const progress = classes.map((c) => {
    const sum = classSummary(db, u, c.id);
    return { classId: c.id, code: c.code, courseName: c.course_name, color: c.color, status: c.status, progress: sum.progress, nextPart: sum.nextPart, unrecorded: sum.unrecorded.length };
  });

  const atRisk = classes.filter((c) => c.status === 'active').flatMap((c) => {
    const g = gradebook(db, u, c.id, { activeOnly: true });
    return g.rows.filter((r) => r.atRisk).map((r) => ({ classId: c.id, code: c.code, enrollmentId: r.enrollmentId, studentCode: r.code, nameKm: r.nameKm, nameLatin: r.nameLatin, total: r.total, reason: r.riskReason }));
  });

  const pay = payOverview(db, u, now.slice(0, 4));
  const month = pay.months.find((m) => m.month === monthOf(now)) ?? null;
  const proposals = db.all(`SELECT p.id, p.class_id, p.reason, c.code FROM schedule_proposals p JOIN classes c ON c.id = p.class_id WHERE p.status = 'pending' AND p.class_id IN (${inList})`);

  return {
    today: now,
    todays,
    next: next ? decorate(next) : null,
    notReady,
    milestones,
    progress,
    atRisk: atRisk.slice(0, 12),
    atRiskTotal: atRisk.length,
    month,
    currency: pay.currency,
    proposals,
  };
}

// ---------------------------------------------------------------------------------------------
// Reminders. Each reminder has a dedupe key so it is sent at most once.

export interface Reminder {
  key: string;
  text: string;
}

export function buildReminders(db: DB, u: User, now: string = today(db, u)): Reminder[] {
  const sc = classScope(u);
  const out: Reminder[] = [];
  const tomorrow = addDays(now, 1);
  const rows = db.all(
    `SELECT s.*, c.code, co.id AS course_id FROM sessions s JOIN classes c ON c.id = s.class_id JOIN courses co ON co.id = c.course_id
      WHERE ${sc.where} AND s.status = 'planned' AND s.date BETWEEN ? AND ? ORDER BY s.date, s.start_time`,
    ...sc.params, tomorrow, addDays(now, 7),
  );
  const parts = new Map<number, { code: string; title: string | null; lessonId: number }>();
  for (const cid of new Set(rows.map((r) => r.course_id))) for (const p of orderedParts(db, cid)) parts.set(p.id, { code: p.code, title: p.title ?? p.lessonTitle, lessonId: p.lessonId });

  const tmr = rows.filter((r) => r.date === tomorrow);
  if (tmr.length) {
    const lines = tmr.map((r) => `• ${r.start_time}–${r.end_time} ${r.code} ${r.kind}${r.part_id && parts.get(r.part_id) ? ` — ${parts.get(r.part_id)!.code} ${parts.get(r.part_id)!.title ?? ''}` : ''}`);
    out.push({ key: `${u.id}:tomorrow:${tomorrow}`, text: `Tomorrow (${formatDate(tomorrow)}):\n${lines.join('\n')}` });
  }
  const prep: string[] = [];
  for (const r of rows.filter((x) => x.date <= addDays(now, 2) && x.part_id)) {
    const p = parts.get(r.part_id);
    if (!p) continue;
    const mats = db.all("SELECT title, status FROM materials WHERE lesson_id = ? AND (part_id IS NULL OR part_id = ?) AND status <> 'ready'", p.lessonId, r.part_id);
    for (const m of mats) prep.push(`• ${r.code} ${formatDate(r.date)}: ${m.title} (${m.status.replace('_', ' ')})`);
  }
  if (prep.length) out.push({ key: `${u.id}:prep:${now}`, text: `Materials to prepare:\n${prep.join('\n')}` });
  const ms = rows.filter((r) => r.checkpoint || r.kind === 'exam');
  for (const r of ms) out.push({ key: `${u.id}:milestone:${r.id}:${r.date}`, text: `${r.code}: ${r.checkpoint ?? (r.activity === 'final' ? 'Final exam' : 'Midterm exam')} on ${formatDate(r.date)} at ${r.start_time}` });
  if (weekday(now) === 0 && rows.length) out.push({ key: `${u.id}:week:${now}`, text: `This week: ${rows.filter((r) => r.date <= addDays(now, 7)).length} sessions planned.` });
  return out;
}

export async function sendTelegram(token: string, chatId: string, text: string): Promise<void> {
  const res = await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ chat_id: chatId, text }),
  });
  if (!res.ok) throw new Error(`Telegram responded ${res.status}`);
}

/** Sends any reminders that are due and have not been sent before. */
export async function runReminders(db: DB, send: (u: User, text: string) => Promise<void> = defaultSend(db)) {
  const users = db.all<User>('SELECT id, email, name, role FROM users');
  let sent = 0;
  for (const u of users) {
    if (getSetting(db, u.id, 'notify.enabled', '0') !== '1') continue;
    const tz = getSetting(db, u.id, 'timezone', DEFAULT_TZ);
    const at = getSetting(db, u.id, 'notify.time', '18:00');
    if (nowTimeIn(tz) < at) continue;
    for (const r of buildReminders(db, u, todayIn(tz))) {
      const claimed = db.run("INSERT OR IGNORE INTO notification_log (owner_id, dedupe_key, channel, message, status) VALUES (?,?,'telegram',?,'pending')", u.id, r.key, r.text);
      if (!claimed.changes) continue;
      try {
        await send(u, r.text);
        db.run("UPDATE notification_log SET status = 'sent' WHERE dedupe_key = ?", r.key);
        sent++;
      } catch (e) {
        // Release the claim so the next run retries.
        db.run('DELETE FROM notification_log WHERE dedupe_key = ?', r.key);
      }
    }
  }
  return sent;
}

function defaultSend(db: DB) {
  return async (u: User, text: string) => {
    const token = getSetting(db, u.id, 'notify.telegramToken', '');
    const chat = getSetting(db, u.id, 'notify.telegramChat', '');
    if (!token || !chat) throw new Error('Telegram is not configured');
    await sendTelegram(token, chat, text);
  };
}
