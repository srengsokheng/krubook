import { addDays, diffDays, inRange, rangesOverlap, startOfWeek, weekday, type ISODate } from './dates.ts';

export type SessionKind = 'lecture' | 'practice' | 'exam';
export type Activity = 'lesson' | 'midterm_review' | 'midterm' | 'capstone' | 'final_review' | 'final' | 'buffer' | 'makeup';
export type SessionStatus = 'planned' | 'completed' | 'cancelled' | 'skipped' | 'moved';

export interface Meeting {
  id: number;
  weekday: number; // 0 = Sunday
  start: string;
  end: string;
  room?: string | null;
}

/**
 * How meetings within one academic week are labelled.
 * - sequence: the 1st eligible meeting gets sequence[0], the 2nd sequence[1] … (the last entry repeats).
 * - weekday: an explicit, user-configured map from weekday to kind.
 */
export type SessionRule =
  | { mode: 'sequence'; sequence: Array<'lecture' | 'practice'> }
  | { mode: 'weekday'; map: Record<string, 'lecture' | 'practice'> };

export const DEFAULT_RULE: SessionRule = { mode: 'sequence', sequence: ['lecture', 'practice'] };

export interface TemplateWeek {
  week: number;
  activity: Activity;
  checkpoint?: string | null; // e.g. "LAB 1"
  label?: string | null;
}

export interface Holiday {
  date: ISODate;
  name: string;
}

export interface PlanInput {
  classStart: ISODate;
  weeks: number;
  meetings: Meeting[];
  rule: SessionRule;
  template: TemplateWeek[];
  partIds: number[]; // curriculum order
  holidays: Holiday[];
  /** Dates on which the teacher has approved teaching despite a holiday. */
  holidayExceptions?: ISODate[];
  midterm?: { start: ISODate; end: ISODate } | null;
  final?: { start: ISODate; end: ISODate } | null;
  classEnd?: ISODate | null;
}

export interface PlannedSession {
  genKey: string;
  week: number;
  date: ISODate;
  start: string;
  end: string;
  meetingId: number | null;
  kind: SessionKind;
  activity: Activity;
  partId: number | null;
  checkpoint: string | null;
  status: 'planned' | 'cancelled';
  note: string | null;
}

export interface PlanResult {
  sessions: PlannedSession[];
  unscheduledPartIds: number[];
  warnings: string[];
}

/** The standard 17-week shape used when a course has no custom template. */
export function standardTemplate(weeks = 17): TemplateWeek[] {
  const out: TemplateWeek[] = [];
  for (let w = 1; w <= weeks; w++) out.push({ week: w, activity: 'lesson' });
  const set = (w: number, patch: Partial<TemplateWeek>) => {
    const t = out.find((x) => x.week === w);
    if (t) Object.assign(t, patch);
  };
  if (weeks >= 17) {
    set(4, { checkpoint: 'LAB 1' });
    set(7, { checkpoint: 'LAB 2', activity: 'lesson' });
    set(8, { activity: 'midterm', label: 'Midterm review & exam' });
    set(11, { checkpoint: 'LAB 3' });
    set(13, { checkpoint: 'LAB 4' });
    set(14, { activity: 'capstone', label: 'Capstone work' });
    set(15, { activity: 'capstone', label: 'Capstone work' });
    set(16, { activity: 'final_review', label: 'Final review' });
    set(17, { activity: 'final', label: 'Final exam / project defence' });
  }
  return out;
}

export function ruleKind(rule: SessionRule, indexInWeek: number, wd: number): 'lecture' | 'practice' {
  if (rule.mode === 'weekday') return rule.map[String(wd)] ?? 'lecture';
  const seq = rule.sequence.length ? rule.sequence : (['lecture', 'practice'] as const);
  return seq[Math.min(indexInWeek, seq.length - 1)];
}

function holidayMap(holidays: Holiday[], exceptions: ISODate[] = []) {
  const ex = new Set(exceptions);
  const m = new Map<ISODate, string>();
  for (const h of holidays) if (!ex.has(h.date)) m.set(h.date, h.name);
  return m;
}

export function academicWeek(classStart: ISODate, date: ISODate): number {
  return Math.floor(diffDays(startOfWeek(date), startOfWeek(classStart)) / 7) + 1;
}

/**
 * Builds a full term plan from real dates. Deterministic: the same input always yields the same
 * genKeys, so saving it twice updates rows instead of duplicating them.
 */
export function generatePlan(input: PlanInput): PlanResult {
  const warnings: string[] = [];
  const hol = holidayMap(input.holidays, input.holidayExceptions);
  const template = new Map((input.template.length ? input.template : standardTemplate(input.weeks)).map((t) => [t.week, t]));
  const meetings = [...input.meetings].sort((a, b) => ((a.weekday + 6) % 7) - ((b.weekday + 6) % 7) || a.start.localeCompare(b.start));
  if (!meetings.length) warnings.push('The class has no meeting times, so no sessions were generated.');

  const week1 = startOfWeek(input.classStart);
  const queue = [...input.partIds];
  const sessions: PlannedSession[] = [];
  let lastLecturePart: number | null = null;

  for (let w = 1; w <= input.weeks; w++) {
    const monday = addDays(week1, (w - 1) * 7);
    const t = template.get(w) ?? { week: w, activity: 'lesson' as Activity };
    const weekSessions: PlannedSession[] = [];
    let eligibleIndex = 0;

    for (const m of meetings) {
      const date = addDays(monday, (m.weekday + 6) % 7);
      if (date < input.classStart) continue;
      if (input.classEnd && date > input.classEnd) continue;
      const base = { genKey: `w${w}:m${m.id}`, week: w, date, start: m.start, end: m.end, meetingId: m.id, checkpoint: null, note: null };

      const holidayName = hol.get(date);
      if (holidayName) {
        weekSessions.push({ ...base, kind: ruleKind(input.rule, eligibleIndex, weekday(date)), activity: 'lesson', partId: null, status: 'cancelled', note: `Holiday: ${holidayName}` });
        continue;
      }

      let activity: Activity = t.activity;
      if (input.midterm && inRange(date, input.midterm.start, input.midterm.end)) activity = 'midterm';
      else if (input.final && inRange(date, input.final.start, input.final.end)) activity = 'final';
      else if ((activity === 'midterm' && input.midterm) || (activity === 'final' && input.final)) {
        // Exam windows are configured on the term, so outside them this week is a review week.
        activity = activity === 'midterm' ? 'midterm_review' : 'final_review';
      }

      const kind: SessionKind = activity === 'midterm' || activity === 'final' ? 'exam' : ruleKind(input.rule, eligibleIndex, weekday(date));
      eligibleIndex++;
      let partId: number | null = null;
      if (activity === 'lesson') {
        if (kind === 'lecture') {
          partId = queue.shift() ?? null;
          if (partId === null) activity = 'buffer';
          lastLecturePart = partId;
        } else {
          partId = lastLecturePart;
          if (partId === null) activity = 'buffer';
        }
      }
      weekSessions.push({ ...base, kind, activity, partId, status: 'planned', note: t.label ?? null });
    }

    if (t.checkpoint) {
      const open = weekSessions.filter((s) => s.status === 'planned');
      const target = open.findLast((s) => s.kind === 'practice') ?? open.at(-1);
      if (target) target.checkpoint = t.checkpoint;
      else warnings.push(`${t.checkpoint} (week ${w}) has no available session; pick a date manually.`);
    }
    sessions.push(...weekSessions);
  }

  if (queue.length) warnings.push(`${queue.length} lesson part(s) did not fit into the term.`);
  return { sessions, unscheduledPartIds: queue, warnings };
}

// ---------------------------------------------------------------------------------------------
// Re-planning: proposals that are reviewed before they are applied.

export interface SessionState {
  id: number;
  week: number;
  date: ISODate;
  start: string;
  end: string;
  kind: SessionKind;
  kindSource: 'auto' | 'manual';
  activity: Activity;
  partId: number | null;
  checkpoint: string | null;
  status: SessionStatus;
  /** Completed, or explicitly confirmed by the teacher: never changed automatically. */
  locked: boolean;
  holidayException?: boolean;
  note?: string | null;
}

export interface SessionChange {
  sessionId: number;
  date: ISODate;
  start: string;
  before: Pick<SessionState, 'status' | 'kind' | 'partId' | 'checkpoint' | 'activity'>;
  after: Pick<SessionState, 'status' | 'kind' | 'partId' | 'checkpoint' | 'activity'>;
  reasons: string[];
}

export interface PartShift {
  partId: number;
  oldDate: ISODate | null;
  newDate: ISODate | null;
}

export interface ReplanResult {
  changes: SessionChange[];
  partShifts: PartShift[];
  overflowPartIds: number[];
  checkpointWarnings: string[];
}

export interface ReplanInput {
  sessions: SessionState[];
  partIds: number[];
  /** Parts fully covered according to actual teaching records. */
  coveredPartIds: Iterable<number>;
  holidays: Holiday[];
  rule: SessionRule;
  /** Only sessions on or after this date may change. */
  from: ISODate;
}

const TEACHABLE: Activity[] = ['lesson', 'buffer'];

export function proposeReplan(input: ReplanInput): ReplanResult {
  const hol = new Map(input.holidays.map((h) => [h.date, h.name]));
  const covered = new Set(input.coveredPartIds);
  const sorted = [...input.sessions].sort((a, b) => a.date.localeCompare(b.date) || a.start.localeCompare(b.start));
  const next = sorted.map((s) => ({ ...s }));
  const reasons = new Map<number, string[]>();
  const why = (id: number, r: string) => {
    const list = reasons.get(id) ?? [];
    if (!list.includes(r)) list.push(r);
    reasons.set(id, list);
  };
  const mutable = (s: SessionState) => !s.locked && s.status === 'planned' && s.date >= input.from;
  const checkpointWarnings: string[] = [];

  // 1. Holidays cancel unlocked sessions unless the teacher approved an exception.
  for (const s of next) {
    if (mutable(s) && hol.has(s.date) && !s.holidayException) {
      s.status = 'cancelled';
      why(s.id, `Holiday: ${hol.get(s.date)}`);
    }
  }

  // 2. Re-apply the lecture/practice rule within each affected week.
  const byWeek = new Map<number, typeof next>();
  for (const s of next) byWeek.set(s.week, [...(byWeek.get(s.week) ?? []), s]);
  for (const [, list] of byWeek) {
    let idx = 0;
    for (const s of list) {
      if (s.status === 'cancelled' || s.status === 'moved' || s.status === 'skipped' || s.kind === 'exam') continue;
      const ruleK = ruleKind(input.rule, idx, weekday(s.date));
      idx++;
      if (mutable(s) && s.kindSource === 'auto' && s.kind !== ruleK) {
        s.kind = ruleK;
        why(s.id, `Now the ${idx === 1 ? 'first' : 'next'} meeting of week ${s.week}, so it becomes ${ruleK}`);
      }
    }
    // Checkpoints whose session was cancelled move to the last open session of the same week.
    for (const s of list) {
      if (s.checkpoint && s.status === 'cancelled' && mutable({ ...s, status: 'planned' })) {
        const target = list.filter((x) => x.status === 'planned' && x.kind !== 'exam' && x.date >= input.from).at(-1);
        if (target) {
          target.checkpoint = s.checkpoint;
          why(target.id, `${s.checkpoint} moved here from a cancelled session`);
          s.checkpoint = null;
        } else {
          checkpointWarnings.push(`${s.checkpoint} has no session left in week ${s.week}; schedule a make-up or pick another date.`);
        }
      }
    }
  }

  // 3. Re-flow curriculum content into open lecture/practice sessions.
  const pinned = new Set(next.filter((s) => !mutable(s) && s.status === 'planned' && s.partId != null).map((s) => s.partId!));
  const queue = input.partIds.filter((p) => !covered.has(p) && !pinned.has(p));
  let lastLecture: number | null = null;
  for (const s of next) {
    if (s.status !== 'planned' && s.status !== 'completed') continue;
    if (!mutable(s)) {
      if (s.kind === 'lecture' && s.partId != null) lastLecture = s.partId;
      continue;
    }
    if (!TEACHABLE.includes(s.activity)) continue;
    if (s.kind === 'lecture') {
      const p = queue.shift() ?? null;
      s.partId = p;
      lastLecture = p;
    } else if (s.kind === 'practice') {
      s.partId = lastLecture;
    }
    s.activity = s.partId == null ? 'buffer' : 'lesson';
  }

  const changes: SessionChange[] = [];
  const pick = (s: SessionState) => ({ status: s.status, kind: s.kind, partId: s.partId, checkpoint: s.checkpoint, activity: s.activity });
  sorted.forEach((before, i) => {
    const after = next[i];
    const b = pick(before), a = pick(after);
    if (JSON.stringify(b) === JSON.stringify(a)) return;
    if (b.partId !== a.partId && !reasons.has(before.id)) why(before.id, 'Lesson content re-flowed after earlier changes');
    changes.push({ sessionId: before.id, date: before.date, start: before.start, before: b, after: a, reasons: reasons.get(before.id) ?? [] });
  });

  // A session cancelled just before this proposal still carries its lesson, so it counts as the
  // lesson's old date.
  const firstLecture = (list: SessionState[], includeCancelled: boolean) => {
    const m = new Map<number, ISODate>();
    for (const s of list) {
      const live = s.status === 'planned' || s.status === 'completed' || (includeCancelled && s.status === 'cancelled');
      if (s.kind === 'lecture' && s.partId != null && live && !m.has(s.partId)) m.set(s.partId, s.date);
    }
    return m;
  };
  const oldDates = firstLecture(sorted, true), newDates = firstLecture(next, false);
  const partShifts: PartShift[] = [];
  for (const p of input.partIds) {
    const o = oldDates.get(p) ?? null, n = newDates.get(p) ?? null;
    if (o !== n && !covered.has(p)) partShifts.push({ partId: p, oldDate: o, newDate: n });
  }

  return { changes, partShifts, overflowPartIds: queue, checkpointWarnings };
}

// ---------------------------------------------------------------------------------------------

export interface TimedItem {
  id: number;
  classId: number;
  date: ISODate;
  start: string;
  end: string;
  status?: string;
}

/** Pairs of sessions that double-book the teacher. Cancelled and moved sessions are ignored. */
export function findOverlaps<T extends TimedItem>(items: T[]): Array<[T, T]> {
  const live = items.filter((s) => s.status !== 'cancelled' && s.status !== 'moved' && s.status !== 'skipped');
  const byDate = new Map<string, T[]>();
  for (const s of live) byDate.set(s.date, [...(byDate.get(s.date) ?? []), s]);
  const out: Array<[T, T]> = [];
  for (const list of byDate.values()) {
    list.sort((a, b) => a.start.localeCompare(b.start));
    for (let i = 0; i < list.length; i++)
      for (let j = i + 1; j < list.length; j++) {
        if (list[j].start >= list[i].end) break;
        if (rangesOverlap(list[i].start, list[i].end, list[j].start, list[j].end)) out.push([list[i], list[j]]);
      }
  }
  return out;
}
