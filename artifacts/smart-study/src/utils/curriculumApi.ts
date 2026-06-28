/**
 * Frontend API client for the curriculum + exam system.
 *
 * All requests automatically include a Firebase ID token so the backend can
 * identify the caller and enforce ownership / admin checks.
 */
import { getAuth } from 'firebase/auth';
import { getAppCheckToken } from '../lib/appCheckToken';

// ─── Types — Curriculum ───────────────────────────────────────────────────────

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
  bookTitle?: string;
  ownerId?: string | null;
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

// ─── Types — Exam Bank ────────────────────────────────────────────────────────

export interface ExamRecord {
  examId: string;
  curriculumDocId: string;
  title: string;
  bookTitle?: string | null;
  subject: string;
  grade: string;
  country: string;
  track?: string | null;
  year?: string | null;
  examType: string;
  organization?: string | null;
  ownerId?: string | null;
  visibility: 'public' | 'private';
  questionCount: number;
  extractionStatus: 'pending' | 'extracting' | 'done' | 'error' | 'poor_scan';
  extractionError?: string | null;
  extractedAt?: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface ExamQuestion {
  id: string;
  examId: string;
  question: string;
  questionType: 'mcq' | 'true_false' | 'short_answer' | 'essay' | 'calculation';
  options?: string[] | null;
  correctAnswer?: string | null;
  explanation?: string | null;
  topic?: string | null;
  chapter?: string | null;
  subject: string;
  grade: string;
  country: string;
  year?: string | null;
  examType?: string | null;
  difficulty?: 'easy' | 'medium' | 'hard' | null;
  organization?: string | null;
  questionOrder?: number | null;
}

// ─── Types — Exam Solver ──────────────────────────────────────────────────────

export interface StartAttemptResponse {
  attemptId: string;
  examId: string;
  /** Questions without correct answers — safe for display */
  questions: Omit<ExamQuestion, 'correctAnswer' | 'explanation'>[];
}

export interface ExamAttempt {
  id: string;
  examId: string;
  studentId: string;
  status: 'in_progress' | 'completed' | 'abandoned';
  totalQuestions: number;
  correctCount: number;
  scorePct: string | null;
  startedAt: string;
  completedAt: string | null;
}

export interface ExamAnswer {
  id: string;
  attemptId: string;
  questionId: string;
  studentAnswer: string | null;
  isCorrect: boolean | null;
  gradingMethod: string | null;
  aiFeedback: string | null;
  answeredAt: string;
}

export interface SubmitResult {
  attemptId: string;
  totalQuestions: number;
  correctCount: number;
  scorePct: number;
}

export interface AttemptResults {
  attemptId: string;
  examId: string;
  studentId: string;
  totalQuestions: number;
  correctCount: number;
  scorePct: string | null;
  completedAt: string | null;
  answers: Array<ExamAnswer & {
    questionText: string | null;
    correctAnswer: string | null;
    explanation: string | null;
    topic: string | null;
    chapter: string | null;
    questionType: string | null;
    options: string[] | null;
  }>;
}

export interface FlashcardSeedItem {
  front: string;
  back: string;
  category: string;
  source: 'exam_question';
  examId: string;
  questionId: string;
  studentAnswer: string | null;
  aiFeedback: string | null;
}

// ─── Types — Weakness ─────────────────────────────────────────────────────────

export interface WeakTopicResult {
  subject: string;
  topic: string;
  weaknessScore: number;
  correct: number;
  total: number;
}

export interface WeaknessSnapshot {
  id: number;
  studentId: string;
  country: string;
  grade: string;
  subject: string;
  topicScores: Record<string, { correct: number; total: number; score: number }>;
  totalExams: number;
  lastUpdated: string;
}

// ─── Types — Exam Generator ───────────────────────────────────────────────────

export interface GenerateExamOptions {
  country: string;
  grade: string;
  subject: string;
  track?: string;
  chapter?: string;
  topic?: string;
  year?: string;
  examType?: string;
  organization?: string;
  count?: number;
  title?: string;
  bookTitle?: string;
  typeBreakdown?: Record<string, number>;
}

export interface GenerateExamResult {
  examId: string;
  title: string;
  questionCount: number;
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
  const [token, acToken] = await Promise.all([getIdToken(), getAppCheckToken()]);
  const h: Record<string, string> = {};
  if (token)   h['Authorization']      = `Bearer ${token}`;
  if (acToken) h['X-Firebase-AppCheck'] = acToken;
  return h;
}

async function authJson(): Promise<HeadersInit> {
  const [token, acToken] = await Promise.all([getIdToken(), getAppCheckToken()]);
  const h: Record<string, string> = { 'Content-Type': 'application/json' };
  if (token)   h['Authorization']      = `Bearer ${token}`;
  if (acToken) h['X-Firebase-AppCheck'] = acToken;
  return h;
}

// ─── Base paths ───────────────────────────────────────────────────────────────

const CURR = '/api/curriculum';
const EXAM = '/api/exams';
const RECS = '/api/exams/records';
const SOLV = '/api/exams/solve';

// ─── Curriculum endpoints ─────────────────────────────────────────────────────

export async function getMe(): Promise<MeResponse | null> {
  try {
    const res = await fetch(`${CURR}/me`, { headers: await authHeaders() });
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

  const res = await fetch(`${CURR}/upload`, {
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
  const res = await fetch(`${CURR}/jobs/${jobId}`, { headers: await authHeaders() });
  if (!res.ok) throw new Error(`Job ${jobId} not found`);
  return res.json();
}

export async function getCurriculumDocs(): Promise<CurriculumDocMeta[]> {
  const res = await fetch(`${CURR}/docs`, { headers: await authHeaders() });
  if (!res.ok) return [];
  return res.json();
}

export async function deleteCurriculumDoc(id: string): Promise<void> {
  const res = await fetch(`${CURR}/docs/${id}`, {
    method: 'DELETE',
    headers: await authHeaders(),
  });
  if (!res.ok) {
    const err = await res.json().catch(() => ({ error: `HTTP ${res.status}` }));
    throw new Error((err as { error?: string }).error ?? 'Delete failed');
  }
}

export async function resumeCurriculumDoc(docId: string): Promise<{
  jobId: string;
  docId: string;
  status: string;
  resumeFromPage: number;
}> {
  const res = await fetch(`${CURR}/docs/${docId}/resume`, {
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
  const res = await fetch(`${CURR}/search?${params}`, { headers: await authHeaders() });
  if (!res.ok) return [];
  const data = await res.json();
  return (data as { chunks?: CurriculumChunk[] }).chunks ?? [];
}

// ─── Exam Bank endpoints ──────────────────────────────────────────────────────

export async function listExamRecords(): Promise<ExamRecord[]> {
  const res = await fetch(`${RECS}`, { headers: await authHeaders() });
  if (!res.ok) return [];
  return res.json();
}

export async function getExamRecord(examId: string): Promise<ExamRecord | null> {
  const res = await fetch(`${RECS}/${examId}`, { headers: await authHeaders() });
  if (!res.ok) return null;
  return res.json();
}

export async function getExamQuestions(examId: string): Promise<ExamQuestion[]> {
  const res = await fetch(`${RECS}/${examId}/questions`, { headers: await authHeaders() });
  if (!res.ok) return [];
  const data = await res.json();
  return (data as { questions?: ExamQuestion[] }).questions ?? [];
}

export async function deleteExamRecord(examId: string): Promise<void> {
  const res = await fetch(`${RECS}/${examId}`, {
    method: 'DELETE',
    headers: await authHeaders(),
  });
  if (!res.ok) {
    const err = await res.json().catch(() => ({ error: `HTTP ${res.status}` }));
    throw new Error((err as { error?: string }).error ?? 'Delete failed');
  }
}

/**
 * Search question bank — all params optional.
 * Pass `country` to narrow to the student's curriculum; omit for global view.
 */
export async function searchBankQuestions(opts: {
  country?: string;
  grade?: string;
  subject?: string;
} = {}): Promise<ExamQuestion[]> {
  const params = new URLSearchParams();
  if (opts.country) params.set('country', opts.country);
  if (opts.grade)   params.set('grade',   opts.grade);
  if (opts.subject) params.set('subject', opts.subject);

  const res = await fetch(`${EXAM}/questions?${params}`, { headers: await authHeaders() });
  if (!res.ok) return [];
  const data = await res.json();
  return (data as { questions?: ExamQuestion[] }).questions ?? [];
}

// ─── Exam Solver endpoints ────────────────────────────────────────────────────

/** Start a new exam attempt and get questions (no correct answers). */
export async function startExamAttempt(examId: string): Promise<StartAttemptResponse> {
  const res = await fetch(`${SOLV}/start`, {
    method: 'POST',
    headers: await authJson(),
    body: JSON.stringify({ examId }),
  });
  if (!res.ok) {
    const err = await res.json().catch(() => ({ error: `HTTP ${res.status}` }));
    throw new Error((err as { error?: string }).error ?? 'Failed to start attempt');
  }
  return res.json();
}

/** Save one answer during an in-progress attempt. Can be called multiple times to update. */
export async function submitExamAnswer(
  attemptId: string,
  questionId: string,
  answer: string
): Promise<void> {
  const res = await fetch(`${SOLV}/${attemptId}/answer`, {
    method: 'POST',
    headers: await authJson(),
    body: JSON.stringify({ questionId, answer }),
  });
  if (!res.ok) {
    const err = await res.json().catch(() => ({ error: `HTTP ${res.status}` }));
    throw new Error((err as { error?: string }).error ?? 'Failed to save answer');
  }
}

/** Finalize attempt: triggers auto-grading and weakness analysis. */
export async function submitAttempt(attemptId: string): Promise<SubmitResult> {
  const res = await fetch(`${SOLV}/${attemptId}/submit`, {
    method: 'POST',
    headers: await authJson(),
    body: '{}',
  });
  if (!res.ok) {
    const err = await res.json().catch(() => ({ error: `HTTP ${res.status}` }));
    throw new Error((err as { error?: string }).error ?? 'Failed to submit attempt');
  }
  return res.json();
}

/** Get attempt info and raw answers. */
export async function getAttempt(
  attemptId: string
): Promise<{ attempt: ExamAttempt; answers: ExamAnswer[] }> {
  const res = await fetch(`${SOLV}/${attemptId}`, { headers: await authHeaders() });
  if (!res.ok) throw new Error(`Attempt ${attemptId} not found`);
  return res.json();
}

/** Get full graded results with question text, correct answers, feedback. */
export async function getAttemptResults(attemptId: string): Promise<AttemptResults> {
  const res = await fetch(`${SOLV}/${attemptId}/results`, { headers: await authHeaders() });
  if (!res.ok) {
    const err = await res.json().catch(() => ({ error: `HTTP ${res.status}` }));
    throw new Error((err as { error?: string }).error ?? 'Failed to get results');
  }
  return res.json();
}

/**
 * Get wrong answers formatted as flashcard seed data.
 * Frontend should save them to Firestore with source='exam_question'.
 */
export async function getExamFlashcards(
  attemptId: string
): Promise<{ flashcards: FlashcardSeedItem[]; count: number }> {
  const res = await fetch(`${SOLV}/${attemptId}/flashcards`, { headers: await authHeaders() });
  if (!res.ok) return { flashcards: [], count: 0 };
  return res.json();
}

// ─── Weakness endpoints ───────────────────────────────────────────────────────

/** List all weakness snapshots for the current user. */
export async function listWeaknessSnapshots(): Promise<{ snapshots: WeaknessSnapshot[] }> {
  const res = await fetch(`${SOLV}/weakness/list`, { headers: await authHeaders() });
  if (!res.ok) return { snapshots: [] };
  return res.json();
}

/** Get ranked weak topics for a specific country + grade. */
export async function getWeakTopics(
  country: string,
  grade: string
): Promise<{ topics: WeakTopicResult[] }> {
  const params = new URLSearchParams({ country, grade });
  const res = await fetch(`${SOLV}/weakness/topics?${params}`, { headers: await authHeaders() });
  if (!res.ok) return { topics: [] };
  return res.json();
}

/** List all attempts by the current student, enriched with exam title. */
export interface AttemptWithTitle extends ExamAttempt {
  examTitle: string;
}

export async function listMyAttempts(): Promise<{ attempts: AttemptWithTitle[] }> {
  const res = await fetch(`${SOLV}/attempts`, { headers: await authHeaders() });
  if (!res.ok) return { attempts: [] };
  return res.json();
}

// ─── Exam Coverage Analysis ───────────────────────────────────────────────────

export interface CoverageChunk {
  chunkIndex: number;
  pageRange: string;
  chars: number;
  arabicWords: number;
  questionPatterns: number;
  extracted: number;
  retried: boolean;
  ocrScore: number;
  isLowConfidence: boolean;
  dotRatio: number;
  failureReason: string | null;
  patternDetail: {
    hasNumberedItems: boolean;
    hasQuestionWords: boolean;
    hasQuestionMarks: boolean;
    hasMcqOptions: boolean;
  };
}

export interface ExamCoverageReport {
  examId: string;
  title: string;
  extractionStatus: string;
  questionCount: number;
  ocrQualityScore: number | null;
  extractionAttempts: number | null;
  failureReason: string | null;
  totalChunks: number;
  chunksAttempted: number;
  totalExtracted: number;
  zeroChunkCount: number;
  lowConfChunkCount: number;
  chunks: CoverageChunk[];
}

export async function getExamCoverage(examId: string): Promise<ExamCoverageReport> {
  const res = await fetch(`${EXAM}/records/${examId}/coverage`, { headers: await authHeaders() });
  if (!res.ok) {
    const err = await res.json().catch(() => ({ error: `HTTP ${res.status}` }));
    throw new Error((err as { error?: string }).error ?? 'Failed to load coverage');
  }
  return res.json();
}

// ─── Exam Generator endpoint ──────────────────────────────────────────────────

/**
 * AI-generate a new exam from curriculum chunks.
 * Admin → public exam. Regular user → private practice exam.
 */
export async function generateExam(opts: GenerateExamOptions): Promise<GenerateExamResult> {
  const res = await fetch(`${EXAM}/generate`, {
    method: 'POST',
    headers: await authJson(),
    body: JSON.stringify(opts),
  });
  if (!res.ok) {
    const err = await res.json().catch(() => ({ error: `HTTP ${res.status}` }));
    throw new Error((err as { error?: string }).error ?? 'Exam generation failed');
  }
  return res.json();
}
