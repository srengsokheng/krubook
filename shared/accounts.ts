// Accounts and what each one may use. One teacher per account; every teacher's courses, classes,
// students, grades and pay are visible only to that teacher. Administrators also manage accounts
// (create, suspend, reset passwords, set the paid-until date and features) but cannot open another
// teacher's data.

export const FEATURES = {
  pay: { label: 'Pay, rates and payslips', paths: [/^\/pay(\/|$)/, /^\/rates(\/|$)/, /^\/export\/pay\//] },
  import: { label: 'Update from Excel and spreadsheet imports', paths: [/^\/workbook\//, /^\/import\//, /^\/classes\/\d+\/import\//, /^\/students\/id-(match|apply)$/] },
  exports: { label: 'Excel exports', paths: [/^\/export\//] },
  reminders: { label: 'Telegram reminders', paths: [/^\/notifications\//] },
  slides: { label: 'Lesson slides from a book (uses the Claude API)', paths: [/^\/slides(\/|$)/] },
} as const;
export type Feature = keyof typeof FEATURES;
export const FEATURE_KEYS = Object.keys(FEATURES) as Feature[];

/** The feature an API path belongs to, if it is one that can be switched off. */
export function featureOf(path: string): Feature | null {
  for (const k of FEATURE_KEYS) if (FEATURES[k].paths.some((re) => re.test(path))) return k;
  return null;
}

export function parseFeaturesOff(raw: unknown): Feature[] {
  try {
    const v = typeof raw === 'string' ? JSON.parse(raw) : raw;
    return Array.isArray(v) ? FEATURE_KEYS.filter((k) => v.includes(k)) : [];
  } catch {
    return [];
  }
}

/** True when a non-admin account's paid-until date has passed (`today` and the date are YYYY-MM-DD). */
export function accessExpired(role: string, accessUntil: string | null | undefined, today: string): boolean {
  return role !== 'admin' && !!accessUntil && accessUntil < today;
}
