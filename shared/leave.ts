// The message a teacher sends to ask for leave from some classes, filled in from a template:
//
//   ជម្រាបសួរលោកគ្រូ ខ្ញុំសូមអនុញ្ញាតច្បាប់
//   SRENG SOKHENG FRI 13-11-2026 (2:45 PM - 5:15 PM ONLY)
//   ដោយសារខ្ញុំមានការប្រឡងថ្នាក់អនុបណ្ឌិត (Master)។ សូមអរគុណ ។
//
// Placeholders: {name} {day} {date} {times} {classes} {reason}. Classes that follow each other
// without a break are written as one time range.

export const DEFAULT_LEAVE_TEMPLATE = 'ជម្រាបសួរលោកគ្រូ ខ្ញុំសូមអនុញ្ញាតច្បាប់\n{name} {day} {date} ({times} ONLY)\nដោយសារ{reason}។ សូមអរគុណ ។';

/** Common reasons, in Khmer as they go into the message, with an English hint. */
export const LEAVE_REASONS: Array<{ km: string; en: string }> = [
  { km: 'ខ្ញុំមានការប្រឡងថ្នាក់អនុបណ្ឌិត (Master)', en: 'Master’s exam' },
  { km: 'ខ្ញុំមានធុរៈផ្ទាល់ខ្លួន', en: 'Personal matter' },
  { km: 'ខ្ញុំមិនស្រួលខ្លួន', en: 'Not feeling well' },
  { km: 'ខ្ញុំមានធុរៈបន្ទាន់ក្នុងគ្រួសារ', en: 'Family emergency' },
  { km: 'ខ្ញុំត្រូវចូលរួមកិច្ចប្រជុំ', en: 'Meeting' },
];

const DAYS = ['SUN', 'MON', 'TUE', 'WED', 'THU', 'FRI', 'SAT'];

/** "14:45" → "2:45 PM". */
export function time12(hhmm: string): string {
  const [h, m] = hhmm.split(':').map(Number) as [number, number];
  return `${((h + 11) % 12) + 1}:${String(m).padStart(2, '0')} ${h < 12 ? 'AM' : 'PM'}`;
}

/** Joins classes that follow on without a break (or overlap) into time ranges, in order. */
export function timeRanges(classes: Array<{ start: string; end: string }>): Array<{ start: string; end: string }> {
  const sorted = [...classes].sort((a, b) => a.start.localeCompare(b.start));
  const out: Array<{ start: string; end: string }> = [];
  for (const c of sorted) {
    const last = out[out.length - 1];
    if (last && c.start <= last.end) { if (c.end > last.end) last.end = c.end; }
    else out.push({ start: c.start, end: c.end });
  }
  return out;
}

export function leaveMessage(o: { template?: string | null; name: string; date: string; classes: Array<{ code: string; start: string; end: string }>; reason: string }): string {
  const [y, mo, d] = o.date.split('-');
  const day = DAYS[new Date(`${o.date}T00:00:00Z`).getUTCDay()]!;
  const times = timeRanges(o.classes).map((r) => `${time12(r.start)} - ${time12(r.end)}`).join(', ');
  const classes = [...o.classes].sort((a, b) => a.start.localeCompare(b.start)).map((c) => c.code).join(', ');
  const fill: Record<string, string> = {
    name: o.name.trim().toUpperCase(), day, date: `${d}-${mo}-${y}`, times, classes,
    reason: o.reason.trim().replace(/[។.\s]+$/u, ''),
  };
  return (o.template?.trim() ? o.template : DEFAULT_LEAVE_TEMPLATE).replace(/\{(name|day|date|times|classes|reason)\}/g, (_, k: string) => fill[k] ?? '');
}
