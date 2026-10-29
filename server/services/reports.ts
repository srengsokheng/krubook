import type { DB } from '../db.ts';
import type { User } from '../auth.ts';
import { classScope, getSetting, payStartDay, today } from './access.ts';
import { classSummary, orderedParts } from './plan.ts';
import { gradebook } from './records.ts';
import { addDays, DEFAULT_TZ, durationMinutes, formatDate, minutesOf, nowTimeIn, todayIn, weekday } from '../../shared/dates.ts';
import { checkinLink } from './checkin.ts';
import { payOverview } from './pay.ts';
import { lateMinutes, payMonthOf } from '../../shared/pay.ts';

// ---------------------------------------------------------------------------------------------
// Dashboard

// At-risk students per class, remembered until anything that affects them changes. The key
// covers every input: scores and attendance (count + sum of row versions, so any edit or delete
// changes it), the grading setup, enrollments and student names, and session statuses.
const riskCache = new WeakMap<DB, Map<number, { key: string; rows: any[] }>>();
function riskKey(db: DB, classId: number): string {
  return (db.get(
    `SELECT
       (SELECT COUNT(*) || '/' || IFNULL(SUM(sc.version), 0) FROM scores sc JOIN enrollments e ON e.id = sc.enrollment_id WHERE e.class_id = ?) || '|' ||
       (SELECT COUNT(*) || '/' || IFNULL(SUM(a.version), 0) FROM attendance a JOIN sessions s ON s.id = a.session_id WHERE s.class_id = ?) || '|' ||
       (SELECT IFNULL(updated_at, '') || status || attendance_rule || target_total || pass_mark FROM grade_configs WHERE class_id = ?) || '|' ||
       (SELECT IFNULL(group_concat(c.id || ':' || c.max_score || ':' || c.kind), '') FROM grade_components c JOIN grade_configs g ON g.id = c.config_id WHERE g.class_id = ?) || '|' ||
       (SELECT IFNULL(group_concat(e.id || e.status || IFNULL(st.name_km, '') || IFNULL(st.name_latin, '') || st.student_code), '') FROM enrollments e JOIN students st ON st.id = e.student_id WHERE e.class_id = ?) || '|' ||
       (SELECT IFNULL(group_concat(id || status), '') FROM sessions WHERE class_id = ?) AS k`,
    classId, classId, classId, classId, classId, classId,
  ) as { k: string }).k;
}
function atRiskFor(db: DB, u: User, c: Record<string, any>) {
  const key = riskKey(db, c.id);
  let cache = riskCache.get(db);
  if (!cache) riskCache.set(db, (cache = new Map()));
  const hit = cache.get(c.id);
  if (hit && hit.key === key) return hit.rows;
  const g = gradebook(db, u, c.id, { activeOnly: true });
  const rows = g.rows.filter((r) => r.atRisk).map((r) => ({ classId: c.id, code: c.code, enrollmentId: r.enrollmentId, studentCode: r.code, nameKm: r.nameKm, nameLatin: r.nameLatin, total: r.total, reason: r.riskReason }));
  cache.set(c.id, { key, rows });
  return rows;
}

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
  const checkins = new Map(db.all(`SELECT k.session_id, k.time, (l.id IS NOT NULL) AS locked FROM checkins k JOIN sessions s ON s.id = k.session_id LEFT JOIN pay_statement_lines l ON l.session_id = k.session_id WHERE s.class_id IN (${inList}) AND s.date = ?`, now).map((k) => [k.session_id, k]));
  const decorate = (s: any) => {
    const c = byId.get(s.class_id)!;
    const k = checkins.get(s.id);
    return { checkin: k ? { time: k.time, late: lateMinutes(s.start_time, k.time), locked: !!k.locked } : null, id: s.id, classId: s.class_id, code: c.code, courseName: c.course_name, color: c.color, date: s.date, start: s.start_time, end: s.end_time, kind: s.kind, activity: s.activity, status: s.status, checkpoint: s.checkpoint, note: s.note, part: s.part_id ? partNames.get(s.part_id) ?? null : null, partId: s.part_id, materials: materialsFor(s.part_id) };
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

  const atRisk = classes.filter((c) => c.status === 'active').flatMap((c) => atRiskFor(db, u, c));

  const payMonth = payMonthOf(now, payStartDay(db, u));
  const pay = payOverview(db, u, payMonth.slice(0, 4));
  const month = pay.months.find((m) => m.month === payMonth) ?? null;
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

/** Classes starting within the next CHECKIN_LEAD minutes (or started up to 10 minutes ago) that you
 * have not checked in to, each with a one-tap check-in link. Sent once per session. */
export const CHECKIN_LEAD = 15;
export function buildCheckinReminders(db: DB, u: User, date: string, time: string): Reminder[] {
  const t = minutesOf(time);
  const rows = db.all(
    `SELECT s.id, s.start_time, s.end_time, s.kind, c.code, COALESCE(m.room, c.room) AS room FROM sessions s JOIN classes c ON c.id = s.class_id LEFT JOIN meetings m ON m.id = s.meeting_id
      WHERE c.teacher_id = ? AND s.date = ? AND s.status = 'planned' AND NOT EXISTS (SELECT 1 FROM checkins k WHERE k.session_id = s.id)
      ORDER BY s.start_time`,
    u.id, date,
  );
  return rows.filter((r) => t >= minutesOf(r.start_time) - CHECKIN_LEAD && t <= minutesOf(r.start_time) + 10).map((r) => {
    const link = checkinLink(db, u, r.id);
    return {
      key: `${u.id}:checkin:${r.id}`,
      text: `${r.code} ${r.kind} starts at ${r.start_time}${r.room ? ` in ${r.room}` : ''}. ${link ? `Tap to check in:\n${link}` : 'Check in on the KruBook dashboard.'}`,
    };
  });
}

export async function sendTelegram(token: string, chatId: string, text: string): Promise<void> {
  const res = await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    // No link previews: a preview fetch must never be mistaken for opening a check-in link.
    body: JSON.stringify({ chat_id: chatId, text, link_preview_options: { is_disabled: true } }),
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
    const time = nowTimeIn(tz), date = todayIn(tz);
    const due = [
      ...(getSetting(db, u.id, 'notify.checkin', '1') === '1' ? buildCheckinReminders(db, u, date, time) : []),
      ...(time >= at ? buildReminders(db, u, date) : []),
    ];
    for (const r of due) {
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
