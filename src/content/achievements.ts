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
  weekly_champion: {
    emoji: "👑",
    name: "Weekly Champion",
    description: "Finished #1 on the weekly voice leaderboard",
  },
  weekly_night_owl: {
    emoji: "🦉",
    name: "Night Owl",
    description: "Logged 5+ late-night hours this week (10 PM - 6 AM)",
  },
  weekly_marathon: {
    emoji: "🏃",
    name: "Marathoner",
    description: "Completed a 4+ hour voice session this week",
  },
  weekly_social_butterfly: {
    emoji: "🦋",
    name: "Social Butterfly",
    description: "Voiced with 5+ unique users this week",
  },
  weekly_consistent: {
    emoji: "🔥",
    name: "Consistent",
    description: "Connected on 5+ days this week (5+ min/day)",
  },
} as const;

export type AchievementType =
  | "weekly_champion"
  | "weekly_night_owl"
  | "weekly_marathon"
  | "weekly_social_butterfly"
  | "weekly_active"
  | "weekly_consistent";
