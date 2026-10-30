/**
 * The startup and shutdown posts to the Discord log (#1556), kept out of
 * `src/index.ts` so each can be tested on its own. Neither ever throws: a
 * failed log post must not break startup or stop the bot from shutting down.
 */

import type { DiscordLogger } from "../services/discord-logger.js";
import logger from "./logger.js";
import { runWithTimeout } from "./run-with-timeout.js";

/** How long the shutdown post may take before the shutdown carries on. */
export const SHUTDOWN_LOG_TIMEOUT_MS = 2000;

/**
 * Post "KoolBot started" once the services are up. Fire and forget: it hands
 * back at once, so a stalled or rate-limited send can never hold up readiness.
 * Posts nothing once a shutdown has begun.
 * Never throws, however the post fails.
 */
export function postStartupLog(
  discordLogger: Pick<DiscordLogger, "logBotStartup"> | undefined,
  isShuttingDown: () => boolean = () => false,
): void {
  if (!discordLogger) return;
  // A signal can arrive while the services are still starting; "started"
  // after "shutting down" would be a lie.
  if (isShuttingDown()) return;
  try {
    discordLogger.logBotStartup().catch((error: unknown) => {
      logger.error("Failed to post the startup log:", error);
    });
  } catch (error) {
    logger.error("Failed to post the startup log:", error);
  }
}

/**
 * Post "KoolBot is shutting down", best effort: gives up after
 * `timeoutMs` so a slow Discord API cannot hold up the rest of the shutdown.
 * Never throws; does nothing when the logger was never created (a signal
 * that arrives before startup got that far).
 */
export async function postShutdownLog(
  discordLogger: Pick<DiscordLogger, "logBotShutdown"> | undefined,
  timeoutMs: number = SHUTDOWN_LOG_TIMEOUT_MS,
): Promise<void> {
  if (!discordLogger) return;
  await runWithTimeout(
    () => discordLogger.logBotShutdown(),
    timeoutMs,
    "Shutdown log post",
  );
}
