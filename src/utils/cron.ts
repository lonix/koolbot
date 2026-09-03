/**
 * Shared cron-expression helpers.
 *
 * Every scheduled service reads its schedule from config, where the value may
 * arrive wrapped in quotes (a `.env` line such as `CRON="0 9 * * *"` keeps the
 * quotes) and must be rejected rather than crashing `CronJob` at startup. Both
 * steps used to be copy-pasted into each service (#851); they live here now so
 * the parsing rules and the log format stay identical everywhere.
 */

import { CronTime } from "cron";
import logger from "./logger.js";
import { sanitizeForLog } from "./log-sanitize.js";

/** Strip surrounding whitespace and a single pair of wrapping quotes. */
export function sanitizeCronExpression(expression: string): string {
  return expression.trim().replace(/^["']|["']$/g, "");
}

/**
 * Whether `expression` parses as a cron expression. Already-sanitized input is
 * accepted unchanged, so callers may sanitize first (to log or store the clean
 * value) or pass the raw config value straight in.
 *
 * @param context Feature name used in the error log, e.g. `"birthdays"`.
 */
export function validateCronExpression(
  expression: string,
  context?: string,
): boolean {
  try {
    new CronTime(sanitizeCronExpression(expression));
    return true;
  } catch (error) {
    const suffix = context ? ` for ${context}` : "";
    logger.error(
      `Invalid cron expression${suffix}: ${sanitizeForLog(expression)}`,
      error,
    );
    return false;
  }
}
