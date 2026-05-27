export interface CurriculumContext {
  country: string;
  level: string;
  track: string;
  subject: string | null;
}

export function buildSystemPrompt(curriculum: CurriculumContext): string {
  const curriculumBlock = JSON.stringify(curriculum, null, 2);

  const noSubjectBlock = curriculum.subject === null
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

  return `You are Sage — a Curriculum Engine AI Tutor built for a premium educational app.

==================================================
ROLE
==================================================
You are NOT a generic chatbot.
You are a precise, exam-focused private tutor.
You ONLY operate within the curriculum object provided below.
You did NOT choose this curriculum — it was assigned by the system.

==================================================
ACTIVE CURRICULUM OBJECT
==================================================
${curriculumBlock}

Country: ${countryLabel}
Level: ${levelLabel}
Track: ${trackLabel}
${noSubjectBlock}

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

async function discoverModel(apiKey: string): Promise<string> {
  if (cachedModel) return cachedModel;

  try {
    const res = await fetch(
      `https://generativelanguage.googleapis.com/v1beta/models?key=${apiKey}`
    );
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
        const modelId = match.name.replace(/^models\//, '');
        cachedModel = modelId;
        console.log('[Sage] Using model:', modelId);
        return modelId;
      }
    }
  } catch {
    // fall through
  }

  const fallbacks = [
    'gemini-1.5-flash-latest',
    'gemini-1.5-flash',
    'gemini-1.5-pro',
    'gemini-2.0-flash',
  ];
  cachedModel = fallbacks[0];
  return cachedModel;
}

export async function generateAIResponse(
  userMessage: string,
  history: ConversationMessage[] = [],
  curriculum?: CurriculumContext
): Promise<string> {
  const apiKey = import.meta.env.VITE_GEMINI_API_KEY;
  if (!apiKey) throw new Error('GEMINI_API_KEY not configured');

  const modelId = await discoverModel(apiKey);

  const systemPrompt = buildSystemPrompt(
    curriculum ?? { country: '', level: '', track: '', subject: null }
  );

  const contents: ConversationMessage[] = [
    ...history,
    { role: 'user', parts: [{ text: userMessage }] },
  ];

  const attempts = [
    {
      body: {
        system_instruction: { parts: [{ text: systemPrompt }] },
        contents,
        generationConfig: { maxOutputTokens: 1024, temperature: 0.7 },
      },
      apiVersion: 'v1beta',
    },
    {
      body: {
        contents: [
          { role: 'user', parts: [{ text: systemPrompt }] },
          { role: 'model', parts: [{ text: 'مفهوم. أنا Sage، مدرسك الخاص. كيف يمكنني مساعدتك؟' }] },
          ...history,
          { role: 'user', parts: [{ text: userMessage }] },
        ],
        generationConfig: { maxOutputTokens: 1024, temperature: 0.7 },
      },
      apiVersion: 'v1beta',
    },
  ];

  let lastError = 'Unknown error';

  for (const attempt of attempts) {
    try {
      const url = `https://generativelanguage.googleapis.com/${attempt.apiVersion}/models/${modelId}:generateContent?key=${apiKey}`;
      const res = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(attempt.body),
      });

      const data = await res.json();

      if (!res.ok) {
        const errMsg: string = data?.error?.message ?? `HTTP ${res.status}`;
        lastError = errMsg;
        if (res.status === 429 || errMsg.toLowerCase().includes('quota') || errMsg.toLowerCase().includes('resource_exhausted')) {
          throw new Error('quota_exceeded');
        }
        if (errMsg.toLowerCase().includes('not found')) {
          cachedModel = null;
        }
        continue;
      }

      const text: string = data?.candidates?.[0]?.content?.parts?.[0]?.text ?? '';
      if (!text) {
        lastError = 'Empty response';
        continue;
      }
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
