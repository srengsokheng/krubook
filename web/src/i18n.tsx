import { createContext, useContext, useEffect, useState, type ReactNode } from 'react';
import { usePref } from './prefs.ts';

export type Lang = 'en' | 'km';

const km: Record<string, string> = {
  Dashboard: 'ផ្ទាំងគ្រប់គ្រង',
  Timetable: 'កាលវិភាគ',
  Classes: 'ថ្នាក់រៀន',
  Courses: 'មុខវិជ្ជា',
  Terms: 'ឆមាស',
  Students: 'និស្សិត',
  Pay: 'ម៉ោងបង្រៀន និងប្រាក់',
  Settings: 'ការកំណត់',
  'Sign out': 'ចាកចេញ',
  'Sign in': 'ចូលប្រើ',
  Email: 'អ៊ីមែល',
  Password: 'ពាក្យសម្ងាត់',
  Today: 'ថ្ងៃនេះ',
  'Teaching today': 'បង្រៀនថ្ងៃនេះ',
  'Up next': 'បន្ទាប់',
  'Not ready': 'មិនទាន់រួចរាល់',
  'Materials to prepare': 'ឯកសារត្រូវរៀបចំ',
  'Class progress': 'វឌ្ឍនភាពថ្នាក់',
  'Labs and exams ahead': 'ពិសោធន៍ និងការប្រឡងខាងមុខ',
  'Students at risk': 'និស្សិតប្រឈមនឹងការធ្លាក់',
  'Sessions this month': 'វគ្គខែនេះ',
  'Hours this month': 'ម៉ោងខែនេះ',
  'Estimated pay': 'ប្រាក់ប៉ាន់ស្មាន',
  Lecture: 'ទ្រឹស្តី',
  Practice: 'អនុវត្ត',
  Exam: 'ប្រឡង',
  ahead: 'លឿនជាងផែនការ',
  on_schedule: 'តាមផែនការ',
  behind: 'យឺតជាងផែនការ',
  not_started: 'មិនទាន់ចាប់ផ្តើម',
  planned: 'គ្រោងទុក',
  completed: 'បានបង្រៀន',
  cancelled: 'លុបចោល',
  skipped: 'រំលង',
  moved: 'ផ្លាស់ប្តូរ',
  present: 'វត្តមាន',
  late: 'យឺត',
  absent: 'អវត្តមាន',
  excused: 'មានច្បាប់',
  Overview: 'ទិដ្ឋភាពទូទៅ',
  'Term plan': 'ផែនការឆមាស',
  Roster: 'បញ្ជីឈ្មោះ',
  Attendance: 'វត្តមាន',
  Gradebook: 'សៀវភៅពិន្ទុ',
  Setup: 'ការរៀបចំ',
  Save: 'រក្សាទុក',
  Cancel: 'បោះបង់',
  Close: 'បិទ',
  Export: 'នាំចេញ',
  Print: 'បោះពុម្ព',
  'Mark taught': 'កត់ត្រាការបង្រៀន',
  'Mark everyone present': 'សម្គាល់ទាំងអស់ថាមានវត្តមាន',
  'Student ID': 'អត្តលេខ',
  'Khmer name': 'ឈ្មោះខ្មែរ',
  'Latin name': 'ឈ្មោះឡាតាំង',
  Total: 'សរុប',
  Result: 'លទ្ធផល',
  Average: 'មធ្យមភាគ',
  'Pass rate': 'អត្រាជាប់',
  Highest: 'ខ្ពស់បំផុត',
  Lowest: 'ទាបបំផុត',
  Missing: 'ខ្វះ',
  Week: 'សប្តាហ៍',
  Date: 'កាលបរិច្ឆេទ',
  Lesson: 'មេរៀន',
  Status: 'ស្ថានភាព',
  Notes: 'កំណត់ចំណាំ',
  Holidays: 'ថ្ងៃឈប់សម្រាក',
  Language: 'ភាសា',
  Offline: 'គ្មានអ៊ីនធឺណិត',
  Online: 'មានអ៊ីនធឺណិត',
  Synced: 'បានធ្វើសមកាលកម្ម',
  'waiting to sync': 'កំពុងរង់ចាំធ្វើសមកាលកម្ម',
  'Next lesson': 'មេរៀនបន្ទាប់',
  'Last taught': 'បានបង្រៀនចុងក្រោយ',
  'Import students': 'នាំចូលនិស្សិត',
  'Add student': 'បន្ថែមនិស្សិត',
  Search: 'ស្វែងរក',
  'This week': 'សប្តាហ៍នេះ',
  'Review changes': 'ពិនិត្យការផ្លាស់ប្តូរ',
  'Apply changes': 'អនុវត្តការផ្លាស់ប្តូរ',
  Backup: 'ការបម្រុងទុក',
};

const en: Record<string, string> = {
  ahead: 'Ahead of plan', on_schedule: 'On schedule', behind: 'Behind plan', not_started: 'Not started',
  planned: 'Planned', completed: 'Taught', cancelled: 'Cancelled', skipped: 'Skipped', moved: 'Moved',
  present: 'Present', late: 'Late', absent: 'Absent', excused: 'Excused',
};

type Ctx = { lang: Lang; setLang: (l: Lang) => void; t: (s: string) => string; setOverrides: (o: Record<string, string>) => void };
const Ctx = createContext<Ctx>({ lang: 'en', setLang: () => {}, t: (s) => s, setOverrides: () => {} });

export function I18nProvider({ children }: { children: ReactNode }) {
  // The language is an account preference, so it follows the teacher to every device.
  const [lang, setLang] = usePref<Lang>('lang', 'en');
  useEffect(() => { document.documentElement.lang = lang; }, [lang]);
  // Teachers can rename statuses in Settings; their wording wins over both dictionaries.
  const [overrides, setOverrides] = useState<Record<string, string>>({});
  const t = (s: string) => overrides[s] || (lang === 'km' ? km[s] : en[s]) || s;
  return <Ctx.Provider value={{ lang, setLang, t, setOverrides }}>{children}</Ctx.Provider>;
}

export const useI18n = () => useContext(Ctx);
