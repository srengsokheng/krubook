export type ComponentKind = 'manual' | 'attendance';

export interface GradeComponent {
  id: number;
  key: string;
  name: string;
  max: number;
  kind: ComponentKind;
  position: number;
}

export interface AttendanceRule {
  /** Share of a present mark that a late arrival earns (0–1). */
  lateCredit: number;
  /** How excused absences count: removed from the count, counted as present, or as absent. */
  excused: 'exclude' | 'present' | 'absent';
}

export const DEFAULT_ATTENDANCE_RULE: AttendanceRule = { lateCredit: 0.5, excused: 'exclude' };

export interface GradeConfig {
  targetTotal: number;
  passMark: number;
  labelPass: string;
  labelFail: string;
  components: GradeComponent[];
  attendanceRule: AttendanceRule;
}

export const DEFAULT_COMPONENTS: Array<Omit<GradeComponent, 'id'>> = [
  { key: 'lab1', name: 'LAB 1', max: 5, kind: 'manual', position: 1 },
  { key: 'lab2', name: 'LAB 2', max: 5, kind: 'manual', position: 2 },
  { key: 'lab3', name: 'LAB 3', max: 5, kind: 'manual', position: 3 },
  { key: 'lab4', name: 'LAB 4', max: 5, kind: 'manual', position: 4 },
  { key: 'midterm', name: 'Midterm', max: 20, kind: 'manual', position: 5 },
  { key: 'final', name: 'Final project', max: 40, kind: 'manual', position: 6 },
  { key: 'attendance', name: 'Attendance & activity', max: 20, kind: 'attendance', position: 7 },
];

const round2 = (n: number) => Math.round(n * 100) / 100;

export interface ConfigCheck {
  total: number;
  valid: boolean;
  errors: string[];
}

export function checkConfig(cfg: Pick<GradeConfig, 'targetTotal' | 'passMark' | 'components'>): ConfigCheck {
  const errors: string[] = [];
  const total = round2(cfg.components.reduce((s, c) => s + c.max, 0));
  if (!cfg.components.length) errors.push('Add at least one grade component.');
  for (const c of cfg.components) {
    if (!(c.max > 0)) errors.push(`${c.name}: maximum must be greater than 0.`);
    if (!c.name.trim()) errors.push('Every component needs a name.');
  }
  const keys = cfg.components.map((c) => c.key);
  if (new Set(keys).size !== keys.length) errors.push('Component keys must be unique.');
  if (cfg.components.filter((c) => c.kind === 'attendance').length > 1) errors.push('Only one component can be calculated from attendance.');
  if (total !== cfg.targetTotal) errors.push(`Maximum scores add up to ${total}, but the target total is ${cfg.targetTotal}. Adjust the maximums so they add up to ${cfg.targetTotal}.`);
  if (!(cfg.passMark > 0 && cfg.passMark <= cfg.targetTotal)) errors.push(`Pass mark must be between 0 and ${cfg.targetTotal}.`);
  return { total, valid: errors.length === 0, errors };
}

const KHMER_DIGITS = '០១២៣៤៥៦៧៨៩';

/**
 * Parses what a teacher types or pastes into a score cell.
 * Returns `null` for an empty cell (missing score), which is different from 0.
 */
export function parseScoreInput(raw: string): { ok: true; value: number | null } | { ok: false; error: string } {
  let s = raw.trim();
  if (s === '' || s === '-') return { ok: true, value: null };
  s = s.replace(/[០-៩]/g, (d) => String(KHMER_DIGITS.indexOf(d))).replace(',', '.');
  if (!/^\d+(\.\d+)?$/.test(s)) return { ok: false, error: `"${raw.trim()}" is not a number.` };
  return { ok: true, value: Number(s) };
}

export function validateScore(value: number, max: number): string | null {
  if (!Number.isFinite(value)) return 'Score must be a number.';
  if (value < 0) return 'Score cannot be negative.';
  if (value > max) return `Score ${value} is above the maximum of ${max}.`;
  if (Math.round(value * 100) !== value * 100) return 'Use at most two decimal places.';
  return null;
}

export type AttendanceMark = 'present' | 'late' | 'absent' | 'excused';

export interface AttendanceScore {
  score: number | null;
  counted: number;
  present: number;
  late: number;
  absent: number;
  excused: number;
  percent: number | null;
}

/**
 * Attendance points from marks on sessions that actually took place. Sessions without a mark are
 * not counted at all, so a forgotten roll call is never treated as an absence.
 */
export function attendanceScore(marks: AttendanceMark[], max: number, rule: AttendanceRule): AttendanceScore {
  const c = { present: 0, late: 0, absent: 0, excused: 0 };
  for (const m of marks) c[m]++;
  let earned = c.present + c.late * rule.lateCredit;
  let counted = c.present + c.late + c.absent;
  if (rule.excused === 'present') { earned += c.excused; counted += c.excused; }
  if (rule.excused === 'absent') counted += c.excused;
  const ratio = counted ? earned / counted : null;
  return { ...c, counted, score: ratio === null ? null : round2(ratio * max), percent: ratio === null ? null : round2(ratio * 100) };
}

export interface StudentResult {
  values: Record<number, number | null>;
  total: number;
  gradedMax: number;
  missing: number[];
  complete: boolean;
  result: 'pass' | 'fail' | 'incomplete';
  label: string;
  atRisk: boolean;
  riskReason: string | null;
}

/**
 * `scores` holds entered values per component id. For the attendance component, an entered value is
 * a manual override; otherwise the calculated attendance score is used.
 */
export function computeStudent(cfg: GradeConfig, scores: Record<number, number | null | undefined>, attendance: number | null): StudentResult {
  const values: Record<number, number | null> = {};
  const missing: number[] = [];
  let total = 0, gradedMax = 0;
  for (const c of cfg.components) {
    let v = scores[c.id];
    if ((v === undefined || v === null) && c.kind === 'attendance') v = attendance;
    values[c.id] = v ?? null;
    if (v === undefined || v === null) missing.push(c.id);
    else { total += v; gradedMax += c.max; }
  }
  total = round2(total);
  const complete = missing.length === 0;
  const remaining = cfg.components.filter((c) => missing.includes(c.id)).reduce((s, c) => s + c.max, 0);
  let result: StudentResult['result'] = 'incomplete';
  if (complete) result = total >= cfg.passMark ? 'pass' : 'fail';
  else if (total + remaining < cfg.passMark) result = 'fail';

  let atRisk = false, riskReason: string | null = null;
  if (result === 'fail') {
    atRisk = true;
    riskReason = complete ? `Total ${total} is below the pass mark of ${cfg.passMark}.` : `Cannot reach ${cfg.passMark} even with full marks on the remaining components.`;
  } else if (!complete && gradedMax > 0 && total / gradedMax < cfg.passMark / cfg.targetTotal) {
    atRisk = true;
    riskReason = `Scoring ${Math.round((total / gradedMax) * 100)}% so far; the pass mark needs ${Math.round((cfg.passMark / cfg.targetTotal) * 100)}%.`;
  }
  const label = result === 'pass' ? cfg.labelPass : result === 'fail' ? cfg.labelFail : '';
  return { values, total, gradedMax, missing, complete, result, label, atRisk, riskReason };
}

export interface ClassStats {
  students: number;
  complete: number;
  average: number | null;
  passRate: number | null;
  highest: number | null;
  lowest: number | null;
  atRisk: number;
  missingCells: number;
}

export function classStats(results: StudentResult[]): ClassStats {
  const done = results.filter((r) => r.complete);
  const totals = done.map((r) => r.total);
  return {
    students: results.length,
    complete: done.length,
    average: totals.length ? round2(totals.reduce((a, b) => a + b, 0) / totals.length) : null,
    passRate: done.length ? round2((done.filter((r) => r.result === 'pass').length / done.length) * 100) : null,
    highest: totals.length ? Math.max(...totals) : null,
    lowest: totals.length ? Math.min(...totals) : null,
    atRisk: results.filter((r) => r.atRisk).length,
    missingCells: results.reduce((s, r) => s + r.missing.length, 0),
  };
}
