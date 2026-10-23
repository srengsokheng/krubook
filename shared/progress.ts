import type { ISODate } from './dates.ts';

export type ProgressStatus = 'not_started' | 'ahead' | 'on_schedule' | 'behind';

export interface ProgressSession {
  date: ISODate;
  kind: string;
  status: string;
  /** Part this session was given in the original generated plan (the baseline). */
  originalPartId: number | null;
  originalDate: ISODate;
}

export interface ProgressInput {
  partIds: number[];
  coveredPartIds: Iterable<number>;
  sessions: ProgressSession[];
  hasRecords: boolean;
  today: ISODate;
  /** How many parts ahead or behind still counts as on schedule. */
  tolerance?: number;
}

export interface Progress {
  status: ProgressStatus;
  expected: number;
  actual: number;
  totalParts: number;
  nextPartId: number | null;
  reason: string;
}

/** Compares parts actually taught with the parts the original plan expected before today. */
export function classProgress(input: ProgressInput): Progress {
  const covered = new Set(input.coveredPartIds);
  const tol = input.tolerance ?? 0;
  const actual = input.partIds.filter((p) => covered.has(p)).length;
  const expectedSet = new Set<number>();
  for (const s of input.sessions) if (s.kind === 'lecture' && s.originalPartId != null && s.originalDate < input.today) expectedSet.add(s.originalPartId);
  const expected = expectedSet.size;
  const nextPartId = input.partIds.find((p) => !covered.has(p)) ?? null;
  const base = { expected, actual, totalParts: input.partIds.length, nextPartId };

  if (!input.hasRecords && expected === 0) return { ...base, status: 'not_started', reason: 'No sessions have been taught yet and none were due.' };
  const diff = actual - expected;
  if (diff > tol) return { ...base, status: 'ahead', reason: `${actual} of ${input.partIds.length} parts taught; the plan expected ${expected} by today.` };
  if (diff < -tol) return { ...base, status: 'behind', reason: `${actual} of ${input.partIds.length} parts taught; the plan expected ${expected} by today (${-diff} behind).` };
  return { ...base, status: 'on_schedule', reason: `${actual} parts taught, matching the plan.` };
}
