"use client";

import Link from "next/link";
import * as Dialog from "@radix-ui/react-dialog";
import * as Select from "@radix-ui/react-select";
import { format } from "date-fns";
import { AnimatePresence, motion } from "framer-motion";
import { Fragment, useEffect, useMemo, useRef, useState, type PointerEvent, type TouchEvent } from "react";
import { DayPicker, type DateRange } from "react-day-picker";
import "react-day-picker/style.css";
import { Activity, Bot, Calendar, Check, ChevronDown, ChevronLeft, ChevronRight, Clock3, Dumbbell, Edit3, Eraser, LogIn, LogOut, Maximize2, Minimize2, Moon, Plus, RefreshCw, Save, Search, Send, Sun, Trash2, X } from "lucide-react";
import { CartesianGrid, Label, Line, LineChart, PolarAngleAxis, PolarGrid, PolarRadiusAxis, Radar, RadarChart, ResponsiveContainer, Scatter, ScatterChart, Tooltip, XAxis, YAxis } from "recharts";
import { cacheExerciseCatalog, enqueueOffline, getOfflineQueueCount, offlineDb, searchCachedExerciseCatalog, type OfflineQueueItem } from "@/lib/offline-db";
import { isSupabaseConfigured, supabase, type BodyWeight, type CustomExercise, type ExerciseCatalogItem, type Routine, type RoutineExercise, type Workout, type WorkoutExercise, type WorkoutSetRow } from "@/lib/supabase";
import { blankExercise, blankSet, loadWorkoutDraft, saveWorkoutDraft, type ExerciseDraft, type SetRow } from "@/lib/workout-draft";
import { useTheme } from "./providers";

type WorkoutWithExercises = Workout & { workout_exercises: WorkoutExercise[] };
type RoutineWithExercises = Routine & { routine_exercises: RoutineExercise[] };
type EditableSetRow = Omit<WorkoutSetRow, "reps" | "weight"> & { reps: number | string; weight: number | string };
type ExerciseTrackerDraft = { exerciseName: string; sets: SetRow[] };
type ExerciseSuggestion = Pick<ExerciseCatalogItem, "id" | "name" | "category" | "muscles" | "equipment" | "image_url"> & { source: "catalog" | "history" | "custom" };
type MuscleCatalogItem = Pick<ExerciseCatalogItem, "name" | "muscles" | "muscles_secondary" | "equipment" | "image_url">;
type AgentTable = { title: string; columns: string[]; rows: string[][] };
type WorkoutSummary = {
    title: string;
    duration: string;
    volume: number;
    sets: number;
    exercises: number;
};
type FinishWorkoutDetails = { title: string; notes: string; photos: File[] };
type AgentContext = {
    exerciseNames?: string[];
    muscleGroup?: string;
    dateRange?: { label: string; start?: string; end?: string };
    resultMode?: "summary" | "exercise-list" | "set-detail" | "best-set" | "workout-detail";
    lastColumns?: string[];
    lastRowCount?: number;
};
type AgentAnswer = { answer: string; breakdown?: Array<{ label: string; value: number; unit: string }>; tables?: AgentTable[]; context?: AgentContext };
type AgentChatMessage = { id: string; role: "user" | "assistant"; content: string; breakdown?: AgentAnswer["breakdown"]; tables?: AgentTable[] };
type EditableWorkoutExercise = { id: string; name: string; notes: string; setRows: EditableSetRow[]; image_url?: string | null; equipment?: string[]; isNew?: boolean };
type RoutineBuilderDraft = { open: boolean; editingRoutineId: string; title: string; exercises: EditableWorkoutExercise[]; expandedIds: string[] };
type OfflineWorkoutPayload = { name: string; notes?: string | null; exercises: Array<{ name: string; sets: Array<{ set: number; reps: number; weight: number; notes?: string }>; notes?: string | null; body_weight?: number | null }> };
type OfflineBodyWeightPayload = { user_key: string; weight: number; measured_on: string; notes: string | null };

const TRACKER_DRAFT_KEY = "progressfit-exercise-tracker-draft";
const WORKOUT_UI_STATE_KEY = "progressfit-workout-ui-state";
const ROUTINE_BUILDER_DRAFT_KEY = "progressfit-routine-builder-draft";
const formatWorkoutName = (date = new Date()) => date.toLocaleDateString(undefined, { weekday: "short", month: "short", day: "numeric", year: "numeric" });
const normalise = (name: string) => name.normalize("NFKC").trim().toLowerCase().replace(/\s+/g, " ").replace(/\btriceps\b/g, "tricep");
const exerciseSearchVariants = (name: string) => Array.from(new Set([name.trim(), name.trim().replace(/\btriceps\b/gi, "tricep"), name.trim().replace(/\btricep\b/gi, "triceps")].filter(Boolean)));
const blankTrackerSets = () => [blankSet()];
const PAGE_SIZE = 10;
const WEIGHT_PAGE_SIZE = 10;
const todayInputValue = () => new Date().toISOString().slice(0, 10);
const SECTION_STORAGE_KEY = "progressfit-active-section";
const TOAST_DURATION_MS = 1500;
const SWIPE_DELETE_WIDTH = 88;
const PULL_REFRESH_THRESHOLD = 82;
const REST_TIMER_OPTIONS = [0, 10, 20, 30, 45, 60, 90, 120, 180] as const;
type ActiveSection = "workouts" | "exercises" | "progress" | "weight" | "settings";
type WorkoutUiState = { active: boolean; expanded: boolean; startedAt: number };
const MUSCLE_GROUPS = ["Chest", "Back", "Legs", "Shoulders", "Arms", "Core"] as const;
const CUSTOM_EXERCISE_CATEGORIES = ["Arms", "Back", "Chest", "Core", "Legs", "Shoulders", "Cardio", "Full Body", "Other"] as const;
const CUSTOM_EXERCISE_MUSCLES = ["Biceps", "Triceps", "Forearms", "Chest", "Lats", "Traps", "Rhomboids", "Rear delts", "Front delts", "Side delts", "Abs", "Obliques", "Lower back", "Quads", "Hamstrings", "Glutes", "Calves", "Adductors", "Abductors"] as const;
const CUSTOM_EXERCISE_EQUIPMENT = ["Barbell", "Dumbbell", "Cable", "Machine", "Smith machine", "Bodyweight", "Bench", "Kettlebell", "Resistance band", "Other"] as const;
type MuscleGroup = typeof MUSCLE_GROUPS[number];
const estimateOneRepMax = (weight: number, reps: number) => Math.round(weight * (1 + reps / 30));
const poundsToKilograms = (weight: number) => Number((weight * 0.45359237).toFixed(1));
const isBodyweightEquipment = (equipment?: string[] | null) => (equipment ?? []).some((item) => normalise(item).includes("bodyweight"));
const offlineId = (type: "weight" | "exercise" | "workout", id: number) => `offline-${type}-${id}`;
const offlineQueueIdFrom = (id: string) => Number(id.split("-").at(-1));
const formatDurationSeconds = (seconds?: number | null) => {
    if (!seconds || seconds <= 0) return "—";
    const wholeSeconds = Math.floor(seconds);
    if (wholeSeconds >= 3600) return `${Math.floor(wholeSeconds / 3600)}h ${Math.floor((wholeSeconds % 3600) / 60)}m`;
    if (wholeSeconds >= 60) return `${Math.floor(wholeSeconds / 60)}m ${wholeSeconds % 60}s`;
    return `${wholeSeconds}s`;
};
const formatRestTimer = (seconds: number) => `${Math.floor(Math.max(0, seconds) / 60).toString().padStart(2, "0")}:${Math.max(0, seconds % 60).toString().padStart(2, "0")}`;
const formatRestOption = (seconds: number) => seconds === 0 ? "Off" : seconds < 60 ? `${seconds}s` : seconds % 60 === 0 ? `${seconds / 60}m` : `${Math.floor(seconds / 60)}m ${seconds % 60}s`;

function muscleGroupFor(muscle: string): MuscleGroup | null {
    const value = muscle.toLowerCase();
    if (value.includes("pectoralis") || value.includes("chest")) return "Chest";
    if (value.includes("latissimus") || value.includes("trapezius") || value.includes("teres") || value.includes("rhomboid") || value.includes("back")) return "Back";
    if (value.includes("quadriceps") || value.includes("hamstring") || value.includes("glute") || value.includes("gastrocnemius") || value.includes("soleus") || value.includes("calf") || value.includes("adductor") || value.includes("abductor")) return "Legs";
    if (value.includes("deltoid") || value.includes("shoulder")) return "Shoulders";
    if (value.includes("biceps") || value.includes("triceps") || value.includes("brachialis") || value.includes("forearm") || value.includes("wrist")) return "Arms";
    if (value.includes("abdominis") || value.includes("oblique") || value.includes("core")) return "Core";
    return null;
}

function loadTrackerDraft(): ExerciseTrackerDraft | null {
    if (typeof window === "undefined") return null;
    const raw = localStorage.getItem(TRACKER_DRAFT_KEY);
    if (!raw) return null;
    try {
        const parsed = JSON.parse(raw) as ExerciseTrackerDraft;
        return {
            exerciseName: typeof parsed.exerciseName === "string" ? parsed.exerciseName : "",
            sets: Array.isArray(parsed.sets) && parsed.sets.length ? parsed.sets.map((set) => ({ ...set, completed: Boolean(set.completed), prefilled: Boolean(set.prefilled) })) : blankTrackerSets(),
        };
    } catch {
        return null;
    }
}

function saveTrackerDraft(draft: ExerciseTrackerDraft) {
    if (typeof window === "undefined") return;
    localStorage.setItem(TRACKER_DRAFT_KEY, JSON.stringify(draft));
}

function loadWorkoutUiState(): WorkoutUiState | null {
    if (typeof window === "undefined") return null;
    const raw = localStorage.getItem(WORKOUT_UI_STATE_KEY);
    if (!raw) return null;
    try {
        const parsed = JSON.parse(raw) as Partial<WorkoutUiState>;
        return {
            active: Boolean(parsed.active),
            expanded: Boolean(parsed.expanded),
            startedAt: typeof parsed.startedAt === "number" && Number.isFinite(parsed.startedAt) ? parsed.startedAt : Date.now(),
        };
    } catch {
        return null;
    }
}

function saveWorkoutUiState(state: WorkoutUiState) {
    if (typeof window === "undefined") return;
    localStorage.setItem(WORKOUT_UI_STATE_KEY, JSON.stringify(state));
}

function loadRoutineBuilderDraft(): RoutineBuilderDraft | null {
    if (typeof window === "undefined") return null;
    const raw = sessionStorage.getItem(ROUTINE_BUILDER_DRAFT_KEY);
    if (!raw) return null;
    try {
        const parsed = JSON.parse(raw) as Partial<RoutineBuilderDraft>;
        return {
            open: Boolean(parsed.open),
            editingRoutineId: typeof parsed.editingRoutineId === "string" ? parsed.editingRoutineId : "",
            title: typeof parsed.title === "string" ? parsed.title : "",
            exercises: Array.isArray(parsed.exercises) ? parsed.exercises : [],
            expandedIds: Array.isArray(parsed.expandedIds) ? parsed.expandedIds.filter((id): id is string => typeof id === "string") : [],
        };
    } catch {
        return null;
    }
}

function saveRoutineBuilderDraft(draft: RoutineBuilderDraft) {
    if (typeof window === "undefined") return;
    sessionStorage.setItem(ROUTINE_BUILDER_DRAFT_KEY, JSON.stringify(draft));
}

function clearRoutineBuilderDraft() {
    if (typeof window === "undefined") return;
    sessionStorage.removeItem(ROUTINE_BUILDER_DRAFT_KEY);
}

function inputDateToDate(value: string) {
    return value ? new Date(`${value}T00:00:00`) : undefined;
}

function dateToInputValue(date?: Date) {
    return date ? format(date, "yyyy-MM-dd") : "";
}

function DatePickerField({ label, value, onChange }: { label: string; value: string; onChange: (value: string) => void }) {
    const selected = inputDateToDate(value);
    return (
        <Dialog.Root>
            <Dialog.Trigger asChild>
                <button className="date-picker-trigger" type="button" aria-label={label}>
                    <Calendar size={16} />
                    <span>{selected ? format(selected, "MMM d, yyyy") : label}</span>
                </button>
            </Dialog.Trigger>
            <Dialog.Portal>
                <Dialog.Overlay className="dialog-overlay" />
                <Dialog.Content className="dialog-content date-dialog-content">
                    <Dialog.Title className="dialog-title">{label}</Dialog.Title>
                    <DayPicker mode="single" selected={selected} onSelect={(date) => onChange(dateToInputValue(date))} />
                    <div className="dialog-actions">
                        <button className="btn secondary" onClick={() => onChange("")}>Clear</button>
                        <Dialog.Close asChild><button className="btn">Done</button></Dialog.Close>
                    </div>
                </Dialog.Content>
            </Dialog.Portal>
        </Dialog.Root>
    );
}

function DateRangePickerField({ from, to, onChange, compact = false }: { from: string; to: string; onChange: (range: { from: string; to: string }) => void; compact?: boolean }) {
    const selected: DateRange | undefined = from || to ? { from: inputDateToDate(from), to: inputDateToDate(to) } : undefined;
    const label = selected?.from
        ? selected.to
            ? `${format(selected.from, "MMM d, yyyy")} - ${format(selected.to, "MMM d, yyyy")}`
            : `${format(selected.from, "MMM d, yyyy")} - optional`
        : "Date range";

    return (
        <Dialog.Root>
            <Dialog.Trigger asChild>
                <button className={compact ? "bare-icon-btn" : "date-picker-trigger"} type="button" aria-label="Date range" title={label}>
                    <Calendar size={16} />
                    {!compact && <span>{label}</span>}
                </button>
            </Dialog.Trigger>
            <Dialog.Portal>
                <Dialog.Overlay className="dialog-overlay" />
                <Dialog.Content className="dialog-content date-dialog-content">
                    <Dialog.Title className="dialog-title" style={{ position: "absolute", width: 1, height: 1, padding: 0, margin: -1, overflow: "hidden", clip: "rect(0, 0, 0, 0)", whiteSpace: "nowrap", border: 0 }}>Date range</Dialog.Title>
                    <DayPicker mode="range" selected={selected} onSelect={(range) => onChange({ from: dateToInputValue(range?.from), to: dateToInputValue(range?.to) })} />
                    <div className="dialog-actions">
                        <button className="btn secondary" onClick={() => onChange({ from: "", to: "" })}>Clear</button>
                        <Dialog.Close asChild><button className="btn">Done</button></Dialog.Close>
                    </div>
                </Dialog.Content>
            </Dialog.Portal>
        </Dialog.Root>
    );
}

export default function Home() {
    const { theme, cycleTheme } = useTheme();
    const [activeSection, setActiveSection] = useState<ActiveSection>("exercises");
    const [userKey, setUserKey] = useState("");
    const [authEmail, setAuthEmail] = useState("");
    const [authPassword, setAuthPassword] = useState("");
    const [authUserEmail, setAuthUserEmail] = useState("");
    const [authLoading, setAuthLoading] = useState(true);
    const [authMessage, setAuthMessage] = useState("");
    const [authModalOpen, setAuthModalOpen] = useState(false);
    const [agentModalOpen, setAgentModalOpen] = useState(false);
    const [agentQuestion, setAgentQuestion] = useState("");
    const [agentMessages, setAgentMessages] = useState<AgentChatMessage[]>([]);
    const [agentContext, setAgentContext] = useState<AgentContext | undefined>();
    const [agentLoading, setAgentLoading] = useState(false);
    const [agentError, setAgentError] = useState("");
    const [exerciseName, setExerciseName] = useState("");
    const [sets, setSets] = useState<SetRow[]>(blankTrackerSets());
    const [workoutName, setWorkoutName] = useState("");
    const [savedWorkoutName, setSavedWorkoutName] = useState("");
    const [currentWorkoutId, setCurrentWorkoutId] = useState("");
    const [workoutStartedAt, setWorkoutStartedAt] = useState(Date.now());
    const [workoutClockTick, setWorkoutClockTick] = useState(Date.now());
    const [draftWorkoutActive, setDraftWorkoutActive] = useState(false);
    const [finishSummary, setFinishSummary] = useState<WorkoutSummary | null>(null);
    const [workoutQueue, setWorkoutQueue] = useState<ExerciseDraft[]>([]);
    const [routines, setRoutines] = useState<RoutineWithExercises[]>([]);
    const [routineBuilderOpen, setRoutineBuilderOpen] = useState(false);
    const [editingRoutineId, setEditingRoutineId] = useState("");
    const [routineTitle, setRoutineTitle] = useState("");
    const [routineExercises, setRoutineExercises] = useState<EditableWorkoutExercise[]>([]);
    const [activeRoutineExerciseId, setActiveRoutineExerciseId] = useState("");
    const [routineCloseConfirmOpen, setRoutineCloseConfirmOpen] = useState(false);
    const [pendingStartRoutine, setPendingStartRoutine] = useState<RoutineWithExercises | null>(null);
    const [pendingDeleteRoutine, setPendingDeleteRoutine] = useState<RoutineWithExercises | null>(null);
    const [routinesExpanded, setRoutinesExpanded] = useState(true);
    const [pendingDiscardAction, setPendingDiscardAction] = useState<{ type: "empty" | "createRoutine" | "startRoutine"; routine?: RoutineWithExercises } | null>(null);
    const [history, setHistory] = useState<WorkoutExercise[]>([]);
    const [draftExerciseHistory, setDraftExerciseHistory] = useState<WorkoutExercise[]>([]);
    const [catalogSuggestions, setCatalogSuggestions] = useState<ExerciseSuggestion[]>([]);
    const [selectedExerciseMeta, setSelectedExerciseMeta] = useState<ExerciseSuggestion | null>(null);
    const [customExerciseModalOpen, setCustomExerciseModalOpen] = useState(false);
    const [customExerciseName, setCustomExerciseName] = useState("");
    const [customExerciseCategory, setCustomExerciseCategory] = useState("");
    const [customExerciseMuscles, setCustomExerciseMuscles] = useState<string[]>([]);
    const [customExerciseEquipment, setCustomExerciseEquipment] = useState<string[]>([]);
    const [customExerciseTarget, setCustomExerciseTarget] = useState<"tracker" | "progress" | "edit" | "routine" | "routine-edit" | "none">("none");
    const [activeEditExerciseId, setActiveEditExerciseId] = useState("");
    const [editExerciseSuggestions, setEditExerciseSuggestions] = useState<ExerciseSuggestion[]>([]);
    const [recentWorkouts, setRecentWorkouts] = useState<WorkoutWithExercises[]>([]);
    const [muscleCatalog, setMuscleCatalog] = useState<MuscleCatalogItem[]>([]);
    const [bodyWeights, setBodyWeights] = useState<BodyWeight[]>([]);
    const [bodyWeightHistory, setBodyWeightHistory] = useState<BodyWeight[]>([]);
    const [workoutSearch, setWorkoutSearch] = useState("");
    const [workoutStartDate, setWorkoutStartDate] = useState("");
    const [workoutEndDate, setWorkoutEndDate] = useState("");
    const [workoutPage, setWorkoutPage] = useState(0);
    const [editingWorkoutId, setEditingWorkoutId] = useState("");
    const [editingWorkoutFullscreen, setEditingWorkoutFullscreen] = useState(false);
    const [editWorkoutName, setEditWorkoutName] = useState("");
    const [editWorkoutNotes, setEditWorkoutNotes] = useState("");
    const [editWorkoutPhotoUrls, setEditWorkoutPhotoUrls] = useState<string[]>([]);
    const [editWorkoutPhotos, setEditWorkoutPhotos] = useState<File[]>([]);
    const [previewImageUrl, setPreviewImageUrl] = useState("");
    const [editWorkoutExercises, setEditWorkoutExercises] = useState<EditableWorkoutExercise[]>([]);
    const [weightValue, setWeightValue] = useState("");
    const [weightDate, setWeightDate] = useState(todayInputValue());
    const [weightNotes, setWeightNotes] = useState("");
    const [weightPage, setWeightPage] = useState(0);
    const [progressExercise, setProgressExercise] = useState("");
    const [progressHistory, setProgressHistory] = useState<WorkoutExercise[]>([]);
    const [expandedProgressRecordId, setExpandedProgressRecordId] = useState("");
    const [progressCatalogSuggestions, setProgressCatalogSuggestions] = useState<ExerciseSuggestion[]>([]);
    const [isProgressSearchFocused, setIsProgressSearchFocused] = useState(false);
    const [bodyWeightCount, setBodyWeightCount] = useState(0);
    const [editingWeightId, setEditingWeightId] = useState("");
    const [pendingDeleteWeight, setPendingDeleteWeight] = useState<BodyWeight | null>(null);
    const [clearDraftModalOpen, setClearDraftModalOpen] = useState(false);
    const [workoutNameModalOpen, setWorkoutNameModalOpen] = useState(false);
    const [workoutNameInput, setWorkoutNameInput] = useState(formatWorkoutName());
    const [finishDetailsModalOpen, setFinishDetailsModalOpen] = useState(false);
    const [finishWorkoutNameInput, setFinishWorkoutNameInput] = useState(formatWorkoutName());
    const [finishWorkoutNotes, setFinishWorkoutNotes] = useState("");
    const [finishWorkoutPhotos, setFinishWorkoutPhotos] = useState<File[]>([]);
    const [pendingDeleteWorkout, setPendingDeleteWorkout] = useState<WorkoutWithExercises | null>(null);
    const [pendingRemoveExercise, setPendingRemoveExercise] = useState<ExerciseDraft | null>(null);
    const [logoutConfirmOpen, setLogoutConfirmOpen] = useState(false);
    const [expandedWorkoutIds, setExpandedWorkoutIds] = useState<string[]>([]);
    const [expandedWorkoutExerciseIds, setExpandedWorkoutExerciseIds] = useState<string[]>([]);
    const [isExerciseSearchFocused, setIsExerciseSearchFocused] = useState(false);
    const [expandedHistoryExerciseIds, setExpandedHistoryExerciseIds] = useState<string[]>([]);
    const [expandedRecentRecordId, setExpandedRecentRecordId] = useState("");
    const [collapsedQueueIds, setCollapsedQueueIds] = useState<string[]>([]);
    const [fullscreenExerciseId, setFullscreenExerciseId] = useState("");
    const [restTimerRemaining, setRestTimerRemaining] = useState(0);
    const [restTimerTotal, setRestTimerTotal] = useState(0);
    const [restTimerEndAt, setRestTimerEndAt] = useState(0);
    const [restTimerSheetOpen, setRestTimerSheetOpen] = useState(false);
    const [restTimerExerciseId, setRestTimerExerciseId] = useState("");
    const [restTimerMinimized, setRestTimerMinimized] = useState(false);
    const [exercisePickerOpen, setExercisePickerOpen] = useState(false);
    const [exercisePickerMode, setExercisePickerMode] = useState<"track" | "edit" | "routine" | "routine-edit">("track");
    const [exercisePickerSearch, setExercisePickerSearch] = useState("");
    const [exercisePickerSuggestions, setExercisePickerSuggestions] = useState<ExerciseSuggestion[]>([]);
    const [selectedPickerExercises, setSelectedPickerExercises] = useState<ExerciseSuggestion[]>([]);
    const [openSwipeSet, setOpenSwipeSet] = useState<{ exerciseId: string; setId: string; offset: number } | null>(null);
    const [activeSwipeSetId, setActiveSwipeSetId] = useState("");
    const [pullRefreshDistance, setPullRefreshDistance] = useState(0);
    const [isPullRefreshing, setIsPullRefreshing] = useState(false);
    const [draftReady, setDraftReady] = useState(false);
    const [saving, setSaving] = useState(false);
    const [toast, setToast] = useState("");
    const [isOnline, setIsOnline] = useState(true);
    const [offlineQueueCount, setOfflineQueueCount] = useState(0);
    const [syncingOffline, setSyncingOffline] = useState(false);
    const [isMobileView, setIsMobileView] = useState(false);
    const offlineSyncInFlightRef = useRef(false);
    const swipeGestureRef = useRef<{ exerciseId: string; setId: string; startX: number; startY: number; startOffset: number; currentOffset: number; isSwiping: boolean } | null>(null);
    const pullRefreshRef = useRef<{ startY: number; active: boolean } | null>(null);
    const restAudioContextRef = useRef<AudioContext | null>(null);
    const exercisePickerInputRef = useRef<HTMLInputElement | null>(null);
    const weightFormRef = useRef<HTMLDivElement | null>(null);
    const weightInputRef = useRef<HTMLInputElement | null>(null);
    const skipInitialSectionPersistRef = useRef(true);
    const restTimerCompletedRef = useRef(false);

    useEffect(() => {
        const saved = localStorage.getItem(SECTION_STORAGE_KEY);
        if (saved === "workouts" || saved === "exercises" || saved === "progress" || saved === "weight" || saved === "settings") setActiveSection(saved);
    }, []);

    useEffect(() => {
        if (!restTimerEndAt) return;
        const updateRemaining = () => setRestTimerRemaining(Math.max(0, Math.ceil((restTimerEndAt - Date.now()) / 1000)));
        updateRemaining();
        const timer = window.setInterval(updateRemaining, 1000);
        return () => window.clearInterval(timer);
    }, [restTimerEndAt]);

    useEffect(() => {
        if (restTimerRemaining > 0) {
            restTimerCompletedRef.current = false;
            return;
        }
        if (!restTimerTotal || restTimerCompletedRef.current) return;
        restTimerCompletedRef.current = true;
        setRestTimerEndAt(0);
        playRestTimerSound();
        notifyRestTimerComplete();
    }, [restTimerRemaining, restTimerTotal]);

    useEffect(() => {
        if (skipInitialSectionPersistRef.current) {
            skipInitialSectionPersistRef.current = false;
            return;
        }
        localStorage.setItem(SECTION_STORAGE_KEY, activeSection);
    }, [activeSection]);

    useEffect(() => {
        const query = window.matchMedia("(max-width: 640px)");
        const update = () => setIsMobileView(query.matches);
        update();
        query.addEventListener("change", update);
        return () => query.removeEventListener("change", update);
    }, []);

    useEffect(() => {
        const updateViewportHeight = () => {
            const height = window.visualViewport?.height ?? window.innerHeight;
            document.documentElement.style.setProperty("--app-viewport-height", `${height}px`);
        };
        updateViewportHeight();
        window.visualViewport?.addEventListener("resize", updateViewportHeight);
        window.visualViewport?.addEventListener("scroll", updateViewportHeight);
        window.addEventListener("resize", updateViewportHeight);
        return () => {
            window.visualViewport?.removeEventListener("resize", updateViewportHeight);
            window.visualViewport?.removeEventListener("scroll", updateViewportHeight);
            window.removeEventListener("resize", updateViewportHeight);
        };
    }, []);

    useEffect(() => {
        const trackerDraft = loadTrackerDraft();
        if (trackerDraft) {
            setExerciseName(trackerDraft.exerciseName);
            setSets(trackerDraft.sets);
        }

        const workoutDraft = loadWorkoutDraft();
        const workoutUiState = loadWorkoutUiState();
        if (workoutDraft) {
            const exercises = workoutDraft.exercises
                .filter((exercise) => exercise.name.trim())
                .map((exercise) => exercise.savedExerciseId?.startsWith("offline-") ? { ...exercise, savedExerciseId: undefined } : exercise);
            setWorkoutName(workoutDraft.workoutName);
            setSavedWorkoutName(workoutDraft.workoutName);
            setCurrentWorkoutId(workoutDraft.workoutId ?? "");
            setWorkoutQueue(exercises);
            setDraftWorkoutActive(workoutUiState?.active ?? exercises.length > 0);
            if (workoutUiState?.startedAt) {
                setWorkoutStartedAt(workoutUiState.startedAt);
                setWorkoutClockTick(Date.now());
            }
            if (workoutUiState?.active && workoutUiState.expanded) setFullscreenExerciseId(exercises[0]?.id ?? "workout");
            setCollapsedQueueIds(exercises.map((exercise) => exercise.id));
        }

        const routineBuilderDraft = loadRoutineBuilderDraft();
        if (routineBuilderDraft?.open) {
            setActiveSection("exercises");
            setRoutineBuilderOpen(true);
            setEditingRoutineId(routineBuilderDraft.editingRoutineId);
            setRoutineTitle(routineBuilderDraft.title);
            setRoutineExercises(routineBuilderDraft.exercises);
            setExpandedWorkoutExerciseIds(routineBuilderDraft.expandedIds);
        }

        async function initAuth() {
            if (!isSupabaseConfigured) {
                setAuthLoading(false);
                setDraftReady(true);
                return;
            }

            const { data } = await supabase.auth.getUser();
            const user = data.user;
            setUserKey(user?.id ?? "");
            setAuthUserEmail(user?.email ?? "");
            if (user) await loadData(user.id);
            setAuthLoading(false);
            setDraftReady(true);
        }

        initAuth();
        const { data: listener } = supabase.auth.onAuthStateChange((_event, session) => {
            const user = session?.user;
            setUserKey(user?.id ?? "");
            setAuthUserEmail(user?.email ?? "");
            if (user) loadData(user.id);
            else {
                setHistory([]);
                setDraftExerciseHistory([]);
                setRecentWorkouts([]);
                setBodyWeights([]);
                setBodyWeightHistory([]);
                setProgressHistory([]);
            }
        });

        return () => listener.subscription.unsubscribe();
    }, []);

    useEffect(() => {
        setIsOnline(navigator.onLine);
        const handleOnline = () => {
            setIsOnline(true);
            processOfflineQueue();
        };
        const handleOffline = () => setIsOnline(false);
        window.addEventListener("online", handleOnline);
        window.addEventListener("offline", handleOffline);
        return () => {
            window.removeEventListener("online", handleOnline);
            window.removeEventListener("offline", handleOffline);
        };
    }, [userKey]);

    useEffect(() => {
        if (!userKey) return;
        refreshOfflineCount(userKey);
        if (navigator.onLine) {
            processOfflineQueue(userKey).catch((error) => console.error(error.message));
            warmExerciseCatalogCache().catch((error) => console.error(error.message));
        }
    }, [userKey]);

    useEffect(() => {
        if (!draftReady) return;
        saveTrackerDraft({ exerciseName, sets });
    }, [draftReady, exerciseName, sets]);

    useEffect(() => {
        if (!draftReady) return;
        saveWorkoutDraft({ workoutName, workoutId: currentWorkoutId || undefined, exercises: workoutQueue.length ? workoutQueue : [blankExercise()] });
    }, [currentWorkoutId, draftReady, workoutName, workoutQueue]);

    useEffect(() => {
        if (!draftReady) return;
        saveWorkoutUiState({ active: draftWorkoutActive, expanded: Boolean(fullscreenExerciseId), startedAt: workoutStartedAt });
    }, [draftReady, draftWorkoutActive, fullscreenExerciseId, workoutStartedAt]);

    useEffect(() => {
        if (!draftReady) return;
        if (!routineBuilderOpen) return;
        saveRoutineBuilderDraft({ open: true, editingRoutineId, title: routineTitle, exercises: routineExercises, expandedIds: expandedWorkoutExerciseIds });
    }, [draftReady, editingRoutineId, expandedWorkoutExerciseIds, routineBuilderOpen, routineExercises, routineTitle]);

    useEffect(() => {
        if (!draftReady) return;
        const persistDrafts = () => {
            saveTrackerDraft({ exerciseName, sets });
            saveWorkoutDraft({ workoutName, workoutId: currentWorkoutId || undefined, exercises: workoutQueue.length ? workoutQueue : [blankExercise()] });
            if (routineBuilderOpen) saveRoutineBuilderDraft({ open: true, editingRoutineId, title: routineTitle, exercises: routineExercises, expandedIds: expandedWorkoutExerciseIds });
        };
        window.addEventListener("pagehide", persistDrafts);
        window.addEventListener("beforeunload", persistDrafts);
        return () => {
            window.removeEventListener("pagehide", persistDrafts);
            window.removeEventListener("beforeunload", persistDrafts);
        };
    }, [currentWorkoutId, draftReady, editingRoutineId, exerciseName, expandedWorkoutExerciseIds, routineBuilderOpen, routineExercises, routineTitle, sets, workoutName, workoutQueue]);

    useEffect(() => {
        const query = exerciseName.trim();
        if (query.length < 2) {
            setCatalogSuggestions([]);
            return;
        }

        let cancelled = false;
        const timeout = window.setTimeout(async () => {
            if (!navigator.onLine || !isSupabaseConfigured) {
                const cached = await searchCachedExerciseCatalog(query, 8);
                if (!cancelled) setCatalogSuggestions(cached.map((exercise) => ({ ...exercise, source: "catalog" })));
                return;
            }

            const customRows = await searchCustomExercises(query, 8);
            const { data, error } = await supabase
                .from("exercise_catalog")
                .select("id,name,category,muscles,equipment,image_url")
                .ilike("name", `%${query}%`)
                .order("name", { ascending: true })
                .limit(8);

            if (cancelled) return;
            if (error) {
                console.error(error.message);
                const cached = await searchCachedExerciseCatalog(query, 8);
                setCatalogSuggestions([...customRows, ...cached.map((exercise) => ({ ...exercise, source: "catalog" as const }))].slice(0, 8));
                return;
            }

            const rows = (data ?? []) as Omit<ExerciseSuggestion, "source">[];
            await cacheExerciseCatalog(rows);
            const suggestions = new Map<string, ExerciseSuggestion>();
            [...customRows, ...rows.map((exercise) => ({ ...exercise, source: "catalog" as const }))].forEach((exercise) => suggestions.set(normalise(exercise.name), exercise));
            setCatalogSuggestions(Array.from(suggestions.values()).slice(0, 8));
        }, 180);

        return () => {
            cancelled = true;
            window.clearTimeout(timeout);
        };
    }, [exerciseName, userKey]);

    const pickerRecentExerciseNames = useMemo(() => {
        return Array.from(new Set(recentWorkouts.flatMap((workout) => (workout.workout_exercises ?? []).map((exercise) => exercise.exercise_name.trim()).filter(Boolean))));
    }, [recentWorkouts]);

    const workoutExerciseMeta = useMemo(() => {
        return new Map(muscleCatalog.map((exercise) => [normalise(exercise.name), exercise]));
    }, [muscleCatalog]);

    const finishWorkoutPhotoPreviews = useMemo(() => finishWorkoutPhotos.map((file) => ({ file, url: URL.createObjectURL(file) })), [finishWorkoutPhotos]);
    const editWorkoutPhotoPreviews = useMemo(() => editWorkoutPhotos.map((file) => ({ file, url: URL.createObjectURL(file) })), [editWorkoutPhotos]);

    useEffect(() => {
        return () => finishWorkoutPhotoPreviews.forEach((preview) => URL.revokeObjectURL(preview.url));
    }, [finishWorkoutPhotoPreviews]);

    useEffect(() => {
        return () => editWorkoutPhotoPreviews.forEach((preview) => URL.revokeObjectURL(preview.url));
    }, [editWorkoutPhotoPreviews]);

    useEffect(() => {
        if (!exercisePickerOpen) return;
        const query = exercisePickerSearch.trim();
        if (query.length < 2) {
            setExercisePickerSuggestions([]);
            return;
        }

        let cancelled = false;
        const timeout = window.setTimeout(async () => {
            const recentRows: ExerciseSuggestion[] = pickerRecentExerciseNames
                .filter((name) => normalise(name).includes(normalise(query)))
                .map((name) => {
                    const key = normalise(name);
                    const meta = workoutExerciseMeta.get(key);
                    return {
                        id: key,
                        name,
                        category: "Recent",
                        muscles: meta?.muscles ?? [],
                        equipment: meta?.equipment ?? [],
                        image_url: meta?.image_url ?? null,
                        source: "history" as const,
                    };
                });

            if (!navigator.onLine || !isSupabaseConfigured) {
                const cached = await searchCachedExerciseCatalog(query, 20);
                if (!cancelled) {
                    const suggestions = new Map<string, ExerciseSuggestion>();
                    [...recentRows, ...cached.map((exercise) => ({ ...exercise, source: "catalog" as const }))].forEach((exercise) => suggestions.set(normalise(exercise.name), exercise));
                    setExercisePickerSuggestions(Array.from(suggestions.values()).slice(0, 20));
                }
                return;
            }

            const customRows = await searchCustomExercises(query, 20);
            const { data, error } = await supabase
                .from("exercise_catalog")
                .select("id,name,category,muscles,equipment,image_url")
                .ilike("name", `%${query}%`)
                .order("name", { ascending: true })
                .limit(20);

            if (cancelled) return;
            if (error) {
                console.error(error.message);
                setExercisePickerSuggestions(customRows);
                return;
            }

            const rows = (data ?? []) as Omit<ExerciseSuggestion, "source">[];
            await cacheExerciseCatalog(rows);
            const suggestions = new Map<string, ExerciseSuggestion>();
            [...recentRows, ...customRows, ...rows.map((exercise) => ({ ...exercise, source: "catalog" as const }))].forEach((exercise) => suggestions.set(normalise(exercise.name), exercise));
            setExercisePickerSuggestions(Array.from(suggestions.values()).slice(0, 20));
        }, 180);

        return () => {
            cancelled = true;
            window.clearTimeout(timeout);
        };
    }, [exercisePickerOpen, exercisePickerSearch, pickerRecentExerciseNames, userKey, workoutExerciseMeta]);

    useEffect(() => {
        const query = progressExercise.trim();
        if (query.length < 2) {
            setProgressCatalogSuggestions([]);
            return;
        }

        let cancelled = false;
        const timeout = window.setTimeout(async () => {
            if (!navigator.onLine || !isSupabaseConfigured) {
                const cached = await searchCachedExerciseCatalog(query, 8);
                if (!cancelled) setProgressCatalogSuggestions(cached.map((exercise) => ({ ...exercise, source: "catalog" })));
                return;
            }

            const customRows = await searchCustomExercises(query, 8);
            const { data, error } = await supabase
                .from("exercise_catalog")
                .select("id,name,category,muscles,equipment,image_url")
                .ilike("name", `%${query}%`)
                .order("name", { ascending: true })
                .limit(8);

            if (cancelled) return;
            if (error) {
                console.error(error.message);
                const cached = await searchCachedExerciseCatalog(query, 8);
                setProgressCatalogSuggestions([...customRows, ...cached.map((exercise) => ({ ...exercise, source: "catalog" as const }))].slice(0, 8));
                return;
            }

            const rows = (data ?? []) as Omit<ExerciseSuggestion, "source">[];
            await cacheExerciseCatalog(rows);
            const suggestions = new Map<string, ExerciseSuggestion>();
            [...customRows, ...rows.map((exercise) => ({ ...exercise, source: "catalog" as const }))].forEach((exercise) => suggestions.set(normalise(exercise.name), exercise));
            setProgressCatalogSuggestions(Array.from(suggestions.values()).slice(0, 8));
        }, 180);

        return () => {
            cancelled = true;
            window.clearTimeout(timeout);
        };
    }, [progressExercise, userKey]);

    useEffect(() => {
        const activeExercise = editWorkoutExercises.find((exercise) => exercise.id === activeEditExerciseId);
        const query = activeExercise?.name.trim() ?? "";
        if (!activeEditExerciseId || query.length < 2) {
            setEditExerciseSuggestions([]);
            return;
        }

        let cancelled = false;
        const timeout = window.setTimeout(async () => {
            const customRows = await searchCustomExercises(query, 8);
            if (!navigator.onLine || !isSupabaseConfigured) {
                const cached = await searchCachedExerciseCatalog(query, 8);
                if (!cancelled) setEditExerciseSuggestions([...customRows, ...cached.map((exercise) => ({ ...exercise, source: "catalog" as const }))].slice(0, 8));
                return;
            }

            const { data, error } = await supabase
                .from("exercise_catalog")
                .select("id,name,category,muscles,equipment,image_url")
                .ilike("name", `%${query}%`)
                .order("name", { ascending: true })
                .limit(8);

            if (cancelled) return;
            if (error) {
                console.error(error.message);
                setEditExerciseSuggestions(customRows);
                return;
            }
            const suggestions = new Map<string, ExerciseSuggestion>();
            [...customRows, ...((data ?? []) as Omit<ExerciseSuggestion, "source">[]).map((exercise) => ({ ...exercise, source: "catalog" as const }))].forEach((exercise) => suggestions.set(normalise(exercise.name), exercise));
            setEditExerciseSuggestions(Array.from(suggestions.values()).slice(0, 8));
        }, 180);

        return () => {
            cancelled = true;
            window.clearTimeout(timeout);
        };
    }, [activeEditExerciseId, editWorkoutExercises, userKey]);

    useEffect(() => {
        const query = progressExercise.trim();
        if (!userKey || !isSupabaseConfigured || !query) {
            setProgressHistory([]);
            return;
        }

        let cancelled = false;
        const timeout = window.setTimeout(async () => {
            const { data, error } = await supabase
                .from("workout_exercises")
                .select("*")
                .eq("user_key", userKey)
                .ilike("exercise_name", query)
                .order("created_at", { ascending: true })
                .limit(200);

            if (cancelled) return;
            if (error) {
                console.error(error.message);
                setProgressHistory([]);
                return;
            }

            setProgressHistory((data ?? []) as WorkoutExercise[]);
        }, 180);

        return () => {
            cancelled = true;
            window.clearTimeout(timeout);
        };
    }, [progressExercise, userKey]);

    useEffect(() => {
        const names = Array.from(new Set(recentWorkouts.flatMap((workout) => (workout.workout_exercises ?? []).map((exercise) => exercise.exercise_name.trim()).filter(Boolean))));
        if (!names.length || !isSupabaseConfigured || !navigator.onLine) {
            setMuscleCatalog([]);
            return;
        }

        let cancelled = false;
        async function loadMuscleCatalog() {
            const { data, error } = await supabase
                .from("exercise_catalog")
                .select("name,muscles,muscles_secondary,equipment,image_url")
                .in("name", names)
                .limit(500);

            const custom = userKey ? await supabase
                .from("custom_exercises")
                .select("name,muscles,muscles_secondary,equipment")
                .eq("user_key", userKey)
                .in("name", names)
                .limit(500) : { data: [], error: null };

            if (cancelled) return;
            if (error || custom.error) {
                console.error(error?.message || custom.error?.message);
                setMuscleCatalog([]);
                return;
            }
            setMuscleCatalog([...(data ?? []), ...(custom.data ?? [])] as MuscleCatalogItem[]);
        }

        loadMuscleCatalog();
        return () => {
            cancelled = true;
        };
    }, [recentWorkouts, userKey]);

    useEffect(() => {
        loadDraftExerciseHistory([...workoutQueue.map((exercise) => exercise.name), exerciseName]);
    }, [exerciseName, workoutQueue.map((exercise) => normalise(exercise.name)).join("|"), userKey]);

    async function signInWithEmail() {
        const email = authEmail.trim();
        if (!email || !authPassword) return alert("Enter your email and password.");
        setAuthMessage("");
        const { error } = await supabase.auth.signInWithPassword({ email, password: authPassword });
        if (error) return alert(error.message);
        setAuthPassword("");
        setAuthModalOpen(false);
    }

    async function signUpWithEmail() {
        const email = authEmail.trim();
        if (!email || !authPassword) return alert("Enter your email and password.");
        if (authPassword.length < 6) return alert("Password must be at least 6 characters.");
        setAuthMessage("");
        const { error } = await supabase.auth.signUp({ email, password: authPassword });
        if (error) return alert(error.message);
        setAuthPassword("");
        setAuthMessage("Account created. If email confirmations are enabled, check your email, then sign in.");
    }

    async function askAgent(questionOverride?: string) {
        const question = (questionOverride ?? agentQuestion).trim();
        if (!question) return;
        if (!authUserEmail) {
            setAgentError("Sign in before asking ProgressFit.");
            return;
        }

        const userMessage: AgentChatMessage = { id: crypto.randomUUID(), role: "user", content: question };
        const nextMessages = [...agentMessages, userMessage];
        setAgentMessages(nextMessages);
        setAgentQuestion("");
        setAgentLoading(true);
        setAgentError("");
        const { data } = await supabase.auth.getSession();
        const token = data.session?.access_token;
        if (!token) {
            setAgentLoading(false);
            setAgentError("Sign in before asking ProgressFit.");
            return;
        }

        try {
            const response = await fetch("/api/agent", {
                method: "POST",
                headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
                body: JSON.stringify({ question, messages: nextMessages.map((message) => ({ role: message.role, content: message.content })), context: agentContext }),
            });
            const body = await response.json();
            if (!response.ok) throw new Error(body.error || "ProgressFit could not answer that yet.");
            const answer = body as AgentAnswer;
            setAgentContext(answer.context);
            setAgentMessages((current) => [...current, { id: crypto.randomUUID(), role: "assistant", content: answer.answer, breakdown: answer.breakdown, tables: answer.tables }]);
        } catch (error) {
            const message = error instanceof Error ? error.message : "ProgressFit could not answer that yet.";
            setAgentError(message);
            setAgentMessages((current) => [...current, { id: crypto.randomUUID(), role: "assistant", content: message }]);
        } finally {
            setAgentLoading(false);
        }
    }

    async function signOut() {
        await supabase.auth.signOut();
        setLogoutConfirmOpen(false);
        setUserKey("");
        setAuthUserEmail("");
        setHistory([]);
        setDraftExerciseHistory([]);
        setRecentWorkouts([]);
        setBodyWeights([]);
        setBodyWeightHistory([]);
        setProgressHistory([]);
    }

    async function refreshOfflineCount(key = userKey) {
        setOfflineQueueCount(await getOfflineQueueCount(key));
    }

    const toggleListValue = (values: string[], value: string) => values.includes(value) ? values.filter((item) => item !== value) : [...values, value];

    const customSuggestion = (exercise: Pick<CustomExercise, "id" | "name" | "category" | "muscles" | "equipment">): ExerciseSuggestion => ({
        id: exercise.id,
        name: exercise.name,
        category: exercise.category || "Custom",
        muscles: exercise.muscles ?? [],
        equipment: exercise.equipment ?? [],
        image_url: null,
        source: "custom",
    });

    async function searchCustomExercises(query: string, limit = 8) {
        if (!userKey || !navigator.onLine || !isSupabaseConfigured) return [] as ExerciseSuggestion[];
        const { data, error } = await supabase
            .from("custom_exercises")
            .select("id,name,category,muscles,equipment")
            .eq("user_key", userKey)
            .ilike("name", `%${query}%`)
            .order("name", { ascending: true })
            .limit(limit);
        if (error) {
            console.error(error.message);
            return [];
        }
        return ((data ?? []) as Array<Pick<CustomExercise, "id" | "name" | "category" | "muscles" | "equipment">>).map(customSuggestion);
    }

    function openCustomExerciseModal(name: string, target: "tracker" | "progress" | "edit" | "routine" | "routine-edit") {
        setCustomExerciseName(name.trim());
        setCustomExerciseCategory("");
        setCustomExerciseMuscles([]);
        setCustomExerciseEquipment([]);
        setCustomExerciseTarget(target);
        setCustomExerciseModalOpen(true);
    }

    async function saveCustomExercise() {
        const name = customExerciseName.trim();
        if (!name) return alert("Enter an exercise name.");
        if (!userKey) return alert("Sign in before adding custom exercises.");

        const payload = {
            user_key: userKey,
            name,
            category: customExerciseCategory.trim() || null,
            muscles: customExerciseMuscles,
            muscles_secondary: [],
            equipment: customExerciseEquipment,
            updated_at: new Date().toISOString(),
        };
        const existing = await supabase
            .from("custom_exercises")
            .select("id")
            .eq("user_key", userKey)
            .ilike("name", name)
            .maybeSingle();
        if (existing.error) return alert(existing.error.message);
        const query = existing.data?.id
            ? supabase.from("custom_exercises").update(payload).eq("id", existing.data.id).eq("user_key", userKey)
            : supabase.from("custom_exercises").insert(payload);
        const { data, error } = await query.select("id,name,category,muscles,equipment").single();
        if (error) return alert(error.message);

        const suggestion = customSuggestion(data as Pick<CustomExercise, "id" | "name" | "category" | "muscles" | "equipment">);
        if (customExerciseTarget === "tracker") {
            addToWorkout(suggestion.name, suggestion);
            setCatalogSuggestions([]);
            setExercisePickerOpen(false);
        } else if (customExerciseTarget === "progress") {
            setProgressExercise(suggestion.name);
            setProgressCatalogSuggestions([]);
        } else if (customExerciseTarget === "edit" && activeEditExerciseId) {
            updateEditWorkoutExercise(activeEditExerciseId, { name: suggestion.name, image_url: suggestion.image_url, equipment: suggestion.equipment ?? [] });
            setEditExerciseSuggestions([]);
            setExercisePickerOpen(false);
        } else if (customExerciseTarget === "routine") {
            const id = crypto.randomUUID();
            setRoutineExercises((prev) => prev.some((exercise) => normalise(exercise.name) === normalise(suggestion.name)) ? prev : [...prev, { id, name: suggestion.name, notes: "", setRows: [{ set: 1, reps: 0, weight: 0, notes: "" }], image_url: suggestion.image_url, equipment: suggestion.equipment ?? [] }]);
            setExpandedWorkoutExerciseIds((current) => current.includes(id) ? current : [...current, id]);
            setExercisePickerOpen(false);
        } else if (customExerciseTarget === "routine-edit" && activeRoutineExerciseId) {
            updateRoutineExercise(activeRoutineExerciseId, { name: suggestion.name, image_url: suggestion.image_url, equipment: suggestion.equipment ?? [] });
            setExercisePickerOpen(false);
            setActiveRoutineExerciseId("");
        }
        setCustomExerciseModalOpen(false);
        setToast(`${suggestion.name} added`);
        setTimeout(() => setToast(""), TOAST_DURATION_MS);
    }

    async function warmExerciseCatalogCache() {
        if (!navigator.onLine || !isSupabaseConfigured) return;
        const cacheKey = "progressfit-exercise-catalog-cache-v1";
        if (localStorage.getItem(cacheKey)) return;

        const { data, error } = await supabase
            .from("exercise_catalog")
            .select("id,name,category,muscles,equipment,image_url")
            .order("name", { ascending: true })
            .range(0, 499);

        if (error) return console.error(error.message);
        await cacheExerciseCatalog((data ?? []) as Omit<ExerciseSuggestion, "source">[]);
        localStorage.setItem(cacheKey, new Date().toISOString());
    }

    async function updateOfflineQueuedExercise(exercise: ExerciseDraft, name: string, rows: Array<{ set: number; reps: number; weight: number; notes?: string }>) {
        const queueId = exercise.savedExerciseId ? offlineQueueIdFrom(exercise.savedExerciseId) : NaN;
        if (!Number.isFinite(queueId)) return false;
        const queued = await offlineDb.queue.get(queueId);
        if (queued?.type !== "save_workout") return false;

        await offlineDb.queue.update(queueId, {
            payload: {
                name,
                exercises: [{ name, sets: rows, notes: exercise.notes?.trim() || null, body_weight: currentBodyWeight }],
            } satisfies OfflineWorkoutPayload,
        });
        return true;
    }

    async function executeOfflineItem(item: OfflineQueueItem) {
        if (item.type === "save_body_weight") {
            const payload = item.payload as OfflineBodyWeightPayload;
            const { error } = await supabase.from("body_weights").upsert(payload, { onConflict: "user_key,measured_on" });
            if (error) throw error;
            return;
        }

        if (item.type === "save_workout") {
            const payload = item.payload as OfflineWorkoutPayload;
            if (!payload.exercises.length) return;
            const { data: workout, error: workoutError } = await supabase
                .from("workouts")
                .insert({ user_key: item.userKey, name: payload.name, notes: payload.notes ?? null })
                .select("id")
                .single();
            if (workoutError || !workout) throw workoutError ?? new Error("Could not sync workout");

            const exercises = payload.exercises.map((exercise) => ({
                workout_id: workout.id,
                user_key: item.userKey,
                exercise_name: exercise.name,
                sets: exercise.sets.length,
                reps: Math.max(...exercise.sets.map((set) => set.reps)),
                weight: Math.max(...exercise.sets.map((set) => set.weight)),
                volume: exercise.sets.reduce((sum, set) => sum + set.reps * set.weight, 0),
                set_rows: exercise.sets,
                notes: exercise.notes ?? null,
                body_weight: exercise.body_weight ?? null,
            }));

            const { error } = await supabase.from("workout_exercises").insert(exercises);
            if (error) {
                await supabase.from("workouts").delete().eq("id", workout.id).eq("user_key", item.userKey);
                throw error;
            }
        }
    }

    async function processOfflineQueue(key = userKey) {
        if (!key || !navigator.onLine || !isSupabaseConfigured || offlineSyncInFlightRef.current) return;
        offlineSyncInFlightRef.current = true;
        setSyncingOffline(true);
        try {
            const items = await offlineDb.queue.where("userKey").equals(key).sortBy("createdAt");
            for (const item of items) {
                if (!item.id) continue;
                await executeOfflineItem(item);
                await offlineDb.queue.delete(item.id);
            }
            await refreshOfflineCount(key);
            await loadData(key);
            setWorkoutQueue((prev) => prev.map((exercise) => exercise.savedExerciseId?.startsWith("offline-") ? { ...exercise, savedExerciseId: undefined } : exercise));
        } finally {
            offlineSyncInFlightRef.current = false;
            setSyncingOffline(false);
        }
    }

    async function loadData(key = userKey) {
        if (!key || !isSupabaseConfigured) return;
        await Promise.all([loadHistory(key), loadRecentWorkouts(key), loadRoutines(key), loadBodyWeights(key), loadBodyWeightHistory(key)]);
    }

    async function refreshWorkoutData() {
        if (isPullRefreshing) return;
        setIsPullRefreshing(true);
        try {
            await refreshOfflineCount();
            await loadData();
        } finally {
            setPullRefreshDistance(0);
            setIsPullRefreshing(false);
            pullRefreshRef.current = null;
        }
    }

    function canStartPullRefresh() {
        return activeSection === "workouts" && !editingWorkoutFullscreen && !isPullRefreshing && window.scrollY <= 2;
    }

    function startPullRefresh(event: TouchEvent<HTMLElement>) {
        if (!canStartPullRefresh() || event.touches.length !== 1) return;
        pullRefreshRef.current = { startY: event.touches[0].clientY, active: true };
    }

    function movePullRefresh(event: TouchEvent<HTMLElement>) {
        const gesture = pullRefreshRef.current;
        if (!gesture?.active || event.touches.length !== 1) return;
        const distance = event.touches[0].clientY - gesture.startY;
        if (distance <= 0) {
            setPullRefreshDistance(0);
            return;
        }
        if (window.scrollY > 2) {
            pullRefreshRef.current = null;
            setPullRefreshDistance(0);
            return;
        }
        setPullRefreshDistance(Math.min(112, distance * 0.55));
    }

    function endPullRefresh() {
        const shouldRefresh = pullRefreshDistance >= PULL_REFRESH_THRESHOLD;
        pullRefreshRef.current = null;
        if (shouldRefresh) {
            void refreshWorkoutData();
            return;
        }
        setPullRefreshDistance(0);
    }

    function blurActiveInput() {
        if (document.activeElement !== exercisePickerInputRef.current) return;
        document.documentElement.style.setProperty("--app-viewport-height", `${window.innerHeight}px`);
        exercisePickerInputRef.current?.blur();
        window.requestAnimationFrame(() => {
            document.documentElement.style.setProperty("--app-viewport-height", `${window.innerHeight}px`);
            exercisePickerInputRef.current?.blur();
        });
    }

    async function loadHistory(key = userKey) {
        if (!key || !isSupabaseConfigured) return;
        const { data, error } = await supabase
            .from("workout_exercises")
            .select("*")
            .eq("user_key", key)
            .order("created_at", { ascending: false })
            .limit(50);

        if (error) return console.error(error.message);
        setHistory(data ?? []);
    }

    async function loadDraftExerciseHistory(names: string[], key = userKey) {
        const uniqueNames = Array.from(new Set(names.map((name) => name.trim()).filter(Boolean)));
        if (!key || !isSupabaseConfigured || !uniqueNames.length) {
            setDraftExerciseHistory([]);
            return;
        }

        const queries = uniqueNames.flatMap(exerciseSearchVariants).map((name) => supabase
            .from("workout_exercises")
            .select("*")
            .eq("user_key", key)
            .ilike("exercise_name", `%${name}%`)
            .order("created_at", { ascending: false })
            .limit(10));

        const results = await Promise.all(queries);
        const firstError = results.find((result) => result.error)?.error;
        if (firstError) return console.error(firstError.message);
        const allowedNames = new Set(uniqueNames.map(normalise));
        const rows = new Map<string, WorkoutExercise>();
        results.flatMap((result) => (result.data ?? []) as WorkoutExercise[]).forEach((row) => {
            if (allowedNames.has(normalise(row.exercise_name))) rows.set(row.id, row);
        });
        setDraftExerciseHistory(Array.from(rows.values()).sort((a, b) => b.created_at.localeCompare(a.created_at)));
    }

    async function loadRecentWorkouts(key = userKey) {
        if (!key || !isSupabaseConfigured) return;
        const { data, error } = await supabase
            .from("workouts")
            .select("*, workout_exercises(*)")
            .eq("user_key", key)
            .order("created_at", { ascending: false })
            .limit(500);

        if (error) return console.error(error.message);
        setRecentWorkouts((data ?? []) as WorkoutWithExercises[]);
    }

    async function loadRoutines(key = userKey) {
        if (!key || !isSupabaseConfigured) return;
        const { data, error } = await supabase
            .from("routines")
            .select("*, routine_exercises(*)")
            .eq("user_key", key)
            .order("created_at", { ascending: false });

        if (error) return console.error(error.message);
        setRoutines(((data ?? []) as RoutineWithExercises[]).map((routine) => ({
            ...routine,
            routine_exercises: (routine.routine_exercises ?? []).slice().sort((a, b) => Number(a.position) - Number(b.position)),
        })));
    }

    async function loadBodyWeights(key = userKey, page = weightPage) {
        if (!key || !isSupabaseConfigured) return;
        const from = page * WEIGHT_PAGE_SIZE;
        const to = from + WEIGHT_PAGE_SIZE - 1;
        const { data, error, count } = await supabase
            .from("body_weights")
            .select("*", { count: "exact" })
            .eq("user_key", key)
            .order("measured_on", { ascending: false })
            .range(from, to);

        if (error) return console.error(error.message);
        setBodyWeights((data ?? []) as BodyWeight[]);
        setBodyWeightCount(count ?? 0);
    }

    async function loadBodyWeightHistory(key = userKey) {
        if (!key || !isSupabaseConfigured) return;
        const { data, error } = await supabase
            .from("body_weights")
            .select("*")
            .eq("user_key", key)
            .order("measured_on", { ascending: true })
            .limit(365);

        if (error) return console.error(error.message);
        setBodyWeightHistory((data ?? []) as BodyWeight[]);
    }

    const exerciseHistoryRows = useMemo(() => {
        const rows = new Map<string, WorkoutExercise>();
        [...draftExerciseHistory, ...history].forEach((row) => rows.set(row.id, row));
        return Array.from(rows.values());
    }, [draftExerciseHistory, history]);

    const exerciseNames = useMemo(() => {
        return Array.from(new Set(exerciseHistoryRows.map((h) => h.exercise_name)));
    }, [exerciseHistoryRows]);

    const exerciseSuggestions = useMemo(() => {
        const q = normalise(exerciseName);
        if (!q) return [];

        const suggestions = new Map<string, ExerciseSuggestion>();
        exerciseNames
            .filter((name) => normalise(name).includes(q))
            .forEach((name) => {
                const key = normalise(name);
                if (!suggestions.has(key)) {
                    suggestions.set(key, { id: key, name, category: "Recent", muscles: [], equipment: [], image_url: null, source: "history" });
                }
            });
        catalogSuggestions.forEach((exercise) => {
            const key = normalise(exercise.name);
            if (!suggestions.has(key)) suggestions.set(key, exercise);
        });

        return Array.from(suggestions.values()).slice(0, 8);
    }, [catalogSuggestions, exerciseName, exerciseNames]);

    const selectedHistory = useMemo(() => {
        const key = normalise(exerciseName);
        if (!key) return [];
        return exerciseHistoryRows.filter((h) => normalise(h.exercise_name) === key);
    }, [exerciseHistoryRows, exerciseName]);

    const filteredWorkouts = useMemo(() => {
        const q = normalise(workoutSearch);

        return recentWorkouts.filter((workout) => {
            const exercises = workout.workout_exercises ?? [];
            const matchesSearch = !q || normalise(workout.name || "").includes(q) || exercises.some((exercise) => normalise(exercise.exercise_name).includes(q));
            const workoutDate = workout.created_at.slice(0, 10);
            const matchesStart = !workoutStartDate || workoutDate >= workoutStartDate;
            const matchesEnd = !workoutEndDate || workoutDate <= workoutEndDate;
            return matchesSearch && matchesStart && matchesEnd;
        });
    }, [recentWorkouts, workoutEndDate, workoutSearch, workoutStartDate]);

    const workoutTotalPages = Math.max(1, Math.ceil(filteredWorkouts.length / PAGE_SIZE));
    const safeWorkoutPage = Math.min(workoutPage, workoutTotalPages - 1);
    const workoutRows = filteredWorkouts.slice(safeWorkoutPage * PAGE_SIZE, safeWorkoutPage * PAGE_SIZE + PAGE_SIZE);
    const hasUnsavedWorkoutExercises = workoutQueue.some((exercise) => !exercise.savedExerciseId);
    const workoutTitle = workoutName.trim() || formatWorkoutName();
    const hasWorkoutNameChanged = workoutTitle !== (savedWorkoutName.trim() || formatWorkoutName());
    const muscleBalance = useMemo(() => {
        const catalogByName = new Map(muscleCatalog.map((exercise) => [normalise(exercise.name), exercise]));
        const totals = new Map<MuscleGroup, number>(MUSCLE_GROUPS.map((group) => [group, 0]));
        const unmatched = new Set<string>();

        recentWorkouts.forEach((workout) => {
            (workout.workout_exercises ?? []).forEach((exercise) => {
                const metadata = catalogByName.get(normalise(exercise.exercise_name));
                if (!metadata) {
                    unmatched.add(exercise.exercise_name);
                    return;
                }

                const volume = Number(exercise.volume) || 0;
                metadata.muscles.forEach((muscle) => {
                    const group = muscleGroupFor(muscle);
                    if (group) totals.set(group, (totals.get(group) ?? 0) + volume);
                });
                metadata.muscles_secondary.forEach((muscle) => {
                    const group = muscleGroupFor(muscle);
                    if (group) totals.set(group, (totals.get(group) ?? 0) + volume * 0.5);
                });
            });
        });

        return {
            data: MUSCLE_GROUPS.map((group) => ({ muscleGroup: group, volume: Math.round(totals.get(group) ?? 0) })),
            unmatchedCount: unmatched.size,
            matchedCount: recentWorkouts.reduce((count, workout) => count + (workout.workout_exercises ?? []).filter((exercise) => catalogByName.has(normalise(exercise.exercise_name))).length, 0),
        };
    }, [muscleCatalog, recentWorkouts]);
    const weightTotalPages = Math.max(1, Math.ceil(bodyWeightCount / WEIGHT_PAGE_SIZE));
    const safeWeightPage = Math.min(weightPage, weightTotalPages - 1);
    const weightRows = bodyWeights;
    const currentBodyWeight = bodyWeights[0]?.weight ?? null;
    const weightKilograms = weightValue && Number.isFinite(Number(weightValue)) ? `${poundsToKilograms(Number(weightValue))} kg` : "";
    const weightChartData = useMemo(() => bodyWeightHistory.map((row) => ({
        date: new Date(`${row.measured_on}T00:00:00`).toLocaleDateString(undefined, { month: "short", day: "numeric" }),
        measuredOn: row.measured_on,
        weight: Number(row.weight),
        notes: row.notes,
    })).filter((row) => Number.isFinite(row.weight)), [bodyWeightHistory]);
    const weightSummary = useMemo(() => {
        if (!weightChartData.length) return null;
        const latest = weightChartData.at(-1)!;
        const previous = weightChartData.length > 1 ? weightChartData.at(-2)! : null;
        const first = weightChartData[0];
        const lowest = weightChartData.reduce((min, row) => row.weight < min.weight ? row : min, first);
        const highest = weightChartData.reduce((max, row) => row.weight > max.weight ? row : max, first);
        return {
            latest,
            previousChange: previous ? Number((latest.weight - previous.weight).toFixed(1)) : 0,
            totalChange: Number((latest.weight - first.weight).toFixed(1)),
            lowest,
            highest,
            entries: weightChartData.length,
        };
    }, [weightChartData]);

    const progressSuggestions = useMemo(() => {
        const q = normalise(progressExercise);
        if (!q) return [];

        const suggestions = new Map<string, ExerciseSuggestion>();
        exerciseNames
            .filter((name) => normalise(name).includes(q))
            .forEach((name) => {
                const key = normalise(name);
                if (!suggestions.has(key)) suggestions.set(key, { id: key, name, category: "Recent", muscles: [], equipment: [], image_url: null, source: "history" });
            });
        progressCatalogSuggestions.forEach((exercise) => {
            const key = normalise(exercise.name);
            if (!suggestions.has(key)) suggestions.set(key, exercise);
        });

        return Array.from(suggestions.values()).slice(0, 8);
    }, [exerciseNames, progressCatalogSuggestions, progressExercise]);

    const progressData = useMemo(() => {
        const key = normalise(progressExercise);
        if (!key) return [];

        const grouped = new Map<string, {
            date: string;
            sortKey: string;
            bestWeight: number;
            bestReps: number;
            estimatedOneRepMax: number;
            volume: number;
            sessions: number;
            bestSet: string;
        }>();

        progressHistory
            .filter((record) => normalise(record.exercise_name) === key)
            .forEach((record) => {
                const sortKey = record.created_at.slice(0, 10);
                const setRows = record.set_rows?.length ? record.set_rows : [{ set: 1, reps: record.reps, weight: record.weight }];
                const bestSet = setRows.reduce<{ weight: number; reps: number; e1rm: number } | null>((best, set) => {
                    const weight = Number(set.weight);
                    const reps = Number(set.reps);
                    const e1rm = estimateOneRepMax(weight, reps);
                    if (!Number.isFinite(weight) || !Number.isFinite(reps)) return best;
                    if (!best || e1rm > best.e1rm || (e1rm === best.e1rm && weight > best.weight)) return { weight, reps, e1rm };
                    return best;
                }, null) ?? { weight: Number(record.weight), reps: Number(record.reps), e1rm: estimateOneRepMax(Number(record.weight), Number(record.reps)) };
                const existing = grouped.get(sortKey);
                const volume = Number(record.volume) || setRows.reduce((sum, set) => sum + Number(set.reps) * Number(set.weight), 0);

                if (!existing) {
                    grouped.set(sortKey, {
                        date: new Date(record.created_at).toLocaleDateString(undefined, { month: "short", day: "numeric" }),
                        sortKey,
                        bestWeight: bestSet.weight,
                        bestReps: bestSet.reps,
                        estimatedOneRepMax: bestSet.e1rm,
                        volume,
                        sessions: 1,
                        bestSet: `${bestSet.weight} lbs × ${bestSet.reps}`,
                    });
                    return;
                }

                existing.volume += volume;
                existing.sessions += 1;
                if (bestSet.e1rm > existing.estimatedOneRepMax || (bestSet.e1rm === existing.estimatedOneRepMax && bestSet.weight > existing.bestWeight)) {
                    existing.bestWeight = bestSet.weight;
                    existing.bestReps = bestSet.reps;
                    existing.estimatedOneRepMax = bestSet.e1rm;
                    existing.bestSet = `${bestSet.weight} lbs × ${bestSet.reps}`;
                }
            });

        return Array.from(grouped.values()).sort((a, b) => a.sortKey.localeCompare(b.sortKey));
    }, [progressHistory, progressExercise]);

    const progressSummary = useMemo(() => {
        if (!progressData.length) return null;
        const latest = progressData.at(-1)!;
        const previous = progressData.length > 1 ? progressData.at(-2)! : null;
        const allTimeBest = progressData.reduce((best, row) => row.estimatedOneRepMax > best.estimatedOneRepMax ? row : best, progressData[0]);
        return {
            latest,
            allTimeBest,
            totalSessions: progressData.reduce((sum, row) => sum + row.sessions, 0),
            e1rmChange: previous ? latest.estimatedOneRepMax - previous.estimatedOneRepMax : 0,
        };
    }, [progressData]);

    const bodyWeightVsExerciseData = useMemo(() => {
        const key = normalise(progressExercise);
        if (!key) return [];

        const bodyWeightsByDate = new Map(bodyWeights.map((row) => [row.measured_on, Number(row.weight)]));
        return progressHistory
            .filter((record) => normalise(record.exercise_name) === key)
            .map((record) => {
                const dateKey = record.created_at.slice(0, 10);
                return {
                    date: new Date(record.created_at).toLocaleDateString(undefined, { month: "short", day: "numeric", year: "numeric" }),
                    bodyWeight: record.body_weight ? Number(record.body_weight) : bodyWeightsByDate.get(dateKey),
                    exerciseWeight: Number(record.weight),
                };
            })
            .filter((row) => Number.isFinite(row.bodyWeight) && Number.isFinite(row.exerciseWeight));
    }, [bodyWeights, progressHistory, progressExercise]);

    function exerciseIsBodyweight(name: string, equipment?: string[] | null) {
        return isBodyweightEquipment(equipment) || isBodyweightEquipment(workoutExerciseMeta.get(normalise(name))?.equipment);
    }

    function lastBestForSet(exerciseName: string, setNumber: number, bodyweight = false) {
        const record = exerciseHistoryRows.find((item) => normalise(item.exercise_name) === normalise(exerciseName));
        const row = record?.set_rows?.find((set) => Number(set.set) === setNumber);
        if (row) return bodyweight ? `${row.reps} reps` : `${row.weight} lbs x ${row.reps}`;
        if (record && setNumber === 1) return bodyweight ? `${record.reps} reps` : `${record.weight} lbs x ${record.reps}`;
        return "—";
    }

    function restAudioContext() {
        const AudioContextClass = window.AudioContext || (window as typeof window & { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
        if (!AudioContextClass) return null;
        restAudioContextRef.current ??= new AudioContextClass();
        restAudioContextRef.current.resume().catch(() => undefined);
        return restAudioContextRef.current;
    }

    function playRestTimerSound() {
        const context = restAudioContext();
        if (!context) return;
        context.resume().then(() => {
            const oscillator = context.createOscillator();
            const gain = context.createGain();
            const now = context.currentTime;
            oscillator.type = "sine";
            oscillator.frequency.setValueAtTime(880, now);
            oscillator.frequency.setValueAtTime(1174, now + 0.12);
            gain.gain.setValueAtTime(0.001, now);
            gain.gain.exponentialRampToValueAtTime(0.18, now + 0.02);
            gain.gain.exponentialRampToValueAtTime(0.001, now + 0.36);
            oscillator.connect(gain);
            gain.connect(context.destination);
            oscillator.start(now);
            oscillator.stop(now + 0.38);
        }).catch(() => undefined);
    }

    async function requestRestTimerNotificationPermission() {
        if (!("Notification" in window) || Notification.permission !== "default") return;
        try {
            await Notification.requestPermission();
        } catch {
            // Notifications are optional; timer behavior should not depend on permission state.
        }
    }

    async function notifyRestTimerComplete() {
        if (!("Notification" in window) || Notification.permission !== "granted") return;
        try {
            navigator.vibrate?.([220, 100, 220]);
            const options = {
                body: "Time for your next set.",
                tag: "rest-timer",
                icon: "/icon-192.png",
                silent: false,
                vibrate: [220, 100, 220],
            } as NotificationOptions;
            if ("serviceWorker" in navigator) {
                const registration = await navigator.serviceWorker.ready;
                await registration.showNotification("Rest timer complete", options);
                return;
            }
            new Notification("Rest timer complete", options);
        } catch {
            // Browsers can still suppress notifications in some background/low-power states.
        }
    }

    function startRestTimer(seconds: number) {
        if (!seconds) return;
        restAudioContext();
        requestRestTimerNotificationPermission();
        restTimerCompletedRef.current = false;
        setRestTimerMinimized(false);
        setRestTimerTotal(seconds);
        setRestTimerRemaining(seconds);
        setRestTimerEndAt(Date.now() + seconds * 1000);
    }

    function decreaseRestTimer() {
        setRestTimerRemaining((remaining) => {
            const next = Math.max(0, remaining - 15);
            setRestTimerEndAt(next ? Date.now() + next * 1000 : 0);
            return next;
        });
    }

    function increaseRestTimer() {
        setRestTimerRemaining((remaining) => {
            const next = Math.max(1, remaining + 15);
            setRestTimerTotal((total) => Math.max(total, next));
            setRestTimerEndAt(Date.now() + next * 1000);
            return next;
        });
    }

    function skipRestTimer() {
        restTimerCompletedRef.current = true;
        setRestTimerRemaining(0);
        setRestTimerTotal(0);
        setRestTimerEndAt(0);
    }

    function previousBestSetValues(exerciseName: string, setNumber: number) {
        const record = exerciseHistoryRows.find((item) => normalise(item.exercise_name) === normalise(exerciseName));
        const row = record?.set_rows?.find((set) => Number(set.set) === setNumber);
        if (row) return { reps: String(row.reps || ""), weight: String(row.weight || "") };
        const fallbackRow = record?.set_rows?.at(-1);
        if (fallbackRow) return { reps: String(fallbackRow.reps || ""), weight: String(fallbackRow.weight || "") };
        if (record && setNumber === 1) return { reps: String(record.reps || ""), weight: String(record.weight || "") };
        return null;
    }

    function trackerSetFromPreviousBest(exerciseName: string, setNumber: number): SetRow {
        const bestValues = previousBestSetValues(exerciseName, setNumber);
        return bestValues ? { id: crypto.randomUUID(), ...bestValues, notes: "", completed: false, prefilled: true } : blankSet();
    }

    function bestPerformedSet(record: WorkoutExercise) {
        const rows = record.set_rows?.length ? record.set_rows : [{ set: 1, reps: record.reps, weight: record.weight }];
        return rows.reduce<{ reps: number; weight: number } | null>((best, set) => {
            const reps = Number(set.reps);
            const weight = Number(set.weight);
            if (!Number.isFinite(reps) || !Number.isFinite(weight)) return best;
            if (!best || weight > best.weight || (weight === best.weight && reps > best.reps)) return { reps, weight };
            return best;
        }, null);
    }

    function validSetRows(sourceSets = sets, bodyweight = false) {
        return sourceSets
            .filter((set) => set.completed)
            .map((set, index) => ({ set: index + 1, reps: Number(set.reps), weight: bodyweight || set.weight === "" ? 0 : Number(set.weight), notes: set.notes?.trim() || undefined }))
            .filter((set) => Number.isFinite(set.reps) && set.reps > 0 && Number.isFinite(set.weight) && set.weight >= 0);
    }

    function clearTracker() {
        setExerciseName("");
        setSelectedExerciseMeta(null);
        setSets(blankTrackerSets());
    }

    function clearCurrentDraft() {
        const keepTrackingOpen = Boolean(fullscreenExerciseId);
        setWorkoutQueue([]);
        setCollapsedQueueIds([]);
        setFullscreenExerciseId(keepTrackingOpen ? "workout" : "");
        setCurrentWorkoutId("");
        if (!keepTrackingOpen) setWorkoutName("");
        setSavedWorkoutName("");
        if (!keepTrackingOpen) {
            setWorkoutStartedAt(Date.now());
            setWorkoutClockTick(Date.now());
        }
        setDraftWorkoutActive(keepTrackingOpen);
        localStorage.removeItem(WORKOUT_UI_STATE_KEY);
        clearTracker();
        setClearDraftModalOpen(false);
        setToast("Draft cleared");
        setTimeout(() => setToast(""), TOAST_DURATION_MS);
    }

    function hasActiveTrackedDraft() {
        return draftWorkoutActive || workoutQueue.length > 0 || Boolean(fullscreenExerciseId);
    }

    function runTrackHomeAction(action: { type: "empty" | "createRoutine" | "startRoutine"; routine?: RoutineWithExercises }) {
        if (hasActiveTrackedDraft()) {
            setPendingDiscardAction(action);
            return;
        }
        if (action.type === "empty") startEmptyWorkout();
        else if (action.type === "createRoutine") openCreateRoutine();
        else if (action.type === "startRoutine" && action.routine) setPendingStartRoutine(action.routine);
    }

    function confirmDiscardAndContinue() {
        const action = pendingDiscardAction;
        setWorkoutQueue([]);
        setCollapsedQueueIds([]);
        setFullscreenExerciseId("");
        setCurrentWorkoutId("");
        setWorkoutName("");
        setSavedWorkoutName("");
        setWorkoutStartedAt(Date.now());
        setWorkoutClockTick(Date.now());
        setDraftWorkoutActive(false);
        localStorage.removeItem(WORKOUT_UI_STATE_KEY);
        clearTracker();
        setPendingDiscardAction(null);
        if (!action) return;
        window.setTimeout(() => {
            if (action.type === "empty") startEmptyWorkout();
            else if (action.type === "createRoutine") openCreateRoutine();
            else if (action.type === "startRoutine" && action.routine) setPendingStartRoutine(action.routine);
        }, 0);
    }

    function updateSet(setId: string, patch: Partial<Omit<SetRow, "id">>) {
        setSets((prev) => prev.map((set) => (set.id === setId ? { ...set, ...patch } : set)));
    }

    function addToWorkout(nameOverride?: string, metaOverride?: ExerciseSuggestion | null) {
        const name = (nameOverride ?? exerciseName).trim();
        if (!name) return alert("Search or enter an exercise name first.");

        const knownExercise = metaOverride
            ?? (selectedExerciseMeta && normalise(selectedExerciseMeta.name) === normalise(name) ? selectedExerciseMeta : null)
            ?? exerciseSuggestions.find((exercise) => normalise(exercise.name) === normalise(name))
            ?? null;
        if (!knownExercise) return alert("Choose an exercise from the suggestions, or use Add custom exercise.");

        const existingExercise = workoutQueue.find((exercise) => normalise(exercise.name) === normalise(name));
        if (existingExercise) {
            setCollapsedQueueIds((prev) => prev.filter((id) => id !== existingExercise.id));
            clearTracker();
            setToast(`${name} is already added`);
            setTimeout(() => setToast(""), TOAST_DURATION_MS);
            return;
        }

        const id = crypto.randomUUID();
        setDraftWorkoutActive(true);
        setWorkoutQueue((prev) => [
            ...prev,
            {
                id,
                name,
                sets: [trackerSetFromPreviousBest(name, 1)],
                image_url: knownExercise.image_url ?? null,
                category: knownExercise.category ?? null,
                muscles: knownExercise.muscles ?? [],
                equipment: knownExercise.equipment ?? [],
                notes: "",
                restTimerSeconds: 0,
            },
        ]);
        setCollapsedQueueIds((prev) => [...prev, id]);
        clearTracker();
        setToast(`${name} added`);
        setTimeout(() => setToast(""), TOAST_DURATION_MS);
    }

    function togglePickerExercise(exercise: ExerciseSuggestion) {
        setSelectedPickerExercises((current) => {
            if (exercisePickerMode === "edit" || exercisePickerMode === "routine-edit") return [exercise];
            return current.some((item) => normalise(item.name) === normalise(exercise.name)) ? current.filter((item) => normalise(item.name) !== normalise(exercise.name)) : [...current, exercise];
        });
        blurActiveInput();
    }

    function openExercisePicker(mode: "track" | "edit" | "routine" | "routine-edit" = "track", editExerciseId = "") {
        setExercisePickerMode(mode);
        if (editExerciseId) setActiveEditExerciseId(editExerciseId);
        if (mode === "routine-edit") setActiveRoutineExerciseId(editExerciseId);
        setSelectedPickerExercises([]);
        setExercisePickerSearch("");
        setExercisePickerSuggestions([]);
        setExercisePickerOpen(true);
    }

    function addSelectedPickerExercises() {
        if (exercisePickerMode === "edit") {
            const selected = selectedPickerExercises[0];
            if (selected && activeEditExerciseId) updateEditWorkoutExercise(activeEditExerciseId, { name: selected.name, image_url: selected.image_url, equipment: selected.equipment ?? [] });
            setExercisePickerOpen(false);
            setExercisePickerMode("track");
            setSelectedPickerExercises([]);
            return;
        }

        if (exercisePickerMode === "routine-edit") {
            const selected = selectedPickerExercises[0];
            if (selected && activeRoutineExerciseId) updateRoutineExercise(activeRoutineExerciseId, { name: selected.name, image_url: selected.image_url, equipment: selected.equipment ?? [] });
            setExercisePickerOpen(false);
            setExercisePickerMode("track");
            setSelectedPickerExercises([]);
            setActiveRoutineExerciseId("");
            return;
        }

        if (exercisePickerMode === "routine") {
            const additions = selectedPickerExercises.filter((exercise) => !routineExercises.some((item) => normalise(item.name) === normalise(exercise.name)));
            const nextExercises = additions.map((exercise) => ({
                id: crypto.randomUUID(),
                name: exercise.name,
                notes: "",
                setRows: [{ set: 1, reps: 0, weight: 0, notes: "" }],
                image_url: exercise.image_url ?? null,
                equipment: exercise.equipment ?? [],
            }));
            setRoutineExercises((prev) => [...prev, ...nextExercises]);
            setExpandedWorkoutExerciseIds((current) => [...current, ...nextExercises.map((exercise) => exercise.id)]);
            setExercisePickerOpen(false);
            setExercisePickerMode("track");
            setSelectedPickerExercises([]);
            return;
        }

        const additions = selectedPickerExercises.filter((exercise) => !workoutQueue.some((item) => normalise(item.name) === normalise(exercise.name)));
        if (!additions.length) {
            setExercisePickerOpen(false);
            return;
        }

        const drafts = additions.map((exercise) => ({
            id: crypto.randomUUID(),
            name: exercise.name,
            sets: [trackerSetFromPreviousBest(exercise.name, 1)],
            image_url: exercise.image_url ?? null,
            category: exercise.category ?? null,
            muscles: exercise.muscles ?? [],
            equipment: exercise.equipment ?? [],
            notes: "",
            restTimerSeconds: 0,
        }));
        setDraftWorkoutActive(true);
        setWorkoutQueue((prev) => [...prev, ...drafts]);
        setCollapsedQueueIds((prev) => fullscreenExerciseId ? prev.filter((id) => !drafts.some((draft) => draft.id === id)) : [...prev, ...drafts.slice(1).map((draft) => draft.id)]);
        if (fullscreenExerciseId) setFullscreenExerciseId(drafts[0].id);
        setExercisePickerOpen(false);
        setToast(`${drafts.length} ${drafts.length === 1 ? "exercise" : "exercises"} added`);
        setTimeout(() => setToast(""), TOAST_DURATION_MS);
    }

    async function saveSingleExercise() {
        const name = exerciseName.trim();
        const rows = validSetRows();
        if (!isSupabaseConfigured) return alert("Add Supabase env vars in .env.local first.");
        if (!name || !rows.length || !userKey) return alert("Add an exercise name and complete at least one valid set first.");

        const saved = await saveExercises([{ name, sets: rows }], name);
        if (saved) clearTracker();
    }

    async function saveWorkoutFromTrackers() {
        if (!workoutQueue.length) return alert("Add at least one exercise before saving a workout.");

        const rows = workoutQueue
            .filter((exercise) => !exercise.savedExerciseId)
            .map((exercise) => ({ exercise, name: exercise.name.trim(), sets: validSetRows(exercise.sets, exerciseIsBodyweight(exercise.name, exercise.equipment)) }))
            .filter((exercise) => exercise.name && exercise.sets.length);

        if (!isSupabaseConfigured) return alert("Add Supabase env vars in .env.local first.");
        if (!rows.length) {
            if (hasWorkoutNameChanged) return saveWorkoutNameChange();
            return alert("Complete at least one valid set before saving a workout.");
        }
        if (!userKey) return alert("Sign in before saving a workout.");

        await confirmSaveWorkout(workoutTitle);
    }

    async function saveWorkoutNameChange() {
        const title = workoutTitle;
        if (!currentWorkoutId) {
            setSavedWorkoutName(title);
            setWorkoutName(title);
            setToast("Workout name saved");
            setTimeout(() => setToast(""), TOAST_DURATION_MS);
            return;
        }
        if (!userKey) return alert("Sign in before updating a workout name.");
        if (!navigator.onLine) return alert("Connect to the internet before updating a saved workout name.");

        setSaving(true);
        const { error } = await supabase.from("workouts").update({ name: title, duration_seconds: workoutElapsedSeconds }).eq("id", currentWorkoutId).eq("user_key", userKey);
        setSaving(false);
        if (error) return alert(error.message);

        setSavedWorkoutName(title);
        setWorkoutName(title);
        await loadData();
        setToast("Workout name updated");
        setTimeout(() => setToast(""), TOAST_DURATION_MS);
    }

    async function confirmSaveWorkout(titleOverride?: string) {
        const rows = workoutQueue
            .filter((exercise) => !exercise.savedExerciseId)
            .map((exercise) => ({ exercise, name: exercise.name.trim(), sets: validSetRows(exercise.sets, exerciseIsBodyweight(exercise.name, exercise.equipment)) }))
            .filter((exercise) => exercise.name && exercise.sets.length);
        const title = titleOverride?.trim() || workoutNameInput.trim() || workoutTitle;

        if (!rows.length) {
            alert("Complete at least one unsaved valid set before saving a workout.");
            return false;
        }

        if (!navigator.onLine) {
            const queueId = await enqueueOffline({
                userKey,
                type: "save_workout",
                payload: {
                    name: title,
                    notes: null,
                    exercises: rows.map(({ exercise, name, sets }) => ({ name, sets, notes: exercise.notes?.trim() || null, body_weight: currentBodyWeight })),
                } satisfies OfflineWorkoutPayload,
            });
            await refreshOfflineCount();
            setWorkoutQueue((prev) => prev.map((exercise) => rows.some((row) => row.exercise.id === exercise.id) ? { ...exercise, savedExerciseId: offlineId("workout", queueId) } : exercise));
            setWorkoutNameModalOpen(false);
            setSavedWorkoutName(title);
            setWorkoutName(title);
            setToast(`${title} saved offline`);
            setTimeout(() => setToast(""), TOAST_DURATION_MS);
            return true;
        }

        setSaving(true);
        const { data: workout, error: workoutError } = await supabase
            .from("workouts")
            .insert({ user_key: userKey, name: title, notes: null, duration_seconds: workoutElapsedSeconds })
            .select("id")
            .single();

        if (workoutError || !workout) {
            setSaving(false);
            alert(workoutError?.message ?? "Could not save workout");
            return false;
        }

        const payload = rows.map(({ exercise, name, sets }) => ({
            workout_id: workout.id,
            user_key: userKey,
            exercise_name: name,
            sets: sets.length,
            reps: Math.max(...sets.map((set) => set.reps)),
            weight: Math.max(...sets.map((set) => set.weight)),
            volume: sets.reduce((sum, set) => sum + set.reps * set.weight, 0),
            set_rows: sets,
            notes: exercise.notes?.trim() || null,
            body_weight: currentBodyWeight,
        }));

        const { error } = await supabase.from("workout_exercises").insert(payload);
        setSaving(false);
        if (error) {
            alert(error.message);
            return false;
        }

        setWorkoutNameModalOpen(false);
        setCurrentWorkoutId(workout.id);
        setWorkoutName(title);
        setSavedWorkoutName(title);
        await loadData();
        setToast(`${title} saved`);
        setTimeout(() => setToast(""), TOAST_DURATION_MS);
        return true;
    }

    async function uploadWorkoutPhotos(workoutId: string, photos: File[]) {
        const urls: string[] = [];
        for (const [index, photo] of photos.entries()) {
            const extension = photo.name.split(".").pop()?.toLowerCase().replace(/[^a-z0-9]/g, "") || "jpg";
            const path = `${userKey}/${workoutId}/${Date.now()}-${index}.${extension}`;
            const { error } = await supabase.storage.from("workout-images").upload(path, photo, { contentType: photo.type || "image/jpeg" });
            if (error) throw error;
            const { data } = supabase.storage.from("workout-images").getPublicUrl(path);
            urls.push(data.publicUrl);
        }
        return urls;
    }

    async function saveFinishedWorkout(details: FinishWorkoutDetails, rows: Array<{ exercise: ExerciseDraft; name: string; sets: Array<{ set: number; reps: number; weight: number; notes?: string }> }>) {
        const title = details.title.trim() || formatWorkoutName();
        const notes = details.notes.trim() || null;
        if (!isSupabaseConfigured) {
            alert("Add Supabase env vars in .env.local first.");
            return false;
        }
        if (!userKey) {
            alert("Sign in before finishing a workout.");
            return false;
        }
        if (!navigator.onLine) {
            const queueId = await enqueueOffline({
                userKey,
                type: "save_workout",
                payload: {
                    name: title,
                    notes,
                    exercises: rows.map(({ exercise, name, sets }) => ({ name, sets, notes: exercise.notes?.trim() || null, body_weight: currentBodyWeight })),
                } satisfies OfflineWorkoutPayload,
            });
            await refreshOfflineCount();
            setWorkoutQueue((prev) => prev.map((exercise) => rows.some((row) => row.exercise.id === exercise.id) ? { ...exercise, savedExerciseId: offlineId("workout", queueId) } : exercise));
            if (details.photos.length) alert("Workout saved offline. Add photos again when you're online.");
            return true;
        }

        const { data: workout, error: workoutError } = await supabase
            .from("workouts")
            .insert({ user_key: userKey, name: title, notes, duration_seconds: workoutElapsedSeconds, photo_urls: [] })
            .select("id")
            .single();
        if (workoutError || !workout) {
            alert(workoutError?.message ?? "Could not finish workout");
            return false;
        }

        if (details.photos.length) {
            try {
                const photoUrls = await uploadWorkoutPhotos(workout.id, details.photos);
                const { error: photoError } = await supabase.from("workouts").update({ photo_urls: photoUrls }).eq("id", workout.id).eq("user_key", userKey);
                if (photoError) throw photoError;
            } catch (error) {
                await supabase.from("workouts").delete().eq("id", workout.id).eq("user_key", userKey);
                alert(error instanceof Error ? error.message : "Could not upload workout photos");
                return false;
            }
        }

        const payload = rows.map(({ exercise, name, sets }) => ({
            workout_id: workout.id,
            user_key: userKey,
            exercise_name: name,
            sets: sets.length,
            reps: Math.max(...sets.map((set) => set.reps)),
            weight: Math.max(...sets.map((set) => set.weight)),
            volume: sets.reduce((sum, set) => sum + set.reps * set.weight, 0),
            set_rows: sets,
            notes: exercise.notes?.trim() || null,
            body_weight: currentBodyWeight,
        }));

        const { error } = await supabase.from("workout_exercises").insert(payload);
        if (error) {
            await supabase.from("workouts").delete().eq("id", workout.id).eq("user_key", userKey);
            alert(error.message);
            return false;
        }
        return true;
    }

    function startEditWorkout(workout: WorkoutWithExercises, options: { fullscreen?: boolean } = {}) {
        setEditingWorkoutId(workout.id);
        setEditingWorkoutFullscreen(Boolean(options.fullscreen));
        setEditWorkoutName(workout.name || formatWorkoutName(new Date(workout.created_at)));
        setEditWorkoutNotes(workout.notes ?? "");
        setEditWorkoutPhotoUrls(workout.photo_urls ?? []);
        setEditWorkoutPhotos([]);
        setEditWorkoutExercises((workout.workout_exercises ?? []).map((exercise) => ({
            id: exercise.id,
            name: exercise.exercise_name,
            notes: exercise.notes ?? "",
            image_url: workoutExerciseMeta.get(normalise(exercise.exercise_name))?.image_url ?? null,
            equipment: workoutExerciseMeta.get(normalise(exercise.exercise_name))?.equipment ?? [],
            setRows: (exercise.set_rows?.length ? exercise.set_rows : [{ set: 1, reps: exercise.reps, weight: exercise.weight }]).map((set, index) => ({
                set: index + 1,
                reps: Number(set.reps),
                weight: Number(set.weight),
                notes: set.notes ?? "",
            })),
        })));
    }

    function cancelEditWorkout() {
        setEditingWorkoutId("");
        setEditingWorkoutFullscreen(false);
        setEditWorkoutName("");
        setEditWorkoutNotes("");
        setEditWorkoutPhotoUrls([]);
        setEditWorkoutPhotos([]);
        setEditWorkoutExercises([]);
    }

    function updateEditWorkoutExercise(exerciseId: string, patch: Partial<EditableWorkoutExercise>) {
        setEditWorkoutExercises((prev) => prev.map((exercise) => exercise.id === exerciseId ? { ...exercise, ...patch } : exercise));
    }

    function updateEditWorkoutSet(exerciseId: string, setIndex: number, patch: Partial<WorkoutSetRow>) {
        setEditWorkoutExercises((prev) => prev.map((exercise) => exercise.id === exerciseId ? {
            ...exercise,
            setRows: exercise.setRows.map((set, index) => index === setIndex ? { ...set, ...patch } : set),
        } : exercise));
    }

    function addEditWorkoutSet(exerciseId: string) {
        setEditWorkoutExercises((prev) => prev.map((exercise) => {
            if (exercise.id !== exerciseId) return exercise;
            const previous = exercise.setRows.at(-1);
            const nextSet = previous ? { set: exercise.setRows.length + 1, reps: previous.reps, weight: previous.weight, notes: "" } : { set: 1, reps: 0, weight: 0, notes: "" };
            return { ...exercise, setRows: [...exercise.setRows, nextSet] };
        }));
    }

    function removeEditWorkoutSet(exerciseId: string, setIndex: number) {
        setEditWorkoutExercises((prev) => prev.map((exercise) => exercise.id === exerciseId ? {
            ...exercise,
            setRows: exercise.setRows.filter((_, index) => index !== setIndex).map((set, index) => ({ ...set, set: index + 1 })),
        } : exercise));
    }

    function startSavedSetSwipe(event: PointerEvent<HTMLElement>, exerciseId: string, setId: string) {
        if (event.pointerType === "mouse" && event.button !== 0) return;
        const startOffset = openSwipeSet?.exerciseId === exerciseId && openSwipeSet.setId === setId ? openSwipeSet.offset : 0;
        swipeGestureRef.current = { exerciseId, setId, startX: event.clientX, startY: event.clientY, startOffset, currentOffset: startOffset, isSwiping: false };
        event.currentTarget.setPointerCapture?.(event.pointerId);
    }

    function moveSavedSetSwipe(event: PointerEvent<HTMLElement>) {
        const gesture = swipeGestureRef.current;
        if (!gesture) return;
        const deltaX = event.clientX - gesture.startX;
        const deltaY = event.clientY - gesture.startY;
        if (!gesture.isSwiping) {
            if (Math.abs(deltaX) < 8 || Math.abs(deltaX) <= Math.abs(deltaY)) return;
            gesture.isSwiping = true;
            setActiveSwipeSetId(gesture.setId);
        }
        event.preventDefault();
        const offset = Math.min(0, Math.max(-SWIPE_DELETE_WIDTH, gesture.startOffset + deltaX));
        gesture.currentOffset = offset;
        setOpenSwipeSet({ exerciseId: gesture.exerciseId, setId: gesture.setId, offset });
    }

    function endSavedSetSwipe() {
        const gesture = swipeGestureRef.current;
        if (!gesture) return;
        const offset = gesture.currentOffset;
        setOpenSwipeSet(offset < -36 ? { exerciseId: gesture.exerciseId, setId: gesture.setId, offset: -SWIPE_DELETE_WIDTH } : null);
        swipeGestureRef.current = null;
        setActiveSwipeSetId("");
    }

    function removeEditWorkoutExercise(exerciseId: string) {
        setEditWorkoutExercises((prev) => prev.filter((exercise) => exercise.id !== exerciseId));
    }

    function addEditWorkoutExercise() {
        const id = `new-${crypto.randomUUID()}`;
        setEditWorkoutExercises((prev) => [...prev, { id, name: "", notes: "", setRows: [{ set: 1, reps: 0, weight: 0, notes: "" }], equipment: [], isNew: true }]);
        setExpandedWorkoutExerciseIds((prev) => [...prev, id]);
        setActiveEditExerciseId(id);
    }

    function updateRoutineExercise(exerciseId: string, patch: Partial<EditableWorkoutExercise>) {
        setRoutineExercises((prev) => prev.map((exercise) => exercise.id === exerciseId ? { ...exercise, ...patch } : exercise));
    }

    function updateRoutineSet(exerciseId: string, setIndex: number, patch: Partial<EditableSetRow>) {
        setRoutineExercises((prev) => prev.map((exercise) => exercise.id === exerciseId ? {
            ...exercise,
            setRows: exercise.setRows.map((set, index) => index === setIndex ? { ...set, ...patch } : set),
        } : exercise));
    }

    function addRoutineSet(exerciseId: string) {
        setRoutineExercises((prev) => prev.map((exercise) => {
            if (exercise.id !== exerciseId) return exercise;
            const previous = exercise.setRows.at(-1);
            const nextSet = previous ? { set: exercise.setRows.length + 1, reps: previous.reps, weight: previous.weight, notes: "" } : { set: 1, reps: 0, weight: 0, notes: "" };
            return { ...exercise, setRows: [...exercise.setRows, nextSet] };
        }));
    }

    function removeRoutineSet(exerciseId: string, setIndex: number) {
        setRoutineExercises((prev) => prev.map((exercise) => exercise.id === exerciseId ? {
            ...exercise,
            setRows: exercise.setRows.filter((_, index) => index !== setIndex).map((set, index) => ({ ...set, set: index + 1 })),
        } : exercise));
    }

    function removeRoutineExercise(exerciseId: string) {
        setRoutineExercises((prev) => prev.filter((exercise) => exercise.id !== exerciseId));
    }

    function openCreateRoutine() {
        setEditingRoutineId("");
        setRoutineTitle("");
        setRoutineExercises([]);
        setExpandedWorkoutExerciseIds([]);
        setRoutineBuilderOpen(true);
    }

    function openEditRoutine(routine: RoutineWithExercises) {
        const exercises = (routine.routine_exercises ?? []).slice().sort((a, b) => Number(a.position) - Number(b.position)).map((exercise) => {
            const meta = workoutExerciseMeta.get(normalise(exercise.exercise_name));
            return {
                id: exercise.id,
                name: exercise.exercise_name,
                notes: exercise.notes ?? "",
                image_url: meta?.image_url ?? null,
                equipment: meta?.equipment ?? [],
                setRows: (exercise.set_rows?.length ? exercise.set_rows : [{ set: 1, reps: 0, weight: 0 }]).map((set, index) => ({
                    set: index + 1,
                    reps: Number(set.reps),
                    weight: Number(set.weight),
                    notes: set.notes ?? "",
                })),
            };
        });
        setEditingRoutineId(routine.id);
        setRoutineTitle(routine.title);
        setRoutineExercises(exercises);
        setExpandedWorkoutExerciseIds([]);
        setRoutineBuilderOpen(true);
    }

    function closeRoutineBuilder() {
        setRoutineBuilderOpen(false);
        setEditingRoutineId("");
        setRoutineTitle("");
        setRoutineExercises([]);
        clearRoutineBuilderDraft();
    }

    async function saveRoutine() {
        const title = routineTitle.trim();
        if (!isSupabaseConfigured) return alert("Add Supabase env vars in .env.local first.");
        if (!userKey) return alert("Sign in before saving a routine.");
        if (!title) return alert("Add a routine title.");
        const exercises = routineExercises.map((exercise) => {
            const isBodyweight = exerciseIsBodyweight(exercise.name, exercise.equipment);
            const rows = exercise.setRows
                .map((set, index) => ({ set: index + 1, reps: Number(set.reps), weight: isBodyweight ? 0 : Number(set.weight), notes: set.notes?.trim() || undefined }))
                .filter((set) => Number.isFinite(set.reps) && set.reps > 0 && Number.isFinite(set.weight) && set.weight >= 0);
            return { ...exercise, setRows: rows };
        }).filter((exercise) => exercise.name.trim() && exercise.setRows.length);
        if (!exercises.length) return alert("Add at least one exercise with a valid set.");

        setSaving(true);
        const wasEditingRoutine = Boolean(editingRoutineId);
        let routineId = editingRoutineId;
        if (editingRoutineId) {
            const { error: routineError } = await supabase
                .from("routines")
                .update({ title, updated_at: new Date().toISOString() })
                .eq("id", editingRoutineId)
                .eq("user_key", userKey);
            if (routineError) {
                setSaving(false);
                return alert(routineError.message);
            }
            const { error: deleteError } = await supabase.from("routine_exercises").delete().eq("routine_id", editingRoutineId).eq("user_key", userKey);
            if (deleteError) {
                setSaving(false);
                return alert(deleteError.message);
            }
        } else {
            const { data: routine, error: routineError } = await supabase.from("routines").insert({ user_key: userKey, title }).select("id").single();
            if (routineError || !routine) {
                setSaving(false);
                return alert(routineError?.message ?? "Could not save routine");
            }
            routineId = routine.id;
        }
        const payload = exercises.map((exercise, index) => ({
            routine_id: routineId,
            user_key: userKey,
            exercise_name: exercise.name.trim(),
            position: index,
            set_rows: exercise.setRows,
            notes: exercise.notes.trim() || null,
        }));
        const { error } = await supabase.from("routine_exercises").insert(payload);
        setSaving(false);
        if (error) return alert(error.message);
        closeRoutineBuilder();
        await loadRoutines();
        setToast(`${title} ${wasEditingRoutine ? "updated" : "saved"}`);
        setTimeout(() => setToast(""), TOAST_DURATION_MS);
    }

    async function deleteRoutine(routine: RoutineWithExercises) {
        const { error } = await supabase.from("routines").delete().eq("id", routine.id).eq("user_key", userKey);
        if (error) return alert(error.message);
        setPendingDeleteRoutine(null);
        setRoutines((current) => current.filter((item) => item.id !== routine.id));
    }

    function startRoutineWorkout(routine: RoutineWithExercises) {
        const now = Date.now();
        const drafts = (routine.routine_exercises ?? []).map((exercise) => {
            const meta = workoutExerciseMeta.get(normalise(exercise.exercise_name));
            return {
                id: crypto.randomUUID(),
                name: exercise.exercise_name,
                sets: (exercise.set_rows?.length ? exercise.set_rows : [{ set: 1, reps: 0, weight: 0 }]).map((set) => ({ id: crypto.randomUUID(), reps: String(set.reps || ""), weight: String(set.weight || ""), notes: set.notes ?? "", completed: false, prefilled: true })),
                image_url: meta?.image_url ?? null,
                category: null,
                muscles: [],
                equipment: meta?.equipment ?? [],
                notes: exercise.notes ?? "",
                restTimerSeconds: 0,
            };
        });
        setWorkoutStartedAt(now);
        setWorkoutClockTick(now);
        setWorkoutName(routine.title);
        setSavedWorkoutName("");
        setCurrentWorkoutId("");
        setWorkoutQueue(drafts);
        setCollapsedQueueIds([]);
        setDraftWorkoutActive(true);
        setFullscreenExerciseId(drafts[0]?.id ?? "workout");
        setPendingStartRoutine(null);
        setActiveSection("exercises");
    }

    async function saveEditWorkout(workout: WorkoutWithExercises) {
        const workoutName = editWorkoutName.trim() || formatWorkoutName(new Date(workout.created_at));
        const exerciseUpdates = editWorkoutExercises.map((exercise) => {
            const isBodyweight = exerciseIsBodyweight(exercise.name, exercise.equipment);
            const rows = exercise.setRows
                .map((set, index) => ({ set: index + 1, reps: Number(set.reps), weight: isBodyweight ? 0 : Number(set.weight), notes: set.notes?.trim() || undefined }))
                .filter((set) => Number.isFinite(set.reps) && set.reps > 0 && Number.isFinite(set.weight) && set.weight >= 0);
            return { ...exercise, setRows: rows };
        }).filter((exercise) => exercise.name.trim() && exercise.setRows.length);

        if (!exerciseUpdates.length) return alert("Keep at least one exercise with a valid set.");

        let nextPhotoUrls = editWorkoutPhotoUrls;
        if (editWorkoutPhotos.length) {
            try {
                const uploadedPhotoUrls = await uploadWorkoutPhotos(workout.id, editWorkoutPhotos);
                nextPhotoUrls = [...editWorkoutPhotoUrls, ...uploadedPhotoUrls];
            } catch (error) {
                return alert(error instanceof Error ? error.message : "Could not upload workout photos");
            }
        }

        const { error: workoutError } = await supabase.from("workouts").update({ name: workoutName, notes: editWorkoutNotes.trim() || null, photo_urls: nextPhotoUrls }).eq("id", workout.id).eq("user_key", userKey);
        if (workoutError) return alert(workoutError.message);

        const keptExerciseIds = new Set(exerciseUpdates.map((exercise) => exercise.id));
        const deletedExerciseIds = (workout.workout_exercises ?? []).map((exercise) => exercise.id).filter((id) => !keptExerciseIds.has(id));
        if (deletedExerciseIds.length) {
            const { error } = await supabase.from("workout_exercises").delete().in("id", deletedExerciseIds).eq("user_key", userKey);
            if (error) return alert(error.message);
        }

        for (const exercise of exerciseUpdates) {
            const payload = {
                exercise_name: exercise.name.trim(),
                sets: exercise.setRows.length,
                reps: Math.max(...exercise.setRows.map((set) => set.reps)),
                weight: Math.max(...exercise.setRows.map((set) => set.weight)),
                volume: exercise.setRows.reduce((sum, set) => sum + set.reps * set.weight, 0),
                set_rows: exercise.setRows,
                notes: exercise.notes.trim() || null,
            };
            const query = exercise.isNew
                ? supabase.from("workout_exercises").insert({ ...payload, workout_id: workout.id, user_key: userKey })
                : supabase.from("workout_exercises").update(payload).eq("id", exercise.id).eq("user_key", userKey);
            const { error } = await query;
            if (error) return alert(error.message);
        }

        setEditWorkoutPhotoUrls(nextPhotoUrls);
        setEditWorkoutPhotos([]);
        cancelEditWorkout();
        await loadData();
        setToast(`${workoutName} updated`);
        setTimeout(() => setToast(""), TOAST_DURATION_MS);
    }

    async function confirmDeleteWorkout() {
        if (!pendingDeleteWorkout) return;
        const workout = pendingDeleteWorkout;
        const name = workout.name || formatWorkoutName(new Date(workout.created_at));

        const { data, error } = await supabase.from("workouts").delete().eq("id", workout.id).eq("user_key", userKey).select("id");
        if (error) return alert(error.message);
        if (!data?.length) return alert("Could not delete workout. Apply the latest Supabase schema so workouts can be deleted.");

        setPendingDeleteWorkout(null);
        setExpandedWorkoutIds((current) => current.filter((id) => id !== workout.id));
        setRecentWorkouts((current) => current.filter((row) => row.id !== workout.id));
        setHistory((current) => current.filter((row) => row.workout_id !== workout.id));
        await loadRecentWorkouts();
        await loadHistory();
        setToast(`${name} deleted`);
        setTimeout(() => setToast(""), TOAST_DURATION_MS);
    }

    async function saveBodyWeight() {
        const weight = Number(weightValue);
        if (!isSupabaseConfigured) return alert("Add Supabase env vars in .env.local first.");
        if (!userKey || !Number.isFinite(weight) || weight <= 0 || !weightDate) return alert("Add a valid weight and date.");

        const payload = { user_key: userKey, weight, measured_on: weightDate, notes: weightNotes.trim() || null };

        if (editingWeightId.startsWith("offline-")) {
            const queueId = offlineQueueIdFrom(editingWeightId);
            if (Number.isFinite(queueId)) await offlineDb.queue.update(queueId, { payload: payload satisfies OfflineBodyWeightPayload });
            setBodyWeights((current) => current.map((row) => row.id === editingWeightId ? { ...row, ...payload } : row));
            setBodyWeightHistory((current) => current.map((row) => row.id === editingWeightId ? { ...row, ...payload } : row).sort((a, b) => a.measured_on.localeCompare(b.measured_on)));
            setEditingWeightId("");
            setWeightValue("");
            setWeightNotes("");
            setWeightDate(todayInputValue());
            setToast("Offline weight updated");
            setTimeout(() => setToast(""), TOAST_DURATION_MS);
            return;
        }

        if (!navigator.onLine && !editingWeightId) {
            const queueId = await enqueueOffline({ userKey, type: "save_body_weight", payload: payload satisfies OfflineBodyWeightPayload });
            await refreshOfflineCount();
            const offlineRow = { id: offlineId("weight", queueId), created_at: new Date().toISOString(), ...payload };
            setBodyWeights((current) => [offlineRow, ...current].slice(0, WEIGHT_PAGE_SIZE));
            setBodyWeightHistory((current) => [...current, offlineRow].sort((a, b) => a.measured_on.localeCompare(b.measured_on)));
            setBodyWeightCount((count) => count + 1);
            setWeightValue("");
            setWeightNotes("");
            setWeightDate(todayInputValue());
            setToast("Weight saved offline");
            setTimeout(() => setToast(""), TOAST_DURATION_MS);
            return;
        }

        const { error } = editingWeightId
            ? await supabase.from("body_weights").update(payload).eq("id", editingWeightId).eq("user_key", userKey)
            : await supabase.from("body_weights").upsert(payload, { onConflict: "user_key,measured_on" });

        if (error) return alert(error.message);
        const wasEditing = Boolean(editingWeightId);
        resetWeightForm();
        setEditingWeightId("");
        setWeightPage(0);
        await Promise.all([loadBodyWeights(userKey, 0), loadBodyWeightHistory(userKey)]);
        setToast(wasEditing ? "Weight updated" : "Weight saved");
        setTimeout(() => setToast(""), TOAST_DURATION_MS);
    }

    function startEditWeight(row: BodyWeight) {
        setActiveSection("weight");
        setEditingWeightId(row.id);
        setWeightValue(String(row.weight));
        setWeightDate(row.measured_on);
        setWeightNotes(row.notes ?? "");
        window.setTimeout(() => {
            weightFormRef.current?.scrollIntoView({ behavior: "smooth", block: "start" });
            weightInputRef.current?.focus();
        }, 0);
    }

    function resetWeightForm() {
        setWeightValue("");
        setWeightNotes("");
        setWeightDate(todayInputValue());
        setEditingWeightId("");
    }

    async function confirmDeleteWeight() {
        if (!pendingDeleteWeight) return;
        if (pendingDeleteWeight.id.startsWith("offline-")) {
            const queueId = offlineQueueIdFrom(pendingDeleteWeight.id);
            if (Number.isFinite(queueId)) await offlineDb.queue.delete(queueId);
            setBodyWeights((current) => current.filter((row) => row.id !== pendingDeleteWeight.id));
            setBodyWeightHistory((current) => current.filter((row) => row.id !== pendingDeleteWeight.id));
            setBodyWeightCount((count) => Math.max(0, count - 1));
            await refreshOfflineCount();
        } else {
            const { error } = await supabase.from("body_weights").delete().eq("id", pendingDeleteWeight.id).eq("user_key", userKey);
            if (error) return alert(error.message);
            await Promise.all([loadBodyWeights(), loadBodyWeightHistory()]);
        }

        setPendingDeleteWeight(null);
        setEditingWeightId("");
        setToast("Weight deleted");
        setTimeout(() => setToast(""), TOAST_DURATION_MS);
    }

    async function saveExercises(rows: Array<{ name: string; sets: Array<{ set: number; reps: number; weight: number; notes?: string }> }>, title: string) {
        setSaving(true);
        const { data: workout, error: workoutError } = await supabase
            .from("workouts")
            .insert({ user_key: userKey, name: title || formatWorkoutName(), duration_seconds: workoutElapsedSeconds })
            .select("id")
            .single();

        if (workoutError || !workout) {
            setSaving(false);
            alert(workoutError?.message ?? "Could not save");
            return false;
        }

        const payload = rows.map((exercise) => ({
            workout_id: workout.id,
            user_key: userKey,
            exercise_name: exercise.name,
            sets: exercise.sets.length,
            reps: Math.max(...exercise.sets.map((set) => set.reps)),
            weight: Math.max(...exercise.sets.map((set) => set.weight)),
            volume: exercise.sets.reduce((sum, set) => sum + set.reps * set.weight, 0),
            set_rows: exercise.sets,
            notes: null,
            body_weight: currentBodyWeight,
        }));

        const { error } = await supabase.from("workout_exercises").insert(payload);
        setSaving(false);
        if (error) {
            alert(error.message);
            return false;
        }

        setExpandedWorkoutIds((current) => current.includes(workout.id) ? current : [...current, workout.id]);
        await loadData();
        setToast("Saved. Nice work 💪");
        setTimeout(() => setToast(""), TOAST_DURATION_MS);
        return true;
    }

    function updateQueuedExerciseNotes(exerciseId: string, notes: string) {
        setWorkoutQueue((prev) => prev.map((exercise) => exercise.id === exerciseId ? { ...exercise, notes } : exercise));
    }

    function updateQueuedSet(exerciseId: string, setId: string, patch: Partial<Omit<SetRow, "id">>) {
        setWorkoutQueue((prev) =>
            prev.map((exercise) =>
                exercise.id === exerciseId
                    ? { ...exercise, sets: exercise.sets.map((set) => (set.id === setId ? { ...set, ...patch } : set)) }
                    : exercise,
            ),
        );
    }

    function toggleQueuedSetCompleted(exerciseId: string, setId: string, completed: boolean, restSeconds: number) {
        setWorkoutQueue((prev) => prev.map((exercise) => {
            if (exercise.id !== exerciseId) return exercise;
            const isBodyweight = exerciseIsBodyweight(exercise.name, exercise.equipment);
            return {
                ...exercise,
                sets: exercise.sets.map((set, index) => {
                    if (set.id !== setId) return set;
                    if (!completed) return { ...set, completed };
                    const fallback = previousBestSetValues(exercise.name, index + 1);
                    return {
                        ...set,
                        completed,
                        prefilled: false,
                        reps: set.reps || fallback?.reps || "",
                        weight: isBodyweight ? "0" : set.weight || fallback?.weight || "",
                    };
                }),
            };
        }));
        if (completed) startRestTimer(restSeconds);
    }

    function addQueuedSet(exerciseId: string) {
        setWorkoutQueue((prev) => prev.map((exercise) => {
            if (exercise.id !== exerciseId) return exercise;
            const nextSet = trackerSetFromPreviousBest(exercise.name, exercise.sets.length + 1);
            return { ...exercise, sets: [...exercise.sets, nextSet] };
        }));
    }

    function removeQueuedSet(exerciseId: string, setId: string) {
        setWorkoutQueue((prev) => prev.map((exercise) => exercise.id === exerciseId ? { ...exercise, sets: exercise.sets.filter((set) => set.id !== setId) } : exercise));
        setOpenSwipeSet((current) => current?.exerciseId === exerciseId && current.setId === setId ? null : current);
    }

    function removeQueuedExercise(exercise: ExerciseDraft) {
        const nextQueue = workoutQueue.filter((item) => item.id !== exercise.id);
        setWorkoutQueue(nextQueue);
        setCollapsedQueueIds((prev) => prev.filter((collapsedId) => collapsedId !== exercise.id));
        setFullscreenExerciseId((id) => !id ? id : id === exercise.id ? nextQueue[0]?.id ?? "workout" : id);
        setPendingRemoveExercise(null);
    }

    function toggleTrackerFullscreen() {
        if (fullscreenExerciseId) {
            setFullscreenExerciseId("");
            return;
        }
        const firstExerciseId = workoutQueue[0]?.id;
        if (!firstExerciseId) return;
        setFullscreenExerciseId(firstExerciseId);
    }

    function startEmptyWorkout() {
        if (!workoutQueue.length) {
            const now = Date.now();
            setWorkoutStartedAt(now);
            setWorkoutClockTick(now);
        }
        setDraftWorkoutActive(true);
        setFullscreenExerciseId("workout");
    }

    function resumeExpandedWorkout() {
        setFullscreenExerciseId(workoutQueue[0]?.id ?? "workout");
    }

    function openFinishDetailsModal() {
        const validExercises = workoutQueue
            .map((exercise) => ({ exercise, name: exercise.name.trim(), sets: validSetRows(exercise.sets, exerciseIsBodyweight(exercise.name, exercise.equipment)) }))
            .filter(({ name, sets }) => name && sets.length);

        if (!validExercises.length) return alert("Complete at least one valid set before finishing.");
        setFinishWorkoutNameInput(workoutTitle);
        setFinishWorkoutNotes("");
        setFinishWorkoutPhotos([]);
        setFinishSummary(null);
        setFinishDetailsModalOpen(true);
    }

    async function finishWorkout(details: FinishWorkoutDetails) {
        const validExercises = workoutQueue
            .map((exercise) => ({ exercise, name: exercise.name.trim(), sets: validSetRows(exercise.sets, exerciseIsBodyweight(exercise.name, exercise.equipment)) }))
            .filter(({ name, sets }) => name && sets.length);

        if (!validExercises.length) return alert("Complete at least one valid set before finishing.");

        setSaving(true);
        const saved = await saveFinishedWorkout(details, validExercises);
        if (!saved) {
            setSaving(false);
            return;
        }
        setSaving(false);
        setFinishDetailsModalOpen(false);

        setFinishSummary(null);
        setWorkoutQueue([]);
        setCollapsedQueueIds([]);
        setFullscreenExerciseId("");
        setCurrentWorkoutId("");
        setWorkoutName("");
        setSavedWorkoutName("");
        setDraftWorkoutActive(false);
        localStorage.removeItem(WORKOUT_UI_STATE_KEY);
        clearTracker();
        await loadData();
    }

    useEffect(() => {
        if (!fullscreenExerciseId && !workoutQueue.length && !draftWorkoutActive) return;
        const timer = window.setInterval(() => setWorkoutClockTick(Date.now()), 1000);
        return () => window.clearInterval(timer);
    }, [draftWorkoutActive, fullscreenExerciseId, workoutQueue.length]);

    const workoutStatsRows = workoutQueue.flatMap((exercise) => validSetRows(exercise.sets, exerciseIsBodyweight(exercise.name, exercise.equipment)));
    const workoutStatsSetCount = workoutStatsRows.length;
    const workoutStatsVolume = workoutStatsRows.reduce((sum, set) => sum + set.reps * set.weight, 0);
    const canFinishWorkout = workoutStatsSetCount > 0;
    const workoutElapsedSeconds = Math.max(0, Math.floor((workoutClockTick - workoutStartedAt) / 1000));
    const workoutDurationLabel = formatDurationSeconds(workoutElapsedSeconds);
    const restTimerProgress = restTimerTotal ? Math.max(0, Math.min(1, restTimerRemaining / restTimerTotal)) : 0;

    return (
        <main>
            <nav className="top-nav" aria-label="Main sections" style={{ gridTemplateColumns: "repeat(5, minmax(0, 1fr))", gap: 6 }}>
                <button style={{ display: "flex", alignItems: "center", justifyContent: "center", padding: "12px 6px", whiteSpace: "nowrap" }} className={activeSection === "workouts" ? "active" : ""} onClick={() => setActiveSection("workouts")}>Workouts</button>
                <button style={{ display: "flex", alignItems: "center", justifyContent: "center", padding: "12px 6px", whiteSpace: "nowrap" }} className={activeSection === "exercises" ? "active" : ""} onClick={() => setActiveSection("exercises")}>Track</button>
                <button style={{ display: "flex", alignItems: "center", justifyContent: "center", padding: "12px 6px", whiteSpace: "nowrap" }} className={activeSection === "progress" ? "active" : ""} onClick={() => setActiveSection("progress")}>Progress</button>
                <button style={{ display: "flex", alignItems: "center", justifyContent: "center", padding: "12px 6px", whiteSpace: "nowrap" }} className={activeSection === "weight" ? "active" : ""} onClick={() => setActiveSection("weight")}>Weight</button>
                <button style={{ display: "flex", alignItems: "center", justifyContent: "center", padding: "12px 6px", whiteSpace: "nowrap" }} className={activeSection === "settings" ? "active" : ""} onClick={() => setActiveSection("settings")}>Settings</button>
            </nav>

            {(!isOnline || offlineQueueCount > 0) && (
                <div className="sync-status">
                    <span>{isOnline ? syncingOffline ? "Syncing" : "Online" : "Offline"}</span>
                    <span>{offlineQueueCount} pending sync</span>
                </div>
            )}

            {activeSection === "exercises" && !fullscreenExerciseId && !routineBuilderOpen && (
                <section className="stack track-home-section">
                    <div className="card stack recent-card track-start-card">
                        <button className="btn track-start-btn" type="button" onClick={() => runTrackHomeAction({ type: "empty" })}><Plus size={18} /> Start empty workout</button>
                    </div>
                    <div className="routines-home">
                        <button className="btn secondary routine-add-btn" type="button" onClick={() => runTrackHomeAction({ type: "createRoutine" })}><Plus size={18} /> New routine</button>
                        <div className="routines-heading-row">
                            <button className="routines-heading-toggle" type="button" aria-expanded={routinesExpanded} onClick={() => setRoutinesExpanded((expanded) => !expanded)}>
                                <ChevronDown className={routinesExpanded ? "chevron open" : "chevron"} size={18} />
                                <span>My Routines ({routines.length})</span>
                            </button>
                        </div>
                        {routines.length > 0 && (
                            <div className={routinesExpanded ? "routine-list" : "routine-list collapsed"}>
                                {routines.map((routine) => {
                                    const exerciseCount = routine.routine_exercises?.length ?? 0;
                                    return (
                                        <article className="routine-card" key={routine.id}>
                                            <button className="routine-card-main" type="button" onClick={() => runTrackHomeAction({ type: "startRoutine", routine })}>
                                                <strong>{routine.title}</strong>
                                                <small>{exerciseCount} {exerciseCount === 1 ? "exercise" : "exercises"}</small>
                                            </button>
                                            <div className="routine-card-actions">
                                                <button className="bare-icon-btn routine-edit-btn" type="button" aria-label={`Edit ${routine.title}`} onClick={() => openEditRoutine(routine)}><Edit3 size={16} /></button>
                                                <button className="bare-icon-btn routine-delete-btn" type="button" aria-label={`Delete ${routine.title}`} onClick={() => setPendingDeleteRoutine(routine)}><Trash2 size={16} /></button>
                                            </div>
                                        </article>
                                    );
                                })}
                            </div>
                        )}
                    </div>
                </section>
            )}

            <AnimatePresence>
                {activeSection === "exercises" && routineBuilderOpen && (
                    <motion.section
                        className="card stack recent-card expanded-workout-section routine-builder-section"
                        initial={{ opacity: 0, y: 32, scale: 0.985 }}
                        animate={{ opacity: 1, y: 0, scale: 1 }}
                        exit={{ opacity: 0, y: 32, scale: 0.985 }}
                        transition={{ type: "spring", stiffness: 360, damping: 36 }}
                    >
                        <div className="expanded-view-top">
                            <div className="expanded-workout-title-row">
                                <button className="bare-icon-btn" aria-label="Close routine builder" onClick={() => setRoutineCloseConfirmOpen(true)}><X size={18} /></button>
                                <label className="expanded-workout-name">
                                    <input value={routineTitle} onChange={(event) => setRoutineTitle(event.target.value)} placeholder="Routine title" aria-label="Routine title" />
                                </label>
                                <div className="expanded-view-actions">
                                    <button className="btn finish-workout-compact-btn" type="button" disabled={saving || !routineExercises.length} onClick={saveRoutine}>Save</button>
                                </div>
                            </div>
                            <div className="expanded-workout-stats" aria-label="Routine summary">
                                <span><small>Exercises</small><strong>{routineExercises.length}</strong></span>
                                <span><small>Sets</small><strong>{routineExercises.reduce((sum, exercise) => sum + exercise.setRows.length, 0)}</strong></span>
                                <span><small>Volume</small><strong>{routineExercises.reduce((sum, exercise) => sum + exercise.setRows.reduce((setSum, set) => setSum + Number(set.reps || 0) * Number(set.weight || 0), 0), 0)}</strong></span>
                            </div>
                        </div>
                        <div className="workout-list routine-builder-list">
                            {routineExercises.length === 0 && (
                                <div className="expanded-workout-empty">
                                    <Dumbbell size={28} />
                                    <strong>No exercises yet</strong>
                                    <span>Use the floating plus button to build this routine.</span>
                                </div>
                            )}
                            {routineExercises.map((exercise) => {
                                const isRoutineExerciseExpanded = expandedWorkoutExerciseIds.includes(exercise.id);
                                const isBodyweightRoutineExercise = exerciseIsBodyweight(exercise.name, exercise.equipment);
                                const exerciseHistory = exerciseHistoryRows.filter((record) => normalise(record.exercise_name) === normalise(exercise.name)).slice(0, 3);
                                const isHistoryOpen = expandedHistoryExerciseIds.includes(exercise.id);
                                return (
                                <div className="workout-exercise-section expanded-workout-exercise routine-builder-exercise" key={exercise.id}>
                                    <div className="workout-exercise-header saved-edit-exercise-header">
                                        <button className="workout-exercise-toggle" type="button" aria-expanded={isRoutineExerciseExpanded} onClick={() => setExpandedWorkoutExerciseIds((current) => current.includes(exercise.id) ? current.filter((id) => id !== exercise.id) : [...current, exercise.id])}>
                                            <ChevronDown className={isRoutineExerciseExpanded ? "chevron open" : "chevron"} size={18} />
                                            <span className="exercise-suggestion-icon">{exercise.image_url ? <img src={exercise.image_url} alt="" /> : <Dumbbell size={17} />}</span>
                                        </button>
                                        <button className="saved-edit-exercise-name" type="button" onClick={() => openExercisePicker("routine-edit", exercise.id)}>
                                            <span>{exercise.name}</span>
                                        </button>
                                        <button className="bare-icon-btn expanded-exercise-delete" type="button" aria-label={`Remove ${exercise.name}`} onClick={() => removeRoutineExercise(exercise.id)}><Trash2 size={16} /></button>
                                    </div>
                                    {isRoutineExerciseExpanded && <div className="workout-exercise-body">
                                        <textarea className="input exercise-notes-input saved-edit-exercise-notes" rows={1} aria-label={`${exercise.name} notes`} placeholder="Add exercise notes here..." value={exercise.notes} onChange={(event) => updateRoutineExercise(exercise.id, { notes: event.target.value })} />
                                        {exerciseHistory.length > 0 && (
                                            <div className="recent-record-list exercise-history-list">
                                                <div className="recent-list-header">
                                                    <button
                                                        className="record-summary-toggle recent-header-toggle"
                                                        onClick={() => setExpandedHistoryExerciseIds((prev) => prev.includes(exercise.id) ? prev.filter((id) => id !== exercise.id) : [...prev, exercise.id])}
                                                    >
                                                        <ChevronDown className={isHistoryOpen ? "chevron open" : "chevron"} size={18} />
                                                        <span>Last 3 records</span>
                                                    </button>
                                                    <Link className="view-all-link" href={`/history?exercise=${encodeURIComponent(exercise.name.trim())}`}>View all</Link>
                                                </div>
                                                {isHistoryOpen && exerciseHistory.map((record) => {
                                                    const isExpanded = expandedRecentRecordId === record.id;
                                                    const bestSet = bestPerformedSet(record);
                                                    return (
                                                        <div className="record-detail-panel recent-record-panel" key={record.id}>
                                                            <button className="record-summary-toggle" onClick={() => setExpandedRecentRecordId(isExpanded ? "" : record.id)}>
                                                                <ChevronDown className={isExpanded ? "chevron open" : "chevron"} size={18} />
                                                                <span>{new Date(record.created_at).toLocaleDateString(undefined, { month: "short", day: "numeric", year: "numeric" })}</span>
                                                                <span>{record.sets} {record.sets === 1 ? "set" : "sets"}{bestSet ? ` • best ${bestSet.weight} lbs × ${bestSet.reps}` : ""}</span>
                                                            </button>
                                                            {isExpanded && (
                                                                <>
                                                                    <div className="record-detail-meta">
                                                                        <span>{record.volume} lbs volume</span>
                                                                        {record.notes && <span>{record.notes}</span>}
                                                                    </div>
                                                                    <div className="set-detail-table">
                                                                        <div className="set-detail-head" style={{ gridTemplateColumns: "0.6fr 1fr 1fr 1.3fr" }}>
                                                                            <span>Set</span>
                                                                            <span>Reps</span>
                                                                            <span>Weight</span>
                                                                            <span>Notes</span>
                                                                        </div>
                                                                        {(record.set_rows?.length ? record.set_rows : [{ set: 1, reps: record.reps, weight: record.weight }]).map((set) => (
                                                                            <div className="set-detail-row" style={{ gridTemplateColumns: "0.6fr 1fr 1fr 1.3fr" }} key={`${record.id}-${set.set}`}>
                                                                                <span>{set.set}</span>
                                                                                <span>{set.reps}</span>
                                                                                <span>{set.weight} lbs</span>
                                                                                <span>{set.notes || "-"}</span>
                                                                            </div>
                                                                        ))}
                                                                    </div>
                                                                </>
                                                            )}
                                                        </div>
                                                    );
                                                })}
                                            </div>
                                        )}
                                        <div className="queued-set-table saved-edit-set-table routine-set-table">
                                            <div className={isBodyweightRoutineExercise ? "set-grid queued-set-grid table-head saved-edit-set-grid routine-set-grid bodyweight-routine-set-grid" : "set-grid queued-set-grid table-head saved-edit-set-grid routine-set-grid"} aria-hidden="true">
                                                <span>Set</span>{!isBodyweightRoutineExercise && <span>Weight</span>}<span>Reps</span>
                                            </div>
                                            {exercise.setRows.map((set, index) => {
                                                const routineSetSwipeId = `routine-${exercise.id}-${index}`;
                                                const swipeOffset = openSwipeSet?.exerciseId === exercise.id && openSwipeSet.setId === routineSetSwipeId ? openSwipeSet.offset : 0;
                                                const isSwipeOpen = swipeOffset < 0;
                                                return (
                                                    <div className={isSwipeOpen ? "swipe-set-row saved-edit-swipe-row swipe-open" : "swipe-set-row saved-edit-swipe-row"} key={`${exercise.id}-${index}`}>
                                                        <button className="swipe-delete-action" type="button" tabIndex={isSwipeOpen ? 0 : -1} onClick={() => { removeRoutineSet(exercise.id, index); setOpenSwipeSet(null); }}>Delete</button>
                                                        <motion.div
                                                            className={isBodyweightRoutineExercise ? "set-grid queued-set-grid saved-edit-set-grid routine-set-grid routine-set-row bodyweight-routine-set-grid" : "set-grid queued-set-grid saved-edit-set-grid routine-set-grid routine-set-row"}
                                                            animate={{ x: swipeOffset }}
                                                            transition={activeSwipeSetId === routineSetSwipeId ? { duration: 0 } : { type: "spring", stiffness: 360, damping: 34, mass: 0.7 }}
                                                            onPointerDown={(event) => startSavedSetSwipe(event, exercise.id, routineSetSwipeId)}
                                                            onPointerMove={moveSavedSetSwipe}
                                                            onPointerUp={endSavedSetSwipe}
                                                            onPointerCancel={endSavedSetSwipe}
                                                        >
                                                            <span className="set-number">{index + 1}</span>
                                                            {!isBodyweightRoutineExercise && <div className="weight-control">
                                                                <input className="input weight-input" inputMode="decimal" value={set.weight} onChange={(event) => updateRoutineSet(exercise.id, index, { weight: event.target.value.replace(/[^0-9.]/g, "") })} />
                                                            </div>}
                                                            <div className="reps-control">
                                                                <input className="input reps-input" inputMode="numeric" value={set.reps} onChange={(event) => updateRoutineSet(exercise.id, index, { reps: Number(event.target.value.replace(/\D/g, "")) })} />
                                                            </div>
                                                        </motion.div>
                                                    </div>
                                                );
                                            })}
                                        </div>
                                        <div className="fullscreen-tracker-actions"><button className="btn" type="button" onClick={() => addRoutineSet(exercise.id)}><Plus size={16} /> Add set</button></div>
                                    </div>}
                                </div>
                                );
                            })}
                        </div>
                        <motion.button className="expanded-add-exercise-fab" type="button" aria-label="Add routine exercise" onClick={() => openExercisePicker("routine")} initial={{ opacity: 0, scale: 0.72, y: 18 }} animate={{ opacity: 1, scale: 1, y: 0 }} exit={{ opacity: 0, scale: 0.72, y: 18 }} whileTap={{ scale: 0.92 }} transition={{ type: "spring", stiffness: 520, damping: 32 }}><Plus size={22} /></motion.button>
                    </motion.section>
                )}
            </AnimatePresence>

            <AnimatePresence>
                {activeSection === "exercises" && draftWorkoutActive && !fullscreenExerciseId && (
                    <motion.div
                        className="collapsed-workout-pill"
                        role="group"
                        aria-label="Current workout"
                        initial={{ opacity: 0, y: 28, scale: 0.96 }}
                        animate={{ opacity: 1, y: 0, scale: 1 }}
                        exit={{ opacity: 0, y: 28, scale: 0.96 }}
                        transition={{ type: "spring", stiffness: 420, damping: 34 }}
                    >
                    <button className="collapsed-workout-main" type="button" onClick={resumeExpandedWorkout}>
                        <ChevronDown className="collapsed-workout-chevron" size={22} />
                        <span className="collapsed-workout-copy">
                            <span className="collapsed-workout-title"><span className="collapsed-workout-dot" /> <strong>Workout</strong> {workoutDurationLabel}</span>
                            <span className="collapsed-workout-meta">{workoutQueue.length ? `${workoutQueue.length} ${workoutQueue.length === 1 ? "exercise" : "exercises"}` : "No exercise"}</span>
                        </span>
                    </button>
                    <button className="collapsed-workout-delete" type="button" aria-label="Clear draft" onClick={() => setClearDraftModalOpen(true)}><Trash2 size={22} /></button>
                    </motion.div>
                )}
            </AnimatePresence>

            <AnimatePresence>
                {activeSection === "exercises" && fullscreenExerciseId && (
                    <motion.section
                        className="card stack recent-card expanded-workout-section"
                        initial={{ opacity: 0, y: 32, scale: 0.985 }}
                        animate={{ opacity: 1, y: 0, scale: 1 }}
                        exit={{ opacity: 0, y: 32, scale: 0.985 }}
                        transition={{ type: "spring", stiffness: 360, damping: 36 }}
                    >
                    {fullscreenExerciseId && (
                        <div className="expanded-view-top">
                            <div className="expanded-workout-title-row">
                                <button className="bare-icon-btn" aria-label="Close expanded view" onClick={() => setFullscreenExerciseId("")}><ChevronRight size={18} /></button>
                                <label className="expanded-workout-name">
                                    <input value={workoutName} onChange={(event) => setWorkoutName(event.target.value)} placeholder={formatWorkoutName()} aria-label="Workout name" />
                                </label>
                                <div className="expanded-view-actions">
                                    <button className="bare-icon-btn" aria-label="Clear all" type="button" onClick={() => setClearDraftModalOpen(true)}><Eraser size={18} /></button>
                                    <button className={canFinishWorkout ? "btn finish-workout-compact-btn can-finish" : "btn finish-workout-compact-btn"} type="button" disabled={saving || !canFinishWorkout} onClick={openFinishDetailsModal}>Finish</button>
                                </div>
                            </div>
                            <div className="expanded-workout-stats" aria-label="Workout summary">
                                <span><small>Duration</small><strong>{workoutDurationLabel}</strong></span>
                                <span><small>Volume</small><strong>{workoutStatsVolume}</strong></span>
                                <span><small>Sets</small><strong>{workoutStatsSetCount}</strong></span>
                            </div>
                        </div>
                    )}
                    <div className="section-title exercise-tracker-title">
                        <label className="workout-name-title">
                            <Activity size={18} />
                            <input value={workoutName} onChange={(event) => setWorkoutName(event.target.value)} placeholder={formatWorkoutName()} aria-label="Workout name" />
                        </label>
                        <div className="row action-row tracker-actions-row">
                            <button className="bare-icon-btn" aria-label="Add exercises" onClick={() => openExercisePicker()}><Plus size={18} /></button>
                            <button className="bare-icon-btn" aria-label={fullscreenExerciseId ? "Exit expanded tracking view" : "Open expanded tracking view"} onClick={toggleTrackerFullscreen}>{fullscreenExerciseId ? <Minimize2 size={18} /> : <Maximize2 size={18} />}</button>
                            <button className="bare-icon-btn" aria-label="Clear all" onClick={() => setClearDraftModalOpen(true)}><Eraser size={18} /></button>
                        </div>
                    </div>
                    <div className="workout-list">
                        {workoutQueue.length === 0 && (
                            <div className="expanded-workout-empty">
                                <Dumbbell size={28} />
                                <strong>No exercises yet</strong>
                                <span>Use the floating plus button to start tracking sets.</span>
                            </div>
                        )}
                        {workoutQueue.map((exercise) => {
                            const isBodyweightExercise = exerciseIsBodyweight(exercise.name, exercise.equipment);
                            const rows = validSetRows(exercise.sets, isBodyweightExercise);
                            const volume = rows.reduce((sum, set) => sum + set.reps * set.weight, 0);
                            const isCollapsed = collapsedQueueIds.includes(exercise.id);
                            const meta = [exercise.category, exercise.muscles?.[0], exercise.equipment?.[0]].filter(Boolean).join(" • ");
                            const exerciseHistory = exerciseHistoryRows.filter((record) => normalise(record.exercise_name) === normalise(exercise.name)).slice(0, 3);
                            const isHistoryOpen = expandedHistoryExerciseIds.includes(exercise.id);
                            const isFullscreen = Boolean(fullscreenExerciseId);
                            return (
                                <div className={isFullscreen ? "workout-exercise-section expanded-workout-exercise" : "workout-exercise-section"} key={exercise.id}>
                                    <div className="workout-exercise-header">
                                        <button
                                            className="workout-exercise-toggle"
                                            aria-expanded={!isCollapsed}
                                            onClick={() => setCollapsedQueueIds((prev) => prev.includes(exercise.id) ? prev.filter((id) => id !== exercise.id) : [...prev, exercise.id])}
                                        >
                                                <ChevronDown className={isCollapsed ? "chevron" : "chevron open"} size={18} />
                                                <span className="exercise-suggestion-icon">
                                                    {exercise.image_url ? <img src={exercise.image_url} alt="" /> : <Dumbbell size={17} />}
                                                </span>
                                                <span className="workout-exercise-title">
                                                <span className="workout-exercise-name-line">
                                                    <strong>{exercise.name}</strong>
                                                </span>
                                                <small>{meta || `${rows.length} ${rows.length === 1 ? "set" : "sets"} • ${volume} lbs volume`}</small>
                                            </span>
                                        </button>
                                        <button
                                            className={isFullscreen ? "bare-icon-btn expanded-exercise-delete" : "btn danger icon-btn"}
                                            type="button"
                                            aria-label={`Remove ${exercise.name}`}
                                            onClick={(event) => {
                                                event.stopPropagation();
                                                setPendingRemoveExercise(exercise);
                                            }}
                                        >
                                            <Trash2 size={16} onClick={(event) => {
                                                event.stopPropagation();
                                                setPendingRemoveExercise(exercise);
                                            }} />
                                        </button>
                                    </div>
                                    {!isCollapsed && (
                                        <div className="workout-exercise-body">
                                            <textarea className="input exercise-notes-input" rows={1} aria-label={`${exercise.name} notes`} placeholder="Add notes here..." value={exercise.notes ?? ""} onChange={(event) => updateQueuedExerciseNotes(exercise.id, event.target.value)} />
                                            <button className="rest-timer-inline" type="button" onClick={() => { setRestTimerExerciseId(exercise.id); setRestTimerSheetOpen(true); }}>
                                                <Clock3 size={18} />
                                                <span>Rest Timer: {formatRestOption(exercise.restTimerSeconds ?? 0)}</span>
                                            </button>
                                            {exerciseHistory.length > 0 && (
                                                <div className="recent-record-list exercise-history-list">
                                                    <div className="recent-list-header">
                                                        <button
                                                            className="record-summary-toggle recent-header-toggle"
                                                            onClick={() => setExpandedHistoryExerciseIds((prev) => prev.includes(exercise.id) ? prev.filter((id) => id !== exercise.id) : [...prev, exercise.id])}
                                                        >
                                                            <ChevronDown className={isHistoryOpen ? "chevron open" : "chevron"} size={18} />
                                                            <span>Last 3 records</span>
                                                        </button>
                                                        <Link className="view-all-link" href={`/history?exercise=${encodeURIComponent(exercise.name.trim())}`}>View all</Link>
                                                    </div>
                                                    {isHistoryOpen && exerciseHistory.map((record) => {
                                                        const isExpanded = expandedRecentRecordId === record.id;
                                                        const bestSet = bestPerformedSet(record);
                                                        return (
                                                            <div className="record-detail-panel recent-record-panel" key={record.id}>
                                                                <button className="record-summary-toggle" onClick={() => setExpandedRecentRecordId(isExpanded ? "" : record.id)}>
                                                                    <ChevronDown className={isExpanded ? "chevron open" : "chevron"} size={18} />
                                                                    <span>{new Date(record.created_at).toLocaleDateString(undefined, { month: "short", day: "numeric", year: "numeric" })}</span>
                                                                    <span>{record.sets} {record.sets === 1 ? "set" : "sets"}{bestSet ? ` • best ${bestSet.weight} lbs × ${bestSet.reps}` : ""}</span>
                                                                </button>
                                                                {isExpanded && (
                                                                    <>
                                                                        <div className="record-detail-meta">
                                                                            <span>{record.volume} lbs volume</span>
                                                                            {record.notes && <span>{record.notes}</span>}
                                                                        </div>
                                                                        <div className="set-detail-table">
                                                                            <div className="set-detail-head" style={{ gridTemplateColumns: "0.6fr 1fr 1fr 1.3fr" }}>
                                                                                <span>Set</span>
                                                                                <span>Reps</span>
                                                                                <span>Weight</span>
                                                                                <span>Notes</span>
                                                                            </div>
                                                                            {(record.set_rows?.length ? record.set_rows : [{ set: 1, reps: record.reps, weight: record.weight }]).map((set) => (
                                                                                <div className="set-detail-row" style={{ gridTemplateColumns: "0.6fr 1fr 1fr 1.3fr" }} key={`${record.id}-${set.set}`}>
                                                                                    <span>{set.set}</span>
                                                                                    <span>{set.reps}</span>
                                                                                    <span>{set.weight} lbs</span>
                                                                                    <span>{set.notes || "—"}</span>
                                                                                </div>
                                                                            ))}
                                                                        </div>
                                                                    </>
                                                                )}
                                                            </div>
                                                        );
                                                    })}
                                                </div>
                                            )}
                                            <div className="queued-set-table">
                                                <div className={isBodyweightExercise ? "set-grid queued-set-grid table-head bodyweight-set-grid" : "set-grid queued-set-grid table-head"} style={isBodyweightExercise ? undefined : isFullscreen ? { gridTemplateColumns: "28px minmax(76px,1.2fr) minmax(56px,.8fr) minmax(70px,1fr) 40px", gap: 0 } : { gridTemplateColumns: "32px minmax(92px,1.2fr) minmax(66px,.8fr) minmax(82px,1fr) 42px", gap: 0, minWidth: 332 }} aria-hidden="true">
                                                    <span>Set</span>
                                                    {!isBodyweightExercise && <span>Weight</span>}
                                                    <span>Reps</span>
                                                    <span>Best</span>
                                                    <span className="set-complete-label"><Check size={13} /></span>
                                                </div>
                                                {exercise.sets.map((set, index) => {
                                                    const swipeOffset = openSwipeSet?.exerciseId === exercise.id && openSwipeSet.setId === set.id ? openSwipeSet.offset : 0;
                                                    const isSwipeOpen = swipeOffset < 0;
                                                    const fallbackValues = previousBestSetValues(exercise.name, index + 1);
                                                    return (
                                                        <div className={isSwipeOpen ? "swipe-set-row swipe-open" : "swipe-set-row"} style={isFullscreen ? undefined : { minWidth: 332 }} key={set.id}>
                                                            <button className="swipe-delete-action" type="button" tabIndex={isSwipeOpen ? 0 : -1} onClick={() => { removeQueuedSet(exercise.id, set.id); setOpenSwipeSet(null); }}>Delete</button>
                                                            <motion.div
                                                                className={`set-grid queued-set-grid draggable-row tracker-set-row ${isBodyweightExercise ? "bodyweight-set-grid" : ""} ${set.completed ? "completed" : "unchecked"}`}
                                                                style={isBodyweightExercise ? undefined : isFullscreen ? { gridTemplateColumns: "28px minmax(76px,1.2fr) minmax(56px,.8fr) minmax(70px,1fr) 40px", gap: 0 } : { gridTemplateColumns: "32px minmax(92px,1.2fr) minmax(66px,.8fr) minmax(82px,1fr) 42px", gap: 0, minWidth: 332 }}
                                                                drag="x"
                                                                dragConstraints={{ left: -SWIPE_DELETE_WIDTH, right: 0 }}
                                                                dragElastic={0.12}
                                                                dragDirectionLock
                                                                dragMomentum={false}
                                                                animate={{ x: swipeOffset }}
                                                                transition={{ type: "spring", stiffness: 360, damping: 34, mass: 0.7 }}
                                                                onDragStart={() => {
                                                                    if (openSwipeSet && (openSwipeSet.exerciseId !== exercise.id || openSwipeSet.setId !== set.id)) setOpenSwipeSet(null);
                                                                }}
                                                                onDragEnd={(_, info) => {
                                                                    setOpenSwipeSet(info.offset.x < -36 || info.velocity.x < -420 ? { exerciseId: exercise.id, setId: set.id, offset: -SWIPE_DELETE_WIDTH } : null);
                                                                }}
                                                            >
                                                                <span className="set-number">{index + 1}</span>
                                                                {!isBodyweightExercise && (
                                                                    <div className="weight-control">
                                                                        <input
                                                                            className={set.prefilled && !set.completed ? "input weight-input prefilled-value" : "input weight-input"}
                                                                            inputMode="decimal"
                                                                            aria-label={`${exercise.name} set ${index + 1} weight in lbs`}
                                                                            placeholder={set.prefilled && !set.completed && set.weight ? set.weight : set.weight ? "0" : fallbackValues?.weight ?? "0"}
                                                                            value={set.prefilled && !set.completed ? "" : set.weight}
                                                                            onChange={(event) => updateQueuedSet(exercise.id, set.id, { weight: event.target.value.replace(/[^0-9.]/g, ""), prefilled: false })}
                                                                        />
                                                                    </div>
                                                                )}
                                                                <div className="reps-control">
                                                                    <input
                                                                        className={set.prefilled && !set.completed ? "input reps-input prefilled-value" : "input reps-input"}
                                                                        inputMode="numeric"
                                                                        aria-label={`${exercise.name} set ${index + 1} reps`}
                                                                        placeholder={set.prefilled && !set.completed && set.reps ? set.reps : set.reps ? "0" : fallbackValues?.reps ?? "0"}
                                                                        value={set.prefilled && !set.completed ? "" : set.reps}
                                                                        onChange={(event) => updateQueuedSet(exercise.id, set.id, { reps: event.target.value.replace(/\D/g, ""), prefilled: false })}
                                                                    />
                                                                </div>
                                                                <span className="last-best">{lastBestForSet(exercise.name, index + 1, isBodyweightExercise)}</span>
                                                                <button
                                                                    className="set-complete-btn"
                                                                    type="button"
                                                                    aria-label={`${set.completed ? "Mark incomplete" : "Complete"} ${exercise.name} set ${index + 1}`}
                                                                    aria-pressed={Boolean(set.completed)}
                                                                    onClick={() => toggleQueuedSetCompleted(exercise.id, set.id, !set.completed, exercise.restTimerSeconds ?? 0)}
                                                                >
                                                                    {set.completed && <Check size={16} />}
                                                                </button>
                                                            </motion.div>
                                                        </div>
                                                    );
                                                })}
                                            </div>
                                            {isFullscreen && (
                                                <div className="fullscreen-tracker-actions">
                                                    <button className="btn" type="button" onClick={() => addQueuedSet(exercise.id)}><Plus size={16} /> Add set</button>
                                                </div>
                                            )}
                                            <div className="row tracker-footer-row">
                                                {!isFullscreen && <button className="bare-icon-btn" aria-label={`Add set to ${exercise.name}`} onClick={() => addQueuedSet(exercise.id)}><Plus size={16} /></button>}
                                            </div>
                                        </div>
                                    )}
                                </div>
                            );
                        })}
                    </div>
                    {fullscreenExerciseId && (
                        <motion.button
                            className="expanded-add-exercise-fab"
                            type="button"
                            aria-label="Add exercise"
                            onClick={() => openExercisePicker()}
                            initial={{ opacity: 0, scale: 0.72, y: 18 }}
                            animate={{ opacity: 1, scale: 1, y: 0 }}
                            exit={{ opacity: 0, scale: 0.72, y: 18 }}
                            whileTap={{ scale: 0.92 }}
                            transition={{ type: "spring", stiffness: 520, damping: 32 }}
                        >
                            <Plus size={22} />
                        </motion.button>
                    )}
                    </motion.section>
                )}
            </AnimatePresence>

            <AnimatePresence>
                {activeSection === "workouts" && editingWorkoutFullscreen && editingWorkoutId && (() => {
                    const workout = recentWorkouts.find((row) => row.id === editingWorkoutId);
                    if (!workout) return null;
                    const editWorkoutVolume = editWorkoutExercises.reduce((sum, exercise) => sum + exercise.setRows.reduce((setSum, set) => setSum + Number(set.reps || 0) * Number(set.weight || 0), 0), 0);
                    const editWorkoutSetCount = editWorkoutExercises.reduce((sum, exercise) => sum + exercise.setRows.filter((set) => Number(set.reps) > 0 && Number(set.weight) >= 0).length, 0);
                    return (
                        <motion.section
                            className="card stack recent-card expanded-workout-section saved-workout-editor-section"
                            initial={{ opacity: 0, y: 32, scale: 0.985 }}
                            animate={{ opacity: 1, y: 0, scale: 1 }}
                            exit={{ opacity: 0, y: 32, scale: 0.985 }}
                            transition={{ type: "spring", stiffness: 360, damping: 36 }}
                        >
                            <div className="expanded-view-top">
                                <div className="expanded-workout-title-row">
                                    <button className="bare-icon-btn" aria-label="Cancel editing workout" onClick={cancelEditWorkout}><ChevronRight size={18} /></button>
                                    <label className="expanded-workout-name">
                                        <input value={editWorkoutName} onChange={(event) => setEditWorkoutName(event.target.value)} placeholder={formatWorkoutName(new Date(workout.created_at))} aria-label="Workout name" />
                                    </label>
                                    <div className="expanded-view-actions">
                                        <button className="btn finish-workout-compact-btn" type="button" disabled={saving || !editWorkoutSetCount} onClick={() => saveEditWorkout(workout)}>Save</button>
                                    </div>
                                </div>
                                <div className="expanded-workout-stats" aria-label="Workout summary">
                                    <span><small>Duration</small><strong>{formatDurationSeconds(workout.duration_seconds)}</strong></span>
                                    <span><small>Volume</small><strong>{editWorkoutVolume}</strong></span>
                                    <span><small>Sets</small><strong>{editWorkoutSetCount}</strong></span>
                                </div>
                            </div>
                            <div className="saved-workout-editor-scroll">
                                <div className="edit-workout-details-panel">
                                    <label className="field-label">
                                        <span>Description</span>
                                        <textarea className="input finish-description-input" rows={4} value={editWorkoutNotes} onChange={(event) => setEditWorkoutNotes(event.target.value)} placeholder="Add workout description..." />
                                    </label>
                                    {editWorkoutPhotoUrls.length > 0 && (
                                        <div className="field-label">
                                            <span>Images</span>
                                            <label className="finish-photo-picker edit-workout-photo-picker">
                                                <input type="file" accept="image/*" multiple onChange={(event) => { const files = Array.from(event.target.files ?? []).filter((file) => file.type.startsWith("image/")); setEditWorkoutPhotos((current) => [...current, ...files]); event.target.value = ""; }} />
                                                <Plus size={18} />
                                                <span>Add images</span>
                                            </label>
                                            <div className="workout-photo-grid edit-workout-photo-grid">
                                                {editWorkoutPhotoUrls.map((url, index) => (
                                                    <div className="edit-workout-photo" key={`${workout.id}-edit-photo-${index}`}>
                                                        <button className="edit-workout-photo-open" type="button" aria-label="View image" onClick={() => setPreviewImageUrl(url)}><img src={url} alt="" /></button>
                                                        <button className="edit-workout-photo-remove" type="button" aria-label="Remove image" onClick={() => setEditWorkoutPhotoUrls((current) => current.filter((_, itemIndex) => itemIndex !== index))}><X size={14} /></button>
                                                    </div>
                                                ))}
                                                {editWorkoutPhotoPreviews.map((preview, index) => (
                                                    <div className="edit-workout-photo" key={`${preview.file.name}-${preview.file.lastModified}-${index}`}>
                                                        <button className="edit-workout-photo-open" type="button" aria-label="View selected image" onClick={() => setPreviewImageUrl(preview.url)}><img src={preview.url} alt="" /></button>
                                                        <button className="edit-workout-photo-remove" type="button" aria-label="Remove selected image" onClick={() => setEditWorkoutPhotos((current) => current.filter((_, itemIndex) => itemIndex !== index))}><X size={14} /></button>
                                                    </div>
                                                ))}
                                            </div>
                                        </div>
                                    )}
                                    {!editWorkoutPhotoUrls.length && (
                                        <div className="field-label">
                                            <span>Images</span>
                                            <label className="finish-photo-picker edit-workout-photo-picker">
                                                <input type="file" accept="image/*" multiple onChange={(event) => { const files = Array.from(event.target.files ?? []).filter((file) => file.type.startsWith("image/")); setEditWorkoutPhotos((current) => [...current, ...files]); event.target.value = ""; }} />
                                                <Plus size={18} />
                                                <span>Add images</span>
                                            </label>
                                            {editWorkoutPhotoPreviews.length > 0 && (
                                                <div className="workout-photo-grid edit-workout-photo-grid">
                                                    {editWorkoutPhotoPreviews.map((preview, index) => (
                                                        <div className="edit-workout-photo" key={`${preview.file.name}-${preview.file.lastModified}-${index}`}>
                                                            <button className="edit-workout-photo-open" type="button" aria-label="View selected image" onClick={() => setPreviewImageUrl(preview.url)}><img src={preview.url} alt="" /></button>
                                                            <button className="edit-workout-photo-remove" type="button" aria-label="Remove selected image" onClick={() => setEditWorkoutPhotos((current) => current.filter((_, itemIndex) => itemIndex !== index))}><X size={14} /></button>
                                                        </div>
                                                    ))}
                                                </div>
                                            )}
                                        </div>
                                    )}
                                </div>
                                <div className="workout-list">
                                {editWorkoutExercises.length === 0 && (
                                    <div className="expanded-workout-empty">
                                        <Dumbbell size={28} />
                                        <strong>No exercises saved</strong>
                                        <span>Use the floating plus button to add an exercise.</span>
                                    </div>
                                )}
                                {editWorkoutExercises.map((exercise) => {
                                    const isCollapsed = !expandedWorkoutExerciseIds.includes(exercise.id);
                                    const rows = exercise.setRows.filter((set) => Number(set.reps) > 0 && Number(set.weight) >= 0);
                                    const volume = rows.reduce((sum, set) => sum + Number(set.reps) * Number(set.weight), 0);
                                    const exerciseMeta = workoutExerciseMeta.get(normalise(exercise.name));
                                    const isBodyweightEditExercise = exerciseIsBodyweight(exercise.name, exercise.equipment ?? exerciseMeta?.equipment);
                                    const exerciseImageUrl = exercise.image_url ?? exerciseMeta?.image_url;
                                    return (
                                        <div className="workout-exercise-section expanded-workout-exercise" key={exercise.id}>
                                            <div className="workout-exercise-header saved-edit-exercise-header">
                                                <button
                                                    className="workout-exercise-toggle"
                                                    aria-expanded={!isCollapsed}
                                                    onClick={() => setExpandedWorkoutExerciseIds((prev) => prev.includes(exercise.id) ? prev.filter((id) => id !== exercise.id) : [...prev, exercise.id])}
                                                >
                                                    <ChevronDown className={isCollapsed ? "chevron" : "chevron open"} size={18} />
                                                    <span className="exercise-suggestion-icon">
                                                        {exerciseImageUrl ? <img src={exerciseImageUrl} alt="" /> : <Dumbbell size={17} />}
                                                    </span>
                                                </button>
                                                <button className="saved-edit-exercise-name" type="button" onClick={() => openExercisePicker("edit", exercise.id)}>
                                                    <span>{exercise.name || "Select exercise"}</span>
                                                    <small>Tap to change</small>
                                                </button>
                                                <button className="bare-icon-btn expanded-exercise-delete" type="button" aria-label={`Delete ${exercise.name || "exercise"}`} onClick={() => removeEditWorkoutExercise(exercise.id)}><Trash2 size={16} /></button>
                                            </div>
                                            {!isCollapsed && (
                                                <div className="workout-exercise-body">
                                                    <div className="record-detail-meta saved-edit-exercise-meta">
                                                        <span>{rows.length} {rows.length === 1 ? "set" : "sets"}</span>
                                                        <span>{volume} lbs volume</span>
                                                        {exercise.name.trim() && <Link href={`/history?exercise=${encodeURIComponent(exercise.name.trim())}`}>View records</Link>}
                                                    </div>
                                                    <textarea className="input exercise-notes-input saved-edit-exercise-notes" rows={1} aria-label={`${exercise.name || "Exercise"} notes`} placeholder="Add exercise notes here..." value={exercise.notes} onChange={(event) => updateEditWorkoutExercise(exercise.id, { notes: event.target.value })} />
                                                    <div className="queued-set-table saved-edit-set-table">
                                                        <div className={isBodyweightEditExercise ? "set-grid queued-set-grid table-head saved-edit-set-grid bodyweight-edit-set-grid" : "set-grid queued-set-grid table-head saved-edit-set-grid"} aria-hidden="true">
                                                            <span>Set</span>
                                                            {!isBodyweightEditExercise && <span>Weight</span>}
                                                            <span>Reps</span>
                                                            <span>Best</span>
                                                        </div>
                                                        {exercise.setRows.map((set, index) => {
                                                            const editSetSwipeId = `edit-${exercise.id}-${index}`;
                                                            const swipeOffset = openSwipeSet?.exerciseId === exercise.id && openSwipeSet.setId === editSetSwipeId ? openSwipeSet.offset : 0;
                                                            const isSwipeOpen = swipeOffset < 0;
                                                            return (
                                                                <div className={isSwipeOpen ? "swipe-set-row saved-edit-swipe-row swipe-open" : "swipe-set-row saved-edit-swipe-row"} key={`${exercise.id}-${set.set}-${index}`}>
                                                                    <button className="swipe-delete-action" type="button" tabIndex={isSwipeOpen ? 0 : -1} onClick={() => { removeEditWorkoutSet(exercise.id, index); setOpenSwipeSet(null); }}>Delete</button>
                                                                    <motion.div
                                                                        className="saved-edit-set-block saved-edit-set-content"
                                                                        animate={{ x: swipeOffset }}
                                                                        transition={activeSwipeSetId === editSetSwipeId ? { duration: 0 } : { type: "spring", stiffness: 360, damping: 34, mass: 0.7 }}
                                                                        onPointerDown={(event) => startSavedSetSwipe(event, exercise.id, editSetSwipeId)}
                                                                        onPointerMove={moveSavedSetSwipe}
                                                                        onPointerUp={endSavedSetSwipe}
                                                                        onPointerCancel={endSavedSetSwipe}
                                                                    >
                                                                        <div className={isBodyweightEditExercise ? "set-grid queued-set-grid saved-edit-set-grid bodyweight-edit-set-grid" : "set-grid queued-set-grid saved-edit-set-grid"}>
                                                                            <span className="set-number">{index + 1}</span>
                                                                            {!isBodyweightEditExercise && <div className="weight-control">
                                                                                <input className="input weight-input" inputMode="decimal" aria-label={`${exercise.name || "Exercise"} set ${index + 1} weight in lbs`} placeholder="0" value={set.weight} onChange={(event) => updateEditWorkoutSet(exercise.id, index, { weight: Number(event.target.value.replace(/[^0-9.]/g, "")) })} />
                                                                            </div>}
                                                                            <div className="reps-control">
                                                                                <input className="input reps-input" inputMode="numeric" aria-label={`${exercise.name || "Exercise"} set ${index + 1} reps`} placeholder="0" value={set.reps} onChange={(event) => updateEditWorkoutSet(exercise.id, index, { reps: Number(event.target.value.replace(/\D/g, "")) })} />
                                                                            </div>
                                                                            <span className="last-best saved-edit-best">{exercise.name.trim() ? lastBestForSet(exercise.name, index + 1, isBodyweightEditExercise) : "—"}</span>
                                                                        </div>
                                                                    </motion.div>
                                                                </div>
                                                            );
                                                        })}
                                                    </div>
                                                    <div className="fullscreen-tracker-actions">
                                                        <button className="btn" type="button" onClick={() => addEditWorkoutSet(exercise.id)}><Plus size={16} /> Add set</button>
                                                    </div>
                                                </div>
                                            )}
                                        </div>
                                    );
                                })}
                                </div>
                            </div>
                            <motion.button
                                className="expanded-add-exercise-fab"
                                type="button"
                                aria-label="Add exercise"
                                onClick={addEditWorkoutExercise}
                                initial={{ opacity: 0, scale: 0.72, y: 18 }}
                                animate={{ opacity: 1, scale: 1, y: 0 }}
                                exit={{ opacity: 0, scale: 0.72, y: 18 }}
                                whileTap={{ scale: 0.92 }}
                                transition={{ type: "spring", stiffness: 520, damping: 32 }}
                            >
                                <Plus size={22} />
                            </motion.button>
                        </motion.section>
                    );
                })()}
            </AnimatePresence>

            {activeSection === "workouts" && (
                <section className="stack workouts-section" onTouchStart={startPullRefresh} onTouchMove={movePullRefresh} onTouchEnd={endPullRefresh} onTouchCancel={endPullRefresh}>
                    <div className={pullRefreshDistance > 0 || isPullRefreshing ? "pull-refresh-indicator visible" : "pull-refresh-indicator"} style={{ height: pullRefreshDistance || (isPullRefreshing ? 42 : 0) }}>
                        <RefreshCw className={isPullRefreshing ? "spinning" : ""} size={16} />
                        <span>{isPullRefreshing ? "Refreshing..." : pullRefreshDistance >= PULL_REFRESH_THRESHOLD ? "Release to refresh" : "Pull to refresh"}</span>
                    </div>
                    <div className="workout-filters">
                        <div className="input-icon-wrap workout-search-field">
                            <Search className="input-icon" size={17} />
                            <input className="input with-icon with-clear" style={{ paddingRight: 82 }} placeholder="Search workout name or included exercise" value={workoutSearch} onChange={(event) => { setWorkoutSearch(event.target.value); setWorkoutPage(0); }} />
                            {workoutSearch && (
                                <button className="clear-input" style={{ right: 42 }} aria-label="Clear workout search" onClick={() => { setWorkoutSearch(""); setWorkoutPage(0); }}>
                                    <X size={16} />
                                </button>
                            )}
                            <div style={{ position: "absolute", right: 8, top: "50%", transform: "translateY(-50%)" }}>
                                <DateRangePickerField
                                    compact
                                    from={workoutStartDate}
                                    to={workoutEndDate}
                                    onChange={(range) => {
                                        setWorkoutStartDate(range.from);
                                        setWorkoutEndDate(range.to);
                                        setWorkoutPage(0);
                                    }}
                                />
                            </div>
                        </div>
                    </div>

                    {workoutRows.length ? (
                        <>
                            <div className="workout-card-list">
                                {workoutRows.map((workout) => {
                                    const isExpanded = expandedWorkoutIds.includes(workout.id);
                                    const exercises = workout.workout_exercises ?? [];
                                    const volume = exercises.reduce((sum, exercise) => sum + Number(exercise.volume || 0), 0);
                                    const workoutNameValue = workout.name || formatWorkoutName(new Date(workout.created_at));
                                    return (
                                        <article className="workout-card-item" key={workout.id}>
                                            <div className="workout-card-top">
                                                <button className="workout-card-main" type="button" onClick={() => setExpandedWorkoutIds((current) => isExpanded ? current.filter((id) => id !== workout.id) : [...current, workout.id])}>
                                                    <span className="workout-card-chevron"><ChevronDown className={isExpanded ? "chevron open" : "chevron"} size={18} /></span>
                                                    <span className="workout-card-copy">
                                                        <strong>{workoutNameValue}</strong>
                                                        <small>{new Date(workout.created_at).toLocaleDateString(undefined, { month: "short", day: "numeric", year: "numeric" })}</small>
                                                    </span>
                                                </button>
                                                <div className="workout-card-icon-actions">
                                                    <button
                                                        className="bare-icon-btn workout-card-edit-btn"
                                                        type="button"
                                                        aria-label={`Edit ${workoutNameValue}`}
                                                        onClick={() => startEditWorkout(workout, { fullscreen: true })}
                                                    >
                                                        <Edit3 size={16} />
                                                    </button>
                                                    <button
                                                        className="bare-icon-btn workout-card-delete-btn"
                                                        type="button"
                                                        aria-label={`Delete ${workoutNameValue}`}
                                                        onClick={() => setPendingDeleteWorkout(workout)}
                                                    >
                                                        <Trash2 size={16} />
                                                    </button>
                                                </div>
                                            </div>
                                            <div className="workout-card-stats">
                                                <span><small>Duration</small><strong>{formatDurationSeconds(workout.duration_seconds)}</strong></span>
                                                <span><small>Volume</small><strong>{volume} lbs</strong></span>
                                                <span><small>Exercises</small><strong>{exercises.length}</strong></span>
                                            </div>
                                            {isExpanded && (
                                                <div className="workout-card-detail">
                                                    {exercises.length ? exercises.map((exercise) => {
                                                        const isExerciseExpanded = expandedWorkoutExerciseIds.includes(exercise.id);
                                                        const setRows = exercise.set_rows?.length ? exercise.set_rows : [{ set: 1, reps: exercise.reps, weight: exercise.weight }];
                                                        const bestRow = setRows.reduce<WorkoutSetRow | null>((best, set) => !best || Number(set.weight) > Number(best.weight) ? set : best, null);
                                                        return (
                                                            <div className="workout-card-exercise" key={exercise.id}>
                                                                <div className="workout-card-exercise-head">
                                                                    <button className="workout-card-exercise-toggle" type="button" aria-expanded={isExerciseExpanded} onClick={() => setExpandedWorkoutExerciseIds((current) => current.includes(exercise.id) ? current.filter((id) => id !== exercise.id) : [...current, exercise.id])}>
                                                                        <ChevronDown className={isExerciseExpanded ? "chevron open" : "chevron"} size={16} />
                                                                        <span>
                                                                            <strong>{exercise.exercise_name}</strong>
                                                                            <small>{setRows.length} {setRows.length === 1 ? "set" : "sets"}{bestRow ? ` • best ${bestRow.weight} lbs × ${bestRow.reps}` : ""}</small>
                                                                        </span>
                                                                    </button>
                                                                    <Link href={`/history?exercise=${encodeURIComponent(exercise.exercise_name.trim())}`}>Records</Link>
                                                                </div>
                                                                {isExerciseExpanded && (
                                                                    <>
                                                                        {exercise.notes && <p className="workout-card-exercise-notes">{exercise.notes}</p>}
                                                                        <div className="workout-card-set-table" aria-label={`${exercise.exercise_name} sets`}>
                                                                            <div className="workout-card-set-head" aria-hidden="true">
                                                                                <span>Set</span>
                                                                                <span>Reps</span>
                                                                                <span>Weight</span>
                                                                            </div>
                                                                            {setRows.map((set, setIndex) => (
                                                                                <div className="workout-card-set-row" key={`${exercise.id}-${set.set}-${setIndex}`}>
                                                                                    <span>{setIndex + 1}</span>
                                                                                    <span>{set.reps}</span>
                                                                                    <span>{set.weight} lbs</span>
                                                                                </div>
                                                                            ))}
                                                                        </div>
                                                                    </>
                                                                )}
                                                            </div>
                                                        );
                                                    }) : <p className="muted">No exercises saved.</p>}
                                                </div>
                                            )}
                                        </article>
                                    );
                                })}
                            </div>
                            <div className="table-wrap workouts-table-wrap">
                                <table className="records-table workouts-table">
                                    <colgroup>
                                        <col style={{ width: "var(--workout-toggle-col)" }} />
                                        <col style={{ width: "var(--workout-name-col)" }} />
                                        <col style={{ width: "var(--workout-date-col)" }} />
                                        <col style={{ width: "var(--workout-duration-col)" }} />
                                        <col style={{ width: "var(--workout-exercises-col)" }} />
                                        <col style={{ width: "var(--workout-volume-col)" }} />
                                        <col style={{ width: "var(--workout-actions-col)" }} />
                                    </colgroup>
                                    <thead>
                                        <tr>
                                            <th></th>
                                            <th>Workout</th>
                                            <th>Date</th>
                                            <th>Duration</th>
                                            <th>Exercises</th>
                                            <th>Volume</th>
                                            <th></th>
                                        </tr>
                                    </thead>
                                    <tbody>
                                        {workoutRows.map((workout) => {
                                            const isExpanded = expandedWorkoutIds.includes(workout.id);
                                            const isEditingWorkout = editingWorkoutId === workout.id;
                                            const exercises = workout.workout_exercises ?? [];
                                            const volume = exercises.reduce((sum, exercise) => sum + Number(exercise.volume || 0), 0);
                                            return (
                                                <Fragment key={workout.id}>
                                                    <tr className="clickable-table-row" onClick={() => setExpandedWorkoutIds((current) => isExpanded ? current.filter((id) => id !== workout.id) : [...current, workout.id])}>
                                                        <td>
                                                            <button className="table-toggle" aria-label={isExpanded ? "Collapse workout" : "Expand workout"}>
                                                                <ChevronDown className={isExpanded ? "chevron open" : "chevron"} size={16} />
                                                            </button>
                                                        </td>
                                                        <td className="workout-name-cell">{workout.name || formatWorkoutName(new Date(workout.created_at))}</td>
                                                        <td className="workout-date-cell">{new Date(workout.created_at).toLocaleDateString(undefined, isMobileView ? { month: "short", day: "numeric", year: "numeric" } : { weekday: "short", month: "short", day: "numeric", year: "numeric" })}</td>
                                                        <td className="workout-duration-cell">{formatDurationSeconds(workout.duration_seconds)}</td>
                                                        <td>{exercises.length}</td>
                                                        <td className="workout-volume-cell">{volume} lbs</td>
                                                        <td>
                                                            <div className="record-actions">
                                                                <button
                                                                    className="table-toggle"
                                                                    aria-label={`Edit ${workout.name || "workout"}`}
                                                                    onClick={(event) => {
                                                                        event.stopPropagation();
                                                                        setExpandedWorkoutIds((current) => current.includes(workout.id) ? current : [...current, workout.id]);
                                                                        startEditWorkout(workout);
                                                                    }}
                                                                >
                                                                    <Edit3 size={15} />
                                                                </button>
                                                                <button
                                                                    className="table-toggle"
                                                                    aria-label={`Delete ${workout.name || "workout"}`}
                                                                    onClick={(event) => {
                                                                        event.stopPropagation();
                                                                        setPendingDeleteWorkout(workout);
                                                                    }}
                                                                >
                                                                    <Trash2 size={15} />
                                                                </button>
                                                            </div>
                                                        </td>
                                                    </tr>
                                                    {isExpanded && (
                                                        <tr className="record-detail-row workout-detail-row">
                                                            <td colSpan={7} style={{ padding: 0 }}>
                                                                <div className="record-detail-panel workout-detail-panel" style={{ padding: 0, width: "min(100%, calc(100vw - 60px))" }}>
                                                                     {isEditingWorkout && (
                                                                         <div style={{ display: "grid", gridTemplateColumns: "minmax(0, 1fr) auto", gap: 10, alignItems: "center", padding: "12px 12px 4px" }}>
                                                                             <input className="detail-input" style={{ padding: "10px 12px" }} value={editWorkoutName} onChange={(event) => setEditWorkoutName(event.target.value)} aria-label="Workout name" />
                                                                            <div className="row" style={{ gap: 8 }}>
                                                                                <button className="bare-icon-btn" aria-label="Add exercise to workout" onClick={addEditWorkoutExercise}><Plus size={17} /></button>
                                                                                <button className="bare-icon-btn" aria-label="Cancel editing workout" onClick={cancelEditWorkout}><X size={17} /></button>
                                                                                <button className="bare-icon-btn" aria-label="Save workout changes" onClick={() => saveEditWorkout(workout)}><Check size={17} /></button>
                                                                             </div>
                                                                         </div>
                                                                     )}
                                                                     {isEditingWorkout && (
                                                                         <div className="edit-workout-details-panel inline-edit-workout-details-panel">
                                                                             <label className="field-label">
                                                                                 <span>Description</span>
                                                                                 <textarea className="input finish-description-input" rows={4} value={editWorkoutNotes} onChange={(event) => setEditWorkoutNotes(event.target.value)} placeholder="Add workout description..." />
                                                                             </label>
                                                                             {editWorkoutPhotoUrls.length > 0 && (
                                                                                 <div className="field-label">
                                                                                     <span>Images</span>
                                                                                     <label className="finish-photo-picker edit-workout-photo-picker">
                                                                                         <input type="file" accept="image/*" multiple onChange={(event) => { const files = Array.from(event.target.files ?? []).filter((file) => file.type.startsWith("image/")); setEditWorkoutPhotos((current) => [...current, ...files]); event.target.value = ""; }} />
                                                                                         <Plus size={18} />
                                                                                         <span>Add images</span>
                                                                                     </label>
                                                                                     <div className="workout-photo-grid edit-workout-photo-grid">
                                                                                         {editWorkoutPhotoUrls.map((url, index) => (
                                                                                             <div className="edit-workout-photo" key={`${workout.id}-inline-edit-photo-${index}`}>
                                                                                                 <button className="edit-workout-photo-open" type="button" aria-label="View image" onClick={() => setPreviewImageUrl(url)}><img src={url} alt="" /></button>
                                                                                                 <button className="edit-workout-photo-remove" type="button" aria-label="Remove image" onClick={() => setEditWorkoutPhotoUrls((current) => current.filter((_, itemIndex) => itemIndex !== index))}><X size={14} /></button>
                                                                                             </div>
                                                                                         ))}
                                                                                         {editWorkoutPhotoPreviews.map((preview, index) => (
                                                                                             <div className="edit-workout-photo" key={`${preview.file.name}-${preview.file.lastModified}-${index}`}>
                                                                                                 <button className="edit-workout-photo-open" type="button" aria-label="View selected image" onClick={() => setPreviewImageUrl(preview.url)}><img src={preview.url} alt="" /></button>
                                                                                                 <button className="edit-workout-photo-remove" type="button" aria-label="Remove selected image" onClick={() => setEditWorkoutPhotos((current) => current.filter((_, itemIndex) => itemIndex !== index))}><X size={14} /></button>
                                                                                             </div>
                                                                                         ))}
                                                                                     </div>
                                                                                 </div>
                                                                             )}
                                                                             {!editWorkoutPhotoUrls.length && (
                                                                                 <div className="field-label">
                                                                                     <span>Images</span>
                                                                                     <label className="finish-photo-picker edit-workout-photo-picker">
                                                                                         <input type="file" accept="image/*" multiple onChange={(event) => { const files = Array.from(event.target.files ?? []).filter((file) => file.type.startsWith("image/")); setEditWorkoutPhotos((current) => [...current, ...files]); event.target.value = ""; }} />
                                                                                         <Plus size={18} />
                                                                                         <span>Add images</span>
                                                                                     </label>
                                                                                     {editWorkoutPhotoPreviews.length > 0 && (
                                                                                         <div className="workout-photo-grid edit-workout-photo-grid">
                                                                                             {editWorkoutPhotoPreviews.map((preview, index) => (
                                                                                                 <div className="edit-workout-photo" key={`${preview.file.name}-${preview.file.lastModified}-${index}`}>
                                                                                                     <button className="edit-workout-photo-open" type="button" aria-label="View selected image" onClick={() => setPreviewImageUrl(preview.url)}><img src={preview.url} alt="" /></button>
                                                                                                     <button className="edit-workout-photo-remove" type="button" aria-label="Remove selected image" onClick={() => setEditWorkoutPhotos((current) => current.filter((_, itemIndex) => itemIndex !== index))}><X size={14} /></button>
                                                                                                 </div>
                                                                                             ))}
                                                                                         </div>
                                                                                     )}
                                                                                 </div>
                                                                             )}
                                                                         </div>
                                                                     )}
                                                                     {(isEditingWorkout ? editWorkoutExercises.length : exercises.length) ? (
                                                                        <div
                                                                            className="recent-record-list"
                                                                            style={{
                                                                                border: 0,
                                                                                borderRadius: 0,
                                                                                background: "transparent",
                                                                                gap: 8,
                                                                                overflow: "visible",
                                                                                padding: "10px 8px 12px 20px",
                                                                            }}
                                                                        >
                                                                            {(isEditingWorkout ? editWorkoutExercises : exercises).map((exercise) => {
                                                                                const editExercise = isEditingWorkout ? exercise as EditableWorkoutExercise : editWorkoutExercises.find((item) => item.id === exercise.id);
                                                                                const originalExercise = exercises.find((item) => item.id === exercise.id);
                                                                                const exerciseNameValue = isEditingWorkout ? (exercise as EditableWorkoutExercise).name : (exercise as WorkoutExercise).exercise_name;
                                                                                const setRows = !isEditingWorkout && "set_rows" in exercise ? (exercise.set_rows?.length ? exercise.set_rows : [{ set: 1, reps: exercise.reps, weight: exercise.weight }]) : [];
                                                                                const displayRows = isEditingWorkout && editExercise ? editExercise.setRows : setRows;
                                                                                const isExerciseExpanded = expandedWorkoutExerciseIds.includes(exercise.id);
                                                                                const summaryRows = displayRows.filter((set) => Number(set.reps) > 0 && Number(set.weight) >= 0);
                                                                                const bestRow = summaryRows.reduce<EditableSetRow | null>((best, set) => !best || Number(set.weight) > Number(best.weight) ? set : best, null);
                                                                                const exerciseMeta = workoutExerciseMeta.get(normalise(exerciseNameValue));
                                                                                const exerciseImageUrl = isEditingWorkout && editExercise ? editExercise.image_url ?? exerciseMeta?.image_url : exerciseMeta?.image_url;
                                                                                return (
                                                                                    <div
                                                                                        className="record-detail-panel recent-record-panel"
                                                                                        key={exercise.id}
                                                                                        style={{ border: "1px solid var(--line)", borderRadius: 14, padding: 14 }}
                                                                                    >
                                                                                        <div style={{ display: "grid", gridTemplateColumns: isEditingWorkout ? (isMobileView ? "auto auto minmax(0, 1fr) auto" : "1fr auto") : "1fr", gap: 8, alignItems: "start" }}>
                                                                                            {isEditingWorkout && editExercise ? (
                                                                                                <div style={{ display: isMobileView ? "contents" : "grid", gridTemplateColumns: "auto auto minmax(0, 1fr) auto", gap: 8, alignItems: "center", width: "100%" }}>
                                                                                                    <button className="bare-icon-btn" aria-label={isExerciseExpanded ? `Collapse ${exerciseNameValue || "exercise"}` : `Expand ${exerciseNameValue || "exercise"}`} onClick={() => setExpandedWorkoutExerciseIds((prev) => prev.includes(exercise.id) ? prev.filter((id) => id !== exercise.id) : [...prev, exercise.id])}>
                                                                                                        <ChevronDown className={isExerciseExpanded ? "chevron open" : "chevron"} size={18} />
                                                                                                    </button>
                                                                                                    <span style={{ display: "inline-flex", alignItems: "center", justifyContent: "center", width: 34, height: 34, minWidth: 34, borderRadius: 12, border: "1px solid var(--line)", background: "var(--panel2)", overflow: "hidden" }}>
                                                                                                        {exerciseImageUrl ? <img src={exerciseImageUrl} alt="" style={{ width: "100%", height: "100%", objectFit: "cover", display: "block" }} /> : <Dumbbell size={17} />}
                                                                                                    </span>
                                                                                                    <div className="input-icon-wrap search-combo" style={{ display: "block", minWidth: 0 }}>
                                                                                                        <input className="detail-input" value={editExercise.name} placeholder="Search exercise" onFocus={() => setActiveEditExerciseId(exercise.id)} onBlur={() => setTimeout(() => { setActiveEditExerciseId(""); setEditExerciseSuggestions([]); }, 120)} onChange={(event) => { setActiveEditExerciseId(exercise.id); updateEditWorkoutExercise(exercise.id, { name: event.target.value, image_url: null }); }} />
                                                                                                        {activeEditExerciseId === exercise.id && editExercise.name.trim().length >= 2 && (
                                                                                                            <div className="exercise-suggestions" role="listbox" style={{ position: "static", marginTop: 8, width: "100%", maxWidth: "100%" }}>
                                                                                                                {editExerciseSuggestions.map((suggestion) => (
                                                                                                                    <div className="exercise-suggestion-item" key={`${suggestion.source}-${suggestion.id}`} role="option" tabIndex={0} onMouseDown={(event) => { event.preventDefault(); updateEditWorkoutExercise(exercise.id, { name: suggestion.name, image_url: suggestion.image_url }); setEditExerciseSuggestions([]); setActiveEditExerciseId(""); }}>
                                                                                                                        <span className="exercise-suggestion-icon">{suggestion.image_url ? <img src={suggestion.image_url} alt="" /> : <Dumbbell size={17} />}</span>
                                                                                                                        <span className="exercise-suggestion-copy"><span>{suggestion.name}</span><small>{[suggestion.category, suggestion.muscles?.[0], suggestion.equipment?.[0]].filter(Boolean).join(" • ")}</small></span>
                                                                                                                    </div>
                                                                                                                ))}
                                                                                                                {!editExerciseSuggestions.some((suggestion) => normalise(suggestion.name) === normalise(editExercise.name)) && (
                                                                                                                    <button className="exercise-suggestion-item" style={{ width: "100%", textAlign: "left" }} type="button" onMouseDown={(event) => { event.preventDefault(); openCustomExerciseModal(editExercise.name, "edit"); }}>
                                                                                                                        <span className="exercise-suggestion-icon"><Plus size={17} /></span>
                                                                                                                        <span className="exercise-suggestion-copy"><span>Add custom exercise</span><small>{editExercise.name.trim()}</small></span>
                                                                                                                    </button>
                                                                                                                )}
                                                                                                            </div>
                                                                                                        )}
                                                                                                    </div>
                                                                                                    {!isMobileView && <span className="muted" style={{ whiteSpace: "nowrap" }}>{displayRows.length} {displayRows.length === 1 ? "set" : "sets"}{bestRow ? ` • best ${bestRow.weight} lbs × ${bestRow.reps}` : ""}</span>}
                                                                                                </div>
                                                                                            ) : (
                                                                                                <button className="record-summary-toggle" style={{ display: "grid", gridTemplateColumns: "auto auto minmax(0, 1fr)", justifyContent: "start", justifyItems: "start", textAlign: "left", width: "100%" }} onClick={() => setExpandedWorkoutExerciseIds((prev) => prev.includes(exercise.id) ? prev.filter((id) => id !== exercise.id) : [...prev, exercise.id])}>
                                                                                                    <ChevronDown className={isExerciseExpanded ? "chevron open" : "chevron"} size={18} />
                                                                                                    <span style={{ display: "inline-flex", alignItems: "center", justifyContent: "center", width: 34, height: 34, minWidth: 34, borderRadius: 12, border: "1px solid var(--line)", background: "var(--panel2)", overflow: "hidden" }}>
                                                                                                        {exerciseImageUrl ? <img src={exerciseImageUrl} alt="" style={{ width: "100%", height: "100%", objectFit: "cover", display: "block" }} /> : <Dumbbell size={17} />}
                                                                                                    </span>
                                                                                                    <span style={{ display: "grid", gap: 3, minWidth: 0, justifyItems: "start", textAlign: "left" }}>
                                                                                                        <span style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{exerciseNameValue}</span>
                                                                                                        {!isMobileView && <span className="muted">{displayRows.length} {displayRows.length === 1 ? "set" : "sets"}{bestRow ? ` • best ${bestRow.weight} lbs × ${bestRow.reps}` : ""}</span>}
                                                                                                    </span>
                                                                                                </button>
                                                                                            )}
                                                                                            {isEditingWorkout && <button className="bare-icon-btn" aria-label={`Delete ${exerciseNameValue || "exercise"}`} onClick={() => removeEditWorkoutExercise(exercise.id)}><Trash2 size={15} /></button>}
                                                                                        </div>
                                                                                        {isExerciseExpanded && (
                                                                                            <>
                                                                                                <div className="record-detail-meta">
                                                                                                    <span>{originalExercise?.volume ?? 0} lbs volume</span>
                                                                                                    <span>{displayRows.length} {displayRows.length === 1 ? "set" : "sets"}</span>
                                                                                                    {bestRow && <span>Best {bestRow.weight} lbs × {bestRow.reps}</span>}
                                                                                                    {!isEditingWorkout && <Link href={`/history?exercise=${encodeURIComponent(exerciseNameValue.trim())}`}>View records</Link>}
                                                                                                </div>
                                                                                                <div className="set-detail-table">
                                                                                                    <div className="set-detail-head" style={{ gridTemplateColumns: isEditingWorkout ? "0.5fr 1fr 1fr 1.25fr 34px" : "0.6fr 1fr 1fr 1.3fr" }}>
                                                                                                        <span>Set</span>
                                                                                                        <span>Reps</span>
                                                                                                        <span>Weight</span>
                                                                                                        <span>Notes</span>
                                                                                                        {isEditingWorkout && <span></span>}
                                                                                                    </div>
                                                                                                    {displayRows.map((set, index) => (
                                                                                                        <div className="set-detail-row" style={{ gridTemplateColumns: isEditingWorkout ? "0.5fr 1fr 1fr 1.25fr 34px" : "0.6fr 1fr 1fr 1.3fr" }} key={`${exercise.id}-${set.set}-${index}`}>
                                                                                                            <span>{index + 1}</span>
                                                                                                            {isEditingWorkout ? (
                                                                                                                <>
                                                                                                                    <input className="detail-input" inputMode="numeric" value={set.reps} onChange={(event) => updateEditWorkoutSet(exercise.id, index, { reps: Number(event.target.value.replace(/\D/g, "")) })} />
                                                                                                                    <input className="detail-input" inputMode="decimal" value={set.weight} onChange={(event) => updateEditWorkoutSet(exercise.id, index, { weight: Number(event.target.value.replace(/[^0-9.]/g, "")) })} />
                                                                                                                    <input className="detail-input" value={set.notes ?? ""} placeholder="Notes" onChange={(event) => updateEditWorkoutSet(exercise.id, index, { notes: event.target.value })} />
                                                                                                                    <button className="bare-icon-btn" aria-label={`Delete ${exerciseNameValue || "exercise"} set ${index + 1}`} onClick={() => removeEditWorkoutSet(exercise.id, index)}><X size={14} /></button>
                                                                                                                </>
                                                                                                            ) : (
                                                                                                                <>
                                                                                                                    <span>{set.reps}</span>
                                                                                                                    <span>{set.weight} lbs</span>
                                                                                                                    <span>{set.notes || "—"}</span>
                                                                                                                </>
                                                                                                            )}
                                                                                                        </div>
                                                                                                    ))}
                                                                                                </div>
                                                                                                {isEditingWorkout && <button className="bare-icon-btn" aria-label={`Add set to ${exerciseNameValue || "exercise"}`} onClick={() => addEditWorkoutSet(exercise.id)}><Plus size={16} /></button>}
                                                                                            </>
                                                                                        )}
                                                                                    </div>
                                                                                );
                                                                            })}
                                                                        </div>
                                                                    ) : <div className="empty">No exercises saved for this workout.</div>}
                                                                </div>
                                                            </td>
                                                        </tr>
                                                    )}
                                                </Fragment>
                                            );
                                        })}
                                    </tbody>
                                </table>
                            </div>
                            <div className="pagination" style={{ flexDirection: "row", justifyContent: "center" }}>
                                <button className="btn secondary icon-btn" style={{ width: 42, minWidth: 42 }} aria-label="Previous workout page" disabled={safeWorkoutPage === 0} onClick={() => setWorkoutPage((current) => Math.max(0, current - 1))}><ChevronLeft size={17} /></button>
                                <span className="muted">Page {safeWorkoutPage + 1} of {workoutTotalPages}</span>
                                <button className="btn secondary icon-btn" style={{ width: 42, minWidth: 42 }} aria-label="Next workout page" disabled={safeWorkoutPage >= workoutTotalPages - 1} onClick={() => setWorkoutPage((current) => Math.min(workoutTotalPages - 1, current + 1))}><ChevronRight size={17} /></button>
                            </div>
                        </>
                    ) : <div className="empty">No workouts found.</div>}
                </section>
            )}

            {activeSection === "progress" && (
                <section className="stack progress-section">
                    <div className="input-icon-wrap search-combo">
                        <Search className="input-icon" size={17} />
                        <input
                            className="input with-icon with-clear"
                            placeholder="Search exercise progress"
                            value={progressExercise}
                            onFocus={() => setIsProgressSearchFocused(true)}
                            onBlur={() => setTimeout(() => setIsProgressSearchFocused(false), 120)}
                            onChange={(event) => {
                                setProgressExercise(event.target.value);
                                setIsProgressSearchFocused(true);
                            }}
                        />
                        {progressExercise && (
                            <button className="clear-input" aria-label="Clear progress search" onClick={() => setProgressExercise("")}>
                                <X size={16} />
                            </button>
                        )}
                        {isProgressSearchFocused && progressExercise.trim().length >= 2 && (
                            <div className="exercise-suggestions" role="listbox">
                                {progressSuggestions.map((exercise) => (
                                    <div
                                        className="exercise-suggestion-item"
                                        key={`${exercise.source}-${exercise.id}`}
                                        role="option"
                                        tabIndex={0}
                                        onMouseDown={(event) => {
                                            event.preventDefault();
                                            setProgressExercise(exercise.name);
                                            setIsProgressSearchFocused(false);
                                        }}
                                    >
                                        <span className="exercise-suggestion-icon">
                                            {exercise.image_url ? <img src={exercise.image_url} alt="" /> : <Dumbbell size={17} />}
                                        </span>
                                        <span className="exercise-suggestion-copy">
                                            <span>{exercise.name}</span>
                                            <small>{[exercise.category, exercise.muscles?.[0], exercise.equipment?.[0]].filter(Boolean).join(" • ")}</small>
                                        </span>
                                    </div>
                                ))}
                                {!progressSuggestions.some((exercise) => normalise(exercise.name) === normalise(progressExercise)) && (
                                    <button className="exercise-suggestion-item" style={{ width: "100%", textAlign: "left" }} type="button" onMouseDown={(event) => { event.preventDefault(); openCustomExerciseModal(progressExercise, "progress"); }}>
                                        <span className="exercise-suggestion-icon"><Plus size={17} /></span>
                                        <span className="exercise-suggestion-copy"><span>Add custom exercise</span><small>{progressExercise.trim()}</small></span>
                                    </button>
                                )}
                            </div>
                        )}
                    </div>
                    {muscleBalance.matchedCount > 0 && (
                        <div className="chart-card shadcn-chart">
                            <h3>Muscle balance</h3>
                            <ResponsiveContainer width="100%" height={isMobileView ? 300 : 360}>
                                <RadarChart data={muscleBalance.data} outerRadius={isMobileView ? 92 : 126}>
                                    <PolarGrid stroke="var(--line)" />
                                    <PolarAngleAxis dataKey="muscleGroup" tick={{ fontSize: isMobileView ? 11 : 12, fill: "var(--muted)" }} />
                                    <PolarRadiusAxis tick={false} axisLine={false} />
                                    <Tooltip formatter={(value) => [`${value} lbs`, "Volume"]} contentStyle={{ borderRadius: 14, border: "1px solid var(--line)", boxShadow: "0 12px 30px rgba(43,43,43,.12)" }} />
                                    <Radar name="Volume" dataKey="volume" stroke="var(--chart-1)" fill="var(--chart-1)" fillOpacity={0.18} strokeWidth={2.5} />
                                </RadarChart>
                            </ResponsiveContainer>
                        </div>
                    )}
                    {progressData.length ? (
                        <>
                            {progressSummary && (
                                <div className="stats">
                                    <div className="chart-card">
                                        <h3>Current best</h3>
                                        <strong>{progressSummary.latest.bestSet}</strong>
                                        <p className="muted">Est. 1RM {progressSummary.latest.estimatedOneRepMax} lbs</p>
                                    </div>
                                    <div className="chart-card">
                                        <h3>All-time estimated 1RM</h3>
                                        <strong>{progressSummary.allTimeBest.estimatedOneRepMax} lbs</strong>
                                        <p className="muted">{progressSummary.allTimeBest.date} • {progressSummary.allTimeBest.bestSet}</p>
                                    </div>
                                    <div className="chart-card">
                                        <h3>Sessions</h3>
                                        <strong>{progressSummary.totalSessions}</strong>
                                        <p className="muted">1RM {progressSummary.e1rmChange >= 0 ? "+" : ""}{progressSummary.e1rmChange} lbs from previous</p>
                                    </div>
                                </div>
                            )}
                            <div className="chart-card shadcn-chart">
                                <h3>Exercise trend</h3>
                                <ResponsiveContainer width="100%" height={isMobileView ? 300 : 380}>
                                    <LineChart data={progressData} margin={isMobileView ? { top: 12, right: 8, left: -18, bottom: 10 } : { top: 16, right: 26, left: 22, bottom: 26 }}>
                                        <CartesianGrid stroke="var(--line)" strokeDasharray="3 3" vertical={false} />
                                        <XAxis dataKey="date" tickLine={false} axisLine={false} interval="preserveStartEnd" minTickGap={isMobileView ? 18 : 8} tick={{ fontSize: isMobileView ? 10 : 12, fill: "var(--muted)" }}>
                                            {!isMobileView && <Label value="Date" offset={-14} position="insideBottom" fill="var(--muted)" fontSize={12} />}
                                        </XAxis>
                                        <YAxis yAxisId="weight" width={isMobileView ? 36 : 60} tickLine={false} axisLine={false} tick={{ fontSize: isMobileView ? 10 : 12, fill: "var(--muted)" }}>
                                            {!isMobileView && <Label value="Weight (lbs)" angle={-90} position="insideLeft" fill="var(--muted)" fontSize={12} />}
                                        </YAxis>
                                        <YAxis yAxisId="volume" orientation="right" width={isMobileView ? 36 : 60} tickLine={false} axisLine={false} tick={{ fontSize: isMobileView ? 10 : 12, fill: "var(--muted)" }}>
                                            {!isMobileView && <Label value="Volume (lbs)" angle={90} position="insideRight" fill="var(--muted)" fontSize={12} />}
                                        </YAxis>
                                        <Tooltip
                                            formatter={(value, name, item) => {
                                                const suffix = name === "Volume" ? " lbs volume" : " lbs";
                                                return [`${value}${suffix}`, name === "Estimated 1RM" ? "Est. 1RM" : name];
                                            }}
                                            labelFormatter={(label, payload) => {
                                                const row = payload?.[0]?.payload;
                                                return row ? `${label} • best ${row.bestSet} • ${row.sessions} ${row.sessions === 1 ? "session" : "sessions"}` : label;
                                            }}
                                            contentStyle={{ borderRadius: 14, border: "1px solid var(--line)", boxShadow: "0 12px 30px rgba(43,43,43,.12)" }}
                                        />
                                        <Line yAxisId="weight" type="monotone" dataKey="bestWeight" name="Best weight" stroke="var(--chart-1)" strokeWidth={2.5} dot={{ r: isMobileView ? 2 : 3 }} />
                                        <Line yAxisId="weight" type="monotone" dataKey="estimatedOneRepMax" name="Estimated 1RM" stroke="#555" strokeWidth={2.5} strokeDasharray="5 5" dot={{ r: isMobileView ? 2 : 3 }} />
                                        <Line yAxisId="volume" type="monotone" dataKey="volume" name="Volume" stroke="var(--chart-2)" strokeWidth={2.5} dot={{ r: isMobileView ? 2 : 3 }} />
                                    </LineChart>
                                </ResponsiveContainer>
                            </div>
                        </>
                    ) : <div className="empty">Search an exercise to see progress.</div>}

                    {bodyWeightVsExerciseData.length > 0 && (
                        <div className="chart-card shadcn-chart">
                            <h3>Body weight vs {progressExercise} best weight</h3>
                            <ResponsiveContainer width="100%" height={isMobileView ? 280 : 340}>
                                <ScatterChart data={bodyWeightVsExerciseData} margin={isMobileView ? { top: 12, right: 8, left: -8, bottom: 10 } : { top: 16, right: 28, left: 54, bottom: 30 }}>
                                    <CartesianGrid stroke="var(--line)" strokeDasharray="3 3" />
                                    <XAxis type="number" dataKey="bodyWeight" name="Body weight" unit=" lbs" tickLine={false} axisLine={false} tick={{ fontSize: isMobileView ? 10 : 12, fill: "var(--muted)" }}>
                                        {!isMobileView && <Label value="Body weight (lbs)" offset={-14} position="insideBottom" fill="var(--muted)" fontSize={12} />}
                                    </XAxis>
                                    <YAxis type="number" dataKey="exerciseWeight" name={`${progressExercise} best`} unit=" lbs" tickLine={false} axisLine={false} tick={{ fontSize: isMobileView ? 10 : 12, fill: "var(--muted)" }} width={isMobileView ? 38 : 58}>
                                        {!isMobileView && <Label value={`${progressExercise} best (lbs)`} angle={-90} position="left" offset={36} fill="var(--muted)" fontSize={12} />}
                                    </YAxis>
                                    <Tooltip cursor={{ strokeDasharray: "3 3" }} formatter={(value, name) => [`${value} lbs`, name]} labelFormatter={(_, payload) => payload?.[0]?.payload?.date ?? ""} contentStyle={{ borderRadius: 14, border: "1px solid var(--line)", boxShadow: "0 12px 30px rgba(43,43,43,.12)" }} />
                                    <Scatter name={`${progressExercise} best`} data={bodyWeightVsExerciseData} fill="var(--chart-1)" />
                                </ScatterChart>
                            </ResponsiveContainer>
                        </div>
                    )}

                    {progressHistory.length > 0 && (
                        <div className="recent-record-list">
                            <div className="recent-list-header">
                                <span className="muted">Records</span>
                                <Link className="view-all-link" href={`/history?exercise=${encodeURIComponent(progressExercise.trim())}`}>View all</Link>
                            </div>
                            {progressHistory.slice().reverse().slice(0, 10).map((record) => {
                                const isExpanded = expandedProgressRecordId === record.id;
                                const rows = record.set_rows?.length ? record.set_rows : [{ set: 1, reps: record.reps, weight: record.weight }];
                                return (
                                    <div className="record-detail-panel recent-record-panel" key={record.id}>
                                        <button className="record-summary-toggle" onClick={() => setExpandedProgressRecordId(isExpanded ? "" : record.id)}>
                                            <ChevronDown className={isExpanded ? "chevron open" : "chevron"} size={18} />
                                            <span>{new Date(record.created_at).toLocaleDateString(undefined, { month: "short", day: "numeric", year: "numeric" })}</span>
                                            <span>{record.sets} {record.sets === 1 ? "set" : "sets"} • best {record.weight} lbs × {record.reps}</span>
                                        </button>
                                        {isExpanded && (
                                            <>
                                                <div className="record-detail-meta">
                                                    <span>{record.volume} lbs volume</span>
                                                    {record.notes && <span>{record.notes}</span>}
                                                </div>
                                                <div className="set-detail-table">
                                                    <div className="set-detail-head" style={{ gridTemplateColumns: "0.6fr 1fr 1fr 1.3fr" }}>
                                                        <span>Set</span>
                                                        <span>Reps</span>
                                                        <span>Weight</span>
                                                        <span>Notes</span>
                                                    </div>
                                                    {rows.map((set) => (
                                                        <div className="set-detail-row" style={{ gridTemplateColumns: "0.6fr 1fr 1fr 1.3fr" }} key={`${record.id}-${set.set}`}>
                                                            <span>{set.set}</span>
                                                            <span>{set.reps}</span>
                                                            <span>{set.weight} lbs</span>
                                                            <span>{set.notes || "—"}</span>
                                                        </div>
                                                    ))}
                                                </div>
                                            </>
                                        )}
                                    </div>
                                );
                            })}
                        </div>
                    )}
                </section>
            )}

            {activeSection === "weight" && (
                <section className="stack weight-section">
                    <div ref={weightFormRef} className="stack">
                        {editingWeightId && <div className="sync-status" style={{ marginBottom: 0 }}><span>Editing weight entry</span><span>{weightDate}</span></div>}
                        <div className="date-filters">
                            <DatePickerField label="Weight date" value={weightDate} onChange={setWeightDate} />
                            <div className="weight-input-wrap">
                                <input ref={weightInputRef} className="input weight-input" inputMode="decimal" placeholder="Weight (lbs)" value={weightValue} onChange={(event) => setWeightValue(event.target.value.replace(/[^0-9.]/g, ""))} />
                                {weightKilograms && <span className="weight-kg-conversion">{weightKilograms}</span>}
                            </div>
                        </div>
                        <input className="input" placeholder="Notes (optional)" value={weightNotes} onChange={(event) => setWeightNotes(event.target.value)} />
                        <div className="row action-row">
                            <button className="btn" onClick={saveBodyWeight}><Save size={18} /> {editingWeightId ? "Update weight" : "Save weight"}</button>
                        </div>
                    </div>

                    {weightSummary && (
                        <>
                            <div className="stats">
                                <div className="chart-card">
                                    <h3>Current weight</h3>
                                    <strong>{weightSummary.latest.weight} lbs</strong>
                                    <p className="muted">{weightSummary.previousChange >= 0 ? "+" : ""}{weightSummary.previousChange} lbs from previous</p>
                                </div>
                                <div className="chart-card">
                                    <h3>Total change</h3>
                                    <strong>{weightSummary.totalChange >= 0 ? "+" : ""}{weightSummary.totalChange} lbs</strong>
                                    <p className="muted">Across {weightSummary.entries} {weightSummary.entries === 1 ? "entry" : "entries"}</p>
                                </div>
                                <div className="chart-card">
                                    <h3>Range</h3>
                                    <strong>{weightSummary.lowest.weight} - {weightSummary.highest.weight} lbs</strong>
                                    <p className="muted">Low to high</p>
                                </div>
                            </div>
                            <div className="chart-card shadcn-chart">
                                <h3>Body weight trend</h3>
                                <ResponsiveContainer width="100%" height={isMobileView ? 280 : 340}>
                                    <LineChart data={weightChartData} margin={isMobileView ? { top: 12, right: 8, left: -10, bottom: 10 } : { top: 16, right: 26, left: 22, bottom: 26 }}>
                                        <CartesianGrid stroke="var(--line)" strokeDasharray="3 3" vertical={false} />
                                        <XAxis dataKey="date" tickLine={false} axisLine={false} interval="preserveStartEnd" minTickGap={isMobileView ? 18 : 8} tick={{ fontSize: isMobileView ? 10 : 12, fill: "var(--muted)" }}>
                                            {!isMobileView && <Label value="Date" offset={-14} position="insideBottom" fill="var(--muted)" fontSize={12} />}
                                        </XAxis>
                                        <YAxis width={isMobileView ? 38 : 60} domain={["dataMin - 2", "dataMax + 2"]} tickLine={false} axisLine={false} tick={{ fontSize: isMobileView ? 10 : 12, fill: "var(--muted)" }}>
                                            {!isMobileView && <Label value="Body weight (lbs)" angle={-90} position="insideLeft" fill="var(--muted)" fontSize={12} />}
                                        </YAxis>
                                        <Tooltip formatter={(value) => [`${value} lbs`, "Weight"]} labelFormatter={(label, payload) => {
                                            const row = payload?.[0]?.payload;
                                            return row?.notes ? `${label} • ${row.notes}` : label;
                                        }} contentStyle={{ borderRadius: 14, border: "1px solid var(--line)", boxShadow: "0 12px 30px rgba(43,43,43,.12)" }} />
                                        <Line type="monotone" dataKey="weight" name="Weight" stroke="var(--chart-1)" strokeWidth={2.5} dot={{ r: isMobileView ? 2 : 3 }} />
                                    </LineChart>
                                </ResponsiveContainer>
                            </div>
                        </>
                    )}

                    {bodyWeights.length ? (
                        <>
                            <div className="table-wrap">
                                <table className="records-table">
                                    <thead>
                                        <tr>
                                            <th>Date</th>
                                            <th>Weight</th>
                                            <th>Notes</th>
                                            <th></th>
                                        </tr>
                                    </thead>
                                    <tbody>
                                        {weightRows.map((row) => (
                                            <tr key={row.id}>
                                                <td>{new Date(`${row.measured_on}T00:00:00`).toLocaleDateString(undefined, { month: "short", day: "numeric", year: "numeric" })}</td>
                                                <td>{row.weight} lbs</td>
                                                <td>{row.notes || "—"}</td>
                                                <td>
                                                    <div className="record-actions">
                                                        <button className="table-toggle" aria-label="Edit weight" onClick={() => startEditWeight(row)}><Edit3 size={15} /></button>
                                                        <button className="table-toggle" aria-label="Delete weight" onClick={() => setPendingDeleteWeight(row)}><Trash2 size={15} /></button>
                                                    </div>
                                                </td>
                                            </tr>
                                        ))}
                                    </tbody>
                                </table>
                            </div>
                            {weightTotalPages > 1 && (
                                <div className="pagination" style={{ flexDirection: "row", justifyContent: "center" }}>
                                    <button className="btn secondary icon-btn" style={{ width: 42, minWidth: 42 }} aria-label="Previous weight page" disabled={safeWeightPage === 0} onClick={() => setWeightPage((current) => { const next = Math.max(0, current - 1); loadBodyWeights(userKey, next); return next; })}><ChevronLeft size={17} /></button>
                                    <span className="muted">Page {safeWeightPage + 1} of {weightTotalPages}</span>
                                    <button className="btn secondary icon-btn" style={{ width: 42, minWidth: 42 }} aria-label="Next weight page" disabled={safeWeightPage >= weightTotalPages - 1} onClick={() => setWeightPage((current) => { const next = Math.min(weightTotalPages - 1, current + 1); loadBodyWeights(userKey, next); return next; })}><ChevronRight size={17} /></button>
                                </div>
                            )}
                        </>
                    ) : <div className="empty">No weight records found.</div>}
                </section>
            )}

            {activeSection === "settings" && (
                <section className="stack settings-section">
                    <div className="settings-list">
                        <button className="settings-row" type="button" onClick={cycleTheme}>
                            <span className="settings-row-icon">{theme === "dark" ? <Moon size={18} /> : <Sun size={18} />}</span>
                            <span><strong>Mode</strong><small>{theme === "dark" ? "Dark" : "Light"}</small></span>
                            <ChevronRight size={17} />
                        </button>
                        <button className="settings-row" type="button" onClick={() => setAgentModalOpen(true)}>
                            <span className="settings-row-icon"><Bot size={18} /></span>
                            <span><strong>Ask ProgressFit</strong><small>Chat with your training history</small></span>
                            <ChevronRight size={17} />
                        </button>
                        <button className="settings-row" type="button" onClick={() => window.location.reload()}>
                            <span className="settings-row-icon"><RefreshCw size={18} /></span>
                            <span><strong>Refresh app</strong><small>Reload latest data</small></span>
                            <ChevronRight size={17} />
                        </button>
                        {authLoading ? null : authUserEmail ? (
                            <button className="settings-row" type="button" onClick={() => setLogoutConfirmOpen(true)}>
                                <span className="settings-row-icon"><LogOut size={18} /></span>
                                <span><strong>Sign out</strong><small>{authUserEmail}</small></span>
                                <ChevronRight size={17} />
                            </button>
                        ) : (
                            <button className="settings-row" type="button" onClick={() => setAuthModalOpen(true)}>
                                <span className="settings-row-icon"><LogIn size={18} /></span>
                                <span><strong>Sign in</strong><small>Sync workouts across devices</small></span>
                                <ChevronRight size={17} />
                            </button>
                        )}
                    </div>
                </section>
            )}

            <AnimatePresence>
                {activeSection === "exercises" && fullscreenExerciseId && restTimerRemaining > 0 && (
                    <motion.div
                        key={restTimerMinimized ? "rest-timer-minimized" : "rest-timer-expanded"}
                        className={restTimerMinimized ? "rest-timer-panel minimized" : "rest-timer-panel"}
                        initial={{ y: "100%", opacity: 0 }}
                        animate={{ y: 0, opacity: 1 }}
                        exit={{ y: "100%", opacity: 0 }}
                        transition={{ type: "spring", stiffness: 360, damping: 34 }}
                        drag={restTimerMinimized ? false : "y"}
                        dragConstraints={{ top: 0, bottom: 150 }}
                        dragElastic={0.12}
                        dragMomentum={false}
                        dragSnapToOrigin
                        onDragEnd={(_, info) => {
                            if (info.offset.y > 56 || info.velocity.y > 420) setRestTimerMinimized(true);
                            else if (info.offset.y < -18 || info.velocity.y < -320) setRestTimerMinimized(false);
                        }}
                    >
                        {restTimerMinimized ? (
                            <div className="rest-timer-mini-controls">
                                <button type="button" onClick={decreaseRestTimer}>-15</button>
                                <button className="rest-timer-mini-time" type="button" onClick={() => setRestTimerMinimized(false)}><Clock3 size={15} /> {formatRestTimer(restTimerRemaining)}</button>
                                <button type="button" onClick={increaseRestTimer}>+15</button>
                                <button className="rest-timer-mini-skip" type="button" onClick={skipRestTimer}>Skip</button>
                            </div>
                        ) : (
                            <>
                                <div className="rest-timer-progress"><span style={{ transform: `scaleX(${restTimerProgress})` }} /></div>
                                <strong>{formatRestTimer(restTimerRemaining)}</strong>
                                <div className="rest-timer-actions">
                                    <button type="button" onClick={decreaseRestTimer}>-15</button>
                                    <button type="button" onClick={increaseRestTimer}>+15</button>
                                    <button className="rest-timer-skip" type="button" onClick={skipRestTimer}>Skip</button>
                                </div>
                            </>
                        )}
                    </motion.div>
                )}
            </AnimatePresence>

            <AnimatePresence>
                {restTimerSheetOpen && (
                    <>
                        <motion.button className="bottom-sheet-backdrop" type="button" aria-label="Close rest timer options" onClick={() => setRestTimerSheetOpen(false)} initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }} />
                        <motion.div className="bottom-sheet rest-timer-sheet" initial={{ y: "100%" }} animate={{ y: 0 }} exit={{ y: "100%" }} transition={{ type: "spring", stiffness: 380, damping: 36 }}>
                            <h3>Rest timer</h3>
                            <div className="rest-timer-options">
                                {REST_TIMER_OPTIONS.map((seconds) => {
                                    const selectedExercise = workoutQueue.find((exercise) => exercise.id === restTimerExerciseId);
                                    return (
                                    <button className={(selectedExercise?.restTimerSeconds ?? 0) === seconds ? "active" : ""} type="button" key={seconds} onClick={() => { setWorkoutQueue((current) => current.map((exercise) => exercise.id === restTimerExerciseId ? { ...exercise, restTimerSeconds: seconds } : exercise)); if (!seconds) { setRestTimerRemaining(0); setRestTimerTotal(0); setRestTimerEndAt(0); } setRestTimerSheetOpen(false); }}>
                                        {formatRestOption(seconds)}
                                    </button>
                                    );
                                })}
                            </div>
                        </motion.div>
                    </>
                )}
            </AnimatePresence>

            <Dialog.Root open={Boolean(pendingStartRoutine)} onOpenChange={(open) => { if (!open) setPendingStartRoutine(null); }}>
                <Dialog.Portal>
                    <Dialog.Overlay className="dialog-overlay" />
                    <Dialog.Content className="dialog-content">
                        <Dialog.Title className="dialog-title">Start routine?</Dialog.Title>
                        <Dialog.Description className="dialog-description">
                            Start a workout with {pendingStartRoutine?.title || "this routine"}? All routine exercises and sets will be loaded into Track.
                        </Dialog.Description>
                        <div className="dialog-actions">
                            <Dialog.Close asChild><button className="btn secondary">Cancel</button></Dialog.Close>
                            <button className="btn" type="button" onClick={() => pendingStartRoutine && startRoutineWorkout(pendingStartRoutine)}>Start workout</button>
                        </div>
                    </Dialog.Content>
                </Dialog.Portal>
            </Dialog.Root>

            <Dialog.Root open={Boolean(pendingDiscardAction)} onOpenChange={(open) => { if (!open) setPendingDiscardAction(null); }}>
                <Dialog.Portal>
                    <Dialog.Overlay className="dialog-overlay" />
                    <Dialog.Content className="dialog-content">
                        <Dialog.Title className="dialog-title">Discard current workout?</Dialog.Title>
                        <Dialog.Description className="dialog-description">
                            You have a workout in progress. Discard it and continue?
                        </Dialog.Description>
                        <div className="dialog-actions">
                            <Dialog.Close asChild><button className="btn secondary">Cancel</button></Dialog.Close>
                            <button className="btn danger" type="button" onClick={confirmDiscardAndContinue}>Discard and continue</button>
                        </div>
                    </Dialog.Content>
                </Dialog.Portal>
            </Dialog.Root>

            <Dialog.Root open={Boolean(pendingDeleteRoutine)} onOpenChange={(open) => { if (!open) setPendingDeleteRoutine(null); }}>
                <Dialog.Portal>
                    <Dialog.Overlay className="dialog-overlay" />
                    <Dialog.Content className="dialog-content">
                        <Dialog.Title className="dialog-title">Delete routine?</Dialog.Title>
                        <Dialog.Description className="dialog-description">
                            Delete {pendingDeleteRoutine?.title || "this routine"}? This will not delete saved workouts.
                        </Dialog.Description>
                        <div className="dialog-actions">
                            <Dialog.Close asChild><button className="btn secondary">Cancel</button></Dialog.Close>
                            <button className="btn danger" type="button" onClick={() => pendingDeleteRoutine && deleteRoutine(pendingDeleteRoutine)}>Delete</button>
                        </div>
                    </Dialog.Content>
                </Dialog.Portal>
            </Dialog.Root>

            <Dialog.Root open={routineCloseConfirmOpen} onOpenChange={setRoutineCloseConfirmOpen}>
                <Dialog.Portal>
                    <Dialog.Overlay className="dialog-overlay" />
                    <Dialog.Content className="dialog-content">
                        <Dialog.Title className="dialog-title">Close routine?</Dialog.Title>
                        <Dialog.Description className="dialog-description">
                            Save this routine before closing, or discard your changes?
                        </Dialog.Description>
                        <div className="dialog-actions">
                            <Dialog.Close asChild><button className="btn secondary">Cancel</button></Dialog.Close>
                            <button className="btn secondary" type="button" onClick={() => { setRoutineCloseConfirmOpen(false); closeRoutineBuilder(); }}>Discard</button>
                            <button className="btn" type="button" disabled={saving || !routineExercises.length} onClick={async () => { setRoutineCloseConfirmOpen(false); await saveRoutine(); }}>Save routine</button>
                        </div>
                    </Dialog.Content>
                </Dialog.Portal>
            </Dialog.Root>

            <Dialog.Root open={authModalOpen} onOpenChange={setAuthModalOpen}>
                <Dialog.Portal>
                    <Dialog.Overlay className="dialog-overlay" />
                    <Dialog.Content className="dialog-content">
                        <Dialog.Title className="dialog-title">Sign in</Dialog.Title>
                        <Dialog.Description className="dialog-description">Use the same email and password on iPhone and web to sync your data.</Dialog.Description>
                        <input className="input" type="email" placeholder="Email" value={authEmail} onChange={(event) => setAuthEmail(event.target.value)} />
                        <input className="input" type="password" placeholder="Password" value={authPassword} onChange={(event) => setAuthPassword(event.target.value)} />
                        {authMessage && <p className="muted">{authMessage}</p>}
                        <div className="dialog-actions">
                            <Dialog.Close asChild><button className="btn secondary">Cancel</button></Dialog.Close>
                            <button className="btn secondary" onClick={signUpWithEmail}>Create account</button>
                            <button className="btn" onClick={signInWithEmail}>Sign in</button>
                        </div>
                    </Dialog.Content>
                </Dialog.Portal>
            </Dialog.Root>

            <Dialog.Root open={agentModalOpen} onOpenChange={setAgentModalOpen}>
                <Dialog.Portal>
                    <Dialog.Overlay className="dialog-overlay" />
                    <Dialog.Content className="dialog-content agent-dialog-content" style={{ top: "max(12px, env(safe-area-inset-top))", bottom: "auto", left: 8, right: 8, width: "auto", height: "calc(100dvh - max(12px, env(safe-area-inset-top)) + env(safe-area-inset-bottom))", maxHeight: "none", transform: "none", paddingTop: 16, paddingBottom: "max(16px, env(safe-area-inset-bottom))" }}>
                        <div className="agent-dialog-head" style={{ alignItems: "flex-start" }}>
                            <div style={{ minWidth: 0, paddingRight: 8 }}>
                                <Dialog.Title className="dialog-title">Ask ProgressFit</Dialog.Title>
                                <Dialog.Description className="dialog-description">Ask follow-up questions about your training history.</Dialog.Description>
                            </div>
                            <div className="row" style={{ flexShrink: 0, gap: 6 }}>
                                {agentMessages.length > 0 && <button className="bare-icon-btn" style={{ width: 44, height: 44, padding: 0 }} onClick={() => { setAgentMessages([]); setAgentError(""); setAgentContext(undefined); }} aria-label="Clear chat" title="Clear chat"><Trash2 size={18} /></button>}
                                <Dialog.Close asChild><button className="bare-icon-btn" style={{ width: 44, height: 44, padding: 0 }} aria-label="Close agent" title="Close"><X size={22} /></button></Dialog.Close>
                            </div>
                        </div>
                        <div className="agent-chat-log">
                            {agentMessages.length === 0 ? (
                                <div className="agent-welcome">
                                    <strong>What do you want to know?</strong>
                                    <p className="muted">Try a training question, then ask follow-ups like “what about chest?” or “and this month?”.</p>
                                    <div className="agent-prompts">
                                        {["Arm sets last month", "Chest volume this week", "Workouts this month", "Top muscle group last month"].map((prompt) => (
                                            <button className="suggestion" key={prompt} type="button" onClick={() => askAgent(prompt)} disabled={agentLoading}>{prompt}</button>
                                        ))}
                                    </div>
                                </div>
                            ) : (
                                agentMessages.map((message) => (
                                    <div className={`agent-message ${message.role}`} key={message.id}>
                                        <div className="agent-bubble">
                                            <p>{message.content}</p>
                                            {message.breakdown?.length ? (
                                                <div className="agent-breakdown">
                                                    {message.breakdown.map((row) => (
                                                        <div className="agent-breakdown-row" key={`${message.id}-${row.label}`}>
                                                            <span>{row.label}</span>
                                                            <span>{row.value} {row.unit}</span>
                                                        </div>
                                                    ))}
                                                </div>
                                            ) : null}
                                            {message.tables?.map((table) => (
                                                <div className="set-detail-table" key={`${message.id}-${table.title}`}>
                                                    <div className="set-detail-head" style={{ gridTemplateColumns: `repeat(${table.columns.length}, minmax(0, 1fr))` }}>
                                                        {table.columns.map((column) => <span key={column}>{column}</span>)}
                                                    </div>
                                                    {table.title && <div className="set-detail-row" style={{ gridTemplateColumns: "1fr" }}><span>{table.title}</span></div>}
                                                    {table.rows.map((row, rowIndex) => (
                                                        <div className="set-detail-row" style={{ gridTemplateColumns: `repeat(${table.columns.length}, minmax(0, 1fr))` }} key={`${table.title}-${rowIndex}`}>
                                                            {row.map((cell, cellIndex) => <span key={`${rowIndex}-${cellIndex}`}>{cell || "-"}</span>)}
                                                        </div>
                                                    ))}
                                                </div>
                                            ))}
                                        </div>
                                    </div>
                                ))
                            )}
                            {agentLoading && <div className="agent-message assistant"><div className="agent-bubble"><p>ProgressFit is checking...</p></div></div>}
                        </div>
                        {agentError && <p className="muted">{agentError}</p>}
                        <form className="agent-form" onSubmit={(event) => { event.preventDefault(); askAgent(); }}>
                            <input className="input" value={agentQuestion} onChange={(event) => setAgentQuestion(event.target.value)} placeholder={agentMessages.length ? "Ask a follow-up..." : "How many arm sets did I do last month?"} />
                            <button className="btn icon-btn" type="submit" disabled={agentLoading || !agentQuestion.trim()} aria-label="Ask"><Send size={17} /></button>
                        </form>
                    </Dialog.Content>
                </Dialog.Portal>
            </Dialog.Root>

            <Dialog.Root open={exercisePickerOpen} onOpenChange={setExercisePickerOpen}>
                <AnimatePresence>
                    {exercisePickerOpen && (
                        <Dialog.Portal forceMount>
                            <Dialog.Overlay forceMount asChild>
                                <motion.div
                                    className="dialog-overlay exercise-picker-overlay"
                                    initial={{ opacity: 0 }}
                                    animate={{ opacity: 1 }}
                                    exit={{ opacity: 0 }}
                                    transition={{ duration: 0.18 }}
                                />
                            </Dialog.Overlay>
                            <Dialog.Content forceMount asChild>
                                <motion.div
                                    className={selectedPickerExercises.length ? "dialog-content exercise-picker-dialog has-selection" : "dialog-content exercise-picker-dialog"}
                                    initial={isMobileView ? { opacity: 0, y: 24 } : { opacity: 0, x: "-50%", y: "-46%", scale: 0.96 }}
                                    animate={isMobileView ? { opacity: 1, y: 0 } : { opacity: 1, x: "-50%", y: "-50%", scale: 1 }}
                                    exit={isMobileView ? { opacity: 0, y: 24 } : { opacity: 0, x: "-50%", y: "-46%", scale: 0.96 }}
                                    transition={{ type: "spring", stiffness: 420, damping: 34 }}
                                >
                        <div className="exercise-picker-header">
                            <Dialog.Title className="dialog-title">{exercisePickerMode === "edit" || exercisePickerMode === "routine-edit" ? "Select exercise" : "Add exercises"}</Dialog.Title>
                            <Dialog.Close asChild><button className="bare-icon-btn" aria-label="Close add exercises"><X size={18} /></button></Dialog.Close>
                        </div>
                        <div className="input-icon-wrap search-combo">
                            <Search className="input-icon" size={17} />
                            <input ref={exercisePickerInputRef} className="input with-icon with-clear" value={exercisePickerSearch} onChange={(event) => setExercisePickerSearch(event.target.value)} placeholder="Search exercises" autoFocus />
                            {exercisePickerSearch && (
                                <button className="clear-input" aria-label="Clear exercise search" onClick={() => setExercisePickerSearch("")}>
                                    <X size={16} />
                                </button>
                            )}
                        </div>
                        {selectedPickerExercises.length > 0 && (
                            <div className="exercise-picker-selected">
                                {selectedPickerExercises.map((exercise) => <button type="button" key={exercise.id} onClick={() => togglePickerExercise(exercise)}>{exercise.name}<X size={13} /></button>)}
                            </div>
                        )}
                        <div className="exercise-picker-list" onTouchStartCapture={blurActiveInput} onPointerDownCapture={blurActiveInput} onTouchMoveCapture={blurActiveInput} onWheel={blurActiveInput} onScroll={blurActiveInput}>
                            {exercisePickerSearch.trim().length < 2 ? <p className="muted">Start typing to find an exercise.</p> : (
                                <>
                                    {!exercisePickerSuggestions.some((exercise) => normalise(exercise.name) === normalise(exercisePickerSearch)) && (
                                        <button
                                            className="exercise-picker-item"
                                            type="button"
                                            onClick={() => { setExercisePickerOpen(false); openCustomExerciseModal(exercisePickerSearch, exercisePickerMode === "edit" ? "edit" : exercisePickerMode === "routine" ? "routine" : exercisePickerMode === "routine-edit" ? "routine-edit" : "tracker"); }}
                                        >
                                            <span className="exercise-suggestion-icon"><Plus size={17} /></span>
                                            <span className="exercise-suggestion-copy"><span>Add custom exercise</span><small>{exercisePickerSearch.trim()}</small></span>
                                        </button>
                                    )}
                                    {exercisePickerSuggestions.length ? exercisePickerSuggestions.map((exercise) => {
                                const selected = selectedPickerExercises.some((item) => normalise(item.name) === normalise(exercise.name));
                                const alreadyAdded = exercisePickerMode === "track"
                                    ? workoutQueue.some((item) => normalise(item.name) === normalise(exercise.name))
                                    : exercisePickerMode === "routine"
                                        ? routineExercises.some((item) => normalise(item.name) === normalise(exercise.name))
                                        : false;
                                return (
                                    <button
                                        className={selected ? "exercise-picker-item selected" : "exercise-picker-item"}
                                        type="button"
                                        key={`${exercise.source}-${exercise.id}`}
                                        disabled={alreadyAdded}
                                        onPointerDown={blurActiveInput}
                                        onClick={() => togglePickerExercise(exercise)}
                                    >
                                        <span className="exercise-suggestion-icon">{exercise.image_url ? <img src={exercise.image_url} alt="" /> : <Dumbbell size={17} />}</span>
                                        <span className="exercise-suggestion-copy"><span>{exercise.name}</span><small>{alreadyAdded ? "Already added" : [exercise.category, exercise.muscles?.[0], exercise.equipment?.[0]].filter(Boolean).join(" • ")}</small></span>
                                        {selected && <Check size={17} />}
                                    </button>
                                );
                                    }) : <p className="muted">No exercises found.</p>}
                                </>
                            )}
                        </div>
                        <div className="dialog-actions exercise-picker-actions">
                            <button className="btn secondary" type="button" onClick={() => setExercisePickerOpen(false)}>Cancel</button>
                            <button className="btn" type="button" disabled={!selectedPickerExercises.length} onClick={addSelectedPickerExercises}>{exercisePickerMode === "edit" || exercisePickerMode === "routine-edit" ? "Select exercise" : `Add ${selectedPickerExercises.length || ""} ${selectedPickerExercises.length === 1 ? "exercise" : "exercises"}`}</button>
                        </div>
                                </motion.div>
                            </Dialog.Content>
                        </Dialog.Portal>
                    )}
                </AnimatePresence>
            </Dialog.Root>

            <Dialog.Root open={customExerciseModalOpen} onOpenChange={setCustomExerciseModalOpen}>
                <Dialog.Portal>
                    <Dialog.Overlay className="dialog-overlay" />
                    <Dialog.Content className="dialog-content">
                        <Dialog.Title className="dialog-title">Add custom exercise</Dialog.Title>
                        <input className="input" value={customExerciseName} onChange={(event) => setCustomExerciseName(event.target.value)} placeholder="Exercise name" />
                        <Select.Root value={customExerciseCategory} onValueChange={setCustomExerciseCategory}>
                            <Select.Trigger className="input" aria-label="Exercise category" style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 10 }}>
                                <Select.Value placeholder="Select category" />
                                <Select.Icon asChild><ChevronDown size={18} /></Select.Icon>
                            </Select.Trigger>
                            <Select.Portal>
                                <Select.Content position="popper" sideOffset={6} style={{ zIndex: 120, minWidth: "var(--radix-select-trigger-width)", overflow: "hidden", border: "1px solid var(--line)", borderRadius: 16, background: "var(--panel)", color: "var(--text)", boxShadow: "0 14px 32px rgba(43,43,43,.16)" }}>
                                    <Select.Viewport>
                                        {CUSTOM_EXERCISE_CATEGORIES.map((category) => (
                                            <Select.Item value={category} key={category} style={{ display: "grid", gridTemplateColumns: "20px 1fr", gap: 8, alignItems: "center", padding: "11px 12px", cursor: "pointer", outline: "none" }}>
                                                <Select.ItemIndicator><Check size={15} /></Select.ItemIndicator>
                                                <Select.ItemText>{category}</Select.ItemText>
                                            </Select.Item>
                                        ))}
                                    </Select.Viewport>
                                </Select.Content>
                            </Select.Portal>
                        </Select.Root>
                        <div className="stack">
                            <small className="muted">Primary muscles</small>
                            <div className="agent-prompts" style={{ justifyContent: "flex-start" }}>
                                {CUSTOM_EXERCISE_MUSCLES.map((muscle) => (
                                    <button className="suggestion" style={{ width: "auto", background: customExerciseMuscles.includes(muscle) ? "var(--brand)" : undefined, color: customExerciseMuscles.includes(muscle) ? "var(--bg)" : undefined }} type="button" key={muscle} onClick={() => setCustomExerciseMuscles((current) => toggleListValue(current, muscle))}>{muscle}</button>
                                ))}
                            </div>
                        </div>
                        <div className="stack">
                            <small className="muted">Equipment</small>
                            <div className="agent-prompts" style={{ justifyContent: "flex-start" }}>
                                {CUSTOM_EXERCISE_EQUIPMENT.map((equipment) => (
                                    <button className="suggestion" style={{ width: "auto", background: customExerciseEquipment.includes(equipment) ? "var(--brand)" : undefined, color: customExerciseEquipment.includes(equipment) ? "var(--bg)" : undefined }} type="button" key={equipment} onClick={() => setCustomExerciseEquipment((current) => toggleListValue(current, equipment))}>{equipment}</button>
                                ))}
                            </div>
                        </div>
                        <div className="dialog-actions">
                            <Dialog.Close asChild><button className="btn secondary">Cancel</button></Dialog.Close>
                            <button className="btn" onClick={saveCustomExercise}>Save exercise</button>
                        </div>
                    </Dialog.Content>
                </Dialog.Portal>
            </Dialog.Root>

            <Dialog.Root open={workoutNameModalOpen} onOpenChange={setWorkoutNameModalOpen}>
                <Dialog.Portal>
                    <Dialog.Overlay className="dialog-overlay" />
                    <Dialog.Content className="dialog-content">
                        <Dialog.Title className="dialog-title">Save workout</Dialog.Title>
                        <Dialog.Description className="dialog-description">Name this workout, or leave the default.</Dialog.Description>
                        <input className="input" value={workoutNameInput} onChange={(event) => setWorkoutNameInput(event.target.value)} placeholder={formatWorkoutName()} />
                        <div className="dialog-actions">
                            <Dialog.Close asChild><button className="btn secondary">Cancel</button></Dialog.Close>
                            <button className="btn" disabled={saving} onClick={() => confirmSaveWorkout()}>{saving ? "Saving..." : "Save workout"}</button>
                        </div>
                    </Dialog.Content>
                </Dialog.Portal>
            </Dialog.Root>

            <Dialog.Root open={finishDetailsModalOpen} onOpenChange={(open) => { if (!saving) { setFinishDetailsModalOpen(open); if (!open) setFinishSummary(null); } }}>
                <Dialog.Portal>
                    <Dialog.Overlay className="dialog-overlay" />
                    <Dialog.Content className="dialog-content finish-details-dialog">
                        <Dialog.Title className="dialog-title">Finish workout</Dialog.Title>
                        <Dialog.Description className="dialog-description">Review your workout and add details before saving.</Dialog.Description>
                        <div className="finish-details-body">
                            <div className="finish-summary-grid">
                                <span><small>Duration</small><strong>{workoutDurationLabel}</strong></span>
                                <span><small>Volume</small><strong>{workoutStatsVolume} lbs</strong></span>
                                <span><small>Sets</small><strong>{workoutStatsSetCount}</strong></span>
                                <span><small>Exercises</small><strong>{workoutQueue.filter((exercise) => exercise.name.trim() && validSetRows(exercise.sets, exerciseIsBodyweight(exercise.name, exercise.equipment)).length).length}</strong></span>
                            </div>
                            <label className="field-label">
                                <span>Workout name</span>
                                <input className="input" value={finishWorkoutNameInput} onChange={(event) => setFinishWorkoutNameInput(event.target.value)} placeholder={formatWorkoutName()} />
                            </label>
                            <label className="field-label">
                                <span>Description</span>
                                <textarea className="input finish-description-input" rows={4} value={finishWorkoutNotes} onChange={(event) => setFinishWorkoutNotes(event.target.value)} placeholder="How did it feel? Add notes, PRs, soreness, or context." />
                            </label>
                            <div className="field-label">
                                <span>Images</span>
                                <label className="finish-photo-picker">
                                    <input type="file" accept="image/*" multiple onChange={(event) => { const files = Array.from(event.target.files ?? []).filter((file) => file.type.startsWith("image/")); setFinishWorkoutPhotos((current) => [...current, ...files]); event.target.value = ""; }} />
                                    <Plus size={18} />
                                    <span>Add images</span>
                                </label>
                                {finishWorkoutPhotoPreviews.length > 0 && (
                                    <div className="finish-photo-grid">
                                        {finishWorkoutPhotoPreviews.map((preview, index) => (
                                            <div className="finish-photo-preview" key={`${preview.file.name}-${preview.file.lastModified}-${index}`}>
                                                <img src={preview.url} alt="" />
                                                <button type="button" aria-label="Remove image" onClick={() => setFinishWorkoutPhotos((current) => current.filter((_, itemIndex) => itemIndex !== index))}><X size={14} /></button>
                                            </div>
                                        ))}
                                    </div>
                                )}
                            </div>
                        </div>
                        <div className="dialog-actions finish-details-actions">
                            <button className="btn secondary" type="button" disabled={saving} onClick={() => setFinishDetailsModalOpen(false)}>Cancel</button>
                            <button className="btn" type="button" disabled={saving} onClick={() => finishWorkout({ title: finishWorkoutNameInput, notes: finishWorkoutNotes, photos: finishWorkoutPhotos })}>{saving ? "Saving..." : "Save workout"}</button>
                        </div>
                    </Dialog.Content>
                </Dialog.Portal>
            </Dialog.Root>

            <Dialog.Root open={Boolean(previewImageUrl)} onOpenChange={(open) => !open && setPreviewImageUrl("")}>
                <Dialog.Portal>
                    <Dialog.Overlay className="dialog-overlay image-preview-overlay" />
                    <Dialog.Content className="image-preview-dialog">
                        <Dialog.Title className="sr-only">Workout image</Dialog.Title>
                        <button className="image-preview-close" type="button" aria-label="Close image" onClick={() => setPreviewImageUrl("")}><X size={20} /></button>
                        {previewImageUrl && <img src={previewImageUrl} alt="" />}
                    </Dialog.Content>
                </Dialog.Portal>
            </Dialog.Root>

            <Dialog.Root open={Boolean(pendingDeleteWorkout)} onOpenChange={(open) => !open && setPendingDeleteWorkout(null)}>
                <Dialog.Portal>
                    <Dialog.Overlay className="dialog-overlay" />
                    <Dialog.Content className="dialog-content">
                        <Dialog.Title className="dialog-title">Delete workout?</Dialog.Title>
                        <Dialog.Description className="dialog-description">
                            This will delete {pendingDeleteWorkout?.name || "this workout"} and all exercises in it. This cannot be undone.
                        </Dialog.Description>
                        <div className="dialog-actions">
                            <Dialog.Close asChild><button className="btn secondary">Cancel</button></Dialog.Close>
                            <button className="btn danger" onClick={confirmDeleteWorkout}>Delete</button>
                        </div>
                    </Dialog.Content>
                </Dialog.Portal>
            </Dialog.Root>

            <Dialog.Root open={Boolean(finishSummary) && !finishDetailsModalOpen} onOpenChange={(open) => !open && setFinishSummary(null)}>
                <Dialog.Portal>
                    <Dialog.Overlay className="dialog-overlay" />
                    <Dialog.Content className="dialog-content finish-summary-dialog">
                        <Dialog.Title className="dialog-title">Workout complete</Dialog.Title>
                        <Dialog.Description className="dialog-description">{finishSummary?.title}</Dialog.Description>
                        <div className="finish-summary-grid">
                            <span><small>Duration</small><strong>{finishSummary?.duration}</strong></span>
                            <span><small>Volume</small><strong>{finishSummary?.volume} lbs</strong></span>
                            <span><small>Sets</small><strong>{finishSummary?.sets}</strong></span>
                            <span><small>Exercises</small><strong>{finishSummary?.exercises}</strong></span>
                        </div>
                        <div className="dialog-actions">
                            <Dialog.Close asChild><button className="btn">Done</button></Dialog.Close>
                        </div>
                    </Dialog.Content>
                </Dialog.Portal>
            </Dialog.Root>

            <Dialog.Root open={logoutConfirmOpen} onOpenChange={setLogoutConfirmOpen}>
                <Dialog.Portal>
                    <Dialog.Overlay className="dialog-overlay" />
                    <Dialog.Content className="dialog-content">
                        <Dialog.Title className="dialog-title">Sign out?</Dialog.Title>
                        <Dialog.Description className="dialog-description">
                            You will need to sign in again to sync your workouts.
                        </Dialog.Description>
                        <div className="dialog-actions">
                            <Dialog.Close asChild><button className="btn secondary">Cancel</button></Dialog.Close>
                            <button className="btn danger" onClick={signOut}>Sign out</button>
                        </div>
                    </Dialog.Content>
                </Dialog.Portal>
            </Dialog.Root>

            <Dialog.Root open={Boolean(pendingDeleteWeight)} onOpenChange={(open) => !open && setPendingDeleteWeight(null)}>
                <Dialog.Portal>
                    <Dialog.Overlay className="dialog-overlay" />
                    <Dialog.Content className="dialog-content">
                        <Dialog.Title className="dialog-title">Delete weight?</Dialog.Title>
                        <Dialog.Description className="dialog-description">
                            Delete the {pendingDeleteWeight?.measured_on} weight entry? This cannot be undone.
                        </Dialog.Description>
                        <div className="dialog-actions">
                            <Dialog.Close asChild><button className="btn secondary">Cancel</button></Dialog.Close>
                            <button className="btn danger" onClick={confirmDeleteWeight}>Delete</button>
                        </div>
                    </Dialog.Content>
                </Dialog.Portal>
            </Dialog.Root>

            <Dialog.Root open={clearDraftModalOpen} onOpenChange={setClearDraftModalOpen}>
                <Dialog.Portal>
                    <Dialog.Overlay className="dialog-overlay" />
                    <Dialog.Content className="dialog-content">
                        <Dialog.Title className="dialog-title">Clear current draft?</Dialog.Title>
                        <Dialog.Description className="dialog-description">
                            This will remove all exercises currently added to the tracker. Saved records will not be deleted.
                        </Dialog.Description>
                        <div className="dialog-actions">
                            <Dialog.Close asChild><button className="btn secondary">Cancel</button></Dialog.Close>
                            <button className="btn danger" onClick={clearCurrentDraft}>Clear all</button>
                        </div>
                    </Dialog.Content>
                </Dialog.Portal>
            </Dialog.Root>

            <Dialog.Root open={Boolean(pendingRemoveExercise)} onOpenChange={(open) => !open && setPendingRemoveExercise(null)}>
                <Dialog.Portal>
                    <Dialog.Overlay className="dialog-overlay" />
                    <Dialog.Content className="dialog-content">
                        <Dialog.Title className="dialog-title">Remove from tracker?</Dialog.Title>
                        <Dialog.Description className="dialog-description">
                            Remove {pendingRemoveExercise?.name || "this exercise"} from this screen? Saved records will not be deleted.
                        </Dialog.Description>
                        <div className="dialog-actions">
                            <Dialog.Close asChild><button className="btn secondary">Cancel</button></Dialog.Close>
                            <button className="btn danger" onClick={() => pendingRemoveExercise && removeQueuedExercise(pendingRemoveExercise)}>Remove</button>
                        </div>
                    </Dialog.Content>
                </Dialog.Portal>
            </Dialog.Root>

            {toast && <div className="toast">{toast}</div>}
        </main>
    );
}
