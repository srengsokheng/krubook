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
