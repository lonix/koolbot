/**
 * Strip CR/LF (and other control characters) from user-controlled values
 * before interpolating them into log messages, so an attacker cannot forge
 * additional log entries by submitting input containing newlines.
 *
 * Output is truncated so a hostile payload cannot blow up the log line.
 */
export function sanitizeForLog(value: unknown, maxLength = 128): string {
  if (value === null || value === undefined) return "";
  const str = typeof value === "string" ? value : String(value);
  const cleaned = str
    // Strip CR/LF first. The explicit `\n|\r` alternation is the form CodeQL
    // recognizes as a log-injection sanitizer; the broader control-character
    // pass below uses a range that its taint tracking does not credit.
    .replace(/\n|\r/g, " ")
    // eslint-disable-next-line no-control-regex
    .replace(/[\x00-\x1f\x7f]+/g, " ");
  if (cleaned.length <= maxLength) return cleaned;
  return `${cleaned.slice(0, maxLength)}…`;
}

/**
 * Summarise an error for logging without dumping the whole object.
 *
 * A `DiscordAPIError` carries `requestBody` (the JSON that was sent, e.g. the
 * content of a DM) and `rawError` as own enumerable fields; handing the error
 * to the logger as meta serialises all of them. Log only `code`, `status`,
 * `method` and `message`, never the request payload (#1152).
 */
export function describeDiscordError(err: unknown): string {
  if (err === null || err === undefined) return "unknown error";
  if (typeof err !== "object") return sanitizeForLog(err, 256);
  const e = err as {
    name?: unknown;
    code?: unknown;
    status?: unknown;
    method?: unknown;
    message?: unknown;
  };
  const parts: string[] = [sanitizeForLog(e.name ?? "Error", 64)];
  if (e.code !== undefined) parts.push(`code=${sanitizeForLog(e.code, 32)}`);
  if (e.status !== undefined) {
    parts.push(`status=${sanitizeForLog(e.status, 16)}`);
  }
  if (e.method !== undefined) {
    parts.push(`method=${sanitizeForLog(e.method, 16)}`);
  }
  const message = typeof e.message === "string" ? e.message : "";
  return `${parts.join(" ")}${message ? `: ${sanitizeForLog(message, 256)}` : ""}`;
}
