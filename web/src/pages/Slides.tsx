import { useEffect, useRef, useState } from 'react';
import { api, download, useApi } from '../api.ts';
import { Confirm, Empty, ErrorNote, Field, Icon, Loading, Menu, Notice, Pill, useAction, useToast } from '../ui.tsx';
import type { Me } from '../App.tsx';

// Lesson slides from a book: keep a sample deck (the look and slide types of a course) and the
// course book, choose the book pages for a lesson, and KruBook writes the lesson in the sample's
// format with the AI an administrator chose (Claude or Gemini). The text can be checked and edited here before downloading PowerPoint.

type SlideFile = { id: number; kind: 'sample' | 'book'; title: string; filename: string; size: number; pages?: number | null; lessons?: { no: number; title: string; from: number; to: number }[]; slideCount?: number | null; createdAt: string };
type Slot = { slot: number; lines: string[]; chars: number; page?: boolean };
type SampleInfo = { slideCount: number; slides: { index: number; slots: Slot[] }[] };
type DeckSlide = { sample: number; slots: { slot: number; lines: string[] }[] };
type Lesson = {
  id: number; title: string; status: 'working' | 'ready' | 'failed'; error: string | null; sampleId: number | null; bookId: number | null;
  request: { lessonNo: string; fromPage: number; toPage: number; title?: string; nextTitle?: string };
  usage: { input: number; output: number; model: string } | null; slideCount: number; createdAt: string; slides?: DeckSlide[];
};
type Status = { ready: boolean; demo: boolean; provider: string; providerLabel: string; model: string };

const size = (n: number) => (n < 1024 * 1024 ? `${Math.max(1, Math.round(n / 1024))} KB` : `${(n / 1024 / 1024).toFixed(1)} MB`);
// Claude list prices in US$ per million tokens (input, output). Gemini's show on the Google bill.
const PRICES: Record<string, [number, number]> = { 'claude-opus-5-5': [4, 20], 'claude-sonnet-5-5': [2, 10], 'claude-haiku-5-5': [0.1, 0.5] };
const cost = (u: Lesson['usage']) => {
  if (!u || !u.input) return null;
  const p = PRICES[u.model];
  return p ? `${u.model}, about $${Math.max(0.01, (u.input * p[0] + u.output * p[1]) / 1e6).toFixed(2)}` : `${u.model}, ${Math.round((u.input + u.output) / 1000)}k tokens`;
};
/** Rough cost of a lesson from `pages` book pages with `model`; empty when the price is not known. */
const estimate = (model: string, pages: number) => {
  const p = PRICES[model];
  if (!p) return '';
  const lo = ((20_000 + pages * 1500) * p[0] + 10_000 * p[1]) / 1e6;
  const hi = ((25_000 + pages * 3000) * p[0] + 30_000 * p[1]) / 1e6;
  return ` Roughly $${Math.max(0.01, lo).toFixed(2)}–$${Math.max(0.01, hi).toFixed(2)} with ${model}.`;
};

export function Slides({ me }: { me: Me }) {
  const files = useApi<SlideFile[]>('/slides/files');
  const lessons = useApi<Lesson[]>('/slides/lessons');
  const status = useApi<Status>('/slides/status');
  const [open, setOpen] = useState<number | null>(null);
  const working = lessons.data?.some((l) => l.status === 'working');
  const reloadLessons = lessons.reload;

  // While a lesson is being written, check on it every few seconds.
  useEffect(() => {
    if (!working) return;
    const t = setInterval(() => void reloadLessons(), 4000);
    return () => clearInterval(t);
  }, [working, reloadLessons]);

  if (open !== null) return <LessonEditor id={open} onBack={() => { setOpen(null); void lessons.reload(); }} />;
  if (files.error) return <div className="page"><ErrorNote error={files.error} retry={files.reload} /></div>;
  if (!files.data || !lessons.data) return <div className="page"><Loading rows={6} /></div>;
  const samples = files.data.filter((f) => f.kind === 'sample');
  const books = files.data.filter((f) => f.kind === 'book');

  return (
    <div className="page">
      <div className="page-head">
        <div>
          <h1>Lesson slides</h1>
          <p className="sub">Give KruBook a sample deck and the course book; it writes a new lesson from the book pages in the same format, ready to check and download as PowerPoint.</p>
        </div>
      </div>
      {status.data && !status.data.ready && (
        <Notice tone="warn">Writing lessons needs an API key for {status.data.providerLabel}. {me.role === 'admin' ? 'Add it on the Accounts page (“AI for lesson slides” at the bottom).' : 'Ask the administrator to add one.'} You can already upload your sample decks and books.</Notice>
      )}
      {status.data?.demo && <Notice>Demo mode: lessons are copies of the sample deck, not written from the book.</Notice>}
      <div className="stack">
        <Library samples={samples} books={books} reload={files.reload} />
        <NewLesson samples={samples} books={books} ready={!!status.data?.ready} model={status.data?.model ?? ''} onStarted={() => void lessons.reload()} />
        <Lessons lessons={lessons.data} reload={lessons.reload} onOpen={setOpen} />
      </div>
    </div>
  );
}

function Library({ samples, books, reload }: { samples: SlideFile[]; books: SlideFile[]; reload: () => void }) {
  const input = useRef<HTMLInputElement>(null);
  const { busy, run } = useAction();
  const [del, setDel] = useState<SlideFile | null>(null);
  const toast = useToast();
  const upload = async (list: FileList | null) => {
    if (!list?.length) return;
    for (const f of Array.from(list)) {
      if (f.size > 60 * 1024 * 1024) { toast(`${f.name} is larger than 60 MB.`, 'bad'); continue; }
      const raw = await f.arrayBuffer();
      await run(() => api(`/slides/files?${new URLSearchParams({ filename: f.name })}`, { raw, headers: { 'content-type': 'application/octet-stream' } }), `${f.name} uploaded`);
    }
    if (input.current) input.current.value = '';
    reload();
  };
  const rename = async (f: SlideFile) => {
    const t = window.prompt('Name', f.title);
    if (t && t.trim() && t !== f.title) await run(() => api(`/slides/files/${f.id}`, { method: 'PUT', body: { title: t } }), 'Renamed').then(reload);
  };
  const list = (items: SlideFile[], empty: string) => items.length ? (
    <ul className="ledger">{items.map((f) => (
      <li key={f.id}>
        <span className="grow"><b>{f.title}</b><div className="faint xs">{f.filename} · {size(f.size)} · {f.kind === 'book' ? `${f.pages} pages${f.lessons?.length ? ` · ${f.lessons.length} lessons` : ''}` : `${f.slideCount} slides`}</div></span>
        <Menu items={[
          { label: 'Download', onSelect: () => run(() => download(`/slides/files/${f.id}/download`)) },
          { label: 'Rename…', onSelect: () => void rename(f) },
          { label: 'Delete…', danger: true, onSelect: () => setDel(f) },
        ]} />
      </li>
    ))}</ul>
  ) : <p className="faint small" style={{ padding: '12px 18px', margin: 0 }}>{empty}</p>;

  return (
    <section className="panel">
      <div className="panel-head">
        <h2>Sample decks and books</h2>
        <button className="btn" disabled={busy} onClick={() => input.current?.click()}><Icon name="upload" />Upload .pptx or .pdf</button>
        <input ref={input} type="file" multiple hidden aria-label="Sample deck or book to upload" accept=".pptx,.pdf" onChange={(e) => void upload(e.target.files)} />
      </div>
      <div className="split-2">
        <div><h3 className="small" style={{ padding: '12px 18px 0', margin: 0 }}>Sample decks (.pptx)</h3>{list(samples, 'Upload a finished lesson deck. Its slides become the layouts for new lessons — the deck with the most kinds of slides (code, tables, bullets) works best.')}</div>
        <div><h3 className="small" style={{ padding: '12px 18px 0', margin: 0 }}>Books (.pdf)</h3>{list(books, 'Upload the course book as a PDF, up to 60 MB.')}</div>
      </div>
      {del && <Confirm title={`Delete ${del.title}?`} body={del.kind === 'sample' ? 'Lessons made from this sample deck can no longer be downloaded.' : 'Lessons already written from this book are kept.'} confirmLabel="Delete" danger
        onConfirm={() => run(() => api(`/slides/files/${del.id}`, { method: 'DELETE' }), 'Deleted').then(reload)} onClose={() => setDel(null)} />}
    </section>
  );
}

function NewLesson({ samples, books, ready, model, onStarted }: { samples: SlideFile[]; books: SlideFile[]; ready: boolean; model: string; onStarted: () => void }) {
  const empty = { fromPage: '', toPage: '', lessonNo: '', title: '', nextTitle: '', notes: '' };
  const [f, setF] = useState({ sampleId: '', bookId: '', lesson: '', ...empty });
  const [adjust, setAdjust] = useState(false);
  const { busy, run } = useAction();
  const set = (k: keyof typeof f) => (e: { target: { value: string } }) => setF({ ...f, [k]: e.target.value });
  const sampleId = f.sampleId || String(samples[0]?.id ?? '');
  const bookId = f.bookId || String(books[0]?.id ?? '');
  const book = books.find((b) => String(b.id) === bookId);
  const found = book?.lessons ?? [];
  const picked = found.find((l) => String(l.no) === f.lesson);
  const manual = !found.length || f.lesson === 'pages' || adjust;
  const pages = f.fromPage && f.toPage ? Number(f.toPage) - Number(f.fromPage) + 1 : 0;
  // Choosing a lesson of the book fills in its pages, number, title and the next lesson.
  const pick = (value: string) => {
    const l = found.find((x) => String(x.no) === value);
    const next = l && found[found.indexOf(l) + 1];
    setAdjust(false);
    setF({ ...f, ...empty, notes: f.notes, lesson: value, ...(l ? { fromPage: String(l.from), toPage: String(l.to), lessonNo: String(l.no), title: l.title, nextTitle: next?.title ?? '' } : {}) });
  };
  const submit = async () => {
    const r = await run(() => api('/slides/lessons', { method: 'POST', body: { ...f, sampleId: Number(sampleId), bookId: Number(bookId), fromPage: Number(f.fromPage), toPage: Number(f.toPage) } }), 'Writing the lesson — this takes a minute or two');
    if (r) { setF({ ...f, ...empty, lesson: '' }); setAdjust(false); onStarted(); }
  };
  return (
    <section className="panel">
      <div className="panel-head"><h2>Write a lesson</h2></div>
      <div className="panel-body stack">
        {!samples.length || !books.length ? <p className="faint small" style={{ margin: 0 }}>Upload a sample deck and a book first.</p> : (<>
          <div className="form-grid">
            <Field label="Sample deck"><select id="sl-sample" value={sampleId} onChange={set('sampleId')}>{samples.map((s) => <option key={s.id} value={s.id}>{s.title}</option>)}</select></Field>
            <Field label="Book"><select id="sl-book" value={bookId} onChange={(e) => { setF({ ...f, ...empty, bookId: e.target.value, lesson: '' }); setAdjust(false); }}>{books.map((b) => <option key={b.id} value={b.id}>{b.title}</option>)}</select></Field>
            {found.length > 0 && (
              <Field label="Lesson">
                <select id="sl-lesson" value={f.lesson} onChange={(e) => pick(e.target.value)}>
                  <option value="">Choose a lesson…</option>
                  {found.map((l) => <option key={l.no} value={l.no}>Lesson {l.no}: {l.title}</option>)}
                  <option value="pages">Other pages…</option>
                </select>
              </Field>
            )}
          </div>
          {picked && !adjust && (
            <p className="small" style={{ margin: 0 }}>
              Pages {picked.from}–{picked.to} of the PDF · lesson {f.lessonNo} “{f.title}”{f.nextTitle ? <> · next: “{f.nextTitle}”</> : null}{' '}
              <button type="button" className="btn ghost sm" onClick={() => setAdjust(true)}>Change</button>
            </p>
          )}
          {manual && (<>
            {!found.length && <p className="faint xs" style={{ margin: 0 }}>No lesson headings were found in this book, so choose its pages yourself.</p>}
            <div className="form-grid">
              <Field label="From page" hint={book ? `PDF page, 1–${book.pages}` : undefined}><input id="sl-from" type="number" min={1} max={book?.pages ?? undefined} value={f.fromPage} onChange={set('fromPage')} /></Field>
              <Field label="To page"><input id="sl-to" type="number" min={1} max={book?.pages ?? undefined} value={f.toPage} onChange={set('toPage')} /></Field>
              <Field label="Lesson number" hint="As it should appear, e.g. ៣ or 3."><input id="sl-no" value={f.lessonNo} onChange={set('lessonNo')} /></Field>
            </div>
            <div className="form-grid">
              <Field label="Lesson title (optional)" hint="Taken from the book if left empty."><input id="sl-title" value={f.title} onChange={set('title')} placeholder="e.g. Control Statements" /></Field>
              <Field label="Next lesson (optional)" hint="Named on the closing slide."><input id="sl-next" value={f.nextTitle} onChange={set('nextTitle')} placeholder="e.g. Loops" /></Field>
            </div>
          </>)}
          <Field label="Anything else (optional)"><textarea id="sl-notes" rows={2} value={f.notes} onChange={set('notes')} placeholder="e.g. Add one more code example for switch; keep it to about 20 slides." /></Field>
          <div className="row">
            <button className="btn primary" disabled={busy || !ready || !f.fromPage || !f.toPage || !f.lessonNo.trim()} onClick={() => void submit()}><Icon name="edit" />Write lesson</button>
            <span className="faint xs">
              {manual ? 'Use the page numbers your PDF viewer shows, which can differ from the numbers printed in the book.' : ''}
              {pages > 0 && ` ${pages} page${pages === 1 ? '' : 's'}.${estimate(model, pages)}`}
            </span>
          </div>
        </>)}
      </div>
    </section>
  );
}

function Lessons({ lessons, reload, onOpen }: { lessons: Lesson[]; reload: () => void; onOpen: (id: number) => void }) {
  const { run } = useAction();
  const [del, setDel] = useState<Lesson | null>(null);
  return (
    <section className="panel">
      <div className="panel-head"><h2>Lessons</h2><span className="faint small">{lessons.length}</span></div>
      {lessons.length ? (
        <ul className="ledger">{lessons.map((l) => (
          <li key={l.id}>
            <span className="grow">
              <b>{l.title}</b>{' '}
              {l.status === 'working' ? <Pill tone="accent">writing…</Pill> : l.status === 'failed' ? <Pill tone="bad">failed</Pill> : <Pill tone="ok">{l.slideCount} slides</Pill>}
              <div className="faint xs">Lesson {l.request.lessonNo} · book pages {l.request.fromPage}–{l.request.toPage} · {l.createdAt.slice(0, 16)}{cost(l.usage) ? ` · ${cost(l.usage)}` : ''}</div>
              {l.status === 'failed' && l.error && <div className="small" style={{ color: 'var(--bad)' }}>{l.error}</div>}
            </span>
            {l.status === 'ready' && <button className="btn sm" onClick={() => onOpen(l.id)}>Check and edit</button>}
            {l.status === 'ready' && <button className="btn sm" onClick={() => run(() => download(`/slides/lessons/${l.id}/pptx`))}><Icon name="download" />PowerPoint</button>}
            {l.status !== 'working' && <Menu items={[{ label: 'Delete…', danger: true, onSelect: () => setDel(l) }]} />}
          </li>
        ))}</ul>
      ) : <Empty title="No lessons yet">Lessons you write appear here.</Empty>}
      {del && <Confirm title={`Delete ${del.title}?`} body="The written slides are removed. Your sample deck and book are kept." confirmLabel="Delete" danger
        onConfirm={() => run(() => api(`/slides/lessons/${del.id}`, { method: 'DELETE' }), 'Lesson deleted').then(reload)} onClose={() => setDel(null)} />}
    </section>
  );
}

/** A sample slide's name in lists: its number and first words. */
const slideName = (s: SampleInfo['slides'][number]) => {
  const first = s.slots.find((x) => !x.page && x.lines.join('').trim())?.lines.join(' ') ?? '';
  return `${s.index}. ${first.length > 48 ? first.slice(0, 47) + '…' : first}`;
};

function LessonEditor({ id, onBack }: { id: number; onBack: () => void }) {
  const { data, error, reload } = useApi<Lesson>(`/slides/lessons/${id}`);
  const sample = useApi<SampleInfo>(data?.sampleId ? `/slides/samples/${data.sampleId}` : null);
  const [slides, setSlides] = useState<DeckSlide[] | null>(null);
  const [title, setTitle] = useState('');
  const [dirty, setDirty] = useState(false);
  const { busy, run } = useAction();
  useEffect(() => { if (data) { setSlides(data.slides ?? []); setTitle(data.title); setDirty(false); } }, [data]);

  if (error) return <div className="page"><ErrorNote error={error} retry={reload} /></div>;
  if (!data || !slides || (data.sampleId && !sample.data)) return <div className="page"><Loading rows={8} /></div>;
  const info = sample.data;
  const change = (next: DeckSlide[]) => { setSlides(next); setDirty(true); };
  const save = () => run(() => api(`/slides/lessons/${id}`, { method: 'PUT', body: { title, slides } }), 'Saved').then((r) => { if (r) setDirty(false); return r; });
  const setLines = (i: number, slot: number, text: string) => change(slides.map((s, j) => j !== i ? s : {
    ...s, slots: [...s.slots.filter((b) => b.slot !== slot), { slot, lines: text.split('\n') }].sort((a, b) => a.slot - b.slot),
  }));
  const move = (i: number, d: number) => { const n = [...slides]; const [x] = n.splice(i, 1); n.splice(i + d, 0, x!); change(n); };
  const blank = (sampleNo: number): DeckSlide => ({ sample: sampleNo, slots: (info?.slides.find((s) => s.index === sampleNo)?.slots ?? []).filter((b) => !b.page).map((b) => ({ slot: b.slot, lines: b.lines })) });

  return (
    <div className="page">
      <div className="page-head">
        <div>
          <button className="btn sm ghost" onClick={() => { if (!dirty || window.confirm('Leave without saving your changes?')) onBack(); }}><Icon name="left" />All lessons</button>
          <h1 style={{ marginTop: 8 }}>{data.title}</h1>
          <p className="sub">{slides.length} slides. Each slide copies a slide of the sample deck; edit the words box by box. One line per bullet or code line; an empty box is left out of the slide.</p>
        </div>
        <div className="row">
          <button className="btn" disabled={busy || !dirty} onClick={() => void save()}>Save</button>
          <button className="btn primary" disabled={busy || !info} onClick={() => run(async () => { if (dirty) await api(`/slides/lessons/${id}`, { method: 'PUT', body: { title, slides } }); setDirty(false); await download(`/slides/lessons/${id}/pptx`); })}><Icon name="download" />Download PowerPoint</button>
        </div>
      </div>
      {!info && <Notice tone="warn">The sample deck for this lesson was deleted, so it cannot be downloaded. Upload the sample again and write the lesson again.</Notice>}
      <div className="stack">
        <Field label="Lesson name (also the file name)"><input id="sl-edit-title" value={title} onChange={(e) => { setTitle(e.target.value); setDirty(true); }} /></Field>
        {slides.map((s, i) => {
          const layout = info?.slides.find((x) => x.index === s.sample);
          return (
            <section key={i} className="panel" aria-label={`Slide ${i + 1}`}>
              <div className="panel-head">
                <h2>Slide {i + 1}</h2>
                <div className="row">
                  {info && <select aria-label={`Layout of slide ${i + 1}`} value={s.sample} onChange={(e) => change(slides.map((x, j) => j === i ? blank(Number(e.target.value)) : x))}>
                    {info.slides.map((x) => <option key={x.index} value={x.index}>Like sample slide {slideName(x)}</option>)}
                  </select>}
                  <Menu items={[
                    { label: 'Move up', hidden: i === 0, onSelect: () => move(i, -1) },
                    { label: 'Move down', hidden: i === slides.length - 1, onSelect: () => move(i, 1) },
                    { label: 'Duplicate', onSelect: () => change([...slides.slice(0, i + 1), structuredClone(s), ...slides.slice(i + 1)]) },
                    { label: 'Delete slide', danger: true, onSelect: () => change(slides.filter((_, j) => j !== i)) },
                  ]} />
                </div>
              </div>
              <div className="panel-body stack">
                {(layout?.slots ?? []).filter((b) => !b.page).map((b) => {
                  const cur = s.slots.find((x) => x.slot === b.slot)?.lines.join('\n') ?? '';
                  const over = cur.length > b.chars * 1.3 + 10;
                  return (
                    <label key={b.slot} className="stack" style={{ gap: 4 }}>
                      <span className="faint xs">Box {b.slot} · in the sample: “{b.lines.join(' / ').slice(0, 80)}”{over && <b style={{ color: 'var(--warn)' }}> · longer than the sample box ({cur.length} of about {b.chars} characters), may not fit</b>}</span>
                      <textarea rows={Math.min(14, Math.max(1, b.lines.length, cur.split('\n').length))} value={cur} onChange={(e) => setLines(i, b.slot, e.target.value)} className={b.lines.length > 1 ? 'mono' : undefined} />
                    </label>
                  );
                })}
              </div>
            </section>
          );
        })}
        {info && <div className="row"><select id="sl-add" defaultValue="" aria-label="Add a slide like" onChange={(e) => { if (e.target.value) { change([...slides, blank(Number(e.target.value))]); e.target.value = ''; } }}>
          <option value="">Add a slide like…</option>
          {info.slides.map((x) => <option key={x.index} value={x.index}>sample slide {slideName(x)}</option>)}
        </select></div>}
      </div>
    </div>
  );
}
