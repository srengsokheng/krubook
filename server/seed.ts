// Demo data for a separate demo database. Run `npm run seed` (writes data/demo.sqlite by default);
// it refuses to touch a database that already has users.
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { DB } from './db.ts';
import { createUser, type User } from './auth.ts';
import { cambodianHolidays, SOURCE_2026 } from '../shared/holidays.ts';
import { standardTemplate } from '../shared/schedule.ts';
import { generateForClass, completeSession, orderedParts, applyProposal, createProposal } from './services/plan.ts';
import { applySync, ensureConfig, saveConfig, loadConfig } from './services/records.ts';
import { today } from './services/access.ts';

export const DEMO_LOGIN = { email: 'teacher@krubook.test', password: 'krubook-demo' };

const CURRICULA: Record<string, Array<[string, string[]]>> = {
  CPP: [
    ['Introduction to C++ and the toolchain', ['A']], ['Variables, types and operators', ['A', 'B']], ['Control flow: if, switch, loops', ['A', 'B']],
    ['Functions and scope', ['A']], ['Arrays and strings', ['A', 'B']], ['Pointers and references', ['A']], ['Structs and enums', ['A']],
    ['Classes and objects', ['A', 'B']], ['Inheritance and polymorphism', ['A']], ['File input and output', ['A']],
  ],
  WBD1: [
    ['How the web works', ['A']], ['HTML structure and semantics', ['A', 'B']], ['CSS selectors and the box model', ['A', 'B']],
    ['Flexbox and grid layout', ['A', 'B']], ['Responsive design', ['A']], ['Forms and validation', ['A']], ['JavaScript basics', ['A', 'B']],
    ['The DOM and events', ['A']], ['Fetching data', ['A']], ['Deploying a site', ['A']],
  ],
  JAVA: [
    ['Java, the JVM and IntelliJ', ['A']], ['Types, operators and input', ['A']], ['Conditionals and loops', ['A', 'B']], ['Methods', ['A']],
    ['Arrays and ArrayList', ['A', 'B']], ['Classes and encapsulation', ['A', 'B']], ['Inheritance and interfaces', ['A']], ['Exceptions', ['A']],
    ['Collections and generics', ['A']], ['File I/O and JDBC preview', ['A']],
  ],
  CSHARP: [
    ['C# and .NET setup', ['A']], ['Variables and data types', ['A']], ['Decisions and loops', ['A', 'B']], ['Methods and parameters', ['A']],
    ['Arrays and lists', ['A']], ['Classes and properties', ['A', 'B']], ['Inheritance', ['A']], ['LINQ basics', ['A', 'B']],
    ['Windows Forms', ['A', 'B']], ['Working with files', ['A']],
  ],
};

const FAMILY = [['សុខ', 'Sok'], ['ចាន់', 'Chan'], ['ហេង', 'Heng'], ['លី', 'Ly'], ['ម៉ៅ', 'Mao'], ['គឹម', 'Kim'], ['សៀង', 'Seang'], ['ពៅ', 'Pov'], ['ឈឹម', 'Chhim'], ['យឹម', 'Yim'], ['ណុប', 'Nob'], ['ភាព', 'Pheap'], ['ទេព', 'Tep'], ['អ៊ុំ', 'Um'], ['ស៊ិន', 'Sin']];
const GIVEN = [['ដារ៉ា', 'Dara'], ['សុភា', 'Sophea'], ['វិចិត្រ', 'Vichet'], ['ស្រីនាង', 'Sreyneang'], ['បូរ៉ា', 'Bora'], ['ចន្ទ្រា', 'Chantrea'], ['រតនា', 'Rathana'], ['សុវណ្ណ', 'Sovann'], ['មករា', 'Makara'], ['ពិសិដ្ឋ', 'Piseth'], ['លីដា', 'Lida'], ['សុធា', 'Sothea'], ['ពន្លក', 'Ponlok'], ['ស្រីពៅ', 'Sreypov'], ['វណ្ណៈ', 'Vannak'], ['ធីតា', 'Thida'], ['កញ្ញា', 'Kanha'], ['សំណាង', 'Samnang'], ['រស្មី', 'Raksmey'], ['វិសាល', 'Visal']];

function rng(seed: number) {
  return () => ((seed = (seed * 1664525 + 1013904223) % 4294967296) / 4294967296);
}

export function seedDemo(db: DB) {
  if (db.get('SELECT 1 FROM users LIMIT 1')) throw new Error('This database already has users; the demo seed only runs on an empty database.');
  const rand = rng(42);
  const uid = createUser(db, DEMO_LOGIN.email, 'Demo Teacher', DEMO_LOGIN.password, 'admin');
  const u: User = { id: uid, email: DEMO_LOGIN.email, name: 'Demo Teacher', role: 'admin' };
  db.run("INSERT INTO settings (owner_id, key, value) VALUES (?, 'timezone', 'Asia/Phnom_Penh')", uid);
  for (const h of cambodianHolidays()) db.run("INSERT INTO holidays (owner_id, date, name, name_km, source, approx, verified_note) VALUES (?,?,?,?,'national',?,?)", uid, h.date, h.name, h.nameKm, h.approx ? 1 : 0, h.date.startsWith('2026') ? SOURCE_2026 : null);

  const courses: Record<string, number> = {};
  const meta: Record<string, [string, string, string]> = {
    CPP: ['C++ Programming', 'កម្មវិធី C++', '#2f5bd3'],
    WBD1: ['Web Development I', 'ការអភិវឌ្ឍគេហទំព័រ I', '#0f8a6c'],
    JAVA: ['Java Programming', 'កម្មវិធី Java', '#c2491d'],
    CSHARP: ['C# Programming', 'កម្មវិធី C#', '#7a3fb8'],
  };
  for (const [code, lessons] of Object.entries(CURRICULA)) {
    const [name, nameKm, color] = meta[code];
    const cid = db.run('INSERT INTO courses (owner_id, code, name, name_km, color, description) VALUES (?,?,?,?,?,?)', uid, code, name, nameKm, color, `${name}: 17-week course with four labs, a midterm and a capstone project.`).id;
    courses[code] = cid;
    for (const t of standardTemplate(17)) db.run('INSERT INTO template_weeks (course_id, week, activity, checkpoint, label) VALUES (?,?,?,?,?)', cid, t.week, t.activity, t.checkpoint ?? null, t.label ?? null);
    lessons.forEach(([title, parts], i) => {
      const lid = db.run('INSERT INTO lessons (course_id, position, title, objectives, est_minutes) VALUES (?,?,?,?,?)', cid, i + 1, title, `Students can explain and apply: ${title.toLowerCase()}.`, 180).id;
      parts.forEach((label, j) => {
        const pid = db.run('INSERT INTO lesson_parts (lesson_id, position, label, title) VALUES (?,?,?,?)', lid, j + 1, label, parts.length > 1 ? `${title} (${j === 0 ? 'concepts' : 'applied'})` : null).id;
        const st = () => (i < 4 ? 'ready' : i < 6 ? (rand() < 0.6 ? 'ready' : 'in_progress') : rand() < 0.3 ? 'in_progress' : 'not_started');
        db.run('INSERT INTO materials (lesson_id, part_id, kind, title, status) VALUES (?,?,?,?,?)', lid, pid, 'slides', `Slides ${i + 1}${label}`, st());
        db.run('INSERT INTO materials (lesson_id, part_id, kind, title, status) VALUES (?,?,?,?,?)', lid, pid, 'exercise', `Exercises ${i + 1}${label}`, st());
      });
      if ([3, 6, 8, 9].includes(i + 1)) db.run('INSERT INTO materials (lesson_id, kind, title, status) VALUES (?,?,?,?)', lid, 'lab', `Lab sheet for lesson ${i + 1}`, i < 5 ? 'ready' : 'not_started');
      db.run('INSERT INTO materials (lesson_id, kind, title, status) VALUES (?,?,?,?)', lid, 'code', `Example code ${i + 1}`, i < 5 ? 'ready' : 'not_started');
    });
  }

  const termId = db.run(
    "INSERT INTO terms (owner_id, name, start_date, end_date, midterm_start, midterm_end, final_start, final_end, status) VALUES (?, 'Semester 1, 2026–27', '2026-09-07', '2027-01-15', '2026-10-26', '2026-10-30', '2026-12-28', '2027-01-08', 'active')",
    uid,
  ).id;

  const classes: Array<{ code: string; course: string; start: string; meetings: Array<[number, string, string]>; students: number; pace: 'ahead' | 'on' | 'behind' | 'gaps'; status?: string }> = [
    { code: 'ASL3', course: 'CPP', start: '2026-09-07', meetings: [[1, '07:30', '09:00'], [3, '07:30', '09:00']], students: 46, pace: 'ahead' },
    { code: 'SW33', course: 'WBD1', start: '2026-09-08', meetings: [[2, '13:00', '15:00'], [4, '13:00', '15:00']], students: 44, pace: 'behind' },
    { code: 'SW43', course: 'JAVA', start: '2026-09-14', meetings: [[1, '13:30', '14:30'], [5, '13:00', '15:00']], students: 42, pace: 'gaps' },
    { code: 'SY14', course: 'CSHARP', start: '2026-09-28', meetings: [[2, '07:30', '09:00'], [4, '07:30', '08:30']], students: 40, pace: 'on' },
    { code: 'SY33', course: 'CPP', start: '2026-09-09', meetings: [[3, '15:00', '17:00'], [6, '08:00', '10:00']], students: 48, pace: 'on' },
    { code: 'SBQ3', course: 'WBD1', start: '2026-11-07', meetings: [[6, '13:00', '15:00'], [0, '08:00', '10:00']], students: 38, pace: 'on', status: 'upcoming' },
  ];

  let codeSeq = 230001;
  const now = today(db, u);
  for (const c of classes) {
    const classId = db.run("INSERT INTO classes (term_id, course_id, teacher_id, code, start_date, status, room) VALUES (?,?,?,?,?,?,?)", termId, courses[c.course], uid, c.code, c.start, c.status ?? 'active', `Room ${100 + Math.floor(rand() * 300)}`).id;
    for (const [wd, s, e] of c.meetings) db.run('INSERT INTO meetings (class_id, weekday, start_time, end_time) VALUES (?,?,?,?)', classId, wd, s, e);
    ensureConfig(db, classId);
    if (c.code === 'SW33' || c.code === 'SW43') {
      // Carried over from the old spreadsheet: midterm out of 25, so the maximums total 105.
      const { config } = loadConfig(db, classId);
      saveConfig(db, u, classId, { targetTotal: 100, passMark: 50, labelPass: 'ជាប់', labelFail: 'ធ្លាក់', components: config.components.map((x) => ({ ...x, max: x.key === 'midterm' ? 25 : x.max })) });
    }
    const enrollmentIds: number[] = [];
    for (let i = 0; i < c.students; i++) {
      const f = FAMILY[Math.floor(rand() * FAMILY.length)], g = GIVEN[Math.floor(rand() * GIVEN.length)];
      const sid = db.run('INSERT INTO students (owner_id, student_code, name_km, name_latin, gender) VALUES (?,?,?,?,?)', uid, `0${codeSeq++}`, `${f[0]} ${g[0]}`, `${f[1].toUpperCase()} ${g[1]}`, rand() < 0.5 ? 'F' : 'M').id;
      enrollmentIds.push(db.run('INSERT INTO enrollments (student_id, class_id, enrolled_on) VALUES (?,?,?)', sid, classId, c.start).id);
    }
    if (c.code === 'SW43') db.run("INSERT INTO rates (owner_id, class_id, mode, amount, effective_from) VALUES (?, ?, 'per_session', 25, '2026-09-01')", uid, classId);
    generateForClass(db, u, classId);
    if (c.status === 'upcoming') continue;

    // Record teaching up to yesterday, with a different pace for each class.
    const parts = orderedParts(db, courses[c.course]).map((p) => p.id);
    const sessions = db.all("SELECT * FROM sessions WHERE class_id = ? AND status = 'planned' AND date < ? ORDER BY date, start_time", classId, now);
    let pointer = 0, k = 0;
    for (const s of sessions) {
      k++;
      if (c.pace === 'gaps' && k >= sessions.length - 1) continue; // two sessions left unrecorded
      let taught: Array<{ partId: number; coverage: 'full' | 'partial' }> = [];
      if (s.kind === 'lecture' && s.activity === 'lesson') {
        const p = parts[pointer];
        if (c.pace === 'behind' && k % 5 === 0) taught = [{ partId: p, coverage: 'partial' }];
        else if (c.pace === 'ahead' && k === 5) { taught = [{ partId: p, coverage: 'full' }, { partId: parts[pointer + 1], coverage: 'full' }]; pointer += 2; }
        else { taught = [{ partId: p, coverage: 'full' }]; pointer++; }
      }
      if (s.kind === 'practice' && parts[pointer - 1]) taught = [{ partId: parts[pointer - 1], coverage: 'full' }];
      completeSession(db, u, s.id, { parts: taught, pace: c.pace === 'ahead' && k === 5 ? 'early' : c.pace === 'behind' && k % 5 === 0 ? 'behind' : 'on_plan', notes: k === 5 && c.pace === 'ahead' ? 'Class moved quickly; covered the next part as well.' : undefined });
      // Apply the re-plan right away, as the teacher would after reviewing it.
      const pending = db.get("SELECT id FROM schedule_proposals WHERE class_id = ? AND status = 'pending' ORDER BY id DESC", classId);
      if (pending) applyProposal(db, u, pending.id);
      const ops = enrollmentIds.map((eid, i) => {
        const r = rand();
        const status = r < 0.84 ? 'present' : r < 0.91 ? 'late' : r < 0.97 ? 'absent' : 'excused';
        return { opId: `seed-${s.id}-${i}`, type: 'attendance' as const, sessionId: s.id, enrollmentId: eid, status: (i % 17 === 3 && rand() < 0.6 ? 'absent' : status) as any, baseVersion: null };
      });
      applySync(db, u, ops);
    }

    // LAB 1 and LAB 2 scores where those checkpoints have passed.
    const { config } = loadConfig(db, classId);
    const labs = config.components.filter((x) => x.key === 'lab1' || x.key === 'lab2');
    const passed = (cp: string) => db.get("SELECT 1 FROM sessions WHERE class_id = ? AND checkpoint = ? AND date < ?", classId, cp, now);
    const ops: any[] = [];
    enrollmentIds.forEach((eid, i) => {
      for (const comp of labs) {
        if (!passed(comp.key === 'lab1' ? 'LAB 1' : 'LAB 2')) continue;
        if (i % 13 === 7 && comp.key === 'lab2') continue; // missing score
        const weak = i % 17 === 3;
        const v = weak ? Math.round(rand() * 2 * 2) / 2 : Math.min(comp.max, Math.round((2.5 + rand() * 2.5) * 2) / 2);
        ops.push({ opId: `s-${eid}-${comp.id}`, type: 'score', enrollmentId: eid, componentId: comp.id, value: v, baseVersion: null });
      }
    });
    if (ops.length) applySync(db, u, ops);
    if (c.code === 'SW43') createProposal(db, u, classId, 'Holiday calendar re-checked');
  }

  db.run("INSERT INTO rates (owner_id, mode, amount, effective_from) VALUES (?, 'hourly', 12, '2026-01-01')", uid);
  db.run("INSERT INTO pay_adjustments (owner_id, month, amount, note) VALUES (?, '2026-09', 15, 'Exam invigilation, 15 Sep')", uid);
  return u;
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  const file = resolve(process.env.KRUBOOK_DB ?? 'data/demo.sqlite');
  const db = new DB(file);
  seedDemo(db);
  db.close();
  console.log(`Demo data written to ${file}\nSign in with ${DEMO_LOGIN.email} / ${DEMO_LOGIN.password}`);
}
