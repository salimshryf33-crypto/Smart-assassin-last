/**
 * Frontend API client for the curriculum system.
 *
 * All requests automatically include a Firebase ID token so the backend can
 * identify the caller and enforce ownership / admin checks.
 */
import { getAuth } from 'firebase/auth';

// ─── Types ────────────────────────────────────────────────────────────────────

export interface CurriculumDocMeta {
  id: string;
  country: string;
  grade: string;
  subject: string;
  track: string;
  filename: string;
  totalPages: number;
  chunkCount: number;
  status: 'queued' | 'processing' | 'ocr_running' | 'partial' | 'resuming' | 'done' | 'error';
  errorMessage?: string;
  uploadedAt: number;
  processedAt?: number;
  docType?: 'book' | 'note' | 'exam';
  /** e.g. "النحو والصرف", "فيزياء 3" — distinguishes multiple books per subject. */
  bookTitle?: string;
  /** Firebase UID of the uploader; null for admin-managed public books. */
  ownerId?: string | null;
  /** 'public' = curriculum books visible to all; 'private' = personal notes/exams. */
  visibility: 'public' | 'private';
  extractionMethod?: 'text' | 'virtual' | 'ocr';
  extractedChars?: number;
  avgCharsPerPage?: number;
  extractedPages?: number;
  lastRenderedPage?: number;
  lastResumeAttempt?: number;
  resumeAttempts?: number;
  lastResumeError?: string;
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
  status: 'queued' | 'processing' | 'ocr_running' | 'partial' | 'resuming' | 'done' | 'error';
  progress: { current: number; total: number };
  result?: {
    totalPages: number;
    chunkCount: number;
    extractionMethod?: 'text' | 'virtual' | 'ocr';
    extractedChars?: number;
    avgCharsPerPage?: number;
  };
  error?: string;
  resumeFromPage?: number;
}

export interface MeResponse {
  uid: string;
  isAdmin: boolean;
}

// ─── Auth helper ──────────────────────────────────────────────────────────────

async function getIdToken(): Promise<string | null> {
  try {
    const user = getAuth().currentUser;
    if (!user) return null;
    return await user.getIdToken();
  } catch {
    return null;
  }
}

async function authHeaders(): Promise<HeadersInit> {
  const token = await getIdToken();
  return token ? { Authorization: `Bearer ${token}` } : {};
}

// ─── Base path ────────────────────────────────────────────────────────────────

const BASE = '/api/curriculum';

// ─── Endpoints ────────────────────────────────────────────────────────────────

/** Returns current user's UID and admin flag. */
export async function getMe(): Promise<MeResponse | null> {
  try {
    const res = await fetch(`${BASE}/me`, { headers: await authHeaders() });
    if (!res.ok) return null;
    return res.json();
  } catch {
    return null;
  }
}

export async function uploadCurriculumPdf(
  file: File,
  meta: {
    country: string;
    grade: string;
    subject: string;
    track?: string;
    docType?: 'book' | 'note' | 'exam';
    bookTitle?: string;
  }
): Promise<{ jobId: string; docId: string }> {
  const form = new FormData();
  form.append('pdf', file);
  form.append('country', meta.country);
  form.append('grade', meta.grade);
  form.append('subject', meta.subject);
  form.append('track', meta.track ?? '');
  form.append('docType', meta.docType ?? 'book');
  if (meta.bookTitle?.trim()) form.append('bookTitle', meta.bookTitle.trim());

  const res = await fetch(`${BASE}/upload`, {
    method: 'POST',
    headers: await authHeaders(),
    body: form,
  });
  if (!res.ok) {
    const err = await res.json().catch(() => ({ error: `HTTP ${res.status}` }));
    throw new Error((err as { error?: string }).error ?? 'Upload failed');
  }
  return res.json();
}

export async function getJobStatus(jobId: string): Promise<JobStatus> {
  const res = await fetch(`${BASE}/jobs/${jobId}`, { headers: await authHeaders() });
  if (!res.ok) throw new Error(`Job ${jobId} not found`);
  return res.json();
}

export async function getCurriculumDocs(): Promise<CurriculumDocMeta[]> {
  const res = await fetch(`${BASE}/docs`, { headers: await authHeaders() });
  if (!res.ok) return [];
  return res.json();
}

export async function deleteCurriculumDoc(id: string): Promise<void> {
  const res = await fetch(`${BASE}/docs/${id}`, {
    method: 'DELETE',
    headers: await authHeaders(),
  });
  if (!res.ok) {
    const err = await res.json().catch(() => ({ error: `HTTP ${res.status}` }));
    throw new Error((err as { error?: string }).error ?? 'Delete failed');
  }
}

/**
 * Search curriculum chunks.
 *
 * @param bookTitle  Mode B — restrict to one specific book title.
 *                   Omit for Mode A (all books in the subject).
 */
export async function resumeCurriculumDoc(docId: string): Promise<{
  jobId: string;
  docId: string;
  status: string;
  resumeFromPage: number;
}> {
  const res = await fetch(`${BASE}/docs/${docId}/resume`, {
    method: 'POST',
    headers: await authHeaders(),
  });
  if (!res.ok) {
    const err = await res.json().catch(() => ({ error: `HTTP ${res.status}` }));
    throw new Error((err as { error?: string }).error ?? 'Resume failed');
  }
  return res.json();
}

export async function searchCurriculumApi(
  country: string,
  grade: string,
  subject: string,
  query: string,
  topK = 3,
  bookTitle?: string
): Promise<CurriculumChunk[]> {
  if (!country || !grade || !subject) return [];
  const params = new URLSearchParams({ country, grade, subject, query, topK: String(topK) });
  if (bookTitle) params.set('bookTitle', bookTitle);
  const res = await fetch(`${BASE}/search?${params}`, { headers: await authHeaders() });
  if (!res.ok) return [];
  const data = await res.json();
  return (data as { chunks?: CurriculumChunk[] }).chunks ?? [];
}
