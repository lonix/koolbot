import type { ColorResolvable } from "discord.js";
import type { ModerationAction } from "../models/moderation-log.js";

/**
 * Shared rendering helpers for moderation-log rows (#728, #907).
 *
 * `/modlog`, the `/warn` confirmation and the moderation context notice all
 * render the same six actions, so the emoji/label, the accent colour and the
 * "prior history" summary live here rather than in any one caller.
 */

/** Emoji + label shown for each action. */
export function actionLabel(action: ModerationAction): string {
  switch (action) {
    case "warn":
      return "⚠️ Warn";
    case "kick":
      return "👢 Kick";
    case "ban":
      return "🔨 Ban";
    case "unban":
      return "🕊️ Unban";
    case "timeout":
      return "⏳ Timeout";
    case "untimeout":
      return "✅ Timeout lifted";
    default:
      return action;
  }
}

/** Embed accent colour per action: red for the severe end, green for a lift. */
export function actionColor(action: ModerationAction): ColorResolvable {
  switch (action) {
    case "warn":
      return 0xf59e0b;
    case "kick":
      return 0xf97316;
    case "ban":
      return 0xdc2626;
    case "timeout":
      return 0xeab308;
    case "unban":
    case "untimeout":
      return 0x22c55e;
    default:
      return 0x6366f1;
  }
}

/** Singular / plural noun used when counting prior entries of each action. */
const ACTION_NOUNS: Record<ModerationAction, readonly [string, string]> = {
  warn: ["warn", "warns"],
  timeout: ["timeout", "timeouts"],
  kick: ["kick", "kicks"],
  ban: ["ban", "bans"],
  untimeout: ["timeout lifted", "timeouts lifted"],
  unban: ["unban", "unbans"],
};

/**
 * Order the counts are listed in: roughly most-to-least telling about the
 * member, with the two "action reversed" entries last. Fixed so the same
 * history always renders the same way.
 */
export const ACTION_SUMMARY_ORDER: readonly ModerationAction[] = [
  "warn",
  "timeout",
  "kick",
  "ban",
  "untimeout",
  "unban",
];

/**
 * A member's moderation history collapsed to per-action counts plus the
 * timestamp of the newest entry. Produced by
 * `ModerationService.summarizeHistory`.
 */
export interface ModerationHistorySummary {
  /** Total rows counted. */
  total: number;
  /** Rows per action; actions with no rows are absent. */
  counts: Partial<Record<ModerationAction, number>>;
  /** `createdAt` of the newest counted row, or `null` when there are none. */
  mostRecent: Date | null;
}

/**
 * Render a one-line "what has this member done before?" summary, e.g.
 * `2 warns, 1 timeout (most recent <t:1234567890:R>)`.
 *
 * The timestamp is a Discord relative marker so each viewer sees it in their
 * own locale ("4 months ago") without the bot doing any date maths.
 */
export function formatHistorySummary(
  summary: ModerationHistorySummary,
): string {
  if (summary.total === 0) {
    return "No prior entries";
  }

  const parts = ACTION_SUMMARY_ORDER.flatMap((action) => {
    const count = summary.counts[action] ?? 0;
    if (count === 0) return [];
    const [singular, plural] = ACTION_NOUNS[action];
    return [`${count} ${count === 1 ? singular : plural}`];
  });

  const recent = summary.mostRecent
    ? ` (most recent <t:${Math.floor(summary.mostRecent.getTime() / 1000)}:R>)`
    : "";

  return `${parts.join(", ")}${recent}`;
}
