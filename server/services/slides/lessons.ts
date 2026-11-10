import { AppError, DB, type Row } from '../../db.ts';
import type { User } from '../../auth.ts';
import { buildDeck, readSample, type DeckSlide, type SampleInfo } from './pptx.ts';
import { pdfPageCount, pdfPages, type LessonAsk } from './write.ts';
import { writerFor } from './ai.ts';
export { setWriter } from './ai.ts';

// Lesson slides from a book: a teacher keeps sample decks (the look and slide types of a course)
// and books (PDF), and asks for a lesson from a range of book pages. Writing takes a minute or
// more, so it runs in the background: the lesson is saved as "working" and becomes "ready" (or
// "failed" with the reason). The slide text can then be edited and downloaded as PowerPoint.

// ---- Sample decks and books -------------------------------------------------------------------

const fileOut = (f: Row) => {
  const info = JSON.parse(f.info || '{}');
  return {
    id: f.id, kind: f.kind, title: f.title, filename: f.filename, size: f.size, createdAt: f.created_at,
    ...(f.kind === 'book' ? { pages: info.pages ?? null } : { slideCount: info.slideCount ?? null }),
  };
};

export function listFiles(db: DB, u: User) {
  return db.all('SELECT id, kind, title, filename, size, info, created_at FROM slide_files WHERE owner_id = ? ORDER BY kind, created_at DESC', u.id).map(fileOut);
}

function ownFile(db: DB, u: User, id: number, kind?: 'sample' | 'book') {
  const f = db.get('SELECT id, owner_id, kind, title, filename, size, info, created_at FROM slide_files WHERE id = ?', id);
  if (!f || f.owner_id !== u.id || (kind && f.kind !== kind)) throw new AppError(404, kind === 'book' ? 'Book not found.' : kind === 'sample' ? 'Sample deck not found.' : 'File not found.');
  return f;
}
const fileData = (db: DB, id: number) => Buffer.from(db.get('SELECT data FROM slide_files WHERE id = ?', id)!.data as Uint8Array);

export async function addFile(db: DB, u: User, body: Buffer, filename: string, title: string | null) {
  if (!Buffer.isBuffer(body) || !body.length) throw new AppError(422, 'Choose a file to upload.');
  const name = filename.replace(/[\\/\u0000-\u001f]/g, '').trim().slice(0, 200);
  const ext = name.split('.').pop()?.toLowerCase();
  let kind: 'sample' | 'book';
  let info: object;
  if (ext === 'pptx') {
    const s = await readSample(body);
    kind = 'sample';
    info = s;
  } else if (ext === 'pdf') {
    kind = 'book';
    info = { pages: await pdfPageCount(body) };
  } else throw new AppError(422, 'Upload a sample deck as .pptx or a book as .pdf.');
  const t = (title ?? '').trim().slice(0, 200) || name.replace(/\.[^.]+$/, '');
  const id = db.tx(() => {
    const id = db.run('INSERT INTO slide_files (owner_id, kind, title, filename, size, info, data) VALUES (?,?,?,?,?,?,?)', u.id, kind, t, name, body.length, JSON.stringify(info), body).id;
    db.audit(u.id, 'slide_file', id, 'upload', undefined, { kind, title: t, filename: name, size: body.length });
    return id;
  });
  return fileOut(ownFile(db, u, id));
}

export function renameFile(db: DB, u: User, id: number, title: unknown) {
  const f = ownFile(db, u, id);
  const t = String(title ?? '').trim().slice(0, 200);
  if (!t) throw new AppError(422, 'Give it a name.');
  db.tx(() => { db.run('UPDATE slide_files SET title = ? WHERE id = ?', t, f.id); db.audit(u.id, 'slide_file', f.id, 'update', { title: f.title }, { title: t }); });
  return fileOut(ownFile(db, u, id));
}

export function deleteFile(db: DB, u: User, id: number) {
  const f = ownFile(db, u, id);
  db.tx(() => { db.run('DELETE FROM slide_files WHERE id = ?', f.id); db.audit(u.id, 'slide_file', f.id, 'delete', fileOut(f)); });
}

export function sampleSlides(db: DB, u: User, id: number): SampleInfo {
  return JSON.parse(ownFile(db, u, id, 'sample').info);
}

export function fileDownload(db: DB, u: User, id: number) {
  const f = ownFile(db, u, id);
  return { filename: f.filename, mime: f.kind === 'book' ? 'application/pdf' : PPTX, data: fileData(db, f.id) };
}

// ---- Lessons ----------------------------------------------------------------------------------

const PPTX = 'application/vnd.openxmlformats-officedocument.presentationml.presentation';

const lessonOut = (l: Row, withSlides = false) => ({
  id: l.id, title: l.title, status: l.status, error: l.error, sampleId: l.sample_id, bookId: l.book_id,
  request: JSON.parse(l.request || '{}'), usage: l.usage ? JSON.parse(l.usage) : null,
  slideCount: JSON.parse(l.slides || '[]').length, createdAt: l.created_at, updatedAt: l.updated_at,
  ...(withSlides ? { slides: JSON.parse(l.slides || '[]') as DeckSlide[] } : {}),
});

function ownLesson(db: DB, u: User, id: number) {
  const l = db.get('SELECT * FROM slide_lessons WHERE id = ?', id);
  if (!l || l.owner_id !== u.id) throw new AppError(404, 'Lesson not found.');
  return l;
}

export function listLessons(db: DB, u: User) {
  return db.all('SELECT * FROM slide_lessons WHERE owner_id = ? ORDER BY created_at DESC, id DESC', u.id).map((l) => lessonOut(l));
}

export function getLesson(db: DB, u: User, id: number) {
  return lessonOut(ownLesson(db, u, id), true);
}

const text = (v: unknown, max: number) => (v == null ? null : String(v).trim().slice(0, max) || null);

/**
 * Saves a new lesson as "working" and writes it in the background. `current` returns the live
 * database when the writing finishes (a restore can swap it in the meantime).
 */
export async function startLesson(db: DB, u: User, body: any, current: () => DB = () => db) {
  const sample = ownFile(db, u, Number(body?.sampleId), 'sample');
  const book = ownFile(db, u, Number(body?.bookId), 'book');
  const pages = JSON.parse(book.info).pages as number;
  const ask: LessonAsk = {
    lessonNo: text(body?.lessonNo, 20) ?? '',
    title: text(body?.title, 200),
    nextTitle: text(body?.nextTitle, 200),
    notes: text(body?.notes, 2000),
    fromPage: Math.trunc(Number(body?.fromPage)),
    toPage: Math.trunc(Number(body?.toPage)),
  };
  if (!ask.lessonNo) throw new AppError(422, 'Enter the lesson number.');
  if (!(ask.fromPage >= 1 && ask.toPage >= ask.fromPage && ask.toPage <= pages)) throw new AppError(422, `Choose pages between 1 and ${pages}.`);
  const write = writerFor(db);
  const pdf = await pdfPages(fileData(db, book.id), ask.fromPage, ask.toPage);
  const info: SampleInfo = JSON.parse(sample.info);
  const title = ask.title ?? `Lesson ${ask.lessonNo} — ${book.title}, pages ${ask.fromPage}–${ask.toPage}`;
  const id = db.tx(() => {
    const id = db.run("INSERT INTO slide_lessons (owner_id, sample_id, book_id, title, request, status) VALUES (?,?,?,?,?,'working')",
      u.id, sample.id, book.id, title, JSON.stringify(ask)).id;
    db.audit(u.id, 'slide_lesson', id, 'create', undefined, { title, ...ask });
    return id;
  });
  const done = write({ pdf, sample: info, ask }).then(
    (r) => current().run("UPDATE slide_lessons SET status = 'ready', error = NULL, slides = ?, usage = ?, updated_at = datetime('now') WHERE id = ? AND status = 'working'",
      JSON.stringify(r.slides), JSON.stringify(r.usage), id),
    (e) => {
      if (!(e instanceof AppError)) console.error('Lesson writing failed:', e);
      const msg = e instanceof AppError ? e.message : friendly(e);
      current().run("UPDATE slide_lessons SET status = 'failed', error = ?, updated_at = datetime('now') WHERE id = ? AND status = 'working'", msg, id);
    },
  ).catch((e) => console.error('Could not save the written lesson:', e));
  pending.add(done);
  void done.finally(() => pending.delete(done));
  return lessonOut(ownLesson(db, u, id));
}

const pending = new Set<Promise<unknown>>();
/** Resolves when every lesson being written has finished (for tests). */
export const settled = () => Promise.all([...pending]);

function friendly(e: any): string {
  const status = e?.status;
  if (status === 401 || status === 403 || (status === 400 && /api key/i.test(String(e?.message)))) return 'The AI service refused the API key. Ask the administrator to check it.';
  if (status === 404) return 'The AI service does not know that model name. Ask the administrator to check it on the Accounts page.';
  if (status === 429) return 'The AI service is busy or the API key has reached its limit. Try again in a few minutes.';
  if (status === 400 && /credit|balance|billing/i.test(String(e?.message))) return 'The AI account has run out of credit. Ask the administrator to top it up.';
  if (status === 413 || /too large|too long|exceed/i.test(String(e?.message))) return 'Those pages are too large to send in one go. Choose fewer pages.';
  if (status >= 500 || status === 529) return 'The AI service is not available right now. Try again in a few minutes.';
  return 'Writing the lesson failed. Try again.';
}

/** Lessons left "working" when the server stopped are marked failed (run at start-up). */
export function failInterrupted(db: DB) {
  db.run("UPDATE slide_lessons SET status = 'failed', error = 'The server restarted while this lesson was being written. Try again.', updated_at = datetime('now') WHERE status = 'working'");
}

export function saveLesson(db: DB, u: User, id: number, body: any) {
  const l = ownLesson(db, u, id);
  if (l.status === 'working') throw new AppError(409, 'This lesson is still being written.');
  const title = body?.title === undefined ? l.title : text(body.title, 200);
  if (!title) throw new AppError(422, 'Give the lesson a title.');
  let slides = l.slides as string;
  if (body?.slides !== undefined) {
    if (!Array.isArray(body.slides) || body.slides.length > 200) throw new AppError(422, 'The slides could not be read.');
    const info: SampleInfo | null = l.sample_id ? JSON.parse(ownFile(db, u, l.sample_id).info) : null;
    const clean: DeckSlide[] = body.slides.map((s: any, i: number) => {
      const sample = Math.trunc(Number(s?.sample));
      if (info && !info.slides.some((x) => x.index === sample)) throw new AppError(422, `Slide ${i + 1} uses a sample slide the deck does not have.`);
      return {
        sample,
        slots: (Array.isArray(s?.slots) ? s.slots : []).map((b: any) => ({
          slot: Math.trunc(Number(b?.slot)),
          lines: (Array.isArray(b?.lines) ? b.lines : []).slice(0, 40).map((x: unknown) => String(x ?? '').slice(0, 400)),
        })).filter((b: any) => b.slot >= 1),
      };
    });
    slides = JSON.stringify(clean);
  }
  db.tx(() => {
    db.run("UPDATE slide_lessons SET title = ?, slides = ?, status = CASE WHEN status = 'failed' AND ? <> '[]' THEN 'ready' ELSE status END, updated_at = datetime('now') WHERE id = ?", title, slides, slides, l.id);
    db.audit(u.id, 'slide_lesson', l.id, 'update', { title: l.title }, { title });
  });
  return getLesson(db, u, id);
}

export function deleteLesson(db: DB, u: User, id: number) {
  const l = ownLesson(db, u, id);
  db.tx(() => { db.run('DELETE FROM slide_lessons WHERE id = ?', l.id); db.audit(u.id, 'slide_lesson', l.id, 'delete', { title: l.title }); });
}

export async function lessonDeck(db: DB, u: User, id: number) {
  const l = ownLesson(db, u, id);
  if (l.status !== 'ready') throw new AppError(409, l.status === 'working' ? 'This lesson is still being written.' : 'This lesson has no slides yet.');
  if (!l.sample_id) throw new AppError(409, 'The sample deck for this lesson was deleted. Upload it again and write the lesson again.');
  const data = await buildDeck(fileData(db, l.sample_id), JSON.parse(l.slides));
  const filename = `${l.title.replace(/[\\/:*?"<>|\u0000-\u001f]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 120) || 'Lesson'}.pptx`;
  return { filename, mime: PPTX, data };
}
