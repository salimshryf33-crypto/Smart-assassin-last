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

export const MIN_AVG_CHARS_PER_PAGE = 150;
export const MIN_TOTAL_CHARS        = 2_000;
export const MIN_NON_WS_DENSITY     = 0.20;

const VIRTUAL_PAGE_CHARS = 2_000;
const MIN_PAGE_CHARS     = 10;

const OCR_MODEL      = 'gemini-2.5-flash';
const OCR_DPI        = 150;
const BATCH_SIZE     = 8;
const OCR_MAX_OUTPUT = 16384;

const GEMINI_BASE = 'https://generativelanguage.googleapis.com';

// ─── Quota error ─────────────────────────────────────────────────────────────
//
// Thrown when Gemini returns HTTP 429 (quota exhausted).
// Carries whatever OCR text was successfully accumulated before the quota hit,
// plus the last PDF page number that was fully rendered and OCR'd.
// The queue processor catches this and marks the doc as 'partial'.

export class QuotaExhaustedError extends Error {
  constructor(
    public readonly lastRenderedPage: number,
    public readonly accumulatedTexts: string[],
    message: string
  ) {
    super(message);
    this.name = 'QuotaExhaustedError';
  }
}

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
  // Last PDF page number (1-based) that was successfully OCR'd and included
  // in pageTexts. Only set for OCR extraction. Used as the resume point if
  // processing is interrupted.
  lastRenderedPage?: number;
}

// ─── Quality measurement ─────────────────────────────────────────────────────

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
//
// Parameters:
//   filePath       — path to the PDF file (must exist)
//   onProgress     — called with (current, total) pages as they are processed
//   onOcrStart     — called once when text-layer stages fail and image OCR begins
//   startFromPage  — 1-based PDF page to begin OCR from (default: 1).
//                    When > 1, stages 1–3 are skipped entirely and OCR starts
//                    at this page. Used for resuming a partial extraction.
//   onBatchComplete — called after every successful OCR batch with the last
//                    rendered page number. Allows the caller to persist the
//                    resume point to disk after each batch, so a quota failure
//                    mid-book always leaves a recoverable state.

export async function extractPdf(
  filePath: string,
  onProgress?: (current: number, total: number) => void,
  onOcrStart?: () => void,
  startFromPage = 1,
  onBatchComplete?: (lastRenderedPage: number) => void,
): Promise<ExtractionResult> {
  const buffer = fs.readFileSync(filePath);
  onProgress?.(0, 0);

  const pageTexts: string[] = [];
  let totalPages = 0;

  // ── Stages 1–3: native text-layer extraction ─────────────────────────────
  // Skipped entirely when resuming from a specific page (startFromPage > 1),
  // because we already know this is a scanned PDF requiring image OCR.
  if (startFromPage === 1) {
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

      // ── Stage 1: per-page render ──────────────────────────────────────────
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

      // ── Stage 2: form-feed split ──────────────────────────────────────────
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

      // ── Stage 3: virtual page split ───────────────────────────────────────
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
      console.warn(
        `[pdfExtractor] pdf-parse error (falling through to image OCR): ` +
        (parseErr instanceof Error ? parseErr.message : String(parseErr))
      );
    }
  } else {
    // Resuming — we need totalPages from pdf-parse for the batch loop bounds.
    // Use a lightweight parse (max=1) just to get the page count.
    try {
      const meta = await pdfParse(buffer, { max: 1 });
      totalPages = meta.numpages || 0;
    } catch {
      // Best-effort — if this fails, ocrPdfViaImages will use totalPages=0
      // which causes it to render pages until pdftoppm finds no more.
    }
  }

  // ── Stage 4: Image-based OCR via pdftoppm + Gemini Vision ────────────────
  if (startFromPage === 1) {
    console.warn(`[pdfExtractor] Text-layer stages failed for "${filePath}" (totalPages=${totalPages}). Starting image OCR...`);
  } else {
    console.log(`[pdfExtractor] Resuming image OCR for "${filePath}" from page ${startFromPage} (totalPages=${totalPages})...`);
  }

  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) {
    console.error('[pdfExtractor] No GEMINI_API_KEY — image OCR unavailable');
    const qFailed = measureQuality([]);
    return { pageTexts: [], totalPages, extractionMethod: 'ocr', quality: qFailed };
  }

  onOcrStart?.();

  // ocrPdfViaImages throws QuotaExhaustedError if quota is hit — let it propagate
  // to the caller (curriculumQueue) which handles it by saving partial progress.
  const ocrResult = await ocrPdfViaImages(
    filePath,
    totalPages,
    apiKey,
    onProgress,
    startFromPage,
    onBatchComplete,
  );

  const qOcr = measureQuality(ocrResult.pageTexts);

  if (qOcr.totalChars > 0) {
    console.log(
      `[pdfExtractor] Image OCR OK — ${ocrResult.pageTexts.length} virtual pages` +
      ` | ${qOcr.totalChars} chars extracted` +
      ` | lastRenderedPage=${ocrResult.lastRenderedPage}`
    );
    return {
      pageTexts: ocrResult.pageTexts,
      totalPages: Math.max(totalPages, ocrResult.pageTexts.length),
      extractionMethod: 'ocr',
      quality: qOcr,
      lastRenderedPage: ocrResult.lastRenderedPage,
    };
  }

  console.error('[pdfExtractor] Image OCR produced 0 characters');
  const qFailed = measureQuality([]);
  return { pageTexts: [], totalPages, extractionMethod: 'ocr', quality: qFailed };
}

// ─── Image-based OCR: pdftoppm → PNG → Gemini Vision ─────────────────────────

async function ocrPdfViaImages(
  filePath: string,
  totalPages: number,
  apiKey: string,
  onProgress?: (current: number, total: number) => void,
  startFromPage = 1,
  onBatchComplete?: (lastRenderedPage: number) => void,
): Promise<{ pageTexts: string[]; lastRenderedPage: number }> {

  const imgDir = path.join(os.tmpdir(), `sage_ocr_${Date.now()}_${Math.random().toString(36).slice(2)}`);
  fs.mkdirSync(imgDir, { recursive: true });

  const allBatchTexts: string[] = [];
  const pagesTotal = totalPages > 0 ? totalPages : 1;
  // Track the last page whose content is confirmed saved in allBatchTexts.
  // Initialised to startFromPage - 1 so that if the very first batch fails,
  // lastRenderedPage reflects no progress from this run.
  let lastRenderedPage = startFromPage - 1;

  try {
    for (let pageStart = startFromPage; pageStart <= pagesTotal; pageStart += BATCH_SIZE) {
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
        // Quota errors must NOT be retried — propagate immediately so the
        // caller can save progress and mark the doc as partial.
        if (batchErr instanceof QuotaExhaustedError) {
          // Attach the accumulated texts so far before rethrowing
          throw new QuotaExhaustedError(
            lastRenderedPage,
            allBatchTexts,
            batchErr.message,
          );
        }

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
            if (pageErr instanceof QuotaExhaustedError) {
              throw new QuotaExhaustedError(
                lastRenderedPage,
                allBatchTexts,
                pageErr.message,
              );
            }
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

      // ── Update resume checkpoint ──────────────────────────────────────────
      // pageEnd is now confirmed processed. Persist this to disk via the
      // callback so that if quota hits on the NEXT batch, we have an accurate
      // resume point.
      lastRenderedPage = pageEnd;
      onBatchComplete?.(lastRenderedPage);

      onProgress?.(pageEnd, pagesTotal);
    }
  } finally {
    try { fs.rmSync(imgDir, { recursive: true, force: true }); } catch { /* ignore */ }
  }

  if (allBatchTexts.length === 0) return { pageTexts: [], lastRenderedPage };

  // Split each batch blob into virtual pages
  const pageTexts: string[] = [];
  for (const blob of allBatchTexts) {
    pageTexts.push(...splitToVirtualPages(blob));
  }

  return { pageTexts, lastRenderedPage };
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
    { timeout: 120_000 }
  );

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
      signal: AbortSignal.timeout(180_000),
    }
  );

  if (!response.ok) {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const errBody = await response.json().catch(() => ({ error: `HTTP ${response.status}` })) as any;
    const message = `Gemini Vision error ${response.status}: ${errBody?.error?.message ?? JSON.stringify(errBody)}`;

    // 429 = quota exhausted — throw a typed error so the queue can save progress
    if (response.status === 429) {
      throw new QuotaExhaustedError(0, [], message);
    }

    throw new Error(message);
  }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const data = await response.json() as any;
  const text: string = data?.candidates?.[0]?.content?.parts?.[0]?.text ?? '';

  return text;
}
