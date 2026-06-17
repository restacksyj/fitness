import { createClient } from "@supabase/supabase-js";

const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL;
const supabasePublishableKey = process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY;

export const isSupabaseConfigured = Boolean(supabaseUrl && supabasePublishableKey);

export const supabase = createClient(
  supabaseUrl || "https://example.supabase.co",
  supabasePublishableKey || "missing-publishable-key",
);

export type Workout = {
  id: string;
  user_key: string;
  name: string | null;
  notes: string | null;
  created_at: string;
};

export type WorkoutSetRow = {
  set: number;
  reps: number;
  weight: number;
  notes?: string;
};

export type WorkoutExercise = {
  id: string;
  workout_id: string;
  user_key: string;
  exercise_name: string;
  sets: number;
  reps: number;
  weight: number;
  volume: number;
  set_rows: WorkoutSetRow[] | null;
  notes: string | null;
  body_weight: number | null;
  created_at: string;
};

export type ExerciseCatalogItem = {
  id: string;
  wger_id: number;
  wger_uuid: string | null;
  name: string;
  description: string;
  category: string | null;
  muscles: string[];
  muscles_secondary: string[];
  equipment: string[];
  image_url: string | null;
  language_id: number;
  created_at: string;
  updated_at: string;
};

export type BodyWeight = {
  id: string;
  user_key: string;
  weight: number;
  measured_on: string;
  notes: string | null;
  created_at: string;
};
