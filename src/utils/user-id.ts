/**
 * Discord user-id matching for collections that hold legacy id formats.
 *
 * Quotes imported before ids were normalised carry `<@123>`, `<@!123>` or
 * `@123` rather than a bare snowflake, so any lookup that matches only the
 * clean id silently misses them (#775, #958). Every path that queries or
 * compares a stored user id against a member must go through here, so the
 * readers, the counters and the purge all agree on which rows are theirs.
 */

/**
 * Normalize a Discord user ID from various formats to a clean numeric ID.
 * Handles: `<@123>`, `<@!123>`, `@username`, or plain `123`.
 * Returns the numeric ID, or the original string if not parseable.
 */
export function normalizeUserId(input: string): string {
  // Extract ID from mention formats: <@123> or <@!123>
  const mentionMatch = input.match(/^<@!?(\d+)>$/);
  if (mentionMatch) {
    return mentionMatch[1];
  }

  // Remove leading @ if present
  const cleanInput = input.replace(/^@/, "");

  // If it's a numeric ID, return it
  if (/^\d+$/.test(cleanInput)) {
    return cleanInput;
  }

  // Return original if we can't parse it (might be a username)
  return input;
}

/**
 * Every stored form a user id may appear in, for matching against fields such
 * as `authorId` / `addedById`.
 */
export function userIdMatchForms(userId: string): string[] {
  const normalizedId = normalizeUserId(userId);
  return [
    normalizedId,
    `<@${normalizedId}>`,
    `<@!${normalizedId}>`,
    `@${normalizedId}`,
  ];
}

/**
 * True when `stored` — in any of its legacy forms — is the same user as
 * `userId`. For comparing a row already in hand, where a `$in` query is not
 * available.
 */
export function isSameUserId(stored: unknown, userId: string): boolean {
  return (
    typeof stored === "string" &&
    normalizeUserId(stored) === normalizeUserId(userId)
  );
}
