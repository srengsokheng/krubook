import JSZip from 'jszip';
import { PDFDocument, StandardFonts } from 'pdf-lib';

// A tiny deck in the shape of the real C++ decks: a title, a lead line, three bullets (each a dot
// shape beside a text box), a footer and a page number; plus a cover slide.
const sp = (id: number, x: number, y: number, w: number, h: number, text?: string[]) =>
  `<p:sp><p:nvSpPr><p:cNvPr id="${id}" name="S${id}"/><p:cNvSpPr/><p:nvPr/></p:nvSpPr><p:spPr><a:xfrm><a:off x="${x}" y="${y}"/><a:ext cx="${w}" cy="${h}"/></a:xfrm></p:spPr>` +
  `<p:txBody><a:bodyPr/><a:lstStyle/>${text ? text.map((t) => `<a:p><a:pPr marL="0"/><a:r><a:rPr lang="en-US" b="1"/><a:t>${t}</a:t></a:r><a:endParaRPr lang="en-US"/></a:p>`).join('') : '<a:p><a:endParaRPr/></a:p>'}</p:txBody></p:sp>`;
const slide = (shapes: string) => `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><p:sld xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships" xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main"><p:cSld><p:spTree><p:nvGrpSpPr><p:cNvPr id="1" name=""/><p:cNvGrpSpPr/><p:nvPr/></p:nvGrpSpPr><p:grpSpPr/>${shapes}</p:spTree></p:cSld></p:sld>`;
export const COVER = slide(sp(2, 0, 0, 9000000, 600000, ['C++ PROGRAMMING']) + sp(3, 0, 800000, 9000000, 600000, ['Lesson 2']));
export const CONTENT = slide(
  sp(2, 500000, 300000, 9000000, 400000, ['Variables']) +
  sp(3, 500000, 800000, 9000000, 400000, ['A variable stores a value:']) +
  sp(4, 500000, 1600000, 100000, 100000) + sp(5, 800000, 1500000, 9000000, 300000, ['First point']) +
  sp(6, 500000, 2400000, 100000, 100000) + sp(7, 800000, 2300000, 9000000, 300000, ['Second point']) +
  sp(8, 500000, 3200000, 100000, 100000) + sp(9, 800000, 3100000, 9000000, 300000, ['Third point']) +
  sp(10, 500000, 6000000, 3000000, 300000, ['C++ · Lesson 2']) + sp(11, 11000000, 6000000, 500000, 300000, ['01']),
);
export const CODE = slide(sp(2, 0, 0, 9000000, 400000, ['Code']) + sp(3, 0, 600000, 9000000, 3000000, ['int a = 1;', 'cout << a;']));

export async function sampleDeck(): Promise<Buffer> {
  const z = new JSZip();
  const slides = [COVER, CONTENT, CODE];
  z.file('[Content_Types].xml', `<?xml version="1.0"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">${slides.map((_, i) => `<Override PartName="/ppt/slides/slide${i + 1}.xml" ContentType="application/vnd.openxmlformats-officedocument.presentationml.slide+xml"/>`).join('')}<Override PartName="/ppt/notesSlides/notesSlide1.xml" ContentType="application/vnd.openxmlformats-officedocument.presentationml.notesSlide+xml"/></Types>`);
  z.file('ppt/presentation.xml', `<?xml version="1.0"?><p:presentation xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><p:sldIdLst>${slides.map((_, i) => `<p:sldId id="${300 + i}" r:id="rId${i + 5}"/>`).join('')}</p:sldIdLst></p:presentation>`);
  z.file('ppt/_rels/presentation.xml.rels', `<?xml version="1.0"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/slideMaster" Target="slideMasters/slideMaster1.xml"/>${slides.map((_, i) => `<Relationship Id="rId${i + 5}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/slide" Target="slides/slide${i + 1}.xml"/>`).join('')}</Relationships>`);
  slides.forEach((s, i) => {
    z.file(`ppt/slides/slide${i + 1}.xml`, s);
    z.file(`ppt/slides/_rels/slide${i + 1}.xml.rels`, `<?xml version="1.0"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/slideLayout" Target="../slideLayouts/slideLayout1.xml"/>${i === 0 ? '<Relationship Id="rId2" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/notesSlide" Target="../notesSlides/notesSlide1.xml"/>' : ''}</Relationships>`);
  });
  z.file('ppt/notesSlides/notesSlide1.xml', '<notes/>');
  z.file('docProps/app.xml', '<Properties><Slides>3</Slides><Notes>1</Notes></Properties>');
  return z.generateAsync({ type: 'nodebuffer' });
}

/**
 * A book of `pages` pages laid out like the C++ book: page 1 is the contents, then "Lesson 1: The
 * Basics" as a running header, and from the middle on "Lesson 2: Loops and More".
 */
export async function bookPdf(pages = 5): Promise<Buffer> {
  const d = await PDFDocument.create();
  const font = await d.embedFont(StandardFonts.Helvetica);
  const half = Math.max(2, Math.ceil((pages + 1) / 2));
  for (let i = 1; i <= pages; i++) {
    const p = d.addPage([300, 400]);
    const lines = i === 1
      ? ['Table of Contents', 'Lesson 1: The Basics ........ 1', 'Lesson 2: Loops and More ........ 3']
      : [`Lesson ${i < half ? 1 : 2}: ${i < half ? 'The Basics' : 'Loops and More'}`, 'SETEC Institute', `${i - 1}`, 'Some text about the lesson.'];
    lines.forEach((t, n) => p.drawText(t, { x: 20, y: 370 - n * 20, size: 10, font }));
  }
  return Buffer.from(await d.save());
}

