import { DatabaseSync, type SQLInputValue } from 'node:sqlite';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { MIGRATIONS } from './schema.ts';

export type Row = Record<string, any>;

export class DB {
  readonly raw: DatabaseSync;
  private depth = 0;

  constructor(file: string) {
    if (file !== ':memory:') mkdirSync(dirname(file), { recursive: true });
    this.raw = new DatabaseSync(file);
    this.raw.exec('PRAGMA foreign_keys = ON; PRAGMA journal_mode = WAL; PRAGMA busy_timeout = 5000;');
    this.migrate();
  }

  private migrate() {
    this.raw.exec('CREATE TABLE IF NOT EXISTS schema_meta (version INTEGER NOT NULL)');
    const row = this.raw.prepare('SELECT version FROM schema_meta').get() as Row | undefined;
    let version = row?.version ?? 0;
    if (!row) this.raw.prepare('INSERT INTO schema_meta (version) VALUES (0)').run();
    for (; version < MIGRATIONS.length; version++) {
      this.tx(() => {
        this.raw.exec(MIGRATIONS[version]);
        this.raw.prepare('UPDATE schema_meta SET version = ?').run(version + 1);
      });
    }
  }

  get schemaVersion(): number {
    return (this.raw.prepare('SELECT version FROM schema_meta').get() as Row).version;
  }

  all<T = Row>(sql: string, ...params: SQLInputValue[]): T[] {
    return this.raw.prepare(sql).all(...params) as T[];
  }

  get<T = Row>(sql: string, ...params: SQLInputValue[]): T | undefined {
    return this.raw.prepare(sql).get(...params) as T | undefined;
  }

  run(sql: string, ...params: SQLInputValue[]) {
    const r = this.raw.prepare(sql).run(...params);
    return { changes: Number(r.changes), id: Number(r.lastInsertRowid) };
  }

  /** Runs `fn` in a transaction; nested calls join the outer transaction via savepoints. */
  tx<T>(fn: () => T): T {
    const sp = `sp${this.depth}`;
    this.raw.exec(this.depth === 0 ? 'BEGIN IMMEDIATE' : `SAVEPOINT ${sp}`);
    this.depth++;
    try {
      const out = fn();
      this.depth--;
      this.raw.exec(this.depth === 0 ? 'COMMIT' : `RELEASE ${sp}`);
      return out;
    } catch (e) {
      this.depth--;
      this.raw.exec(this.depth === 0 ? 'ROLLBACK' : `ROLLBACK TO ${sp}; RELEASE ${sp}`);
      throw e;
    }
  }

  audit(userId: number | null, entity: string, entityId: number | null, action: string, before?: unknown, after?: unknown) {
    this.run(
      'INSERT INTO audit_log (user_id, entity, entity_id, action, before_json, after_json) VALUES (?,?,?,?,?,?)',
      userId, entity, entityId, action, before === undefined ? null : JSON.stringify(before), after === undefined ? null : JSON.stringify(after),
    );
  }

  close() {
    this.raw.close();
  }
}

/** Expected failure that the API turns into a 4xx response with a readable message. */
export class AppError extends Error {
  constructor(public status: number, message: string, public details?: unknown) {
    super(message);
  }
}

const TRIGGER_MESSAGES: Record<string, [number, string]> = {
  SCORE_ABOVE_MAX: [422, 'The score is above the maximum for this component.'],
  SCORE_WRONG_CLASS: [422, 'This student is not enrolled in the class this grade belongs to.'],
  GRADEBOOK_FINALIZED: [409, 'This gradebook is finalized. Reopen it before changing scores.'],
  MAX_BELOW_EXISTING_SCORES: [422, 'Some students already have scores above the new maximum. Correct those scores first.'],
  GRADE_TOTAL_MISMATCH: [422, 'The component maximums must add up to the target total before the gradebook can be activated.'],
  CONFIG_NOT_DRAFT: [409, 'Return the grading setup to draft before changing components.'],
  ATTENDANCE_SESSION_NOT_HELD: [422, 'Attendance cannot be recorded for a cancelled, skipped or moved session.'],
  ATTENDANCE_WRONG_CLASS: [422, 'This student is not enrolled in the class for this session.'],
  SESSION_HAS_HISTORY: [409, 'This session has teaching or attendance records and cannot be deleted.'],
  SESSION_HAS_ATTENDANCE: [409, 'This session already has attendance records. Clear them before cancelling or moving it.'],
  PAY_LOCKED: [409, 'This is part of an approved pay statement. Undo the approval first.'],
  PAY_PAID: [409, 'This pay statement is marked paid and cannot be changed.'],
};

export function translateDbError(e: unknown): AppError | null {
  const msg = e instanceof Error ? e.message : String(e);
  for (const [code, [status, text]] of Object.entries(TRIGGER_MESSAGES)) if (msg.includes(code)) return new AppError(status, text, { code });
  if (msg.includes('UNIQUE constraint failed: enrollments.student_id, enrollments.class_id')) return new AppError(409, 'The student is already actively enrolled in this class.');
  if (msg.includes('enrollments_one_active')) return new AppError(409, 'The student is already actively enrolled in this class.');
  if (msg.includes('UNIQUE constraint failed: students')) return new AppError(409, 'A student with this ID already exists.');
  if (msg.includes('UNIQUE constraint failed: courses')) return new AppError(409, 'A course with this code already exists.');
  if (msg.includes('UNIQUE constraint failed: classes')) return new AppError(409, 'A class with this code already exists in the term.');
  if (msg.includes('UNIQUE constraint failed')) return new AppError(409, 'This record already exists.');
  if (msg.includes('FOREIGN KEY constraint failed')) return new AppError(409, 'Other records depend on this item, so it cannot be removed. Archive it instead.');
  if (msg.includes('CHECK constraint failed')) return new AppError(422, `A value is outside the allowed range (${msg.replace(/.*CHECK constraint failed: /, '')}).`);
  return null;
}
