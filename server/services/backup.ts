import { createHash } from 'node:crypto';
import { existsSync, renameSync, rmSync } from 'node:fs';
import ExcelJS from 'exceljs';
import { AppError, DB, type Row } from '../db.ts';

// Backup format (documented in README): a JSON object
//   { format: "krubook-backup", schemaVersion, exportedAt, counts: {table: n}, checksum, tables: {table: rows[]} }
// `checksum` is the SHA-256 of JSON.stringify(tables). Login sessions are never included.

/** Insert order respects foreign keys. */
export const BACKUP_TABLES = [
  'users', 'settings', 'courses', 'lessons', 'lesson_parts', 'materials', 'template_weeks', 'terms', 'holidays',
  'classes', 'meetings', 'sessions', 'teaching_records', 'record_parts', 'schedule_proposals', 'students', 'enrollments',
  'grade_configs', 'grade_components', 'scores', 'attendance', 'rates', 'pay_adjustments', 'payments', 'notification_log', 'audit_log',
] as const;

export interface Backup {
  format: 'krubook-backup';
  schemaVersion: number;
  exportedAt: string;
  counts: Record<string, number>;
  checksum: string;
  tables: Record<string, Row[]>;
}

const checksum = (tables: Record<string, Row[]>) => createHash('sha256').update(JSON.stringify(tables)).digest('hex');

export function exportBackup(db: DB): Backup {
  const tables: Record<string, Row[]> = {};
  for (const t of BACKUP_TABLES) tables[t] = db.all(`SELECT * FROM ${t} ORDER BY rowid`);
  return {
    format: 'krubook-backup',
    schemaVersion: db.schemaVersion,
    exportedAt: new Date().toISOString(),
    counts: Object.fromEntries(Object.entries(tables).map(([k, v]) => [k, v.length])),
    checksum: checksum(tables),
    tables,
  };
}

export async function exportBackupXlsx(db: DB): Promise<Buffer> {
  const b = exportBackup(db);
  const wb = new ExcelJS.Workbook();
  const info = wb.addWorksheet('About');
  info.addRows([['KruBook full backup'], ['Exported', b.exportedAt], ['Schema version', b.schemaVersion], ['Checksum (JSON)', b.checksum], ['Restore', 'Restore uses the JSON backup file. This workbook is a readable copy of every table.']]);
  for (const t of BACKUP_TABLES) {
    const rows = b.tables[t].map((r) => (t === 'users' ? { ...r, password_hash: '(hidden)' } : r));
    const ws = wb.addWorksheet(t.slice(0, 31));
    const cols = rows[0] ? Object.keys(rows[0]) : db.all(`PRAGMA table_info(${t})`).map((c) => c.name);
    ws.columns = cols.map((c) => ({ header: c, key: c, width: Math.min(40, Math.max(10, c.length + 2)), style: c.includes('code') || c === 'phone' ? { numFmt: '@' } : {} }));
    ws.getRow(1).font = { bold: true };
    for (const r of rows) ws.addRow(r);
  }
  return Buffer.from(await wb.xlsx.writeBuffer());
}

/**
 * Validates a backup by loading it into a fresh in-memory database with every constraint and
 * trigger active. Returns that database so it can become the live one.
 */
export function loadBackup(input: unknown): { db: DB; counts: Record<string, number> } {
  const b = input as Backup;
  if (!b || b.format !== 'krubook-backup' || typeof b.tables !== 'object') throw new AppError(422, 'This file is not a KruBook backup.');
  if (checksum(b.tables) !== b.checksum) throw new AppError(422, 'The backup checksum does not match its contents. The file is damaged or was edited.');
  const db = new DB(':memory:');
  if (b.schemaVersion > db.schemaVersion) { db.close(); throw new AppError(422, `This backup comes from a newer version of KruBook (schema ${b.schemaVersion}).`); }
  try {
    db.tx(() => {
      const deferredConfigStatus: Array<[number, string]> = [];
      const deferredTransfers: Array<[number, number]> = [];
      for (const t of BACKUP_TABLES) {
        const rows = b.tables[t] ?? [];
        if (b.counts?.[t] !== undefined && b.counts[t] !== rows.length) throw new AppError(422, `Table ${t} should contain ${b.counts[t]} rows but has ${rows.length}.`);
        const cols = new Set(db.all(`PRAGMA table_info(${t})`).map((c) => c.name));
        for (const r0 of rows) {
          const r = { ...r0 };
          if (t === 'grade_configs' && r.status !== 'draft') { deferredConfigStatus.push([r.id, r.status]); r.status = 'draft'; }
          if (t === 'enrollments' && r.transferred_to_id) { deferredTransfers.push([r.id, r.transferred_to_id]); r.transferred_to_id = null; }
          const keys = Object.keys(r).filter((k) => cols.has(k));
          db.run(`INSERT INTO ${t} (${keys.join(',')}) VALUES (${keys.map(() => '?').join(',')})`, ...keys.map((k) => r[k]));
        }
        if (t === 'scores') for (const [id, status] of deferredConfigStatus) db.run('UPDATE grade_configs SET status = ? WHERE id = ?', status, id);
        if (t === 'enrollments') for (const [id, to] of deferredTransfers) db.run('UPDATE enrollments SET transferred_to_id = ? WHERE id = ?', to, id);
      }
      const fk = db.all('PRAGMA foreign_key_check');
      if (fk.length) throw new AppError(422, `The backup has ${fk.length} broken reference(s), first in table ${fk[0].table}.`);
    });
    const ok = db.get('PRAGMA integrity_check');
    if (ok?.integrity_check !== 'ok') throw new AppError(422, 'The restored database failed its integrity check.');
  } catch (e) {
    db.close();
    if (e instanceof AppError) throw e;
    throw new AppError(422, `The backup could not be loaded: ${(e as Error).message}`);
  }
  const counts = Object.fromEntries(BACKUP_TABLES.map((t) => [t, (db.get(`SELECT COUNT(*) AS n FROM ${t}`) as Row).n]));
  return { db, counts };
}

/** Writes a validated backup to `file`, keeping the previous database next to it. */
export function restoreToFile(input: unknown, file: string, closeLive: () => void): { counts: Record<string, number>; previous: string | null } {
  const { db, counts } = loadBackup(input);
  const tmp = `${file}.restore-${Date.now()}`;
  db.raw.exec(`VACUUM INTO '${tmp.replace(/'/g, "''")}'`);
  db.close();
  closeLive();
  let previous: string | null = null;
  if (existsSync(file)) {
    previous = `${file}.before-restore-${new Date().toISOString().replace(/[:.]/g, '-')}`;
    renameSync(file, previous);
    for (const ext of ['-wal', '-shm']) if (existsSync(file + ext)) rmSync(file + ext);
  }
  renameSync(tmp, file);
  return { counts, previous };
}
