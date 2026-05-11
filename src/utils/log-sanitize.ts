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
  // eslint-disable-next-line no-control-regex
  const cleaned = str.replace(/[\x00-\x1f\x7f]+/g, " ");
  if (cleaned.length <= maxLength) return cleaned;
  return `${cleaned.slice(0, maxLength)}…`;
}
