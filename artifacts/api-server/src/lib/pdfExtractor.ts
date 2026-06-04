import { createRequire } from 'node:module';
import fs from 'node:fs';

const require = createRequire(import.meta.url);

// pdf-parse@1.x is CJS — must be externalized from esbuild (see build.mjs).
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const pdfParse = require('pdf-parse') as (buffer: Buffer, opts?: Record<string, unknown>) => Promise<{ numpages: number; text: string }>;

// ─── Quality thresholds ────────────────────────────────────────────────────────
//
// A PDF passes quality validation only when ALL three conditions are met.
// If any condition fails the extractor falls through to the next stage (or OCR).
//
//   MIN_AVG_CHARS_PER_PAGE  — average extracted chars per PDF page.
//     Typical Arabic textbook page:  800–2 500 chars.
//     Scanned page with only headers/footers: < 100 chars.
//     Threshold set at 150 to catch near-empty extractions while allowing
//     sparsely-formatted pages (e.g. diagrams with captions).
//
//   MIN_TOTAL_CHARS  — absolute floor regardless of page count.
//     Guards against very short PDFs (e.g. a single cover page).
//
//   MIN_NON_WS_DENSITY  — fraction of extracted chars that are non-whitespace.
//     A page full of spaces/newlines scores 0 here.
//     Threshold 0.20 means at least 1 in 5 chars must be real content.

export const MIN_AVG_CHARS_PER_PAGE = 150;   // chars / page
export const MIN_TOTAL_CHARS        = 2_000;  // absolute minimum
export const MIN_NON_WS_DENSITY     = 0.20;   // non-whitespace fraction

export type ExtractionMethod = 'text' | 'virtual' | 'ocr';

export interface ExtractionQuality {
  totalChars: number;
  nonWsChars: number;
  nonWsDensity: number;    // nonWsChars / totalChars  (0–1)
  pageCount: number;       // pages that passed MIN_PAGE_CHARS filter
  avgCharsPerPage: number; // totalChars / pageCount
  passed: boolean;         // true when all three thresholds are met
}

export interface ExtractionResult {
  pageTexts: string[];
  totalPages: number;
  extractionMethod: ExtractionMethod;
  quality: ExtractionQuality;
}

// Virtual page size when the PDF produces a single text blob
const VIRTUAL_PAGE_CHARS = 2_000;

// Minimum chars for a page to be considered non-empty during page filtering
const MIN_PAGE_CHARS = 10;

// ─── Quality helpers ──────────────────────────────────────────────────────────

function measureQuality(pages: string[]): ExtractionQuality {
  const totalChars = pages.reduce((s, p) => s + p.length, 0);
  const nonWsChars = pages.reduce((s, p) => s + p.replace(/\s/g, '').length, 0);
  const pageCount  = pages.length;
  const avgCharsPerPage = pageCount > 0 ? totalChars / pageCount : 0;
  const nonWsDensity    = totalChars > 0 ? nonWsChars / totalChars : 0;

  const passed =
    totalChars        >= MIN_TOTAL_CHARS        &&
    avgCharsPerPage   >= MIN_AVG_CHARS_PER_PAGE &&
    nonWsDensity      >= MIN_NON_WS_DENSITY;

  return { totalChars, nonWsChars, nonWsDensity, pageCount, avgCharsPerPage, passed };
}

// ─── RTL character-separation fix ─────────────────────────────────────────────
// Some Arabic PDFs store text with pdfjs emitting each Unicode code point as a
// separate item: "ة ي ن ا د و س ل ا" instead of "السودانية".

const ARABIC_CHAR_RE = /^[\u0600-\u06FF\u0750-\u077F\uFB50-\uFDFF\uFE70-\uFEFF]$/;
const MAX_WORD_LEN = 10;

export function fixCharSeparatedArabic(text: string): string {
  const tokens = text.split(/\s+/).filter(Boolean);
  if (tokens.length < 4) return text;

  const arabicSingleCount = tokens.filter((t) => ARABIC_CHAR_RE.test(t)).length;
  if (arabicSingleCount / tokens.length < 0.5) return text;

  const result: string[] = [];
  let i = 0;

  while (i < tokens.length) {
    if (ARABIC_CHAR_RE.test(tokens[i])) {
      const chars: string[] = [];
      while (i < tokens.length && ARABIC_CHAR_RE.test(tokens[i])) {
        chars.push(tokens[i]);
        if (chars.length === MAX_WORD_LEN) {
          result.push(chars.reverse().join(''));
          chars.length = 0;
        }
        i++;
      }
      if (chars.length > 0) result.push(chars.reverse().join(''));
    } else {
      result.push(tokens[i]);
      i++;
    }
  }

  return result.join(' ');
}

// ─── Main extractor ───────────────────────────────────────────────────────────

export async function extractPdf(
  filePath: string,
  onProgress?: (current: number, total: number) => void,
  onOcrStart?: () => void
): Promise<ExtractionResult> {
  const buffer = fs.readFileSync(filePath);
  onProgress?.(0, 0);

  const pageTexts: string[] = [];

  const result = await pdfParse(buffer, {
    max: 0,
    pagerender: (pageData: unknown) => {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const page = pageData as any;
      return page
        .getTextContent({ normalizeWhitespace: true })
        .then((content: { items: Array<{ str: string }> }) => {
          const text = content.items
            .map((item) => item.str)
            .join(' ')
            .replace(/\s{2,}/g, ' ')
            .trim();
          pageTexts.push(text || ' ');
          onProgress?.(pageTexts.length, Math.max(pageTexts.length, 1));
          return text;
        });
    },
  });

  const totalPages = result.numpages || pageTexts.length;
  onProgress?.(totalPages, totalPages);

  // ── Stage 1: per-page render ─────────────────────────────────────────────
  const renderedPages = pageTexts
    .map(fixCharSeparatedArabic)
    .filter((t) => t.trim().length >= MIN_PAGE_CHARS);

  if (renderedPages.length > 1) {
    const q1 = measureQuality(renderedPages);
    if (q1.passed) {
      console.log(
        `[pdfExtractor] Stage 1 OK — ${renderedPages.length} pages via pagerender` +
        ` | ${q1.totalChars} chars | ${q1.avgCharsPerPage.toFixed(0)} chars/page` +
        ` | density=${q1.nonWsDensity.toFixed(2)} (file="${filePath}")`
      );
      return { pageTexts: renderedPages, totalPages, extractionMethod: 'text', quality: q1 };
    }
    console.warn(
      `[pdfExtractor] Stage 1 SPARSE — ${renderedPages.length} pages but` +
      ` only ${q1.avgCharsPerPage.toFixed(0)} chars/page (min=${MIN_AVG_CHARS_PER_PAGE})` +
      `, density=${q1.nonWsDensity.toFixed(2)}, total=${q1.totalChars} — falling through to OCR`
    );
  }

  // ── Stage 2: form-feed split fallback ─────────────────────────────────────
  const ffPages = result.text
    .split('\f')
    .map((p) => fixCharSeparatedArabic(
      p.replace(/\s{3,}/g, '\n').replace(/[ \t]{2,}/g, ' ').trim()
    ))
    .filter((p) => p.length >= MIN_PAGE_CHARS);

  if (ffPages.length > 1) {
    const q2 = measureQuality(ffPages);
    if (q2.passed) {
      console.log(
        `[pdfExtractor] Stage 2 OK — ${ffPages.length} pages via form-feed` +
        ` | ${q2.totalChars} chars | ${q2.avgCharsPerPage.toFixed(0)} chars/page (file="${filePath}")`
      );
      return { pageTexts: ffPages, totalPages, extractionMethod: 'text', quality: q2 };
    }
    console.warn(
      `[pdfExtractor] Stage 2 SPARSE — ${ffPages.length} form-feed pages but` +
      ` only ${q2.avgCharsPerPage.toFixed(0)} chars/page — falling through to OCR`
    );
  }

  // ── Stage 3: virtual page split ───────────────────────────────────────────
  const rawBlob = fixCharSeparatedArabic(
    (ffPages[0] || pageTexts[0] || result.text || '').trim()
  );

  if (rawBlob.length >= MIN_TOTAL_CHARS) {
    const virtualPages: string[] = [];
    for (let i = 0; i < rawBlob.length; i += VIRTUAL_PAGE_CHARS) {
      let end = Math.min(i + VIRTUAL_PAGE_CHARS, rawBlob.length);
      if (end < rawBlob.length) {
        const spaceIdx = rawBlob.lastIndexOf(' ', end);
        if (spaceIdx > i + VIRTUAL_PAGE_CHARS / 2) end = spaceIdx + 1;
      }
      const slice = rawBlob.slice(i, end).trim();
      if (slice.length >= MIN_PAGE_CHARS) virtualPages.push(slice);
    }

    if (virtualPages.length > 0) {
      const q3 = measureQuality(virtualPages);
      if (q3.passed) {
        console.log(
          `[pdfExtractor] Stage 3 OK — ${virtualPages.length} virtual pages` +
          ` | ${q3.totalChars} chars | ${q3.avgCharsPerPage.toFixed(0)} chars/page (file="${filePath}")`
        );
        return { pageTexts: virtualPages, totalPages, extractionMethod: 'virtual', quality: q3 };
      }
      console.warn(
        `[pdfExtractor] Stage 3 SPARSE — virtual split produced ${virtualPages.length} pages` +
        ` but only ${q3.avgCharsPerPage.toFixed(0)} chars/page — falling through to OCR`
      );
    }
  }

  // ── Stage 4 / 5: Gemini Vision OCR for scanned PDFs ─────────────────────
  console.warn(
    `[pdfExtractor] All text-layer stages failed or produced sparse results for "${filePath}"` +
    ` (totalPages=${totalPages}). Attempting Gemini Vision OCR...`
  );

  const apiKey = process.env.GEMINI_API_KEY;
  if (apiKey) {
    onOcrStart?.();
    try {
      const ocrPages = await ocrPdfWithGemini(filePath, buffer, apiKey);
      if (ocrPages.length > 0) {
        const qOcr = measureQuality(ocrPages);
        console.log(
          `[pdfExtractor] OCR OK — ${ocrPages.length} pages extracted` +
          ` | ${qOcr.totalChars} chars | ${qOcr.avgCharsPerPage.toFixed(0)} chars/page` +
          ` (file="${filePath}")`
        );
        return {
          pageTexts: ocrPages,
          totalPages: Math.max(totalPages, ocrPages.length),
          extractionMethod: 'ocr',
          quality: qOcr,
        };
      }
    } catch (ocrErr) {
      console.warn(
        `[pdfExtractor] OCR failed for "${filePath}": ` +
        (ocrErr instanceof Error ? ocrErr.message : String(ocrErr))
      );
    }
  } else {
    console.warn(`[pdfExtractor] No GEMINI_API_KEY — OCR unavailable for "${filePath}"`);
  }

  // ── Complete failure ─────────────────────────────────────────────────────
  console.error(
    `[pdfExtractor] All extraction stages failed for "${filePath}". ` +
    `PDF is image-based and OCR produced no usable text.`
  );

  const qFailed = measureQuality([]);
  return { pageTexts: [], totalPages, extractionMethod: 'ocr', quality: qFailed };
}

// ─── Gemini Vision OCR ────────────────────────────────────────────────────────

async function ocrPdfWithGemini(
  filePath: string,
  buffer: Buffer,
  apiKey: string
): Promise<string[]> {
  const MAX_INLINE_BYTES = 20 * 1024 * 1024;
  if (buffer.length > MAX_INLINE_BYTES) {
    throw new Error(
      `PDF size ${(buffer.length / 1024 / 1024).toFixed(1)} MB exceeds 20 MB inline OCR limit. ` +
      `Please use a smaller file or a version with a text layer.`
    );
  }

  const base64 = buffer.toString('base64');
  const GEMINI_BASE = 'https://generativelanguage.googleapis.com';

  const response = await fetch(
    `${GEMINI_BASE}/v1beta/models/gemini-1.5-flash:generateContent?key=${apiKey}`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        contents: [{
          parts: [
            {
              text:
                'هذا ملف PDF ممسوح ضوئياً. استخرج كل النصوص العربية والإنجليزية من جميع صفحاته.\n' +
                'قسّم الناتج باستخدام الفاصل "=== الصفحة N ===" قبل كل صفحة (حيث N هو رقم الصفحة).\n' +
                'لا تضف شرحاً أو تعليقاً، فقط النص المستخرج كما هو.',
            },
            {
              inline_data: {
                mime_type: 'application/pdf',
                data: base64,
              },
            },
          ],
        }],
        generationConfig: { temperature: 0, maxOutputTokens: 65536 },
      }),
    }
  );

  if (!response.ok) {
    const errBody = await response.json().catch(() => ({ error: `HTTP ${response.status}` }));
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    throw new Error(`Gemini OCR API error ${response.status}: ${(errBody as any)?.error?.message ?? JSON.stringify(errBody)}`);
  }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const data = await response.json() as any;
  const text: string = data?.candidates?.[0]?.content?.parts?.[0]?.text ?? '';

  if (!text.trim()) {
    throw new Error('Gemini OCR returned empty text — PDF may be unreadable or encrypted.');
  }

  const pages = text
    .split(/===\s*(?:الصفحة|Page)\s*\d+\s*===/i)
    .map((p: string) => fixCharSeparatedArabic(p.trim()))
    .filter((p: string) => p.length >= MIN_PAGE_CHARS);

  if (pages.length > 0) return pages;

  const blob = fixCharSeparatedArabic(text.trim());
  if (blob.length < MIN_PAGE_CHARS) throw new Error('Gemini OCR text too short to be useful.');

  const virtualPages: string[] = [];
  for (let i = 0; i < blob.length; i += VIRTUAL_PAGE_CHARS) {
    let end = Math.min(i + VIRTUAL_PAGE_CHARS, blob.length);
    if (end < blob.length) {
      const spaceIdx = blob.lastIndexOf(' ', end);
      if (spaceIdx > i + VIRTUAL_PAGE_CHARS / 2) end = spaceIdx + 1;
    }
    const slice = blob.slice(i, end).trim();
    if (slice.length >= MIN_PAGE_CHARS) virtualPages.push(slice);
  }

  return virtualPages;
}
