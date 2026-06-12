/**
 * Bot presence status pools used by BotStatusService.
 *
 * Picked at random based on how many users are in voice chat.
 * `multipleUsersStatuses` entries must contain the literal `{count}`
 * placeholder — it is replaced with the current user count at runtime.
 */

export const lonelyStatuses = [
  "nobody, I hate it here",
  "paint dry, I'm so bored",
  "the void, I'm contemplating existence",
  "pixels, I'm counting them",
  "solitaire, I'm playing alone",
  "nothing, I'm staring at the void",
  "the meaning of life, I'm contemplating it",
  "Rick Astley on repeat, I'm so lonely", // cspell:ignore Astley
  "Lo-fi girl, kinda goes with the vibe",
  "the whole universe was in a hot dense state",
  "Some russian kid, screaming about fucking my mom",
  "The matrix, blue or red pill, guys ?",
] as const;

export const singleUserStatuses = [
  "a lone wanderer",
  "one solitary soul",
  "a single user existing",
  "one person contemplating life",
  "a lone voice in the void",
  "just one user vibing",
] as const;

export const multipleUsersStatuses = [
  "{count} nerds",
  "{count} souls",
  "{count} humans",
  "{count} chatters",
  "{count} people",
  "{count} gamers that suck",
  "{count} conversing about nothing",
  "{count} people that need to get a life",
] as const satisfies readonly `${string}{count}${string}`[];

/**
 * The three presence pools, in display/iteration order. Used as the
 * `pool` discriminator on stored `BotStatusMessage` rows and as the
 * collection id in the WebUI editor routes.
 */
export const BOT_STATUS_POOLS = ["lonely", "single", "multiple"] as const;

export type BotStatusPool = (typeof BOT_STATUS_POOLS)[number];

/**
 * Built-in seed values for each pool. When the DB store for a pool is
 * empty the bot falls back to these, so behaviour is unchanged out of the
 * box and an operator can "seed defaults" to start editing from them.
 */
export const STATUS_POOL_DEFAULTS: Record<BotStatusPool, readonly string[]> = {
  lonely: lonelyStatuses,
  single: singleUserStatuses,
  multiple: multipleUsersStatuses,
};

export interface BotStatusPoolMeta {
  pool: BotStatusPool;
  /** Human-readable name shown as the editor section heading. */
  label: string;
  /** One-line explanation of when this pool is used. */
  description: string;
  /**
   * Whether every entry must contain the literal `{count}` placeholder.
   * True only for the `multiple` pool — the placeholder is substituted
   * with the live voice-channel user count at pick time. This preserves
   * the invariant the `satisfies` template-literal type guarantees for
   * the hardcoded defaults, which the DB cannot enforce by type alone.
   */
  requiresCount: boolean;
}

export const BOT_STATUS_POOL_META: Record<BotStatusPool, BotStatusPoolMeta> = {
  lonely: {
    pool: "lonely",
    label: "Empty — nobody in voice",
    description: "Shown when no users are in a tracked voice channel.",
    requiresCount: false,
  },
  single: {
    pool: "single",
    label: "One user in voice",
    description: "Shown when exactly one user is in voice.",
    requiresCount: false,
  },
  multiple: {
    pool: "multiple",
    label: "Multiple users in voice",
    description:
      "Shown when two or more users are in voice. Each entry must contain the {count} placeholder, replaced with the live user count.",
    requiresCount: true,
  },
};

/** Maximum length of a single status entry (Discord activity name cap). */
export const STATUS_TEXT_MAX = 128;

/** Narrowing type guard for a raw string that may name a pool. */
export function isBotStatusPool(value: string): value is BotStatusPool {
  return (BOT_STATUS_POOLS as readonly string[]).includes(value);
}

/**
 * Validate a single status entry for the given pool. Returns a
 * human-readable error string, or `null` when the entry is valid. Pure
 * and exported so both the write-route layer and the unit tests can share
 * one source of truth for the `{count}` invariant.
 */
export function validateStatusEntry(
  pool: BotStatusPool,
  text: string,
): string | null {
  const trimmed = text.trim();
  if (!trimmed) {
    return "Status text cannot be empty.";
  }
  if (trimmed.length > STATUS_TEXT_MAX) {
    return `Status text must be ${STATUS_TEXT_MAX} characters or fewer.`;
  }
  if (
    BOT_STATUS_POOL_META[pool].requiresCount &&
    !trimmed.includes("{count}")
  ) {
    return "Entries in the multiple-users pool must contain the {count} placeholder.";
  }
  return null;
}
