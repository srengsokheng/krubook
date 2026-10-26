// Starting calendar of Cambodian public holidays. Lunar holidays (Khmer New Year aside) move every
// year and the government publishes the official list by royal decree, so every entry here is
// editable in Settings → Holidays. Entries marked `approx` should be checked against that decree.

export interface HolidaySeed {
  date: string;
  name: string;
  nameKm: string;
  approx?: boolean;
}

/** 2026 dates match Sub-Decree No. 167 (18 Sep 2025); 2027 lunar holidays are not published yet. */
export const SOURCE_2026 = 'Sub-Decree No. 167 (18 Sep 2025)';

const FIXED: Array<[string, string, string]> = [
  ['01-01', "International New Year's Day", 'ទិវាចូលឆ្នាំសកល'],
  ['01-07', 'Victory over Genocide Day', 'ទិវាជ័យជម្នះលើរបបប្រល័យពូជសាសន៍'],
  ['03-08', "International Women's Day", 'ទិវានារីអន្តរជាតិ'],
  ['04-14', 'Khmer New Year', 'ពិធីបុណ្យចូលឆ្នាំថ្មីប្រពៃណីជាតិ'],
  ['04-15', 'Khmer New Year', 'ពិធីបុណ្យចូលឆ្នាំថ្មីប្រពៃណីជាតិ'],
  ['04-16', 'Khmer New Year', 'ពិធីបុណ្យចូលឆ្នាំថ្មីប្រពៃណីជាតិ'],
  ['05-01', 'International Labour Day', 'ទិវាពលកម្មអន្តរជាតិ'],
  ['05-14', "King Norodom Sihamoni's Birthday", 'ព្រះរាជពិធីបុណ្យចម្រើនព្រះជន្ម ព្រះមហាក្សត្រ'],
  ['06-18', "Queen Mother's Birthday", 'ព្រះរាជពិធីបុណ្យចម្រើនព្រះជន្ម សម្តេចព្រះមហាក្សត្រី'],
  ['09-24', 'Constitution Day', 'ទិវាប្រកាសរដ្ឋធម្មនុញ្ញ'],
  ['10-15', 'Commemoration Day of King Father Norodom Sihanouk', 'ទិវាប្រារព្ធពិធីគោរពព្រះវិញ្ញាណក្ខន្ធ ព្រះករុណា ព្រះបាទ នរោត្តម សីហនុ'],
  ['10-29', "King Norodom Sihamoni's Coronation Day", 'ព្រះរាជពិធីគ្រងព្រះបរមរាជសម្បត្តិ'],
  ['11-09', 'Independence Day', 'ពិធីបុណ្យឯករាជ្យជាតិ'],
  ['12-29', 'Peace Day in Cambodia', 'ទិវាសន្តិភាពនៅកម្ពុជា'],
];

const LUNAR_2026: HolidaySeed[] = [
  { date: '2026-05-01', name: 'Visak Bochea Day', nameKm: 'ពិធីបុណ្យវិសាខបូជា' },
  { date: '2026-05-05', name: 'Royal Ploughing Ceremony', nameKm: 'ព្រះរាជពិធីច្រត់ព្រះនង្គ័ល' },
  { date: '2026-10-10', name: 'Pchum Ben Festival', nameKm: 'ពិធីបុណ្យភ្ជុំបិណ្ឌ' },
  { date: '2026-10-11', name: 'Pchum Ben Festival', nameKm: 'ពិធីបុណ្យភ្ជុំបិណ្ឌ' },
  { date: '2026-10-12', name: 'Pchum Ben Festival', nameKm: 'ពិធីបុណ្យភ្ជុំបិណ្ឌ' },
  { date: '2026-11-23', name: 'Water Festival', nameKm: 'ព្រះរាជពិធីបុណ្យអុំទូក' },
  { date: '2026-11-24', name: 'Water Festival', nameKm: 'ព្រះរាជពិធីបុណ្យអុំទូក' },
  { date: '2026-11-25', name: 'Water Festival', nameKm: 'ព្រះរាជពិធីបុណ្យអុំទូក' },
];

export function cambodianHolidays(years: number[] = [2026, 2027]): HolidaySeed[] {
  const out: HolidaySeed[] = [];
  for (const y of years) for (const [md, name, nameKm] of FIXED) out.push({ date: `${y}-${md}`, name, nameKm });
  out.push(...LUNAR_2026.filter((h) => years.includes(+h.date.slice(0, 4))));
  // Visak Bochea and Labour Day can share a date; keep one row per date.
  const seen = new Set<string>();
  return out.sort((a, b) => a.date.localeCompare(b.date)).filter((h) => (seen.has(h.date) ? false : (seen.add(h.date), true)));
}

/** Consecutive days with the same name as one entry: Pchum Ben 10–12 Oct is one holiday, not three. */
export function holidayRanges(list: HolidaySeed[] = cambodianHolidays()): Array<HolidaySeed & { endDate: string | null }> {
  const out: Array<HolidaySeed & { endDate: string | null }> = [];
  for (const h of [...list].sort((a, b) => a.date.localeCompare(b.date))) {
    const last = out[out.length - 1];
    const next = last && new Date(Date.parse(`${last.endDate ?? last.date}T00:00:00Z`) + 86_400_000).toISOString().slice(0, 10);
    if (last && last.name === h.name && next === h.date) { last.endDate = h.date; last.approx = last.approx || h.approx; }
    else out.push({ ...h, endDate: null });
  }
  return out;
}
