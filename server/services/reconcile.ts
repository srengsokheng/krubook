import { AppError, translateDbError, type DB, type Row } from '../db.ts';
import type { User } from '../auth.ts';
import { classScope, ownClass, ownSession, payStartDay, today } from './access.ts';
import { cancelSession, classSummary, completeSession, createProposal, orderedParts } from './plan.ts';
import { loadRates, payOverview } from './pay.ts';
import { loadConfig } from './records.ts';
import { durationMinutes } from '../../shared/dates.ts';
import { payMonthOf, resolveRate, sessionPay } from '../../shared/pay.ts';
import { attendanceScore, computeStudent, type AttendanceMark } from '../../shared/grades.ts';

// Three review-first workflows. Each one previews its effect, changes nothing until confirmed,
// and writes every change to the audit log.

const ROLLBACK = Symbol('preview');

/** Runs `fn` in a transaction and rolls it back, so a preview shows exactly what applying would do. */
function preview<T>(db: DB, fn: () => T): T {
  let out: T | undefined;
  try {
    db.tx(() => { out = fn(); throw ROLLBACK; });
  } catch (e) {
    if (e !== ROLLBACK) throw e;
  }
  return out as T;
}

// =============================================================================================
// 1. Past sessions without a teaching record

export function unrecordedSessions(db: DB, u: User) {
  const sc = classScope(u);
  const now = today(db, u);
  const rates = loadRates(db, u.id);
  const rows = db.all(
    `SELECT s.*, c.code, c.course_id, co.name AS course_name, co.color FROM sessions s
       JOIN classes c ON c.id = s.class_id JOIN courses co ON co.id = c.course_id
      WHERE ${sc.where} AND s.status = 'planned' AND s.date < ? AND c.status <> 'archived'
      ORDER BY c.code, s.date, s.start_time`,
    ...sc.params, now,
  );
  const parts = new Map<number, Map<number, Row>>();
  return rows.map((s) => {
    if (!parts.has(s.course_id)) parts.set(s.course_id, new Map(orderedParts(db, s.course_id).map((p) => [p.id, p])));
    const p = s.part_id ? parts.get(s.course_id)!.get(s.part_id) : null;
    const minutes = durationMinutes(s.start_time, s.end_time);
    const rate = resolveRate(rates, { classId: s.class_id, courseId: s.course_id, date: s.date });
    return {
      sessionId: s.id, classId: s.class_id, code: s.code, color: s.color, courseName: s.course_name, week: s.week,
      date: s.date, start: s.start_time, end: s.end_time, minutes, kind: s.kind, activity: s.activity,
      plannedPart: p ? { id: p.id, code: p.code, title: p.title ?? p.lessonTitle } : null,
      note: s.note, estimatedPay: rate ? sessionPay(rate, minutes) : null,
    };
  });
}

export type Decision =
  | { sessionId: number; action: 'taught'; parts?: Array<{ partId: number; coverage: 'full' | 'partial' }>; minutes?: number; note?: string }
  | { sessionId: number; action: 'cancelled' | 'skipped'; note?: string }
  | { sessionId: number; action: 'leave' };

function snapshot(db: DB, u: User, classIds: number[], months: string[]) {
  const years = [...new Set(months.map((m) => m.slice(0, 4)))];
  const pay = years.flatMap((y) => payOverview(db, u, y).months).filter((m) => months.includes(m.month))
    .map((m) => ({ month: m.month, taughtSessions: m.taughtSessions, hours: Math.round((m.taughtMinutes / 60) * 100) / 100, estimated: m.estimated, total: m.total }));
  const progress = classIds.map((id) => {
    const s = classSummary(db, u, id);
    const c = db.get('SELECT code FROM classes WHERE id = ?', id)!;
    return { classId: id, code: c.code, status: s.progress.status, actual: s.progress.actual, expected: s.progress.expected, nextPart: s.nextPart?.code ?? null, unrecorded: s.unrecorded.length };
  });
  return { pay, progress };
}

/**
 * Applies the teacher's decisions for past sessions. Sessions are never marked taught because their
 * date passed; each needs an explicit decision. With `dryRun` the same changes run and are rolled
 * back, returning before/after totals.
 */
export function reconcileSessions(db: DB, u: User, decisions: Decision[], dryRun: boolean) {
  if (!Array.isArray(decisions) || !decisions.length) throw new AppError(422, 'Choose at least one session.');
  if (decisions.length > 500) throw new AppError(422, 'Review at most 500 sessions at a time.');
  const seen = new Set<number>();
  const now = today(db, u);
  const acting = decisions.filter((d) => d.action !== 'leave');
  const sessions = new Map<number, Row>();
  for (const d of decisions) {
    if (seen.has(d.sessionId)) throw new AppError(422, `Session ${d.sessionId} appears twice.`);
    seen.add(d.sessionId);
    if (!['taught', 'cancelled', 'skipped', 'leave'].includes(d.action)) throw new AppError(422, 'Unknown decision.');
    const s = ownSession(db, u, Number(d.sessionId));
    if (d.action === 'leave') continue;
    if (s.status !== 'planned') throw new AppError(409, `The ${s.date} session is already ${s.status}; nothing to reconcile.`);
    if (s.date > now) throw new AppError(422, `The ${s.date} session is in the future.`);
    if (db.get('SELECT 1 FROM teaching_records WHERE session_id = ?', s.id)) throw new AppError(409, `The ${s.date} session already has a teaching record.`);
    sessions.set(s.id, s);
  }
  const classIds = [...new Set([...sessions.values()].map((s) => s.class_id))];
  const sd = payStartDay(db, u);
  const months = [...new Set([...sessions.values()].map((s) => payMonthOf(s.date, sd)))];
  const before = snapshot(db, u, classIds, months);

  const run = () => {
    const results: Array<{ sessionId: number; action: string; proposalId: number | null }> = [];
    for (const d of acting) {
      const s = sessions.get(d.sessionId)!;
      let proposal: Row | null = null;
      if (d.action === 'taught') {
        const parts = d.parts ?? (s.part_id && s.activity === 'lesson' ? [{ partId: s.part_id, coverage: 'full' as const }] : []);
        proposal = completeSession(db, u, s.id, { parts, minutes: d.minutes, notes: d.note || 'Recorded during reconciliation' }).proposal;
      } else if (d.action === 'cancelled') {
        proposal = cancelSession(db, u, s.id, d.note || 'Not held (reconciliation)').proposal;
      } else {
        db.run("UPDATE sessions SET status = 'skipped', note = ?, version = version + 1, updated_at = datetime('now') WHERE id = ?", d.note || 'Skipped (reconciliation)', s.id);
        db.audit(u.id, 'session', s.id, 'skip', { status: 'planned' }, { status: 'skipped', note: d.note });
        proposal = createProposal(db, u, s.class_id, `Session on ${s.date} skipped`, s.date);
      }
      results.push({ sessionId: s.id, action: d.action, proposalId: proposal?.id ?? null });
    }
    return { results, after: snapshot(db, u, classIds, months) };
  };

  try {
    const out = dryRun ? preview(db, run) : db.tx(run);
    return { applied: !dryRun, before, after: out.after, results: out.results, left: decisions.length - acting.length };
  } catch (e) {
    throw (e instanceof AppError ? e : translateDbError(e) ?? e);
  }
}

// =============================================================================================
// 2. Official student IDs from an authorised export

/** Latin names: no accents, no punctuation, lower case, single spaces; also an order-free key. */
export function normLatin(s: string | null | undefined) {
  const base = (s ?? '').normalize('NFKD').replace(/[̀-ͯ]/g, '').toLowerCase().replace(/[^a-z]+/g, ' ').trim();
  return { exact: base, tokens: base.split(' ').filter(Boolean).sort().join(' ') };
}

/** Khmer names: canonical composition, no spaces or zero-width characters. */
export function normKhmer(s: string | null | undefined) {
  return (s ?? '').normalize('NFC').replace(/[\s​‌‍ ]+/g, '');
}

export interface IdRow { row: number; officialId: string; nameKm?: string; nameLatin?: string; classCode?: string }

type Candidate = { studentId: number; code: string; nameKm: string | null; nameLatin: string | null; classes: string; by: string[] };

export interface IdMatch {
  row: number;
  officialId: string;
  input: { nameKm: string | null; nameLatin: string | null; classCode: string | null };
  status: 'unchanged' | 'match' | 'ambiguous' | 'none' | 'conflict' | 'invalid';
  reason: string;
  candidates: Candidate[];
  suggested: number | null; // student id, only when exactly one strong candidate
}

/** Proposes, never applies: every name-based match must be confirmed before IDs change. */
export function matchStudentIds(db: DB, u: User, rows: IdRow[]): { matches: IdMatch[]; summary: Record<string, number> } {
  if (!Array.isArray(rows) || !rows.length) throw new AppError(422, 'The file has no rows.');
  if (rows.length > 5000) throw new AppError(422, 'Send at most 5000 rows at a time.');
  const students = db.all(
    `SELECT s.id, s.student_code, s.name_km, s.name_latin,
            (SELECT group_concat(c.code, ', ') FROM enrollments e JOIN classes c ON c.id = e.class_id WHERE e.student_id = s.id) AS classes
       FROM students s WHERE s.owner_id = ?`, u.id,
  ).map((s: Row): Row => ({ ...s, km: normKhmer(s.name_km), lat: normLatin(s.name_latin), classList: (s.classes ?? '').split(', ').filter(Boolean) as string[] }));
  const byCode = new Map(students.map((s) => [s.student_code, s]));
  const idCount = new Map<string, number>();
  for (const r of rows) { const id = String(r.officialId ?? '').trim(); if (id) idCount.set(id, (idCount.get(id) ?? 0) + 1); }

  const matches: IdMatch[] = rows.map((r) => {
    const officialId = String(r.officialId ?? '').trim();
    const input = { nameKm: r.nameKm?.trim() || null, nameLatin: r.nameLatin?.trim() || null, classCode: r.classCode?.trim().toUpperCase() || null };
    const base = { row: r.row, officialId, input, candidates: [] as Candidate[], suggested: null as number | null };
    if (!officialId) return { ...base, status: 'invalid', reason: 'No official ID on this row.' };
    if (!/^[A-Za-z0-9._\-/]{1,40}$/.test(officialId)) return { ...base, status: 'invalid', reason: `"${officialId}" is not a valid ID (letters, digits and . _ - / only).` };
    if (!input.nameKm && !input.nameLatin) return { ...base, status: 'invalid', reason: 'No name to match on.' };
    if ((idCount.get(officialId) ?? 0) > 1) return { ...base, status: 'conflict', reason: `ID ${officialId} appears ${idCount.get(officialId)} times in the file.` };

    const km = normKhmer(input.nameKm), lat = normLatin(input.nameLatin);
    const cands: Candidate[] = [];
    for (const s of students) {
      const by: string[] = [];
      if (km && s.km === km) by.push('Khmer name');
      if (lat.exact && s.lat.exact === lat.exact) by.push('Latin name');
      else if (lat.tokens && s.lat.tokens === lat.tokens) by.push('Latin name (word order)');
      if (!by.length) continue;
      if (input.classCode && !s.classList.includes(input.classCode)) continue;
      cands.push({ studentId: s.id, code: s.student_code, nameKm: s.name_km, nameLatin: s.name_latin, classes: s.classes ?? '', by });
    }
    const owner = byCode.get(officialId);
    if (owner) {
      if (cands.some((c) => c.studentId === owner.id)) return { ...base, candidates: cands, status: 'unchanged', reason: `Already assigned to ${owner.name_latin ?? owner.name_km}.`, suggested: owner.id };
      return { ...base, candidates: cands, status: 'conflict', reason: `ID ${officialId} already belongs to ${owner.name_latin ?? owner.name_km} (${owner.classes ?? 'no class'}).` };
    }
    if (!cands.length) return { ...base, status: 'none', reason: input.classCode ? `No student with this name in ${input.classCode}.` : 'No student with this name.' };
    // A strong match agrees on every name the file gives.
    const strong = cands.filter((c) => (!km || c.by.includes('Khmer name')) && (!lat.exact || c.by.some((b) => b.startsWith('Latin'))));
    if (strong.length === 1 && cands.length === 1) return { ...base, candidates: cands, status: 'match', reason: `Matched by ${cands[0].by.join(' and ')}.`, suggested: cands[0].studentId };
    return { ...base, candidates: cands, status: 'ambiguous', reason: `${cands.length} students could match. Choose one, or leave it.` };
  });

  // Two rows suggesting the same student is a conflict for both.
  const targets = new Map<number, number[]>();
  for (const m of matches) if (m.status === 'match' && m.suggested) targets.set(m.suggested, [...(targets.get(m.suggested) ?? []), m.row]);
  for (const m of matches) {
    const rowsFor = m.suggested ? targets.get(m.suggested) : undefined;
    if (m.status === 'match' && rowsFor && rowsFor.length > 1) Object.assign(m, { status: 'conflict', suggested: null, reason: `Rows ${rowsFor.join(', ')} all match the same student.` });
  }
  const summary: Record<string, number> = {};
  for (const m of matches) summary[m.status] = (summary[m.status] ?? 0) + 1;
  return { matches, summary };
}

/** Changes student IDs after the teacher confirmed each one. Relations use internal ids, so history is untouched. */
export function applyStudentIds(db: DB, u: User, assignments: Array<{ studentId: number; newCode: string }>) {
  if (!Array.isArray(assignments) || !assignments.length) throw new AppError(422, 'Confirm at least one change.');
  const newCodes = new Set<string>();
  const ids = new Set<number>();
  for (const a of assignments) {
    const code = String(a.newCode ?? '').trim();
    if (!/^[A-Za-z0-9._\-/]{1,40}$/.test(code)) throw new AppError(422, `"${code}" is not a valid ID.`);
    if (newCodes.has(code)) throw new AppError(422, `ID ${code} is assigned twice.`);
    if (ids.has(a.studentId)) throw new AppError(422, 'A student is assigned two IDs.');
    newCodes.add(code); ids.add(a.studentId);
  }
  return db.tx(() => {
    const changed: Array<{ studentId: number; oldCode: string; newCode: string }> = [];
    for (const a of assignments) {
      const s = db.get('SELECT * FROM students WHERE id = ? AND owner_id = ?', a.studentId, u.id);
      if (!s) throw new AppError(404, `Student ${a.studentId} not found.`);
      const code = String(a.newCode).trim();
      if (s.student_code === code) continue;
      const other = db.get('SELECT id, name_latin FROM students WHERE owner_id = ? AND student_code = ? AND id <> ?', u.id, code, s.id);
      if (other && !ids.has(other.id)) throw new AppError(409, `ID ${code} already belongs to ${other.name_latin}.`);
      changed.push({ studentId: s.id, oldCode: s.student_code, newCode: code });
    }
    // Two passes so IDs can be swapped between students in the same batch without a collision.
    for (const c of changed) db.run('UPDATE students SET student_code = ? WHERE id = ?', `~tmp~${c.studentId}`, c.studentId);
    for (const c of changed) {
      db.run('UPDATE students SET student_code = ? WHERE id = ?', c.newCode, c.studentId);
      db.audit(u.id, 'student', c.studentId, 'id.change', { student_code: c.oldCode }, { student_code: c.newCode });
    }
    return { changed: changed.length, unchanged: assignments.length - changed.length, changes: changed };
  });
}

// =============================================================================================
// 3. Imported attendance + activity scores vs calculated attendance

function attendanceRows(db: DB, classId: number) {
  const { row, config } = loadConfig(db, classId);
  const comp = config.components.find((c) => c.kind === 'attendance');
  if (!comp) throw new AppError(409, 'This class has no attendance component in its grading setup.');
  const enrollments = db.all(
    `SELECT e.id, e.status, st.student_code, st.name_km, st.name_latin FROM enrollments e JOIN students st ON st.id = e.student_id
      WHERE e.class_id = ? ORDER BY st.student_code`, classId,
  );
  const scores = new Map<number, Record<number, number>>();
  for (const s of db.all('SELECT sc.enrollment_id, sc.component_id, sc.value FROM scores sc JOIN grade_components c ON c.id = sc.component_id WHERE c.config_id = ?', row.id)) {
    scores.set(s.enrollment_id, { ...(scores.get(s.enrollment_id) ?? {}), [s.component_id]: s.value });
  }
  const marks = new Map<number, AttendanceMark[]>();
  for (const m of db.all(`SELECT a.enrollment_id, a.status FROM attendance a JOIN sessions s ON s.id = a.session_id WHERE s.class_id = ? AND s.status IN ('planned','completed')`, classId)) {
    marks.set(m.enrollment_id, [...(marks.get(m.enrollment_id) ?? []), m.status]);
  }
  return { config, comp, enrollments, scores, marks };
}

export function attendancePreview(db: DB, u: User, classId: number) {
  ownClass(db, u, classId);
  const { config, comp, enrollments, scores, marks } = attendanceRows(db, classId);
  const archived = (db.get('SELECT COUNT(*) AS n FROM score_archive WHERE component_id = ? AND restored_at IS NULL', comp.id) as Row).n;
  const rows = enrollments.map((e) => {
    const sc = scores.get(e.id) ?? {};
    const override = sc[comp.id] ?? null;
    const att = attendanceScore(marks.get(e.id) ?? [], comp.max, config.attendanceRule);
    const without = { ...sc }; delete without[comp.id];
    const before = computeStudent(config, sc, att.score);
    const after = computeStudent(config, without, att.score);
    return {
      enrollmentId: e.id, enrollmentStatus: e.status, code: e.student_code, nameKm: e.name_km, nameLatin: e.name_latin,
      manual: override, calculated: att.score, sessionsCounted: att.counted,
      totalBefore: before.total, totalAfter: after.total, resultBefore: before.result, resultAfter: after.result,
      change: override == null ? 'none' : att.score == null ? 'becomes missing' : 'replaced',
    };
  });
  const sessionsWithRollCall = (db.get(`SELECT COUNT(DISTINCT a.session_id) AS n FROM attendance a JOIN sessions s ON s.id = a.session_id WHERE s.class_id = ?`, classId) as Row).n;
  return {
    component: { id: comp.id, name: comp.name, max: comp.max }, rule: config.attendanceRule, sessionsWithRollCall, archived,
    rows,
    summary: {
      manual: rows.filter((r) => r.manual != null).length,
      replaced: rows.filter((r) => r.change === 'replaced').length,
      becomesMissing: rows.filter((r) => r.change === 'becomes missing').length,
      resultChanges: rows.filter((r) => r.manual != null && r.resultBefore !== r.resultAfter).length,
    },
  };
}

/** Moves the chosen manual values into the archive so the calculated score applies. Reversible. */
export function switchToCalculated(db: DB, u: User, classId: number, enrollmentIds: number[], confirm: boolean) {
  ownClass(db, u, classId);
  if (!confirm) throw new AppError(422, 'Confirm the change after reviewing the preview.');
  if (!Array.isArray(enrollmentIds) || !enrollmentIds.length) throw new AppError(422, 'Choose at least one student.');
  const { comp } = attendanceRows(db, classId);
  try {
    return db.tx(() => {
      let moved = 0;
      for (const id of enrollmentIds) {
        const e = db.get('SELECT id FROM enrollments WHERE id = ? AND class_id = ?', Number(id), classId);
        if (!e) throw new AppError(422, `Enrollment ${id} is not in this class.`);
        const s = db.get('SELECT * FROM scores WHERE enrollment_id = ? AND component_id = ?', e.id, comp.id);
        if (!s) continue;
        db.run("INSERT INTO score_archive (enrollment_id, component_id, value, reason, archived_by) VALUES (?, ?, ?, 'switched to calculated attendance', ?)", e.id, comp.id, s.value, u.id);
        db.run('DELETE FROM scores WHERE id = ?', s.id);
        db.audit(u.id, 'score', s.id, 'attendance.calculated', { value: s.value }, { value: null, archived: true });
        moved++;
      }
      return { moved };
    });
  } catch (e) {
    throw (e instanceof AppError ? e : translateDbError(e) ?? e);
  }
}

/** Puts archived manual values back where the cell is still empty. */
export function restoreManual(db: DB, u: User, classId: number) {
  ownClass(db, u, classId);
  const { comp } = attendanceRows(db, classId);
  try {
    return db.tx(() => {
      let restored = 0, skipped = 0;
      for (const a of db.all('SELECT * FROM score_archive WHERE component_id = ? AND restored_at IS NULL ORDER BY id DESC', comp.id)) {
        if (db.get('SELECT 1 FROM scores WHERE enrollment_id = ? AND component_id = ?', a.enrollment_id, comp.id)) { skipped++; continue; }
        const id = db.run('INSERT INTO scores (enrollment_id, component_id, value, updated_by) VALUES (?,?,?,?)', a.enrollment_id, comp.id, a.value, u.id).id;
        db.run("UPDATE score_archive SET restored_at = datetime('now') WHERE id = ?", a.id);
        db.audit(u.id, 'score', id, 'attendance.manual-restored', undefined, { value: a.value });
        restored++;
      }
      return { restored, skipped };
    });
  } catch (e) {
    throw (e instanceof AppError ? e : translateDbError(e) ?? e);
  }
}
