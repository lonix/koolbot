/**
 * Discord payload limits and helpers for keeping variable-length command
 * output inside them (#840).
 *
 * Several commands build their reply by joining a variable number of rows
 * (leaderboard entries, moderation-log entries, achievements). On a guild
 * with enough data the joined text exceeds Discord's limit and the API
 * rejects the whole reply with `50035 Invalid Form Body`, so the user gets
 * nothing. The helpers here drop overflow rows (or trim a single oversized
 * row) so the payload is always deliverable.
 *
 * Lengths are measured in UTF-16 code units (`String.prototype.length`),
 * which is never smaller than Discord's own character count, so staying
 * under a limit here guarantees staying under it on Discord's side.
 */

/** Maximum length of a message's `content`. */
export const DISCORD_MESSAGE_CONTENT_LIMIT = 2000;

/** Maximum length of an embed's `description`. */
export const DISCORD_EMBED_DESCRIPTION_LIMIT = 4096;

/** Maximum length of an embed field's `value`. */
export const DISCORD_EMBED_FIELD_VALUE_LIMIT = 1024;

const DEFAULT_ELLIPSIS = "…";

/**
 * Trim `text` so it is at most `maxChars` long, replacing the cut-off tail
 * with `ellipsis`. Text that already fits is returned unchanged.
 */
export function truncateText(
  text: string,
  maxChars: number,
  ellipsis: string = DEFAULT_ELLIPSIS,
): string {
  if (text.length <= maxChars) {
    return text;
  }
  const keep = Math.max(0, maxChars - ellipsis.length);
  return keep === 0 && ellipsis.length > maxChars
    ? text.slice(0, Math.max(0, maxChars))
    : `${text.slice(0, keep)}${ellipsis}`;
}

export interface ClampToLimitOptions {
  /** String placed between rows. Defaults to a newline. */
  separator?: string;
  /**
   * Renders the trailing line that summarises the rows dropped to fit.
   * Defaults to `…and N more`.
   */
  overflowLabel?: (dropped: number) => string;
}

function defaultOverflowLabel(dropped: number): string {
  return `…and ${dropped} more`;
}

/**
 * Join `rows` with `separator`, keeping only as many leading whole rows as
 * fit within `maxChars` and appending an `…and N more` line for the rest.
 *
 * - Rows that fit are never modified, so output is stable until the limit
 *   is actually reached.
 * - When even the first row is too long on its own it is truncated rather
 *   than dropped, so the caller always gets something to show.
 * - The result is guaranteed to be at most `maxChars` long.
 */
export function clampToLimit(
  rows: readonly string[],
  maxChars: number,
  options: ClampToLimitOptions = {},
): string {
  const separator = options.separator ?? "\n";
  const overflowLabel = options.overflowLabel ?? defaultOverflowLabel;

  const joined = rows.join(separator);
  if (joined.length <= maxChars) {
    return joined;
  }

  const kept: string[] = [];
  let length = 0;

  for (let i = 0; i < rows.length; i++) {
    const row = rows[i];
    const candidate =
      length + (kept.length > 0 ? separator.length : 0) + row.length;
    const dropped = rows.length - (i + 1);
    const suffix =
      dropped > 0 ? separator.length + overflowLabel(dropped).length : 0;

    if (candidate + suffix > maxChars) {
      break;
    }
    kept.push(row);
    length = candidate;
  }

  if (kept.length === 0) {
    // Not even the first row fits alongside the overflow note: show a
    // trimmed first row so the reply is still meaningful. That row is
    // shown, so it does not count towards the dropped total.
    const dropped = rows.length - 1;
    const suffix = dropped > 0 ? `${separator}${overflowLabel(dropped)}` : "";
    const budget = maxChars - suffix.length;
    if (budget <= 0) {
      return truncateText(rows[0] ?? "", maxChars);
    }
    return `${truncateText(rows[0] ?? "", budget)}${suffix}`;
  }

  const dropped = rows.length - kept.length;
  const suffix = dropped > 0 ? `${separator}${overflowLabel(dropped)}` : "";
  return `${kept.join(separator)}${suffix}`;
}
