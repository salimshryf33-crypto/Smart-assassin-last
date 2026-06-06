import { createRequire } from 'node:module';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

const require = createRequire(import.meta.url);
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const pdfParse = require('pdf-parse') as (buffer: Buffer, opts?: Record<string, unknown>) => Promise<{ numpages: number; text: string }>;

// ─── Constants ────────────────────────────────────────────────────────────────

// Text-layer quality thresholds (Stages 1–3 ONLY — never applied to OCR output)
export const MIN_AVG_CHARS_PER_PAGE = 150;
export const MIN_TOTAL_CHARS        = 2_000;
export const MIN_NON_WS_DENSITY     = 0.20;

// Virtual page size used when splitting a text blob into page-like chunks
const VIRTUAL_PAGE_CHARS = 2_000;

// Minimum chars for a page to be considered non-empty
const MIN_PAGE_CHARS = 10;

// Image OCR settings
const OCR_MODEL      = 'gemini-2.5-flash';
const OCR_DPI        = 150;   // DPI for pdftoppm rendering
const BATCH_SIZE     = 8;     // pages per Gemini Vision call
const OCR_MAX_OUTPUT = 16384; // maxOutputTokens per batch

const GEMINI_BASE = 'https://generativelanguage.googleapis.com';

// ─── Types ────────────────────────────────────────────────────────────────────

export type ExtractionMethod = 'text' | 'virtual' | 'ocr';

export interface ExtractionQuality {
  totalChars: number;
  nonWsChars: number;
  nonWsDensity: number;
  pageCount: number;
  avgCharsPerPage: number;
  passed: boolean;
}

export interface ExtractionResult {
  pageTexts: string[];
  totalPages: number;
  extractionMethod: ExtractionMethod;
  quality: ExtractionQuality;
}

// ─── Quality measurement (text layers only) ───────────────────────────────────

function measureQuality(pages: string[], pdfPageCount?: number): ExtractionQuality {
  const totalChars  = pages.reduce((s, p) => s + p.length, 0);
  const nonWsChars  = pages.reduce((s, p) => s + p.replace(/\s/g, '').length, 0);
  const pageCount   = pages.length;
  const denominator = (pdfPageCount && pdfPageCount > pageCount) ? pdfPageCount : pageCount;
  const avgCharsPerPage = denominator > 0 ? totalChars / denominator : 0;
  const nonWsDensity    = totalChars > 0 ? nonWsChars / totalChars : 0;

  const passed =
    totalChars        >= MIN_TOTAL_CHARS        &&
    avgCharsPerPage   >= MIN_AVG_CHARS_PER_PAGE &&
    nonWsDensity      >= MIN_NON_WS_DENSITY;

  return { totalChars, nonWsChars, nonWsDensity, pageCount, avgCharsPerPage, passed };
}

// ─── RTL character-separation fix ────────────────────────────────────────────

const ARABIC_CHAR_RE = /^[\u0600-\u06FF\u0750-\u077F\uFB50-\uFDFF\uFE70-\uFEFF]$/;
const MAX_WORD_LEN   = 10;

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

// ─── OCR repetition filter ────────────────────────────────────────────────────
// Gemini sometimes hallucinates by repeating the same line many times.
// Collapse any line that appears more than MAX_LINE_REPEATS times in a block.

const MAX_LINE_REPEATS = 3;

export function filterRepetitiveLines(text: string): string {
  const lines = text.split('\n');
  const out: string[] = [];
  const lineCount = new Map<string, number>();

  for (const line of lines) {
    const key = line.trim();
    if (!key) { out.push(line); continue; }
    const count = (lineCount.get(key) ?? 0) + 1;
    lineCount.set(key, count);
    if (count <= MAX_LINE_REPEATS) out.push(line);
  }

  return out.join('\n');
}

// ─── Virtual page splitter ────────────────────────────────────────────────────

function splitToVirtualPages(blob: string): string[] {
  const pages: string[] = [];
  for (let i = 0; i < blob.length; i += VIRTUAL_PAGE_CHARS) {
    let end = Math.min(i + VIRTUAL_PAGE_CHARS, blob.length);
    if (end < blob.length) {
      const spaceIdx = blob.lastIndexOf(' ', end);
      if (spaceIdx > i + VIRTUAL_PAGE_CHARS / 2) end = spaceIdx + 1;
    }
    const slice = blob.slice(i, end).trim();
    if (slice.length >= MIN_PAGE_CHARS) pages.push(slice);
  }
  return pages;
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
  let totalPages = 0;

  // ── Stages 1–3: native text-layer extraction (wrapped — errors fall through to OCR) ──
  try {
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

    totalPages = result.numpages || pageTexts.length;
    onProgress?.(totalPages, totalPages);

    // ── Stage 1: per-page render ────────────────────────────────────────────
    const renderedPages = pageTexts
      .map(fixCharSeparatedArabic)
      .filter((t) => t.trim().length >= MIN_PAGE_CHARS);

    if (renderedPages.length > 1) {
      const q1 = measureQuality(renderedPages, totalPages);
      if (q1.passed) {
        console.log(`[pdfExtractor] Stage 1 OK — ${renderedPages.length} pages | ${q1.totalChars} chars | ${q1.avgCharsPerPage.toFixed(0)} chars/page`);
        return { pageTexts: renderedPages, totalPages, extractionMethod: 'text', quality: q1 };
      }
      console.warn(`[pdfExtractor] Stage 1 SPARSE — ${q1.avgCharsPerPage.toFixed(0)} chars/page (min=${MIN_AVG_CHARS_PER_PAGE}), density=${q1.nonWsDensity.toFixed(2)}`);
    }

    // ── Stage 2: form-feed split ────────────────────────────────────────────
    const ffPages = result.text
      .split('\f')
      .map((p) => fixCharSeparatedArabic(p.replace(/\s{3,}/g, '\n').replace(/[ \t]{2,}/g, ' ').trim()))
      .filter((p) => p.length >= MIN_PAGE_CHARS);

    if (ffPages.length > 1) {
      const q2 = measureQuality(ffPages, totalPages);
      if (q2.passed) {
        console.log(`[pdfExtractor] Stage 2 OK — ${ffPages.length} pages | ${q2.totalChars} chars | ${q2.avgCharsPerPage.toFixed(0)} chars/page`);
        return { pageTexts: ffPages, totalPages, extractionMethod: 'text', quality: q2 };
      }
      console.warn(`[pdfExtractor] Stage 2 SPARSE — ${q2.avgCharsPerPage.toFixed(0)} chars/page`);
    }

    // ── Stage 3: virtual page split ─────────────────────────────────────────
    const rawBlob = fixCharSeparatedArabic(
      (ffPages[0] || pageTexts[0] || result.text || '').trim()
    );

    if (rawBlob.length >= MIN_TOTAL_CHARS) {
      const virtualPages = splitToVirtualPages(rawBlob);
      if (virtualPages.length > 0) {
        const q3 = measureQuality(virtualPages, totalPages);
        if (q3.passed) {
          console.log(`[pdfExtractor] Stage 3 OK — ${virtualPages.length} virtual pages | ${q3.totalChars} chars | ${q3.avgCharsPerPage.toFixed(0)} chars/page`);
          return { pageTexts: virtualPages, totalPages, extractionMethod: 'virtual', quality: q3 };
        }
        console.warn(`[pdfExtractor] Stage 3 SPARSE — ${q3.avgCharsPerPage.toFixed(1)} chars/page`);
      }
    }
  } catch (parseErr) {
    // pdf-parse can throw on malformed/encrypted PDFs — do not crash.
    // Fall through to image-based OCR which works directly on the rendered pixels.
    console.warn(
      `[pdfExtractor] pdf-parse error (falling through to image OCR): ` +
      (parseErr instanceof Error ? parseErr.message : String(parseErr))
    );
  }

  // ── Stage 4: Image-based OCR via pdftoppm + Gemini Vision ────────────────
  console.warn(`[pdfExtractor] Text-layer stages failed for "${filePath}" (totalPages=${totalPages}). Starting image OCR...`);

  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) {
    console.error('[pdfExtractor] No GEMINI_API_KEY — image OCR unavailable');
    const qFailed = measureQuality([]);
    return { pageTexts: [], totalPages, extractionMethod: 'ocr', quality: qFailed };
  }

  onOcrStart?.();

  try {
    const ocrPages = await ocrPdfViaImages(filePath, totalPages, apiKey, onProgress);

    const qOcr = measureQuality(ocrPages);

    // ── CRITICAL: Accept OCR output if totalChars > 0. ──────────────────────
    // No avgCharsPerPage / density gates for OCR — they are meaningless for
    // image-based extraction where page grouping is virtual.
    if (qOcr.totalChars > 0) {
      console.log(
        `[pdfExtractor] Image OCR OK — ${ocrPages.length} virtual pages` +
        ` | ${qOcr.totalChars} chars extracted`
      );
      return {
        pageTexts: ocrPages,
        totalPages: Math.max(totalPages, ocrPages.length),
        extractionMethod: 'ocr',
        quality: qOcr,
      };
    }

    console.error('[pdfExtractor] Image OCR produced 0 characters');
  } catch (ocrErr) {
    console.error(
      '[pdfExtractor] Image OCR failed:',
      ocrErr instanceof Error ? ocrErr.message : String(ocrErr)
    );
  }

  const qFailed = measureQuality([]);
  return { pageTexts: [], totalPages, extractionMethod: 'ocr', quality: qFailed };
}

// ─── Image-based OCR: pdftoppm → PNG → Gemini Vision ─────────────────────────

async function ocrPdfViaImages(
  filePath: string,
  totalPages: number,
  apiKey: string,
  onProgress?: (current: number, total: number) => void
): Promise<string[]> {

  // Temp dir for rendered PNG images (cleaned up after each batch)
  const imgDir = path.join(os.tmpdir(), `sage_ocr_${Date.now()}_${Math.random().toString(36).slice(2)}`);
  fs.mkdirSync(imgDir, { recursive: true });

  const allBatchTexts: string[] = [];
  const pagesTotal = totalPages > 0 ? totalPages : 1;

  try {
    // Process pages in batches of BATCH_SIZE
    for (let pageStart = 1; pageStart <= pagesTotal; pageStart += BATCH_SIZE) {
      const pageEnd = Math.min(pageStart + BATCH_SIZE - 1, pagesTotal);

      onProgress?.(pageStart - 1, pagesTotal);
      console.log(`[pdfExtractor] OCR batch: pages ${pageStart}–${pageEnd} of ${pagesTotal}`);

      // Render this batch of pages to PNG
      let imagePaths: string[] = [];
      try {
        imagePaths = await renderPageBatch(filePath, imgDir, pageStart, pageEnd);
      } catch (renderErr) {
        console.warn(
          `[pdfExtractor] pdftoppm failed for pages ${pageStart}–${pageEnd}:`,
          renderErr instanceof Error ? renderErr.message : String(renderErr)
        );
        continue;
      }

      if (imagePaths.length === 0) {
        console.warn(`[pdfExtractor] No images rendered for pages ${pageStart}–${pageEnd}`);
        continue;
      }

      // Run Gemini Vision OCR on this batch
      let batchText = '';
      try {
        batchText = await ocrImageBatch(imagePaths, apiKey);
      } catch (batchErr) {
        console.warn(
          `[pdfExtractor] Batch OCR failed for pages ${pageStart}–${pageEnd}, retrying page-by-page:`,
          batchErr instanceof Error ? batchErr.message : String(batchErr)
        );

        // Fallback: retry each page individually
        for (let idx = 0; idx < imagePaths.length; idx++) {
          try {
            const pageText = await ocrImageBatch([imagePaths[idx]], apiKey);
            if (pageText.trim()) batchText += '\n' + pageText;
          } catch (pageErr) {
            console.warn(
              `[pdfExtractor] Single-page OCR failed for page ${pageStart + idx}:`,
              pageErr instanceof Error ? pageErr.message : String(pageErr)
            );
          }
        }
      }

      // Clean up rendered images immediately to save disk space
      for (const img of imagePaths) {
        try { fs.unlinkSync(img); } catch { /* ignore */ }
      }

      const cleaned = filterRepetitiveLines(fixCharSeparatedArabic(batchText.trim()));
      if (cleaned.length >= MIN_PAGE_CHARS) {
        allBatchTexts.push(cleaned);
      }

      onProgress?.(pageEnd, pagesTotal);
    }
  } finally {
    // Remove temp dir
    try { fs.rmSync(imgDir, { recursive: true, force: true }); } catch { /* ignore */ }
  }

  if (allBatchTexts.length === 0) return [];

  // Split each batch blob into virtual pages so the chunker gets granular input
  const pageTexts: string[] = [];
  for (const blob of allBatchTexts) {
    pageTexts.push(...splitToVirtualPages(blob));
  }

  return pageTexts;
}

// ─── pdftoppm page renderer ───────────────────────────────────────────────────

async function renderPageBatch(
  filePath: string,
  imgDir: string,
  firstPage: number,
  lastPage: number
): Promise<string[]> {
  const prefix = path.join(imgDir, `p${firstPage}`);

  await execFileAsync(
    'pdftoppm',
    [
      '-png',
      '-r', String(OCR_DPI),
      '-f', String(firstPage),
      '-l', String(lastPage),
      filePath,
      prefix,
    ],
    { timeout: 120_000 }  // 2 min per batch
  );

  // pdftoppm names files: <prefix>-1.png, <prefix>-2.png or <prefix>-001.png
  return fs.readdirSync(imgDir)
    .filter((f) => f.startsWith(`p${firstPage}`) && f.endsWith('.png'))
    .sort()
    .map((f) => path.join(imgDir, f));
}

// ─── Gemini Vision batch OCR ──────────────────────────────────────────────────

async function ocrImageBatch(
  imagePaths: string[],
  apiKey: string
): Promise<string> {
  // Build image parts from PNG files
  const imageParts = imagePaths.map((p) => ({
    inline_data: {
      mime_type: 'image/png' as const,
      data: fs.readFileSync(p).toString('base64'),
    },
  }));

  const prompt =
    'أنت نظام OCR متخصص. مهمتك استخراج النص من الصور المرفقة.\n' +
    'القواعد:\n' +
    '- اكتب النص كما يظهر في الصورة تماماً بدون تغيير\n' +
    '- للمعادلات الرياضية: اكتبها بصيغة نصية وضعية (مثال: F = m × a)\n' +
    '- للجداول: اكتب محتواها سطراً سطراً\n' +
    '- لا تضف أي شرح أو تعليق أو عناوين من عندك\n' +
    '- إذا كانت صورة غير واضحة اكتب ما تستطيع قراءته';

  const body = {
    contents: [
      {
        parts: [
          { text: prompt },
          ...imageParts,
        ],
      },
    ],
    generationConfig: {
      temperature: 0,
      maxOutputTokens: OCR_MAX_OUTPUT,
    },
  };

  const response = await fetch(
    `${GEMINI_BASE}/v1beta/models/${OCR_MODEL}:generateContent?key=${apiKey}`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(180_000), // 3 min per batch
    }
  );

  if (!response.ok) {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const errBody = await response.json().catch(() => ({ error: `HTTP ${response.status}` })) as any;
    throw new Error(
      `Gemini Vision error ${response.status}: ${errBody?.error?.message ?? JSON.stringify(errBody)}`
    );
  }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const data = await response.json() as any;
  const text: string = data?.candidates?.[0]?.content?.parts?.[0]?.text ?? '';

  return text;
}
