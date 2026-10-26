// One-off import of the old "Teaching_Schedule_and_Progress.xlsx" workbook into a new database.
//
//   npx tsx server/import-workbook.ts <workbook.xlsx> --db data/krubook.sqlite [--materials D:\Work\Teaching]
//
// Reads: the Weekly Schedule (meeting times), each "Term Plan - <class>" sheet (start date, exam
// windows, week-by-week content, checkpoints, which weeks were completed), and each
// "Gradebook - <class>" sheet (maximums, pass mark, students, scores). Lesson materials are
// listed from <materials>/cpp/lessonNN and <materials>/nodejs/lessonNN when that folder is given.
//
// The data is owned by an unclaimed account; the first account created with `krubook-user add`
// claims it. Everything that could not be mapped is printed at the end.
import ExcelJS from 'exceljs';
import { existsSync, readdirSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { DB } from './db.ts';
import type { User } from './auth.ts';
import { holidayRanges, SOURCE_2026 } from '../shared/holidays.ts';
import { addDays, isISODate } from '../shared/dates.ts';
import { completeSession, generateForClass, orderedParts } from './services/plan.ts';
import { applySync, ensureConfig, saveConfig, setConfigStatus } from './services/records.ts';

const args = process.argv.slice(2);
const opt = (name: string) => { const i = args.indexOf(name); return i >= 0 ? args[i + 1] : undefined; };
const workbookPath = args.find((a) => /\.xlsx$/i.test(a));
const dbPath = resolve(opt('--db') ?? 'data/krubook.sqlite');
const materialsDir = opt('--materials');
if (!workbookPath) { console.error('Usage: tsx server/import-workbook.ts <workbook.xlsx> --db <file> [--materials <dir>]'); process.exit(1); }

const report: string[] = [];
const MONTHS: Record<string, number> = { Jan: 1, Feb: 2, Mar: 3, Apr: 4, May: 5, Jun: 6, Jul: 7, Aug: 8, Sep: 9, Oct: 10, Nov: 11, Dec: 12 };
// The workbook omits years: Aug–Dec are 2026, Jan–Jul are 2027.
const isoOf = (mon: string, day: number) => { const m = MONTHS[mon.slice(0, 3)]; return `${m >= 8 ? 2026 : 2027}-${String(m).padStart(2, '0')}-${String(day).padStart(2, '0')}`; };

function text(c: ExcelJS.Cell): string {
  const v = c.value as any;
  if (v == null) return '';
  if (typeof v === 'object') { if ('result' in v) return v.result == null ? '' : String(v.result); if ('richText' in v) return v.richText.map((t: any) => t.text).join(''); if ('text' in v) return String(v.text); }
  return String(v).trim();
}
function num(c: ExcelJS.Cell): number | null {
  const v = c.value as any;
  if (v == null || v === '') return null;
  if (typeof v === 'number') return v;
  if (typeof v === 'object' && 'formula' in v) return null; // totals are recalculated, never imported
  const n = Number(String(v).trim());
  return Number.isFinite(n) ? n : null;
}

/** "Start Sep 7 · Midterm Nov 9-14 · Final Jan 11-16" / "Midterm Nov 30-Dec 5" */
function parseHeader(s: string) {
  const range = (label: string) => {
    const m = new RegExp(`${label}\\s+([A-Z][a-z]{2})\\s+(\\d+)\\s*-\\s*(?:([A-Z][a-z]{2})\\s+)?(\\d+)`).exec(s);
    if (!m) return null;
    return { start: isoOf(m[1], +m[2]), end: isoOf(m[3] ?? m[1], +m[4]) };
  };
  const st = /Start\s+([A-Z][a-z]{2})\s+(\d+)/.exec(s);
  return { start: st ? isoOf(st[1], +st[2]) : null, midterm: range('Midterm'), final: range('Final') };
}

type Row = { label: string; content: string; checkpoint: string | null; status: string; note: string | null };
type Kind = { activity: string; lesson?: number; part?: string; title?: string };

function classify(content: string): Kind {
  const m = /^Lesson\s+(\d+)(?:,\s*Part\s+([A-Z]))?\s*[—-]\s*(.+)$/.exec(content);
  if (m) return { activity: 'lesson', lesson: +m[1], part: m[2] ?? 'A', title: m[3].trim() };
  if (/^MIDTERM EXAM/i.test(content)) return { activity: 'midterm' };
  if (/^FINAL EXAM/i.test(content)) return { activity: 'final' };
  if (/capstone/i.test(content)) return { activity: 'capstone' };
  if (/midterm review/i.test(content)) return { activity: 'midterm_review' };
  if (/final exam review|cumulative review/i.test(content)) return { activity: 'final_review' };
  return { activity: 'buffer' };
}

const COURSE_INFO: Record<string, { code: string; name: string; nameKm: string; color: string; folder: string }> = {
  'C++': { code: 'CPP', name: 'C++ Programming', nameKm: 'កម្មវិធី C++', color: '#c2491d', folder: 'cpp' },
  'WBD I': { code: 'WBD1', name: 'Web Development I (Node.js)', nameKm: 'ការអភិវឌ្ឍគេហទំព័រ I', color: '#2f5bd3', folder: 'nodejs' },
};
const courseKey = (s: string) => (/C\+\+/.test(s) ? 'C++' : /WBD/.test(s) ? 'WBD I' : s);

function parseTime(slot: string) {
  // "1:00 - 2:30 PM" → afternoon times; the workbook only uses PM slots.
  const m = /(\d+):(\d+)\s*-\s*(\d+):(\d+)\s*(AM|PM)?/i.exec(slot)!;
  const h = (x: string) => { let n = +x; if ((m[5] ?? 'PM').toUpperCase() === 'PM' && n < 12) n += 12; return String(n).padStart(2, '0'); };
  return { start: `${h(m[1])}:${m[2]}`, end: `${h(m[3])}:${m[4]}` };
}

async function main() {
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.readFile(workbookPath!);
  if (existsSync(dbPath)) { console.error(`${dbPath} already exists. Import into a new database file.`); process.exit(1); }
  const db = new DB(dbPath);

  const ownerId = db.run("INSERT INTO users (email, name, password_hash, role) VALUES ('owner@krubook.local', 'Teacher', '!', 'admin')").id;
  const u: User = { id: ownerId, email: 'owner@krubook.local', name: 'Teacher', role: 'admin' };
  db.run("INSERT INTO settings (owner_id, key, value) VALUES (?, 'timezone', 'Asia/Phnom_Penh')", ownerId);
  for (const h of holidayRanges()) db.run("INSERT INTO holidays (owner_id, date, end_date, name, name_km, source, approx, verified_note) VALUES (?,?,?,?,?,'national',?,?)", ownerId, h.date, h.endDate, h.name, h.nameKm, h.approx ? 1 : 0, h.date.startsWith('2026') ? SOURCE_2026 : null);

  // ---- Weekly schedule → meetings ---------------------------------------------------------
  const ws = wb.getWorksheet('Weekly Schedule')!;
  const days = [1, 2, 3, 4, 5, 6]; // columns B..G = Monday..Saturday
  const meetings = new Map<string, Array<{ weekday: number; start: string; end: string }>>();
  const courseOf = new Map<string, string>();
  ws.eachRow((row) => {
    const slot = text(row.getCell(1));
    if (!/\d+:\d+\s*-\s*\d+:\d+/.test(slot)) return;
    const t = parseTime(slot);
    days.forEach((wd, i) => {
      const cell = text(row.getCell(i + 2));
      if (!cell || cell === '—') return;
      const [code, courseLine = ''] = cell.split('\n');
      meetings.set(code.trim(), [...(meetings.get(code.trim()) ?? []), { weekday: wd, ...t }]);
      courseOf.set(code.trim(), courseKey(courseLine.split('—')[0].trim()));
    });
  });

  // ---- Term plans ---------------------------------------------------------------------------
  const plans = new Map<string, { header: ReturnType<typeof parseHeader>; rows: Row[] }>();
  for (const sheet of wb.worksheets.filter((s) => s.name.startsWith('Term Plan - '))) {
    const code = sheet.name.replace('Term Plan - ', '').trim();
    const header = parseHeader(text(sheet.getCell('A2')));
    const rows: Row[] = [];
    sheet.eachRow((r, i) => {
      if (i < 5) return;
      const label = text(r.getCell(1)), content = text(r.getCell(3));
      if (!label || !content) return;
      rows.push({ label, content, checkpoint: text(r.getCell(4)) || null, status: text(r.getCell(5)), note: text(r.getCell(6)) || null });
    });
    plans.set(code, { header, rows });
  }

  // ---- Courses and curriculum --------------------------------------------------------------
  const progressTitles = new Map<string, string>();
  wb.getWorksheet('Progress & Next Steps')?.eachRow((r) => {
    for (const col of [5, 6]) { const m = /^Lesson\s+(\d+)\s*[—-]\s*(.+?)(?:\s*\(.*\))?$/.exec(text(r.getCell(col))); if (m) progressTitles.set(`${courseKey(text(r.getCell(2)))}:${m[1]}`, m[2].trim()); }
  });
  const courseIds = new Map<string, number>();
  const partIdOf = new Map<string, number>(); // "C++:2:A" → part id
  for (const key of new Set(courseOf.values())) {
    const info = COURSE_INFO[key];
    if (!info) { report.push(`Unknown course "${key}" skipped.`); continue; }
    const cid = db.run('INSERT INTO courses (owner_id, code, name, name_km, color, weeks) VALUES (?,?,?,?,?,19)', ownerId, info.code, info.name, info.nameKm, info.color).id;
    courseIds.set(key, cid);
    const sample = [...plans.entries()].find(([code]) => courseOf.get(code) === key)!;
    const lessons = new Map<number, Array<{ part: string; title: string }>>();
    for (const r of sample[1].rows) {
      const k = classify(r.content);
      if (k.activity !== 'lesson') continue;
      const list = lessons.get(k.lesson!) ?? [];
      if (!list.some((p) => p.part === k.part)) list.push({ part: k.part!, title: k.title! });
      lessons.set(k.lesson!, list);
    }
    const files = materialsDir ? join(materialsDir, info.folder) : null;
    for (const [n, parts] of [...lessons.entries()].sort((a, b) => a[0] - b[0])) {
      const multi = parts.length > 1;
      const folder = files ? join(files, `lesson${String(n).padStart(2, '0')}`) : null;
      const deck = folder && existsSync(folder) ? readdirSync(folder).find((f) => /\.pptx$/i.test(f) && !f.startsWith('~')) : undefined;
      const fromDeck = deck?.replace(/\.pptx$/i, '').split('_').slice(2).join(' ').replace(/([a-z])([A-Z])/g, '$1 $2');
      const title = (multi ? progressTitles.get(`${key}:${n}`) ?? fromDeck ?? parts[0].title : parts[0].title).replace(/\s*\+\s*practice$/i, '');
      const lid = db.run('INSERT INTO lessons (course_id, position, title) VALUES (?,?,?)', cid, n, title).id;
      for (const [i, p] of parts.sort((a, b) => a.part.localeCompare(b.part)).entries()) {
        const pid = db.run('INSERT INTO lesson_parts (lesson_id, position, label, title) VALUES (?,?,?,?)', lid, i + 1, p.part, multi ? p.title.replace(/\s*\+\s*practice$/i, '') : null).id;
        partIdOf.set(`${key}:${n}:${p.part}`, pid);
      }
      if (folder && existsSync(folder)) {
        for (const f of readdirSync(folder).filter((x) => !x.startsWith('~'))) {
          const kind = /\.pptx$/i.test(f) ? 'slides' : /^exercise.*\.docx$/i.test(f) || /exercise.*\.docx$/i.test(f) ? 'exercise' : /^example/i.test(f) ? 'code' : null;
          if (kind) db.run("INSERT INTO materials (lesson_id, kind, title, status) VALUES (?,?,?,'ready')", lid, kind, f);
        }
      }
    }
    // The course template follows the sample class's week-by-week plan.
    sample[1].rows.forEach((r, i) => {
      const k = classify(r.content);
      db.run('INSERT INTO template_weeks (course_id, week, activity, checkpoint, label) VALUES (?,?,?,?,?)', cid, i + 1, k.activity, r.checkpoint, k.activity === 'lesson' ? null : r.content);
    });
  }

  // ---- Terms: one per intake (same exam windows) ------------------------------------------
  const termIds = new Map<string, number>();
  for (const [code, p] of plans) {
    const key = `${p.header.midterm?.start}|${p.header.final?.start}`;
    if (termIds.has(key)) continue;
    const same = [...plans.values()].filter((x) => `${x.header.midterm?.start}|${x.header.final?.start}` === key);
    const start = same.map((x) => x.header.start!).sort()[0];
    const end = p.header.final?.end ?? addDays(start, 7 * 19);
    const name = `Semester 1, 2026–27 (from ${start.slice(5) === '09-07' ? '7 Sep' : start.slice(5) === '09-28' ? '28 Sep' : start})`;
    termIds.set(key, db.run("INSERT INTO terms (owner_id, name, start_date, end_date, midterm_start, midterm_end, final_start, final_end, status) VALUES (?,?,?,?,?,?,?,?,'active')",
      ownerId, name, start, end, p.header.midterm?.start ?? null, p.header.midterm?.end ?? null, p.header.final?.start ?? null, p.header.final?.end ?? null).id);
    void code;
  }

  // ---- Classes ------------------------------------------------------------------------------
  const today = process.env.KRUBOOK_TODAY ?? new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Phnom_Penh' }).format(new Date());
  for (const [code, p] of plans) {
    const key = courseOf.get(code);
    const courseId = key ? courseIds.get(key) : undefined;
    if (!courseId || !p.header.start || !isISODate(p.header.start)) { report.push(`${code}: no course or start date; skipped.`); continue; }
    const termId = termIds.get(`${p.header.midterm?.start}|${p.header.final?.start}`)!;
    const classId = db.run("INSERT INTO classes (term_id, course_id, teacher_id, code, start_date, weeks, status) VALUES (?,?,?,?,?,?,'active')", termId, courseId, ownerId, code, p.header.start, p.rows.length).id;
    for (const m of meetings.get(code) ?? []) db.run('INSERT INTO meetings (class_id, weekday, start_time, end_time) VALUES (?,?,?,?)', classId, m.weekday, m.start, m.end);
    if (!meetings.get(code)?.length) report.push(`${code}: no meeting times in the Weekly Schedule.`);
    ensureConfig(db, classId);
    const gen = generateForClass(db, u, classId);
    for (const w of gen.warnings) report.push(`${code}: ${w}`);

    // This class's own checkpoints (they differ slightly between classes).
    db.run('UPDATE sessions SET checkpoint = NULL WHERE class_id = ?', classId);
    p.rows.forEach((r, i) => {
      if (!r.checkpoint) return;
      const s = db.get("SELECT id FROM sessions WHERE class_id = ? AND week = ? AND status = 'planned' ORDER BY CASE kind WHEN 'practice' THEN 0 ELSE 1 END, date DESC LIMIT 1", classId, i + 1);
      if (s) db.run('UPDATE sessions SET checkpoint = ? WHERE id = ?', r.checkpoint, s.id);
      else report.push(`${code}: ${r.checkpoint} (week ${i + 1}) has no session left that week.`);
    });

    // Gradebook: maximums, pass mark, students and scores.
    const g = wb.getWorksheet(`Gradebook - ${code}`);
    const enrollmentIds: Array<{ row: number; eid: number }> = [];
    if (g) {
      const max = (col: number) => num(g.getRow(3).getCell(col)) ?? 0;
      const pass = num(g.getRow(4).getCell(2)) ?? 50;
      const cols: Array<[string, number, 'manual' | 'attendance']> = [['LAB 1', 4, 'manual'], ['LAB 2', 5, 'manual'], ['LAB 3', 6, 'manual'], ['LAB 4', 7, 'manual'], ['Midterm', 9, 'manual'], ['Final project', 11, 'manual'], ['Attendance & activity', 12, 'attendance']];
      saveConfig(db, u, classId, { targetTotal: 100, passMark: pass, labelPass: 'ជាប់', labelFail: 'ធ្លាក់', components: cols.map(([name, col, kind]) => ({ name, max: max(col), kind })) });
      try { setConfigStatus(db, u, classId, 'active'); } catch (e) { report.push(`${code}: grading setup left as draft: ${(e as Error).message}`); }
      const comps = db.all('SELECT c.id, c.position FROM grade_components c JOIN grade_configs gc ON gc.id = c.config_id WHERE gc.class_id = ? ORDER BY c.position', classId);
      const ops: any[] = [];
      g.eachRow((r, i) => {
        if (i < 7) return;
        const no = num(r.getCell(1)), km = text(r.getCell(2)), latin = text(r.getCell(3));
        if (no == null || (!km && !latin)) return;
        const studentCode = `${code}-${String(no).padStart(2, '0')}`;
        const sid = db.run("INSERT INTO students (owner_id, student_code, name_km, name_latin, notes) VALUES (?,?,?,?,'Imported from the workbook. Replace the ID with the official student ID.')", ownerId, studentCode, km || null, latin || null).id;
        const eid = db.run('INSERT INTO enrollments (student_id, class_id, enrolled_on) VALUES (?,?,?)', sid, classId, p.header.start).id;
        enrollmentIds.push({ row: i, eid });
        cols.forEach(([, col], ci) => {
          const v = num(r.getCell(col));
          if (v != null) ops.push({ opId: `${eid}:${ci}`, type: 'score', enrollmentId: eid, componentId: comps[ci].id, value: v, baseVersion: null });
        });
      });
      for (const res of applySync(db, u, ops)) if (res.status !== 'applied') report.push(`${code}: a score was not imported (${(res as any).message ?? res.status}).`);
    } else report.push(`${code}: no gradebook sheet.`);

    // Teaching records for weeks marked Completed.
    const parts = orderedParts(db, courseId);
    p.rows.forEach((r, i) => {
      if (!/^completed$/i.test(r.status)) return;
      const k = classify(r.content);
      const partId = k.activity === 'lesson' ? partIdOf.get(`${key}:${k.lesson}:${k.part}`) ?? null : null;
      const sessions = db.all("SELECT * FROM sessions WHERE class_id = ? AND week = ? ORDER BY date, start_time", classId, i + 1);
      for (const s of sessions) {
        if (s.status === 'cancelled') { report.push(`${code}: week ${i + 1} is marked Completed, but ${s.date} is ${s.note}. Check whether you taught that day; restore the session if so.`); continue; }
        if (s.date > today) { report.push(`${code}: week ${i + 1} is marked Completed but ${s.date} is in the future; not recorded.`); continue; }
        completeSession(db, u, s.id, { parts: partId ? [{ partId, coverage: 'full' }] : [], notes: [k.activity === 'lesson' ? null : r.content, r.note].filter(Boolean).join(' · ') || undefined });
      }
    });
    void parts;
    const pending = db.get("SELECT COUNT(*) AS n FROM schedule_proposals WHERE class_id = ? AND status = 'pending'", classId)!.n;
    const counts = db.get("SELECT COUNT(*) AS n, SUM(status = 'completed') AS done, SUM(status = 'cancelled') AS cancelled FROM sessions WHERE class_id = ?", classId)!;
    console.log(`${code}: ${enrollmentIds.length} students, ${counts.n} sessions (${counts.done} taught, ${counts.cancelled} cancelled)${pending ? ', 1 schedule change to review' : ''}`);
  }

  db.close();
  console.log(`\nDatabase written to ${dbPath}`);
  if (report.length) console.log(`\nNeeds your attention:\n- ${[...new Set(report)].join('\n- ')}`);
}

main().catch((e) => { console.error(e); process.exit(1); });
