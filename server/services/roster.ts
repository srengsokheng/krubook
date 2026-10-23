import ExcelJS from 'exceljs';
import { AppError, type DB } from '../db.ts';
import type { User } from '../auth.ts';
import { ownClass, ownEnrollment, today } from './access.ts';

export interface ImportRow {
  row: number; // spreadsheet row number, for error messages
  student_code: string;
  name_km?: string;
  name_latin?: string;
  gender?: string;
  email?: string;
  phone?: string;
  notes?: string;
}

export interface RowIssue {
  row: number;
  field: string;
  level: 'error' | 'warning';
  message: string;
}

/** Reads the first worksheet of an .xlsx file, or a CSV, into header + rows of strings. */
export async function parseSpreadsheet(buf: Buffer, filename: string): Promise<{ headers: string[]; rows: string[][] }> {
  if (/\.csv$/i.test(filename) || /\.txt$/i.test(filename)) return parseCsv(buf.toString('utf8').replace(/^﻿/, ''));
  if (!/\.xlsx$/i.test(filename)) throw new AppError(422, 'Upload an .xlsx or .csv file. Older .xls files need to be saved as .xlsx first.');
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.load(buf as any);
  const ws = wb.worksheets[0];
  if (!ws) throw new AppError(422, 'The workbook has no sheets.');
  const out: string[][] = [];
  ws.eachRow({ includeEmpty: false }, (r) => {
    const vals: string[] = [];
    for (let i = 1; i <= ws.columnCount; i++) vals.push(cellText(r.getCell(i)));
    out.push(vals);
  });
  const [headers = [], ...rows] = out;
  return { headers: headers.map((h) => h.trim()), rows: rows.filter((r) => r.some((v) => v.trim())) };
}

function cellText(c: ExcelJS.Cell): string {
  const v = c.value as any;
  if (v == null) return '';
  if (typeof v === 'object') {
    if ('richText' in v) return v.richText.map((t: any) => t.text).join('');
    if ('result' in v) return String(v.result ?? '');
    if ('text' in v) return String(v.text);
    if (v instanceof Date) return v.toISOString().slice(0, 10);
  }
  // Excel stores IDs like 00123 as text when formatted as text; if it stored a number, use the
  // displayed text so leading zeros from a number format survive.
  if (typeof v === 'number' && c.numFmt && /^0+$/.test(c.numFmt)) return String(v).padStart(c.numFmt.length, '0');
  return String(v);
}

export function parseCsv(text: string): { headers: string[]; rows: string[][] } {
  const rows: string[][] = [];
  let row: string[] = [], field = '', q = false;
  const delim = (text.split('\n')[0].match(/;/g)?.length ?? 0) > (text.split('\n')[0].match(/,/g)?.length ?? 0) ? ';' : ',';
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (q) {
      if (ch === '"' && text[i + 1] === '"') { field += '"'; i++; }
      else if (ch === '"') q = false;
      else field += ch;
    } else if (ch === '"') q = true;
    else if (ch === delim) { row.push(field); field = ''; }
    else if (ch === '\n' || ch === '\r') {
      if (ch === '\r' && text[i + 1] === '\n') i++;
      row.push(field); rows.push(row); row = []; field = '';
    } else field += ch;
  }
  if (field || row.length) { row.push(field); rows.push(row); }
  const [headers = [], ...rest] = rows;
  return { headers: headers.map((h) => h.trim()), rows: rest.filter((r) => r.some((v) => v.trim())) };
}

/** Checks rows before anything is saved. Errors block the import; warnings are informational. */
export function validateImport(db: DB, u: User, classId: number, rows: ImportRow[]): RowIssue[] {
  ownClass(db, u, classId);
  const issues: RowIssue[] = [];
  const seen = new Map<string, number>();
  for (const r of rows) {
    const code = (r.student_code ?? '').trim();
    if (!code) issues.push({ row: r.row, field: 'student_code', level: 'error', message: 'Student ID is required.' });
    else if (seen.has(code)) issues.push({ row: r.row, field: 'student_code', level: 'error', message: `Duplicate student ID ${code} (also on row ${seen.get(code)}).` });
    else seen.set(code, r.row);
    if (!r.name_km?.trim() && !r.name_latin?.trim()) issues.push({ row: r.row, field: 'name_latin', level: 'error', message: 'Enter a Khmer or Latin name.' });
    if (r.email && !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(r.email.trim())) issues.push({ row: r.row, field: 'email', level: 'error', message: `"${r.email}" is not a valid email address.` });
    if (code) {
      const ex = db.get('SELECT * FROM students WHERE owner_id = ? AND student_code = ?', u.id, code);
      if (ex) {
        const differs = (r.name_latin?.trim() && ex.name_latin && r.name_latin.trim() !== ex.name_latin) || (r.name_km?.trim() && ex.name_km && r.name_km.trim() !== ex.name_km);
        if (differs) issues.push({ row: r.row, field: 'name_latin', level: 'warning', message: `ID ${code} already belongs to ${ex.name_latin ?? ex.name_km}. The existing name is kept.` });
        const enrolled = db.get("SELECT 1 FROM enrollments WHERE student_id = ? AND class_id = ? AND status = 'active'", ex.id, classId);
        if (enrolled) issues.push({ row: r.row, field: 'student_code', level: 'warning', message: `${code} is already in this class and will be skipped.` });
      }
    }
  }
  return issues;
}

export function commitImport(db: DB, u: User, classId: number, rows: ImportRow[]) {
  const issues = validateImport(db, u, classId, rows);
  const errors = issues.filter((i) => i.level === 'error');
  if (errors.length) throw new AppError(422, `Fix ${errors.length} problem(s) before importing.`, { issues });
  const on = today(db, u);
  return db.tx(() => {
    let created = 0, enrolled = 0, skipped = 0;
    for (const r of rows) {
      const code = r.student_code.trim();
      let st = db.get('SELECT id FROM students WHERE owner_id = ? AND student_code = ?', u.id, code);
      if (!st) {
        const id = db.run(
          'INSERT INTO students (owner_id, student_code, name_km, name_latin, gender, email, phone, notes) VALUES (?,?,?,?,?,?,?,?)',
          u.id, code, r.name_km?.trim() || null, r.name_latin?.trim() || null, r.gender?.trim() || null, r.email?.trim() || null, r.phone?.trim() || null, r.notes?.trim() || null,
        ).id;
        st = { id };
        created++;
      }
      if (db.get("SELECT 1 FROM enrollments WHERE student_id = ? AND class_id = ? AND status = 'active'", st.id, classId)) { skipped++; continue; }
      db.run('INSERT INTO enrollments (student_id, class_id, enrolled_on) VALUES (?,?,?)', st.id, classId, on);
      enrolled++;
    }
    db.audit(u.id, 'class', classId, 'roster.import', undefined, { created, enrolled, skipped });
    return { created, enrolled, skipped };
  });
}

/** Ends the current enrollment and opens a new one; grades and attendance stay with the old one. */
export function transferEnrollment(db: DB, u: User, enrollmentId: number, toClassId: number, note?: string) {
  const e = ownEnrollment(db, u, enrollmentId);
  ownClass(db, u, toClassId);
  if (e.status !== 'active') throw new AppError(409, 'Only an active enrollment can be transferred.');
  if (e.class_id === toClassId) throw new AppError(422, 'Choose a different class.');
  const on = today(db, u);
  return db.tx(() => {
    const newId = db.run('INSERT INTO enrollments (student_id, class_id, enrolled_on, note) VALUES (?,?,?,?)', e.student_id, toClassId, on, note ?? `Transferred from class #${e.class_id}`).id;
    db.run("UPDATE enrollments SET status = 'transferred', ended_on = ?, transferred_to_id = ?, note = COALESCE(?, note) WHERE id = ?", on, newId, note ?? null, enrollmentId);
    db.audit(u.id, 'enrollment', enrollmentId, 'transfer', e, { toClassId, newEnrollmentId: newId });
    return { enrollmentId: newId };
  });
}

export function setEnrollmentStatus(db: DB, u: User, enrollmentId: number, status: string, note?: string) {
  const e = ownEnrollment(db, u, enrollmentId);
  if (!['active', 'dropped', 'withdrawn', 'completed'].includes(status)) throw new AppError(422, 'Unknown enrollment status.');
  db.tx(() => {
    db.run('UPDATE enrollments SET status = ?, ended_on = ?, note = COALESCE(?, note) WHERE id = ?', status, status === 'active' ? null : today(db, u), note ?? null, enrollmentId);
    db.audit(u.id, 'enrollment', enrollmentId, `status.${status}`, e, { status, note });
  });
}
