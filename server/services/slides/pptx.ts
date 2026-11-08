import JSZip from 'jszip';
import { AppError } from '../../db.ts';

// Reads a sample PowerPoint deck and builds new decks from it.
//
// A sample deck's slides are used as layouts. Every top-level shape that carries text is a
// "slot", numbered in the order it appears on the slide. A new slide names the sample slide it
// copies and gives new lines for its slots; the copy keeps the sample's background, colours,
// fonts, pictures and positions, and only the words change. A slot left empty is removed together
// with the text-less shapes that belong to it (a bullet dot, a table row's background), so a slide
// with five bullet boxes can carry three bullets. Page numbers are renumbered automatically.

export interface SampleSlot { slot: number; lines: string[]; chars: number; page?: boolean }
export interface SampleSlide { index: number; slots: SampleSlot[] }
export interface SampleInfo { slideCount: number; slides: SampleSlide[] }
export interface DeckSlide { sample: number; slots: { slot: number; lines: string[] }[] }

const SLIDE_TYPE = 'application/vnd.openxmlformats-officedocument.presentationml.slide+xml';
const REL_SLIDE = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships/slide';

const unesc = (s: string) => s.replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(+n)).replace(/&amp;/g, '&');
const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
// Characters XML 1.0 does not allow.
const clean = (s: string) => s.replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f￾￿]/g, '');

interface Part { start: number; end: number; xml: string; text: string[]; box: Box | null }
interface Box { x: number; y: number; w: number; h: number }

/** The top-level children of the slide's shape tree, with their text paragraphs and position. */
function shapes(xml: string): { treeStart: number; treeEnd: number; parts: Part[] } {
  const open = xml.indexOf('<p:spTree>');
  const close = xml.lastIndexOf('</p:spTree>');
  if (open < 0 || close < 0) throw new AppError(422, 'This PowerPoint slide has no shapes we can read.');
  const treeStart = open + '<p:spTree>'.length;
  const parts: Part[] = [];
  const tag = /<(\/?)([A-Za-z0-9_]+:[A-Za-z0-9_]+)\b[^>]*?(\/?)>/g;
  tag.lastIndex = treeStart;
  let depth = 0;
  let start = -1;
  let m: RegExpExecArray | null;
  while ((m = tag.exec(xml)) && m.index < close) {
    const [whole, closing, , selfClosing] = m;
    if (closing) {
      depth--;
      if (depth === 0) {
        const end = m.index + whole.length;
        parts.push(part(xml, start, end));
      }
    } else if (selfClosing) {
      if (depth === 0) parts.push(part(xml, m.index, m.index + whole.length));
    } else {
      if (depth === 0) start = m.index;
      depth++;
    }
  }
  return { treeStart, treeEnd: close, parts };
}

function part(xml: string, start: number, end: number): Part {
  const s = xml.slice(start, end);
  const isText = s.startsWith('<p:sp>') || s.startsWith('<p:sp ');
  const text = isText ? paragraphs(s).map((p) => paraText(p)) : [];
  const off = /<a:off x="(-?\d+)" y="(-?\d+)"\/>\s*<a:ext cx="(\d+)" cy="(\d+)"\/>/.exec(s);
  return { start, end, xml: s, text, box: off ? { x: +off[1], y: +off[2], w: +off[3], h: +off[4] } : null };
}

const PARA = /<a:p(?:\s[^>]*)?>[\s\S]*?<\/a:p>|<a:p\/>/g;
const paragraphs = (shape: string) => {
  const body = /<p:txBody>[\s\S]*<\/p:txBody>/.exec(shape)?.[0] ?? '';
  return body.match(PARA) ?? [];
};
const paraText = (p: string) => unesc([...p.matchAll(/<a:t>([\s\S]*?)<\/a:t>|<a:t\/>/g)].map((m) => m[1] ?? '').join(''));
const isSlot = (p: Part) => p.text.some((t) => t.trim() !== '');
const digitsOnly = (p: Part) => p.text.length === 1 && /^\d{1,3}$/.test(p.text[0]!.trim());
/** The page number is the slide's last text box, holding only digits (a table cell of digits is not). */
const pageNumberOf = (parts: Part[]) => { const slots = parts.filter(isSlot); const last = slots[slots.length - 1]; return last && digitsOnly(last) ? last : null; };

async function openDeck(buf: Buffer | Uint8Array) {
  let zip: JSZip;
  try {
    zip = await JSZip.loadAsync(buf);
  } catch {
    throw new AppError(422, 'That file is not a PowerPoint (.pptx) file.');
  }
  const pres = await zip.file('ppt/presentation.xml')?.async('string');
  const presRels = await zip.file('ppt/_rels/presentation.xml.rels')?.async('string');
  if (!pres || !presRels) throw new AppError(422, 'That file is not a PowerPoint (.pptx) file.');
  const rels = new Map([...presRels.matchAll(/<Relationship\b[^>]*>/g)].map((m) => [/Id="([^"]+)"/.exec(m[0])![1], m[0]]));
  const order = [...pres.matchAll(/<p:sldId\b[^>]*r:id="([^"]+)"/g)].map((m) => {
    const target = /Target="([^"]+)"/.exec(rels.get(m[1]) ?? '')?.[1] ?? '';
    return 'ppt/' + target.replace(/^\/?ppt\//, '').replace(/^\.\//, '');
  });
  if (!order.length) throw new AppError(422, 'That PowerPoint has no slides.');
  return { zip, pres, presRels, order };
}

/** What each slide of a sample deck holds, slot by slot. */
export async function readSample(buf: Buffer | Uint8Array): Promise<SampleInfo> {
  const { zip, order } = await openDeck(buf);
  const slides: SampleSlide[] = [];
  for (let i = 0; i < order.length; i++) {
    const xml = await zip.file(order[i])?.async('string');
    if (!xml) continue;
    const parts = shapes(xml).parts;
    const page = pageNumberOf(parts);
    const slots = parts.filter(isSlot).map((p, n) => ({
      slot: n + 1, lines: p.text, chars: p.text.join('\n').length, ...(p === page ? { page: true } : {}),
    }));
    slides.push({ index: i + 1, slots });
  }
  return { slideCount: order.length, slides };
}

/** New paragraphs for a shape, each copying the look of the sample paragraph in the same place. */
function fillShape(shape: string, lines: string[]): string {
  const paras = paragraphs(shape);
  if (!paras.length) return shape;
  const withRun = (i: number) => {
    for (let j = Math.min(i, paras.length - 1); j >= 0; j--) if (/<a:r>/.test(paras[j]!)) return paras[j]!;
    return paras.find((p) => /<a:r>/.test(p)) ?? paras[0]!;
  };
  const out = lines.map((line, i) => {
    const t = withRun(i);
    const pPr = /<a:pPr\b[^>]*\/>|<a:pPr\b[^>]*>[\s\S]*?<\/a:pPr>/.exec(t)?.[0] ?? '';
    const rPr = /<a:r>\s*(<a:rPr\b[^>]*\/>|<a:rPr\b[^>]*>[\s\S]*?<\/a:rPr>)/.exec(t)?.[1] ?? '';
    const end = /<a:endParaRPr\b[^>]*\/>|<a:endParaRPr\b[^>]*>[\s\S]*?<\/a:endParaRPr>/.exec(t)?.[0] ?? '';
    const text = clean(line);
    return `<a:p>${pPr}${text ? `<a:r>${rPr}<a:t>${esc(text)}</a:t></a:r>` : ''}${end}</a:p>`;
  });
  const first = shape.indexOf(paras[0]!);
  const last = shape.lastIndexOf(paras[paras.length - 1]!) + paras[paras.length - 1]!.length;
  return shape.slice(0, first) + out.join('') + shape.slice(last);
}

const overlaps = (a: Box, b: Box) => {
  const vertical = a.y < b.y + b.h && b.y < a.y + a.h;
  const gap = Math.max(0, Math.max(a.x, b.x) - Math.min(a.x + a.w, b.x + b.w));
  return vertical && gap < 457200; // half an inch
};

/** One new slide from a sample slide and the new text for its slots. */
export function fillSlide(xml: string, slots: Map<number, string[]>, pageShift: number): string {
  const { parts } = shapes(xml);
  const page = pageNumberOf(parts);
  const kept = new Set<Part>();
  const removed: Part[] = [];
  const replaced = new Map<Part, string>();
  let n = 0;
  for (const p of parts) {
    if (!isSlot(p)) continue;
    n++;
    if (p === page) {
      const old = p.text[0]!.trim();
      const num = Math.max(1, +old + pageShift);
      replaced.set(p, fillShape(p.xml, [String(num).padStart(old.length, '0')]));
      kept.add(p);
      continue;
    }
    const lines = slots.get(n);
    if (!lines || !lines.some((l) => l.trim())) { removed.push(p); continue; }
    replaced.set(p, fillShape(p.xml, lines));
    kept.add(p);
  }
  // A text-less shape goes with the removed slots it sits beside, unless a kept slot also uses it.
  for (const p of parts) {
    if (isSlot(p) || !p.box || !removed.length) continue;
    const box = p.box;
    const byRemoved = removed.some((r) => r.box && overlaps(box, r.box));
    const byKept = [...kept].some((k) => k.box && overlaps(box, k.box));
    if (byRemoved && !byKept) removed.push(p);
  }
  const drop = new Set(removed);
  let out = '';
  let at = 0;
  for (const p of parts) {
    out += xml.slice(at, p.start);
    out += drop.has(p) ? '' : replaced.get(p) ?? p.xml;
    at = p.end;
  }
  return out + xml.slice(at);
}

/** A new .pptx with the sample deck's theme and the given slides. */
export async function buildDeck(sample: Buffer | Uint8Array, slides: DeckSlide[]): Promise<Buffer> {
  if (!slides.length) throw new AppError(422, 'The lesson has no slides yet.');
  const { zip, pres, presRels, order } = await openDeck(sample);
  const sources: { xml: string; rels: string }[] = [];
  for (const path of order) {
    const xml = (await zip.file(path)?.async('string')) ?? '';
    const relPath = path.replace(/slides\/([^/]+)$/, 'slides/_rels/$1.rels');
    const rels = (await zip.file(relPath)?.async('string')) ?? '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"></Relationships>';
    sources.push({ xml, rels });
  }
  // Drop the sample's own slides and speaker notes.
  for (const name of Object.keys(zip.files)) if (/^ppt\/(slides|notesSlides)\//.test(name)) zip.remove(name);

  let types = (await zip.file('[Content_Types].xml')!.async('string'))
    .replace(/<Override\b[^>]*PartName="\/ppt\/(slides|notesSlides)\/[^"]*"[^>]*\/>/g, '');
  const relEntries: string[] = [];
  const ids: string[] = [];
  slides.forEach((s, i) => {
    const src = sources[s.sample - 1];
    if (!src) throw new AppError(422, `Slide ${i + 1} uses sample slide ${s.sample}, which the sample deck does not have.`);
    const slots = new Map(s.slots.map((x) => [x.slot, x.lines]));
    const xml = fillSlide(src.xml, slots, i + 1 - s.sample);
    const rels = src.rels.replace(/<Relationship\b[^>]*relationships\/notesSlide"[^>]*\/>/g, '');
    zip.file(`ppt/slides/slide${i + 1}.xml`, xml);
    zip.file(`ppt/slides/_rels/slide${i + 1}.xml.rels`, rels);
    types = types.replace('</Types>', `<Override PartName="/ppt/slides/slide${i + 1}.xml" ContentType="${SLIDE_TYPE}"/></Types>`);
    relEntries.push(`<Relationship Id="rIdKb${i + 1}" Type="${REL_SLIDE}" Target="slides/slide${i + 1}.xml"/>`);
    ids.push(`<p:sldId id="${256 + i}" r:id="rIdKb${i + 1}"/>`);
  });
  zip.file('[Content_Types].xml', types);
  zip.file('ppt/_rels/presentation.xml.rels', presRels
    .replace(/<Relationship\b[^>]*relationships\/slide"[^>]*\/>/g, '')
    .replace('</Relationships>', relEntries.join('') + '</Relationships>'));
  zip.file('ppt/presentation.xml', pres
    .replace(/<p:sldIdLst>[\s\S]*?<\/p:sldIdLst>/, `<p:sldIdLst>${ids.join('')}</p:sldIdLst>`)
    .replace(/<p:custShowLst>[\s\S]*?<\/p:custShowLst>/, '')
    .replace(/<p14:sectionLst\b[\s\S]*?<\/p14:sectionLst>/, ''));
  const app = await zip.file('docProps/app.xml')?.async('string');
  if (app) zip.file('docProps/app.xml', app.replace(/<Slides>\d+<\/Slides>/, `<Slides>${slides.length}</Slides>`).replace(/<Notes>\d+<\/Notes>/, '<Notes>0</Notes>'));
  return zip.generateAsync({ type: 'nodebuffer', compression: 'DEFLATE' });
}
