import { AppError, translateDbError, type DB, type Row } from '../db.ts';
import type { User } from '../auth.ts';
import { ownClass, ownEnrollment, ownSession, today } from './access.ts';
import {
  attendanceScore, checkConfig, classStats, computeStudent, DEFAULT_ATTENDANCE_RULE, DEFAULT_COMPONENTS, validateScore,
  type AttendanceMark, type AttendanceRule, type GradeConfig,
} from '../../shared/grades.ts';

// ---------------------------------------------------------------------------------------------
// Grading configuration

export function ensureConfig(db: DB, classId: number): Row {
  const existing = db.get('SELECT * FROM grade_configs WHERE class_id = ?', classId);
  if (existing) return existing;
  return db.tx(() => {
    const term = db.get('SELECT t.grade_target FROM classes c JOIN terms t ON t.id = c.term_id WHERE c.id = ?', classId)!;
    const id = db.run('INSERT INTO grade_configs (class_id, target_total) VALUES (?, ?)', classId, term.grade_target).id;
    for (const c of DEFAULT_COMPONENTS) db.run('INSERT INTO grade_components (config_id, position, key, name, max_score, kind) VALUES (?,?,?,?,?,?)', id, c.position, c.key, c.name, c.max, c.kind);
    if (term.grade_target === 100) db.run("UPDATE grade_configs SET status = 'active' WHERE id = ?", id);
    return db.get('SELECT * FROM grade_configs WHERE id = ?', id)!;
  });
}

export function loadConfig(db: DB, classId: number): { row: Row; config: GradeConfig } {
  const row = ensureConfig(db, classId);
  const components = db.all('SELECT * FROM grade_components WHERE config_id = ? ORDER BY position, id', row.id).map((c) => ({ id: c.id, key: c.key, name: c.name, max: c.max_score, kind: c.kind, position: c.position }));
  let rule: AttendanceRule = DEFAULT_ATTENDANCE_RULE;
  try { rule = { ...DEFAULT_ATTENDANCE_RULE, ...JSON.parse(row.attendance_rule) }; } catch { /* keep default */ }
  return { row, config: { targetTotal: row.target_total, passMark: row.pass_mark, labelPass: row.label_pass, labelFail: row.label_fail, components, attendanceRule: rule } };
}

export interface ConfigBody {
  targetTotal: number;
  passMark: number;
  labelPass: string;
  labelFail: string;
  attendanceRule?: AttendanceRule;
  components: Array<{ id?: number; key?: string; name: string; max: number; kind?: 'manual' | 'attendance' }>;
}

export function saveConfig(db: DB, u: User, classId: number, body: ConfigBody) {
  ownClass(db, u, classId);
  const { row, config: before } = loadConfig(db, classId);
  if (row.status === 'finalized') throw new AppError(409, 'This gradebook is finalized. Reopen it before changing the grading setup.');
  const rule = body.attendanceRule ?? before.attendanceRule;
  if (!(rule.lateCredit >= 0 && rule.lateCredit <= 1)) throw new AppError(422, 'Late credit must be between 0 and 1.');
  const comps = body.components.map((c, i) => ({ ...c, key: (c.key || c.name).toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_|_$/g, '') || `c${i + 1}`, kind: c.kind ?? 'manual', position: i + 1 }));
  const seen = new Set<string>();
  for (const c of comps) {
    let k = c.key, n = 2;
    while (seen.has(k)) k = `${c.key}_${n++}`;
    seen.add((c.key = k));
  }
  const check = checkConfig({ targetTotal: body.targetTotal, passMark: body.passMark, components: comps.map((c, i) => ({ ...c, id: c.id ?? -i })) });

  try {
    db.tx(() => {
      db.run("UPDATE grade_configs SET status = 'draft' WHERE id = ?", row.id);
      db.run(
        "UPDATE grade_configs SET target_total=?, pass_mark=?, label_pass=?, label_fail=?, attendance_rule=?, updated_at=datetime('now') WHERE id=?",
        body.targetTotal, body.passMark, body.labelPass.trim() || 'ជាប់', body.labelFail.trim() || 'ធ្លាក់', JSON.stringify(rule), row.id,
      );
      const keep = new Set(comps.filter((c) => c.id).map((c) => c.id));
      for (const old of before.components) if (!keep.has(old.id)) db.run('DELETE FROM grade_components WHERE id = ?', old.id);
      // Temporarily move keys aside so renames between components never collide.
      db.run("UPDATE grade_components SET key = '__' || id WHERE config_id = ?", row.id);
      for (const c of comps) {
        if (c.id) db.run('UPDATE grade_components SET position=?, key=?, name=?, max_score=?, kind=? WHERE id=? AND config_id=?', c.position, c.key, c.name.trim(), c.max, c.kind, c.id, row.id);
        else db.run('INSERT INTO grade_components (config_id, position, key, name, max_score, kind) VALUES (?,?,?,?,?,?)', row.id, c.position, c.key, c.name.trim(), c.max, c.kind);
      }
      // A valid configuration that was in use stays in use; an invalid one stays a draft.
      if (row.status === 'active' && check.valid) db.run("UPDATE grade_configs SET status = 'active' WHERE id = ?", row.id);
      db.audit(u.id, 'grade_config', row.id, 'update', before, body);
    });
  } catch (e) {
    const mapped = translateDbError(e);
    if (mapped?.message.includes('Other records depend')) throw new AppError(409, 'A component you removed already has scores. Clear those scores first, or keep the component.');
    throw mapped ?? e;
  }
  return gradebook(db, u, classId);
}

export function setConfigStatus(db: DB, u: User, classId: number, status: 'draft' | 'active' | 'finalized') {
  ownClass(db, u, classId);
  const { row, config } = loadConfig(db, classId);
  if (status !== 'draft') {
    const check = checkConfig(config);
    if (!check.valid) throw new AppError(422, check.errors.join(' '), { errors: check.errors });
  }
  db.tx(() => {
    db.run('UPDATE grade_configs SET status = ? WHERE id = ?', status, row.id);
    db.audit(u.id, 'grade_config', row.id, `status.${status}`, { status: row.status }, { status });
  });
  return gradebook(db, u, classId);
}

// ---------------------------------------------------------------------------------------------
// Gradebook

function attendanceMarks(db: DB, classId: number): Map<number, AttendanceMark[]> {
  const rows = db.all(
    `SELECT a.enrollment_id, a.status FROM attendance a JOIN sessions s ON s.id = a.session_id
      WHERE s.class_id = ? AND s.status IN ('planned','completed')`,
    classId,
  );
  const m = new Map<number, AttendanceMark[]>();
  for (const r of rows) m.set(r.enrollment_id, [...(m.get(r.enrollment_id) ?? []), r.status]);
  return m;
}

export function gradebook(db: DB, u: User, classId: number) {
  const cls = ownClass(db, u, classId);
  const { row, config } = loadConfig(db, classId);
  const check = checkConfig(config);
  const students = db.all(
    `SELECT e.id AS enrollment_id, e.status AS enrollment_status, s.id AS student_id, s.student_code, s.name_km, s.name_latin, s.gender
       FROM enrollments e JOIN students s ON s.id = e.student_id WHERE e.class_id = ?
      ORDER BY CASE e.status WHEN 'active' THEN 0 WHEN 'completed' THEN 0 ELSE 1 END, s.student_code`,
    classId,
  );
  const scoreRows = db.all(
    `SELECT sc.* FROM scores sc JOIN grade_components c ON c.id = sc.component_id WHERE c.config_id = ?`,
    row.id,
  );
  const scores = new Map<number, Record<number, { value: number; version: number }>>();
  for (const s of scoreRows) scores.set(s.enrollment_id, { ...(scores.get(s.enrollment_id) ?? {}), [s.component_id]: { value: s.value, version: s.version } });
  const marks = attendanceMarks(db, classId);
  const attComp = config.components.find((c) => c.kind === 'attendance');

  const rows = students.map((st) => {
    const sc = scores.get(st.enrollment_id) ?? {};
    const att = attComp ? attendanceScore(marks.get(st.enrollment_id) ?? [], attComp.max, config.attendanceRule) : null;
    const result = computeStudent(config, Object.fromEntries(Object.entries(sc).map(([k, v]) => [k, v.value])), att?.score ?? null);
    const usable = check.valid;
    return {
      enrollmentId: st.enrollment_id, enrollmentStatus: st.enrollment_status, studentId: st.student_id, code: st.student_code, nameKm: st.name_km, nameLatin: st.name_latin, gender: st.gender,
      scores: sc, attendance: att, ...result,
      result: usable ? result.result : 'incomplete', label: usable ? result.label : '',
    };
  });
  const counted = rows.filter((r) => r.enrollmentStatus === 'active' || r.enrollmentStatus === 'completed');
  return {
    classId, classCode: cls.code,
    config: { id: row.id, status: row.status, ...config },
    check,
    rows,
    stats: classStats(counted),
  };
}

// ---------------------------------------------------------------------------------------------
// Attendance

export function sessionAttendance(db: DB, u: User, sessionId: number) {
  const s = ownSession(db, u, sessionId);
  const roster = db.all(
    `SELECT e.id AS enrollment_id, e.status AS enrollment_status, st.student_code, st.name_km, st.name_latin,
            a.status, a.version, a.note
       FROM enrollments e JOIN students st ON st.id = e.student_id
       LEFT JOIN attendance a ON a.enrollment_id = e.id AND a.session_id = ?
      WHERE e.class_id = ? AND e.enrolled_on <= ? AND (e.status = 'active' OR e.ended_on IS NULL OR e.ended_on >= ? OR a.id IS NOT NULL)
      ORDER BY st.student_code`,
    sessionId, s.class_id, s.date, s.date,
  );
  const now = today(db, u);
  return {
    session: { id: s.id, classId: s.class_id, date: s.date, start: s.start_time, end: s.end_time, kind: s.kind, status: s.status },
    editable: !['cancelled', 'moved', 'skipped'].includes(s.status) && s.date <= now,
    reason: ['cancelled', 'moved', 'skipped'].includes(s.status) ? `This session is ${s.status}, so it has no attendance.` : s.date > now ? 'Attendance opens on the day of the session.' : null,
    roster: roster.map((r) => ({ enrollmentId: r.enrollment_id, enrollmentStatus: r.enrollment_status, code: r.student_code, nameKm: r.name_km, nameLatin: r.name_latin, status: r.status ?? null, version: r.version ?? null, note: r.note })),
  };
}

export function attendanceSummary(db: DB, u: User, classId: number) {
  ownClass(db, u, classId);
  const { config } = loadConfig(db, classId);
  const attComp = config.components.find((c) => c.kind === 'attendance');
  const sessions = db.all(
    `SELECT s.id, s.date, s.start_time, s.kind, s.status, (SELECT COUNT(*) FROM attendance a WHERE a.session_id = s.id) AS marked
       FROM sessions s WHERE s.class_id = ? AND s.status NOT IN ('moved') ORDER BY s.date, s.start_time`,
    classId,
  );
  const marks = attendanceMarks(db, classId);
  const students = db.all(
    `SELECT e.id, e.status, st.student_code, st.name_km, st.name_latin FROM enrollments e JOIN students st ON st.id = e.student_id WHERE e.class_id = ? ORDER BY st.student_code`,
    classId,
  );
  const cells = db.all('SELECT a.session_id, a.enrollment_id, a.status FROM attendance a JOIN sessions s ON s.id = a.session_id WHERE s.class_id = ?', classId);
  return {
    sessions,
    rule: config.attendanceRule,
    max: attComp?.max ?? null,
    cells,
    students: students.map((s) => ({ enrollmentId: s.id, enrollmentStatus: s.status, code: s.student_code, nameKm: s.name_km, nameLatin: s.name_latin, ...attendanceScore(marks.get(s.id) ?? [], attComp?.max ?? 0, config.attendanceRule) })),
  };
}

// ---------------------------------------------------------------------------------------------
// Sync: the single write path for scores and attendance, used online and when replaying the
// offline queue. Each operation carries the version the client last saw; if the server has moved
// on to a different value, the operation is reported as a conflict instead of overwriting it.

export type SyncOp =
  | { opId: string; type: 'score'; enrollmentId: number; componentId: number; value: number | null; baseVersion: number | null }
  | { opId: string; type: 'attendance'; sessionId: number; enrollmentId: number; status: AttendanceMark | null; baseVersion: number | null; note?: string | null };

export type SyncResult =
  | { opId: string; status: 'applied'; version: number | null }
  | { opId: string; status: 'conflict'; server: { value: unknown; version: number | null }; message: string }
  | { opId: string; status: 'error'; message: string };

function applyScore(db: DB, u: User, op: Extract<SyncOp, { type: 'score' }>): SyncResult {
  const e = ownEnrollment(db, u, op.enrollmentId);
  const comp = db.get('SELECT c.*, gc.class_id, gc.status AS config_status FROM grade_components c JOIN grade_configs gc ON gc.id = c.config_id WHERE c.id = ?', op.componentId);
  if (!comp || comp.class_id !== e.class_id) return { opId: op.opId, status: 'error', message: 'This grade column does not belong to the student’s class.' };
  if (comp.config_status === 'finalized') return { opId: op.opId, status: 'error', message: 'This gradebook is finalized.' };
  if (op.value !== null) {
    const err = validateScore(op.value, comp.max_score);
    if (err) return { opId: op.opId, status: 'error', message: `${comp.name}: ${err}` };
  }
  const cur = db.get('SELECT * FROM scores WHERE enrollment_id = ? AND component_id = ?', op.enrollmentId, op.componentId);
  const curValue = cur?.value ?? null;
  if (curValue === op.value) return { opId: op.opId, status: 'applied', version: cur?.version ?? null };
  if ((cur?.version ?? null) !== op.baseVersion) {
    return { opId: op.opId, status: 'conflict', server: { value: curValue, version: cur?.version ?? null }, message: `${comp.name} was changed to ${curValue ?? 'empty'} on another device.` };
  }
  if (op.value === null) {
    db.run('DELETE FROM scores WHERE id = ?', cur!.id);
    db.audit(u.id, 'score', cur!.id, 'clear', { value: cur!.value }, { enrollmentId: op.enrollmentId, componentId: op.componentId, value: null });
    return { opId: op.opId, status: 'applied', version: null };
  }
  if (cur) {
    db.run("UPDATE scores SET value = ?, version = version + 1, updated_by = ?, updated_at = datetime('now') WHERE id = ?", op.value, u.id, cur.id);
    db.audit(u.id, 'score', cur.id, 'update', { value: cur.value }, { value: op.value });
    return { opId: op.opId, status: 'applied', version: cur.version + 1 };
  }
  const id = db.run('INSERT INTO scores (enrollment_id, component_id, value, updated_by) VALUES (?,?,?,?)', op.enrollmentId, op.componentId, op.value, u.id).id;
  db.audit(u.id, 'score', id, 'create', undefined, { enrollmentId: op.enrollmentId, componentId: op.componentId, value: op.value });
  return { opId: op.opId, status: 'applied', version: 1 };
}

function applyAttendance(db: DB, u: User, op: Extract<SyncOp, { type: 'attendance' }>): SyncResult {
  const s = ownSession(db, u, op.sessionId);
  const e = ownEnrollment(db, u, op.enrollmentId);
  if (e.class_id !== s.class_id) return { opId: op.opId, status: 'error', message: 'The student is not in this session’s class.' };
  if (['cancelled', 'moved', 'skipped'].includes(s.status)) return { opId: op.opId, status: 'error', message: `This session is ${s.status}; no attendance is kept for it.` };
  if (s.date > today(db, u)) return { opId: op.opId, status: 'error', message: 'Attendance for a future session cannot be recorded yet.' };
  if (op.status !== null && !['present', 'late', 'absent', 'excused'].includes(op.status)) return { opId: op.opId, status: 'error', message: 'Unknown attendance mark.' };
  const cur = db.get('SELECT * FROM attendance WHERE session_id = ? AND enrollment_id = ?', op.sessionId, op.enrollmentId);
  const curValue = cur?.status ?? null;
  if (curValue === op.status && (op.note === undefined || op.note === (cur?.note ?? null))) return { opId: op.opId, status: 'applied', version: cur?.version ?? null };
  if ((cur?.version ?? null) !== op.baseVersion) {
    return { opId: op.opId, status: 'conflict', server: { value: curValue, version: cur?.version ?? null }, message: `Attendance was changed to ${curValue ?? 'unmarked'} on another device.` };
  }
  if (op.status === null) {
    db.run('DELETE FROM attendance WHERE id = ?', cur!.id);
    db.audit(u.id, 'attendance', cur!.id, 'clear', { status: cur!.status }, null);
    return { opId: op.opId, status: 'applied', version: null };
  }
  if (cur) {
    db.run("UPDATE attendance SET status = ?, note = COALESCE(?, note), version = version + 1, updated_by = ?, updated_at = datetime('now') WHERE id = ?", op.status, op.note ?? null, u.id, cur.id);
    db.audit(u.id, 'attendance', cur.id, 'update', { status: cur.status }, { status: op.status });
    return { opId: op.opId, status: 'applied', version: cur.version + 1 };
  }
  const id = db.run('INSERT INTO attendance (session_id, enrollment_id, status, note, updated_by) VALUES (?,?,?,?,?)', op.sessionId, op.enrollmentId, op.status, op.note ?? null, u.id).id;
  db.audit(u.id, 'attendance', id, 'create', undefined, { sessionId: op.sessionId, enrollmentId: op.enrollmentId, status: op.status });
  return { opId: op.opId, status: 'applied', version: 1 };
}

export function applySync(db: DB, u: User, ops: SyncOp[]): SyncResult[] {
  if (!Array.isArray(ops) || ops.length > 2000) throw new AppError(422, 'Send between 1 and 2000 changes at a time.');
  return db.tx(() =>
    ops.map((op) => {
      try {
        return db.tx(() => (op.type === 'score' ? applyScore(db, u, op) : op.type === 'attendance' ? applyAttendance(db, u, op) : { opId: (op as any).opId, status: 'error' as const, message: 'Unknown change type.' }));
      } catch (e) {
        const m = e instanceof AppError ? e : translateDbError(e);
        return { opId: op.opId, status: 'error' as const, message: m?.message ?? 'The change could not be saved.' };
      }
    }),
  );
}
