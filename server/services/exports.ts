import ExcelJS from 'exceljs';
import type { DB } from '../db.ts';
import type { User } from '../auth.ts';
import { ownClass } from './access.ts';
import { gradebook, attendanceSummary } from './records.ts';
import { orderedParts } from './plan.ts';
import { payLines, payOverview } from './pay.ts';
import { payMonthOf } from '../../shared/pay.ts';
import { weekdayName, weekday } from '../../shared/dates.ts';

// Excel exports keep real types: dates are Excel dates, scores are numbers, and student IDs are
// text so leading zeros survive.

const HEADER_FILL: ExcelJS.Fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFE8ECF6' } };
const FONT = 'Kantumruy Pro';

const asDate = (iso: string | null | undefined) => (iso ? new Date(`${iso}T00:00:00Z`) : null);

function classMeta(db: DB, classId: number) {
  return db.get(
    `SELECT c.code, c.name, co.name AS course, co.code AS course_code, t.name AS term FROM classes c
       JOIN courses co ON co.id = c.course_id JOIN terms t ON t.id = c.term_id WHERE c.id = ?`,
    classId,
  )!;
}

function sheetWithMeta(wb: ExcelJS.Workbook, name: string, meta: Array<[string, string]>, columns: Array<{ header: string; key: string; width: number; style?: Partial<ExcelJS.Style> }>) {
  const ws = wb.addWorksheet(name, { views: [{ state: 'frozen', ySplit: meta.length + 2 }] });
  meta.forEach(([k, v], i) => {
    const r = ws.getRow(i + 1);
    r.getCell(1).value = k;
    r.getCell(1).font = { name: FONT, bold: true };
    r.getCell(2).value = v;
    r.getCell(2).font = { name: FONT };
  });
  const headerRow = meta.length + 2;
  ws.columns = columns.map((c) => ({ key: c.key, width: c.width, style: { font: { name: FONT }, ...c.style } }));
  const hr = ws.getRow(headerRow);
  columns.forEach((c, i) => {
    const cell = hr.getCell(i + 1);
    cell.value = c.header;
    cell.font = { name: FONT, bold: true };
    cell.fill = HEADER_FILL;
    cell.border = { bottom: { style: 'thin' } };
  });
  ws.pageSetup = { orientation: 'landscape', fitToPage: true, fitToWidth: 1, fitToHeight: 0, printTitlesRow: `${headerRow}:${headerRow}` };
  return { ws, headerRow };
}

function addRow(ws: ExcelJS.Worksheet, values: Record<string, unknown>) {
  const r = ws.addRow(values);
  r.font = { name: FONT };
  return r;
}

export async function gradebookXlsx(db: DB, u: User, classId: number): Promise<Buffer> {
  ownClass(db, u, classId);
  const g = gradebook(db, u, classId);
  const m = classMeta(db, classId);
  const wb = new ExcelJS.Workbook();
  wb.creator = 'KruBook';
  const comps = g.config.components;
  const { ws } = sheetWithMeta(
    wb, 'Gradebook',
    [['Class', `${m.code}${m.name ? ` — ${m.name}` : ''}`], ['Course', `${m.course_code} ${m.course}`], ['Term', m.term], ['Grading', `${g.check.total}/${g.config.targetTotal}, pass mark ${g.config.passMark}${g.check.valid ? '' : ' — CONFIGURATION INVALID'}`], ['Exported', new Date().toISOString().slice(0, 16).replace('T', ' ')]],
    [
      { header: 'No.', key: 'no', width: 5 },
      { header: 'Student ID', key: 'code', width: 14, style: { numFmt: '@' } },
      { header: 'Khmer name', key: 'km', width: 24 },
      { header: 'Latin name', key: 'latin', width: 24 },
      ...comps.map((c) => ({ header: `${c.name} (/${c.max})`, key: `c${c.id}`, width: 12, style: { numFmt: '0.##' } })),
      { header: `Total (/${g.config.targetTotal})`, key: 'total', width: 12, style: { numFmt: '0.##' } },
      { header: 'Result', key: 'result', width: 10 },
      { header: 'Missing', key: 'missing', width: 10 },
      { header: 'Enrollment', key: 'enr', width: 12 },
    ],
  );
  g.rows.forEach((r, i) => {
    const values: Record<string, unknown> = { no: i + 1, code: r.code, km: r.nameKm ?? '', latin: r.nameLatin ?? '', total: r.total, result: r.label, missing: r.missing.length || '', enr: r.enrollmentStatus };
    for (const c of comps) values[`c${c.id}`] = r.values[c.id] ?? null;
    const row = addRow(ws, values);
    if (r.result === 'fail') row.getCell('result').font = { name: FONT, color: { argb: 'FFB42318' }, bold: true };
  });
  ws.addRow({});
  const s = g.stats;
  for (const [k, v] of [['Average', s.average], ['Pass rate %', s.passRate], ['Highest', s.highest], ['Lowest', s.lowest], ['At risk', s.atRisk], ['Missing scores', s.missingCells]] as const) addRow(ws, { latin: k, total: v });
  return Buffer.from(await wb.xlsx.writeBuffer());
}

export async function termPlanXlsx(db: DB, u: User, classId: number): Promise<Buffer> {
  const cls = ownClass(db, u, classId);
  const m = classMeta(db, classId);
  const parts = new Map(orderedParts(db, cls.course_id).map((p) => [p.id, p]));
  const sessions = db.all(
    `SELECT s.*, r.taught_on, r.pace, r.notes AS record_notes,
            (SELECT group_concat(rp.part_id || ':' || rp.coverage) FROM record_parts rp WHERE rp.record_id = r.id) AS taught
       FROM sessions s LEFT JOIN teaching_records r ON r.session_id = s.id WHERE s.class_id = ? ORDER BY s.date, s.start_time`,
    classId,
  );
  const wb = new ExcelJS.Workbook();
  const { ws } = sheetWithMeta(wb, 'Term plan', [['Class', m.code], ['Course', `${m.course_code} ${m.course}`], ['Term', m.term], ['Exported', new Date().toISOString().slice(0, 16).replace('T', ' ')]], [
    { header: 'Week', key: 'week', width: 6 },
    { header: 'Date', key: 'date', width: 13, style: { numFmt: 'yyyy-mm-dd' } },
    { header: 'Day', key: 'day', width: 6 },
    { header: 'Start', key: 'start', width: 7 },
    { header: 'End', key: 'end', width: 7 },
    { header: 'Type', key: 'kind', width: 10 },
    { header: 'Planned lesson', key: 'part', width: 34 },
    { header: 'Checkpoint', key: 'cp', width: 14 },
    { header: 'Status', key: 'status', width: 11 },
    { header: 'Actually taught', key: 'taught', width: 34 },
    { header: 'Completed on', key: 'done', width: 13, style: { numFmt: 'yyyy-mm-dd' } },
    { header: 'Original date', key: 'orig', width: 13, style: { numFmt: 'yyyy-mm-dd' } },
    { header: 'Notes', key: 'note', width: 30 },
  ]);
  const pname = (id: number | null) => (id && parts.get(id) ? `${parts.get(id)!.code} ${parts.get(id)!.title ?? parts.get(id)!.lessonTitle}` : '');
  for (const s of sessions) {
    const taught = s.taught ? s.taught.split(',').map((t: string) => { const [id, cov] = t.split(':'); return `${pname(+id)}${cov === 'partial' ? ' (partial)' : ''}`; }).join('; ') : '';
    addRow(ws, {
      week: s.week, date: asDate(s.date), day: weekdayName(weekday(s.date)), start: s.start_time, end: s.end_time,
      kind: s.kind, part: s.activity === 'lesson' ? pname(s.part_id) : s.activity.replace('_', ' '), cp: s.checkpoint ?? '', status: s.status,
      taught, done: asDate(s.taught_on), orig: s.original_date !== s.date ? asDate(s.original_date) : null, note: [s.note, s.record_notes].filter(Boolean).join(' · '),
    });
  }
  return Buffer.from(await wb.xlsx.writeBuffer());
}

export async function rosterXlsx(db: DB, u: User, classId: number): Promise<Buffer> {
  ownClass(db, u, classId);
  const m = classMeta(db, classId);
  const rows = db.all(
    `SELECT st.*, e.status AS enrollment_status, e.enrolled_on, e.ended_on FROM enrollments e JOIN students st ON st.id = e.student_id WHERE e.class_id = ? ORDER BY st.student_code`,
    classId,
  );
  const wb = new ExcelJS.Workbook();
  const { ws } = sheetWithMeta(wb, 'Students', [['Class', m.code], ['Term', m.term], ['Exported', new Date().toISOString().slice(0, 16).replace('T', ' ')]], [
    { header: 'No.', key: 'no', width: 5 },
    { header: 'Student ID', key: 'code', width: 14, style: { numFmt: '@' } },
    { header: 'Khmer name', key: 'km', width: 26 },
    { header: 'Latin name', key: 'latin', width: 26 },
    { header: 'Gender', key: 'gender', width: 8 },
    { header: 'Email', key: 'email', width: 26 },
    { header: 'Phone', key: 'phone', width: 14, style: { numFmt: '@' } },
    { header: 'Enrollment', key: 'status', width: 12 },
    { header: 'Enrolled on', key: 'on', width: 12, style: { numFmt: 'yyyy-mm-dd' } },
    { header: 'Ended on', key: 'off', width: 12, style: { numFmt: 'yyyy-mm-dd' } },
  ]);
  rows.forEach((r, i) => addRow(ws, { no: i + 1, code: r.student_code, km: r.name_km ?? '', latin: r.name_latin ?? '', gender: r.gender ?? '', email: r.email ?? '', phone: r.phone ?? '', status: r.enrollment_status, on: asDate(r.enrolled_on), off: asDate(r.ended_on) }));
  return Buffer.from(await wb.xlsx.writeBuffer());
}

export async function attendanceXlsx(db: DB, u: User, classId: number): Promise<Buffer> {
  ownClass(db, u, classId);
  const m = classMeta(db, classId);
  const a = attendanceSummary(db, u, classId);
  const held = a.sessions.filter((s: any) => s.marked > 0);
  const cell = new Map(a.cells.map((c: any) => [`${c.session_id}:${c.enrollment_id}`, c.status]));
  const short: Record<string, string> = { present: 'P', late: 'L', absent: 'A', excused: 'E' };
  const wb = new ExcelJS.Workbook();
  const { ws, headerRow } = sheetWithMeta(wb, 'Attendance', [['Class', m.code], ['Term', m.term], ['Key', 'P present · L late · A absent · E excused · blank not recorded'], ['Exported', new Date().toISOString().slice(0, 16).replace('T', ' ')]], [
    { header: 'Student ID', key: 'code', width: 14, style: { numFmt: '@' } },
    { header: 'Name', key: 'name', width: 26 },
    ...held.map((s: any) => ({ header: s.date.slice(5), key: `s${s.id}`, width: 6 })),
    { header: 'Present', key: 'p', width: 8 }, { header: 'Late', key: 'l', width: 6 }, { header: 'Absent', key: 'ab', width: 7 }, { header: 'Excused', key: 'e', width: 8 },
    { header: '%', key: 'pct', width: 7, style: { numFmt: '0.0' } }, { header: `Score (/${a.max ?? '-'})`, key: 'score', width: 10, style: { numFmt: '0.##' } },
  ]);
  void headerRow;
  for (const s of a.students) {
    const v: Record<string, unknown> = { code: s.code, name: s.nameLatin ?? s.nameKm, p: s.present, l: s.late, ab: s.absent, e: s.excused, pct: s.percent, score: s.score };
    for (const h of held) v[`s${h.id}`] = short[cell.get(`${h.id}:${s.enrollmentId}`) as string] ?? '';
    addRow(ws, v);
  }
  return Buffer.from(await wb.xlsx.writeBuffer());
}

export async function payXlsx(db: DB, u: User, year: string): Promise<Buffer> {
  const p = payOverview(db, u, year);
  const wb = new ExcelJS.Workbook();
  const { ws } = sheetWithMeta(wb, 'Monthly summary', [['Teacher', u.name], ['Year', year], ['Pay period', p.payStartDay === 1 ? 'Calendar month' : `Day ${p.payStartDay} of the previous month to day ${p.payStartDay - 1} of the pay month`], ['Note', 'Estimated = taught sessions not yet approved. Approved and paid amounts come from frozen pay statements. Expected = planned sessions still ahead.'], ['Exported', new Date().toISOString().slice(0, 16).replace('T', ' ')]], [
    { header: 'Pay month', key: 'month', width: 10 },
    { header: 'From', key: 'from', width: 12 },
    { header: 'To', key: 'to', width: 12 },
    { header: 'Sessions taught', key: 'n', width: 14 },
    { header: 'Hours taught', key: 'h', width: 12, style: { numFmt: '0.00' } },
    { header: 'Make-up sessions', key: 'mk', width: 15 },
    { header: 'Late arrivals', key: 'late', width: 12 },
    { header: 'Late deductions', key: 'ded', width: 14, style: { numFmt: '#,##0.00' } },
    { header: `Estimated (${p.currency})`, key: 'est', width: 15, style: { numFmt: '#,##0.00' } },
    { header: 'Approved', key: 'appr', width: 12, style: { numFmt: '#,##0.00' } },
    { header: 'Paid', key: 'paid', width: 12, style: { numFmt: '#,##0.00' } },
    { header: 'Month total', key: 'total', width: 13, style: { numFmt: '#,##0.00' } },
    { header: 'Expected (planned)', key: 'exp', width: 17, style: { numFmt: '#,##0.00' } },
  ]);
  for (const m of p.months) addRow(ws, { month: m.month, from: m.from, to: m.to, n: m.taughtSessions, h: m.taughtMinutes / 60, mk: m.makeupSessions, late: m.lateSessions, ded: m.deductions, est: m.estimated, appr: m.approved, paid: m.paid, total: m.total, exp: m.expected });
  const det = wb.addWorksheet('Sessions');
  det.columns = [
    { header: 'Date', key: 'date', width: 12, style: { numFmt: 'yyyy-mm-dd' } }, { header: 'Pay month', key: 'pm', width: 10 }, { header: 'Start', key: 'start', width: 7 }, { header: 'Class', key: 'code', width: 10 },
    { header: 'Course', key: 'course', width: 24 }, { header: 'Minutes', key: 'min', width: 9 }, { header: 'Make-up', key: 'mk', width: 9 }, { header: 'Rate', key: 'rate', width: 14 },
    { header: 'Checked in', key: 'in', width: 11 }, { header: 'Late (min)', key: 'late', width: 10 }, { header: 'Late deduction', key: 'ded', width: 14, style: { numFmt: '#,##0.00' } },
    { header: 'Amount', key: 'amt', width: 10, style: { numFmt: '#,##0.00' } }, { header: 'Status', key: 'st', width: 11 },
  ];
  det.getRow(1).font = { bold: true };
  const first = p.months[0], last = p.months[p.months.length - 1];
  for (const l of first ? payLines(db, u, first.from, last.to) : []) det.addRow({ date: asDate(l.date), pm: payMonthOf(l.date, p.payStartDay), start: l.start, code: l.code, course: l.courseName, min: l.minutes, mk: l.isMakeup ? 'yes' : '', rate: l.rate ?? 'no rate set', in: l.checkin ?? '', late: l.late || '', ded: l.deduction || '', amt: l.amount, st: l.statementStatus ?? 'estimated' });
  const st = wb.addWorksheet('Statements');
  st.columns = [{ header: 'Month', key: 'month', width: 10 }, { header: 'Status', key: 'status', width: 10 }, { header: 'Sessions', key: 'sessions', width: 9 }, { header: 'Total', key: 'total', width: 12, style: { numFmt: '#,##0.00' } }, { header: 'Paid on', key: 'paidOn', width: 12 }, { header: 'Paid amount', key: 'paidAmount', width: 12, style: { numFmt: '#,##0.00' } }];
  st.getRow(1).font = { bold: true };
  for (const s of p.statements) st.addRow(s);
  const adj = wb.addWorksheet('Adjustments');
  adj.columns = [{ header: 'Month', key: 'month', width: 10 }, { header: 'Amount', key: 'amount', width: 12, style: { numFmt: '#,##0.00' } }, { header: 'Note', key: 'note', width: 40 }];
  adj.getRow(1).font = { bold: true };
  for (const a of p.adjustments) adj.addRow(a);
  return Buffer.from(await wb.xlsx.writeBuffer());
}
