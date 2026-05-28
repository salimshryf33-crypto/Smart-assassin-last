import { createRequire } from 'node:module';
import fs from 'node:fs';

const require = createRequire(import.meta.url);

type PdfParseResult = {
  text: string;
  numpages: number;
};

// pdf-parse@1.x is CJS — loads correctly at runtime via createRequire.
// It must stay externalized from esbuild (see build.mjs) to prevent
// pdfjs-dist browser APIs (DOMMatrix, etc.) from being bundled.
const pdfParse = require('pdf-parse') as (
  buffer: Buffer,
  options?: { max?: number }
) => Promise<PdfParseResult>;

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

  const result = await pdfParse(buffer, { max: 0 });

  const totalPages = result.numpages;
  onProgress?.(totalPages, totalPages);

  // Split text by form-feed characters (pdf-parse uses \f as page separator)
  const rawPages = result.text.split('\f');

  const pageTexts = rawPages
    .map((p) => p.replace(/\s{3,}/g, '\n').replace(/[ \t]{2,}/g, ' ').trim())
    .filter(Boolean);

  return { pageTexts, totalPages };
}
