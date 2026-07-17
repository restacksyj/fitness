create table if not exists public.workouts (
  id uuid primary key default gen_random_uuid(),
  user_key text not null,
  name text not null default '',
  notes text,
  photo_urls jsonb not null default '[]'::jsonb,
  duration_seconds int not null default 0 check (duration_seconds >= 0),
  created_at timestamptz not null default now()
);

create table if not exists public.workout_exercises (
  id uuid primary key default gen_random_uuid(),
  workout_id uuid not null references public.workouts(id) on delete cascade,
  user_key text not null,
  exercise_name text not null,
  sets int not null check (sets > 0),
  reps int not null check (reps > 0),
  weight numeric not null default 0 check (weight >= 0),
  volume numeric not null default 0 check (volume >= 0),
  set_rows jsonb,
  created_at timestamptz not null default now()
);

-- Safe migrations if you already ran an older schema.
alter table public.workouts add column if not exists name text not null default '';
alter table public.workouts add column if not exists notes text;
alter table public.workouts add column if not exists photo_urls jsonb not null default '[]'::jsonb;
alter table public.workouts add column if not exists duration_seconds int not null default 0 check (duration_seconds >= 0);
alter table public.workout_exercises add column if not exists weight numeric not null default 0 check (weight >= 0);
alter table public.workout_exercises add column if not exists set_rows jsonb;
alter table public.workout_exercises add column if not exists notes text;
alter table public.workout_exercises add column if not exists body_weight numeric check (body_weight is null or body_weight > 0);
alter table public.workout_exercises alter column volume type numeric using volume::numeric;
alter table public.workout_exercises alter column volume set default 0;

create index if not exists workouts_user_created_idx on public.workouts(user_key, created_at desc);
create index if not exists workout_exercises_user_created_idx on public.workout_exercises(user_key, created_at desc);
create index if not exists workout_exercises_user_name_idx on public.workout_exercises(user_key, lower(exercise_name));

create table if not exists public.routines (
  id uuid primary key default gen_random_uuid(),
  user_key text not null,
  title text not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists public.routine_exercises (
  id uuid primary key default gen_random_uuid(),
  routine_id uuid not null references public.routines(id) on delete cascade,
  user_key text not null,
  exercise_name text not null,
  position int not null default 0,
  set_rows jsonb not null default '[]'::jsonb,
  notes text,
  created_at timestamptz not null default now()
);

create index if not exists routines_user_created_idx on public.routines(user_key, created_at desc);
create index if not exists routine_exercises_routine_position_idx on public.routine_exercises(routine_id, position);

create table if not exists public.exercise_catalog (
  id uuid primary key default gen_random_uuid(),
  wger_id int not null unique,
  wger_uuid uuid,
  name text not null,
  description text not null default '',
  category text,
  muscles text[] not null default '{}',
  muscles_secondary text[] not null default '{}',
  equipment text[] not null default '{}',
  image_url text,
  language_id int not null default 2,
  source_payload jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists exercise_catalog_name_idx on public.exercise_catalog using gin (to_tsvector('english', name));
create index if not exists exercise_catalog_lower_name_idx on public.exercise_catalog(lower(name));
create index if not exists exercise_catalog_category_idx on public.exercise_catalog(category);

create table if not exists public.custom_exercises (
  id uuid primary key default gen_random_uuid(),
  user_key text not null,
  name text not null,
  category text,
  muscles text[] not null default '{}',
  muscles_secondary text[] not null default '{}',
  equipment text[] not null default '{}',
  notes text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists custom_exercises_user_name_idx on public.custom_exercises(user_key, lower(name));
create unique index if not exists custom_exercises_user_lower_name_unique on public.custom_exercises(user_key, lower(name));

create table if not exists public.body_weights (
  id uuid primary key default gen_random_uuid(),
  user_key text not null,
  weight numeric not null check (weight > 0),
  measured_on date not null default current_date,
  notes text,
  created_at timestamptz not null default now(),
  unique(user_key, measured_on)
);

create index if not exists body_weights_user_date_idx on public.body_weights(user_key, measured_on desc);

alter table public.workouts enable row level security;
alter table public.workout_exercises enable row level security;
alter table public.routines enable row level security;
alter table public.routine_exercises enable row level security;
alter table public.exercise_catalog enable row level security;
alter table public.custom_exercises enable row level security;
alter table public.body_weights enable row level security;

-- Publishable keys use the anon Postgres role until a user signs in.
-- This personal tracker has no login yet, so policies allow anon insert/select.
-- The app filters by the locally generated user_key; add Supabase Auth later for stronger per-user privacy.
drop policy if exists "anon can insert workouts" on public.workouts;
drop policy if exists "anon can read workouts" on public.workouts;
drop policy if exists "anon can delete workouts" on public.workouts;
drop policy if exists "authenticated can insert own workouts" on public.workouts;
drop policy if exists "authenticated can read own workouts" on public.workouts;
drop policy if exists "authenticated can update own workouts" on public.workouts;
drop policy if exists "authenticated can delete own workouts" on public.workouts;
drop policy if exists "anon can insert workout exercises" on public.workout_exercises;
drop policy if exists "anon can read workout exercises" on public.workout_exercises;
drop policy if exists "anon can update workout exercises" on public.workout_exercises;
drop policy if exists "anon can delete workout exercises" on public.workout_exercises;
drop policy if exists "authenticated can insert own workout exercises" on public.workout_exercises;
drop policy if exists "authenticated can read own workout exercises" on public.workout_exercises;
drop policy if exists "authenticated can update own workout exercises" on public.workout_exercises;
drop policy if exists "authenticated can delete own workout exercises" on public.workout_exercises;
drop policy if exists "authenticated can insert own routines" on public.routines;
drop policy if exists "authenticated can read own routines" on public.routines;
drop policy if exists "authenticated can update own routines" on public.routines;
drop policy if exists "authenticated can delete own routines" on public.routines;
drop policy if exists "authenticated can insert own routine exercises" on public.routine_exercises;
drop policy if exists "authenticated can read own routine exercises" on public.routine_exercises;
drop policy if exists "authenticated can update own routine exercises" on public.routine_exercises;
drop policy if exists "authenticated can delete own routine exercises" on public.routine_exercises;
drop policy if exists "anon can read exercise catalog" on public.exercise_catalog;
drop policy if exists "authenticated can read exercise catalog" on public.exercise_catalog;
drop policy if exists "authenticated can insert own custom exercises" on public.custom_exercises;
drop policy if exists "authenticated can read own custom exercises" on public.custom_exercises;
drop policy if exists "authenticated can update own custom exercises" on public.custom_exercises;
drop policy if exists "authenticated can delete own custom exercises" on public.custom_exercises;
drop policy if exists "anon can insert body weights" on public.body_weights;
drop policy if exists "anon can read body weights" on public.body_weights;
drop policy if exists "anon can update body weights" on public.body_weights;
drop policy if exists "anon can delete body weights" on public.body_weights;
drop policy if exists "authenticated can insert own body weights" on public.body_weights;
drop policy if exists "authenticated can read own body weights" on public.body_weights;
drop policy if exists "authenticated can update own body weights" on public.body_weights;
drop policy if exists "authenticated can delete own body weights" on public.body_weights;

create policy "authenticated can insert own workouts" on public.workouts for insert to authenticated with check ((select auth.uid())::text = user_key);
create policy "authenticated can read own workouts" on public.workouts for select to authenticated using ((select auth.uid())::text = user_key);
create policy "authenticated can update own workouts" on public.workouts for update to authenticated using ((select auth.uid())::text = user_key) with check ((select auth.uid())::text = user_key);
create policy "authenticated can delete own workouts" on public.workouts for delete to authenticated using ((select auth.uid())::text = user_key);
create policy "authenticated can insert own workout exercises" on public.workout_exercises for insert to authenticated with check ((select auth.uid())::text = user_key);
create policy "authenticated can read own workout exercises" on public.workout_exercises for select to authenticated using ((select auth.uid())::text = user_key);
create policy "authenticated can update own workout exercises" on public.workout_exercises for update to authenticated using ((select auth.uid())::text = user_key) with check ((select auth.uid())::text = user_key);
create policy "authenticated can delete own workout exercises" on public.workout_exercises for delete to authenticated using ((select auth.uid())::text = user_key);
create policy "authenticated can insert own routines" on public.routines for insert to authenticated with check ((select auth.uid())::text = user_key);
create policy "authenticated can read own routines" on public.routines for select to authenticated using ((select auth.uid())::text = user_key);
create policy "authenticated can update own routines" on public.routines for update to authenticated using ((select auth.uid())::text = user_key) with check ((select auth.uid())::text = user_key);
create policy "authenticated can delete own routines" on public.routines for delete to authenticated using ((select auth.uid())::text = user_key);
create policy "authenticated can insert own routine exercises" on public.routine_exercises for insert to authenticated with check ((select auth.uid())::text = user_key);
create policy "authenticated can read own routine exercises" on public.routine_exercises for select to authenticated using ((select auth.uid())::text = user_key);
create policy "authenticated can update own routine exercises" on public.routine_exercises for update to authenticated using ((select auth.uid())::text = user_key) with check ((select auth.uid())::text = user_key);
create policy "authenticated can delete own routine exercises" on public.routine_exercises for delete to authenticated using ((select auth.uid())::text = user_key);
create policy "anon can read exercise catalog" on public.exercise_catalog for select to anon using (true);
create policy "authenticated can read exercise catalog" on public.exercise_catalog for select to authenticated using (true);
create policy "authenticated can insert own custom exercises" on public.custom_exercises for insert to authenticated with check ((select auth.uid())::text = user_key);
create policy "authenticated can read own custom exercises" on public.custom_exercises for select to authenticated using ((select auth.uid())::text = user_key);
create policy "authenticated can update own custom exercises" on public.custom_exercises for update to authenticated using ((select auth.uid())::text = user_key) with check ((select auth.uid())::text = user_key);
create policy "authenticated can delete own custom exercises" on public.custom_exercises for delete to authenticated using ((select auth.uid())::text = user_key);
create policy "authenticated can insert own body weights" on public.body_weights for insert to authenticated with check ((select auth.uid())::text = user_key);
create policy "authenticated can read own body weights" on public.body_weights for select to authenticated using ((select auth.uid())::text = user_key);
create policy "authenticated can update own body weights" on public.body_weights for update to authenticated using ((select auth.uid())::text = user_key) with check ((select auth.uid())::text = user_key);
create policy "authenticated can delete own body weights" on public.body_weights for delete to authenticated using ((select auth.uid())::text = user_key);

insert into storage.buckets (id, name, public)
values ('workout-images', 'workout-images', true)
on conflict (id) do update set public = true;

drop policy if exists "authenticated can upload own workout images" on storage.objects;
drop policy if exists "authenticated can read own workout images" on storage.objects;
drop policy if exists "authenticated can update own workout images" on storage.objects;
drop policy if exists "authenticated can delete own workout images" on storage.objects;

create policy "authenticated can upload own workout images" on storage.objects for insert to authenticated
with check (bucket_id = 'workout-images' and (storage.foldername(name))[1] = (select auth.uid())::text);
create policy "authenticated can read own workout images" on storage.objects for select to authenticated
using (bucket_id = 'workout-images' and (storage.foldername(name))[1] = (select auth.uid())::text);
create policy "authenticated can update own workout images" on storage.objects for update to authenticated
using (bucket_id = 'workout-images' and (storage.foldername(name))[1] = (select auth.uid())::text)
with check (bucket_id = 'workout-images' and (storage.foldername(name))[1] = (select auth.uid())::text);
create policy "authenticated can delete own workout images" on storage.objects for delete to authenticated
using (bucket_id = 'workout-images' and (storage.foldername(name))[1] = (select auth.uid())::text);
