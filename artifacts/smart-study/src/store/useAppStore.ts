import { create } from 'zustand';
import { persist } from 'zustand/middleware';

export type Page = 'splash' | 'profile-setup' | 'home' | 'flashcards' | 'focus' | 'chat' | 'search' | 'profile' | 'settings';

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

interface AppState {
  currentPage: Page;
  flashcards: Flashcard[];
  tasks: Task[];
  chatMessages: ChatMessage[];
  userProfile: UserProfile;
  studentProfile: StudentProfile;
  settings: Settings;
  isLoading: boolean;
  activeFlashcardIndex: number;
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
  addFlashcard: (card: Omit<Flashcard, 'id' | 'createdAt' | 'reviewCount'>) => void;
  updateFlashcard: (id: string, updates: Partial<Flashcard>) => void;
  deleteFlashcard: (id: string) => void;
  setActiveFlashcardIndex: (index: number) => void;
  addTask: (task: Omit<Task, 'id' | 'createdAt'>) => void;
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
}

export const useAppStore = create<AppState>()(
  persist(
    (set) => ({
      currentPage: 'splash',
      flashcards: [
        {
          id: '1',
          front: 'What is the powerhouse of the cell?',
          back: 'The mitochondria — it generates ATP through cellular respiration.',
          category: 'Biology',
          createdAt: Date.now() - 86400000,
          reviewCount: 3,
        },
        {
          id: '2',
          front: 'Define photosynthesis',
          back: 'The process by which plants convert light energy into chemical energy (glucose) using CO₂ and water.',
          category: 'Biology',
          createdAt: Date.now() - 72000000,
          reviewCount: 1,
        },
        {
          id: '3',
          front: "What is Newton's second law?",
          back: 'F = ma. Force equals mass times acceleration.',
          category: 'Physics',
          createdAt: Date.now() - 50000000,
          reviewCount: 5,
        },
      ],
      tasks: [
        {
          id: '1',
          title: 'Review Biology chapter 4',
          completed: false,
          createdAt: Date.now() - 3600000,
          priority: 'high',
        },
        {
          id: '2',
          title: 'Complete 20 math problems',
          completed: true,
          createdAt: Date.now() - 7200000,
          priority: 'medium',
        },
        {
          id: '3',
          title: 'Read history notes',
          completed: false,
          createdAt: Date.now() - 1800000,
          priority: 'low',
        },
      ],
      chatMessages: [],
      studentProfile: {
        country: '',
        level: '',
        track: '',
        profileComplete: false,
      },
      userProfile: {
        name: 'Alex',
        avatar: '',
        studyGoal: 'Ace my final exams',
        curriculum: 'STEM',
        streak: 7,
        totalSessions: 42,
        lastStudyDate: new Date().toDateString(),
      },
      settings: {
        language: 'English',
        curriculum: 'STEM',
        fontSize: 'medium',
        darkMode: true,
        notifications: true,
      },
      isLoading: false,
      activeFlashcardIndex: 0,
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
          studentProfile: { country: '', level: '', track: '', profileComplete: false },
          userProfile: {
            name: '',
            avatar: '',
            studyGoal: '',
            curriculum: '',
            streak: 0,
            totalSessions: 0,
            lastStudyDate: new Date().toDateString(),
          },
          settings: {
            language: 'Arabic',
            curriculum: '',
            fontSize: 'medium',
            darkMode: true,
            notifications: true,
          },
          flashcards: [],
          tasks: [],
          activeFlashcardIndex: 0,
          pomodoroState: { isRunning: false, mode: 'work', timeLeft: 25 * 60, sessionsCompleted: 0 },
        }),

      addFlashcard: (card) =>
        set((state) => ({
          flashcards: [
            ...state.flashcards,
            { ...card, id: Date.now().toString(), createdAt: Date.now(), reviewCount: 0 },
          ],
        })),

      updateFlashcard: (id, updates) =>
        set((state) => ({
          flashcards: state.flashcards.map((c) => (c.id === id ? { ...c, ...updates } : c)),
        })),

      deleteFlashcard: (id) =>
        set((state) => ({ flashcards: state.flashcards.filter((c) => c.id !== id) })),

      setActiveFlashcardIndex: (index) => set({ activeFlashcardIndex: index }),

      addTask: (task) =>
        set((state) => ({
          tasks: [{ ...task, id: Date.now().toString(), createdAt: Date.now() }, ...state.tasks],
        })),

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
            { ...msg, id: Date.now().toString(), timestamp: Date.now() },
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
    }),
    {
      name: 'smart-study-assistant',
      partialize: (state) => ({
        flashcards: state.flashcards,
        tasks: state.tasks,
        chatMessages: state.chatMessages,
        userProfile: state.userProfile,
        studentProfile: state.studentProfile,
        settings: state.settings,
      }),
    }
  )
);
