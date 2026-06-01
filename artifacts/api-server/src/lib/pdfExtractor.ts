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
// ~2000 chars ≈ half an A4 page of Arabic text — fine-grained enough for RAG.
const VIRTUAL_PAGE_CHARS = 2000;

// Minimum chars for a page to be considered non-empty
const MIN_PAGE_CHARS = 10;

// ─── RTL character-separation fix ────────────────────────────────────────────
// Some Arabic PDFs store text in visual (RTL) order, causing pdf-parse to emit
// each character separated by a space: "ة ي ن ا د و س ل ا" instead of "السودانية".
// Detection: if > 50% of whitespace-delimited tokens are single Arabic chars,
// collapse consecutive single-char sequences into words.
// ─────────────────────────────────────────────────────────────────────────────

const ARABIC_CHAR_RE = /^[\u0600-\u06FF\u0750-\u077F\uFB50-\uFDFF\uFE70-\uFEFF]$/;

function fixCharSeparatedArabic(text: string): string {
  const tokens = text.split(/\s+/).filter(Boolean);
  if (tokens.length < 4) return text;

  const arabicSingleCount = tokens.filter((t) => ARABIC_CHAR_RE.test(t)).length;
  if (arabicSingleCount / tokens.length < 0.5) return text; // not char-separated

  // Collapse sequences of single Arabic letters into words.
  // Since RTL PDFs often store characters in reverse visual order,
  // each collapsed sequence is also reversed to restore logical order.
  const result: string[] = [];
  let i = 0;
  while (i < tokens.length) {
    if (ARABIC_CHAR_RE.test(tokens[i])) {
      const chars: string[] = [tokens[i]];
      while (i + 1 < tokens.length && ARABIC_CHAR_RE.test(tokens[i + 1])) {
        chars.push(tokens[++i]);
      }
      // Reverse the collected chars to restore logical RTL order
      result.push(chars.reverse().join(''));
    } else {
      result.push(tokens[i]);
    }
    i++;
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
  // Apply char-separation fix to each rendered page before filtering.
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
  // pdf-parse sometimes doesn't fire pagerender for certain PDF encodings.
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
  // Apply char-separation fix first, then split into fixed-size virtual pages
  // so the chunker can still produce meaningful, searchable chunks.
  const rawBlob = fixCharSeparatedArabic(
    (ffPages[0] || pageTexts[0] || result.text || '').trim()
  );

  if (rawBlob.length >= MIN_PAGE_CHARS) {
    const virtualPages: string[] = [];
    for (let i = 0; i < rawBlob.length; i += VIRTUAL_PAGE_CHARS) {
      // Break at a word boundary so we don't cut inside a word
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
