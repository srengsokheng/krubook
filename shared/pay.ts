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
