import { createClient } from "@supabase/supabase-js";

type WgerPage<T> = {
  next: string | null;
  results: T[];
};

type WgerNamed = { id?: number; name?: string };

type WgerTranslation = {
  name?: string;
  description?: string;
  description_source?: string;
  language?: number;
};

type WgerExerciseInfo = {
  id: number;
  uuid?: string;
  category?: WgerNamed;
  muscles?: WgerNamed[];
  muscles_secondary?: WgerNamed[];
  equipment?: WgerNamed[];
  images?: Array<{ image?: string; is_main?: boolean }>;
  translations?: WgerTranslation[];
};

const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL;
const supabaseKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
const language = process.env.WGER_LANGUAGE_ID || "2"; // 2 = English
const pageLimit = process.env.WGER_PAGE_LIMIT || "100";

if (!supabaseUrl || !supabaseKey) {
  throw new Error("Missing NEXT_PUBLIC_SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY env vars. The wger import needs a server-only service role key so it can insert into exercise_catalog with RLS enabled.");
}

const supabase = createClient(supabaseUrl, supabaseKey, {
  auth: { persistSession: false },
});

function stripHtml(value = "") {
  return value.replace(/<[^>]*>/g, " ").replace(/\s+/g, " ").trim();
}

function names(values?: WgerNamed[]) {
  return (values || []).map((value) => value.name).filter(Boolean) as string[];
}

function mainImage(images?: WgerExerciseInfo["images"]) {
  return images?.find((image) => image.is_main)?.image || images?.[0]?.image || null;
}

function translationFor(exercise: WgerExerciseInfo) {
  return (
    exercise.translations?.find((translation) => translation.language === Number(language)) ||
    exercise.translations?.find((translation) => translation.name?.trim())
  );
}

async function fetchJson<T>(url: string): Promise<T> {
  const response = await fetch(url, { headers: { Accept: "application/json" } });
  if (!response.ok) throw new Error(`wger request failed ${response.status}: ${url}`);
  return response.json() as Promise<T>;
}

async function importExercises() {
  let url: string | null = `https://wger.de/api/v2/exerciseinfo/?language=${language}&limit=${pageLimit}`;
  let total = 0;

  while (url) {
    const page: WgerPage<WgerExerciseInfo> = await fetchJson<WgerPage<WgerExerciseInfo>>(url);
    const rows = page.results
      .map((exercise: WgerExerciseInfo) => ({ exercise, translation: translationFor(exercise) }))
      .filter(({ translation }) => translation?.name?.trim())
      .map(({ exercise, translation }) => ({
        wger_id: exercise.id,
        wger_uuid: exercise.uuid || null,
        name: translation!.name!.trim(),
        description: stripHtml(translation!.description || translation!.description_source),
        category: exercise.category?.name || null,
        muscles: names(exercise.muscles),
        muscles_secondary: names(exercise.muscles_secondary),
        equipment: names(exercise.equipment),
        image_url: mainImage(exercise.images),
        language_id: Number(language),
        source_payload: exercise,
        updated_at: new Date().toISOString(),
      }));

    if (rows.length) {
      const { error } = await supabase.from("exercise_catalog").upsert(rows, { onConflict: "wger_id" });
      if (error) throw error;
      total += rows.length;
      console.log(`Imported ${total} exercises...`);
    }

    url = page.next;
  }

  console.log(`Done. Imported/updated ${total} wger exercises.`);
}

importExercises().catch((error) => {
  console.error(error);
  process.exit(1);
});
