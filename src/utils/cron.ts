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
 * Whether `expression` parses as a cron expression, without logging.
 *
 * Use this where an invalid value is ordinary input rather than a fault — the
 * WebUI form handlers validate what an admin typed and answer with a field
 * error, so an error log per typo would be noise. Everything else should
 * prefer `validateCronExpression`, which reports what it rejected.
 */
export function isValidCronExpression(expression: string): boolean {
  try {
    new CronTime(sanitizeCronExpression(expression));
    return true;
  } catch {
    return false;
  }
}

/**
 * Whether `expression` parses as a cron expression, logging the rejected value
 * when it does not. Already-sanitized input is accepted unchanged, so callers
 * may sanitize first (to log or store the clean value) or pass the raw config
 * value straight in.
 *
 * The log line includes the sanitized expression, so callers do not need to
 * log the value again — and should not log it raw, since a config- or
 * database-sourced string can carry newlines.
 *
 * @param context What was being scheduled, used in the error log — a feature
 * name (`"birthdays"`) or a specific record (`"announcement 507f…"`).
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
