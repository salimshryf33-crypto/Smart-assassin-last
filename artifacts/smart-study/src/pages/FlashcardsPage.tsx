import { useState } from 'react';
import { motion, AnimatePresence, useMotionValue, useTransform, PanInfo } from 'framer-motion';
import { Plus, Trash2, BookOpen, X, Check, RotateCcw } from 'lucide-react';
import { useAppStore, Flashcard } from '../store/useAppStore';
import { useAuth } from '../contexts/AuthContext';
import { saveFlashcard, deleteFlashcardFS } from '../lib/firestore';
import { useStreak } from '../hooks/useStreak';
import PageWrapper from '../components/layout/PageWrapper';
import EmptyState from '../components/ui/EmptyState';
import { useSounds } from '../hooks/useSounds';

function CategoryPill({ label, active, onClick, count }: { label: string; active: boolean; onClick: () => void; count: number }) {
  return (
    <motion.button
      whileTap={{ scale: 0.94 }}
      onClick={onClick}
      className="flex items-center gap-1.5 rounded-full px-3.5 py-1.5 text-xs font-semibold transition-all duration-200"
      style={{
        background: active
          ? 'linear-gradient(135deg, rgba(0,144,255,0.35) 0%, rgba(0,198,255,0.2) 100%)'
          : 'rgba(255,255,255,0.04)',
        border: active ? '1px solid rgba(0,198,255,0.4)' : '1px solid rgba(255,255,255,0.07)',
        color: active ? '#00c6ff' : '#94a3b8',
        boxShadow: active ? '0 0 12px rgba(0,198,255,0.15)' : 'none',
      }}
    >
      {label}
      <span
        className="rounded-full px-1.5 py-0.5 text-[9px]"
        style={{ background: active ? 'rgba(0,198,255,0.2)' : 'rgba(255,255,255,0.08)' }}
      >
        {count}
      </span>
    </motion.button>
  );
}

function FlipCard({ card, onNext, onCorrect, onWrong }: {
  card: Flashcard;
  onNext: () => void;
  onCorrect: () => void;
  onWrong: () => void;
}) {
  const [flipped, setFlipped] = useState(false);
  const { onFlashcardFlipSound } = useSounds();
  const x = useMotionValue(0);
  const rotate = useTransform(x, [-200, 200], [-20, 20]);
  const opacity = useTransform(x, [-200, -100, 0, 100, 200], [0, 1, 1, 1, 0]);
  const rightIndicator = useTransform(x, [0, 100], [0, 1]);
  const leftIndicator = useTransform(x, [-100, 0], [1, 0]);

  const handleDragEnd = (_: unknown, info: PanInfo) => {
    if (info.offset.x > 100) {
      onCorrect();
      setFlipped(false);
    } else if (info.offset.x < -100) {
      onWrong();
      setFlipped(false);
    }
  };

  const handleFlip = () => {
    setFlipped((f) => !f);
    onFlashcardFlipSound();
  };

  return (
    <div className="relative flex flex-col items-center">
      <div className="pointer-events-none absolute inset-0 flex items-center justify-between px-4 z-20">
        <motion.div
          style={{ opacity: leftIndicator }}
          className="flex h-14 w-14 items-center justify-center rounded-2xl"
          transition={{ duration: 0 }}
          animate={{}}
        >
          <div className="flex h-12 w-12 items-center justify-center rounded-full"
            style={{ background: 'rgba(248,113,113,0.2)', border: '2px solid rgba(248,113,113,0.5)' }}>
            <X size={20} className="text-red-400" />
          </div>
        </motion.div>
        <motion.div
          style={{ opacity: rightIndicator }}
          className="flex h-14 w-14 items-center justify-center rounded-2xl"
          transition={{ duration: 0 }}
          animate={{}}
        >
          <div className="flex h-12 w-12 items-center justify-center rounded-full"
            style={{ background: 'rgba(52,211,153,0.2)', border: '2px solid rgba(52,211,153,0.5)' }}>
            <Check size={20} className="text-emerald-400" />
          </div>
        </motion.div>
      </div>

      <motion.div
        drag="x"
        dragConstraints={{ left: -300, right: 300 }}
        dragElastic={0.1}
        onDragEnd={handleDragEnd}
        style={{ x, rotate, opacity }}
        className="w-full cursor-grab active:cursor-grabbing"
      >
        <div
          className="relative"
          style={{ perspective: '1200px' }}
          onClick={handleFlip}
        >
          <motion.div
            animate={{ rotateY: flipped ? 180 : 0 }}
            transition={{ duration: 0.5, ease: [0.25, 0.46, 0.45, 0.94] }}
            style={{ transformStyle: 'preserve-3d' }}
            className="relative"
          >
            <div
              className="min-h-[260px] w-full rounded-3xl p-7 flex flex-col items-center justify-center"
              style={{
                backfaceVisibility: 'hidden',
                WebkitBackfaceVisibility: 'hidden',
                background: 'linear-gradient(135deg, rgba(0,198,255,0.08) 0%, rgba(0,80,160,0.12) 100%)',
                border: '1px solid rgba(0,198,255,0.2)',
                boxShadow: '0 8px 40px rgba(0,0,0,0.4), 0 0 0 1px rgba(0,198,255,0.05)',
              }}
            >
              <div
                className="mb-4 rounded-xl px-3 py-1 text-xs font-semibold"
                style={{ background: 'rgba(0,198,255,0.1)', color: '#00c6ff', border: '1px solid rgba(0,198,255,0.2)' }}
              >
                {card.category}
              </div>
              <p className="text-center text-xl font-semibold leading-relaxed text-white">
                {card.front}
              </p>
              <div className="mt-6 flex items-center gap-1.5">
                <RotateCcw size={12} className="text-slate-500" />
                <span className="text-xs text-slate-500">Tap to reveal answer</span>
              </div>
            </div>

            <div
              className="absolute inset-0 min-h-[260px] w-full rounded-3xl p-7 flex flex-col items-center justify-center"
              style={{
                backfaceVisibility: 'hidden',
                WebkitBackfaceVisibility: 'hidden',
                transform: 'rotateY(180deg)',
                background: 'linear-gradient(135deg, rgba(52,211,153,0.08) 0%, rgba(16,185,129,0.05) 100%)',
                border: '1px solid rgba(52,211,153,0.2)',
                boxShadow: '0 8px 40px rgba(0,0,0,0.4), 0 0 0 1px rgba(52,211,153,0.05)',
              }}
            >
              <div
                className="mb-4 rounded-xl px-3 py-1 text-xs font-semibold"
                style={{ background: 'rgba(52,211,153,0.1)', color: '#34d399', border: '1px solid rgba(52,211,153,0.2)' }}
              >
                Answer
              </div>
              <p className="text-center text-base leading-relaxed text-slate-200">
                {card.back}
              </p>
            </div>
          </motion.div>
        </div>
      </motion.div>

      <AnimatePresence>
        {flipped && (
          <motion.div
            initial={{ opacity: 0, y: 12 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0, y: 8 }}
            className="mt-5 flex gap-4"
          >
            <motion.button
              whileTap={{ scale: 0.93 }}
              onClick={() => { onWrong(); setFlipped(false); }}
              className="flex h-14 w-14 items-center justify-center rounded-2xl"
              style={{ background: 'rgba(248,113,113,0.15)', border: '1px solid rgba(248,113,113,0.3)' }}
            >
              <X size={22} className="text-red-400" />
            </motion.button>
            <motion.button
              whileTap={{ scale: 0.93 }}
              onClick={() => { onNext(); setFlipped(false); }}
              className="flex h-14 flex-1 items-center justify-center gap-2 rounded-2xl"
              style={{ background: 'rgba(148,163,184,0.08)', border: '1px solid rgba(255,255,255,0.08)' }}
            >
              <span className="text-sm text-slate-400">Skip</span>
            </motion.button>
            <motion.button
              whileTap={{ scale: 0.93 }}
              onClick={() => { onCorrect(); setFlipped(false); }}
              className="flex h-14 w-14 items-center justify-center rounded-2xl"
              style={{ background: 'rgba(52,211,153,0.15)', border: '1px solid rgba(52,211,153,0.3)' }}
            >
              <Check size={22} className="text-emerald-400" />
            </motion.button>
          </motion.div>
        )}
      </AnimatePresence>

      <p className="mt-4 text-xs text-slate-500">Swipe right = know it · Swipe left = review again</p>
    </div>
  );
}

export default function FlashcardsPage() {
  const { flashcards, addFlashcard, deleteFlashcard, updateFlashcard } = useAppStore();
  const { user } = useAuth();
  const { recordActivity } = useStreak();
  const [activeCategory, setActiveCategory] = useState('All');
  const [cardIndex, setCardIndex] = useState(0);
  const [showAdd, setShowAdd] = useState(false);
  const [newFront, setNewFront] = useState('');
  const [newBack, setNewBack] = useState('');
  const [newCategory, setNewCategory] = useState('General');
  const { onSuccessSound } = useSounds();

  const categories = ['All', ...Array.from(new Set(flashcards.map((c) => c.category)))];
  const filtered = activeCategory === 'All' ? flashcards : flashcards.filter((c) => c.category === activeCategory);

  const currentCard = filtered[cardIndex % Math.max(filtered.length, 1)];

  const handleNext = () => setCardIndex((i) => (i + 1) % Math.max(filtered.length, 1));

  const handleCorrect = () => {
    if (currentCard) {
      const updated = { ...currentCard, reviewCount: currentCard.reviewCount + 1, lastReviewed: Date.now() };
      updateFlashcard(currentCard.id, { reviewCount: updated.reviewCount, lastReviewed: updated.lastReviewed });
      if (user?.uid) {
        saveFlashcard(user.uid, updated).catch((err) =>
          console.error('[Firestore] Failed to update flashcard review:', err)
        );
      }
    }
    recordActivity('flashcard').catch(() => {});
    onSuccessSound();
    handleNext();
  };

  const handleWrong = () => handleNext();

  const handleAdd = () => {
    if (!newFront.trim() || !newBack.trim()) return;
    const newCard = addFlashcard({
      front: newFront.trim(),
      back: newBack.trim(),
      category: newCategory.trim() || 'General',
    });
    if (user?.uid) {
      saveFlashcard(user.uid, newCard).catch((err) =>
        console.error('[Firestore] Failed to save flashcard:', err)
      );
    }
    setNewFront('');
    setNewBack('');
    setNewCategory('General');
    setShowAdd(false);
  };

  const handleDelete = (cardId: string) => {
    deleteFlashcard(cardId);
    if (user?.uid) {
      deleteFlashcardFS(user.uid, cardId).catch((err) =>
        console.error('[Firestore] Failed to delete flashcard:', err)
      );
    }
  };

  return (
    <PageWrapper>
      <div className="px-5 pt-14">
        <div className="mb-6 flex items-center justify-between">
          <div>
            <p className="text-xs font-medium uppercase tracking-widest text-slate-500">Study Mode</p>
            <h1 className="text-2xl font-bold text-white">Flashcards</h1>
          </div>
          <motion.button
            whileTap={{ scale: 0.9 }}
            onClick={() => setShowAdd(true)}
            className="flex items-center gap-1.5 rounded-xl px-3.5 py-2 text-sm font-semibold text-white"
            style={{ background: 'linear-gradient(135deg, #0090ff, #00c6ff)', boxShadow: '0 4px 15px rgba(0,144,255,0.3)' }}
          >
            <Plus size={16} />
            New
          </motion.button>
        </div>

        <div className="mb-6 flex gap-2 overflow-x-auto pb-1 no-scrollbar">
          {categories.map((cat) => (
            <CategoryPill
              key={cat}
              label={cat}
              active={activeCategory === cat}
              onClick={() => { setActiveCategory(cat); setCardIndex(0); }}
              count={cat === 'All' ? flashcards.length : flashcards.filter((c) => c.category === cat).length}
            />
          ))}
        </div>

        {filtered.length > 0 && (
          <div className="mb-6 flex items-center gap-3">
            <div className="flex-1 h-1 rounded-full overflow-hidden" style={{ background: 'rgba(255,255,255,0.06)' }}>
              <motion.div
                animate={{ width: `${((cardIndex % filtered.length) / filtered.length) * 100}%` }}
                className="h-full rounded-full"
                style={{ background: 'linear-gradient(90deg, #00c6ff, #38bdf8)' }}
              />
            </div>
            <span className="text-xs text-slate-400">{(cardIndex % filtered.length) + 1} / {filtered.length}</span>
          </div>
        )}

        {filtered.length === 0 ? (
          <EmptyState
            icon={<BookOpen size={32} />}
            title="Start building your knowledge system"
            description="Create your first flashcard. Tap the New button to get started."
            cta="Create flashcard"
            onCta={() => setShowAdd(true)}
          />
        ) : (
          <AnimatePresence mode="wait">
            <motion.div
              key={`${currentCard?.id}-${cardIndex}`}
              initial={{ opacity: 0, scale: 0.95 }}
              animate={{ opacity: 1, scale: 1 }}
              exit={{ opacity: 0, scale: 0.95 }}
              transition={{ duration: 0.25 }}
            >
              <FlipCard
                card={currentCard}
                onNext={handleNext}
                onCorrect={handleCorrect}
                onWrong={handleWrong}
              />
            </motion.div>
          </AnimatePresence>
        )}

        {filtered.length > 1 && (
          <div className="mt-8">
            <h3 className="mb-3 text-xs font-semibold uppercase tracking-wider text-slate-500">All Cards</h3>
            <div className="space-y-2">
              {filtered.map((card, i) => (
                <motion.div
                  key={card.id}
                  initial={{ opacity: 0, x: -10 }}
                  animate={{ opacity: 1, x: 0 }}
                  transition={{ delay: i * 0.05 }}
                  className="flex items-center gap-3 rounded-xl p-3"
                  style={{ background: 'rgba(255,255,255,0.03)', border: '1px solid rgba(255,255,255,0.05)' }}
                >
                  <button
                    onClick={() => setCardIndex(i)}
                    className="flex-1 text-left"
                  >
                    <p className="text-sm font-medium text-slate-200 truncate">{card.front}</p>
                    <p className="text-xs text-slate-500 mt-0.5">{card.category} · {card.reviewCount} reviews</p>
                  </button>
                  <motion.button
                    whileTap={{ scale: 0.85 }}
                    onClick={() => handleDelete(card.id)}
                    className="flex-shrink-0 p-1.5 rounded-lg"
                    style={{ background: 'rgba(248,113,113,0.1)' }}
                  >
                    <Trash2 size={13} className="text-red-400" />
                  </motion.button>
                </motion.div>
              ))}
            </div>
          </div>
        )}
      </div>

      <AnimatePresence>
        {showAdd && (
          <motion.div
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            className="fixed inset-0 z-50 flex items-end justify-center"
            style={{ background: 'rgba(0,0,0,0.7)' }}
            onClick={(e) => e.target === e.currentTarget && setShowAdd(false)}
          >
            <motion.div
              initial={{ y: '100%' }}
              animate={{ y: 0 }}
              exit={{ y: '100%' }}
              transition={{ type: 'spring', stiffness: 300, damping: 30 }}
              className="w-full rounded-t-3xl p-6 pb-10"
              style={{
                background: '#0d1426',
                border: '1px solid rgba(255,255,255,0.08)',
                borderBottom: 'none',
              }}
            >
              <div className="mb-6 flex items-center justify-between">
                <h2 className="text-lg font-bold text-white">New Flashcard</h2>
                <motion.button whileTap={{ scale: 0.9 }} onClick={() => setShowAdd(false)}>
                  <X size={20} className="text-slate-400" />
                </motion.button>
              </div>

              <div className="space-y-3">
                <div>
                  <label className="mb-1.5 block text-xs font-medium text-slate-400">Question (Front)</label>
                  <textarea
                    value={newFront}
                    onChange={(e) => setNewFront(e.target.value)}
                    placeholder="What is..."
                    rows={2}
                    className="w-full resize-none rounded-xl p-3 text-sm text-white placeholder-slate-600 outline-none"
                    style={{ background: 'rgba(255,255,255,0.05)', border: '1px solid rgba(255,255,255,0.1)' }}
                  />
                </div>
                <div>
                  <label className="mb-1.5 block text-xs font-medium text-slate-400">Answer (Back)</label>
                  <textarea
                    value={newBack}
                    onChange={(e) => setNewBack(e.target.value)}
                    placeholder="The answer is..."
                    rows={2}
                    className="w-full resize-none rounded-xl p-3 text-sm text-white placeholder-slate-600 outline-none"
                    style={{ background: 'rgba(255,255,255,0.05)', border: '1px solid rgba(255,255,255,0.1)' }}
                  />
                </div>
                <div>
                  <label className="mb-1.5 block text-xs font-medium text-slate-400">Category</label>
                  <input
                    value={newCategory}
                    onChange={(e) => setNewCategory(e.target.value)}
                    placeholder="Biology, Physics..."
                    className="w-full rounded-xl p-3 text-sm text-white placeholder-slate-600 outline-none"
                    style={{ background: 'rgba(255,255,255,0.05)', border: '1px solid rgba(255,255,255,0.1)' }}
                  />
                </div>
                <motion.button
                  whileTap={{ scale: 0.97 }}
                  onClick={handleAdd}
                  className="w-full rounded-2xl py-3.5 text-sm font-semibold text-white"
                  style={{ background: 'linear-gradient(135deg, #0090ff, #00c6ff)', boxShadow: '0 4px 20px rgba(0,144,255,0.3)' }}
                >
                  Create Card
                </motion.button>
              </div>
            </motion.div>
          </motion.div>
        )}
      </AnimatePresence>
    </PageWrapper>
  );
}
