import { useState, useRef, useEffect, useCallback } from 'react';
import { motion, AnimatePresence } from 'framer-motion';
import { Send, Trash2, Brain, Sparkles, MessageCircle, BookOpen, Zap, CheckCircle2, XCircle, ChevronRight } from 'lucide-react';
import ReactMarkdown from 'react-markdown';
import remarkMath from 'remark-math';
import rehypeKatex from 'rehype-katex';
import { useAppStore } from '../store/useAppStore';
import { useAuth } from '../contexts/AuthContext';
import { addChatMessageFS, clearChatMessages, saveFlashcard } from '../lib/firestore';
import { useStreak } from '../hooks/useStreak';
import EmptyState from '../components/ui/EmptyState';
import { CurriculumContext } from '../utils/ai';
import { getSubjects, getSubjectLabel } from '../utils/curriculum';
import { formatDate } from '../utils/format';
import { orchestrate, type UnderstandingCheck, type EvaluationResult } from '../lib/engines/aiOrchestrator';
import { evaluateAnswer } from '../lib/engines/flashcardGenEngine';

// ─── Typing indicator ─────────────────────────────────────────────────────────

function TypingIndicator() {
  return (
    <motion.div
      initial={{ opacity: 0, y: 8 }}
      animate={{ opacity: 1, y: 0 }}
      exit={{ opacity: 0, y: 4 }}
      className="flex items-end gap-2 px-4"
    >
      <div
        className="flex h-8 w-8 items-center justify-center rounded-2xl rounded-bl-sm flex-shrink-0"
        style={{
          background: 'linear-gradient(135deg, rgba(0,198,255,0.2) 0%, rgba(0,144,255,0.15) 100%)',
          border: '1px solid rgba(0,198,255,0.25)',
        }}
      >
        <Brain size={14} className="text-[#00c6ff]" />
      </div>
      <div
        className="flex items-center gap-1 rounded-2xl rounded-bl-sm px-4 py-3"
        style={{ background: 'rgba(255,255,255,0.04)', border: '1px solid rgba(255,255,255,0.07)' }}
      >
        {[0, 1, 2].map((i) => (
          <motion.div
            key={i}
            animate={{ scale: [1, 1.5, 1], opacity: [0.3, 1, 0.3] }}
            transition={{ duration: 0.9, delay: i * 0.18, repeat: Infinity }}
            className="h-1.5 w-1.5 rounded-full bg-[#00c6ff]"
          />
        ))}
      </div>
    </motion.div>
  );
}

// ─── Markdown styles ──────────────────────────────────────────────────────────

const markdownStyles = `
  .sage-md p { margin: 0 0 0.55em 0; line-height: 1.65; }
  .sage-md p:last-child { margin-bottom: 0; }
  .sage-md strong { color: #e2e8f0; font-weight: 700; }
  .sage-md em { color: #94a3b8; font-style: italic; }
  .sage-md ul, .sage-md ol { margin: 0.4em 0 0.55em 0; padding-inline-start: 1.25em; }
  .sage-md li { margin-bottom: 0.25em; line-height: 1.6; }
  .sage-md h1, .sage-md h2, .sage-md h3 {
    font-weight: 700; margin: 0.6em 0 0.35em 0; color: #f1f5f9; line-height: 1.3;
  }
  .sage-md h1 { font-size: 1.1em; }
  .sage-md h2 { font-size: 1.0em; }
  .sage-md h3 { font-size: 0.95em; color: #00c6ff; }
  .sage-md code {
    background: rgba(0,198,255,0.1); color: #7dd3fc;
    padding: 0.1em 0.4em; border-radius: 4px; font-size: 0.85em;
    border: 1px solid rgba(0,198,255,0.15);
  }
  .sage-md pre {
    background: rgba(0,0,0,0.35); border: 1px solid rgba(255,255,255,0.08);
    border-radius: 10px; padding: 0.75em 1em; margin: 0.5em 0; overflow-x: auto;
  }
  .sage-md pre code { background: none; border: none; padding: 0; font-size: 0.82em; color: #e2e8f0; }
  .sage-md blockquote {
    border-left: 3px solid rgba(0,198,255,0.4); margin: 0.4em 0;
    padding: 0.2em 0.8em; color: #94a3b8; font-style: italic;
  }
  .sage-md hr { border: none; border-top: 1px solid rgba(255,255,255,0.08); margin: 0.6em 0; }
  .sage-md a { color: #38bdf8; text-decoration: underline; text-decoration-color: rgba(56,189,248,0.4); }
  .sage-md .katex { color: #e2e8f0; font-size: 1em; }
  .sage-md .katex-display {
    margin: 0.75em 0; overflow-x: auto; overflow-y: hidden;
    padding: 0.6em 1em;
    background: rgba(0,198,255,0.05);
    border: 1px solid rgba(0,198,255,0.12);
    border-radius: 10px;
  }
  .sage-md .katex-display .katex { color: #f1f5f9; font-size: 1.1em; }
  .sage-md .katex .mfrac .frac-line { border-color: #94a3b8; }
  .sage-md .katex .sqrt > .root { color: #7dd3fc; }
  .sage-md .katex .mop { color: #93c5fd; }
  .sage-md .katex .mord.text { color: #e2e8f0; }
`;

// ─── Toast ────────────────────────────────────────────────────────────────────

function CardGeneratedToast({ count, onDismiss }: { count: number; onDismiss: () => void }) {
  useEffect(() => {
    const t = setTimeout(onDismiss, 4000);
    return () => clearTimeout(t);
  }, [onDismiss]);

  return (
    <motion.div
      initial={{ opacity: 0, y: -12, scale: 0.95 }}
      animate={{ opacity: 1, y: 0, scale: 1 }}
      exit={{ opacity: 0, y: -8, scale: 0.95 }}
      className="mx-4 mb-2 flex items-center gap-2.5 rounded-2xl px-4 py-3"
      style={{
        background: 'linear-gradient(135deg, rgba(0,198,255,0.12), rgba(0,144,255,0.08))',
        border: '1px solid rgba(0,198,255,0.2)',
      }}
    >
      <Zap size={14} className="text-[#00c6ff] flex-shrink-0" />
      <p className="flex-1 text-xs font-medium text-slate-300">
        {count === 1
          ? '١ بطاقة جديدة أُضيفت تلقائياً!'
          : `${count} بطاقات جديدة أُضيفت تلقائياً!`}
      </p>
      <button onClick={onDismiss}>
        <XCircle size={14} className="text-slate-500" />
      </button>
    </motion.div>
  );
}

// ─── Understanding Check Panel ────────────────────────────────────────────────

function UnderstandingCheckPanel({
  check,
  category,
  onResult,
  onDismiss,
}: {
  check: UnderstandingCheck;
  category: string;
  onResult: (result: EvaluationResult) => void;
  onDismiss: () => void;
}) {
  const [answer, setAnswer] = useState('');
  const [loading, setLoading] = useState(false);

  const handleSubmit = async () => {
    if (!answer.trim() || loading) return;
    setLoading(true);
    try {
      const result = await evaluateAnswer({ check, studentAnswer: answer.trim(), category });
      onResult(result);
    } catch {
      onResult({ understood: true, feedback: 'تعذر التقييم. استمر في الدراسة!', mistakeCard: null });
    } finally {
      setLoading(false);
    }
  };

  return (
    <motion.div
      initial={{ opacity: 0, y: 16 }}
      animate={{ opacity: 1, y: 0 }}
      exit={{ opacity: 0, y: 12 }}
      className="mx-4 mb-2 overflow-hidden rounded-2xl"
      style={{
        background: 'rgba(245,158,11,0.06)',
        border: '1px solid rgba(245,158,11,0.18)',
      }}
    >
      <div className="px-4 pt-3 pb-2">
        <div className="mb-2 flex items-center justify-between">
          <div className="flex items-center gap-1.5">
            <Brain size={13} className="text-amber-400" />
            <span className="text-xs font-semibold text-amber-400">اختبر فهمك</span>
          </div>
          <button onClick={onDismiss} className="text-slate-600">
            <XCircle size={14} />
          </button>
        </div>
        <p className="mb-2.5 text-sm font-medium text-white leading-relaxed">{check.question}</p>
        <textarea
          value={answer}
          onChange={(e) => setAnswer(e.target.value)}
          placeholder="اكتب إجابتك هنا..."
          rows={2}
          className="w-full resize-none rounded-xl p-2.5 text-sm text-white placeholder-slate-600 outline-none"
          style={{ background: 'rgba(255,255,255,0.04)', border: '1px solid rgba(255,255,255,0.08)' }}
        />
        <motion.button
          whileTap={{ scale: 0.97 }}
          onClick={handleSubmit}
          disabled={!answer.trim() || loading}
          className="mt-2 w-full rounded-xl py-2.5 text-xs font-semibold transition-all"
          style={{
            background: answer.trim() && !loading ? 'rgba(245,158,11,0.2)' : 'rgba(255,255,255,0.04)',
            border: answer.trim() && !loading ? '1px solid rgba(245,158,11,0.35)' : '1px solid rgba(255,255,255,0.06)',
            color: answer.trim() && !loading ? '#fbbf24' : '#475569',
          }}
        >
          {loading ? 'جاري التقييم...' : 'تحقق من إجابتي'}
        </motion.button>
      </div>
    </motion.div>
  );
}

// ─── Understanding Result Panel ───────────────────────────────────────────────

function UnderstandingResultPanel({
  result,
  onDismiss,
}: {
  result: EvaluationResult;
  onDismiss: () => void;
}) {
  return (
    <motion.div
      initial={{ opacity: 0, scale: 0.97 }}
      animate={{ opacity: 1, scale: 1 }}
      exit={{ opacity: 0 }}
      className="mx-4 mb-2 rounded-2xl px-4 py-3"
      style={{
        background: result.understood ? 'rgba(52,211,153,0.06)' : 'rgba(248,113,113,0.06)',
        border: `1px solid ${result.understood ? 'rgba(52,211,153,0.2)' : 'rgba(248,113,113,0.2)'}`,
      }}
    >
      <div className="mb-1.5 flex items-center justify-between">
        <div className="flex items-center gap-1.5">
          {result.understood ? (
            <CheckCircle2 size={13} className="text-emerald-400" />
          ) : (
            <XCircle size={13} className="text-red-400" />
          )}
          <span
            className={`text-xs font-semibold ${result.understood ? 'text-emerald-400' : 'text-red-400'}`}
          >
            {result.understood ? 'ممتاز! فهمت المفهوم' : 'راجع هذا المفهوم'}
          </span>
        </div>
        <button onClick={onDismiss} className="text-slate-600">
          <XCircle size={13} />
        </button>
      </div>
      <p className="text-xs text-slate-300 leading-relaxed">{result.feedback}</p>
      {!result.understood && result.mistakeCard && (
        <p className="mt-1.5 text-[11px] text-amber-400/70 flex items-center gap-1">
          <Zap size={10} />
          بطاقة مراجعة أُضيفت لنقطة الضعف هذه
        </p>
      )}
    </motion.div>
  );
}

// ─── Message bubble ───────────────────────────────────────────────────────────

function MessageBubble({ message }: { message: { id: string; role: 'user' | 'assistant'; content: string; timestamp: number } }) {
  const isUser = message.role === 'user';
  return (
    <motion.div
      initial={{ opacity: 0, y: 10, scale: 0.96 }}
      animate={{ opacity: 1, y: 0, scale: 1 }}
      transition={{ duration: 0.3, ease: 'easeOut' }}
      className={`flex items-end gap-2 px-4 ${isUser ? 'flex-row-reverse' : 'flex-row'}`}
    >
      {!isUser && (
        <div
          className="flex h-8 w-8 items-center justify-center rounded-2xl rounded-bl-sm flex-shrink-0 self-start mt-1"
          style={{
            background: 'linear-gradient(135deg, rgba(0,198,255,0.2) 0%, rgba(0,144,255,0.15) 100%)',
            border: '1px solid rgba(0,198,255,0.25)',
          }}
        >
          <Brain size={14} className="text-[#00c6ff]" />
        </div>
      )}
      <div className={`max-w-[80%] ${isUser ? 'items-end' : 'items-start'} flex flex-col gap-1`}>
        <div
          className={`rounded-2xl px-4 py-3 text-sm ${isUser ? 'rounded-br-sm text-white' : 'rounded-bl-sm text-slate-200'}`}
          style={
            isUser
              ? { background: 'linear-gradient(135deg, #0090ff 0%, #0070c0 100%)', boxShadow: '0 4px 16px rgba(0,144,255,0.25)', lineHeight: '1.6' }
              : { background: 'rgba(255,255,255,0.04)', border: '1px solid rgba(255,255,255,0.07)' }
          }
        >
          {isUser ? (
            <span style={{ lineHeight: '1.6', whiteSpace: 'pre-wrap' }}>{message.content}</span>
          ) : (
            <>
              <style>{markdownStyles}</style>
              <div className="sage-md">
                <ReactMarkdown
                  remarkPlugins={[remarkMath]}
                  rehypePlugins={[[rehypeKatex, { strict: false, throwOnError: false, errorColor: '#cc0000' }]]}
                >
                  {message.content}
                </ReactMarkdown>
              </div>
            </>
          )}
        </div>
        <span className="px-1 text-[10px] text-slate-600">{formatDate(message.timestamp)}</span>
      </div>
    </motion.div>
  );
}

// ─── Suggested prompts ────────────────────────────────────────────────────────

const SUGGESTED_PROMPTS = [
  'Help me study for my biology exam',
  'Explain quantum mechanics simply',
  'Give me a study schedule for this week',
  "I'm feeling overwhelmed with studying",
];

// ─── Main component ───────────────────────────────────────────────────────────

export default function AIChat() {
  const chatMessages = useAppStore((s) => s.chatMessages);
  const addChatMessage = useAppStore((s) => s.addChatMessage);
  const clearChat = useAppStore((s) => s.clearChat);
  const flashcards = useAppStore((s) => s.flashcards);
  const addFlashcardLocal = useAppStore((s) => s.addFlashcardLocal);
  const studentProfile = useAppStore((s) => s.studentProfile);
  const { user } = useAuth();
  const { recordActivity } = useStreak();

  const [input, setInput] = useState('');
  const [isTyping, setIsTyping] = useState(false);
  const [selectedSubject, setSelectedSubject] = useState<string | null>(null);
  const [showSubjectPicker, setShowSubjectPicker] = useState(false);
  const [toastCount, setToastCount] = useState(0);
  const [understandingCheck, setUnderstandingCheck] = useState<UnderstandingCheck | null>(null);
  const [checkResult, setCheckResult] = useState<EvaluationResult | null>(null);
  const bottomRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLTextAreaElement>(null);

  const subjects = getSubjects(
    studentProfile?.country ?? '',
    studentProfile?.level ?? '',
    studentProfile?.track ?? ''
  );

  const curriculum: CurriculumContext = {
    country: studentProfile?.country ?? '',
    level: studentProfile?.level ?? '',
    track: studentProfile?.track ?? '',
    subject: selectedSubject,
  };

  const activeSubjectLabel = getSubjectLabel(subjects, selectedSubject);

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [chatMessages, isTyping, understandingCheck, checkResult]);

  // ─── Card save handler (used by orchestrator's onCardsGenerated callback) ──
  const saveGeneratedCards = useCallback(
    (cards: Parameters<typeof addFlashcardLocal>[0][]) => {
      for (const cardData of cards) {
        addFlashcardLocal(cardData);
        if (user?.uid) {
          saveFlashcard(user.uid, cardData).catch((err) =>
            console.error('[Orchestrator] Firestore card save failed:', err)
          );
        }
      }
    },
    [user, addFlashcardLocal]
  );

  // ─── Handle understanding check result ───────────────────────────────────
  const handleCheckResult = useCallback(
    async (result: EvaluationResult) => {
      setCheckResult(result);
      setUnderstandingCheck(null);

      if (!result.understood && result.mistakeCard) {
        const mistakeCardFull = {
          id: `${Date.now()}-${Math.random().toString(36).slice(2, 9)}`,
          createdAt: Date.now(),
          reviewCount: 0,
          front: result.mistakeCard.question,
          back: result.mistakeCard.answer,
          category: result.mistakeCard.category,
          source: 'student_mistake' as const,
          status: 'new' as const,
          easeFactor: 2.5,
          interval: 1,
          repetitions: 0,
          nextReviewDate: Date.now(),
          curriculumTag: {
            country: studentProfile?.country ?? '',
            level: studentProfile?.level ?? '',
            track: studentProfile?.track ?? '',
            subject: selectedSubject ?? '',
          },
        };
        addFlashcardLocal(mistakeCardFull);
        if (user?.uid) {
          saveFlashcard(user.uid, mistakeCardFull).catch(() => {});
        }
      }
    },
    [studentProfile, selectedSubject, user, addFlashcardLocal]
  );

  const sendMessage = async (text?: string) => {
    const content = (text || input).trim();
    if (!content || isTyping) return;

    setInput('');
    setUnderstandingCheck(null);
    setCheckResult(null);

    const userMsg = { role: 'user' as const, content, timestamp: Date.now() };
    addChatMessage({ role: 'user', content });
    if (user?.uid) {
      addChatMessageFS(user.uid, userMsg).catch(() => {});
    }
    setIsTyping(true);

    try {
      const history = chatMessages.map((m) => ({
        role: m.role === 'assistant' ? 'model' : ('user' as 'user' | 'model'),
        parts: [{ text: m.content }],
      }));

      // ── Single orchestrated entry point ──────────────────────────────────
      // Order: subject gate → RAG retrieval gate → Gemini (strict RAG only)
      // Flashcard generation fires async via callback — never delays response.
      const result = await orchestrate(
        {
          message: content,
          history,
          curriculum,
          existingCards: flashcards,
          studentProfile: {
            country: studentProfile?.country ?? '',
            level: studentProfile?.level ?? '',
            track: studentProfile?.track ?? '',
          },
        },
        {
          generateFlashcards: true,
          onCardsGenerated: (cardResult) => {
            if (cardResult.cards.length > 0) {
              const fullCards = cardResult.cards.map((cardData) => ({
                ...cardData,
                id: `${Date.now()}-${Math.random().toString(36).slice(2, 9)}`,
                createdAt: Date.now(),
                reviewCount: 0,
              }));
              saveGeneratedCards(fullCards);
              setToastCount(cardResult.cards.length);
            }
            if (cardResult.understandingCheck) {
              setUnderstandingCheck((prev) => prev ?? cardResult.understandingCheck);
              setCheckResult(null);
            }
          },
        }
      );
      // ─────────────────────────────────────────────────────────────────────

      const response = result.answer.text;

      addChatMessage({ role: 'assistant', content: response });
      if (user?.uid) {
        addChatMessageFS(user.uid, {
          role: 'assistant',
          content: response,
          timestamp: Date.now(),
        }).catch(() => {});
      }

      // Only record streak activity when a real answer was generated
      if (!result.answer.noSubject && !result.answer.noContext) {
        recordActivity('ai_chat', { messageText: content }).catch(() => {});
      }
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      const isQuota =
        msg.includes('QUOTA_EXCEEDED') ||
        msg.includes('quota_exceeded') ||
        msg.includes('429') ||
        msg.includes('quota');
      const isNoKey =
        msg.includes('NO_API_KEY') ||
        msg.includes('not configured') ||
        msg.includes('API_KEY_INVALID') ||
        msg.includes('API key not valid');
      const errorContent = isQuota
        ? 'تجاوزت الحد المجاني لـ Gemini API اليوم. جرب مجدداً غداً أو فعّل الفاتورة على Google AI Studio.'
        : isNoKey
          ? 'مفتاح API غير صحيح أو غير موجود. أضف مفتاحك من الإعدادات أو من Secrets.'
          : `خطأ في الاتصال: ${msg}`;
      addChatMessage({ role: 'assistant', content: errorContent });
    } finally {
      setIsTyping(false);
    }
  };

  const handleClearChat = () => {
    clearChat();
    setUnderstandingCheck(null);
    setCheckResult(null);
    if (user?.uid) {
      clearChatMessages(user.uid).catch(() => {});
    }
  };

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      sendMessage();
    }
  };

  return (
    <div className="flex min-h-screen flex-col" style={{ backgroundColor: '#0a0f1e' }}>
      {/* ── Header ── */}
      <motion.div
        initial={{ opacity: 0, y: -10 }}
        animate={{ opacity: 1, y: 0 }}
        className="flex-shrink-0"
        style={{
          background: 'rgba(10,15,30,0.95)',
          backdropFilter: 'blur(20px)',
          borderBottom: '1px solid rgba(255,255,255,0.05)',
        }}
      >
        <div className="flex items-center justify-between px-5 pt-14 pb-3">
          <div className="flex items-center gap-3">
            <div
              className="flex h-10 w-10 items-center justify-center rounded-2xl"
              style={{
                background: 'linear-gradient(135deg, rgba(0,198,255,0.2) 0%, rgba(0,144,255,0.15) 100%)',
                border: '1px solid rgba(0,198,255,0.3)',
                boxShadow: '0 0 16px rgba(0,198,255,0.15)',
              }}
            >
              <Brain size={18} className="text-[#00c6ff]" />
            </div>
            <div>
              <div className="flex items-center gap-1.5">
                <h1 className="text-base font-bold text-white">Sage</h1>
                <Sparkles size={12} className="text-[#00c6ff]" />
              </div>
              <div className="flex items-center gap-1.5">
                <div className="h-1.5 w-1.5 rounded-full bg-emerald-400" style={{ boxShadow: '0 0 6px rgba(52,211,153,0.8)' }} />
                <p className="text-[11px] text-slate-500">
                  {activeSubjectLabel ? activeSubjectLabel : 'اختر مادة للبدء'}
                </p>
              </div>
            </div>
          </div>
          <div className="flex items-center gap-2">
            {flashcards.filter((c) => c.source && c.source !== 'manual').length > 0 && (
              <div
                className="flex items-center gap-1 rounded-xl px-2.5 py-1.5"
                style={{ background: 'rgba(0,198,255,0.08)', border: '1px solid rgba(0,198,255,0.15)' }}
              >
                <Zap size={11} className="text-[#00c6ff]" />
                <span className="text-[10px] font-medium text-[#00c6ff]">
                  {flashcards.filter((c) => c.source && c.source !== 'manual').length} AI cards
                </span>
              </div>
            )}
            {chatMessages.length > 0 && (
              <motion.button
                whileTap={{ scale: 0.9 }}
                onClick={handleClearChat}
                className="flex items-center gap-1.5 rounded-xl px-3 py-1.5 text-xs text-slate-500"
                style={{ background: 'rgba(248,113,113,0.08)', border: '1px solid rgba(248,113,113,0.15)' }}
              >
                <Trash2 size={12} />
                Clear
              </motion.button>
            )}
          </div>
        </div>

        {/* Subject strip */}
        {subjects.length > 0 && (
          <div className="px-4 pb-3">
            <div className="flex items-center gap-2 overflow-x-auto no-scrollbar pb-1">
              <button
                onClick={() => setShowSubjectPicker((p) => !p)}
                className="flex items-center gap-1.5 flex-shrink-0 rounded-xl px-3 py-1.5 text-xs font-medium transition-all"
                style={{
                  background: showSubjectPicker ? 'rgba(0,198,255,0.15)' : 'rgba(255,255,255,0.04)',
                  border: showSubjectPicker ? '1px solid rgba(0,198,255,0.35)' : '1px solid rgba(255,255,255,0.07)',
                  color: showSubjectPicker ? '#00c6ff' : '#64748b',
                }}
              >
                <BookOpen size={11} />
                المواد
              </button>
              {subjects.map((s) => {
                const isActive = selectedSubject === s.id;
                return (
                  <motion.button
                    key={s.id}
                    whileTap={{ scale: 0.95 }}
                    onClick={() => { setSelectedSubject(isActive ? null : s.id); setShowSubjectPicker(false); }}
                    className="flex items-center gap-1 flex-shrink-0 rounded-xl px-3 py-1.5 text-xs font-medium transition-all"
                    style={{
                      background: isActive ? 'linear-gradient(135deg, rgba(0,144,255,0.25), rgba(0,198,255,0.15))' : 'rgba(255,255,255,0.04)',
                      border: isActive ? '1px solid rgba(0,198,255,0.4)' : '1px solid rgba(255,255,255,0.06)',
                      color: isActive ? '#e2e8f0' : '#64748b',
                      boxShadow: isActive ? '0 0 12px rgba(0,198,255,0.12)' : 'none',
                    }}
                  >
                    <span className="text-[10px]">{s.icon}</span>
                    {s.label}
                  </motion.button>
                );
              })}
            </div>
          </div>
        )}

        {subjects.length > 0 && !selectedSubject && (
          <motion.div
            initial={{ opacity: 0, height: 0 }}
            animate={{ opacity: 1, height: 'auto' }}
            className="mx-4 mb-3 flex items-center gap-2 rounded-xl px-3 py-2 text-xs"
            style={{ background: 'rgba(251,191,36,0.07)', border: '1px solid rgba(251,191,36,0.18)', color: '#fbbf24' }}
          >
            <BookOpen size={12} />
            اختر مادة من القائمة أعلاه حتى يبدأ Sage في التدريس
          </motion.div>
        )}
      </motion.div>

      {/* ── Messages ── */}
      <div className="flex-1 overflow-y-auto py-4 pb-6" style={{ paddingBottom: '100px' }}>
        {chatMessages.length === 0 ? (
          <div className="flex flex-col items-center justify-center h-full min-h-[400px] px-5">
            <EmptyState
              icon={<MessageCircle size={32} />}
              title="Meet Sage, your AI mentor"
              description="I'm here to help you understand any subject, stay motivated, and study smarter. What would you like to explore today?"
            />
            <div className="w-full space-y-2 mt-4">
              <p className="text-xs font-medium text-center text-slate-500 uppercase tracking-wider mb-3">Suggested</p>
              {SUGGESTED_PROMPTS.map((prompt, i) => (
                <motion.button
                  key={prompt}
                  initial={{ opacity: 0, x: -10 }}
                  animate={{ opacity: 1, x: 0 }}
                  transition={{ delay: i * 0.08 }}
                  whileTap={{ scale: 0.98 }}
                  onClick={() => sendMessage(prompt)}
                  className="w-full rounded-2xl px-4 py-3 text-left text-sm text-slate-300 transition-all duration-200"
                  style={{ background: 'rgba(255,255,255,0.03)', border: '1px solid rgba(255,255,255,0.06)' }}
                >
                  {prompt}
                </motion.button>
              ))}
            </div>
          </div>
        ) : (
          <div className="space-y-4">
            {chatMessages.map((msg) => (
              <MessageBubble key={msg.id} message={msg} />
            ))}
            <AnimatePresence>{isTyping && <TypingIndicator />}</AnimatePresence>
            <div ref={bottomRef} />
          </div>
        )}
      </div>

      {/* ── Bottom panel: toast + understanding check ── */}
      <div className="fixed bottom-0 left-0 right-0 z-40">
        <AnimatePresence>
          {toastCount > 0 && (
            <CardGeneratedToast count={toastCount} onDismiss={() => setToastCount(0)} />
          )}
        </AnimatePresence>

        <AnimatePresence>
          {understandingCheck && !checkResult && (
            <UnderstandingCheckPanel
              check={understandingCheck}
              category={selectedSubject ?? 'General'}
              onResult={handleCheckResult}
              onDismiss={() => setUnderstandingCheck(null)}
            />
          )}
        </AnimatePresence>

        <AnimatePresence>
          {checkResult && (
            <UnderstandingResultPanel
              result={checkResult}
              onDismiss={() => setCheckResult(null)}
            />
          )}
        </AnimatePresence>

        {/* Input bar */}
        <motion.div
          initial={{ y: 20, opacity: 0 }}
          animate={{ y: 0, opacity: 1 }}
          transition={{ delay: 0.2 }}
          className="px-4 pb-4"
          style={{ background: 'linear-gradient(to top, rgba(10,15,30,1) 70%, transparent)' }}
        >
          <div
            className="flex items-end gap-2 rounded-3xl p-2 pl-4"
            style={{
              background: 'rgba(13,20,38,0.95)',
              backdropFilter: 'blur(20px)',
              border: '1px solid rgba(255,255,255,0.1)',
              boxShadow: '0 -4px 24px rgba(0,0,0,0.3), 0 0 0 1px rgba(0,198,255,0.05)',
            }}
          >
            <textarea
              ref={inputRef}
              value={input}
              onChange={(e) => setInput(e.target.value)}
              onKeyDown={handleKeyDown}
              placeholder="Ask Sage anything..."
              rows={1}
              className="flex-1 resize-none bg-transparent text-sm text-white placeholder-slate-600 outline-none"
              style={{ maxHeight: '120px', lineHeight: '1.5' }}
            />
            <motion.button
              whileTap={{ scale: 0.9 }}
              whileHover={{ scale: 1.05 }}
              onClick={() => sendMessage()}
              disabled={!input.trim() || isTyping}
              className="flex h-10 w-10 flex-shrink-0 items-center justify-center rounded-2xl transition-all duration-200"
              style={{
                background: input.trim() && !isTyping ? 'linear-gradient(135deg, #0090ff, #00c6ff)' : 'rgba(255,255,255,0.06)',
                boxShadow: input.trim() && !isTyping ? '0 4px 16px rgba(0,144,255,0.3)' : 'none',
              }}
            >
              <Send size={15} className={input.trim() && !isTyping ? 'text-white' : 'text-slate-600'} />
            </motion.button>
          </div>

          {/* Generation hint */}
          <div className="mt-1.5 flex items-center justify-center gap-1">
            <Zap size={9} className="text-slate-700" />
            <span className="text-[10px] text-slate-700">بطاقات تُنشأ تلقائياً من المحادثة</span>
            <ChevronRight size={9} className="text-slate-700" />
          </div>
        </motion.div>
      </div>
    </div>
  );
}
