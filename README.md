# ProgressFit

Mobile-friendly Next.js + TypeScript PWA for tracking workouts and progressive overload. Data is stored in Supabase.

## Setup

1. Install dependencies:

```bash
bun install
```

2. Create a Supabase project and run `supabase/schema.sql` in the SQL editor.

3. Copy env vars:

```bash
cp .env.example .env.local
```

Fill in Supabase browser-safe credentials from Supabase project settings:

```env
NEXT_PUBLIC_SUPABASE_URL=https://your-project.supabase.co
NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY=sb_publishable_your-key
```

Use a **publishable key** (`sb_publishable_...`), not a service role/secret key.

4. Run locally:

```bash
bun run dev
```

5. Build/serve for PWA service worker testing:

```bash
bun run build
bun run start
```

On iPhone, open the deployed HTTPS URL in Safari, tap Share, then **Add to Home Screen**.

## Notes

- Supabase publishable keys are safe to expose in browser/mobile apps and use the `anon` Postgres role until a user signs in.
- The app uses a locally generated `user_key` saved in the browser to separate your data without requiring login. For stronger privacy, add Supabase Auth and ownership-based RLS later.
- Workouts can be named; if left blank, the current date is used as the name.
- Each exercise records set count, set-level reps/weight, best reps, best weight in lbs, and weight volume (`reps × lbs`) for charting.
