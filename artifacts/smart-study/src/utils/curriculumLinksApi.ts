/**
 * curriculumLinksApi.ts
 *
 * Frontend API client for the Phase 2 Curriculum Linking admin endpoints.
 * All calls require an authenticated admin session.
 */

import { getAuth } from 'firebase/auth';
import { getAppCheckToken } from '../lib/appCheckToken';

async function authHeaders(): Promise<HeadersInit> {
  try {
    const user = getAuth().currentUser;
    if (!user) return {};
    const [token, acToken] = await Promise.all([user.getIdToken(), getAppCheckToken()]);
    const h: Record<string, string> = { Authorization: `Bearer ${token}` };
    if (acToken) h['X-Firebase-AppCheck'] = acToken;
    return h;
  } catch {
    return {};
  }
}

// ─── Types ────────────────────────────────────────────────────────────────────

export type LinkStatus = 'pending_review' | 'approved' | 'rejected' | 'no_match';
export type LinkType   = 'auto' | 'manual';

export interface MatchComponentScores {
  metadata:  number;
  keywords:  number;
  chapters:  number;
  temporal:  number;
  total:     number;
}

export interface CurriculumLink {
  id:              string;
  examId:          string;
  examTitle:       string;
  curriculumDocId: string | null;
  linkType:        LinkType;
  status:          LinkStatus;
  confidenceScore: number | null;
  matchMetadata:   {
    candidateTitle?:  string;
    candidateDocId?:  string;
    components?:      MatchComponentScores;
    candidatesCount?: number;
    autoApproved?:    boolean;
    [key: string]: unknown;
  } | null;
  approvedBy:  string | null;
  createdAt:   string;
  updatedAt:   string;
}

export interface LinkStats {
  total:    number;
  pending:  number;
  approved: number;
  rejected: number;
  no_match: number;
}

export interface MatchCandidate {
  docId:          string;
  title:          string;
  confidence:     number;
  components:     MatchComponentScores;
}

export interface CandidatesResult {
  examId:        string;
  existing:      CurriculumLink | null;
  candidates:    MatchCandidate[];
  bestCandidate: MatchCandidate | null;
  autoApproved:  boolean;
  computedAt:    string;
}

// ─── API calls ────────────────────────────────────────────────────────────────

export async function fetchLinkStats(): Promise<LinkStats> {
  const res = await fetch('/api/curriculum-links/stats', { headers: await authHeaders() });
  if (!res.ok) throw new Error(`${res.status} ${res.statusText}`);
  return res.json();
}

export async function fetchPendingLinks(): Promise<CurriculumLink[]> {
  const res = await fetch('/api/curriculum-links/pending', { headers: await authHeaders() });
  if (!res.ok) throw new Error(`${res.status} ${res.statusText}`);
  const data = await res.json();
  return data.links ?? [];
}

export async function fetchAllLinks(status?: LinkStatus, limit = 100): Promise<CurriculumLink[]> {
  const qs = new URLSearchParams({ limit: String(limit) });
  if (status) qs.set('status', status);
  const res = await fetch(`/api/curriculum-links?${qs}`, { headers: await authHeaders() });
  if (!res.ok) throw new Error(`${res.status} ${res.statusText}`);
  const data = await res.json();
  return data.links ?? [];
}

export async function fetchCandidates(examId: string): Promise<CandidatesResult> {
  const res = await fetch(`/api/curriculum-links/candidates/${examId}`, { headers: await authHeaders() });
  if (!res.ok) throw new Error(`${res.status} ${res.statusText}`);
  return res.json();
}

export async function approveCurriculumLink(examId: string, docId?: string): Promise<CurriculumLink> {
  const res = await fetch(`/api/curriculum-links/${examId}/approve`, {
    method:  'POST',
    headers: { 'Content-Type': 'application/json', ...(await authHeaders()) },
    body:    JSON.stringify(docId ? { docId } : {}),
  });
  if (!res.ok) throw new Error(`${res.status} ${res.statusText}`);
  const data = await res.json();
  return data.link;
}

export async function rejectCurriculumLink(examId: string): Promise<void> {
  const res = await fetch(`/api/curriculum-links/${examId}/reject`, {
    method:  'POST',
    headers: { 'Content-Type': 'application/json', ...(await authHeaders()) },
    body:    '{}',
  });
  if (!res.ok) throw new Error(`${res.status} ${res.statusText}`);
}

export async function rematchCurriculumLink(examId: string): Promise<void> {
  const res = await fetch(`/api/curriculum-links/${examId}/rematch`, {
    method:  'POST',
    headers: { 'Content-Type': 'application/json', ...(await authHeaders()) },
    body:    '{}',
  });
  if (!res.ok) throw new Error(`${res.status} ${res.statusText}`);
}

/** Re-run matching on ALL no_match / unlinked exams (admin recovery action). */
export async function rematchAllNoMatch(): Promise<void> {
  const res = await fetch('/api/curriculum-links/rematch-all', {
    method:  'POST',
    headers: { 'Content-Type': 'application/json', ...(await authHeaders()) },
    body:    '{}',
  });
  if (!res.ok) throw new Error(`${res.status} ${res.statusText}`);
}

export async function manualCurriculumLink(examId: string, docId: string): Promise<CurriculumLink> {
  const res = await fetch(`/api/curriculum-links/${examId}/manual`, {
    method:  'POST',
    headers: { 'Content-Type': 'application/json', ...(await authHeaders()) },
    body:    JSON.stringify({ docId }),
  });
  if (!res.ok) throw new Error(`${res.status} ${res.statusText}`);
  const data = await res.json();
  return data.link;
}
