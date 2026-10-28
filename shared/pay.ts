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
// With the 'deduct' rule, an arrival later than the grace period loses the pay for every late
// minute (not only the minutes past the grace period). 'none' records lateness without changing pay.
export interface LateRule {
  mode: 'deduct' | 'none';
  graceMinutes: number;
}
export const DEFAULT_LATE_RULE: LateRule = { mode: 'deduct', graceMinutes: 0 };

const toMinutes = (t: string) => +t.slice(0, 2) * 60 + +t.slice(3, 5);

/** Minutes between the scheduled start and the check-in; 0 when on time or early. */
export function lateMinutes(start: string, checkin: string | null | undefined): number {
  if (!checkin) return 0;
  return Math.max(0, toMinutes(checkin) - toMinutes(start));
}

/**
 * The amount taken off a session for arriving late. Hourly rates lose the late minutes at the
 * hourly rate; per-session rates lose the same share of the session's scheduled length.
 */
export function lateDeduction(rate: Rate | null, scheduledMinutes: number, late: number, rule: LateRule): { minutes: number; amount: number } {
  if (!rate || rule.mode !== 'deduct' || late <= rule.graceMinutes || scheduledMinutes <= 0) return { minutes: 0, amount: 0 };
  const minutes = Math.min(late, scheduledMinutes);
  const perMinute = rate.mode === 'hourly' ? rate.amount / 60 : rate.amount / scheduledMinutes;
  return { minutes, amount: Math.round(perMinute * minutes * 100) / 100 };
}

export function parseLateRule(raw: string | null | undefined): LateRule {
  try {
    const v = JSON.parse(raw ?? '');
    const grace = Number(v?.graceMinutes);
    return { mode: v?.mode === 'none' ? 'none' : 'deduct', graceMinutes: Number.isInteger(grace) && grace >= 0 && grace <= 120 ? grace : 0 };
  } catch {
    return DEFAULT_LATE_RULE;
  }
}
