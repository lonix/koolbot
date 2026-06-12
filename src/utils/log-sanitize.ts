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
