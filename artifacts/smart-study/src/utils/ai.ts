import { searchCurriculum, formatCurriculumContext } from './curriculumSearch';

export interface CurriculumContext {
  country: string;
  level: string;
  track: string;
  subject: string | null;
}

export function buildSystemPrompt(
  curriculum: CurriculumContext,
  curriculumReference?: string
): string {
  const curriculumBlock = JSON.stringify(curriculum, null, 2);

  const noSubjectBlock =
    curriculum.subject === null
      ? `
IMPORTANT — Subject not selected:
The student has not chosen a subject yet.
Do NOT start teaching.
Politely ask them in Arabic to select a subject from the available list first.
Do not answer any academic question until a subject is provided.
`
      : `
ACTIVE SUBJECT: ${curriculum.subject}
You are now teaching this subject ONLY.
Do not answer questions outside this subject.
`;

  const countryLabel =
    curriculum.country === 'egypt' ? 'مصر (المنهج المصري)' :
    curriculum.country === 'sudan' ? 'السودان (المنهج السوداني)' :
    curriculum.country;

  const levelLabel =
    curriculum.level === 'primary' ? 'المرحلة الابتدائية' :
    curriculum.level === 'preparatory' ? 'المرحلة الإعدادية' :
    curriculum.level === 'secondary' ? 'المرحلة الثانوية' :
    curriculum.level;

  const trackLabel =
    curriculum.track === 'scientific' ? 'العلمي' :
    curriculum.track === 'literary' ? 'الأدبي' :
    curriculum.track || 'غير محدد';

  const referenceBlock = curriculumReference
    ? `${curriculumReference}

==================================================
GROUNDING RULES (CURRICULUM REFERENCE)
==================================================
- The CURRICULUM REFERENCE MATERIAL above is extracted from the official textbook.
- Base your explanation on this material as your primary source.
- You may expand with examples but NEVER contradict the reference.
- Cite the chapter name when relevant (e.g., "كما هو مذكور في فصل ...").
- If the reference does not cover the question, say so honestly and answer from general knowledge within the curriculum scope.
`
    : '';

  return `You are Sage — a Curriculum Engine AI Tutor built for a premium educational app.

==================================================
ROLE
==================================================
You are NOT a generic chatbot.
You are a precise, exam-focused private tutor.
You ONLY operate within the curriculum object provided below.

==================================================
ACTIVE CURRICULUM OBJECT
==================================================
${curriculumBlock}

Country: ${countryLabel}
Level: ${levelLabel}
Track: ${trackLabel}
${noSubjectBlock}
${referenceBlock}
==================================================
STRICT RULES
==================================================
- Never modify or override the curriculum object
- Never guess missing values
- Never mix curricula (Egypt ≠ Sudan — completely different syllabi)
- Never suggest or teach subjects outside the provided curriculum
- Only operate within the active subject
- If the subject is null → ask the student to select a subject first, then STOP

==================================================
TEACHING MODE (when subject is provided)
==================================================
- Teach according to the official exam standards of ${countryLabel}
- Follow the exact syllabus style and structure for that country
- Provide exam-style explanations and practice questions
- Stay strictly within the selected level, track, and subject
- Keep answers short and interactive unless details are requested
- Break ideas into simple steps
- Use clean Arabic — professional and natural, never robotic
- Avoid phrases like: "هذا سؤال رائع" أو "دعنا نبدأ"
- Ask at most one follow-up question per response

==================================================
FORMATTING RULES
==================================================
- Use clean markdown
- Bold only important terms
- Use LaTeX for all math: $inline$ and $$block$$
- Keep responses visually clean and easy to read on mobile

==================================================
GOAL
==================================================
Deliver a highly accurate, exam-focused AI tutor
that strictly follows the assigned curriculum context.
Never break character. Never leave the curriculum scope.`;
}

export interface ConversationMessage {
  role: 'user' | 'model';
  parts: { text: string }[];
}

let cachedModel: string | null = null;

async function discoverModel(): Promise<string> {
  if (cachedModel) return cachedModel;
  try {
    const res = await fetch('/api/gemini/models');
    if (res.ok) {
      const data = await res.json();
      const models: Array<{ name: string; supportedGenerationMethods?: string[] }> = data.models ?? [];
      const match = models.find(
        (m) =>
          Array.isArray(m.supportedGenerationMethods) &&
          m.supportedGenerationMethods.includes('generateContent') &&
          !m.name.includes('vision') &&
          !m.name.includes('embedding') &&
          !m.name.includes('aqa')
      );
      if (match) {
        cachedModel = match.name.replace(/^models\//, '');
        return cachedModel;
      }
    }
  } catch { /* fall through */ }
  // gemini-1.5-flash-latest removed from API — gemini-2.5-flash is the
  // current stable model with 1M token input and generateContent support.
  cachedModel = 'gemini-2.5-flash';
  return cachedModel;
}

export async function generateAIResponse(
  userMessage: string,
  history: ConversationMessage[] = [],
  curriculum?: CurriculumContext
): Promise<string> {
  const modelId = await discoverModel();
  const ctx = curriculum ?? { country: '', level: '', track: '', subject: null };

  // Retrieve curriculum reference from backend (async RAG)
  let curriculumReference: string | undefined;
  if (ctx.country && ctx.level && ctx.subject) {
    try {
      const chunks = await searchCurriculum(ctx.country, ctx.level, ctx.subject, userMessage, 5);
      if (chunks.length > 0) {
        curriculumReference = formatCurriculumContext(chunks);
      }
    } catch { /* proceed without reference */ }
  }

  const systemPrompt = buildSystemPrompt(ctx, curriculumReference);
  const contents: ConversationMessage[] = [
    ...history,
    { role: 'user', parts: [{ text: userMessage }] },
  ];

  const attempts = [
    {
      body: {
        model: modelId,
        system_instruction: { parts: [{ text: systemPrompt }] },
        contents,
        generationConfig: { maxOutputTokens: 1024, temperature: 0.7 },
      },
    },
    {
      body: {
        model: modelId,
        contents: [
          { role: 'user', parts: [{ text: systemPrompt }] },
          { role: 'model', parts: [{ text: 'مفهوم. أنا Sage، مدرسك الخاص. كيف يمكنني مساعدتك؟' }] },
          ...history,
          { role: 'user', parts: [{ text: userMessage }] },
        ],
        generationConfig: { maxOutputTokens: 1024, temperature: 0.7 },
      },
    },
  ];

  let lastError = 'Unknown error';

  for (const attempt of attempts) {
    try {
      const res = await fetch('/api/gemini/generate', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(attempt.body),
      });
      const data = await res.json();
      if (!res.ok) {
        const errMsg: string = data?.error?.message ?? data?.error ?? `HTTP ${res.status}`;
        lastError = String(errMsg);
        if (res.status === 429 || (typeof errMsg === 'string' && (errMsg.toLowerCase().includes('quota') || errMsg.toLowerCase().includes('resource_exhausted')))) {
          throw new Error('quota_exceeded');
        }
        if (typeof errMsg === 'string' && errMsg.toLowerCase().includes('not found')) cachedModel = null;
        continue;
      }
      const text: string = data?.candidates?.[0]?.content?.parts?.[0]?.text ?? '';
      if (!text) { lastError = 'Empty response'; continue; }
      return text;
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      if (msg === 'quota_exceeded') throw err;
      lastError = msg;
      continue;
    }
  }

  throw new Error(lastError);
}
