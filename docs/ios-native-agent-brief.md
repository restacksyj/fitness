# ProgressFit Native iOS Handoff Brief

This document is a detailed prompt/brief for an agent or engineer starting a native iOS version of ProgressFit. The current production app is a Next.js/React app wrapped with Capacitor for iOS. The goal of a native iOS effort is not to blindly port every screen immediately, but to build a robust iOS-first workout tracker with native rest timer, notifications, Live Activities, keyboard-safe UI, and eventual HealthKit/Apple Watch readiness.

## High-Level Goal

Build a native SwiftUI iOS app for ProgressFit that uses the same Supabase backend and preserves the current product behavior, while replacing fragile Capacitor/WebView-specific pieces with native iOS implementations.

The native iOS app should prioritize:

- Fast active workout tracking.
- Reliable rest timer behavior in foreground, background, lock screen, and Dynamic Island.
- Native local notifications.
- Clean iPhone-first UI with correct keyboard handling and safe areas.
- Compatibility with the existing Supabase schema and data already created by the web/Capacitor app.
- A migration path where the current Capacitor app can continue working during the native rewrite.

## Current App Context

Repository path:

```text
/Users/yashjajoo/Documents/personal/fitness
```

Current stack:

- Next.js App Router / React.
- Supabase for Auth, Postgres, Storage.
- Capacitor iOS wrapper.
- Local notifications via `@capacitor/local-notifications`.
- Status bar via `@capacitor/status-bar`.
- Live Activity attempted via `capacitor-live-activity` plus a local native fallback plugin.
- Native iOS project under `ios/App`.

Current normal web build:

```bash
bun run build
```

Current Capacitor native bundle build:

```bash
bun run build:cap && bunx cap sync ios
```

Important Capacitor caveat:

- `cap sync ios` regenerates `ios/App/App/capacitor.config.json` and removes manual fallback entries such as `AppLiveActivityPlugin`.
- This is one reason a native app would be cleaner.

## Current Bundle IDs

Main iOS app bundle id:

```text
com.progressfityj.app
```

Current Live Activity widget extension bundle id:

```text
com.progressfityj.app.RestTimerLiveActivity
```

Preserve the main bundle id if replacing the Capacitor app with a native app, because the user is already using SideStore and keeping the bundle id stable helps preserve app identity, permissions, and data.

## Why Native iOS Is Worth Considering

Capacitor helped reuse the web app quickly, but several iOS-native features became fragile:

- Dynamic Island / Live Activity setup requires Widget Extension and ActivityKit.
- Live Activity controls cannot mutate React state directly without opening the app.
- Time Sensitive Notifications require Apple Developer Program support and entitlements; personal teams do not support it.
- Keyboard behavior inside `WKWebView` needs CSS workarounds.
- Xcode project manual edits are easy to break and can be overwritten by Capacitor sync.
- Native notifications, haptics, sounds, background behavior, and safe areas are more reliable in SwiftUI.

For a polished daily-use iOS fitness app, native SwiftUI is the better long-term architecture.

## Current Product Behavior To Preserve

### Core Concepts

- User signs in with Supabase Auth.
- User tracks workouts made of exercises.
- Each exercise has sets.
- Each set has reps, weight, notes, completed state while active.
- Bodyweight exercises hide Weight and save weight as `0`.
- User can save/finish workout with title, description/notes, duration, images.
- User can view/edit saved workouts.
- User can track body weight.
- User can create routines.
- User can ask an agent questions about workout history in the web app; this can be deferred in native MVP.

### Active Workout Tracking

Current React behavior to replicate:

- Active workout starts with a queue of exercises.
- User can add exercises from catalog/history/custom sources.
- Each exercise has editable set rows.
- A set only counts/saves if it is completed and valid.
- Checking a set can start a rest timer based on that exercise’s configured rest timer seconds.
- Previous best values appear as placeholder labels, not actual values until the set is completed/materialized.
- If user clears typed values, previous-best placeholder remains visible.
- Completed bodyweight set saves weight as `0`.

### Rest Timer

Current expected behavior:

- Per-exercise rest timer setting, options currently include:

```text
0, 10, 20, 30, 45, 60, 90, 120, 180 seconds
```

- Timer starts when a set is marked completed if exercise rest timer is non-zero.
- Timer uses absolute end timestamp, not just interval countdown.
- Timer should catch up after app background/lock.
- User can adjust in app: `-15`, `+15`, `Skip`.
- Native local notification should fire when timer completes.
- Live Activity/Dynamic Island should show countdown only.
- Do not include Live Activity `+15`, `-15`, `Skip` controls unless implementing native App Intents properly. Opening the app from controls was judged not useful.

### Notifications

Current notification behavior:

- Rest timer completion schedules a native local notification.
- Notification title:

```text
Rest timer complete
```

- Notification body:

```text
Time for your next set.
```

- Notification is scheduled when rest timer starts.
- Notification is rescheduled on `+15` / `-15`.
- Notification is canceled on skip/off.

Time Sensitive note:

- Tried to add Time Sensitive Notifications.
- Personal Apple development teams do not support the Time Sensitive Notifications capability.
- Do not require Time Sensitive Notifications for MVP.
- If using paid Apple Developer Program later, add entitlement and request authorization with `.timeSensitive`.

### Inactivity Reminder

Current behavior:

- Native local notification after 10 minutes without workout activity.
- Resets on exercise/set/note activity.
- Cancels on finish/discard/no active exercises.

Notification title/body:

```text
Still working out?
It has been 10 minutes since your last workout activity.
```

### Finish Workout Flow

Current desired behavior:

- User taps Finish.
- Fullscreen mobile-safe modal/sheet appears.
- Shows summary stats in same form view:
  - duration
  - volume
  - sets
  - exercises
- User can edit title.
- User can type description/notes.
- User can attach images.
- Keyboard must not cover notes or buttons.
- Save persists workout, exercises, sets, notes, images.
- After save, modal closes directly.

### Images

Current behavior:

- Finish modal supports image selection, preview, upload.
- Images upload to Supabase Storage bucket:

```text
workout-images
```

- Workout row stores public URLs in `workouts.photo_urls`.
- Normal workout list does not show images/description by default.
- Workout edit/detail view can show description/images and allows add/remove.

## Supabase Integration

Native app should use Supabase Swift client if practical.

Likely package:

```text
https://github.com/supabase/supabase-swift
```

Use existing environment variables/config values from the web app, but do not commit secrets. The native app will need Supabase URL and anon key. Use a safe config strategy:

- `Config.xcconfig` ignored from git, or
- build settings, or
- generated configuration file excluded from git.

### Auth

Current auth is Supabase email/password.

Native app should support:

- sign in with email/password
- sign up with email/password
- sign out
- session persistence
- route UI based on auth session

Preserve user identity with `user_key` values. In current web app, `user_key` maps to user/account identity. Inspect `lib/user-key.ts`, `lib/supabase.ts`, and current DB schema before implementation.

### Important Tables And Fields

Inspect these files for canonical types/schema:

```text
lib/supabase.ts
supabase/schema.sql
```

Current known entities:

- `workouts`
- `workout_exercises`
- `body_weights`
- `routines`
- `routine_exercises`
- `custom_exercises`
- exercise catalog/cache imports

Known workout fields:

- `id`
- `user_key`
- `name`
- `notes`
- `duration_seconds`
- `photo_urls`
- timestamps

Known workout exercise/set fields include:

- exercise name
- reps
- weight
- sets/count
- volume
- notes
- `set_rows` as structured set data in existing app behavior
- body weight where applicable

Do not change the DB schema for the native MVP unless necessary. Compatibility with existing web data is important.

### Schema Additions Already Needed/Used

The current app expects these workout columns/storage features:

```sql
alter table public.workouts add column if not exists notes text;
alter table public.workouts add column if not exists photo_urls jsonb not null default '[]'::jsonb;
```

Storage bucket:

```text
workout-images
```

Native implementation should upload images to the same bucket and store URLs in `workouts.photo_urls`.

## Recommended Native iOS Architecture

Use SwiftUI with MVVM-style feature stores/view models.

Recommended minimum iOS target:

```text
iOS 16.2+
```

Reason:

- Live Activities / ActivityKit local activities are cleanest from iOS 16.2 onward.
- Current plugin/package also assumed iOS 16.2.

### Suggested Project Structure

```text
ProgressFit/
  App/
    ProgressFitApp.swift
    AppState.swift
    AppEnvironment.swift
  Config/
    SupabaseConfig.swift
  Models/
    Workout.swift
    WorkoutExercise.swift
    WorkoutSet.swift
    Routine.swift
    BodyWeight.swift
    ExerciseCatalogItem.swift
  Services/
    SupabaseService.swift
    AuthService.swift
    WorkoutService.swift
    RoutineService.swift
    BodyWeightService.swift
    ImageUploadService.swift
    NotificationService.swift
    LiveActivityService.swift
    HapticsService.swift
  Features/
    Auth/
    ActiveWorkout/
    ExercisePicker/
    FinishWorkout/
    WorkoutHistory/
    WorkoutDetail/
    Routines/
    BodyWeight/
    Settings/
  LiveActivities/
    RestTimerLiveActivityAttributes.swift
    RestTimerLiveActivityWidget.swift
  Shared/
    Components/
    Formatters/
    Extensions/
```

### App State

Create a central `AppState` or feature stores for:

- auth session
- current user key
- active workout draft
- rest timer state
- network/sync state
- selected tab/section

Use `@Observable` if targeting modern Swift, or `ObservableObject` if simpler.

### Persistence

Native active workout tracking should be offline-first. A user must be able to start, continue, finish, and locally save a workout without internet. The app should sync completed offline workouts once connectivity returns.

Options:

- SwiftData for local drafts/cache, or
- Codable JSON in app group/user defaults for quick MVP, or
- SQLite/GRDB for robust offline queue.

MVP recommendation:

- Use SwiftData or SQLite/GRDB for active workout drafts, completed offline workouts, and sync queue.
- If using Codable JSON for speed, still model an explicit sync queue instead of only saving a single draft blob.
- Keep local IDs for workouts/exercises/sets and map them to Supabase IDs after successful sync.
- Make sync idempotent so retrying does not create duplicate workouts.

### Offline-First Tracking And Sync

Offline support should be a first-class native iOS requirement, not a later web-style workaround.

Required offline behavior:

- App can open without network if a session already exists locally.
- User can start an active workout while offline.
- User can add exercises and sets while offline.
- User can complete sets and use the rest timer while offline.
- User can finish/save a workout while offline.
- Finished offline workouts appear immediately in local recent workouts with a pending/syncing state.
- When network returns, pending workouts sync to Supabase automatically.
- If sync fails, data remains local and retryable.
- User should never lose an active workout because of app kill, reboot, or network loss.

Suggested local models:

- `LocalWorkoutDraft`: active in-progress workout.
- `LocalWorkout`: completed workout waiting for sync or already synced.
- `LocalWorkoutExercise`: exercise rows for local workout.
- `LocalWorkoutSet`: set rows for local workout exercise.
- `SyncQueueItem`: operation type, local entity id, payload snapshot, retry count, last error, created/updated timestamps.

Suggested sync states:

```text
draft
pendingSync
syncing
synced
failed
```

Suggested sync rules:

- Use a stable client-generated UUID for each local workout.
- Include that UUID in metadata if adding a schema field is acceptable later, or keep local mapping table if not changing schema.
- Sync parent workout first, then workout exercises/sets, then image uploads if any.
- Mark item `synced` only after all related records are saved successfully.
- Use exponential backoff for failed sync attempts.
- Provide a visible indicator such as `Saved offline`, `Syncing`, `Synced`, or `Sync failed`.
- Avoid deleting local data immediately after sync; keep a local cache for recent workouts.

Connectivity monitoring:

- Use `NWPathMonitor` to detect online/offline transitions.
- Trigger sync when path changes to satisfied.
- Also trigger sync on app launch and foreground.

Conflict/duplication strategy for MVP:

- Treat offline-created workouts as append-only.
- Do not attempt complex merge for the first MVP.
- Prevent duplicate uploads by tracking local UUID to remote workout ID.
- If a sync attempt partially succeeds, resume from the known remote IDs rather than inserting again.

## Live Activity Design

Use ActivityKit natively.

### Attributes

Define rest timer activity attributes similar to:

```swift
import ActivityKit
import Foundation

struct RestTimerAttributes: ActivityAttributes {
    struct ContentState: Codable, Hashable {
        var endAt: Date
        var exerciseName: String
        var isComplete: Bool
    }

    var title: String
}
```

### Service Responsibilities

`LiveActivityService` should:

- start activity with absolute `endAt`
- update activity on `+15` / `-15`
- update to complete when timer reaches zero
- end activity on skip/workout finish/discard
- be no-op if activities unavailable
- avoid throwing user-visible errors for unsupported states

### Widget UI Requirements

Lock screen / expanded Dynamic Island:

- timer icon left
- exercise name/title left
- countdown pinned right

Compact Dynamic Island:

- leading: timer icon
- trailing: countdown

Minimal:

- timer icon

Do not add control buttons for MVP.

Apple controls whether Dynamic Island stays expanded/collapses. App cannot force collapse after N seconds.

## Notification Design

`NotificationService` should:

- request local notification permission
- schedule rest timer completion notification at exact end time
- cancel rest timer notification
- reschedule on timer adjustments
- schedule/cancel inactivity reminder

Do not require Time Sensitive Notifications for MVP due personal team limitation.

If later using paid Apple Developer Program:

- Add Time Sensitive Notifications capability in Apple Developer/Xcode.
- Add entitlement.
- Request authorization option `.timeSensitive`.
- Use `UNMutableNotificationContent.interruptionLevel = .timeSensitive`.

## Active Workout Native MVP Requirements

Start with the smallest native feature set that gives daily value:

### Phase 1: Native Tracker MVP

- Auth/session.
- Exercise picker from recent/custom/catalog if feasible.
- Active workout list.
- Add/remove exercise.
- Add/remove set.
- Edit reps/weight.
- Complete/incomplete set.
- Bodyweight exercise handling.
- Rest timer with local notification and Live Activity.
- Finish workout with title/notes and save locally first, then sync to Supabase.
- Offline active workout persistence and completed workout sync queue.
- Recent workouts list.

Defer:

- charts/progress analytics
- AI agent chat
- full routine builder
- image upload if needed to reduce scope

### Phase 2: Polish/Core Parity

- Image upload on finish.
- Edit saved workouts.
- Routine support.
- Body weight tracking.
- Exercise history/previous best placeholders.
- More advanced offline conflict handling and local caching.

### Phase 3: Native-Only Enhancements

- HealthKit body weight/workout integration.
- Apple Watch rest timer.
- App Intents/Siri shortcuts.
- Widgets.
- True Live Activity controls using App Intents if desired.

## UI/UX Guidance

User preference:

- Neutral grayscale/dark-mode-aware UI.
- Avoid warm/amber visual language.
- Preserve clean dark mode.
- Mobile-first, thumb-friendly controls.

Active workout UI priorities:

- Large tap targets.
- Set completion must be fast.
- Add Set button must never be hidden by timer or keyboard.
- Rest timer should not block core actions; reserve scroll space or dock intelligently.
- Keyboard should never cover text fields or save buttons.

Finish workout UI:

- Use a native sheet or full-screen cover.
- Wrap form in `ScrollView`.
- Use `.safeAreaInset(edge: .bottom)` for action buttons.
- Use `.scrollDismissesKeyboard(.interactively)`.
- Use `@FocusState` to scroll focused notes field into view if necessary.

## Data Compatibility Notes

Current web app stores set rows and workout exercise details in shapes defined in `lib/supabase.ts`. Before writing native model structs, inspect actual rows in Supabase or the type definitions.

Important compatibility rules:

- Bodyweight exercise sets should save weight as `0`.
- Only completed valid sets should be saved from active workout.
- Workout duration should be saved in `duration_seconds`.
- Workout notes/description should map to `workouts.notes`.
- Workout photo URLs should map to `workouts.photo_urls`.

## Existing Current Native/Capacitor Gotchas

If continuing to touch current Capacitor iOS project, beware:

- Open `ios/App/App.xcworkspace`, not `App.xcodeproj`.
- Use `App` scheme, not `RestTimerLiveActivity` scheme/target.
- Widget extension cannot be run directly like an app.
- `cap sync ios` regenerates `ios/App/App/capacitor.config.json`.
- Current fallback plugin entry may need manual restore after sync:

```json
"AppLiveActivityPlugin"
```

- Personal Apple Development Team does not support Time Sensitive Notifications.
- Do not add Time Sensitive entitlement unless using a paid developer account/profile.

## Suggested Prompt For Another Agent

Use this as the actual initial prompt to another coding agent:

```text
You are building a native SwiftUI iOS version of ProgressFit, a workout tracker currently implemented as a Next.js/React app with Capacitor. The goal is to create a native iOS app that uses the same Supabase backend/schema and prioritizes active workout tracking, native rest timer, local notifications, and Live Activity/Dynamic Island countdown.

Start by inspecting the existing repo files:
- lib/supabase.ts
- supabase/schema.sql
- app/page.tsx, especially active workout, rest timer, finish workout, and saved workout logic
- ios/App for current bundle ids and Live Activity widget attempt

Build a SwiftUI MVP, not a full rewrite of every feature. Preserve the main bundle id com.progressfityj.app. Use iOS 16.2+ as the target. Use Supabase Swift for auth/database/storage. Do not add Time Sensitive Notifications because personal Apple development teams do not support that entitlement.

Native MVP must include:
- Supabase email/password auth/session
- active workout draft with exercises and sets
- add/remove exercises and sets
- completed-set save semantics
- bodyweight exercise weight=0 semantics
- rest timer using absolute endAt Date
- local notification when rest timer completes
- ActivityKit Live Activity countdown with timer on right side
- finish workout sheet with title, notes, summary, and save to Supabase
- recent workouts list

Defer AI chat, advanced charts, routine builder, and HealthKit until after the tracker MVP works.

Use a clean SwiftUI architecture with services for Supabase, notifications, Live Activities, and workout persistence. Make keyboard/safe-area behavior native and robust.
```

## Success Criteria For Native MVP

- User can sign in.
- User can start a workout.
- User can add an exercise.
- User can add sets and mark them completed.
- Rest timer starts on set completion.
- Rest timer continues/catches up after locking/backgrounding.
- Rest timer completion notification fires.
- Dynamic Island/Live Activity countdown appears on supported device.
- User can finish workout with title/notes.
- Workout appears in recent workouts and remains compatible with existing web data.
- No Xcode project manual hacks are required for normal development.
