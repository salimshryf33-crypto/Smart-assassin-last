import { createRequire } from 'node:module';
import fs from 'node:fs';

const require = createRequire(import.meta.url);

// pdf-parse@1.x is CJS — must be externalized from esbuild (see build.mjs).
// Loaded via createRequire so the CJS module (and its pdfjs-dist dep) runs
// fully in Node.js, without any browser-API bundling.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const pdfParse = require('pdf-parse') as (buffer: Buffer, opts?: Record<string, unknown>) => Promise<{ numpages: number; text: string }>;

export interface ExtractionResult {
  pageTexts: string[];
  totalPages: number;
}

// Virtual page size when the PDF produces a single text blob (no per-page breaks).
const VIRTUAL_PAGE_CHARS = 2000;

// Minimum chars for a page to be considered non-empty
const MIN_PAGE_CHARS = 10;

// ─── RTL character-separation fix ────────────────────────────────────────────
// Some Arabic PDFs store text with pdfjs emitting each Unicode code point as a
// separate item: "ة ي ن ا د و س ل ا" instead of "السودانية".
//
// Algorithm:
//   1. Detect: if > 50% of whitespace tokens are single Arabic chars
//   2. Collect consecutive single-char runs, capped at MAX_WORD_LEN (≈ longest
//      real Arabic word) to prevent merging multiple words into one blob
//   3. Reverse each capped group to restore logical RTL order
//   4. Emit the result with spaces preserved around non-Arabic tokens
// ─────────────────────────────────────────────────────────────────────────────

const ARABIC_CHAR_RE = /^[\u0600-\u06FF\u0750-\u077F\uFB50-\uFDFF\uFE70-\uFEFF]$/;

// Maximum Arabic word length in characters (longest realistic Arabic word ≤ 12).
// Capping here prevents merging unrelated words that have no non-Arabic separator.
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
      // Collect single Arabic chars up to MAX_WORD_LEN per group.
      // When the cap is hit we flush the group and start a new one —
      // this ensures no word exceeds the max length even if the PDF
      // stored multi-word sequences without any non-Arabic separator.
      const chars: string[] = [];
      while (i < tokens.length && ARABIC_CHAR_RE.test(tokens[i])) {
        chars.push(tokens[i]);
        if (chars.length === MAX_WORD_LEN) {
          // Flush this group reversed, then continue collecting
          result.push(chars.reverse().join(''));
          chars.length = 0;
        }
        i++;
      }
      if (chars.length > 0) {
        result.push(chars.reverse().join(''));
      }
    } else {
      result.push(tokens[i]);
      i++;
    }
  }

  return result.join(' ');
}

export async function extractPdf(
  filePath: string,
  onProgress?: (current: number, total: number) => void
): Promise<ExtractionResult> {
  const buffer = fs.readFileSync(filePath);
  onProgress?.(0, 0);

  const pageTexts: string[] = [];

  // Use pagerender callback to capture each page's text individually.
  // This is the only reliable way to get per-page content from pdf-parse@1.x;
  // splitting result.text on '\f' often fails for non-Latin/Arabic PDFs.
  const result = await pdfParse(buffer, {
    max: 0, // process all pages
    pagerender: (pageData: unknown) => {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const page = pageData as any;
      return page
        .getTextContent({ normalizeWhitespace: true })
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        .then((content: { items: Array<{ str: string }> }) => {
          const text = content.items
            .map((item) => item.str)
            .join(' ')
            .replace(/\s{2,}/g, ' ')
            .trim();
          pageTexts.push(text || ' ');
          const total = Math.max(pageTexts.length, 1);
          onProgress?.(pageTexts.length, total);
          return text;
        });
    },
  });

  const totalPages = result.numpages || pageTexts.length;
  onProgress?.(totalPages, totalPages);

  // ── Stage 1: per-page render (preferred) ─────────────────────────────────
  const renderedPages = pageTexts
    .map(fixCharSeparatedArabic)
    .filter((t) => t.trim().length >= MIN_PAGE_CHARS);

  if (renderedPages.length > 1) {
    console.log(
      `[pdfExtractor] Extracted ${renderedPages.length} pages via pagerender` +
      ` (totalPages=${totalPages}, file="${filePath}")`
    );
    return { pageTexts: renderedPages, totalPages };
  }

  // ── Stage 2: form-feed split fallback ─────────────────────────────────────
  const ffPages = result.text
    .split('\f')
    .map((p) => fixCharSeparatedArabic(
      p.replace(/\s{3,}/g, '\n').replace(/[ \t]{2,}/g, ' ').trim()
    ))
    .filter((p) => p.length >= MIN_PAGE_CHARS);

  if (ffPages.length > 1) {
    console.log(
      `[pdfExtractor] Extracted ${ffPages.length} pages via form-feed split` +
      ` (totalPages=${totalPages}, file="${filePath}")`
    );
    return { pageTexts: ffPages, totalPages };
  }

  // ── Stage 3: virtual page split ───────────────────────────────────────────
  // Last resort: the entire PDF text arrived as one blob with no page breaks.
  // Apply char-separation fix first, then split into fixed-size virtual pages.
  const rawBlob = fixCharSeparatedArabic(
    (ffPages[0] || pageTexts[0] || result.text || '').trim()
  );

  if (rawBlob.length >= MIN_PAGE_CHARS) {
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
      console.log(
        `[pdfExtractor] Split blob into ${virtualPages.length} virtual pages` +
        ` (totalPages=${totalPages}, blobLen=${rawBlob.length}, file="${filePath}")`
      );
      return { pageTexts: virtualPages, totalPages };
    }
  }

  // ── Stage 4: truly empty PDF ──────────────────────────────────────────────
  console.warn(
    `[pdfExtractor] No extractable text found in "${filePath}"` +
    ` (totalPages=${totalPages}). PDF may be image-based (scanned) with no text layer.`
  );
  return { pageTexts: [], totalPages };
}
