import { create } from 'zustand';
import { persist } from 'zustand/middleware';
import { type GamificationData, DEFAULT_GAMIFICATION } from '../lib/gamification';
import { type DailyChecklist, DEFAULT_DAILY_CHECKLIST } from '../lib/streakEngine';

export type Page = 'splash' | 'profile-setup' | 'home' | 'flashcards' | 'focus' | 'chat' | 'search' | 'profile' | 'settings' | 'curriculum-manager' | 'exams' | 'exam-solver' | 'exam-results' | 'exam-generator';

export type Country = 'egypt' | 'sudan';
export type Level = 'primary' | 'preparatory' | 'secondary';
export type Track = 'scientific' | 'literary';

export interface Flashcard {
  id: string;
  front: string;
  back: string;
  category: string;
  createdAt: number;
  reviewCount: number;
  lastReviewed?: number;

  source?: 'manual' | 'ai_explanation' | 'student_mistake' | 'exam_question';
  status?: 'new' | 'learning' | 'review' | 'mastered';
  easeFactor?: number;
  interval?: number;
  repetitions?: number;
  nextReviewDate?: number;
  curriculumTag?: {
    country: string;
    level: string;
    track: string;
    subject: string;
    lesson?: string;
  };
}

export interface Task {
  id: string;
  title: string;
  completed: boolean;
  createdAt: number;
  dueDate?: string;
  priority: 'low' | 'medium' | 'high';
}

export interface ChatMessage {
  id: string;
  role: 'user' | 'assistant';
  content: string;
  timestamp: number;
}

export interface StudentProfile {
  country: Country | '';
  level: Level | '';
  track: Track | '';
  profileComplete: boolean;
}

export interface UserProfile {
  name: string;
  avatar: string;
  studyGoal: string;
  curriculum: string;
  streak: number;
  totalSessions: number;
  lastStudyDate: string;
}

export interface Settings {
  language: string;
  curriculum: string;
  fontSize: 'small' | 'medium' | 'large';
  darkMode: boolean;
  notifications: boolean;
}

const DEFAULT_SETTINGS: Settings = {
  language: 'Arabic',
  curriculum: '',
  fontSize: 'medium',
  darkMode: true,
  notifications: true,
};

const DEFAULT_USER_PROFILE: UserProfile = {
  name: '',
  avatar: '',
  studyGoal: '',
  curriculum: '',
  streak: 0,
  totalSessions: 0,
  lastStudyDate: new Date().toDateString(),
};

const DEFAULT_STUDENT_PROFILE: StudentProfile = {
  country: '',
  level: '',
  track: '',
  profileComplete: false,
};

export interface ExamNav {
  selectedExamId: string | null;
  selectedAttemptId: string | null;
  examsSubTab: 'my-exams' | 'bank' | 'weakness' | 'attempts';
  generatorSubject?: string;
  generatorTopic?: string;
}

const DEFAULT_EXAM_NAV: ExamNav = {
  selectedExamId: null,
  selectedAttemptId: null,
  examsSubTab: 'my-exams',
};

interface AppState {
  currentPage: Page;
  flashcards: Flashcard[];
  tasks: Task[];
  chatMessages: ChatMessage[];
  userProfile: UserProfile;
  studentProfile: StudentProfile;
  settings: Settings;
  isLoading: boolean;
  gamification: GamificationData;
  dailyChecklist: DailyChecklist;
  activeFlashcardIndex: number;
  examNav: ExamNav;
  pomodoroState: {
    isRunning: boolean;
    mode: 'work' | 'break';
    timeLeft: number;
    sessionsCompleted: number;
  };

  setPage: (page: Page) => void;
  setStudentProfile: (profile: Omit<StudentProfile, 'profileComplete'>) => void;
  setStudentProfileDirect: (profile: StudentProfile) => void;
  resetStore: () => void;
  hydrateChat: (messages: ChatMessage[]) => void;
  hydrateFlashcards: (cards: Flashcard[]) => void;
  hydrateTasks: (tasks: Task[]) => void;
  addFlashcardLocal: (card: Flashcard) => void;
  updateFlashcardLocal: (id: string, updates: Partial<Flashcard>) => void;
  deleteFlashcardLocal: (id: string) => void;
  addFlashcard: (card: Omit<Flashcard, 'id' | 'createdAt' | 'reviewCount'>) => Flashcard;
  updateFlashcard: (id: string, updates: Partial<Flashcard>) => void;
  deleteFlashcard: (id: string) => void;
  setActiveFlashcardIndex: (index: number) => void;
  addTaskLocal: (task: Task) => void;
  updateTaskLocal: (id: string, updates: Partial<Task>) => void;
  deleteTaskLocal: (id: string) => void;
  addTask: (task: Omit<Task, 'id' | 'createdAt'>) => Task;
  toggleTask: (id: string) => void;
  deleteTask: (id: string) => void;
  addChatMessage: (msg: Omit<ChatMessage, 'id' | 'timestamp'>) => void;
  clearChat: () => void;
  updateProfile: (updates: Partial<UserProfile>) => void;
  updateUserProfile: (updates: Partial<UserProfile>) => void;
  updateSettings: (updates: Partial<Settings>) => void;
  incrementStreak: () => void;
  setPomodoroState: (updates: Partial<AppState['pomodoroState']>) => void;
  setLoading: (loading: boolean) => void;
  updateGamification: (updates: Partial<GamificationData>) => void;
  hydrateGamification: (data: GamificationData) => void;
  updateDailyChecklist: (updates: Partial<DailyChecklist>) => void;
  hydrateDailyChecklist: (checklist: DailyChecklist) => void;
  setExamNav: (updates: Partial<ExamNav>) => void;
}

export const useAppStore = create<AppState>()(
  persist(
    (set, get) => ({
      currentPage: 'splash',
      flashcards: [],
      tasks: [],
      chatMessages: [],
      studentProfile: DEFAULT_STUDENT_PROFILE,
      userProfile: DEFAULT_USER_PROFILE,
      settings: DEFAULT_SETTINGS,
      isLoading: false,
      gamification: DEFAULT_GAMIFICATION,
      dailyChecklist: DEFAULT_DAILY_CHECKLIST,
      activeFlashcardIndex: 0,
      examNav: DEFAULT_EXAM_NAV,
      pomodoroState: {
        isRunning: false,
        mode: 'work',
        timeLeft: 25 * 60,
        sessionsCompleted: 0,
      },

      setPage: (page) => set({ currentPage: page }),

      setStudentProfile: (profile) =>
        set({ studentProfile: { ...profile, profileComplete: true } }),

      setStudentProfileDirect: (profile) =>
        set({ studentProfile: profile }),

      hydrateChat: (messages) => set({ chatMessages: messages }),

      hydrateFlashcards: (cards) => set({ flashcards: cards }),

      hydrateTasks: (tasks) => set({ tasks }),

      resetStore: () =>
        set({
          currentPage: 'splash',
          chatMessages: [],
          studentProfile: DEFAULT_STUDENT_PROFILE,
          userProfile: DEFAULT_USER_PROFILE,
          flashcards: [],
          tasks: [],
          gamification: DEFAULT_GAMIFICATION,
          dailyChecklist: DEFAULT_DAILY_CHECKLIST,
          activeFlashcardIndex: 0,
          pomodoroState: { isRunning: false, mode: 'work', timeLeft: 25 * 60, sessionsCompleted: 0 },
        }),

      addFlashcardLocal: (card) =>
        set((state) => ({ flashcards: [...state.flashcards, card] })),

      updateFlashcardLocal: (id, updates) =>
        set((state) => ({
          flashcards: state.flashcards.map((c) => (c.id === id ? { ...c, ...updates } : c)),
        })),

      deleteFlashcardLocal: (id) =>
        set((state) => ({ flashcards: state.flashcards.filter((c) => c.id !== id) })),

      addFlashcard: (card) => {
        const newCard: Flashcard = {
          ...card,
          id: `${Date.now()}-${Math.random().toString(36).slice(2, 9)}`,
          createdAt: Date.now(),
          reviewCount: 0,
        };
        set((state) => ({ flashcards: [...state.flashcards, newCard] }));
        return newCard;
      },

      updateFlashcard: (id, updates) =>
        set((state) => ({
          flashcards: state.flashcards.map((c) => (c.id === id ? { ...c, ...updates } : c)),
        })),

      deleteFlashcard: (id) =>
        set((state) => ({ flashcards: state.flashcards.filter((c) => c.id !== id) })),

      setActiveFlashcardIndex: (index) => set({ activeFlashcardIndex: index }),

      addTaskLocal: (task) =>
        set((state) => ({ tasks: [task, ...state.tasks] })),

      updateTaskLocal: (id, updates) =>
        set((state) => ({
          tasks: state.tasks.map((t) => (t.id === id ? { ...t, ...updates } : t)),
        })),

      deleteTaskLocal: (id) =>
        set((state) => ({ tasks: state.tasks.filter((t) => t.id !== id) })),

      addTask: (task) => {
        const newTask: Task = {
          ...task,
          id: `${Date.now()}-${Math.random().toString(36).slice(2, 9)}`,
          createdAt: Date.now(),
        };
        set((state) => ({ tasks: [newTask, ...state.tasks] }));
        return newTask;
      },

      toggleTask: (id) =>
        set((state) => ({
          tasks: state.tasks.map((t) => (t.id === id ? { ...t, completed: !t.completed } : t)),
        })),

      deleteTask: (id) =>
        set((state) => ({ tasks: state.tasks.filter((t) => t.id !== id) })),

      addChatMessage: (msg) =>
        set((state) => ({
          chatMessages: [
            ...state.chatMessages,
            { ...msg, id: `${Date.now()}-${Math.random().toString(36).slice(2, 9)}`, timestamp: Date.now() },
          ],
        })),

      clearChat: () => set({ chatMessages: [] }),

      updateProfile: (updates) =>
        set((state) => ({ userProfile: { ...state.userProfile, ...updates } })),

      updateUserProfile: (updates) =>
        set((state) => ({ userProfile: { ...state.userProfile, ...updates } })),

      updateSettings: (updates) =>
        set((state) => ({ settings: { ...state.settings, ...updates } })),

      incrementStreak: () =>
        set((state) => ({
          userProfile: { ...state.userProfile, streak: state.userProfile.streak + 1 },
        })),

      setPomodoroState: (updates) =>
        set((state) => ({ pomodoroState: { ...state.pomodoroState, ...updates } })),

      setLoading: (loading) => set({ isLoading: loading }),

      updateGamification: (updates) =>
        set((state) => ({ gamification: { ...state.gamification, ...updates } })),

      hydrateGamification: (data) =>
        set({ gamification: { ...DEFAULT_GAMIFICATION, ...data } }),

      updateDailyChecklist: (updates) =>
        set((state) => ({ dailyChecklist: { ...state.dailyChecklist, ...updates } })),

      hydrateDailyChecklist: (checklist) =>
        set({ dailyChecklist: { ...DEFAULT_DAILY_CHECKLIST, ...checklist } }),

      setExamNav: (updates) =>
        set((state) => ({ examNav: { ...state.examNav, ...updates } })),
    }),
    {
      name: 'smart-study-assistant',
      version: 3,
      migrate: () => ({}),
      partialize: (state) => ({
        settings: state.settings,
        currentPage: state.currentPage,
      }),
    }
  )
);
