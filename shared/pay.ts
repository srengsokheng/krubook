import type { ISODate } from './dates.ts';

export interface Rate {
  id: number;
  classId: number | null;
  courseId: number | null;
  mode: 'hourly' | 'per_session';
  amount: number;
  effectiveFrom: ISODate;
  active?: boolean;
}

export interface PaySession {
  id: number;
  classId: number;
  courseId: number;
  date: ISODate;
  minutes: number;
  /** completed = taught and recorded; planned = still in the future. */
  state: 'completed' | 'planned';
  isMakeup: boolean;
}

/** The most specific rate in force on the date: class, then course, then the default rate. */
export function resolveRate(rates: Rate[], s: Pick<PaySession, 'classId' | 'courseId' | 'date'>): Rate | null {
  const live = rates.filter((r) => r.active !== false && r.effectiveFrom <= s.date).sort((a, b) => b.effectiveFrom.localeCompare(a.effectiveFrom));
  return live.find((r) => r.classId === s.classId) ?? live.find((r) => r.classId == null && r.courseId === s.courseId) ?? live.find((r) => r.classId == null && r.courseId == null) ?? null;
}

export function sessionPay(rate: Rate | null, minutes: number): number {
  if (!rate) return 0;
  const v = rate.mode === 'hourly' ? (rate.amount * minutes) / 60 : rate.amount;
  return Math.round(v * 100) / 100;
}

// Pay months run from a start day in the previous month up to the day before it in the pay month:
// with the default start day 16, teaching from 16 Aug to 15 Sep is the September pay, paid at the end
// of September. A start day of 1 means plain calendar months.
export const DEFAULT_PAY_START_DAY = 16;

const pad = (n: number) => String(n).padStart(2, '0');

/** The pay month (YYYY-MM) a teaching date belongs to. */
export function payMonthOf(d: ISODate, startDay = DEFAULT_PAY_START_DAY): string {
  const y = +d.slice(0, 4), m = +d.slice(5, 7), day = +d.slice(8, 10);
  if (startDay <= 1 || day < startDay) return d.slice(0, 7);
  return m === 12 ? `${y + 1}-01` : `${y}-${pad(m + 1)}`;
}

/** First and last teaching date counted in a pay month. */
export function payPeriod(month: string, startDay = DEFAULT_PAY_START_DAY): { from: ISODate; to: ISODate } {
  const y = +month.slice(0, 4), m = +month.slice(5, 7);
  if (startDay <= 1) return { from: `${month}-01`, to: `${month}-${pad(new Date(Date.UTC(y, m, 0)).getUTCDate())}` };
  const py = m === 1 ? y - 1 : y, pm = m === 1 ? 12 : m - 1;
  return { from: `${py}-${pad(pm)}-${pad(startDay)}`, to: `${month}-${pad(startDay - 1)}` };
}

// Late arrival. The teacher checks in for a session; minutes after the scheduled start are late.
// The late rule is a list of steps: arriving more than `afterMinutes` late cuts `cutPercent` of that
// session's pay, and the highest step reached applies. Lateness is in whole minutes, so "more than
// 29" means 30 or more. The default: up to 10 minutes late costs nothing, 11 to 29 cuts half, 30 or
// more leaves the session unpaid. No steps = no cuts.
export interface LateStep {
  afterMinutes: number;
  cutPercent: number;
}
export interface LateRule {
  steps: LateStep[];
}
export const DEFAULT_LATE_RULE: LateRule = { steps: [{ afterMinutes: 10, cutPercent: 50 }, { afterMinutes: 29, cutPercent: 100 }] };

const toMinutes = (t: string) => +t.slice(0, 2) * 60 + +t.slice(3, 5);

/** Minutes between the scheduled start and the check-in; 0 when on time or early. */
export function lateMinutes(start: string, checkin: string | null | undefined): number {
  if (!checkin) return 0;
  return Math.max(0, toMinutes(checkin) - toMinutes(start));
}

/** The share of a session's pay (0–100) lost for arriving `late` minutes after the start. */
export function lateCutPercent(late: number, rule: LateRule): number {
  let cut = 0;
  for (const s of rule.steps) if (late > s.afterMinutes) cut = Math.max(cut, s.cutPercent);
  return cut;
}

/** The amount taken off a session paying `pay` for arriving `late` minutes after the start. */
export function lateDeduction(pay: number, late: number, rule: LateRule): { percent: number; amount: number } {
  const percent = lateCutPercent(late, rule);
  return { percent, amount: Math.round(pay * percent) / 100 };
}

/** Checks a late rule from settings or a request; returns null when it is not valid. */
export function validLateRule(v: unknown): LateRule | null {
  const steps = (v as LateRule)?.steps;
  if (!Array.isArray(steps) || steps.length > 5) return null;
  const out: LateStep[] = [];
  for (const s of steps) {
    const after = Number(s?.afterMinutes), cut = Number(s?.cutPercent);
    if (!Number.isInteger(after) || after < 0 || after > 240 || !Number.isFinite(cut) || cut <= 0 || cut > 100) return null;
    out.push({ afterMinutes: after, cutPercent: Math.round(cut * 100) / 100 });
  }
  out.sort((a, b) => a.afterMinutes - b.afterMinutes);
  if (new Set(out.map((s) => s.afterMinutes)).size !== out.length) return null;
  return { steps: out };
}

export function parseLateRule(raw: string | null | undefined): LateRule {
  try {
    return validLateRule(JSON.parse(raw ?? '')) ?? DEFAULT_LATE_RULE;
  } catch {
    return DEFAULT_LATE_RULE;
  }
}
