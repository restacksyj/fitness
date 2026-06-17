export type SetRow = { id: string; reps: string; weight: string; notes?: string };
export type ExerciseDraft = {
  id: string;
  name: string;
  sets: SetRow[];
  image_url?: string | null;
  category?: string | null;
  muscles?: string[];
  equipment?: string[];
  notes?: string;
  savedExerciseId?: string;
};
export type WorkoutDraft = { workoutName: string; workoutId?: string; exercises: ExerciseDraft[] };

const DRAFT_KEY = "progressfit-workout-draft";

export function blankSet(): SetRow {
  return { id: crypto.randomUUID(), reps: "", weight: "" };
}

export function blankExercise(name = ""): ExerciseDraft {
  return { id: crypto.randomUUID(), name, sets: [blankSet(), blankSet(), blankSet()] };
}

export function loadWorkoutDraft(): WorkoutDraft | null {
  if (typeof window === "undefined") return null;
  const raw = localStorage.getItem(DRAFT_KEY);
  if (!raw) return null;

  try {
    const parsed = JSON.parse(raw) as WorkoutDraft;
    if (!Array.isArray(parsed.exercises)) return null;
    return {
      workoutName: typeof parsed.workoutName === "string" ? parsed.workoutName : "",
      workoutId: typeof parsed.workoutId === "string" ? parsed.workoutId : undefined,
      exercises: parsed.exercises.length ? parsed.exercises : [blankExercise()],
    };
  } catch {
    return null;
  }
}

export function saveWorkoutDraft(draft: WorkoutDraft) {
  if (typeof window === "undefined") return;
  localStorage.setItem(DRAFT_KEY, JSON.stringify(draft));
}

export function appendExerciseToDraft(name: string) {
  const current = loadWorkoutDraft() ?? { workoutName: "", exercises: [blankExercise()] };
  saveWorkoutDraft({ ...current, exercises: [...current.exercises, blankExercise(name)] });
}
