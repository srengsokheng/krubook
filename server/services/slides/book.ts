// Finds the lessons in a course book so a teacher can pick "Lesson 3: Control Statements" instead
// of typing page numbers. Books like the SETEC C++ book print a running header on every page
// ("Lesson 3: Control Statements" or "មេរៀនទី ៣: Control Statements"); a lesson runs from the first
// page with its header to the page before the next lesson starts. Contents pages are skipped.
// Text is read with pdf.js; Khmer may come out garbled, but the numbers and English titles do not.

export interface BookLesson { no: number; title: string; from: number; to: number }

const KHMER_DIGITS = '០១២៣៤៥៦៧៨៩';
const toNumber = (s: string) => Number([...s].map((c) => (KHMER_DIGITS.includes(c) ? String(KHMER_DIGITS.indexOf(c)) : c)).join(''));

/** The text of each page (1-based array index 0 = page 1), whitespace collapsed. */
export async function pageTexts(buf: Buffer | Uint8Array, maxPages = 400): Promise<string[]> {
  const pdfjs = await import('pdfjs-dist/legacy/build/pdf.mjs');
  const task = pdfjs.getDocument({ data: new Uint8Array(buf), useSystemFonts: false, verbosity: 0 });
  const doc = await task.promise;
  const out: string[] = [];
  try {
    for (let i = 1; i <= Math.min(doc.numPages, maxPages); i++) {
      const page = await doc.getPage(i);
      const tc = await page.getTextContent();
      out.push(tc.items.map((it: any) => ('str' in it ? it.str : '')).join(' ').replace(/\s+/g, ' ').trim());
      page.cleanup();
    }
  } finally {
    await task.destroy();
  }
  return out;
}

// "Lesson 3: Control Statements", "Chapter 2 - Variables", "មេរៀនទី ៣: Control Statements".
const HEADING = /(?:\b(?:Lesson|Chapter|Unit)|មេរៀនទី|ជំពូកទី)\s*([0-9០-៩]{1,2})\s*[:.\-–—]\s*(.{2,120}?)(?=\s+SETEC\b|\s+\d{1,3}(?:[.\s]|$)|\s{2,}|\s+(?:Lesson|Chapter|Unit|មេរៀនទី|ជំពូកទី)\s*[0-9០-៩]|\s*\.{4,}|$)/i;
const isContents = (t: string) => /\b(Table of Contents|Contents)\b|មាតិកា/i.test(t.slice(0, 200)) || (t.match(/\.{6,}/g)?.length ?? 0) >= 3;

/** The heading a page starts with, if any (looks only near the top of the page). */
export function pageHeading(text: string): { no: number; title: string } | null {
  const m = HEADING.exec(text.slice(0, 260));
  if (!m) return null;
  const no = toNumber(m[1]!);
  const title = m[2]!.replace(/\s+/g, ' ').replace(/[\s.:–—-]+$/, '').trim();
  return no >= 1 && no <= 99 && title ? { no, title } : null;
}

/** The lessons of a book from its page texts; empty when the book has no recognisable headings. */
export function findLessons(texts: string[]): BookLesson[] {
  const firstPage = new Map<number, { page: number; title: string }>();
  const lastPage = new Map<number, number>();
  texts.forEach((t, i) => {
    if (isContents(t)) return;
    const h = pageHeading(t);
    if (!h) return;
    if (!firstPage.has(h.no)) firstPage.set(h.no, { page: i + 1, title: h.title });
    lastPage.set(h.no, i + 1);
  });
  // Keep lessons in page order; a number that appears out of order (a cross-reference) is dropped.
  const starts = [...firstPage].map(([no, v]) => ({ no, ...v })).sort((a, b) => a.page - b.page);
  const ordered = starts.filter((s, i) => i === 0 || s.no > starts[i - 1]!.no);
  return ordered.map((s, i) => {
    const next = ordered[i + 1];
    const to = next ? next.page - 1 : Math.max(lastPage.get(s.no) ?? s.page, s.page);
    return { no: s.no, title: s.title, from: s.page, to: Math.max(s.page, to) };
  });
}

/** Lessons of a PDF book; never throws (a book we cannot read simply has no lesson list). */
export async function bookLessons(buf: Buffer | Uint8Array): Promise<BookLesson[]> {
  try {
    return findLessons(await pageTexts(buf));
  } catch (e) {
    console.error('Could not read the lessons of a book:', (e as Error).message);
    return [];
  }
}
