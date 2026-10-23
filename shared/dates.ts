// Calendar dates are ISO-8601 `YYYY-MM-DD` values (stored as SQLite DATE text, which sorts and
// compares correctly). All arithmetic goes through a day number so it never depends on the host
// machine's time zone or daylight-saving rules. Times of day are `HH:MM` in the school's zone.

export type ISODate = string;
export const DEFAULT_TZ = 'Asia/Phnom_Penh';

const DATE_RE = /^(\d{4})-(\d{2})-(\d{2})$/;
const TIME_RE = /^([01]\d|2[0-3]):([0-5]\d)$/;

export function isISODate(v: unknown): v is ISODate {
  if (typeof v !== 'string') return false;
  const m = DATE_RE.exec(v);
  if (!m) return false;
  const d = new Date(Date.UTC(+m[1], +m[2] - 1, +m[3]));
  return d.getUTCFullYear() === +m[1] && d.getUTCMonth() === +m[2] - 1 && d.getUTCDate() === +m[3];
}

export function isTime(v: unknown): v is string {
  return typeof v === 'string' && TIME_RE.test(v);
}

/** Days since 1970-01-01. */
export function toDayNumber(d: ISODate): number {
  const m = DATE_RE.exec(d);
  if (!m) throw new Error(`Invalid date: ${d}`);
  return Math.floor(Date.UTC(+m[1], +m[2] - 1, +m[3]) / 86400000);
}

export function fromDayNumber(n: number): ISODate {
  return new Date(n * 86400000).toISOString().slice(0, 10);
}

export function addDays(d: ISODate, days: number): ISODate {
  return fromDayNumber(toDayNumber(d) + days);
}

export function diffDays(a: ISODate, b: ISODate): number {
  return toDayNumber(a) - toDayNumber(b);
}

/** 0 = Sunday … 6 = Saturday. */
export function weekday(d: ISODate): number {
  return (toDayNumber(d) + 4) % 7; // 1970-01-01 was a Thursday
}

/** Monday of the week containing `d`. */
export function startOfWeek(d: ISODate): ISODate {
  const wd = weekday(d);
  return addDays(d, -((wd + 6) % 7));
}

export function minutesOf(t: string): number {
  const [h, m] = t.split(':').map(Number);
  return h * 60 + m;
}

export function durationMinutes(start: string, end: string): number {
  return minutesOf(end) - minutesOf(start);
}

export function rangesOverlap(aStart: string, aEnd: string, bStart: string, bEnd: string): boolean {
  return minutesOf(aStart) < minutesOf(bEnd) && minutesOf(bStart) < minutesOf(aEnd);
}

/** Today's calendar date in the given IANA zone. */
export function todayIn(tz: string = DEFAULT_TZ, now: Date = new Date()): ISODate {
  const parts = new Intl.DateTimeFormat('en-CA', { timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit' }).formatToParts(now);
  const get = (t: string) => parts.find((p) => p.type === t)!.value;
  return `${get('year')}-${get('month')}-${get('day')}`;
}

export function nowTimeIn(tz: string = DEFAULT_TZ, now: Date = new Date()): string {
  return new Intl.DateTimeFormat('en-GB', { timeZone: tz, hour: '2-digit', minute: '2-digit', hour12: false }).format(now);
}

export function monthOf(d: ISODate): string {
  return d.slice(0, 7);
}

export function inRange(d: ISODate, from?: ISODate | null, to?: ISODate | null): boolean {
  if (from && d < from) return false;
  if (to && d > to) return false;
  return true;
}

const WD_EN = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const MON_EN = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const WD_KM = ['អាទិត្យ', 'ច័ន្ទ', 'អង្គារ', 'ពុធ', 'ព្រហស្បតិ៍', 'សុក្រ', 'សៅរ៍'];
const MON_KM = ['មករា', 'កុម្ភៈ', 'មីនា', 'មេសា', 'ឧសភា', 'មិថុនា', 'កក្កដា', 'សីហា', 'កញ្ញា', 'តុលា', 'វិច្ឆិកា', 'ធ្នូ'];

export function weekdayName(wd: number, lang: 'en' | 'km' = 'en'): string {
  return (lang === 'km' ? WD_KM : WD_EN)[wd];
}

/** Display only, e.g. "Mon Sep 7". Never stored. */
export function formatDate(d: ISODate, lang: 'en' | 'km' = 'en', withYear = false): string {
  const [y, m, day] = d.split('-').map(Number);
  const wd = weekday(d);
  if (lang === 'km') return `${WD_KM[wd]} ${day} ${MON_KM[m - 1]}${withYear ? ' ' + y : ''}`;
  return `${WD_EN[wd]} ${MON_EN[m - 1]} ${day}${withYear ? ', ' + y : ''}`;
}
