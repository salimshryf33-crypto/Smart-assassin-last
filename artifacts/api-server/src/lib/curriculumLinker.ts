/**
 * curriculumLinker.ts
 *
 * Persistent Curriculum Linking Store — Phase 2
 *
 * Manages the permanent many-to-one relationship between exam records and
 * curriculum documents.  PostgreSQL (Neon) is the ONLY source of truth.
 *
 * Workflow:
 *   1. matchAndLink(examId)         — run matcher, persist candidates, auto-approve
 *                                     if confidence ≥ AUTO_APPROVE_THRESHOLD
 *   2. approveLink(examId, docId)   — admin approves (or overrides to different docId)
 *   3. rejectAndRematch(examId)     — admin rejects, fresh match is triggered
 *   4. manualLink(examId, docId)    — admin picks a document directly
 *
 * On approval, two writes happen atomically:
 *   a. curriculum_links row → status = 'approved'
 *   b. exam_records.linked_curriculum_doc_id = approvedDocId
 *
 * The Correction Engine reads (b) — exam_records is the hot path.
 * The curriculum_links table is the audit trail + improvement feedback.
 *
 * Historical consistency:
 *   - Changing a link NEVER updates historical exam_answers rows.
 *   - The new link applies only to future grading attempts.
 *   - curriculum_links.updated_at records when the link changed.
 */

import { v4 as uuidv4 }                    from 'uuid';
import { getSharedPool }                   from './dbPool';
import { logger }                          from './logger';
import {
  matchExamToCurriculum,
  reinforceMatch,
  AUTO_APPROVE_THRESHOLD,
  PENDING_THRESHOLD,
  type MatchCandidate,
}                                          from './curriculumMatcher';
import { examStore }                       from './examStore';

// ─── Public types ─────────────────────────────────────────────────────────────

export type LinkStatus = 'pending_review' | 'approved' | 'rejected' | 'no_match';
export type LinkType   = 'auto' | 'manual';

export interface CurriculumLink {
  id:                  string;
  examId:              string;
  examTitle:           string;
  curriculumDocId:     string;
  linkType:            LinkType;
  status:              LinkStatus;
  confidenceScore:     number | null;
  matchMetadata:       Record<string, unknown> | null;
  approvedBy:          string | null;
  createdAt:           Date;
  updatedAt:           Date;
}

// ─── DB helpers ───────────────────────────────────────────────────────────────

function pool() {
  return getSharedPool();
}

function rowToLink(r: Record<string, unknown>): CurriculumLink {
  return {
    id:              r['id']                as string,
    examId:          r['exam_id']           as string,
    examTitle:       r['exam_title']        as string ?? '',
    curriculumDocId: r['curriculum_doc_id'] as string,
    linkType:        r['link_type']         as LinkType,
    status:          r['status']            as LinkStatus,
    confidenceScore: r['confidence_score'] != null
                       ? parseFloat(r['confidence_score'] as string)
                       : null,
    matchMetadata:   r['match_metadata']    as Record<string, unknown> | null,
    approvedBy:      r['approved_by']       as string | null,
    createdAt:       new Date(r['created_at'] as string),
    updatedAt:       new Date(r['updated_at'] as string),
  };
}

// ─── Read operations ──────────────────────────────────────────────────────────

export async function getLinkByExam(examId: string): Promise<CurriculumLink | null> {
  const res = await pool().query<Record<string, unknown>>(
    `SELECT cl.*, er.title AS exam_title
     FROM public.curriculum_links cl
     LEFT JOIN public.exam_records er ON er.exam_id = cl.exam_id
     WHERE cl.exam_id = $1
     ORDER BY cl.created_at DESC
     LIMIT 1`,
    [examId]
  );
  return res.rows.length > 0 ? rowToLink(res.rows[0]!) : null;
}

export async function listLinks(opts: {
  status?:   LinkStatus;
  limit?:    number;
  offset?:   number;
} = {}): Promise<CurriculumLink[]> {
  const conditions: string[] = [];
  const values: unknown[]    = [];
  let idx = 1;

  if (opts.status) {
    conditions.push(`cl.status = $${idx++}`);
    values.push(opts.status);
  }

  const where  = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';
  const limit  = opts.limit  ?? 100;
  const offset = opts.offset ?? 0;
  values.push(limit, offset);

  const res = await pool().query<Record<string, unknown>>(
    `SELECT cl.*, er.title AS exam_title
     FROM public.curriculum_links cl
     LEFT JOIN public.exam_records er ON er.exam_id = cl.exam_id
     ${where}
     ORDER BY cl.created_at DESC
     LIMIT $${idx++} OFFSET $${idx}`,
    values
  );
  return res.rows.map(rowToLink);
}

export async function listPendingLinks(): Promise<CurriculumLink[]> {
  return listLinks({ status: 'pending_review' });
}

export async function getStats(): Promise<{
  total: number;
  pending: number;
  approved: number;
  rejected: number;
  no_match: number;
  autoApproved: number;
}> {
  const res = await pool().query<{ status: string; link_type: string; count: string }>(
    `SELECT status, link_type, COUNT(*)::text AS count
     FROM public.curriculum_links
     GROUP BY status, link_type`
  );

  const stats = { total: 0, pending: 0, approved: 0, rejected: 0, no_match: 0, autoApproved: 0 };
  for (const r of res.rows) {
    const n = parseInt(r.count, 10);
    stats.total += n;
    if (r.status === 'pending_review') stats.pending      += n;
    if (r.status === 'approved')       stats.approved     += n;
    if (r.status === 'rejected')       stats.rejected     += n;
    if (r.status === 'no_match')       stats.no_match     += n;
    if (r.status === 'approved' && r.link_type === 'auto') stats.autoApproved += n;
  }
  return stats;
}

// ─── Core pipeline ────────────────────────────────────────────────────────────

/**
 * Run the matcher for an exam and persist the result.
 * Called automatically after extraction completes.
 * If confidence ≥ AUTO_APPROVE_THRESHOLD → auto-approved immediately.
 */
export async function matchAndLink(examId: string): Promise<void> {
  logger.info({ examId }, 'curriculumLinker: starting match pipeline');

  const result = await matchExamToCurriculum(examId);
  const best   = result.bestCandidate;

  if (!best) {
    // No curriculum docs available for this country/grade/subject
    await upsertLink({
      examId,
      curriculumDocId: '',
      linkType:        'auto',
      status:          'no_match',
      confidence:      null,
      metadata:        { computedAt: result.computedAt, reason: 'no_docs_found' },
    });
    logger.info({ examId }, 'curriculumLinker: no_match — no curriculum docs found');
    return;
  }

  // ── Effective auto-approve decision ────────────────────────────────────────
  // Two paths to auto-approve:
  //   (a) confidence ≥ AUTO_APPROVE_THRESHOLD (90)
  //   (b) isExplicitLink: the best candidate IS examRecord.curriculumDocId —
  //       i.e. the admin explicitly chose this curriculum at upload time.
  //       We honour that selection without requiring high keyword overlap.
  const effectiveAutoApprove = result.autoApproved || result.isExplicitLink;

  const status: LinkStatus = effectiveAutoApprove
    ? 'approved'
    : best.confidence >= PENDING_THRESHOLD
    ? 'pending_review'
    : 'no_match';

  await upsertLink({
    examId,
    curriculumDocId: best.docId,
    linkType:        'auto',
    status,
    confidence:      best.confidence,
    metadata:        {
      computedAt:     result.computedAt,
      components:     best.components,
      weights:        best.weights,
      isExplicitLink: result.isExplicitLink,
      candidateTitle: best.docTitle,
      candidateDocId: best.docId,
      allCandidates:  result.candidates.slice(0, 5).map((c) => ({
        docId:      c.docId,
        docTitle:   c.docTitle,
        confidence: c.confidence,
      })),
    },
  });

  if (effectiveAutoApprove) {
    // Persist the approved link into exam_records (hot path for Correction Engine)
    await setLinkedDocId(examId, best.docId);
    // Reinforce weights (continuous improvement)
    await reinforceMatch(best.components, true).catch(() => {});
    logger.info(
      { examId, docId: best.docId, confidence: best.confidence, isExplicitLink: result.isExplicitLink },
      'curriculumLinker: auto-approved ✓'
    );
  } else {
    logger.info(
      { examId, docId: best.docId, confidence: best.confidence, status },
      'curriculumLinker: awaiting admin review'
    );
  }
}

// ─── Admin actions ────────────────────────────────────────────────────────────

/**
 * Admin approves the current best candidate or supplies a specific docId.
 */
export async function approveLink(
  examId:     string,
  docId:      string | null,   // null → use the existing candidate
  approvedBy: string
): Promise<CurriculumLink> {
  const existing = await getLinkByExam(examId);
  const finalDocId = docId ?? existing?.curriculumDocId;

  if (!finalDocId) {
    throw new Error(`curriculumLinker: no docId available to approve for exam ${examId}`);
  }

  // Update link record
  await pool().query(
    `INSERT INTO public.curriculum_links
       (id, exam_id, curriculum_doc_id, link_type, status, confidence_score,
        match_metadata, approved_by, created_at, updated_at)
     VALUES ($1, $2, $3, $4, 'approved', $5, $6, $7, now(), now())
     ON CONFLICT (exam_id) DO UPDATE
       SET curriculum_doc_id = $3,
           link_type         = $4,
           status            = 'approved',
           confidence_score  = $5,
           match_metadata    = $6,
           approved_by       = $7,
           updated_at        = now()`,
    [
      existing?.id ?? uuidv4(),
      examId,
      finalDocId,
      existing?.linkType ?? 'manual',
      existing?.confidenceScore ?? null,
      JSON.stringify({
        ...(existing?.matchMetadata ?? {}),
        manualOverride: docId !== null,
        approvedAt: new Date(),
      }),
      approvedBy,
    ]
  );

  // Persist to exam_records (hot path)
  await setLinkedDocId(examId, finalDocId);

  // Continuous improvement: reinforce if we had component data
  if (existing?.matchMetadata?.['components']) {
    const components = existing.matchMetadata['components'] as { metadata: number; keywords: number; chapters: number; temporal: number };
    await reinforceMatch(components, true).catch(() => {});
  }

  logger.info({ examId, finalDocId, approvedBy }, 'curriculumLinker: link approved by admin');
  return (await getLinkByExam(examId))!;
}

/**
 * Admin rejects the current suggestion and triggers a fresh rematch.
 */
export async function rejectAndRematch(
  examId:     string,
  approvedBy: string
): Promise<void> {
  const existing = await getLinkByExam(examId);

  // Mark rejected
  await pool().query(
    `UPDATE public.curriculum_links
     SET status = 'rejected', approved_by = $2, updated_at = now()
     WHERE exam_id = $1`,
    [examId, approvedBy]
  );

  // Continuous improvement: penalise the rejected match
  if (existing?.matchMetadata?.['components']) {
    const components = existing.matchMetadata['components'] as { metadata: number; keywords: number; chapters: number; temporal: number };
    await reinforceMatch(components, false).catch(() => {});
  }

  logger.info({ examId, approvedBy }, 'curriculumLinker: link rejected — rematching');

  // Fire-and-forget rematch
  matchAndLink(examId).catch((err) =>
    logger.error({ err, examId }, 'curriculumLinker: rematch failed')
  );
}

/**
 * Admin directly picks a curriculum document (manual linking).
 */
export async function manualLink(
  examId:     string,
  docId:      string,
  approvedBy: string
): Promise<CurriculumLink> {
  const existing = await getLinkByExam(examId);

  await pool().query(
    `INSERT INTO public.curriculum_links
       (id, exam_id, curriculum_doc_id, link_type, status, confidence_score,
        match_metadata, approved_by, created_at, updated_at)
     VALUES ($1, $2, $3, 'manual', 'approved', NULL, $4, $5, now(), now())
     ON CONFLICT (exam_id) DO UPDATE
       SET curriculum_doc_id = $3,
           link_type         = 'manual',
           status            = 'approved',
           confidence_score  = NULL,
           match_metadata    = $4,
           approved_by       = $5,
           updated_at        = now()`,
    [
      existing?.id ?? uuidv4(),
      examId,
      docId,
      JSON.stringify({ manualLink: true, linkedAt: new Date() }),
      approvedBy,
    ]
  );

  await setLinkedDocId(examId, docId);

  logger.info({ examId, docId, approvedBy }, 'curriculumLinker: manual link set by admin');
  return (await getLinkByExam(examId))!;
}

// ─── Internal helpers ─────────────────────────────────────────────────────────

async function upsertLink(p: {
  examId:         string;
  curriculumDocId: string;
  linkType:        LinkType;
  status:          LinkStatus;
  confidence:      number | null;
  metadata:        Record<string, unknown>;
}): Promise<void> {
  const existing = await getLinkByExam(p.examId);
  await pool().query(
    `INSERT INTO public.curriculum_links
       (id, exam_id, curriculum_doc_id, link_type, status, confidence_score,
        match_metadata, approved_by, created_at, updated_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7, NULL, now(), now())
     ON CONFLICT (exam_id) DO UPDATE
       SET curriculum_doc_id = $3,
           link_type         = $4,
           status            = $5,
           confidence_score  = $6,
           match_metadata    = $7,
           updated_at        = now()`,
    [
      existing?.id ?? uuidv4(),
      p.examId,
      p.curriculumDocId || null,
      p.linkType,
      p.status,
      p.confidence,
      JSON.stringify(p.metadata),
    ]
  );
}

/** Write the approved curriculum doc ID into exam_records (hot path). */
async function setLinkedDocId(examId: string, docId: string): Promise<void> {
  await pool().query(
    `UPDATE public.exam_records
     SET linked_curriculum_doc_id = $2, updated_at = now()
     WHERE exam_id = $1`,
    [examId, docId]
  );
}

// ─── Startup scan ─────────────────────────────────────────────────────────────

/**
 * Scan all 'done' exam records that need (re-)matching:
 *   - no link row at all (brand new exam)
 *   - link exists but status = 'no_match' (previous match failed; retry with new logic)
 *   - link is approved but linked_curriculum_doc_id is still NULL (write race)
 * Called once at server startup and fire-and-forgotten.
 */
export async function scanUnlinkedExams(): Promise<void> {
  logger.info('curriculumLinker: scanning for unlinked / no_match exams…');

  const res = await pool().query<{ exam_id: string }>(
    `SELECT er.exam_id
     FROM public.exam_records er
     LEFT JOIN public.curriculum_links cl ON cl.exam_id = er.exam_id
     WHERE er.extraction_status = 'done'
       AND er.linked_curriculum_doc_id IS NULL
       AND (cl.exam_id IS NULL OR cl.status = 'no_match')
     ORDER BY er.created_at`
  );

  if (res.rows.length === 0) {
    logger.info('curriculumLinker: all done exams already linked');
    return;
  }

  logger.info({ count: res.rows.length }, 'curriculumLinker: found exams to (re-)match, starting batch');

  for (const row of res.rows) {
    try {
      await matchAndLink(row.exam_id);
    } catch (err) {
      logger.error({ err, examId: row.exam_id }, 'curriculumLinker: failed to match exam during scan');
    }
  }

  logger.info({ count: res.rows.length }, 'curriculumLinker: startup scan complete');
}
