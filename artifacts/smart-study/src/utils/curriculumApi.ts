export interface CurriculumDocMeta {
  id: string;
  country: string;
  grade: string;
  subject: string;
  track: string;
  filename: string;
  totalPages: number;
  chunkCount: number;
  status: 'queued' | 'processing' | 'ocr_running' | 'done' | 'error';
  errorMessage?: string;
  uploadedAt: number;
  processedAt?: number;
  docType?: 'book' | 'note' | 'exam';
  extractionMethod?: 'text' | 'virtual' | 'ocr';
  extractedChars?: number;
  avgCharsPerPage?: number;
  extractedPages?: number;
}

export interface CurriculumChunk {
  id: string;
  docId: string;
  country: string;
  grade: string;
  subject: string;
  chapter: string;
  pageRange: string;
  chunkIndex: number;
  content: string;
  keywords: string[];
}

export interface JobStatus {
  jobId: string;
  docId: string;
  status: 'queued' | 'processing' | 'ocr_running' | 'done' | 'error';
  progress: { current: number; total: number };
  result?: {
    totalPages: number;
    chunkCount: number;
    extractionMethod?: 'text' | 'virtual' | 'ocr';
    extractedChars?: number;
    avgCharsPerPage?: number;
  };
  error?: string;
}

const BASE = '/api/curriculum';

export async function uploadCurriculumPdf(
  file: File,
  meta: { country: string; grade: string; subject: string; track?: string; docType?: 'book' | 'note' | 'exam' }
): Promise<{ jobId: string; docId: string }> {
  const form = new FormData();
  form.append('pdf', file);
  form.append('country', meta.country);
  form.append('grade', meta.grade);
  form.append('subject', meta.subject);
  form.append('track', meta.track ?? '');
  form.append('docType', meta.docType ?? 'book');

  const res = await fetch(`${BASE}/upload`, { method: 'POST', body: form });
  if (!res.ok) {
    const err = await res.json().catch(() => ({ error: `HTTP ${res.status}` }));
    throw new Error(err.error ?? 'Upload failed');
  }
  return res.json();
}

export async function getJobStatus(jobId: string): Promise<JobStatus> {
  const res = await fetch(`${BASE}/jobs/${jobId}`);
  if (!res.ok) throw new Error(`Job ${jobId} not found`);
  return res.json();
}

export async function getCurriculumDocs(): Promise<CurriculumDocMeta[]> {
  const res = await fetch(`${BASE}/docs`);
  if (!res.ok) return [];
  return res.json();
}

export async function deleteCurriculumDoc(id: string): Promise<void> {
  await fetch(`${BASE}/docs/${id}`, { method: 'DELETE' });
}

export async function searchCurriculumApi(
  country: string,
  grade: string,
  subject: string,
  query: string,
  topK = 3
): Promise<CurriculumChunk[]> {
  if (!country || !grade || !subject) return [];
  const params = new URLSearchParams({ country, grade, subject, query, topK: String(topK) });
  const res = await fetch(`${BASE}/search?${params}`);
  if (!res.ok) return [];
  const data = await res.json();
  return data.chunks ?? [];
}
