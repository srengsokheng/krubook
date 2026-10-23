import { describe, expect, it } from 'vitest';
import { addDays, formatDate, startOfWeek, weekday } from '../shared/dates.ts';
import { findOverlaps, generatePlan, proposeReplan, standardTemplate, type Meeting, type SessionState } from '../shared/schedule.ts';
import { attendanceScore, checkConfig, classStats, computeStudent, DEFAULT_ATTENDANCE_RULE, DEFAULT_COMPONENTS, parseScoreInput, validateScore, type GradeConfig } from '../shared/grades.ts';
import { classProgress } from '../shared/progress.ts';
import { monthlyPay, resolveRate } from '../shared/pay.ts';

const MON_WED: Meeting[] = [
  { id: 1, weekday: 1, start: '08:00', end: '10:00' },
  { id: 2, weekday: 3, start: '08:00', end: '10:00' },
];
const parts = Array.from({ length: 12 }, (_, i) => 100 + i);
const base = { weeks: 17, meetings: MON_WED, rule: { mode: 'sequence' as const, sequence: ['lecture', 'practice'] as Array<'lecture' | 'practice'> }, template: standardTemplate(17), partIds: parts, holidays: [] };

describe('dates', () => {
  it('computes weekdays and week starts without the host time zone', () => {
    expect(weekday('2026-09-07')).toBe(1);
    expect(startOfWeek('2026-09-10')).toBe('2026-09-07');
    expect(addDays('2026-12-31', 1)).toBe('2027-01-01');
    expect(formatDate('2026-09-07')).toBe('Mon Sep 7');
  });
});

describe('term plan generator', () => {
  it('generates independent schedules for classes that start on different dates', () => {
    const a = generatePlan({ ...base, classStart: '2026-09-07' });
    const b = generatePlan({ ...base, classStart: '2026-09-28' });
    expect(a.sessions[0].date).toBe('2026-09-07');
    expect(b.sessions[0].date).toBe('2026-09-28');
    expect(a.sessions).toHaveLength(34);
    expect(b.sessions).toHaveLength(34);
    expect(b.sessions.at(-1)!.date > a.sessions.at(-1)!.date).toBe(true);
  });

  it('labels the first meeting of a week Lecture and the next Practice', () => {
    const p = generatePlan({ ...base, classStart: '2026-09-07' });
    expect(p.sessions[0]).toMatchObject({ kind: 'lecture', partId: 100 });
    expect(p.sessions[1]).toMatchObject({ kind: 'practice', partId: 100 });
    expect(p.sessions[2]).toMatchObject({ kind: 'lecture', partId: 101 });
  });

  it('follows the rule on any meeting days, not fixed weekdays', () => {
    const p = generatePlan({ ...base, classStart: '2026-09-08', meetings: [{ id: 7, weekday: 4, start: '13:00', end: '14:00' }, { id: 8, weekday: 2, start: '13:00', end: '14:00' }] });
    expect(weekday(p.sessions[0].date)).toBe(2);
    expect(p.sessions[0].kind).toBe('lecture');
    expect(p.sessions[1].kind).toBe('practice');
  });

  it('supports a custom sequence and a weekday map', () => {
    const three: Meeting[] = [...MON_WED, { id: 3, weekday: 5, start: '08:00', end: '09:00' }];
    const seq = generatePlan({ ...base, meetings: three, classStart: '2026-09-07', rule: { mode: 'sequence', sequence: ['lecture', 'lecture', 'practice'] } });
    expect(seq.sessions.slice(0, 3).map((s) => s.kind)).toEqual(['lecture', 'lecture', 'practice']);
    const map = generatePlan({ ...base, classStart: '2026-09-07', rule: { mode: 'weekday', map: { '1': 'practice', '3': 'lecture' } } });
    expect(map.sessions.slice(0, 2).map((s) => s.kind)).toEqual(['practice', 'lecture']);
  });

  it('handles one-hour and longer slots', () => {
    const p = generatePlan({ ...base, classStart: '2026-09-07', meetings: [{ id: 1, weekday: 1, start: '07:00', end: '08:00' }, { id: 2, weekday: 3, start: '13:30', end: '16:30' }] });
    expect(p.sessions[0]).toMatchObject({ start: '07:00', end: '08:00' });
    expect(p.sessions[1]).toMatchObject({ start: '13:30', end: '16:30' });
  });

  it('skips holidays and makes the next eligible meeting the lecture', () => {
    const p = generatePlan({ ...base, classStart: '2026-09-07', holidays: [{ date: '2026-09-14', name: 'Test holiday' }] });
    const wk2 = p.sessions.filter((s) => s.week === 2);
    expect(wk2[0]).toMatchObject({ status: 'cancelled', note: 'Holiday: Test holiday', partId: null });
    expect(wk2[1]).toMatchObject({ kind: 'lecture', partId: 101 });
  });

  it('keeps a session when the teacher approved a holiday exception', () => {
    const p = generatePlan({ ...base, classStart: '2026-09-07', holidays: [{ date: '2026-09-14', name: 'X' }], holidayExceptions: ['2026-09-14'] });
    expect(p.sessions.find((s) => s.date === '2026-09-14')!.status).toBe('planned');
  });

  it('places exams in the term windows and lab checkpoints on practice sessions', () => {
    const p = generatePlan({ ...base, classStart: '2026-09-07', midterm: { start: '2026-10-26', end: '2026-10-30' } });
    const mid = p.sessions.filter((s) => s.activity === 'midterm');
    expect(mid.length).toBe(2);
    expect(mid.every((s) => s.kind === 'exam')).toBe(true);
    const lab1 = p.sessions.find((s) => s.checkpoint === 'LAB 1')!;
    expect(lab1).toMatchObject({ week: 4, kind: 'practice' });
  });

  it('is deterministic so regeneration never duplicates sessions', () => {
    const a = generatePlan({ ...base, classStart: '2026-09-07' }).sessions.map((s) => s.genKey);
    const b = generatePlan({ ...base, classStart: '2026-09-07' }).sessions.map((s) => s.genKey);
    expect(a).toEqual(b);
    expect(new Set(a).size).toBe(a.length);
  });
});

function toState(classStart: string): SessionState[] {
  return generatePlan({ ...base, classStart }).sessions.map((s, i) => ({ id: i + 1, week: s.week, date: s.date, start: s.start, end: s.end, kind: s.kind, kindSource: 'auto', activity: s.activity, partId: s.partId, checkpoint: s.checkpoint, status: s.status, locked: false }));
}

describe('re-planning proposals', () => {
  it('pulls lessons forward when a class finishes early', () => {
    const s = toState('2026-09-07');
    s[0].status = 'completed'; s[0].locked = true;
    // Lesson parts 100 and 101 were both finished in the first session.
    const r = proposeReplan({ sessions: s, partIds: parts, coveredPartIds: [100, 101], holidays: [], rule: base.rule, from: '2026-09-08' });
    const next = r.changes.find((c) => c.sessionId === 3)!;
    expect(next.before.partId).toBe(101);
    expect(next.after.partId).toBe(102);
    expect(r.partShifts.find((p) => p.partId === 102)).toEqual({ partId: 102, oldDate: '2026-09-21', newDate: '2026-09-14' });
  });

  it('cancels a session on a new holiday, re-labels the week and shows date shifts', () => {
    const s = toState('2026-09-07');
    const r = proposeReplan({ sessions: s, partIds: parts, coveredPartIds: [], holidays: [{ date: '2026-09-14', name: 'New' }], rule: base.rule, from: '2026-09-01' });
    const cancelled = r.changes.find((c) => c.date === '2026-09-14')!;
    expect(cancelled.after.status).toBe('cancelled');
    const wed = r.changes.find((c) => c.date === '2026-09-16')!;
    expect(wed.after).toMatchObject({ kind: 'lecture', partId: 101 });
    expect(r.partShifts.find((p) => p.partId === 101)).toEqual({ partId: 101, oldDate: '2026-09-14', newDate: '2026-09-16' });
  });

  it('never changes completed or confirmed sessions', () => {
    const s = toState('2026-09-07');
    s[2].locked = true; // confirmed by the teacher
    const r = proposeReplan({ sessions: s, partIds: parts, coveredPartIds: [], holidays: [{ date: s[2].date, name: 'H' }], rule: base.rule, from: '2026-09-01' });
    expect(r.changes.find((c) => c.sessionId === 3)).toBeUndefined();
  });

  it('never pulls lessons into review/buffer weeks the teacher planned', () => {
    const template = standardTemplate(17).map((w) => (w.week === 3 ? { ...w, activity: 'buffer' as const, label: 'Lesson 2 continued' } : w));
    const s = generatePlan({ ...base, template, classStart: '2026-09-07' }).sessions.map((x, i) => ({ id: i + 1, week: x.week, date: x.date, start: x.start, end: x.end, kind: x.kind, kindSource: 'auto' as const, activity: x.activity, partId: x.partId, checkpoint: x.checkpoint, status: x.status as SessionState['status'], locked: false }));
    s[0].status = 'completed'; s[0].locked = true;
    const r = proposeReplan({ sessions: s, partIds: parts, coveredPartIds: [100], holidays: [], rule: base.rule, from: '2026-09-08' });
    expect(r.changes.filter((c) => s.find((x) => x.id === c.sessionId)!.week === 3)).toHaveLength(0);
  });

  it('respects manual Lecture/Practice overrides', () => {
    const s = toState('2026-09-07');
    s[3].kind = 'lecture'; s[3].kindSource = 'manual';
    const r = proposeReplan({ sessions: s, partIds: parts, coveredPartIds: [], holidays: [], rule: base.rule, from: '2026-09-01' });
    expect(r.changes.find((c) => c.sessionId === 4)?.after.kind ?? 'lecture').toBe('lecture');
  });

  it('cancelled sessions do not count as taught', () => {
    const s = toState('2026-09-07');
    s[0].status = 'cancelled';
    const p = classProgress({ partIds: parts, coveredPartIds: [], hasRecords: false, today: '2026-09-15', sessions: s.map((x) => ({ date: x.date, kind: x.kind, status: x.status, originalPartId: x.partId, originalDate: x.date })) });
    expect(p.actual).toBe(0);
  });
});

describe('double booking', () => {
  it('detects overlaps across classes and ignores cancelled sessions', () => {
    const o = findOverlaps([
      { id: 1, classId: 1, date: '2026-09-07', start: '08:00', end: '10:00' },
      { id: 2, classId: 2, date: '2026-09-07', start: '09:00', end: '10:00' },
      { id: 3, classId: 3, date: '2026-09-07', start: '10:00', end: '11:00' },
      { id: 4, classId: 4, date: '2026-09-07', start: '08:30', end: '09:00', status: 'cancelled' },
    ]);
    expect(o.map(([a, b]) => [a.id, b.id])).toEqual([[1, 2]]);
  });
});

const cfg = (mid = 20): GradeConfig => ({
  targetTotal: 100, passMark: 50, labelPass: 'ជាប់', labelFail: 'ធ្លាក់', attendanceRule: DEFAULT_ATTENDANCE_RULE,
  components: DEFAULT_COMPONENTS.map((c, i) => ({ ...c, id: i + 1, max: c.key === 'midterm' ? mid : c.max })),
});

describe('gradebook', () => {
  it('default maximums total 100', () => {
    expect(checkConfig(cfg())).toMatchObject({ total: 100, valid: true });
  });
  it('rejects a midterm of 25 (total 105) and accepts the corrected configuration', () => {
    const bad = checkConfig(cfg(25));
    expect(bad.valid).toBe(false);
    expect(bad.total).toBe(105);
    expect(bad.errors[0]).toMatch(/105/);
    expect(checkConfig(cfg(20)).valid).toBe(true);
  });
  it('keeps missing scores distinct from zero', () => {
    expect(parseScoreInput('')).toEqual({ ok: true, value: null });
    expect(parseScoreInput('0')).toEqual({ ok: true, value: 0 });
    const r = computeStudent(cfg(), { 1: 0 }, null);
    expect(r.values[1]).toBe(0);
    expect(r.missing).not.toContain(1);
    expect(r.missing).toContain(2);
  });
  it('rejects scores above the component maximum and parses Khmer digits', () => {
    expect(validateScore(6, 5)).toMatch(/above the maximum/);
    expect(validateScore(5, 5)).toBeNull();
    expect(parseScoreInput('៤.៥')).toEqual({ ok: true, value: 4.5 });
    expect(parseScoreInput('abc').ok).toBe(false);
  });
  it('calculates totals and pass/fail with a configurable pass mark', () => {
    const scores = { 1: 5, 2: 5, 3: 4, 4: 4, 5: 12, 6: 20 };
    const r = computeStudent(cfg(), scores, 10);
    expect(r).toMatchObject({ total: 60, complete: true, result: 'pass', label: 'ជាប់' });
    const strict = computeStudent({ ...cfg(), passMark: 65 }, scores, 10);
    expect(strict).toMatchObject({ result: 'fail', label: 'ធ្លាក់', atRisk: true });
  });
  it('treats an entered attendance value as a manual override', () => {
    const r = computeStudent(cfg(), { 7: 18 }, 12);
    expect(r.values[7]).toBe(18);
  });
  it('flags students who can no longer pass', () => {
    const r = computeStudent(cfg(), { 1: 0, 2: 0, 3: 0, 4: 0, 5: 0, 6: 0 }, null);
    expect(r.result).toBe('fail');
    expect(r.complete).toBe(false);
  });
  it('class statistics use complete students only', () => {
    const c = cfg();
    const s = classStats([computeStudent(c, { 1: 5, 2: 5, 3: 5, 4: 5, 5: 20, 6: 40 }, 20), computeStudent(c, { 1: 1 }, null)]);
    expect(s).toMatchObject({ students: 2, complete: 1, average: 100, passRate: 100 });
  });
});

describe('attendance scoring', () => {
  it('scores only recorded marks and applies late and excused policies', () => {
    expect(attendanceScore([], 20, DEFAULT_ATTENDANCE_RULE).score).toBeNull();
    const marks = ['present', 'present', 'late', 'absent', 'excused'] as const;
    expect(attendanceScore([...marks], 20, DEFAULT_ATTENDANCE_RULE).score).toBe(12.5); // 2.5 / 4
    expect(attendanceScore([...marks], 20, { lateCredit: 1, excused: 'present' }).score).toBe(16);
    expect(attendanceScore([...marks], 20, { lateCredit: 0.5, excused: 'absent' }).score).toBe(10);
  });
});

describe('progress', () => {
  const sessions = toState('2026-09-07').map((x) => ({ date: x.date, kind: x.kind, status: x.status, originalPartId: x.partId, originalDate: x.date }));
  it('reports ahead, on schedule and behind', () => {
    expect(classProgress({ partIds: parts, coveredPartIds: [], hasRecords: false, today: '2026-09-01', sessions }).status).toBe('not_started');
    expect(classProgress({ partIds: parts, coveredPartIds: [100, 101], hasRecords: true, today: '2026-09-15', sessions }).status).toBe('on_schedule');
    expect(classProgress({ partIds: parts, coveredPartIds: [100, 101, 102], hasRecords: true, today: '2026-09-15', sessions }).status).toBe('ahead');
    const behind = classProgress({ partIds: parts, coveredPartIds: [100], hasRecords: true, today: '2026-09-22', sessions });
    expect(behind.status).toBe('behind');
    expect(behind.nextPartId).toBe(101);
    expect(behind.reason).toMatch(/2 behind/);
  });
});

describe('pay', () => {
  const rates = [
    { id: 1, classId: null, courseId: null, mode: 'hourly' as const, amount: 10, effectiveFrom: '2026-01-01' },
    { id: 2, classId: 5, courseId: null, mode: 'per_session' as const, amount: 25, effectiveFrom: '2026-01-01' },
  ];
  it('uses the most specific rate and only counts taught sessions as earned', () => {
    expect(resolveRate(rates, { classId: 5, courseId: 1, date: '2026-09-01' })!.id).toBe(2);
    const m = monthlyPay([
      { id: 1, classId: 1, courseId: 1, date: '2026-09-07', minutes: 90, state: 'completed', isMakeup: false },
      { id: 2, classId: 5, courseId: 1, date: '2026-09-08', minutes: 60, state: 'completed', isMakeup: true },
      { id: 3, classId: 1, courseId: 1, date: '2026-09-30', minutes: 60, state: 'planned', isMakeup: false },
    ], rates, [{ month: '2026-09', amount: -5 }]);
    expect(m[0]).toMatchObject({ taughtSessions: 2, earned: 40, expected: 10, makeupSessions: 1, estimatedTotal: 35 });
  });
});
