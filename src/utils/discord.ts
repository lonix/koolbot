/**
 * Shared Discord client helpers.
 */

import { DiscordAPIError, type Client } from "discord.js";
import logger from "./logger.js";

const DEFAULT_MAX_WAIT_MS = 30_000;
const POLL_INTERVAL_MS = 500;

/**
 * Resolve once the gateway client is ready, or after `maxWaitMs` has elapsed.
 *
 * Services call this at the top of `initialize()` so their first guild/channel
 * fetch doesn't race the gateway handshake. Seven services carried their own
 * copy of this wait (#851); four of them polled forever, which meant a client
 * that never connected left initialization hanging with no diagnostic. The
 * shared version always gives up after `maxWaitMs` and logs a warning, so the
 * caller continues and its own error handling reports the real failure.
 *
 * Both the `ready` event and the poll are used: the event covers the normal
 * case, the poll covers a `ready` that fired between the `isReady()` check and
 * the listener being attached. The interval is unref'd so a pending wait never
 * keeps the process alive on its own.
 *
 * @param label Service name used in the timeout warning.
 */
export async function waitForClientReady(
  client: Client,
  label: string,
  maxWaitMs: number = DEFAULT_MAX_WAIT_MS,
): Promise<void> {
  if (client.isReady()) {
    return;
  }

  return new Promise((resolve) => {
    let resolved = false;
    let elapsed = 0;

    const cleanup = (): void => {
      if (resolved) {
        return;
      }
      resolved = true;
      client.off("ready", onReady);
      clearInterval(intervalId);
    };

    const onReady = (): void => {
      cleanup();
      resolve();
    };

    const intervalId = setInterval(() => {
      if (client.isReady()) {
        cleanup();
        resolve();
        return;
      }

      elapsed += POLL_INTERVAL_MS;
      if (elapsed >= maxWaitMs) {
        logger.warn(
          `${label}: client did not become ready within the expected time; continuing anyway.`,
        );
        cleanup();
        resolve();
      }
    }, POLL_INTERVAL_MS);

    // Don't keep the event loop alive solely for this readiness poll.
    intervalId.unref?.();

    client.once("ready", onReady);
  });
}

/** Discord's "Unknown Message": the post is already gone. */
const DISCORD_UNKNOWN_MESSAGE = 10008;
/** Discord's "Unknown Channel": the channel, and everything in it, is gone. */
const DISCORD_UNKNOWN_CHANNEL = 10003;

export function isUnknownMessageError(error: unknown): boolean {
  return (
    error instanceof DiscordAPIError && error.code === DISCORD_UNKNOWN_MESSAGE
  );
}

export function isUnknownChannelError(error: unknown): boolean {
  return (
    error instanceof DiscordAPIError && error.code === DISCORD_UNKNOWN_CHANNEL
  );
}

/**
 * A post that was to be edited is definitively gone — the message itself, or
 * the whole channel holding it.
 *
 * Thrown rather than returned because the callers of an edit want the normal
 * path to be "it landed"; a caller that cares about the difference between
 * "gone" and "failed" asks with {@link isMissingPostError}. That difference
 * matters to a per-user purge (#916): re-rendering a post to strip someone's
 * name is *complete* when the post no longer exists, and reporting it as a
 * failure would tell the member their name is still on screen when nothing
 * of the sort is left.
 */
export class MissingPostError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "MissingPostError";
  }
}

/**
 * Whether a failed message operation failed because the post is gone, as
 * opposed to a transient, permission or configuration failure.
 */
export function isMissingPostError(error: unknown): boolean {
  return (
    error instanceof MissingPostError ||
    isUnknownMessageError(error) ||
    isUnknownChannelError(error)
  );
}
