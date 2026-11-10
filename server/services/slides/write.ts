import Anthropic from '@anthropic-ai/sdk';
import { PDFDocument } from 'pdf-lib';
import { AppError } from '../../db.ts';
import type { DeckSlide, SampleInfo } from './pptx.ts';

// Writes a lesson's slide text from book pages, in the shape of a sample deck. The book pages go
// to Claude as a PDF (it reads the page images, so Khmer text that PDF text extraction garbles is
// read correctly); the sample deck goes as a list of its slides and their text boxes.

export interface LessonAsk {
  lessonNo: string;
  title?: string | null;
  nextTitle?: string | null;
  notes?: string | null;
  fromPage: number;
  toPage: number;
}
export interface Written { slides: DeckSlide[]; usage: { input: number; output: number; model: string } }
export type Writer = (input: { pdf: Buffer; sample: SampleInfo; ask: LessonAsk; signal?: AbortSignal }) => Promise<Written>;

export const MAX_PAGES = 60;

/** The PDF's page count, or a clear error when it cannot be read. */
export async function pdfPageCount(buf: Buffer | Uint8Array): Promise<number> {
  try {
    const doc = await PDFDocument.load(buf, { ignoreEncryption: true, updateMetadata: false });
    return doc.getPageCount();
  } catch {
    throw new AppError(422, 'That file is not a PDF we can read.');
  }
}

/** A new PDF holding pages `from`..`to` (1-based, inclusive) of the book. */
export async function pdfPages(buf: Buffer | Uint8Array, from: number, to: number): Promise<Buffer> {
  const src = await PDFDocument.load(buf, { ignoreEncryption: true, updateMetadata: false });
  const count = src.getPageCount();
  if (!(from >= 1 && to >= from && to <= count)) throw new AppError(422, `Choose pages between 1 and ${count}.`);
  if (to - from + 1 > MAX_PAGES) throw new AppError(422, `Choose at most ${MAX_PAGES} pages for one lesson.`);
  const out = await PDFDocument.create();
  const pages = await out.copyPages(src, Array.from({ length: to - from + 1 }, (_, i) => from - 1 + i));
  for (const p of pages) out.addPage(p);
  return Buffer.from(await out.save());
}

/** The sample deck as the model sees it: every slide and its numbered text boxes. */
export function describeSample(sample: SampleInfo): string {
  return sample.slides.map((s) => {
    const boxes = s.slots.map((b) => b.page
      ? `  [${b.slot}] page number (filled in automatically, leave it out)`
      : `  [${b.slot}] (${b.lines.length > 1 ? `${b.lines.length} lines, ` : ''}${b.chars} characters) ${b.lines.join(' ⏎ ')}`);
    return `Sample slide ${s.index}:\n${boxes.join('\n')}`;
  }).join('\n\n');
}

const SYSTEM = `You write lesson slides for a university teacher. You are given a sample deck the teacher already uses and some pages from a textbook. Write a new lesson deck that teaches the content of those book pages, built only from the sample deck's slides.

How the deck is built:
- Each slide you write copies one sample slide (its background, colours, fonts, icons and box positions) and replaces the text in its numbered text boxes. Pick the sample slide whose layout fits the content: a slide with bullet boxes for points, a slide with a code box for code, a slide with table cells for a table, and the cover, agenda, summary and closing slides for those parts. A sample slide can be used as many times as needed.
- Give new text for every box you want to keep. A box you leave out is removed along with the shapes that belong to it (a bullet dot, a table row background). Use this to show fewer bullets or table rows than the sample slide has, but always keep the slide's eyebrow, title and footer boxes.
- Text must fit: keep each box close to the sample box's character count, and never more than about 1.3 times it. A box with several lines in the sample (a code box) takes several lines; give one entry per line and keep the number of lines close to the sample's.
- Page-number boxes are filled in automatically; leave them out.

What to write:
- Follow the sample deck's flow and conventions: cover, agenda of the lesson's main parts, then sections numbered the way the sample numbers them, content and code slides, a summary of what was learned, and the closing slide naming the next lesson.
- Write in the same language and register as the sample deck. If it is in Khmer with English technical terms, write Khmer with the English terms kept, using the same punctuation (for example ៖ before a list) and the same numerals for lesson numbers.
- Keep the footer text pattern of the sample, with this lesson's number.
- Teach what the book pages say. Keep their definitions, rules and examples, correct obvious typing mistakes in code, and keep code examples short enough to fit the code box. Do not add topics the pages do not cover.
- Aim for roughly as many slides as the sample deck has for a similar amount of material.`;

const SCHEMA = {
  type: 'object',
  properties: {
    slides: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          sample: { type: 'integer', description: 'Number of the sample slide this slide copies.' },
          slots: {
            type: 'array',
            items: {
              type: 'object',
              properties: {
                slot: { type: 'integer', description: 'Box number on that sample slide.' },
                lines: { type: 'array', items: { type: 'string' }, description: 'The new text, one entry per line.' },
              },
              required: ['slot', 'lines'],
              additionalProperties: false,
            },
          },
        },
        required: ['sample', 'slots'],
        additionalProperties: false,
      },
    },
  },
  required: ['slides'],
  additionalProperties: false,
} as const;

/** Keeps only slides and boxes the sample really has, and drops page numbers. */
export function tidy(sample: SampleInfo, slides: DeckSlide[]): DeckSlide[] {
  const out: DeckSlide[] = [];
  for (const s of slides ?? []) {
    const src = sample.slides.find((x) => x.index === s.sample);
    if (!src) continue;
    const slots = (s.slots ?? [])
      .filter((b) => src.slots.some((x) => x.slot === b.slot && !x.page))
      .map((b) => ({ slot: b.slot, lines: (b.lines ?? []).map((l) => String(l).slice(0, 400)).slice(0, 40) }));
    out.push({ sample: s.sample, slots });
  }
  return out;
}

export function askText(ask: LessonAsk, sample: SampleInfo): string {
  return [
    `Sample deck (${sample.slideCount} slides):`,
    describeSample(sample),
    '',
    `The attached PDF is pages ${ask.fromPage}–${ask.toPage} of the book.`,
    `Write lesson number ${ask.lessonNo}${ask.title ? `, titled "${ask.title}"` : ' (take the title from the book pages)'}.`,
    ask.nextTitle ? `The next lesson is "${ask.nextTitle}"; name it on the closing slide.` : 'If the pages show what the next lesson is, name it on the closing slide; otherwise keep the closing slide general.',
    ask.notes ? `The teacher adds: ${ask.notes}` : '',
  ].filter(Boolean).join('\n');
}

/** Parses the model's JSON answer into slides the sample deck can build. */
function readAnswer(text: string, sample: SampleInfo, who: string): DeckSlide[] {
  let parsed: { slides: DeckSlide[] };
  try {
    parsed = JSON.parse(text.replace(/^```(?:json)?\s*|\s*```$/g, ''));
  } catch {
    throw new AppError(502, `${who} sent an answer we could not read. Try again.`);
  }
  const slides = tidy(sample, parsed?.slides);
  if (!slides.length) throw new AppError(502, `${who} did not write any slides. Try again.`);
  return slides;
}

/** Claude: one call with the book pages and the sample deck. */
export function claudeWriter(apiKey: string, model: string): Writer {
  const client = new Anthropic({ apiKey, maxRetries: 2, timeout: 15 * 60 * 1000 });
  return async ({ pdf, sample, ask, signal }) => {
    // Streamed because the answer is long; refusals fall back to another model on the server.
    // Server-side refusal fallback is offered for Opus and Sonnet, not Haiku.
    const fallback = /haiku/.test(model) ? {} : { betas: ['server-side-fallback-2026-07-01'], fallbacks: 'default' as const };
    const stream = client.beta.messages.stream({
      model,
      max_tokens: 64000,
      ...fallback,
      thinking: { type: 'adaptive' },
      output_config: { effort: 'high', format: { type: 'json_schema', schema: SCHEMA as any } },
      system: SYSTEM,
      messages: [{
        role: 'user',
        content: [
          { type: 'document', source: { type: 'base64', media_type: 'application/pdf', data: pdf.toString('base64') } },
          { type: 'text', text: askText(ask, sample) },
        ],
      }],
    }, { signal });
    const msg = await stream.finalMessage();
    if (msg.stop_reason === 'refusal') throw new AppError(422, 'Claude declined to write slides from these pages. Try a different page range.');
    if (msg.stop_reason === 'max_tokens') throw new AppError(422, 'The lesson was too long to finish in one go. Choose fewer pages and try again.');
    const text = msg.content.map((b) => (b.type === 'text' ? b.text : '')).join('');
    return { slides: readAnswer(text, sample, 'Claude'), usage: { input: msg.usage.input_tokens, output: msg.usage.output_tokens, model } };
  };
}

/**
 * Google Gemini over its REST API: one generateContent call with the book pages inline. Gemini
 * reads the PDF pages too, so Khmer comes through. `fetchFn` is replaceable for tests.
 */
export function geminiWriter(apiKey: string, model: string, fetchFn: typeof fetch = fetch): Writer {
  return async ({ pdf, sample, ask, signal }) => {
    const url = `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}:generateContent`;
    const body = (withSchema: boolean) => JSON.stringify({
      systemInstruction: { parts: [{ text: SYSTEM }] },
      contents: [{ role: 'user', parts: [{ inlineData: { mimeType: 'application/pdf', data: pdf.toString('base64') } }, { text: askText(ask, sample) + `\n\nAnswer with JSON only, in this shape: {"slides":[{"sample":3,"slots":[{"slot":1,"lines":["..."]}]}]}` }] }],
      generationConfig: { responseMimeType: 'application/json', maxOutputTokens: 65536, ...(withSchema ? { responseJsonSchema: SCHEMA } : {}) },
    });
    const call = (withSchema: boolean) => fetchFn(url, {
      method: 'POST', headers: { 'content-type': 'application/json', 'x-goog-api-key': apiKey }, body: body(withSchema),
      signal: signal ?? AbortSignal.timeout(15 * 60 * 1000),
    });
    let res = await call(true);
    let json: any = await res.json().catch(() => null);
    // Older Gemini models do not take a JSON schema; ask again with JSON mode alone.
    if (res.status === 400 && /responseJsonSchema|response_json_schema/i.test(JSON.stringify(json))) {
      res = await call(false);
      json = await res.json().catch(() => null);
    }
    if (!res.ok) {
      const message = json?.error?.message ?? `HTTP ${res.status}`;
      throw Object.assign(new Error(`Gemini: ${message}`), { status: res.status, message });
    }
    const cand = json?.candidates?.[0];
    if (!cand) throw new AppError(422, 'Gemini declined to write slides from these pages (blocked by its safety filter). Try a different page range.');
    if (cand.finishReason === 'MAX_TOKENS') throw new AppError(422, 'The lesson was too long to finish in one go. Choose fewer pages and try again.');
    if (cand.finishReason && !['STOP', 'FINISH_REASON_UNSPECIFIED'].includes(cand.finishReason)) throw new AppError(422, `Gemini stopped early (${cand.finishReason}). Try a different page range.`);
    const text = (cand.content?.parts ?? []).filter((p: any) => !p.thought).map((p: any) => p.text ?? '').join('');
    const u = json.usageMetadata ?? {};
    return { slides: readAnswer(text, sample, 'Gemini'), usage: { input: u.promptTokenCount ?? 0, output: (u.candidatesTokenCount ?? 0) + (u.thoughtsTokenCount ?? 0), model } };
  };
}

/**
 * A stand-in writer for tests and demos without an API key: it copies the sample deck's slides
 * and marks the text, so the whole flow (draft, edit, download) can be tried for free.
 */
export const sampleCopyWriter: Writer = async ({ sample, ask }) => ({
  slides: sample.slides.map((s) => ({
    sample: s.index,
    slots: s.slots.filter((b) => !b.page).map((b) => ({ slot: b.slot, lines: b.slot === 1 ? [`Lesson ${ask.lessonNo}`] : b.lines })),
  })),
  usage: { input: 0, output: 0, model: 'sample-copy' },
});
