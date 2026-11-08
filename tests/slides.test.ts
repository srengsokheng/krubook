import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';
import JSZip from 'jszip';
import { PDFDocument } from 'pdf-lib';
import type { DB } from '../server/db.ts';
import { createApp, createHolder } from '../server/app.ts';
import { addAccount, createUser } from '../server/auth.ts';
import { buildDeck, fillSlide, readSample } from '../server/services/slides/pptx.ts';
import { askText, describeSample, pdfPages, tidy, type Writer } from '../server/services/slides/write.ts';
import { failInterrupted, setWriter, settled } from '../server/services/slides/lessons.ts';
import { exportBackup, loadBackup } from '../server/services/backup.ts';
import { bookPdf, CODE, CONTENT, sampleDeck } from './fixtures/slides.ts';


describe('reading and building decks', () => {
  it('lists each sample slide with its numbered text boxes', async () => {
    const s = await readSample(await sampleDeck());
    expect(s.slideCount).toBe(3);
    expect(s.slides[1]!.slots.map((x) => x.lines[0])).toEqual(['Variables', 'A variable stores a value:', 'First point', 'Second point', 'Third point', 'C++ · Lesson 2', '01']);
    expect(s.slides[1]!.slots[6]).toMatchObject({ slot: 7, page: true });
    expect(s.slides[2]!.slots[1]).toMatchObject({ lines: ['int a = 1;', 'cout << a;'], chars: 21 });
    const text = describeSample(s);
    expect(text).toContain('Sample slide 2:');
    expect(text).toContain('[7] page number');
    expect(text).toContain('[2] (2 lines, 21 characters) int a = 1; ⏎ cout << a;');
  });

  it('replaces text, keeps the formatting, drops empty bullets with their dots and renumbers pages', () => {
    const out = fillSlide(CONTENT, new Map([[1, ['If & else']], [2, ['Choose a path:']], [3, ['<one>']], [6, ['C++ · Lesson 3']]]), 3);
    expect(out).toContain('<a:t>If &amp; else</a:t>');
    expect(out).toContain('<a:t>&lt;one&gt;</a:t>');
    expect(out).toContain('<a:rPr lang="en-US" b="1"/><a:t>Choose a path:</a:t>');
    expect(out).not.toContain('Second point');
    expect(out).not.toContain('name="S6"'); // the dot beside the removed bullet
    expect(out).not.toContain('name="S8"');
    expect(out).toContain('name="S4"'); // the dot beside the kept bullet
    expect(out).toContain('<a:t>04</a:t>');
  });

  it('treats only the last number box as the page number, not table cells holding numbers', async () => {
    const xml = CONTENT.replace('<a:t>First point</a:t>', '<a:t>4</a:t>');
    const s = await readSample(await sampleDeck());
    expect(s.slides[1]!.slots.filter((x) => x.page).map((x) => x.slot)).toEqual([7]);
    const out = fillSlide(xml, new Map([[1, ['T']], [3, ['8']]]), 5);
    expect(out).toContain('<a:t>8</a:t>');
    expect(out).toContain('<a:t>06</a:t>');
  });

  it('writes several lines into a code box', () => {
    const out = fillSlide(CODE, new Map([[1, ['Loop']], [2, ['for (int i = 0; i < 3; i++)', '', '  cout << i;']]]), 0);
    expect(out.match(/<a:p>/g)!.length).toBe(4);
    expect(out).toContain('<a:t>  cout &lt;&lt; i;</a:t>');
  });

  it('builds a deck from the sample, without the sample slides or speaker notes', async () => {
    const buf = await buildDeck(await sampleDeck(), [
      { sample: 1, slots: [{ slot: 1, lines: ['C++'] }, { slot: 2, lines: ['Lesson 3'] }] },
      { sample: 2, slots: [{ slot: 1, lines: ['A'] }] },
      { sample: 2, slots: [{ slot: 1, lines: ['B'] }] },
      { sample: 3, slots: [{ slot: 1, lines: ['C'] }] },
    ]);
    const z = await JSZip.loadAsync(buf);
    const names = Object.keys(z.files);
    expect(names.filter((n) => /^ppt\/slides\/slide\d+\.xml$/.test(n)).sort()).toEqual(['ppt/slides/slide1.xml', 'ppt/slides/slide2.xml', 'ppt/slides/slide3.xml', 'ppt/slides/slide4.xml']);
    expect(names.some((n) => n.includes('notesSlide'))).toBe(false);
    const pres = await z.file('ppt/presentation.xml')!.async('string');
    expect(pres.match(/<p:sldId /g)!.length).toBe(4);
    const rels = await z.file('ppt/_rels/presentation.xml.rels')!.async('string');
    expect(rels).toContain('slideMaster1.xml');
    expect(rels.match(/relationships\/slide"/g)!.length).toBe(4);
    const types = await z.file('[Content_Types].xml')!.async('string');
    expect(types.match(/slide\+xml/g)!.length).toBe(4);
    expect(types).not.toContain('notesSlide');
    expect(await z.file('ppt/slides/_rels/slide1.xml.rels')!.async('string')).not.toContain('notesSlide');
    expect(await z.file('docProps/app.xml')!.async('string')).toContain('<Slides>4</Slides>');
    const s3 = await z.file('ppt/slides/slide3.xml')!.async('string');
    expect(s3).toContain('<a:t>B</a:t>');
    expect(s3).toContain('<a:t>02</a:t>'); // sample slide 2 showed 01; it is now the third slide
    await expect(buildDeck(await sampleDeck(), [{ sample: 9, slots: [] }])).rejects.toThrow(/sample slide 9/);
  });

  it('rejects files that are not decks', async () => {
    await expect(readSample(Buffer.from('nope'))).rejects.toThrow(/not a PowerPoint/);
  });
});

describe('the writer', () => {
  it('cuts the book to the chosen pages', async () => {
    const part = await pdfPages(await bookPdf(10), 3, 5);
    expect((await PDFDocument.load(part)).getPageCount()).toBe(3);
    await expect(pdfPages(await bookPdf(4), 3, 6)).rejects.toThrow(/between 1 and 4/);
  });

  it('keeps only slides and boxes the sample has', async () => {
    const s = await readSample(await sampleDeck());
    expect(tidy(s, [{ sample: 2, slots: [{ slot: 1, lines: ['x'] }, { slot: 7, lines: ['99'] }, { slot: 40, lines: ['y'] }] }, { sample: 8, slots: [] }]))
      .toEqual([{ sample: 2, slots: [{ slot: 1, lines: ['x'] }] }]);
  });

  it('tells Claude the pages, lesson and next lesson', async () => {
    const s = await readSample(await sampleDeck());
    const t = askText({ lessonNo: '៣', title: 'Control Statements', nextTitle: 'Loops', fromPage: 19, toPage: 27 }, s);
    expect(t).toContain('pages 19–27');
    expect(t).toContain('lesson number ៣, titled "Control Statements"');
    expect(t).toContain('"Loops"');
  });
});

describe('lesson slides API', () => {
  let db: DB, dir: string, server: Server, base: string, cookie = '', other = '';
  let calls: any[] = [];
  const writer: Writer = async ({ pdf, sample, ask }) => {
    calls.push({ pages: (await PDFDocument.load(pdf)).getPageCount(), ask, slides: sample.slideCount });
    return { slides: [{ sample: 1, slots: [{ slot: 1, lines: ['C++'] }, { slot: 2, lines: [`Lesson ${ask.lessonNo}`] }] }, { sample: 2, slots: [{ slot: 1, lines: ['Ifs'] }] }], usage: { input: 10, output: 20, model: 'test' } };
  };
  async function login(email: string, password: string) {
    const r = await fetch(`${base}/auth/login`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ email, password }) });
    return r.headers.get('set-cookie')!.split(';')[0]!;
  }
  const call = (c: string, method: string, path: string, body?: unknown) => fetch(base + path, { method, headers: { 'content-type': 'application/json', cookie: c }, body: body === undefined ? undefined : JSON.stringify(body) });
  const upload = (c: string, name: string, data: Buffer) => fetch(`${base}/slides/files?filename=${encodeURIComponent(name)}`, { method: 'POST', headers: { 'content-type': 'application/octet-stream', cookie: c }, body: new Uint8Array(data) });

  beforeEach(async () => {
    delete process.env.ANTHROPIC_API_KEY;
    calls = [];
    dir = mkdtempSync(join(tmpdir(), 'krubook-slides-'));
    const holder = createHolder(join(dir, 's.sqlite'));
    db = holder.db;
    addAccount(db, 'me@example.test', 'Me', 'me-pass-123');
    createUser(db, 'other@example.test', 'Other', 'other-pass-1');
    server = createApp(holder).listen(0);
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}/api`;
    cookie = await login('me@example.test', 'me-pass-123');
    other = await login('other@example.test', 'other-pass-1');
  });
  afterEach(() => { setWriter(null); server.close(); db.close(); rmSync(dir, { recursive: true, force: true }); });

  it('writes a lesson from book pages, lets you edit it and downloads it as PowerPoint', async () => {
    const sample = await (await upload(cookie, 'CPP Lesson 2.pptx', await sampleDeck())).json();
    expect(sample).toMatchObject({ kind: 'sample', title: 'CPP Lesson 2', slideCount: 3 });
    const book = await (await upload(cookie, 'Book.pdf', await bookPdf(12))).json();
    expect(book).toMatchObject({ kind: 'book', pages: 12 });
    expect((await upload(cookie, 'notes.txt', Buffer.from('x'))).status).toBe(422);
    expect((await (await call(cookie, 'GET', `/slides/samples/${sample.id}`)).json()).slides).toHaveLength(3);

    // Without an API key nothing is written.
    expect(await (await call(cookie, 'GET', '/slides/status')).json()).toMatchObject({ ready: false });
    const ask = { sampleId: sample.id, bookId: book.id, lessonNo: '3', title: 'Control Statements', nextTitle: 'Loops', fromPage: 4, toPage: 9 };
    const noKey = await call(cookie, 'POST', '/slides/lessons', ask);
    expect(noKey.status).toBe(409);
    expect((await noKey.json()).details.code).toBe('NO_API_KEY');

    setWriter(writer);
    expect((await call(cookie, 'POST', '/slides/lessons', { ...ask, toPage: 13 })).status).toBe(422);
    const started = await (await call(cookie, 'POST', '/slides/lessons', ask)).json();
    expect(started).toMatchObject({ status: 'working', title: 'Control Statements' });
    await settled();
    expect(calls).toEqual([{ pages: 6, slides: 3, ask: expect.objectContaining({ lessonNo: '3', fromPage: 4, toPage: 9, nextTitle: 'Loops' }) }]);
    const lesson = await (await call(cookie, 'GET', `/slides/lessons/${started.id}`)).json();
    expect(lesson).toMatchObject({ status: 'ready', slideCount: 2, usage: { input: 10, output: 20 } });
    expect(lesson.slides[1]).toEqual({ sample: 2, slots: [{ slot: 1, lines: ['Ifs'] }] });

    const edited = await (await call(cookie, 'PUT', `/slides/lessons/${started.id}`, { title: 'L3', slides: [...lesson.slides, { sample: 3, slots: [{ slot: 2, lines: ['int x;'] }] }] })).json();
    expect(edited).toMatchObject({ title: 'L3', slideCount: 3 });
    expect((await call(cookie, 'PUT', `/slides/lessons/${started.id}`, { slides: [{ sample: 7, slots: [] }] })).status).toBe(422);

    const res = await call(cookie, 'GET', `/slides/lessons/${started.id}/pptx`);
    expect(res.status).toBe(200);
    expect(res.headers.get('content-disposition')).toContain('L3.pptx');
    const z = await JSZip.loadAsync(Buffer.from(await res.arrayBuffer()));
    expect(await z.file('ppt/slides/slide3.xml')!.async('string')).toContain('<a:t>int x;</a:t>');

    // Private to the teacher who made them.
    expect((await call(other, 'GET', `/slides/lessons/${started.id}`)).status).toBe(404);
    expect((await call(other, 'GET', `/slides/files/${book.id}/download`)).status).toBe(404);
    expect(await (await call(other, 'GET', '/slides/files')).json()).toEqual([]);

    // Part of the backup.
    const b = exportBackup(db);
    expect(b.tables.slide_files).toHaveLength(2);
    expect(b.tables.slide_lessons).toHaveLength(1);
    const restored = loadBackup(JSON.parse(JSON.stringify(b)));
    expect(Buffer.from(restored.db.get('SELECT data FROM slide_files WHERE kind = ?', 'book')!.data).length).toBe(book.size);
    restored.db.close();

    expect((await call(cookie, 'DELETE', `/slides/files/${sample.id}`)).status).toBe(200);
    expect((await call(cookie, 'GET', `/slides/lessons/${started.id}/pptx`)).status).toBe(409);
  });

  it('records why writing failed and marks unfinished lessons after a restart', async () => {
    const sample = await (await upload(cookie, 's.pptx', await sampleDeck())).json();
    const book = await (await upload(cookie, 'b.pdf', await bookPdf(3))).json();
    setWriter(async () => { throw Object.assign(new Error('nope'), { status: 401 }); });
    const l = await (await call(cookie, 'POST', '/slides/lessons', { sampleId: sample.id, bookId: book.id, lessonNo: '1', fromPage: 1, toPage: 3 })).json();
    await settled();
    expect(await (await call(cookie, 'GET', `/slides/lessons/${l.id}`)).json()).toMatchObject({ status: 'failed', error: expect.stringMatching(/API key was refused/) });

    setWriter(() => new Promise(() => {}));
    const stuck = await (await call(cookie, 'POST', '/slides/lessons', { sampleId: sample.id, bookId: book.id, lessonNo: '2', fromPage: 1, toPage: 1 })).json();
    expect(stuck.status).toBe('working');
    expect((await call(cookie, 'PUT', `/slides/lessons/${stuck.id}`, { title: 'x' })).status).toBe(409);
    failInterrupted(db);
    expect(await (await call(cookie, 'GET', `/slides/lessons/${stuck.id}`)).json()).toMatchObject({ status: 'failed', error: expect.stringMatching(/restarted/) });
  });

  it('lets only an administrator set the Claude API key, and never shows it back', async () => {
    expect((await call(other, 'PUT', '/admin/ai-key', { key: 'sk-ant-api03-abcdefghijklmnopqrstuvwxyz' })).status).toBe(403);
    expect((await call(cookie, 'PUT', '/admin/ai-key', { key: 'hello' })).status).toBe(422);
    const set = await (await call(cookie, 'PUT', '/admin/ai-key', { key: ' sk-ant-api03-abcdefghijklmnopqrstuvwxyz ' })).json();
    expect(set).toEqual({ ready: true, source: 'admin', ending: 'wxyz' });
    expect(await (await call(other, 'GET', '/slides/status')).json()).toEqual({ ready: true, source: 'admin', ending: 'wxyz' });
    expect(JSON.stringify(exportBackup(db))).not.toContain('abcdefghij');
    expect(JSON.stringify(db.all('SELECT * FROM audit_log'))).not.toContain('abcdefghij');
    expect(await (await call(cookie, 'DELETE', '/admin/ai-key')).json()).toMatchObject({ ready: false });
  });

  it('can be switched off for an account', async () => {
    db.run(`UPDATE users SET features_off = '["slides"]' WHERE email = 'other@example.test'`);
    const r = await call(other, 'GET', '/slides/files');
    expect(r.status).toBe(403);
    expect((await r.json()).details.feature).toBe('slides');
  });
});
