# `src/content/` — static developer-maintained content

This folder holds arrays and lookup tables of **content** — strings, emojis,
embed colors, badge metadata — that ship with the bot but aren't really
"logic". The goal is to keep service files focused on behavior and let
contributors edit copy without touching unrelated code.

## What lives here

| File | Used by | What it is |
| --- | --- | --- |
| `statuses.ts` | `services/bot-status-service.ts` | Random-rotation Discord presence pools (lonely / single-user / multi-user) |
| `notice-categories.ts` | `services/notices-channel-manager.ts` | Per-category emoji + embed color + label |
| `accolades.ts` | `services/achievements-service.ts` | Display metadata (emoji / name / description) for every accolade |
| `achievements.ts` | `services/achievements-service.ts` | Display metadata for time-based achievements |

## What does **not** belong here

- **Logic.** `checkFunction`/`metadataFunction` for accolades stay in
  `achievements-service.ts` next to the rest of the awarding code.
- **Anything user-configurable at runtime.** Server admins set those via
  `ConfigService` and the `/config` wizard, not by editing source files.
- **Per-deploy secrets / IDs.** Channel IDs, role IDs, tokens, etc. belong in
  environment variables or `ConfigService`.

## Adding entries

### Status / response / trigger pools

Just add a string to the array. The exported arrays are `as const`, so the
literal types narrow automatically — there's nothing else to wire up.

`multipleUsersStatuses` entries must contain the literal `{count}`
placeholder. The `satisfies readonly` `${string}{count}${string}` `[]`
constraint will give you a compile error if you forget it.

### A new accolade

Two-step change, both verified by the type checker:

1. Add an entry to `ACCOLADE_METADATA` in `accolades.ts`:

   ```ts
   my_new_accolade: {
     emoji: "✨",
     name: "Display Name",
     description: "What you did to earn it",
   },
   ```

2. Add a matching entry to `accoladeLogic` in
   `services/achievements-service.ts`:

   ```ts
   my_new_accolade: {
     checkFunction: async (userId, userData) => { /* ... */ },
     metadataFunction: async (userId, userData) => { /* ... */ },
   },
   ```

The `Record<AccoladeType, BadgeLogic>` typing means TypeScript fails the
build if you add metadata without logic, or if a typo in the id stops them
from matching.

### A new achievement

Same pattern. `ACHIEVEMENT_METADATA` plus `achievementLogic` in the service.
The achievement logic record is `Partial<>` because some `AchievementType`
ids are reserved for future use.

## Conventions

- Use `as const` on every exported array/object — it preserves literal
  types and prevents accidental mutation.
- Keep one concern per file. If you find yourself adding a second array to
  a file for an unrelated feature, make a new file instead.
- Re-export new files from `index.ts` so they're easy to import.
