'use strict';

/**
 * Turns an uploaded training file into an ordered list of "units" — one per
 * slide for PowerPoint, one per page/chunk otherwise. Keeping the unit
 * boundaries (rather than flattening to a wall of text) is what lets the model
 * map generated sections back to specific slides.
 */

const path = require('path');
const JSZip = require('jszip');

const SUPPORTED = ['.pptx', '.docx', '.pdf', '.txt', '.md'];

/** Strips XML tags but keeps the text of the listed run elements, per paragraph. */
function xmlParagraphs(xml, paragraphTag, textTag) {
  const paraRe = new RegExp(`<${paragraphTag}[\\s>][\\s\\S]*?</${paragraphTag}>`, 'g');
  const textRe = new RegExp(`<${textTag}[^>]*>([\\s\\S]*?)</${textTag}>`, 'g');
  const out = [];
  for (const para of xml.match(paraRe) || []) {
    let line = '';
    let m;
    textRe.lastIndex = 0;
    while ((m = textRe.exec(para)) !== null) line += decodeEntities(m[1]);
    // Explicit line breaks inside a paragraph.
    line = line.replace(/\s+/g, ' ').trim();
    if (line) out.push(line);
  }
  return out;
}

function decodeEntities(s) {
  return String(s)
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&#(\d+);/g, (_, d) => String.fromCharCode(Number(d)))
    .replace(/&amp;/g, '&');
}

const numberIn = (name) => {
  const m = name.match(/(\d+)\.xml$/);
  return m ? Number(m[1]) : 0;
};

async function extractPptx(buffer) {
  const zip = await JSZip.loadAsync(buffer);

  const slideNames = Object.keys(zip.files)
    .filter((n) => /^ppt\/slides\/slide\d+\.xml$/.test(n))
    .sort((a, b) => numberIn(a) - numberIn(b));

  if (slideNames.length === 0) {
    throw new Error('That .pptx contains no slides.');
  }

  const noteNames = new Set(
    Object.keys(zip.files).filter((n) => /^ppt\/notesSlides\/notesSlide\d+\.xml$/.test(n))
  );

  const units = [];
  for (const name of slideNames) {
    const index = numberIn(name);
    const xml = await zip.file(name).async('string');
    const lines = xmlParagraphs(xml, 'a:p', 'a:t');

    let notes = '';
    const noteName = `ppt/notesSlides/notesSlide${index}.xml`;
    if (noteNames.has(noteName)) {
      const noteXml = await zip.file(noteName).async('string');
      // Notes slides repeat the slide number placeholder; drop bare-number lines.
      notes = xmlParagraphs(noteXml, 'a:p', 'a:t')
        .filter((l) => !/^\d+$/.test(l))
        .join('\n');
    }

    units.push({
      index,
      label: `Slide ${index}`,
      title: lines[0] || `Slide ${index}`,
      body: lines.slice(1).join('\n'),
      notes,
    });
  }
  return { kind: 'pptx', units };
}

async function extractDocx(buffer) {
  const zip = await JSZip.loadAsync(buffer);
  const file = zip.file('word/document.xml');
  if (!file) throw new Error('That .docx is missing its document body.');
  const xml = await file.async('string');
  const paragraphs = xmlParagraphs(xml, 'w:p', 'w:t');
  return { kind: 'docx', units: chunkParagraphs(paragraphs, 'Part') };
}

async function extractPdf(buffer) {
  let pdfParse;
  try {
    // Optional dependency: PDFs are supported only when it installed cleanly.
    pdfParse = require('pdf-parse');
  } catch {
    throw new Error(
      'PDF support needs the optional "pdf-parse" package. Run `npm install pdf-parse`, or upload a .pptx / .docx / .md file instead.'
    );
  }
  const data = await pdfParse(buffer);
  const pages = String(data.text || '')
    .split('\f')
    .map((p) => p.trim())
    .filter(Boolean);
  if (pages.length === 0) {
    throw new Error('No selectable text found in that PDF (it may be a scan).');
  }
  return {
    kind: 'pdf',
    units: pages.map((text, i) => ({
      index: i + 1,
      label: `Page ${i + 1}`,
      title: text.split('\n')[0].slice(0, 120) || `Page ${i + 1}`,
      body: text,
      notes: '',
    })),
  };
}

function extractPlainText(buffer, kind) {
  const paragraphs = buffer
    .toString('utf8')
    .split(/\n{2,}/)
    .map((p) => p.trim())
    .filter(Boolean);
  if (paragraphs.length === 0) throw new Error('That file is empty.');
  return { kind, units: chunkParagraphs(paragraphs, 'Block') };
}

/** Groups loose paragraphs into ~1200-character units so the model sees structure. */
function chunkParagraphs(paragraphs, labelPrefix) {
  const units = [];
  let buf = [];
  let size = 0;
  const flush = () => {
    if (!buf.length) return;
    const text = buf.join('\n\n');
    units.push({
      index: units.length + 1,
      label: `${labelPrefix} ${units.length + 1}`,
      title: buf[0].slice(0, 120),
      body: text,
      notes: '',
    });
    buf = [];
    size = 0;
  };
  for (const p of paragraphs) {
    buf.push(p);
    size += p.length;
    if (size > 1200) flush();
  }
  flush();
  return units;
}

async function extractUnits(buffer, filename) {
  const ext = path.extname(filename || '').toLowerCase();
  switch (ext) {
    case '.pptx':
      return extractPptx(buffer);
    case '.docx':
      return extractDocx(buffer);
    case '.pdf':
      return extractPdf(buffer);
    case '.txt':
      return extractPlainText(buffer, 'txt');
    case '.md':
      return extractPlainText(buffer, 'md');
    default:
      throw new Error(`Unsupported file type "${ext || filename}". Supported: ${SUPPORTED.join(', ')}`);
  }
}

/** Renders units into the transcript the model reads. Capped to stay sane on huge decks. */
function unitsToTranscript(units, maxChars = 400_000) {
  const parts = [];
  let total = 0;
  for (const u of units) {
    const block = [
      `### ${u.label}: ${u.title}`,
      u.body ? u.body : '(no body text)',
      u.notes ? `[Presenter notes] ${u.notes}` : '',
    ]
      .filter(Boolean)
      .join('\n');
    if (total + block.length > maxChars) {
      parts.push(`\n[Transcript truncated after ${parts.length} of ${units.length} units.]`);
      break;
    }
    parts.push(block);
    total += block.length;
  }
  return parts.join('\n\n');
}

module.exports = { extractUnits, unitsToTranscript, SUPPORTED };
