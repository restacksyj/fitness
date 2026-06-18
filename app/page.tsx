"use client";

import Link from "next/link";
import * as Dialog from "@radix-ui/react-dialog";
import { format } from "date-fns";
import { Fragment, useEffect, useMemo, useState } from "react";
import { DayPicker, type DateRange } from "react-day-picker";
import "react-day-picker/style.css";
import { Activity, Calendar, Check, ChevronDown, ChevronLeft, ChevronRight, Dumbbell, Edit3, Eraser, GripVertical, LogIn, LogOut, Plus, RefreshCw, Save, Search, SlidersHorizontal, TrendingUp, Trash2, Weight, X } from "lucide-react";
import { CartesianGrid, Label, Line, LineChart, ResponsiveContainer, Scatter, ScatterChart, Tooltip, XAxis, YAxis } from "recharts";
import { cacheExerciseCatalog, enqueueOffline, getOfflineQueueCount, offlineDb, searchCachedExerciseCatalog, type OfflineQueueItem } from "@/lib/offline-db";
import { isSupabaseConfigured, supabase, type BodyWeight, type ExerciseCatalogItem, type Workout, type WorkoutExercise, type WorkoutSetRow } from "@/lib/supabase";
import { blankExercise, blankSet, loadWorkoutDraft, saveWorkoutDraft, type ExerciseDraft, type SetRow } from "@/lib/workout-draft";

type WorkoutWithExercises = Workout & { workout_exercises: WorkoutExercise[] };
type ExerciseTrackerDraft = { exerciseName: string; sets: SetRow[] };
type ExerciseSuggestion = Pick<ExerciseCatalogItem, "id" | "name" | "category" | "muscles" | "equipment" | "image_url"> & { source: "catalog" | "history" };
type EditableWorkoutExercise = { id: string; name: string; setRows: WorkoutSetRow[] };
type OfflineWorkoutPayload = { name: string; exercises: Array<{ name: string; sets: Array<{ set: number; reps: number; weight: number; notes?: string }>; notes?: string | null; body_weight?: number | null }> };
type OfflineBodyWeightPayload = { user_key: string; weight: number; measured_on: string; notes: string | null };

const TRACKER_DRAFT_KEY = "progressfit-exercise-tracker-draft";
const formatWorkoutName = (date = new Date()) => date.toLocaleDateString(undefined, { weekday: "short", month: "short", day: "numeric", year: "numeric" });
const normalise = (name: string) => name.trim().toLowerCase();
const blankTrackerSets = () => [blankSet()];
const PAGE_SIZE = 10;
const WEIGHT_PAGE_SIZE = 10;
const todayInputValue = () => new Date().toISOString().slice(0, 10);
const SECTION_STORAGE_KEY = "progressfit-active-section";
type ActiveSection = "workouts" | "exercises" | "progress" | "weight";
const estimateOneRepMax = (weight: number, reps: number) => Math.round(weight * (1 + reps / 30));

function loadTrackerDraft(): ExerciseTrackerDraft | null {
  if (typeof window === "undefined") return null;
  const raw = localStorage.getItem(TRACKER_DRAFT_KEY);
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw) as ExerciseTrackerDraft;
    return {
      exerciseName: typeof parsed.exerciseName === "string" ? parsed.exerciseName : "",
      sets: Array.isArray(parsed.sets) && parsed.sets.length ? parsed.sets : blankTrackerSets(),
    };
  } catch {
    return null;
  }
}

function saveTrackerDraft(draft: ExerciseTrackerDraft) {
  if (typeof window === "undefined") return;
  localStorage.setItem(TRACKER_DRAFT_KEY, JSON.stringify(draft));
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
      ? `${format(selected.from, "MMM d, yyyy")} – ${format(selected.to, "MMM d, yyyy")}`
      : `${format(selected.from, "MMM d, yyyy")} – optional`
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
          <Dialog.Title className="dialog-title">Date range</Dialog.Title>
          <Dialog.Description className="dialog-description">Pick a start date. End date is optional.</Dialog.Description>
          <DayPicker
            mode="range"
            selected={selected}
            onSelect={(range) => onChange({ from: dateToInputValue(range?.from), to: dateToInputValue(range?.to) })}
          />
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
  const [activeSection, setActiveSection] = useState<ActiveSection>(() => {
    if (typeof window === "undefined") return "exercises";
    const saved = localStorage.getItem(SECTION_STORAGE_KEY);
    return saved === "workouts" || saved === "exercises" || saved === "progress" || saved === "weight" ? saved : "exercises";
  });
  const [userKey, setUserKey] = useState("");
  const [authEmail, setAuthEmail] = useState("");
  const [authPassword, setAuthPassword] = useState("");
  const [authUserEmail, setAuthUserEmail] = useState("");
  const [authLoading, setAuthLoading] = useState(true);
  const [authMessage, setAuthMessage] = useState("");
  const [authModalOpen, setAuthModalOpen] = useState(false);
  const [exerciseName, setExerciseName] = useState("");
  const [sets, setSets] = useState<SetRow[]>(blankTrackerSets());
  const [workoutName, setWorkoutName] = useState("");
  const [currentWorkoutId, setCurrentWorkoutId] = useState("");
  const [workoutQueue, setWorkoutQueue] = useState<ExerciseDraft[]>([]);
  const [history, setHistory] = useState<WorkoutExercise[]>([]);
  const [catalogSuggestions, setCatalogSuggestions] = useState<ExerciseSuggestion[]>([]);
  const [selectedExerciseMeta, setSelectedExerciseMeta] = useState<ExerciseSuggestion | null>(null);
  const [recentWorkouts, setRecentWorkouts] = useState<WorkoutWithExercises[]>([]);
  const [bodyWeights, setBodyWeights] = useState<BodyWeight[]>([]);
  const [bodyWeightHistory, setBodyWeightHistory] = useState<BodyWeight[]>([]);
  const [workoutSearch, setWorkoutSearch] = useState("");
  const [workoutDateFrom, setWorkoutDateFrom] = useState("");
  const [workoutDateTo, setWorkoutDateTo] = useState("");
  const [workoutPage, setWorkoutPage] = useState(0);
  const [editingWorkoutId, setEditingWorkoutId] = useState("");
  const [editWorkoutName, setEditWorkoutName] = useState("");
  const [editWorkoutExercises, setEditWorkoutExercises] = useState<EditableWorkoutExercise[]>([]);
  const [weightValue, setWeightValue] = useState("");
  const [weightDate, setWeightDate] = useState(todayInputValue());
  const [weightNotes, setWeightNotes] = useState("");
  const [weightPage, setWeightPage] = useState(0);
  const [progressExercise, setProgressExercise] = useState("");
  const [progressHistory, setProgressHistory] = useState<WorkoutExercise[]>([]);
  const [progressCatalogSuggestions, setProgressCatalogSuggestions] = useState<ExerciseSuggestion[]>([]);
  const [isProgressSearchFocused, setIsProgressSearchFocused] = useState(false);
  const [bodyWeightCount, setBodyWeightCount] = useState(0);
  const [editingWeightId, setEditingWeightId] = useState("");
  const [pendingDeleteWeight, setPendingDeleteWeight] = useState<BodyWeight | null>(null);
  const [clearDraftModalOpen, setClearDraftModalOpen] = useState(false);
  const [workoutNameModalOpen, setWorkoutNameModalOpen] = useState(false);
  const [workoutNameInput, setWorkoutNameInput] = useState(formatWorkoutName());
  const [pendingDeleteWorkout, setPendingDeleteWorkout] = useState<WorkoutWithExercises | null>(null);
  const [pendingRemoveExercise, setPendingRemoveExercise] = useState<ExerciseDraft | null>(null);
  const [selectedWorkoutId, setSelectedWorkoutId] = useState("");
  const [expandedWorkoutExerciseIds, setExpandedWorkoutExerciseIds] = useState<string[]>([]);
  const [isExerciseSearchFocused, setIsExerciseSearchFocused] = useState(false);
  const [expandedHistoryExerciseIds, setExpandedHistoryExerciseIds] = useState<string[]>([]);
  const [expandedRecentRecordId, setExpandedRecentRecordId] = useState("");
  const [collapsedQueueIds, setCollapsedQueueIds] = useState<string[]>([]);
  const [draggingSetId, setDraggingSetId] = useState("");
  const [dragOverSetId, setDragOverSetId] = useState("");
  const [draftReady, setDraftReady] = useState(false);
  const [saving, setSaving] = useState(false);
  const [savingExerciseId, setSavingExerciseId] = useState("");
  const [toast, setToast] = useState("");
  const [isOnline, setIsOnline] = useState(true);
  const [offlineQueueCount, setOfflineQueueCount] = useState(0);
  const [syncingOffline, setSyncingOffline] = useState(false);
  const [workoutTypeFilter, setWorkoutTypeFilter] = useState<"all" | "workout" | "exercise">("all");
  const [workoutTypeFilterOpen, setWorkoutTypeFilterOpen] = useState(false);
  const [isMobileView, setIsMobileView] = useState(false);

  useEffect(() => {
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
    const trackerDraft = loadTrackerDraft();
    if (trackerDraft) {
      setExerciseName(trackerDraft.exerciseName);
      setSets(trackerDraft.sets);
    }

    const workoutDraft = loadWorkoutDraft();
    if (workoutDraft) {
      const exercises = workoutDraft.exercises
        .filter((exercise) => exercise.name.trim())
        .map((exercise) => exercise.savedExerciseId?.startsWith("offline-") ? { ...exercise, savedExerciseId: undefined } : exercise);
      setWorkoutName(workoutDraft.workoutName);
      setCurrentWorkoutId(workoutDraft.workoutId ?? "");
      setWorkoutQueue(exercises);
      setCollapsedQueueIds(exercises.map((exercise) => exercise.id));
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
        setRecentWorkouts([]);
        setBodyWeights([]);
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
    const persistDrafts = () => {
      saveTrackerDraft({ exerciseName, sets });
      saveWorkoutDraft({ workoutName, workoutId: currentWorkoutId || undefined, exercises: workoutQueue.length ? workoutQueue : [blankExercise()] });
    };
    window.addEventListener("pagehide", persistDrafts);
    window.addEventListener("beforeunload", persistDrafts);
    return () => {
      window.removeEventListener("pagehide", persistDrafts);
      window.removeEventListener("beforeunload", persistDrafts);
    };
  }, [currentWorkoutId, draftReady, exerciseName, sets, workoutName, workoutQueue]);

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
        if (!cancelled) setCatalogSuggestions(cached.filter((exercise) => normalise(exercise.name) !== normalise(query)).map((exercise) => ({ ...exercise, source: "catalog" })));
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
        const cached = await searchCachedExerciseCatalog(query, 8);
        setCatalogSuggestions(cached.map((exercise) => ({ ...exercise, source: "catalog" })));
        return;
      }

      const rows = (data ?? []) as Omit<ExerciseSuggestion, "source">[];
      await cacheExerciseCatalog(rows);
      setCatalogSuggestions(
        rows
          .filter((exercise) => normalise(exercise.name) !== normalise(query))
          .map((exercise) => ({ ...exercise, source: "catalog" })),
      );
    }, 180);

    return () => {
      cancelled = true;
      window.clearTimeout(timeout);
    };
  }, [exerciseName]);

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
        setProgressCatalogSuggestions(cached.map((exercise) => ({ ...exercise, source: "catalog" })));
        return;
      }

      const rows = (data ?? []) as Omit<ExerciseSuggestion, "source">[];
      await cacheExerciseCatalog(rows);
      setProgressCatalogSuggestions(rows.map((exercise) => ({ ...exercise, source: "catalog" })));
    }, 180);

    return () => {
      cancelled = true;
      window.clearTimeout(timeout);
    };
  }, [progressExercise]);

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

  async function signOut() {
    await supabase.auth.signOut();
    setUserKey("");
    setAuthUserEmail("");
    setHistory([]);
    setRecentWorkouts([]);
    setBodyWeights([]);
  }

  async function refreshOfflineCount(key = userKey) {
    setOfflineQueueCount(await getOfflineQueueCount(key));
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
    const items = await offlineDb.queue.where("userKey").equals(userKey).toArray();
    const queued = items.find((item) => {
      if (item.type !== "save_workout") return false;
      const payload = item.payload as OfflineWorkoutPayload;
      return payload.exercises.length === 1 && normalise(payload.exercises[0].name) === normalise(exercise.name);
    });
    if (!queued?.id) return false;
    await offlineDb.queue.update(queued.id, {
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
      const { data: workout, error: workoutError } = await supabase
        .from("workouts")
        .insert({ user_key: item.userKey, name: payload.name })
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
      if (error) throw error;
    }
  }

  async function processOfflineQueue(key = userKey) {
    if (!key || !navigator.onLine || !isSupabaseConfigured || syncingOffline) return;
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
      setSyncingOffline(false);
    }
  }

  async function loadData(key = userKey) {
    if (!key || !isSupabaseConfigured) return;
    await Promise.all([loadHistory(key), loadRecentWorkouts(key), loadBodyWeights(key), loadBodyWeightHistory(key)]);
  }

  async function loadHistory(key = userKey) {
    if (!key || !isSupabaseConfigured) return;
    const { data, error } = await supabase
      .from("workout_exercises")
      .select("*")
      .eq("user_key", key)
      .order("created_at", { ascending: false })
      .limit(10);

    if (error) return console.error(error.message);
    setHistory(data ?? []);
  }

  async function loadRecentWorkouts(key = userKey) {
    if (!key || !isSupabaseConfigured) return;
    const { data, error } = await supabase
      .from("workouts")
      .select("*, workout_exercises(*)")
      .eq("user_key", key)
      .order("created_at", { ascending: false })
      .limit(10);

    if (error) return console.error(error.message);
    setRecentWorkouts((data ?? []) as WorkoutWithExercises[]);
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

  const exerciseNames = useMemo(() => {
    return Array.from(new Set(history.map((h) => h.exercise_name)));
  }, [history]);

  const exerciseSuggestions = useMemo(() => {
    const q = normalise(exerciseName);
    if (!q) return [];

    const suggestions = new Map<string, ExerciseSuggestion>();
    exerciseNames
      .filter((name) => normalise(name).includes(q) && normalise(name) !== q)
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
    return history.filter((h) => normalise(h.exercise_name) === key);
  }, [history, exerciseName]);

  const filteredWorkouts = useMemo(() => {
    const q = normalise(workoutSearch);
    const fromTime = workoutDateFrom ? new Date(`${workoutDateFrom}T00:00:00`).getTime() : null;
    const toTime = workoutDateTo ? new Date(`${workoutDateTo}T23:59:59`).getTime() : null;

    return recentWorkouts.filter((workout) => {
      const workoutTime = new Date(workout.created_at).getTime();
      const exercises = workout.workout_exercises ?? [];
      const inferredType = exercises.length > 1 ? "workout" : "exercise";
      const matchesType = workoutTypeFilter === "all" || inferredType === workoutTypeFilter;
      const matchesSearch = !q || normalise(workout.name || "").includes(q) || exercises.some((exercise) => normalise(exercise.exercise_name).includes(q));
      const matchesFrom = fromTime === null || workoutTime >= fromTime;
      const matchesTo = toTime === null || workoutTime <= toTime;
      return matchesType && matchesSearch && matchesFrom && matchesTo;
    });
  }, [recentWorkouts, workoutDateFrom, workoutDateTo, workoutSearch, workoutTypeFilter]);

  const workoutTotalPages = Math.max(1, Math.ceil(filteredWorkouts.length / PAGE_SIZE));
  const safeWorkoutPage = Math.min(workoutPage, workoutTotalPages - 1);
  const workoutRows = filteredWorkouts.slice(safeWorkoutPage * PAGE_SIZE, safeWorkoutPage * PAGE_SIZE + PAGE_SIZE);
  const selectedWorkout = recentWorkouts.find((workout) => workout.id === selectedWorkoutId);
  const hasUnsavedWorkoutExercises = workoutQueue.some((exercise) => !exercise.savedExerciseId);
  const weightTotalPages = Math.max(1, Math.ceil(bodyWeightCount / WEIGHT_PAGE_SIZE));
  const safeWeightPage = Math.min(weightPage, weightTotalPages - 1);
  const weightRows = bodyWeights;
  const currentBodyWeight = bodyWeights[0]?.weight ?? null;
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

  function lastBestForSet(exerciseName: string, setNumber: number) {
    const record = history.find((item) => normalise(item.exercise_name) === normalise(exerciseName));
    const row = record?.set_rows?.find((set) => Number(set.set) === setNumber);
    if (row) return `${row.weight}×${row.reps}`;
    if (record && setNumber === 1) return `${record.weight}×${record.reps}`;
    return "—";
  }

  function validSetRows(sourceSets = sets) {
    return sourceSets
      .map((set, index) => ({ set: index + 1, reps: Number(set.reps), weight: set.weight === "" ? 0 : Number(set.weight), notes: set.notes?.trim() || undefined }))
      .filter((set) => Number.isFinite(set.reps) && set.reps > 0 && Number.isFinite(set.weight) && set.weight >= 0);
  }

  function clearTracker() {
    setExerciseName("");
    setSelectedExerciseMeta(null);
    setSets(blankTrackerSets());
  }

  function clearCurrentDraft() {
    setWorkoutQueue([]);
    setCollapsedQueueIds([]);
    setCurrentWorkoutId("");
    setWorkoutName("");
    clearTracker();
    setClearDraftModalOpen(false);
    setToast("Draft cleared");
    setTimeout(() => setToast(""), 2200);
  }

  function updateSet(setId: string, patch: Partial<Omit<SetRow, "id">>) {
    setSets((prev) => prev.map((set) => (set.id === setId ? { ...set, ...patch } : set)));
  }

  function reorderSets(fromId: string, toId: string) {
    if (!fromId || !toId || fromId === toId) return;
    setSets((prev) => {
      const fromIndex = prev.findIndex((set) => set.id === fromId);
      const toIndex = prev.findIndex((set) => set.id === toId);
      if (fromIndex < 0 || toIndex < 0) return prev;
      const next = [...prev];
      const [moved] = next.splice(fromIndex, 1);
      next.splice(toIndex, 0, moved);
      return next;
    });
  }

  function addToWorkout(nameOverride?: string, metaOverride?: ExerciseSuggestion | null) {
    const name = (nameOverride ?? exerciseName).trim();
    if (!name) return alert("Search or enter an exercise name first.");

    const existingExercise = workoutQueue.find((exercise) => normalise(exercise.name) === normalise(name));
    if (existingExercise) {
      setCollapsedQueueIds((prev) => prev.filter((id) => id !== existingExercise.id));
      clearTracker();
      setToast(`${name} is already added`);
      setTimeout(() => setToast(""), 2200);
      return;
    }

    const meta = metaOverride ?? (selectedExerciseMeta && normalise(selectedExerciseMeta.name) === normalise(name) ? selectedExerciseMeta : null);
    const id = crypto.randomUUID();
    setWorkoutQueue((prev) => [
      ...prev,
      {
        id,
        name,
        sets: blankTrackerSets(),
        image_url: meta?.image_url ?? null,
        category: meta?.category ?? null,
        muscles: meta?.muscles ?? [],
        equipment: meta?.equipment ?? [],
        notes: "",
      },
    ]);
    setCollapsedQueueIds((prev) => [...prev, id]);
    clearTracker();
    setToast(`${name} added`);
    setTimeout(() => setToast(""), 2200);
  }

  async function saveSingleExercise() {
    const name = exerciseName.trim();
    const rows = validSetRows();
    if (!isSupabaseConfigured) return alert("Add Supabase env vars in .env.local first.");
    if (!name || !rows.length || !userKey) return alert("Add an exercise name and at least one valid set first.");

    const saved = await saveExercises([{ name, sets: rows }], name);
    if (saved) clearTracker();
  }

  function saveWorkoutFromTrackers() {
    if (!workoutQueue.length) return alert("Add at least one exercise before saving a workout.");

    const rows = workoutQueue
      .filter((exercise) => !exercise.savedExerciseId)
      .map((exercise) => ({ exercise, name: exercise.name.trim(), sets: validSetRows(exercise.sets) }))
      .filter((exercise) => exercise.name && exercise.sets.length);

    if (!isSupabaseConfigured) return alert("Add Supabase env vars in .env.local first.");
    if (!rows.length || !userKey) return alert("Add at least one exercise with a valid set before saving a workout.");

    setWorkoutNameInput(workoutName || formatWorkoutName());
    setWorkoutNameModalOpen(true);
  }

  async function confirmSaveWorkout() {
    const rows = workoutQueue
      .filter((exercise) => !exercise.savedExerciseId)
      .map((exercise) => ({ exercise, name: exercise.name.trim(), sets: validSetRows(exercise.sets) }))
      .filter((exercise) => exercise.name && exercise.sets.length);
    const title = workoutNameInput.trim() || formatWorkoutName();

    if (!navigator.onLine) {
      await enqueueOffline({
        userKey,
        type: "save_workout",
        payload: {
          name: title,
          exercises: rows.map(({ exercise, name, sets }) => ({ name, sets, notes: exercise.notes?.trim() || null, body_weight: currentBodyWeight })),
        } satisfies OfflineWorkoutPayload,
      });
      await refreshOfflineCount();
      setWorkoutNameModalOpen(false);
      setToast(`${title} saved offline`);
      setTimeout(() => setToast(""), 2200);
      return;
    }

    setSaving(true);
    const { data: workout, error: workoutError } = await supabase
      .from("workouts")
      .insert({ user_key: userKey, name: title })
      .select("id")
      .single();

    if (workoutError || !workout) {
      setSaving(false);
      return alert(workoutError?.message ?? "Could not save workout");
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
    if (error) return alert(error.message);

    setWorkoutNameModalOpen(false);
    setCurrentWorkoutId(workout.id);
    setWorkoutName(title);
    await loadData();
    setToast(`${title} saved`);
    setTimeout(() => setToast(""), 2200);
  }

  function startEditWorkout(workout: WorkoutWithExercises) {
    setEditingWorkoutId(workout.id);
    setEditWorkoutName(workout.name || formatWorkoutName(new Date(workout.created_at)));
    setEditWorkoutExercises((workout.workout_exercises ?? []).map((exercise) => ({
      id: exercise.id,
      name: exercise.exercise_name,
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
    setEditWorkoutName("");
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
      const nextSet = previous ? { ...previous, set: exercise.setRows.length + 1 } : { set: 1, reps: 0, weight: 0 };
      return { ...exercise, setRows: [...exercise.setRows, nextSet] };
    }));
  }

  function removeEditWorkoutSet(exerciseId: string, setIndex: number) {
    setEditWorkoutExercises((prev) => prev.map((exercise) => exercise.id === exerciseId ? {
      ...exercise,
      setRows: exercise.setRows.filter((_, index) => index !== setIndex).map((set, index) => ({ ...set, set: index + 1 })),
    } : exercise));
  }

  function removeEditWorkoutExercise(exerciseId: string) {
    setEditWorkoutExercises((prev) => prev.filter((exercise) => exercise.id !== exerciseId));
  }

  async function saveEditWorkout(workout: WorkoutWithExercises) {
    const workoutName = editWorkoutName.trim() || formatWorkoutName(new Date(workout.created_at));
    const exerciseUpdates = editWorkoutExercises.map((exercise) => {
      const rows = exercise.setRows
        .map((set, index) => ({ set: index + 1, reps: Number(set.reps), weight: Number(set.weight), notes: set.notes?.trim() || undefined }))
        .filter((set) => Number.isFinite(set.reps) && set.reps > 0 && Number.isFinite(set.weight) && set.weight >= 0);
      return { ...exercise, setRows: rows };
    }).filter((exercise) => exercise.name.trim() && exercise.setRows.length);

    if (!exerciseUpdates.length) return alert("Keep at least one exercise with a valid set.");

    const { error: workoutError } = await supabase.from("workouts").update({ name: workoutName }).eq("id", workout.id).eq("user_key", userKey);
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
      };
      const { error } = await supabase.from("workout_exercises").update(payload).eq("id", exercise.id).eq("user_key", userKey);
      if (error) return alert(error.message);
    }

    cancelEditWorkout();
    await loadData();
    setToast(`${workoutName} updated`);
    setTimeout(() => setToast(""), 2200);
  }

  async function confirmDeleteWorkout() {
    if (!pendingDeleteWorkout) return;
    const workout = pendingDeleteWorkout;
    const name = workout.name || formatWorkoutName(new Date(workout.created_at));

    const { data, error } = await supabase.from("workouts").delete().eq("id", workout.id).eq("user_key", userKey).select("id");
    if (error) return alert(error.message);
    if (!data?.length) return alert("Could not delete workout. Apply the latest Supabase schema so workouts can be deleted.");

    setPendingDeleteWorkout(null);
    if (selectedWorkoutId === workout.id) setSelectedWorkoutId("");
    setRecentWorkouts((current) => current.filter((row) => row.id !== workout.id));
    setHistory((current) => current.filter((row) => row.workout_id !== workout.id));
    await loadRecentWorkouts();
    await loadHistory();
    setToast(`${name} deleted`);
    setTimeout(() => setToast(""), 2200);
  }

  async function saveBodyWeight() {
    const weight = Number(weightValue);
    if (!isSupabaseConfigured) return alert("Add Supabase env vars in .env.local first.");
    if (!userKey || !Number.isFinite(weight) || weight <= 0 || !weightDate) return alert("Add a valid weight and date.");

    const payload = { user_key: userKey, weight, measured_on: weightDate, notes: weightNotes.trim() || null };

    if (editingWeightId.startsWith("offline-")) {
      const items = await offlineDb.queue.where("userKey").equals(userKey).toArray();
      const queued = items.find((item) => item.type === "save_body_weight" && (item.payload as OfflineBodyWeightPayload).measured_on === weightDate);
      if (queued?.id) await offlineDb.queue.update(queued.id, { payload: payload satisfies OfflineBodyWeightPayload });
      setBodyWeights((current) => current.map((row) => row.id === editingWeightId ? { ...row, ...payload } : row));
      setBodyWeightHistory((current) => current.map((row) => row.id === editingWeightId ? { ...row, ...payload } : row).sort((a, b) => a.measured_on.localeCompare(b.measured_on)));
      setEditingWeightId("");
      setWeightValue("");
      setWeightNotes("");
      setWeightDate(todayInputValue());
      setToast("Offline weight updated");
      setTimeout(() => setToast(""), 2200);
      return;
    }

    if (!navigator.onLine && !editingWeightId) {
      await enqueueOffline({ userKey, type: "save_body_weight", payload: payload satisfies OfflineBodyWeightPayload });
      await refreshOfflineCount();
      const offlineRow = { id: `offline-${Date.now()}`, created_at: new Date().toISOString(), ...payload };
      setBodyWeights((current) => [offlineRow, ...current].slice(0, WEIGHT_PAGE_SIZE));
      setBodyWeightHistory((current) => [...current, offlineRow].sort((a, b) => a.measured_on.localeCompare(b.measured_on)));
      setBodyWeightCount((count) => count + 1);
      setWeightValue("");
      setWeightNotes("");
      setWeightDate(todayInputValue());
      setToast("Weight saved offline");
      setTimeout(() => setToast(""), 2200);
      return;
    }

    const { error } = editingWeightId
      ? await supabase.from("body_weights").update(payload).eq("id", editingWeightId).eq("user_key", userKey)
      : await supabase.from("body_weights").upsert(payload, { onConflict: "user_key,measured_on" });

    if (error) return alert(error.message);
    setWeightValue("");
    setWeightNotes("");
    setWeightDate(todayInputValue());
    setEditingWeightId("");
    setWeightPage(0);
    await Promise.all([loadBodyWeights(userKey, 0), loadBodyWeightHistory(userKey)]);
    setToast(editingWeightId ? "Weight updated" : "Weight saved");
    setTimeout(() => setToast(""), 2200);
  }

  function startEditWeight(row: BodyWeight) {
    setEditingWeightId(row.id);
    setWeightValue(String(row.weight));
    setWeightDate(row.measured_on);
    setWeightNotes(row.notes ?? "");
  }

  async function confirmDeleteWeight() {
    if (!pendingDeleteWeight) return;
    if (pendingDeleteWeight.id.startsWith("offline-")) {
      const items = await offlineDb.queue.where("userKey").equals(userKey).toArray();
      const queued = items.find((item) => item.type === "save_body_weight" && (item.payload as OfflineBodyWeightPayload).measured_on === pendingDeleteWeight.measured_on);
      if (queued?.id) await offlineDb.queue.delete(queued.id);
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
    setTimeout(() => setToast(""), 2200);
  }

  async function saveQueuedExercise(exercise: ExerciseDraft) {
    const name = exercise.name.trim();
    const rows = validSetRows(exercise.sets);

    if (!isSupabaseConfigured) return alert("Add Supabase env vars in .env.local first.");
    if (!name || !rows.length || !userKey) return alert("Add at least one valid set first.");

    const payload = {
      exercise_name: name,
      sets: rows.length,
      reps: Math.max(...rows.map((set) => set.reps)),
      weight: Math.max(...rows.map((set) => set.weight)),
      volume: rows.reduce((sum, set) => sum + set.reps * set.weight, 0),
      set_rows: rows,
      notes: exercise.notes?.trim() || null,
      body_weight: currentBodyWeight,
    };

    setSavingExerciseId(exercise.id);

    if (exercise.savedExerciseId?.startsWith("offline-")) {
      const updated = await updateOfflineQueuedExercise(exercise, name, rows);
      setSavingExerciseId("");
      if (updated) {
        setWorkoutQueue((prev) => prev.map((item) => item.id === exercise.id ? { ...item, name, sets: exercise.sets } : item));
        setToast(navigator.onLine ? "Offline change updated and will sync automatically" : `${name} offline change updated`);
      } else {
        setToast(`${name} is already queued for sync`);
      }
      setTimeout(() => setToast(""), 2200);
      return;
    }

    if (!navigator.onLine && !exercise.savedExerciseId) {
      await enqueueOffline({
        userKey,
        type: "save_workout",
        payload: {
          name,
          exercises: [{ name, sets: rows, notes: exercise.notes?.trim() || null, body_weight: currentBodyWeight }],
        } satisfies OfflineWorkoutPayload,
      });
      await refreshOfflineCount();
      setSavingExerciseId("");
      setWorkoutQueue((prev) => prev.map((item) => item.id === exercise.id ? { ...item, savedExerciseId: `offline-${Date.now()}` } : item));
      setToast(`${name} saved offline`);
      setTimeout(() => setToast(""), 2200);
      return;
    }

    if (exercise.savedExerciseId) {
      const { error } = await supabase
        .from("workout_exercises")
        .update(payload)
        .eq("id", exercise.savedExerciseId)
        .eq("user_key", userKey);

      setSavingExerciseId("");
      if (error) return alert(error.message);
      await loadData();
      setToast(`${name} updated`);
      setTimeout(() => setToast(""), 2200);
      return;
    }

    let workoutId = currentWorkoutId;
    if (!workoutId) {
      const { data: workout, error: workoutError } = await supabase
        .from("workouts")
        .insert({ user_key: userKey, name: formatWorkoutName() })
        .select("id")
        .single();

      if (workoutError || !workout) {
        setSavingExerciseId("");
        return alert(workoutError?.message ?? "Could not save");
      }

      workoutId = workout.id;
      setCurrentWorkoutId(workoutId);
    }

    const { data: savedExercise, error } = await supabase
      .from("workout_exercises")
      .insert({ ...payload, workout_id: workoutId, user_key: userKey })
      .select("id")
      .single();

    setSavingExerciseId("");
    if (error || !savedExercise) return alert(error?.message ?? "Could not save");

    setWorkoutQueue((prev) => prev.map((item) => item.id === exercise.id ? { ...item, savedExerciseId: savedExercise.id } : item));
    setSelectedWorkoutId(workoutId);
    await loadData();
    setToast(`${name} saved`);
    setTimeout(() => setToast(""), 2200);
  }

  async function saveExercises(rows: Array<{ name: string; sets: Array<{ set: number; reps: number; weight: number; notes?: string }> }>, title: string) {
    setSaving(true);
    const { data: workout, error: workoutError } = await supabase
      .from("workouts")
      .insert({ user_key: userKey, name: title || formatWorkoutName() })
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

    setSelectedWorkoutId(workout.id);
    await loadData();
    setToast("Saved. Nice work 💪");
    setTimeout(() => setToast(""), 2400);
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

  function addQueuedSet(exerciseId: string) {
    setWorkoutQueue((prev) => prev.map((exercise) => {
      if (exercise.id !== exerciseId) return exercise;
      const previous = exercise.sets.at(-1);
      const nextSet = previous ? { ...previous, id: crypto.randomUUID() } : blankSet();
      return { ...exercise, sets: [...exercise.sets, nextSet] };
    }));
  }

  function reorderQueuedSets(exerciseId: string, fromId: string, toId: string) {
    if (!fromId || !toId || fromId === toId) return;
    setWorkoutQueue((prev) =>
      prev.map((exercise) => {
        if (exercise.id !== exerciseId) return exercise;
        const fromIndex = exercise.sets.findIndex((set) => set.id === fromId);
        const toIndex = exercise.sets.findIndex((set) => set.id === toId);
        if (fromIndex < 0 || toIndex < 0) return exercise;
        const nextSets = [...exercise.sets];
        const [moved] = nextSets.splice(fromIndex, 1);
        nextSets.splice(toIndex, 0, moved);
        return { ...exercise, sets: nextSets };
      }),
    );
  }

  function removeQueuedSet(exerciseId: string, setId: string) {
    setWorkoutQueue((prev) => prev.map((exercise) => exercise.id === exerciseId ? { ...exercise, sets: exercise.sets.filter((set) => set.id !== setId) } : exercise));
  }

  function removeQueuedExercise(exercise: ExerciseDraft) {
    setWorkoutQueue((prev) => prev.filter((item) => item.id !== exercise.id));
    setCollapsedQueueIds((prev) => prev.filter((collapsedId) => collapsedId !== exercise.id));
    setPendingRemoveExercise(null);
  }

  return (
    <main>
      <header className="hero app-hero">
        <div>
          <h1>ProgressFit</h1>
          <p>Track exercises, workouts, and body weight.</p>
        </div>
        <div className="hero-actions">
          <button className="bare-icon-btn hero-auth-btn" aria-label="Refresh" onClick={() => window.location.reload()}><RefreshCw size={20} /></button>
          {authLoading ? null : authUserEmail ? (
            <button className="bare-icon-btn hero-auth-btn" aria-label="Sign out" title={authUserEmail} onClick={signOut}><LogOut size={20} /></button>
          ) : (
            <button className="bare-icon-btn hero-auth-btn" aria-label="Sign in" onClick={() => setAuthModalOpen(true)}><LogIn size={20} /></button>
          )}
        </div>
      </header>

      <nav className="top-nav" aria-label="Main sections" style={{ gridTemplateColumns: "repeat(4, minmax(0, 1fr))", gap: 6 }}>
        <button style={{ display: "flex", alignItems: "center", justifyContent: "center", padding: "12px 6px", whiteSpace: "nowrap" }} className={activeSection === "workouts" ? "active" : ""} onClick={() => setActiveSection("workouts")}>Workouts</button>
        <button style={{ display: "flex", alignItems: "center", justifyContent: "center", padding: "12px 6px", whiteSpace: "nowrap" }} className={activeSection === "exercises" ? "active" : ""} onClick={() => setActiveSection("exercises")}>Exercises</button>
        <button style={{ display: "flex", alignItems: "center", justifyContent: "center", padding: "12px 6px", whiteSpace: "nowrap" }} className={activeSection === "progress" ? "active" : ""} onClick={() => setActiveSection("progress")}>Progress</button>
        <button style={{ display: "flex", alignItems: "center", justifyContent: "center", padding: "12px 6px", whiteSpace: "nowrap" }} className={activeSection === "weight" ? "active" : ""} onClick={() => setActiveSection("weight")}>Weight</button>
      </nav>

      {(!isOnline || offlineQueueCount > 0) && (
        <div className="sync-status">
          <span>{isOnline ? syncingOffline ? "Syncing" : "Online" : "Offline"}</span>
          <span>{offlineQueueCount} pending sync</span>
        </div>
      )}

      {activeSection === "exercises" && <section className="card stack recent-card">
        <div className="section-title">
          <h2><Dumbbell size={18} /> Exercises</h2>
        </div>

        <div className="input-icon-wrap search-combo">
          <Search className="input-icon" size={17} />
          <input
            className="input with-icon with-clear"
            placeholder="Search or enter exercise name"
            value={exerciseName}
            onFocus={() => setIsExerciseSearchFocused(true)}
            onBlur={() => setTimeout(() => setIsExerciseSearchFocused(false), 120)}
            onChange={(event) => {
              setExerciseName(event.target.value);
              setSelectedExerciseMeta(null);
              setIsExerciseSearchFocused(true);
            }}
            onKeyDown={(event) => {
              if (event.key === "Enter") {
                event.preventDefault();
                addToWorkout();
              }
            }}
          />
          {exerciseName && (
            <button className="clear-input" aria-label="Clear exercise search" onClick={() => { setExerciseName(""); setSelectedExerciseMeta(null); }}>
              <X size={16} />
            </button>
          )}
          {isExerciseSearchFocused && exerciseSuggestions.length > 0 && (
            <div className="exercise-suggestions" role="listbox">
              {exerciseSuggestions.map((exercise) => (
                <div
                  className="exercise-suggestion-item"
                  key={`${exercise.source}-${exercise.id}`}
                  role="option"
                  tabIndex={0}
                  onMouseDown={(event) => {
                    event.preventDefault();
                    addToWorkout(exercise.name, exercise);
                    setIsExerciseSearchFocused(false);
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
            </div>
          )}
        </div>

      </section>}

      {activeSection === "exercises" && workoutQueue.length > 0 && (
        <section className="card stack recent-card">
          <div className="section-title">
            <h2><Activity size={18} /> Exercise tracker</h2>
            <div className="row action-row">
              <button className="bare-icon-btn" aria-label="Clear all" onClick={() => setClearDraftModalOpen(true)}><Eraser size={18} /></button>
              <button className="bare-icon-btn" aria-label="Save to workout" disabled={saving || !hasUnsavedWorkoutExercises} onClick={saveWorkoutFromTrackers}><Save size={18} /></button>
            </div>
          </div>
          <div className="workout-list">
            {workoutQueue.map((exercise) => {
              const rows = validSetRows(exercise.sets);
              const volume = rows.reduce((sum, set) => sum + set.reps * set.weight, 0);
              const isCollapsed = collapsedQueueIds.includes(exercise.id);
              const meta = [exercise.category, exercise.muscles?.[0], exercise.equipment?.[0]].filter(Boolean).join(" • ");
              const exerciseHistory = history.filter((record) => normalise(record.exercise_name) === normalise(exercise.name)).slice(0, 3);
              const isHistoryOpen = expandedHistoryExerciseIds.includes(exercise.id);
              return (
                <div className="workout-exercise-section" key={exercise.id}>
                  <div className="workout-exercise-header">
                    <button
                      className="workout-exercise-toggle"
                      onClick={() => setCollapsedQueueIds((prev) => prev.includes(exercise.id) ? prev.filter((id) => id !== exercise.id) : [...prev, exercise.id])}
                    >
                      <ChevronDown className={isCollapsed ? "chevron" : "chevron open"} size={18} />
                      <span className="exercise-suggestion-icon">
                        {exercise.image_url ? <img src={exercise.image_url} alt="" /> : <Dumbbell size={17} />}
                      </span>
                      <span className="workout-exercise-title">
                        <strong>{exercise.name}</strong>
                        <small>{meta || `${rows.length} ${rows.length === 1 ? "set" : "sets"} • ${volume} lbs volume`}</small>
                      </span>
                    </button>
                    <button className="btn danger icon-btn" aria-label={`Remove ${exercise.name}`} onClick={() => setPendingRemoveExercise(exercise)}><Trash2 size={16} /></button>
                  </div>
                  {!isCollapsed && (
                    <div className="workout-exercise-body">
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
                            return (
                              <div className="record-detail-panel recent-record-panel" key={record.id}>
                                <button className="record-summary-toggle" onClick={() => setExpandedRecentRecordId(isExpanded ? "" : record.id)}>
                                  <ChevronDown className={isExpanded ? "chevron open" : "chevron"} size={18} />
                                  <span>{new Date(record.created_at).toLocaleDateString(undefined, { month: "short", day: "numeric", year: "numeric" })}</span>
                                  <span>{record.sets} {record.sets === 1 ? "set" : "sets"} • best {record.weight} lbs × {record.reps}</span>
                                </button>
                                {isExpanded && (
                                  <>
                                    <div className="record-detail-meta">
                                      <span>{record.volume} lbs volume</span>
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
                        <div className="set-grid queued-set-grid table-head" style={{ gridTemplateColumns: "24px 32px minmax(76px,1fr) minmax(76px,1fr) minmax(58px,.65fr) minmax(82px,.8fr) 28px", gap: 6, minWidth: 430 }} aria-hidden="true">
                          <span></span>
                          <span>Set</span>
                          <span>Weight</span>
                          <span>Reps</span>
                          <span>Last best</span>
                          <span>Notes</span>
                          <span></span>
                        </div>
                        {exercise.sets.map((set, index) => (
                          <div
                            className={`set-grid queued-set-grid draggable-row ${dragOverSetId === set.id ? "drag-over" : ""}`}
                            style={{ gridTemplateColumns: "24px 32px minmax(76px,1fr) minmax(76px,1fr) minmax(58px,.65fr) minmax(82px,.8fr) 28px", gap: 6, minWidth: 430 }}
                            key={set.id}
                            onDragOver={(event) => {
                              event.preventDefault();
                              setDragOverSetId(set.id);
                            }}
                            onDragLeave={() => setDragOverSetId("")}
                            onDrop={(event) => {
                              event.preventDefault();
                              reorderQueuedSets(exercise.id, draggingSetId, set.id);
                              setDraggingSetId("");
                              setDragOverSetId("");
                            }}
                          >
                            <button
                              className="drag-handle"
                              style={{ width: 22, minWidth: 22, height: 30, border: 0, background: "transparent" }}
                              draggable
                              aria-label={`Drag ${exercise.name} set ${index + 1} to reorder`}
                              onDragStart={(event) => {
                                setDraggingSetId(set.id);
                                event.dataTransfer.effectAllowed = "move";
                                event.dataTransfer.setData("text/plain", set.id);
                              }}
                              onDragEnd={() => {
                                setDraggingSetId("");
                                setDragOverSetId("");
                              }}
                            >
                              <GripVertical size={14} />
                            </button>
                            <span className="set-number">{index + 1}</span>
                            <input className="input" inputMode="decimal" aria-label={`${exercise.name} set ${index + 1} weight in lbs`} placeholder="lbs" value={set.weight} onChange={(event) => updateQueuedSet(exercise.id, set.id, { weight: event.target.value.replace(/[^0-9.]/g, "") })} />
                            <input className="input" inputMode="numeric" aria-label={`${exercise.name} set ${index + 1} reps`} placeholder="Reps" value={set.reps} onChange={(event) => updateQueuedSet(exercise.id, set.id, { reps: event.target.value.replace(/\D/g, "") })} />
                            <span className="last-best">{lastBestForSet(exercise.name, index + 1)}</span>
                            <input className="input set-notes-input" aria-label={`${exercise.name} set ${index + 1} notes`} placeholder="Notes" value={set.notes ?? ""} onChange={(event) => updateQueuedSet(exercise.id, set.id, { notes: event.target.value })} />
                            <button className="bare-icon-btn" style={{ width: 24, minWidth: 24 }} aria-label={`Remove ${exercise.name} set ${index + 1}`} onClick={() => removeQueuedSet(exercise.id, set.id)}><X size={14} /></button>
                          </div>
                        ))}
                      </div>
                      <div className="row tracker-footer-row">
                        <button className="bare-icon-btn" aria-label={`Add set to ${exercise.name}`} onClick={() => addQueuedSet(exercise.id)}><Plus size={16} /></button>
                        <button className="bare-icon-btn" aria-label={exercise.savedExerciseId?.startsWith("offline-") ? `${exercise.name} queued for sync` : exercise.savedExerciseId ? `Update ${exercise.name}` : `Save ${exercise.name}`} disabled={savingExerciseId === exercise.id || !rows.length} onClick={() => saveQueuedExercise(exercise)}><Check size={16} /></button>
                      </div>
                      <p className="muted">{rows.length} valid {rows.length === 1 ? "set" : "sets"} • {volume} lbs volume</p>
                    </div>
                  )}
                </div>
              );
            })}
          </div>
        </section>
      )}

      {activeSection === "workouts" && (
        <section className="card stack recent-card">
          <div className="section-title">
            <h2><Activity size={18} /> Workouts</h2>
          </div>

          <div className="workout-filters">
            <div className="input-icon-wrap workout-search-field">
              <Search className="input-icon" size={17} />
              <input className="input with-icon" style={{ paddingRight: 82 }} placeholder="Search workouts or exercises" value={workoutSearch} onChange={(event) => { setWorkoutSearch(event.target.value); setWorkoutPage(0); }} />
              <div style={{ position: "absolute", right: 42, top: "50%", transform: "translateY(-50%)" }}>
                <DateRangePickerField
                  compact
                  from={workoutDateFrom}
                  to={workoutDateTo}
                  onChange={(range) => {
                    setWorkoutDateFrom(range.from);
                    setWorkoutDateTo(range.to);
                    setWorkoutPage(0);
                  }}
                />
              </div>
              <div style={{ position: "absolute", right: 8, top: "50%", transform: "translateY(-50%)" }}>
                <button
                  className="bare-icon-btn"
                  aria-label="Filter workout type"
                  aria-expanded={workoutTypeFilterOpen}
                  onClick={() => setWorkoutTypeFilterOpen((open) => !open)}
                  title={`Type: ${workoutTypeFilter[0].toUpperCase() + workoutTypeFilter.slice(1)}`}
                >
                  <SlidersHorizontal size={18} />
                </button>
                {workoutTypeFilterOpen && (
                  <div
                    role="menu"
                    aria-label="Workout type options"
                    style={{
                      position: "absolute",
                      right: 0,
                      top: "calc(100% + 8px)",
                      zIndex: 4,
                      display: "grid",
                      minWidth: 148,
                      overflow: "hidden",
                      border: "1px solid var(--line)",
                      borderRadius: 14,
                      background: "#fff",
                      boxShadow: "0 14px 34px rgba(43,43,43,.12)",
                    }}
                  >
                    {(["all", "workout", "exercise"] as const).map((type) => (
                      <button
                        key={type}
                        role="menuitemradio"
                        aria-checked={workoutTypeFilter === type}
                        onClick={() => {
                          setWorkoutTypeFilter(type);
                          setWorkoutPage(0);
                          setWorkoutTypeFilterOpen(false);
                        }}
                        style={{
                          display: "flex",
                          alignItems: "center",
                          justifyContent: "space-between",
                          gap: 12,
                          padding: "11px 12px",
                          background: workoutTypeFilter === type ? "#f5f5f5" : "#fff",
                          color: "var(--text)",
                          textAlign: "left",
                        }}
                      >
                        <span>{type[0].toUpperCase() + type.slice(1)}</span>
                        {workoutTypeFilter === type && <Check size={15} />}
                      </button>
                    ))}
                  </div>
                )}
              </div>
            </div>
          </div>

          {workoutRows.length ? (
            <>
              <div className="table-wrap">
                <table className="records-table">
                  <colgroup>
                    <col style={{ width: 42 }} />
                    <col style={{ width: 118 }} />
                    <col style={{ width: 84 }} />
                    <col />
                    <col style={{ width: 82 }} />
                    <col style={{ width: 96 }} />
                    <col style={{ width: 76 }} />
                  </colgroup>
                  <thead>
                    <tr>
                      <th></th>
                      <th>Date</th>
                      <th>Type</th>
                      <th>Workout</th>
                      <th>Exercises</th>
                      <th>Volume</th>
                      <th></th>
                    </tr>
                  </thead>
                  <tbody>
                    {workoutRows.map((workout) => {
                      const isExpanded = selectedWorkoutId === workout.id;
                      const isEditingWorkout = editingWorkoutId === workout.id;
                      const exercises = workout.workout_exercises ?? [];
                      const workoutType = exercises.length > 1 ? "Workout" : "Exercise";
                      const volume = exercises.reduce((sum, exercise) => sum + Number(exercise.volume || 0), 0);
                      return (
                        <Fragment key={workout.id}>
                          <tr className="clickable-table-row" onClick={() => setSelectedWorkoutId(isExpanded ? "" : workout.id)}>
                            <td>
                              <button className="table-toggle" aria-label={isExpanded ? "Collapse workout" : "Expand workout"}>
                                <ChevronDown className={isExpanded ? "chevron open" : "chevron"} size={16} />
                              </button>
                            </td>
                            <td>{new Date(workout.created_at).toLocaleDateString(undefined, { month: "short", day: "numeric", year: "numeric" })}</td>
                            <td>{workoutType}</td>
                            <td>{workout.name || formatWorkoutName(new Date(workout.created_at))}</td>
                            <td>{exercises.length}</td>
                            <td>{volume} lbs</td>
                            <td>
                              <div className="record-actions">
                                <button
                                  className="table-toggle"
                                  aria-label={`Edit ${workout.name || "workout"}`}
                                  onClick={(event) => {
                                    event.stopPropagation();
                                    setSelectedWorkoutId(workout.id);
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
                                    <div className="row action-row">
                                      <input className="detail-input" value={editWorkoutName} onChange={(event) => setEditWorkoutName(event.target.value)} aria-label="Workout name" />
                                      <button className="bare-icon-btn" aria-label="Cancel editing workout" onClick={cancelEditWorkout}><X size={17} /></button>
                                      <button className="bare-icon-btn" aria-label="Save workout changes" onClick={() => saveEditWorkout(workout)}><Check size={17} /></button>
                                    </div>
                                  )}
                                  {exercises.length ? (
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
                                      {exercises.filter((exercise) => !isEditingWorkout || editWorkoutExercises.some((item) => item.id === exercise.id)).map((exercise) => {
                                        const editExercise = editWorkoutExercises.find((item) => item.id === exercise.id);
                                        const setRows = exercise.set_rows?.length ? exercise.set_rows : [{ set: 1, reps: exercise.reps, weight: exercise.weight }];
                                        const displayRows = isEditingWorkout && editExercise ? editExercise.setRows : setRows;
                                        const isExerciseExpanded = expandedWorkoutExerciseIds.includes(exercise.id) || isEditingWorkout;
                                        const summaryRows = displayRows.filter((set) => Number(set.reps) > 0 && Number(set.weight) >= 0);
                                        const bestRow = summaryRows.reduce<WorkoutSetRow | null>((best, set) => !best || Number(set.weight) > Number(best.weight) ? set : best, null);
                                        return (
                                           <div
                                             className="record-detail-panel recent-record-panel"
                                             key={exercise.id}
                                             style={{ border: "1px solid var(--line)", borderRadius: 14, padding: 14 }}
                                           >
                                            <div style={{ display: "grid", gridTemplateColumns: isEditingWorkout ? "1fr auto" : "1fr", gap: 8, alignItems: "center" }}>
                                              <button
                                                className="record-summary-toggle"
                                                onClick={() => !isEditingWorkout && setExpandedWorkoutExerciseIds((prev) => prev.includes(exercise.id) ? prev.filter((id) => id !== exercise.id) : [...prev, exercise.id])}
                                              >
                                                <ChevronDown className={isExerciseExpanded ? "chevron open" : "chevron"} size={18} />
                                                <span>{isEditingWorkout && editExercise ? <input className="detail-input" value={editExercise.name} onChange={(event) => updateEditWorkoutExercise(exercise.id, { name: event.target.value })} /> : exercise.exercise_name}</span>
                                                <span>{displayRows.length} {displayRows.length === 1 ? "set" : "sets"}{bestRow ? ` • best ${bestRow.weight} lbs × ${bestRow.reps}` : ""}</span>
                                              </button>
                                              {isEditingWorkout && <button className="bare-icon-btn" aria-label={`Delete ${exercise.exercise_name}`} onClick={() => removeEditWorkoutExercise(exercise.id)}><Trash2 size={15} /></button>}
                                            </div>
                                            {isExerciseExpanded && (
                                              <>
                                                <div className="record-detail-meta">
                                                  <span>{exercise.volume} lbs volume</span>
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
                                                          <button className="bare-icon-btn" aria-label={`Delete ${exercise.exercise_name} set ${index + 1}`} onClick={() => removeEditWorkoutSet(exercise.id, index)}><X size={14} /></button>
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
                                                {isEditingWorkout && <button className="bare-icon-btn" aria-label={`Add set to ${exercise.exercise_name}`} onClick={() => addEditWorkoutSet(exercise.id)}><Plus size={16} /></button>}
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
              {workoutTotalPages > 1 && (
                <div className="pagination">
                  <button className="btn secondary icon-btn" aria-label="Previous workout page" disabled={safeWorkoutPage === 0} onClick={() => setWorkoutPage((current) => Math.max(0, current - 1))}><ChevronLeft size={17} /></button>
                  <span className="muted">Page {safeWorkoutPage + 1} of {workoutTotalPages}</span>
                  <button className="btn secondary icon-btn" aria-label="Next workout page" disabled={safeWorkoutPage >= workoutTotalPages - 1} onClick={() => setWorkoutPage((current) => Math.min(workoutTotalPages - 1, current + 1))}><ChevronRight size={17} /></button>
                </div>
              )}
            </>
          ) : <div className="empty">No workouts found.</div>}
        </section>
      )}

      {activeSection === "progress" && (
        <section className="card stack recent-card">
          <div className="section-title">
            <h2><TrendingUp size={18} /> Progress</h2>
          </div>
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
            {isProgressSearchFocused && progressSuggestions.length > 0 && (
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
              </div>
            )}
          </div>
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
        </section>
      )}

      {activeSection === "weight" && (
        <section className="card stack recent-card">
          <div className="section-title">
            <h2><Weight size={18} /> Weight</h2>
          </div>
          <div className="date-filters">
            <DatePickerField label="Weight date" value={weightDate} onChange={setWeightDate} />
            <input className="input" inputMode="decimal" placeholder="Weight (lbs)" value={weightValue} onChange={(event) => setWeightValue(event.target.value.replace(/[^0-9.]/g, ""))} />
          </div>
          <input className="input" placeholder="Notes (optional)" value={weightNotes} onChange={(event) => setWeightNotes(event.target.value)} />
          <button className="btn" onClick={saveBodyWeight}><Save size={18} /> {editingWeightId ? "Update weight" : "Save weight"}</button>

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
                <div className="pagination">
                  <button className="btn secondary icon-btn" aria-label="Previous weight page" disabled={safeWeightPage === 0} onClick={() => setWeightPage((current) => { const next = Math.max(0, current - 1); loadBodyWeights(userKey, next); return next; })}>‹</button>
                  <span className="muted">Page {safeWeightPage + 1} of {weightTotalPages}</span>
                  <button className="btn secondary icon-btn" aria-label="Next weight page" disabled={safeWeightPage >= weightTotalPages - 1} onClick={() => setWeightPage((current) => { const next = Math.min(weightTotalPages - 1, current + 1); loadBodyWeights(userKey, next); return next; })}>›</button>
                </div>
              )}
            </>
          ) : <div className="empty">No weight records found.</div>}
        </section>
      )}

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

      <Dialog.Root open={workoutNameModalOpen} onOpenChange={setWorkoutNameModalOpen}>
        <Dialog.Portal>
          <Dialog.Overlay className="dialog-overlay" />
          <Dialog.Content className="dialog-content">
            <Dialog.Title className="dialog-title">Save workout</Dialog.Title>
            <Dialog.Description className="dialog-description">Name this workout, or leave the default.</Dialog.Description>
            <input className="input" value={workoutNameInput} onChange={(event) => setWorkoutNameInput(event.target.value)} placeholder={formatWorkoutName()} />
            <div className="dialog-actions">
              <Dialog.Close asChild><button className="btn secondary">Cancel</button></Dialog.Close>
              <button className="btn" disabled={saving} onClick={confirmSaveWorkout}>{saving ? "Saving..." : "Save workout"}</button>
            </div>
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
