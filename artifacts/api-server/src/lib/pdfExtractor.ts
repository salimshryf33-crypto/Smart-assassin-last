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

  // Fallback: if pagerender didn't fire (some PDF engines skip it),
  // split by form-feed and use that instead.
  const finalPages =
    pageTexts.length > 1
      ? pageTexts.filter((t) => t.trim().length > 0)
      : result.text
          .split('\f')
          .map((p) => p.replace(/\s{3,}/g, '\n').replace(/[ \t]{2,}/g, ' ').trim())
          .filter(Boolean);

  console.log(`[pdfExtractor] Extracted ${finalPages.length} pages from "${filePath}" (totalPages=${totalPages}, method=${pageTexts.length > 1 ? 'pagerender' : 'split'})`);

  return { pageTexts: finalPages, totalPages };
}
