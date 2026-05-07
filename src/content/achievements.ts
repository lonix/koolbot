/**
 * Display metadata for time-based achievements.
 *
 * Logic for awarding each achievement lives in
 * `src/services/achievements-service.ts` keyed by the same id.
 *
 * `AchievementType` includes ids that are reserved for future use (no
 * metadata yet, no logic yet) — those entries simply aren't present
 * in this object. The service's logic record is `Partial<>` to match.
 */

export const ACHIEVEMENT_METADATA = {
  weekly_active: {
    emoji: "⚡",
    name: "Active",
    description: "Reached 10 hours in voice chat this week",
  },
} as const;

export type AchievementType =
  | "weekly_champion"
  | "weekly_night_owl"
  | "weekly_marathon"
  | "weekly_social_butterfly"
  | "weekly_active"
  | "weekly_consistent";
