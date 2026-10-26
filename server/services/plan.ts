import { AppError, type DB, type Row } from '../db.ts';
import type { User } from '../auth.ts';
import { ownClass, ownSession, today } from './access.ts';
import { academicWeek, DEFAULT_RULE, findOverlaps, generatePlan, proposeReplan, standardTemplate, type SessionRule, type SessionState, type TemplateWeek } from '../../shared/schedule.ts';
import { addDays, durationMinutes, isISODate, isTime, type ISODate } from '../../shared/dates.ts';
import { classProgress } from '../../shared/progress.ts';

export interface PartInfo {
  id: number;
  lessonId: number;
  lessonNo: number;
  lessonTitle: string;
  label: string;
  title: string | null;
  code: string; // "L2·A"
}

export function orderedParts(db: DB, courseId: number): PartInfo[] {
  const rows = db.all(
    `SELECT p.id, p.lesson_id, p.label, p.title, l.title AS lesson_title,
            (SELECT COUNT(*) FROM lessons l2 WHERE l2.course_id = l.course_id AND l2.position <= l.position) AS lesson_no
       FROM lesson_parts p JOIN lessons l ON l.id = p.lesson_id
      WHERE l.course_id = ? ORDER BY l.position, p.position`,
    courseId,
  );
  return rows.map((r) => ({ id: r.id, lessonId: r.lesson_id, lessonNo: r.lesson_no, lessonTitle: r.lesson_title, label: r.label, title: r.title, code: `L${r.lesson_no}·${r.label}` }));
}

export function courseTemplate(db: DB, courseId: number, weeks: number): TemplateWeek[] {
  const rows = db.all('SELECT week, activity, checkpoint, label FROM template_weeks WHERE course_id = ? ORDER BY week', courseId);
  return rows.length ? (rows as TemplateWeek[]) : standardTemplate(weeks);
}

export function classRule(cls: Row, course: Row): SessionRule {
  try {
    return JSON.parse(cls.session_rule ?? course.session_rule ?? '') as SessionRule;
  } catch {
    return DEFAULT_RULE;
  }
}

export function holidaysFor(db: DB, ownerId: number, termId: number) {
  const rows = db.all<{ date: string; end_date: string | null; name: string }>('SELECT date, end_date, name FROM holidays WHERE owner_id = ? AND (term_id IS NULL OR term_id = ?) ORDER BY date', ownerId, termId);
  // A range blocks every day in it.
  return rows.flatMap((h) => { const days = []; for (let d = h.date; d <= (h.end_date ?? h.date); d = addDays(d, 1)) days.push({ date: d, name: h.name }); return days; });
}

function context(db: DB, cls: Row) {
  const course = db.get('SELECT * FROM courses WHERE id = ?', cls.course_id)!;
  const term = db.get('SELECT * FROM terms WHERE id = ?', cls.term_id)!;
  const meetings = db.all('SELECT * FROM meetings WHERE class_id = ? ORDER BY weekday, start_time', cls.id);
  return { course, term, meetings, parts: orderedParts(db, course.id), rule: classRule(cls, course), holidays: holidaysFor(db, cls.teacher_id, term.id) };
}

export function coveredParts(db: DB, classId: number): Set<number> {
  const rows = db.all(
    `SELECT DISTINCT rp.part_id FROM record_parts rp JOIN teaching_records r ON r.id = rp.record_id
       JOIN sessions s ON s.id = r.session_id WHERE s.class_id = ? AND rp.coverage = 'full'`,
    classId,
  );
  return new Set(rows.map((r) => r.part_id));
}

const LOCKED_SQL = `(s.status = 'completed' OR s.confirmed = 1 OR EXISTS (SELECT 1 FROM attendance a WHERE a.session_id = s.id))`;

export function sessionStates(db: DB, classId: number): Array<SessionState & { version: number }> {
  return db.all(`SELECT s.*, ${LOCKED_SQL} AS locked FROM sessions s WHERE s.class_id = ? ORDER BY s.date, s.start_time`, classId).map((s) => ({
    id: s.id, week: s.week, date: s.date, start: s.start_time, end: s.end_time, kind: s.kind, kindSource: s.kind_source, activity: s.activity,
    partId: s.part_id, checkpoint: s.checkpoint, status: s.status, locked: !!s.locked, holidayException: !!s.holiday_exception, note: s.note, version: s.version,
  }));
}

// ---------------------------------------------------------------------------------------------
// Generation

export function generateForClass(db: DB, u: User, classId: number, opts: { dryRun?: boolean } = {}) {
  const cls = ownClass(db, u, classId);
  const ctx = context(db, cls);
  const hasRecords = db.get('SELECT 1 FROM teaching_records r JOIN sessions s ON s.id = r.session_id WHERE s.class_id = ? LIMIT 1', classId);
  if (hasRecords && !opts.dryRun) {
    throw new AppError(409, 'This class already has teaching records, so the plan cannot be regenerated from scratch. Use “Review schedule changes” to re-plan the remaining sessions.');
  }
  const exceptions = db.all("SELECT date FROM sessions WHERE class_id = ? AND holiday_exception = 1", classId).map((r) => r.date);
  const plan = generatePlan({
    classStart: cls.start_date,
    classEnd: cls.end_date,
    weeks: cls.weeks,
    meetings: ctx.meetings.map((m) => ({ id: m.id, weekday: m.weekday, start: m.start_time, end: m.end_time, room: m.room })),
    rule: ctx.rule,
    template: courseTemplate(db, ctx.course.id, cls.weeks),
    partIds: ctx.parts.map((p) => p.id),
    holidays: ctx.holidays,
    holidayExceptions: exceptions,
    midterm: ctx.term.midterm_start ? { start: ctx.term.midterm_start, end: ctx.term.midterm_end ?? ctx.term.midterm_start } : null,
    final: ctx.term.final_start ? { start: ctx.term.final_start, end: ctx.term.final_end ?? ctx.term.final_start } : null,
  });
  if (opts.dryRun) return { preview: plan.sessions, warnings: plan.warnings, unscheduled: plan.unscheduledPartIds.length, created: 0, updated: 0, kept: 0, removed: 0 };

  return db.tx(() => {
    const existing = new Map(db.all(`SELECT s.*, ${LOCKED_SQL} AS locked FROM sessions s WHERE s.class_id = ? AND s.gen_key IS NOT NULL`, classId).map((s) => [s.gen_key, s]));
    let created = 0, updated = 0, kept = 0, removed = 0;
    for (const p of plan.sessions) {
      const ex = existing.get(p.genKey);
      existing.delete(p.genKey);
      if (!ex) {
        db.run(
          `INSERT INTO sessions (class_id, meeting_id, gen_key, week, date, start_time, end_time, kind, activity, part_id, checkpoint, status, note, original_date, original_part_id)
           VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
          classId, p.meetingId, p.genKey, p.week, p.date, p.start, p.end, p.kind, p.activity, p.partId, p.checkpoint, p.status, p.note, p.date, p.partId,
        );
        created++;
      } else if (ex.locked || ex.status === 'moved') {
        kept++;
      } else {
        const kind = ex.kind_source === 'manual' ? ex.kind : p.kind;
        db.run(
          `UPDATE sessions SET week=?, date=?, start_time=?, end_time=?, kind=?, activity=?, part_id=?, checkpoint=?, status=?, note=?, original_date=?, original_part_id=?, version=version+1, updated_at=datetime('now') WHERE id=?`,
          p.week, p.date, p.start, p.end, kind, p.activity, p.partId, p.checkpoint, p.status, p.note, p.date, p.partId, ex.id,
        );
        updated++;
      }
    }
    for (const ex of existing.values()) {
      if (ex.locked || ex.status === 'moved') { kept++; continue; }
      db.run('DELETE FROM sessions WHERE id = ?', ex.id);
      removed++;
    }
    db.audit(u.id, 'class', classId, 'plan.generate', undefined, { created, updated, kept, removed });
    return { created, updated, kept, removed, warnings: plan.warnings, unscheduled: plan.unscheduledPartIds.length };
  });
}

// ---------------------------------------------------------------------------------------------
// Proposals

export function describeProposal(db: DB, classId: number, payload: Row) {
  const cls = db.get('SELECT course_id FROM classes WHERE id = ?', classId)!;
  const parts = new Map(orderedParts(db, cls.course_id).map((p) => [p.id, p]));
  const name = (id: number | null) => (id == null ? null : parts.get(id)?.code + (parts.get(id)?.title ? ` ${parts.get(id)!.title}` : ''));
  return {
    ...payload,
    changes: payload.changes.map((c: Row) => ({ ...c, beforePart: name(c.before.partId), afterPart: name(c.after.partId) })),
    partShifts: payload.partShifts.map((p: Row) => ({ ...p, part: name(p.partId) })),
    overflow: payload.overflowPartIds.map(name),
  };
}

export function createProposal(db: DB, u: User, classId: number, reason: string, from?: ISODate) {
  const cls = ownClass(db, u, classId);
  const ctx = context(db, cls);
  const states = sessionStates(db, classId);
  const result = proposeReplan({
    sessions: states,
    partIds: ctx.parts.map((p) => p.id),
    coveredPartIds: coveredParts(db, classId),
    holidays: ctx.holidays,
    rule: ctx.rule,
    from: from ?? today(db, u),
  });
  if (!result.changes.length && !result.checkpointWarnings.length) return null;
  const versions = Object.fromEntries(states.filter((s) => result.changes.some((c) => c.sessionId === s.id)).map((s) => [s.id, s.version]));
  return db.tx(() => {
    db.run("UPDATE schedule_proposals SET status = 'stale', resolved_at = datetime('now') WHERE class_id = ? AND status = 'pending'", classId);
    const payload = { ...result, versions };
    const id = db.run('INSERT INTO schedule_proposals (class_id, reason, payload, created_by) VALUES (?,?,?,?)', classId, reason, JSON.stringify(payload), u.id).id;
    return { id, classId, reason, status: 'pending', ...describeProposal(db, classId, payload) };
  });
}

export function listProposals(db: DB, u: User, classId: number) {
  ownClass(db, u, classId);
  return db.all('SELECT * FROM schedule_proposals WHERE class_id = ? ORDER BY id DESC LIMIT 20', classId).map((p) => ({
    id: p.id, classId, reason: p.reason, status: p.status, createdAt: p.created_at, resolvedAt: p.resolved_at, ...describeProposal(db, classId, JSON.parse(p.payload)),
  }));
}

export function applyProposal(db: DB, u: User, proposalId: number) {
  const p = db.get('SELECT * FROM schedule_proposals WHERE id = ?', proposalId);
  if (!p) throw new AppError(404, 'Proposal not found.');
  ownClass(db, u, p.class_id);
  if (p.status !== 'pending') throw new AppError(409, `This proposal is already ${p.status}.`);
  const payload = JSON.parse(p.payload);
  return db.tx(() => {
    for (const c of payload.changes) {
      const s = db.get(`SELECT s.*, ${LOCKED_SQL} AS locked FROM sessions s WHERE s.id = ?`, c.sessionId);
      if (!s || s.version !== payload.versions[c.sessionId] || s.locked) {
        db.run("UPDATE schedule_proposals SET status = 'stale', resolved_at = datetime('now') WHERE id = ?", proposalId);
        throw new AppError(409, 'The schedule changed after this proposal was made. Create a new proposal to see the current impact.');
      }
      db.run(
        "UPDATE sessions SET status=?, kind=?, part_id=?, checkpoint=?, activity=?, note=COALESCE(?, note), version=version+1, updated_at=datetime('now') WHERE id=?",
        c.after.status, c.after.kind, c.after.partId, c.after.checkpoint, c.after.activity, c.reasons.find((r: string) => r.startsWith('Holiday')) ?? null, c.sessionId,
      );
      db.audit(u.id, 'session', c.sessionId, 'proposal.apply', c.before, c.after);
    }
    db.run("UPDATE schedule_proposals SET status = 'applied', resolved_at = datetime('now') WHERE id = ?", proposalId);
    return { applied: payload.changes.length };
  });
}

export function dismissProposal(db: DB, u: User, proposalId: number) {
  const p = db.get('SELECT * FROM schedule_proposals WHERE id = ?', proposalId);
  if (!p) throw new AppError(404, 'Proposal not found.');
  ownClass(db, u, p.class_id);
  db.run("UPDATE schedule_proposals SET status = 'dismissed', resolved_at = datetime('now') WHERE id = ? AND status = 'pending'", proposalId);
}

// ---------------------------------------------------------------------------------------------
// Session changes

function teacherOverlaps(db: DB, u: User, date: ISODate, start: string, end: string, excludeId?: number) {
  const rows = db.all(
    `SELECT s.id, s.class_id, s.date, s.start_time, s.end_time, s.status, c.code FROM sessions s JOIN classes c ON c.id = s.class_id
      WHERE c.teacher_id = ? AND s.date = ? AND s.id IS NOT ?`,
    u.id, date, excludeId ?? null,
  );
  const items = rows.map((r) => ({ id: r.id, classId: r.class_id, date: r.date, start: r.start_time, end: r.end_time, status: r.status, code: r.code }));
  const probe = { id: -1, classId: -1, date, start, end, code: '' };
  return findOverlaps([probe, ...items]).filter(([a, b]) => a.id === -1 || b.id === -1).map(([a, b]) => (a.id === -1 ? b : a));
}

function checkSlot(date: unknown, start: unknown, end: unknown) {
  if (!isISODate(date)) throw new AppError(422, 'Choose a valid date.');
  if (!isTime(start) || !isTime(end)) throw new AppError(422, 'Times must be in HH:MM format.');
  if (end <= start) throw new AppError(422, 'The end time must be after the start time.');
}

export function cancelSession(db: DB, u: User, id: number, reason: string) {
  const s = ownSession(db, u, id);
  if (s.status === 'completed') throw new AppError(409, 'This session was already taught. Reopen its teaching record before cancelling it.');
  if (s.status !== 'planned') throw new AppError(409, `This session is already ${s.status}.`);
  db.tx(() => {
    db.run("UPDATE sessions SET status = 'cancelled', note = ?, version = version + 1, updated_at = datetime('now') WHERE id = ?", reason || 'Cancelled', id);
    db.audit(u.id, 'session', id, 'cancel', { status: s.status }, { status: 'cancelled', reason });
  });
  return { proposal: createProposal(db, u, s.class_id, `Session on ${s.date} cancelled${reason ? `: ${reason}` : ''}`, s.date) };
}

export function restoreSession(db: DB, u: User, id: number) {
  const s = ownSession(db, u, id);
  if (s.status !== 'cancelled' && s.status !== 'skipped') throw new AppError(409, 'Only cancelled or skipped sessions can be restored.');
  db.tx(() => {
    db.run("UPDATE sessions SET status = 'planned', holiday_exception = CASE WHEN note LIKE 'Holiday:%' THEN 1 ELSE holiday_exception END, version = version + 1, updated_at = datetime('now') WHERE id = ?", id);
    db.audit(u.id, 'session', id, 'restore', { status: s.status }, { status: 'planned' });
  });
  return { proposal: createProposal(db, u, s.class_id, `Session on ${s.date} restored`, s.date) };
}

export function moveSession(db: DB, u: User, id: number, body: { date: string; start: string; end: string }) {
  const s = ownSession(db, u, id);
  checkSlot(body.date, body.start, body.end);
  if (s.status !== 'planned') throw new AppError(409, 'Only planned sessions can be moved.');
  const cls = db.get('SELECT * FROM classes WHERE id = ?', s.class_id)!;
  const overlaps = teacherOverlaps(db, u, body.date, body.start, body.end, id);
  const newId = db.tx(() => {
    db.run("UPDATE sessions SET status = 'moved', version = version + 1, updated_at = datetime('now') WHERE id = ?", id);
    const nid = db.run(
      `INSERT INTO sessions (class_id, meeting_id, gen_key, week, date, start_time, end_time, kind, kind_source, activity, part_id, checkpoint, status, confirmed, is_makeup, moved_from_id, original_date, original_part_id, note)
       VALUES (?,?,NULL,?,?,?,?,?,?,?,?,?,'planned',1,?,?,?,?,?)`,
      s.class_id, s.meeting_id, academicWeek(cls.start_date, body.date), body.date, body.start, body.end, s.kind, s.kind_source, s.activity, s.part_id, s.checkpoint, s.is_makeup, id, s.original_date, s.original_part_id, `Moved from ${s.date} ${s.start_time}`,
    ).id;
    db.audit(u.id, 'session', id, 'move', { date: s.date, start: s.start_time }, { date: body.date, start: body.start, newSessionId: nid });
    return nid;
  });
  return { id: newId, overlaps, proposal: createProposal(db, u, s.class_id, `Session moved from ${s.date} to ${body.date}`, s.date < body.date ? s.date : body.date) };
}

export function addSession(db: DB, u: User, classId: number, body: { date: string; start: string; end: string; kind?: string; makeup?: boolean; note?: string }) {
  const cls = ownClass(db, u, classId);
  checkSlot(body.date, body.start, body.end);
  const kind = body.kind === 'practice' ? 'practice' : body.kind === 'exam' ? 'exam' : 'lecture';
  const overlaps = teacherOverlaps(db, u, body.date, body.start, body.end);
  const id = db.tx(() => {
    const nid = db.run(
      `INSERT INTO sessions (class_id, week, date, start_time, end_time, kind, kind_source, activity, status, is_makeup, original_date, note)
       VALUES (?,?,?,?,?,?,'manual','lesson','planned',?,?,?)`,
      classId, academicWeek(cls.start_date, body.date), body.date, body.start, body.end, kind, body.makeup ? 1 : 0, body.date, body.note ?? (body.makeup ? 'Make-up class' : 'Additional session'),
    ).id;
    db.audit(u.id, 'session', nid, 'create', undefined, body);
    return nid;
  });
  return { id, overlaps, proposal: createProposal(db, u, classId, `${body.makeup ? 'Make-up' : 'Additional'} session added on ${body.date}`, body.date) };
}

export function updateSession(db: DB, u: User, id: number, body: Row) {
  const s = ownSession(db, u, id);
  const sets: string[] = [], vals: any[] = [];
  const set = (col: string, v: unknown) => { sets.push(`${col} = ?`); vals.push(v); };
  if (body.kind !== undefined) {
    if (body.kind === null) set('kind_source', 'auto');
    else { if (!['lecture', 'practice', 'exam'].includes(body.kind)) throw new AppError(422, 'Unknown session type.'); set('kind', body.kind); set('kind_source', 'manual'); }
  }
  if (body.confirmed !== undefined) set('confirmed', body.confirmed ? 1 : 0);
  if (body.holidayException !== undefined) set('holiday_exception', body.holidayException ? 1 : 0);
  if (body.note !== undefined) set('note', body.note || null);
  if (body.checkpoint !== undefined) set('checkpoint', body.checkpoint || null);
  if (body.partId !== undefined) { set('part_id', body.partId); set('confirmed', 1); }
  if (!sets.length) return { proposal: null };
  if (body.version !== undefined && body.version !== s.version) throw new AppError(409, 'This session was changed elsewhere. Reload to see the latest version.');
  db.tx(() => {
    db.run(`UPDATE sessions SET ${sets.join(', ')}, version = version + 1, updated_at = datetime('now') WHERE id = ?`, ...vals, id);
    db.audit(u.id, 'session', id, 'update', s, body);
  });
  const affectsPlan = body.kind !== undefined || body.partId !== undefined || body.holidayException !== undefined;
  return { proposal: affectsPlan ? createProposal(db, u, s.class_id, `Session on ${s.date} edited`, s.date) : null };
}

// ---------------------------------------------------------------------------------------------
// Teaching records

export interface CompleteBody {
  parts: Array<{ partId: number; coverage: 'full' | 'partial' }>;
  minutes?: number;
  pace?: 'on_plan' | 'early' | 'behind';
  notes?: string;
  followUp?: string;
}

export function completeSession(db: DB, u: User, id: number, body: CompleteBody) {
  const s = ownSession(db, u, id);
  if (['cancelled', 'moved', 'skipped'].includes(s.status)) throw new AppError(409, `A ${s.status} session cannot be marked as taught.`);
  if (s.date > today(db, u)) throw new AppError(422, 'This session is in the future. Record it on or after the day it is taught.');
  const cls = db.get('SELECT course_id FROM classes WHERE id = ?', s.class_id)!;
  const valid = new Set(orderedParts(db, cls.course_id).map((p) => p.id));
  for (const p of body.parts ?? []) if (!valid.has(p.partId)) throw new AppError(422, 'A selected lesson part does not belong to this course.');
  const minutes = body.minutes ?? durationMinutes(s.start_time, s.end_time);
  if (!(minutes > 0 && minutes <= 600)) throw new AppError(422, 'Duration must be between 1 and 600 minutes.');

  db.tx(() => {
    const existing = db.get('SELECT * FROM teaching_records WHERE session_id = ?', id);
    let recordId: number;
    if (existing) {
      db.run("UPDATE teaching_records SET minutes=?, pace=?, notes=?, follow_up=?, updated_at=datetime('now') WHERE id=?", minutes, body.pace ?? 'on_plan', body.notes ?? null, body.followUp ?? null, existing.id);
      recordId = existing.id;
      db.run('DELETE FROM record_parts WHERE record_id = ?', recordId);
    } else {
      recordId = db.run('INSERT INTO teaching_records (session_id, taught_on, minutes, pace, notes, follow_up, created_by) VALUES (?,?,?,?,?,?,?)', id, s.date, minutes, body.pace ?? 'on_plan', body.notes ?? null, body.followUp ?? null, u.id).id;
    }
    for (const p of body.parts ?? []) db.run('INSERT INTO record_parts (record_id, part_id, coverage) VALUES (?,?,?)', recordId, p.partId, p.coverage);
    db.run("UPDATE sessions SET status = 'completed', version = version + 1, updated_at = datetime('now') WHERE id = ?", id);
    db.audit(u.id, 'teaching_record', recordId, existing ? 'update' : 'create', existing ?? undefined, body);
  });
  return { summary: classSummary(db, u, s.class_id), proposal: createProposal(db, u, s.class_id, `Teaching recorded for ${s.date}`, addDays(s.date, 0)) };
}

export function reopenSession(db: DB, u: User, id: number) {
  const s = ownSession(db, u, id);
  const rec = db.get('SELECT * FROM teaching_records WHERE session_id = ?', id);
  if (!rec) throw new AppError(409, 'This session has no teaching record.');
  db.tx(() => {
    const parts = db.all('SELECT * FROM record_parts WHERE record_id = ?', rec.id);
    db.run('DELETE FROM teaching_records WHERE id = ?', rec.id);
    db.run("UPDATE sessions SET status = 'planned', version = version + 1, updated_at = datetime('now') WHERE id = ?", id);
    db.audit(u.id, 'teaching_record', rec.id, 'reopen', { ...rec, parts }, undefined);
  });
  return { summary: classSummary(db, u, s.class_id) };
}

// ---------------------------------------------------------------------------------------------
// Class summary

export function classSummary(db: DB, u: User, classId: number) {
  const cls = ownClass(db, u, classId);
  const now = today(db, u);
  const parts = orderedParts(db, cls.course_id);
  const partMap = new Map(parts.map((p) => [p.id, p]));
  const covered = coveredParts(db, classId);
  const sessions = db.all('SELECT * FROM sessions WHERE class_id = ? ORDER BY date, start_time', classId);
  const records = db.all(
    `SELECT r.*, s.date, s.kind FROM teaching_records r JOIN sessions s ON s.id = r.session_id WHERE s.class_id = ? ORDER BY s.date DESC, s.start_time DESC`,
    classId,
  );
  const progress = classProgress({
    partIds: parts.map((p) => p.id),
    coveredPartIds: covered,
    hasRecords: records.length > 0,
    today: now,
    tolerance: cls.progress_tolerance,
    sessions: sessions.filter((s) => s.moved_from_id == null).map((s) => ({ date: s.date, kind: s.kind, status: s.status, originalPartId: s.original_part_id, originalDate: s.original_date })),
  });
  const last = records[0];
  const lastParts = last ? db.all('SELECT part_id, coverage FROM record_parts WHERE record_id = ?', last.id) : [];
  const nextSession = sessions.find((s) => s.status === 'planned' && s.date >= now) ?? null;
  const unrecorded = sessions.filter((s) => s.status === 'planned' && s.date < now && s.activity !== 'buffer');
  const milestones = sessions
    .filter((s) => s.status === 'planned' && s.date >= now && (s.checkpoint || s.kind === 'exam'))
    .slice(0, 6)
    .map((s) => ({ sessionId: s.id, date: s.date, label: s.checkpoint ?? (s.activity === 'midterm' ? 'Midterm exam' : 'Final exam') }));
  const nextPart = progress.nextPartId ? partMap.get(progress.nextPartId)! : null;
  const materials = nextPart ? db.all('SELECT * FROM materials WHERE lesson_id = ? AND (part_id IS NULL OR part_id = ?) ORDER BY kind', nextPart.lessonId, nextPart.id) : [];
  return {
    progress,
    lastTaught: last ? { date: last.date, parts: lastParts.map((p) => ({ ...partMap.get(p.part_id), coverage: p.coverage })) } : null,
    nextPart,
    nextSession: nextSession && { id: nextSession.id, date: nextSession.date, start: nextSession.start_time, end: nextSession.end_time, kind: nextSession.kind, partId: nextSession.part_id, part: nextSession.part_id ? partMap.get(nextSession.part_id) ?? null : null },
    unrecorded: unrecorded.map((s) => ({ id: s.id, date: s.date, start: s.start_time, kind: s.kind })),
    milestones,
    materials,
    counts: {
      planned: sessions.filter((s) => s.status === 'planned').length,
      completed: sessions.filter((s) => s.status === 'completed').length,
      cancelled: sessions.filter((s) => s.status === 'cancelled').length,
    },
  };
}
