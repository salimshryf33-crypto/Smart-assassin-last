/**
 * Recovery script: rebuilds exam_records + exam_questions from existing
 * on-disk chunks, and saves PDFs into curriculum_pdfs table.
 *
 * Run with:
 *   DATABASE_URL=... GEMINI_API_KEY=... tsx scripts/recover-exams.ts
 */

import fs from 'node:fs';
import path from 'node:path';
import pg from 'pg';

// ─── Config ───────────────────────────────────────────────────────────────────

const DATA_DIR   = process.env.DATA_DIR ?? path.resolve('artifacts/api-server/data');
const INDEX_PATH = path.join(DATA_DIR, 'curriculum', 'index.json');
const PDFS_DIR   = path.join(DATA_DIR, 'pdfs');

const GEMINI_KEY  = process.env.GEMINI_API_KEY;
const DB_URL      = process.env.DATABASE_URL;
const OWNER_UID   = process.env.ADMIN_UIDS ?? 'JlLBDDgQpkRtgJ3efZ8Lp7yhijr2';

if (!GEMINI_KEY) throw new Error('GEMINI_API_KEY not set');
if (!DB_URL)     throw new Error('DATABASE_URL not set');

const pool = new pg.Pool({
  connectionString: DB_URL,
  ssl: DB_URL.includes('localhost') ? false : { rejectUnauthorized: true },
});

// ─── Types ────────────────────────────────────────────────────────────────────

interface DocMeta {
  id: string;
  country: string;
  grade: string;
  subject: string;
  track?: string;
  filename: string;
  totalPages: number;
  chunkCount: number;
  status: string;
  docType?: string;
  ownerId?: string;
  visibility?: string;
  bookTitle?: string;
  pdfStoragePath?: string;
}

interface Chunk {
  id: string;
  docId: string;
  country: string;
  grade: string;
  subject: string;
  chapter?: string;
  pageRange?: string;
  chunkIndex: number;
  content: string;
}

interface ExtractedQuestion {
  question: string;
  questionType: string;
  options?: string[] | null;
  correctAnswer?: string | null;
  explanation?: string | null;
  topic?: string | null;
  chapter?: string | null;
  difficulty?: string | null;
}

// ─── Gemini call ──────────────────────────────────────────────────────────────

const GEMINI_BASE = 'https://generativelanguage.googleapis.com';
const RATE_LIMIT_DELAYS = [15_000, 30_000, 60_000];

async function callGemini(prompt: string, attempt = 0): Promise<string> {
  const res = await fetch(
    `${GEMINI_BASE}/v1beta/models/gemini-2.5-flash:generateContent?key=${GEMINI_KEY}`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        contents: [{ role: 'user', parts: [{ text: prompt }] }],
        generationConfig: { maxOutputTokens: 32768, temperature: 0.1 },
      }),
    }
  );

  if (res.status === 429 && attempt < RATE_LIMIT_DELAYS.length) {
    const delay = RATE_LIMIT_DELAYS[attempt]!;
    console.log(`  Rate limited (429). Waiting ${delay/1000}s before retry ${attempt+1}...`);
    await new Promise(r => setTimeout(r, delay));
    return callGemini(prompt, attempt + 1);
  }

  if (!res.ok) {
    const data = await res.json().catch(() => ({}));
    throw new Error(`Gemini error ${res.status}: ${JSON.stringify(data)}`);
  }

  const data = await res.json() as any;
  return data?.candidates?.[0]?.content?.parts?.[0]?.text ?? '';
}

function compressFillerDots(text: string): string {
  return text.replace(/\.{4,}/g, '....').replace(/_{4,}/g, '____');
}

function buildPrompt(chunkText: string, examTitle: string): string {
  const compressed = compressFillerDots(chunkText);
  return `أنت نظام استخراج أسئلة امتحانات للمحتوى التعليمي العربي.

استخرج كل الأسئلة من نص الامتحان التالي. أعد مصفوفة JSON فقط.
كل عنصر يجب أن يكون:
{
  "question": "<نص السؤال كاملاً بالعربي>",
  "questionType": "mcq" | "true_false" | "short_answer" | "essay" | "calculation",
  "options": ["أ) ...", "ب) ...", "ج) ...", "د) ..."] أو null للأسئلة المقالية,
  "correctAnswer": "<الإجابة الصحيحة أو null إذا لم تذكر في النص>",
  "explanation": "<الشرح إن وُجد أو null>",
  "topic": "<الموضوع إن وُجد>",
  "chapter": "<الفصل إن وُجد>",
  "difficulty": "easy" | "medium" | "hard" | null
}

قواعد:
- استخرج الأسئلة الفعلية فقط. تجاهل العناوين والتعليمات وأرقام الصفحات.
- للاختيار من متعدد، ضع الخيارات في "options".
- أعد مصفوفة JSON نقية فقط بدون markdown أو تفسيرات.
- إذا لم توجد أسئلة، أعد [].

عنوان الامتحان: ${examTitle}

نص الامتحان:
${compressed}`;
}

function parseQuestions(raw: string): ExtractedQuestion[] {
  const cleaned = raw
    .replace(/^```json\s*/i, '')
    .replace(/^```\s*/i, '')
    .replace(/```\s*$/i, '')
    .trim();

  const match = cleaned.match(/\[[\s\S]*\]/);
  if (!match) return [];

  try {
    const parsed = JSON.parse(match[0]);
    if (!Array.isArray(parsed)) return [];
    return parsed.filter(q => q && typeof q.question === 'string' && q.question.length > 5);
  } catch {
    return [];
  }
}

// ─── DB helpers ───────────────────────────────────────────────────────────────

async function upsertExamRecord(rec: {
  examId: string; curriculumDocId: string; title: string; bookTitle?: string;
  subject: string; grade: string; country: string; track?: string;
  ownerId?: string; visibility: string; extractionStatus: string;
  questionCount?: number; extractedAt?: Date | null;
}): Promise<void> {
  await pool.query(`
    INSERT INTO exam_records
      (exam_id, curriculum_doc_id, title, book_title, subject, grade, country, track,
       owner_id, visibility, extraction_status, question_count, extracted_at,
       exam_type, created_at, updated_at)
    VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,'final',NOW(),NOW())
    ON CONFLICT (exam_id) DO UPDATE SET
      extraction_status = EXCLUDED.extraction_status,
      question_count    = EXCLUDED.question_count,
      extracted_at      = EXCLUDED.extracted_at,
      updated_at        = NOW()
  `, [
    rec.examId, rec.curriculumDocId, rec.title, rec.bookTitle ?? null,
    rec.subject, rec.grade, rec.country, rec.track ?? null,
    rec.ownerId ?? null, rec.visibility, rec.extractionStatus,
    rec.questionCount ?? 0, rec.extractedAt ?? null,
  ]);
}

async function saveQuestions(questions: Array<{
  id: string; examId: string; question: string; questionType: string;
  options: any; correctAnswer: string | null; explanation: string | null;
  topic: string | null; chapter: string | null; subject: string;
  grade: string; country: string; difficulty: string | null;
  sourceExamId: string; sourceExamTitle: string; questionOrder: number;
}>): Promise<void> {
  if (questions.length === 0) return;
  for (let i = 0; i < questions.length; i += 50) {
    const batch = questions.slice(i, i + 50);
    const values = batch.map((q, idx) => {
      const base = idx * 13;
      return `($${base+1},$${base+2},$${base+3},$${base+4},$${base+5},$${base+6},$${base+7},$${base+8},$${base+9},$${base+10},$${base+11},$${base+12},$${base+13})`;
    }).join(',');

    const params = batch.flatMap(q => [
      q.id, q.examId, q.question, q.questionType,
      q.options ? JSON.stringify(q.options) : null,
      q.correctAnswer, q.explanation, q.topic, q.chapter,
      q.subject, q.grade, q.country,
      q.difficulty,
    ]);

    await pool.query(`
      INSERT INTO exam_questions
        (id, exam_id, question, question_type, options, correct_answer, explanation,
         topic, chapter, subject, grade, country, difficulty,
         source_exam_id, source_exam_title, question_order, extracted_at)
      SELECT v.id, v.exam_id, v.question, v.question_type, v.options::jsonb,
             v.correct_answer, v.explanation, v.topic, v.chapter,
             v.subject, v.grade, v.country, v.difficulty,
             v.exam_id, er.title, ROW_NUMBER() OVER (PARTITION BY v.exam_id ORDER BY v.id),
             NOW()
      FROM (VALUES ${values}) AS v(id,exam_id,question,question_type,options,correct_answer,
                                   explanation,topic,chapter,subject,grade,country,difficulty)
      JOIN exam_records er ON er.exam_id = v.exam_id
      ON CONFLICT (id) DO NOTHING
    `, params);
  }
}

async function savePdfToDb(docId: string, filePath: string): Promise<void> {
  if (!fs.existsSync(filePath)) {
    console.log(`  ⚠️  PDF not found on disk: ${filePath}`);
    return;
  }
  const content = fs.readFileSync(filePath);
  await pool.query(`
    INSERT INTO curriculum_pdfs (doc_id, content, byte_size, updated_at)
    VALUES ($1,$2,$3,NOW())
    ON CONFLICT (doc_id) DO UPDATE SET
      content    = EXCLUDED.content,
      byte_size  = EXCLUDED.byte_size,
      updated_at = NOW()
  `, [docId, content, content.length]);
  console.log(`  ✓ PDF saved to DB: ${docId} (${(content.length/1024).toFixed(0)} KB)`);
}

// ─── Main recovery ────────────────────────────────────────────────────────────

async function recoverExam(doc: DocMeta): Promise<void> {
  const docId    = doc.id;
  const examId   = docId; // examIdFromDocId returns docId itself
  const title    = doc.bookTitle ?? doc.filename ?? `Exam ${docId.slice(0,8)}`;

  console.log(`\n════════════════════════════════════════`);
  console.log(`Recovering: ${title}`);
  console.log(`  docId=${docId} subject=${doc.subject} grade=${doc.grade}`);

  // 1. Save PDF to DB
  const pdfPath = path.join(PDFS_DIR, `${docId}.pdf`);
  await savePdfToDb(docId, pdfPath);

  // 2. Load chunks from disk
  const chunksPath = path.join(DATA_DIR, 'curriculum', 'docs', `${docId}.json`);
  if (!fs.existsSync(chunksPath)) {
    console.log(`  ✗ Chunks file not found, skipping`);
    return;
  }
  const chunks: Chunk[] = JSON.parse(fs.readFileSync(chunksPath, 'utf8'));
  console.log(`  Loaded ${chunks.length} chunks`);

  // 3. Create exam_record with status 'extracting'
  await upsertExamRecord({
    examId, curriculumDocId: docId, title,
    bookTitle: doc.bookTitle,
    subject: doc.subject, grade: doc.grade,
    country: doc.country, track: doc.track,
    ownerId: doc.ownerId ?? OWNER_UID,
    visibility: doc.visibility ?? 'private',
    extractionStatus: 'extracting',
  });
  console.log(`  ✓ exam_record created (status=extracting)`);

  // 4. Extract questions from each chunk
  const allQuestions: ExtractedQuestion[] = [];
  let chunkIdx = 0;

  for (const chunk of chunks) {
    chunkIdx++;
    if (!chunk.content || chunk.content.trim().length < 80) {
      console.log(`  Chunk ${chunkIdx}/${chunks.length}: skipped (too short)`);
      continue;
    }

    console.log(`  Chunk ${chunkIdx}/${chunks.length}: pages=${chunk.pageRange ?? '?'} chars=${chunk.content.length} — calling Gemini...`);

    try {
      const prompt = buildPrompt(chunk.content, title);
      const raw    = await callGemini(prompt);
      const qs     = parseQuestions(raw);
      console.log(`    → extracted ${qs.length} questions`);
      allQuestions.push(...qs);
    } catch (err) {
      console.log(`    ✗ Gemini error: ${err instanceof Error ? err.message : err}`);
    }

    // Small delay between chunks to avoid rate limits
    if (chunkIdx < chunks.length) {
      await new Promise(r => setTimeout(r, 2000));
    }
  }

  // 5. Deduplicate questions
  const seen = new Set<string>();
  const unique = allQuestions.filter(q => {
    const key = q.question.trim().slice(0, 80);
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });

  console.log(`  Total extracted: ${allQuestions.length}, after dedup: ${unique.length}`);

  // 6. Save questions to DB
  if (unique.length > 0) {
    const rows = unique.map((q, i) => ({
      id:            `${examId}-q${String(i+1).padStart(4,'0')}`,
      examId,
      question:      q.question,
      questionType:  q.questionType ?? 'short_answer',
      options:       q.options ?? null,
      correctAnswer: q.correctAnswer ?? null,
      explanation:   q.explanation ?? null,
      topic:         q.topic ?? null,
      chapter:       q.chapter ?? null,
      subject:       doc.subject,
      grade:         doc.grade,
      country:       doc.country,
      difficulty:    q.difficulty ?? null,
      sourceExamId:  examId,
      sourceExamTitle: title,
      questionOrder: i + 1,
    }));

    // Need to insert directly since saveQuestions needs a JOIN
    for (let i = 0; i < rows.length; i++) {
      const r = rows[i]!;
      await pool.query(`
        INSERT INTO exam_questions
          (id, exam_id, question, question_type, options, correct_answer, explanation,
           topic, chapter, subject, grade, country, difficulty,
           source_exam_id, source_exam_title, question_order, extracted_at)
        VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,NOW())
        ON CONFLICT (id) DO NOTHING
      `, [
        r.id, r.examId, r.question, r.questionType,
        r.options ? JSON.stringify(r.options) : null,
        r.correctAnswer, r.explanation, r.topic, r.chapter,
        r.subject, r.grade, r.country, r.difficulty,
        r.sourceExamId, r.sourceExamTitle, r.questionOrder,
      ]);
    }
    console.log(`  ✓ Saved ${rows.length} questions to DB`);
  }

  // 7. Update exam_record with final status
  const status = unique.length > 0 ? 'done' : 'error';
  await upsertExamRecord({
    examId, curriculumDocId: docId, title,
    bookTitle: doc.bookTitle,
    subject: doc.subject, grade: doc.grade,
    country: doc.country, track: doc.track,
    ownerId: doc.ownerId ?? OWNER_UID,
    visibility: doc.visibility ?? 'private',
    extractionStatus: status,
    questionCount: unique.length,
    extractedAt: new Date(),
  });
  console.log(`  ✓ exam_record updated: status=${status} questions=${unique.length}`);
}

// ─── Entry point ──────────────────────────────────────────────────────────────

async function main() {
  console.log('╔══════════════════════════════════════════════╗');
  console.log('║     EXAM RECOVERY SCRIPT — Smart Study       ║');
  console.log('╚══════════════════════════════════════════════╝\n');

  // Load index
  const docs: DocMeta[] = JSON.parse(fs.readFileSync(INDEX_PATH, 'utf8'));
  const examDocs = docs.filter(d => d.docType === 'exam');

  console.log(`Found ${docs.length} total docs, ${examDocs.length} exam docs to recover:`);
  for (const d of examDocs) {
    console.log(`  - ${d.bookTitle ?? d.filename} (${d.id})`);
  }

  // Verify DB tables exist
  const tablesRes = await pool.query(`
    SELECT table_name FROM information_schema.tables
    WHERE table_schema='public' ORDER BY table_name
  `);
  console.log(`\nDB tables present: ${tablesRes.rows.map(r => r.table_name).join(', ')}`);

  // Recover each exam — with 45s cooldown between exams to avoid rate limits
  let recovered = 0;
  let failed    = 0;

  for (let i = 0; i < examDocs.length; i++) {
    if (i > 0) {
      console.log('\n⏳ Waiting 45s between exams to avoid rate limits...');
      await new Promise(r => setTimeout(r, 45_000));
    }
    try {
      await recoverExam(examDocs[i]!);
      recovered++;
    } catch (err) {
      console.log(`  ✗ Failed: ${err instanceof Error ? err.message : err}`);
      failed++;
    }
  }

  // Final verification
  console.log('\n════════════════════════════════════════');
  console.log('VERIFICATION:');
  const recCount = await pool.query('SELECT COUNT(*) FROM exam_records');
  const qCount   = await pool.query('SELECT COUNT(*) FROM exam_questions');
  const pdfCount = await pool.query('SELECT COUNT(*) FROM curriculum_pdfs');

  console.log(`  exam_records:    ${recCount.rows[0].count} rows`);
  console.log(`  exam_questions:  ${qCount.rows[0].count} rows`);
  console.log(`  curriculum_pdfs: ${pdfCount.rows[0].count} rows`);
  console.log(`\n  Recovered: ${recovered}  Failed: ${failed}`);

  await pool.end();
  console.log('\n✅ Recovery complete!');
}

main().catch(err => {
  console.error('FATAL:', err);
  process.exit(1);
});
