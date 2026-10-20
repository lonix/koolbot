/**
 * Bounded-time step runner for the graceful-shutdown sequence (#1294).
 */

import logger from "./logger.js";

/** Marker error so a timeout can be told apart from the operation failing. */
class StepTimeoutError extends Error {
  constructor(timeoutMs: number) {
    super(`Timeout after ${timeoutMs}ms`);
    this.name = "StepTimeoutError";
  }
}

/**
 * Run `operation`, giving up on it after `timeoutMs`. Never throws: it resolves
 * to the operation's result, or `null` if it failed or timed out, so a slow or
 * failing step can't block the steps after it.
 *
 * The timer is always cleared once the race settles, so a step that finishes in
 * time leaves no dangling timer. `Promise.race` does not abort the operation,
 * so on a timeout it may still complete in the background.
 *
 * A timeout is logged at `warn` without a stack, because shutdown carries on
 * regardless and a routine restart should not look like a failure. A thrown
 * error from the operation itself stays at `error`.
 */
export async function runWithTimeout<T>(
  operation: () => Promise<T>,
  timeoutMs: number,
  operationName: string,
): Promise<T | null> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const timeoutPromise = new Promise<never>((_, reject) => {
      timer = setTimeout(
        () => reject(new StepTimeoutError(timeoutMs)),
        timeoutMs,
      );
    });

    const result = await Promise.race([operation(), timeoutPromise]);
    logger.info(`✅ ${operationName} completed`);
    return result;
  } catch (error) {
    if (error instanceof StepTimeoutError) {
      logger.warn(
        `⚠️ ${operationName} timed out after ${timeoutMs}ms, continuing shutdown`,
      );
    } else {
      logger.error(`❌ Error in ${operationName}:`, error);
    }
    return null;
  } finally {
    clearTimeout(timer);
  }
}
