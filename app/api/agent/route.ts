import { createClient } from "@supabase/supabase-js";
import { NextResponse } from "next/server";
import { Pool } from "pg";

type AgentMessage = { role: "user" | "assistant"; content: string };
type SqlPlan = { sql: string; reasoning?: string };
type AgentTable = { title: string; columns: string[]; rows: string[][] };
type AgentContext = {
  exerciseNames?: string[];
  muscleGroup?: string;
  dateRange?: { label: string; start?: string; end?: string };
  resultMode?: "summary" | "exercise-list" | "set-detail" | "best-set" | "workout-detail";
  lastColumns?: string[];
  lastRowCount?: number;
};
type AgentAnswer = { answer: string; breakdown?: Array<{ label: string; value: number; unit: string }>; tables?: AgentTable[]; context?: AgentContext };

const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL;
const supabaseKey = process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY;
const groqKey = process.env.GROQ_API_KEY || process.env.GROQ_AI_KEY;
const databaseUrl = process.env.READONLY_DATABASE_URL || process.env.DATABASE_URL || process.env.POSTGRES_URL;
const groqModel = process.env.GROQ_MODEL || "llama-3.1-8b-instant";

const sqlPool = databaseUrl
  ? new Pool({ connectionString: databaseUrl, ssl: databaseUrl.includes("supabase") ? { rejectUnauthorized: false } : undefined, max: 2 })
  : null;

function sanitiseMessages(value: unknown): AgentMessage[] {
  if (!Array.isArray(value)) return [];
  return value
    .filter((message): message is AgentMessage => message && typeof message === "object" && ((message as AgentMessage).role === "user" || (message as AgentMessage).role === "assistant") && typeof (message as AgentMessage).content === "string")
    .slice(-10)
    .map((message) => ({ role: message.role, content: message.content.slice(0, 1600) }));
}

function sanitiseContext(value: unknown): AgentContext | undefined {
  if (!value || typeof value !== "object") return undefined;
  const context = value as AgentContext;
  return {
    exerciseNames: Array.isArray(context.exerciseNames) ? context.exerciseNames.filter((name) => typeof name === "string" && name.trim()).slice(0, 20) : undefined,
    muscleGroup: typeof context.muscleGroup === "string" ? context.muscleGroup.slice(0, 80) : undefined,
    dateRange: context.dateRange && typeof context.dateRange === "object" ? {
      label: typeof context.dateRange.label === "string" ? context.dateRange.label.slice(0, 80) : "previous range",
      start: typeof context.dateRange.start === "string" ? context.dateRange.start.slice(0, 32) : undefined,
      end: typeof context.dateRange.end === "string" ? context.dateRange.end.slice(0, 32) : undefined,
    } : undefined,
    resultMode: ["summary", "exercise-list", "set-detail", "best-set", "workout-detail"].includes(String(context.resultMode)) ? context.resultMode : undefined,
    lastColumns: Array.isArray(context.lastColumns) ? context.lastColumns.filter((column) => typeof column === "string").slice(0, 30) : undefined,
    lastRowCount: typeof context.lastRowCount === "number" ? context.lastRowCount : undefined,
  };
}

function parseJson<T>(text: string): T {
  const fenced = text.match(/```json\s*([\s\S]*?)```/) ?? text.match(/```\s*([\s\S]*?)```/);
  return JSON.parse(fenced?.[1] ?? text) as T;
}

function buildSetTables(rows: Record<string, unknown>[]): AgentTable[] {
  const setRows = rows.filter((row) => "exercise_name" in row && "reps" in row && "weight" in row && ("set_number" in row || "set" in row));
  if (!setRows.length) return [];

  const tables = new Map<string, AgentTable>();
  for (const row of setRows) {
    const exerciseName = String(row.exercise_name ?? "Exercise");
    const date = typeof row.created_at === "string" ? row.created_at.slice(0, 10) : "";
    const title = [date, exerciseName].filter(Boolean).join(" - ");
    const table = tables.get(title) ?? { title, columns: ["Set", "Reps", "Weight", "Notes"], rows: [] };
    table.rows.push([
      String(row.set_number ?? row.set ?? ""),
      String(row.reps ?? ""),
      row.weight === undefined || row.weight === null ? "" : `${row.weight} lb`,
      String(row.notes ?? ""),
    ]);
    tables.set(title, table);
  }

  return Array.from(tables.values()).slice(0, 12).map((table) => ({ ...table, rows: table.rows.slice(0, 20) }));
}

function wantsSetDetails(question: string) {
  return /\b(details?|each set|all sets|set by set|reps? and weight|sets? reps? weight|breakdown)\b/i.test(question);
}

function wantsProgressionAdvice(question: string) {
  return /\b(how can i improve|improve|progress|progression|what should i increase|to what|how much weight|how many reps)\b/i.test(question);
}

function wantsArmSetsSummary(question: string) {
  return /\barm(s)?\b/i.test(question) && /\bsets?\b/i.test(question) && /\blast month\b/i.test(question);
}

function databaseConnectionMessage(error: unknown) {
  if (!error || typeof error !== "object") return null;
  const code = "code" in error ? String((error as { code?: unknown }).code) : "";
  const message = error instanceof Error ? error.message : "";
  if (code === "ENOTFOUND" || message.includes("getaddrinfo ENOTFOUND")) {
    return "The SQL agent cannot reach the production database host. In Vercel, set READONLY_DATABASE_URL to Supabase's pooler connection string, not the direct db.<project>.supabase.co host.";
  }
  return null;
}

function inferDateRange(question: string): AgentContext["dateRange"] | undefined {
  const lower = question.toLowerCase();
  const now = new Date();
  const today = new Date(Date.UTC(now.getFullYear(), now.getMonth(), now.getDate()));
  const iso = (date: Date) => date.toISOString().slice(0, 10);
  if (lower.includes("last week")) {
    const start = new Date(today);
    start.setUTCDate(start.getUTCDate() - 7);
    const end = new Date(today);
    end.setUTCDate(end.getUTCDate() + 1);
    return { label: "last week", start: iso(start), end: iso(end) };
  }
  if (lower.includes("this week")) {
    const start = new Date(today);
    start.setUTCDate(start.getUTCDate() - start.getUTCDay());
    const end = new Date(today);
    end.setUTCDate(end.getUTCDate() + 1);
    return { label: "this week", start: iso(start), end: iso(end) };
  }
  if (lower.includes("today")) {
    const end = new Date(today);
    end.setUTCDate(end.getUTCDate() + 1);
    return { label: "today", start: iso(today), end: iso(end) };
  }
  return undefined;
}

function previousMonthRange(): NonNullable<AgentContext["dateRange"]> {
  const now = new Date();
  const start = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - 1, 1));
  const end = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));
  return { label: "last month", start: start.toISOString().slice(0, 10), end: end.toISOString().slice(0, 10) };
}

function inferContext(question: string, rows: Record<string, unknown>[], mode: AgentContext["resultMode"]): AgentContext {
  const exerciseNames = Array.from(new Set(rows.map((row) => typeof row.exercise_name === "string" ? row.exercise_name : "").filter(Boolean))).slice(0, 20);
  const columns = rows[0] ? Object.keys(rows[0]) : [];
  const lower = question.toLowerCase();
  const muscleGroup = ["triceps", "tricep", "biceps", "shoulders", "shoulder", "chest", "back", "legs", "arms", "core"].find((group) => lower.includes(group));
  return {
    exerciseNames: exerciseNames.length ? exerciseNames : undefined,
    muscleGroup,
    dateRange: inferDateRange(question),
    resultMode: mode,
    lastColumns: columns,
    lastRowCount: rows.length,
  };
}

function mergeContext(previous: AgentContext | undefined, next: AgentContext): AgentContext {
  return {
    exerciseNames: next.exerciseNames ?? previous?.exerciseNames,
    muscleGroup: next.muscleGroup ?? previous?.muscleGroup,
    dateRange: next.dateRange ?? previous?.dateRange,
    resultMode: next.resultMode ?? previous?.resultMode,
    lastColumns: next.lastColumns ?? previous?.lastColumns,
    lastRowCount: next.lastRowCount ?? previous?.lastRowCount,
  };
}

async function generateGroqJson(prompt: string, temperature: number) {
  if (!groqKey) return null;

  const response = await fetch("https://api.groq.com/openai/v1/chat/completions", {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${groqKey}` },
    body: JSON.stringify({
      model: groqModel,
      messages: [{ role: "user", content: prompt }],
      temperature,
      max_tokens: 900,
      response_format: { type: "json_object" },
    }),
  });

  if (!response.ok) {
    console.error("Groq request failed", `${response.status} ${await response.text().catch(() => "")}`);
    return null;
  }

  const body = await response.json() as { choices?: Array<{ message?: { content?: string } }> };
  return body.choices?.[0]?.message?.content ?? null;
}

function validateSql(sql: string, question?: string) {
  const trimmed = sql.trim();
  const lower = trimmed.toLowerCase();
  const questionLower = question?.toLowerCase() ?? "";
  const forbidden = /\b(insert|update|delete|drop|alter|create|truncate|grant|revoke|copy|call|execute|merge|vacuum|analyze|refresh|listen|notify)\b/;

  if (!trimmed) return "SQL was empty.";
  if (!/^(select|with)\b/i.test(trimmed)) return "Only SELECT queries are allowed.";
  if (trimmed.includes(";") || trimmed.includes("--") || trimmed.includes("/*") || trimmed.includes("*/")) return "SQL comments and multiple statements are not allowed.";
  if (forbidden.test(lower)) return "Only read-only SQL is allowed.";
  if (/\blower\s*\(\s*muscle\s*\)/i.test(trimmed)) return "Do not reference a bare muscle column; unnest exercise_catalog muscle arrays with an alias.";
  if (/\bec\./i.test(trimmed) && !/\bjoin\s+exercise_catalog\s+ec\b/i.test(trimmed)) return "References to ec require JOIN exercise_catalog ec in the same query scope.";
  if (/\b(all|performed|details?)\b/i.test(questionLower) && /\blimit\s+1\b/i.test(trimmed)) return "Do not use LIMIT 1 for all/performed/detail requests; return all matching rows up to LIMIT 100.";
  if (!lower.includes("$1")) return "SQL must bind the authenticated user id as $1.";
  if (/\b(auth|storage|vault|extensions|graphql|realtime|pg_catalog|information_schema)\./i.test(trimmed)) return "That schema is not allowed.";
  if (/\bpg_/i.test(trimmed)) return "Postgres system functions are not allowed.";
  if (!/\b(workouts|workout_exercises|exercise_catalog|custom_exercises|body_weights)\b/i.test(trimmed)) return "Query must use allowed analytics tables.";
  return null;
}

function schemaPrompt() {
  return `Allowed Supabase Postgres schema. Only these tables and columns exist; do not invent columns.

public.workouts:
- id uuid primary key: workout id
- user_key text: authenticated user's id as text; always filter workouts.user_key = $1
- name text: workout name
- notes text nullable: workout notes
- created_at timestamptz: when the workout was created/logged

public.workout_exercises:
- id uuid primary key: workout exercise row id
- workout_id uuid: references workouts.id
- user_key text: authenticated user's id as text; always filter workout_exercises.user_key = $1
- exercise_name text: user-entered exercise name, e.g. Standing Shoulder Press
- sets int: total number of sets recorded on this row
- reps int: aggregate/default reps value for this row
- weight numeric: aggregate/default weight in pounds for this row
- volume numeric: total volume in pounds for this row
- set_rows jsonb nullable: array of set objects like [{"set":1,"reps":10,"weight":25,"notes":""}]
- notes text nullable: exercise notes
- body_weight numeric nullable: body weight in pounds at workout time
- created_at timestamptz: when this exercise row was created/logged

public.exercise_catalog:
- id uuid primary key: catalog exercise id
- wger_id int: external wger id
- wger_uuid uuid nullable: external wger uuid
- name text: catalog exercise name
- description text: catalog description
- category text nullable: catalog category
- muscles text[]: primary muscles as text array
- muscles_secondary text[]: secondary muscles as text array
- equipment text[]: equipment as text array
- image_url text nullable: exercise image URL
- language_id int: catalog language id
- source_payload jsonb nullable: raw import payload
- created_at timestamptz: catalog insert time
- updated_at timestamptz: catalog update time

public.custom_exercises:
- id uuid primary key: custom exercise id
- user_key text: authenticated user's id as text; always filter custom_exercises.user_key = $1
- name text: custom exercise name entered by the user
- category text nullable: user-entered category
- muscles text[]: primary muscles as text array
- muscles_secondary text[]: secondary muscles as text array
- equipment text[]: equipment as text array
- notes text nullable: user notes about the custom exercise
- created_at timestamptz: custom exercise creation time
- updated_at timestamptz: custom exercise update time

public.body_weights:
- id uuid primary key: body-weight row id
- user_key text: authenticated user's id as text; always filter body_weights.user_key = $1
- weight numeric: body weight in pounds
- measured_on date: date the body weight was measured
- notes text nullable: body-weight notes
- created_at timestamptz: row creation time

Relationships and joins:
- workout_exercises.workout_id = workouts.id. When joining them, filter both workouts.user_key = $1 and workout_exercises.user_key = $1.
- Match catalog metadata with lower(exercise_catalog.name) = lower(workout_exercises.exercise_name). exercise_catalog has no user_key.
- Match custom metadata with lower(custom_exercises.name) = lower(workout_exercises.exercise_name), and always filter custom_exercises.user_key = $1.
- For body-part queries, use exercise_catalog.muscles/muscles_secondary and custom_exercises.muscles/muscles_secondary arrays; there is no column named muscle.

Muscle group mapping guidance:
- Chest: pectoralis/chest
- Back: latissimus/trapezius/teres/rhomboid/back
- Legs: quadriceps/hamstrings/glutes/calves/adductors/abductors
- Shoulders: deltoids/shoulders
- Arms: biceps/triceps/brachialis/forearms/wrist
- Core: abdominis/obliques/core
- For body-part or muscle-group questions, match exercise_catalog and custom_exercises muscles/muscles_secondary by joining on lower(name) = lower(workout_exercises.exercise_name). Include a name fallback for common variations not found in either metadata source.
- Triceps queries should include triceps catalog matches plus common names like tricep, triceps, pushdown, pressdown, skull crusher, extension, close grip bench, and dip.
- For triceps queries, do not require a catalog match. Use catalog muscles when available, but always OR in workout_exercises.exercise_name ILIKE fallbacks for '%tricep%', '%triceps%', '%pushdown%', '%pressdown%', '%skull crusher%', '%extension%', '%close grip%', and '%dip%'.
- Shoulder queries should include deltoid/shoulder catalog matches plus common names like shoulder press, overhead press, military press, lateral raise, front raise, rear delt, and face pull.
- If you reference ec.muscles or ec.muscles_secondary, the same SELECT scope must include JOIN exercise_catalog ec ON lower(ec.name) = lower(we.exercise_name). Never reference ec from a subquery unless exercise_catalog ec is joined in that subquery.
- For catalog muscle arrays, use EXISTS with unnest after joining ec, e.g. JOIN exercise_catalog ec ON lower(ec.name) = lower(we.exercise_name) WHERE we.user_key = $1 AND EXISTS (SELECT 1 FROM unnest(COALESCE(ec.muscles, ARRAY[]::text[]) || COALESCE(ec.muscles_secondary, ARRAY[]::text[])) AS matched_muscle WHERE matched_muscle ILIKE '%deltoid%' OR matched_muscle ILIKE '%shoulder%'). Never reference a bare column named muscle.

JSON set_rows guidance:
- workout_exercises.set_rows is jsonb, not table columns. Use jsonb_array_elements(COALESCE(we.set_rows, '[]'::jsonb)) AS set_row to inspect individual sets.
- Read fields with set_row->>'set', set_row->>'reps', set_row->>'weight', set_row->>'notes'. Cast numeric fields before ordering/comparing, e.g. (set_row->>'weight')::numeric and (set_row->>'reps')::int.
- For exercise-history requests "with details", include one row per set with workout/exercise date, exercise_name, set number, reps, weight, and notes where available.
- For best set, prefer highest estimated 1RM or highest weight depending on the user's wording; include exercise_name, created_at, set number, reps, and weight.`;
}

async function planSql(question: string, messages: AgentMessage[], context?: AgentContext, rejected?: { sql: string; reason: string }) {
  const conversationContext = messages.map((message) => `${message.role}: ${message.content}`).join("\n") || "No prior conversation.";
  const structuredContext = JSON.stringify(context ?? {}, null, 2);
  const repair = rejected ? `\nThe previous SQL was rejected: ${rejected.reason}\nRejected SQL:\n${rejected.sql}\nGenerate a corrected SQL query.` : "";
  const prompt = `You are a SQL agent for ProgressFit. Convert the user's natural language question into ONE safe Postgres SELECT query.
Return strict JSON only: {"sql":"...","reasoning":"short"}.

Rules:
- SELECT or WITH SELECT only.
- Never generate writes, comments, semicolons, DDL, DML, or multiple statements.
- Always restrict user-owned rows with user_key = $1. $1 is the authenticated user's UUID.
- For joins, restrict every user-owned table involved, e.g. workouts.user_key = $1 and workout_exercises.user_key = $1.
- Use LIMIT 100 for non-aggregate detail queries.
- Weight values are pounds. Do not convert to kg unless asked.
- For misspellings, use ILIKE and simple alternatives when useful, e.g. dumbell/dumbbell.
- For workout-level questions such as "best workout by volume", group by workouts.id/workout_id and sum all exercises in that workout.
- For body-part or muscle-group questions such as shoulder, chest, back, legs, arms, or core, include all matching exercises for that muscle group; do not filter to one exercise name from prior context unless the user explicitly asks for that exercise too.
- For body-part subgroups like triceps, biceps, rear delts, quads, hamstrings, or calves, treat them as muscle queries and include all matching exercises. For "performed" or "all" questions, do not use LIMIT 1 and do not pick only the first matching exercise.
- For singular/plural body-part spelling, include both forms, e.g. tricep and triceps.
- For exercise-specific questions, filter workout_exercises.exercise_name with ILIKE.
- If the user asks for exercises "with details", "details of each set", "all sets", or similar, return set-level detail using workout_exercises.set_rows instead of only aggregate sets/reps/weight columns.
- If the user asks how to improve/progress, return set-level rows with exercise_name, created_at, set number, reps, and weight. Progression advice needs the exact set, current reps, current weight, and target reps/weight.
- For follow-ups, use the conversation context to preserve the prior exercise/date/topic.
- For date phrases without year, prefer the current year if matching data exists.

Current date: ${new Date().toISOString().slice(0, 10)}
${schemaPrompt()}

Conversation:
${conversationContext}
Structured context from previous turns:
${structuredContext}
Latest question: ${question}${repair}`;

  const text = await generateGroqJson(prompt, 0.05);
  if (!text) return null;

  try {
    const parsed = parseJson<Partial<SqlPlan>>(text);
    return typeof parsed.sql === "string" ? { sql: parsed.sql, reasoning: typeof parsed.reasoning === "string" ? parsed.reasoning : undefined } : null;
  } catch {
    return null;
  }
}

async function executeReadOnlySql(sql: string, userId: string, params: unknown[] = []) {
  if (!sqlPool) throw new Error("READONLY_DATABASE_URL is not configured.");

  const client = await sqlPool.connect();
  try {
    await client.query("BEGIN READ ONLY");
    await client.query("SET LOCAL statement_timeout = '3000ms'");
    const result = await client.query(sql, [userId, ...params]);
    await client.query("ROLLBACK");
    return result.rows.slice(0, 100) as Record<string, unknown>[];
  } catch (error) {
    await client.query("ROLLBACK").catch(() => undefined);
    throw error;
  } finally {
    client.release();
  }
}

async function executeSetDetailsFromContext(context: AgentContext, userId: string) {
  const exerciseNames = context.exerciseNames?.map((name) => name.trim().toLowerCase()).filter(Boolean) ?? [];
  const start = context.dateRange?.start;
  const end = context.dateRange?.end;
  if (!exerciseNames.length || !start || !end) return null;

  const sql = `SELECT we.created_at, we.exercise_name, (set_row->>'set')::int AS set_number, (set_row->>'reps')::int AS reps, (set_row->>'weight')::numeric AS weight, set_row->>'notes' AS notes
FROM workout_exercises we, jsonb_array_elements(COALESCE(we.set_rows, '[]'::jsonb)) AS set_row
WHERE we.user_key = $1 AND lower(we.exercise_name) = ANY($2::text[]) AND we.created_at >= $3::timestamptz AND we.created_at < $4::timestamptz
ORDER BY we.created_at, we.exercise_name, set_number
LIMIT 100`;
  const rows = await executeReadOnlySql(sql, userId, [exerciseNames, start, end]);
  return { sql, rows };
}

async function executeArmSetsLastMonth(userId: string) {
  const range = previousMonthRange();
  const sql = `SELECT we.exercise_name, SUM(we.sets)::int AS sets, SUM(we.volume)::numeric AS volume
FROM workout_exercises we
WHERE we.user_key = $1
  AND we.created_at >= $2::timestamptz
  AND we.created_at < $3::timestamptz
  AND (
    we.exercise_name ILIKE '%bicep%' OR we.exercise_name ILIKE '%tricep%' OR we.exercise_name ILIKE '%triceps%' OR
    we.exercise_name ILIKE '%curl%' OR we.exercise_name ILIKE '%pushdown%' OR we.exercise_name ILIKE '%pressdown%' OR
    we.exercise_name ILIKE '%skull crusher%' OR we.exercise_name ILIKE '%extension%' OR we.exercise_name ILIKE '%dip%'
  )
GROUP BY we.exercise_name
ORDER BY sets DESC, we.exercise_name
LIMIT 100`;
  const rows = await executeReadOnlySql(sql, userId, [range.start, range.end]);
  return { sql, rows, range };
}

async function summarise(question: string, messages: AgentMessage[], rows: Record<string, unknown>[], sql: string, previousContext?: AgentContext, mode?: AgentContext["resultMode"]) {
  const tables = buildSetTables(rows);
  const context = mergeContext(previousContext, inferContext(question, rows, mode ?? (tables.length ? "set-detail" : "summary")));
  if (!groqKey) {
    return { answer: rows.length ? `I found ${rows.length} matching ${rows.length === 1 ? "row" : "rows"}.` : "I couldn't find matching data.", breakdown: [], tables, context } satisfies AgentAnswer;
  }

  const conversationContext = messages.map((message) => `${message.role}: ${message.content}`).join("\n") || "No prior conversation.";
  const prompt = `You are ProgressFit's training analytics agent. Answer the user using ONLY the SQL result rows.
Return strict JSON only: {"answer":"short natural answer","breakdown":[{"label":"string","value":number,"unit":"string"}]}.

Rules:
- If rows are empty, say you could not find matching data.
- Do not mention SQL unless the user asks.
- Preserve units from data. Weight is pounds.
- If rows are set-level, summarize what the set tables show. The app will render set tables separately, so do not duplicate every set in the answer text.
- For progression/improvement questions, be specific: name the exercise, set number, current reps, current weight, and the exact next target. Prefer adding 1 rep at the same weight before increasing weight. Example: "Incline Dumbbell Press set 3: currently 5 reps at 55 lb; target 6 reps at 55 lb next time." Do not answer only "increase weight or reps".
- For progression/improvement questions, leave breakdown empty unless it is an aggregate metric; do not split one recommendation into separate weight and reps breakdown rows.
- If rows are workout-level, summarize the whole workout, not a single exercise.
- Use conversation context to answer follow-ups naturally.

Conversation:
${conversationContext}
Latest question: ${question}
SQL used:
${sql}
Rows JSON:
${JSON.stringify(rows)}`;

  const text = await generateGroqJson(prompt, 0.2);
  if (!text) return { answer: rows.length ? `I found ${rows.length} matching ${rows.length === 1 ? "row" : "rows"}.` : "I couldn't find matching data.", breakdown: [], tables, context } satisfies AgentAnswer;

  try {
    const parsed = parseJson<{ answer?: unknown; breakdown?: unknown }>(text);
    const breakdown = !wantsProgressionAdvice(question) && Array.isArray(parsed.breakdown)
      ? parsed.breakdown.filter((row): row is { label: string; value: number; unit: string } => row && typeof row === "object" && typeof row.label === "string" && typeof row.value === "number" && typeof row.unit === "string").slice(0, 40)
      : [];
    return { answer: typeof parsed.answer === "string" ? parsed.answer : (rows.length ? `I found ${rows.length} matching rows.` : "I couldn't find matching data."), breakdown, tables, context } satisfies AgentAnswer;
  } catch {
    return { answer: rows.length ? `I found ${rows.length} matching ${rows.length === 1 ? "row" : "rows"}.` : "I couldn't find matching data.", breakdown: [], tables, context } satisfies AgentAnswer;
  }
}

async function answerWithSqlAgent(question: string, messages: AgentMessage[], userId: string, context?: AgentContext) {
  if (!sqlPool) return { answer: "The SQL agent needs READONLY_DATABASE_URL configured for your Supabase Postgres database.", breakdown: [] } satisfies AgentAnswer;
  if (!groqKey) return { answer: "The SQL agent needs GROQ_API_KEY or GROQ_AI_KEY configured.", breakdown: [] } satisfies AgentAnswer;

  if (wantsArmSetsSummary(question)) {
    try {
      const result = await executeArmSetsLastMonth(userId);
      return await summarise(question, messages, result.rows, result.sql, { ...context, muscleGroup: "arms", dateRange: result.range }, "summary");
    } catch (error) {
      const connectionMessage = databaseConnectionMessage(error);
      if (connectionMessage) return { answer: connectionMessage, breakdown: [], context } satisfies AgentAnswer;
      console.error("Deterministic arm sets query failed", error);
    }
  }

  if (wantsSetDetails(question) && context?.exerciseNames?.length && context.dateRange?.start && context.dateRange.end) {
    try {
      const detailResult = await executeSetDetailsFromContext(context, userId);
      if (detailResult) return await summarise(question, messages, detailResult.rows, detailResult.sql, context, "set-detail");
    } catch (error) {
      console.error("Deterministic set-detail query failed", error);
    }
  }

  let rejected: { sql: string; reason: string } | undefined;
  for (let attempt = 0; attempt < 2; attempt += 1) {
    const plan = await planSql(question, messages, context, rejected);
    if (!plan) break;

    const validationError = validateSql(plan.sql, question);
    if (validationError) {
      rejected = { sql: plan.sql, reason: validationError };
      console.error("Rejected generated SQL", validationError, plan.sql);
      continue;
    }

    try {
      const rows = await executeReadOnlySql(plan.sql, userId);
      if (!rows.length && attempt === 0) {
        rejected = { sql: plan.sql, reason: "Query returned no rows. Broaden exercise matching with catalog muscle arrays plus exercise_name fallbacks, and keep the same date/user filters." };
        continue;
      }
      return await summarise(question, messages, rows, plan.sql, context, buildSetTables(rows).length ? "set-detail" : "summary");
    } catch (error) {
      const connectionMessage = databaseConnectionMessage(error);
      if (connectionMessage) return { answer: connectionMessage, breakdown: [], context } satisfies AgentAnswer;
      const message = error instanceof Error ? error.message : "SQL execution failed";
      rejected = { sql: plan.sql, reason: message.includes("custom_exercises") ? `${message}. The custom_exercises table may not exist in this environment; retry using workout_exercises and exercise_catalog/name fallbacks only.` : message };
      console.error("SQL agent query failed", error, plan.sql);
    }
  }

  return { answer: "I couldn't turn that into a safe read-only query yet. If this works locally but not in production, check that READONLY_DATABASE_URL, GROQ_API_KEY, and the latest custom_exercises schema are configured in production.", breakdown: [] } satisfies AgentAnswer;
}

export async function POST(request: Request) {
  if (!supabaseUrl || !supabaseKey) return NextResponse.json({ error: "Supabase is not configured." }, { status: 500 });

  const payload = await request.json().catch(() => ({ question: "", messages: [] }));
  const messages = sanitiseMessages(payload.messages);
  const context = sanitiseContext(payload.context);
  const latestMessage = [...messages].reverse().find((message) => message.role === "user")?.content;
  const question = typeof payload.question === "string" && payload.question.trim() ? payload.question.trim() : latestMessage?.trim();
  if (!question) return NextResponse.json({ error: "Ask a question first." }, { status: 400 });

  const token = (request.headers.get("authorization") ?? "").replace(/^Bearer\s+/i, "");
  if (!token) return NextResponse.json({ error: "Sign in before asking ProgressFit." }, { status: 401 });

  const supabase = createClient(supabaseUrl, supabaseKey, { global: { headers: { Authorization: `Bearer ${token}` } }, auth: { persistSession: false } });
  const { data, error } = await supabase.auth.getUser(token);
  if (error || !data.user) return NextResponse.json({ error: "Sign in before asking ProgressFit." }, { status: 401 });

  const answer = await answerWithSqlAgent(question, messages, data.user.id, context);
  return NextResponse.json({ ...answer, question });
}
