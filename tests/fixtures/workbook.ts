import ExcelJS from 'exceljs';

// A small copy of the teaching workbook's layout: Weekly Schedule, Term Plan - <class> and
// Gradebook - <class> sheets, with the same cell positions the importer reads.

export interface FixtureStudent { km: string; latin: string; scores: Array<number | null> } // LAB 1-4, Midterm, Final project, Attendance
export interface FixtureSpec { completedWeeks: number; students: FixtureStudent[] }

const LESSONS = ['Intro to C++', 'Variables', 'Control flow', 'Functions', 'Arrays', 'Pointers', 'Structs', 'Classes'];

export async function buildWorkbook(spec: FixtureSpec): Promise<Buffer> {
  const wb = new ExcelJS.Workbook();
  const ws = wb.addWorksheet('Weekly Schedule');
  ws.addRow(['Time', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat']);
  ws.addRow(['1:00 - 2:30 PM', 'SW33\nC++ — Programming', '—', 'SW33\nC++ — Programming', '—', '—', '—']);

  const plan = wb.addWorksheet('Term Plan - SW33');
  plan.getCell('A1').value = 'SW33 term plan';
  plan.getCell('A2').value = 'Start Sep 7 · Midterm Nov 9-14 · Final Jan 11-16';
  plan.addRow([]); plan.addRow(['Week', 'Dates', 'Content', 'Checkpoint', 'Status', 'Notes']);
  for (let w = 1; w <= 12; w++) {
    const content = w <= LESSONS.length ? `Lesson ${w} — ${LESSONS[w - 1]}` : w === 10 ? 'MIDTERM EXAM' : 'Review and buffer';
    plan.getRow(4 + w).values = [`W${w}`, '', content, w === 4 ? 'LAB 1' : '', w <= spec.completedWeeks ? 'Completed' : 'Planned', ''];
  }

  const g = wb.addWorksheet('Gradebook - SW33');
  g.getRow(1).values = ['Gradebook SW33'];
  g.getRow(3).values = ['', '', 'Max', 10, 10, 10, 10, '', 20, '', 30, 10];
  g.getRow(4).values = ['Pass', 50];
  g.getRow(6).values = ['No', 'Khmer', 'Latin', 'LAB 1', 'LAB 2', 'LAB 3', 'LAB 4', '', 'Midterm', '', 'Final', 'Attendance'];
  spec.students.forEach((s, i) => {
    const [l1, l2, l3, l4, mid, fin, att] = s.scores;
    g.getRow(7 + i).values = [i + 1, s.km, s.latin, l1, l2, l3, l4, null, mid, null, fin, att] as any[];
  });
  return Buffer.from(await wb.xlsx.writeBuffer());
}
