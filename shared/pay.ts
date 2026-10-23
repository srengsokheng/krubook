import { monthOf, type ISODate } from './dates.ts';

export interface Rate {
  id: number;
  classId: number | null;
  courseId: number | null;
  mode: 'hourly' | 'per_session';
  amount: number;
  effectiveFrom: ISODate;
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
  const live = rates.filter((r) => r.effectiveFrom <= s.date).sort((a, b) => b.effectiveFrom.localeCompare(a.effectiveFrom));
  return live.find((r) => r.classId === s.classId) ?? live.find((r) => r.classId == null && r.courseId === s.courseId) ?? live.find((r) => r.classId == null && r.courseId == null) ?? null;
}

export function sessionPay(rate: Rate | null, minutes: number): number {
  if (!rate) return 0;
  const v = rate.mode === 'hourly' ? (rate.amount * minutes) / 60 : rate.amount;
  return Math.round(v * 100) / 100;
}

export interface MonthPay {
  month: string;
  taughtSessions: number;
  taughtMinutes: number;
  earned: number;
  plannedSessions: number;
  expected: number;
  makeupSessions: number;
  unratedSessions: number;
  adjustments: number;
  estimatedTotal: number;
}

export function monthlyPay(sessions: PaySession[], rates: Rate[], adjustments: Array<{ month: string; amount: number }>): MonthPay[] {
  const months = new Map<string, MonthPay>();
  const get = (m: string) => {
    if (!months.has(m)) months.set(m, { month: m, taughtSessions: 0, taughtMinutes: 0, earned: 0, plannedSessions: 0, expected: 0, makeupSessions: 0, unratedSessions: 0, adjustments: 0, estimatedTotal: 0 });
    return months.get(m)!;
  };
  for (const s of sessions) {
    const m = get(monthOf(s.date));
    const rate = resolveRate(rates, s);
    if (!rate) m.unratedSessions++;
    const amount = sessionPay(rate, s.minutes);
    if (s.state === 'completed') {
      m.taughtSessions++;
      m.taughtMinutes += s.minutes;
      m.earned += amount;
      if (s.isMakeup) m.makeupSessions++;
    } else {
      m.plannedSessions++;
      m.expected += amount;
    }
  }
  for (const a of adjustments) get(a.month).adjustments += a.amount;
  const r2 = (n: number) => Math.round(n * 100) / 100;
  return [...months.values()]
    .map((m) => ({ ...m, earned: r2(m.earned), expected: r2(m.expected), adjustments: r2(m.adjustments), estimatedTotal: r2(m.earned + m.adjustments) }))
    .sort((a, b) => a.month.localeCompare(b.month));
}
