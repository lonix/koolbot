/**
 * The Discord REST client the Channel Manager writes with (#1065), and the one
 * helper every write (create, edit, move, delete) goes through.
 *
 * The bot's shared discord.js REST client is tuned for fire-and-forget calls:
 * it retries a request up to 3 times on a transport timeout (15 s), a lost
 * connection or a 5xx, and it queues a request behind an exhausted rate-limit
 * bucket for as long as the reset takes (minutes, for the per-channel rename
 * and edit limit). Both are wrong for a write the admin is watching:
 * a create whose response was lost would be sent again, and an edit queued
 * behind a rate limit would be applied long after the page said it failed.
 *
 * So these writes use their own client: no automatic retries, and a rate limit
 * that would make a request wait longer than `RATE_LIMIT_FAST_FAIL_MS` is
 * rejected at once, for both kinds Discord applies (a bucket the client already
 * knows is empty, and an actual 429 with a retry-after). Nothing here changes
 * the shared client or any other service's retry policy.
 */

import { REST, RateLimitError, type RESTOptions } from "discord.js";
import type { CommandManager } from "../services/command-manager.js";

/** A rate-limit wait longer than this is not waited for. */
export const RATE_LIMIT_FAST_FAIL_MS = 20_000;
/** Longest a single write may take before it is cancelled. */
export const WRITE_TIMEOUT_MS = 30_000;

/** How long Discord says a rate-limited request would have to wait. */
export function rateLimitWaitMs(data: {
  timeToReset?: number;
  retryAfter?: number;
  sublimitTimeout?: number;
}): number {
  return Math.max(
    data.timeToReset ?? 0,
    data.retryAfter ?? 0,
    data.sublimitTimeout ?? 0,
  );
}

/**
 * A REST client for admin writes: one attempt per request, a timeout, and
 * rejection (not queueing) of long rate-limit waits. `makeRequest` is only for
 * tests, to stand in for the network.
 */
export function createWriteRest(
  token: string,
  makeRequest?: RESTOptions["makeRequest"],
): REST {
  return new REST({
    version: "10",
    retries: 0,
    timeout: WRITE_TIMEOUT_MS,
    rejectOnRateLimit: (data) =>
      rateLimitWaitMs(data) > RATE_LIMIT_FAST_FAIL_MS,
    ...(makeRequest ? { makeRequest } : {}),
  }).setToken(token);
}

/** The admin-facing message for a write Discord is rate limiting. */
export function rateLimitMessage(waitMs: number): string {
  const minutes = Math.ceil(waitMs / 60_000);
  const when =
    waitMs < 60_000
      ? `${Math.max(1, Math.ceil(waitMs / 1000))} seconds`
      : `${minutes} minute${minutes === 1 ? "" : "s"}`;
  return `Discord is limiting changes right now (it allows only a few renames and edits per channel every 10 minutes). Nothing was changed and the request was cancelled. Try again in about ${when}.`;
}

/** The admin-facing message for any failed write. */
export function describeWriteFailure(error: unknown): string {
  if (error instanceof RateLimitError) {
    return rateLimitMessage(rateLimitWaitMs(error));
  }
  const message = error instanceof Error ? error.message : String(error);
  const name = error instanceof Error ? error.name : "";
  if (name === "AbortError" || /timeout/i.test(message)) {
    return "Discord didn't answer within 30 seconds, so the request was cancelled and nothing should have changed. Check the channel in Discord before trying again.";
  }
  return `Discord refused the change: ${message.slice(0, 200)}`;
}

/**
 * Run one write through `makeDiscordApiCall` with an AbortSignal that is
 * aborted when the attempt fails or times out, so a request that is still
 * queued or in flight is dropped rather than applied later. A retry (only when
 * `retryOnTimeout`, i.e. an idempotent delete) aborts the previous attempt
 * first.
 */
export async function cancellableCall<T>(
  manager: Pick<CommandManager, "makeDiscordApiCall">,
  fn: (signal: AbortSignal) => Promise<T>,
  opName: string,
  retryOnTimeout: boolean,
): Promise<T> {
  let current: AbortController | null = null;
  try {
    return await manager.makeDiscordApiCall(
      () => {
        current?.abort();
        current = new AbortController();
        return fn(current.signal);
      },
      opName,
      WRITE_TIMEOUT_MS,
      3,
      retryOnTimeout,
    );
  } catch (error) {
    (current as AbortController | null)?.abort();
    throw error;
  }
}
