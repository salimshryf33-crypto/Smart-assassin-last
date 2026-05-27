import fs from 'node:fs';

type PdfPageData = {
  pageIndex: number;
  getTextContent: () => Promise<{ items: Array<{ str: string }> }>;
};

type PdfParseResult = { text: string; numpages: number };

type PdfParseFn = (
  buffer: Buffer,
  options?: {
    pagerender?: (page: PdfPageData) => Promise<string>;
    max?: number;
  }
) => Promise<PdfParseResult>;

async function getPdfParse(): Promise<PdfParseFn> {
  // pdf-parse is CJS — handle both .default and direct export
  const mod = await import('pdf-parse');
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const m = mod as any;
  return (m.default ?? m) as PdfParseFn;
}

export interface ExtractionResult {
  pageTexts: string[];
  totalPages: number;
}

export async function extractPdf(
  filePath: string,
  onProgress?: (current: number, total: number) => void
): Promise<ExtractionResult> {
  const buffer = fs.readFileSync(filePath);
  const pdfParse = await getPdfParse();

  const pageTexts: string[] = [];
  let resolvedTotal = 0;

  await pdfParse(buffer, {
    pagerender(pageData: PdfPageData) {
      return pageData.getTextContent().then((content) => {
        const text = content.items
          .map((item) => item.str)
          .join(' ')
          .replace(/\s{2,}/g, ' ')
          .trim();
        pageTexts[pageData.pageIndex] = text;
        onProgress?.(pageData.pageIndex + 1, Math.max(resolvedTotal, pageTexts.length));
        return text;
      });
    },
    max: 0,
  }).then((data) => {
    resolvedTotal = data.numpages;
  });

  const total = resolvedTotal || pageTexts.length;
  onProgress?.(total, total);

  return { pageTexts: pageTexts.filter(Boolean), totalPages: total };
}
