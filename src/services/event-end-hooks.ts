/**
 * End-of-event hooks (#1193): work that must happen when an event ends,
 * registered by the feature that owns it. The shared teardown
 * (`event-teardown.ts`) runs every registered hook once, for a manual "End
 * event now" and for the scheduled end alike.
 *
 * The list is empty today. The clan-tags issue (#1194) registers its nickname
 * restore here.
 *
 * What a hook can rely on, and what it cannot:
 * - It runs AFTER the event has been saved as `ended` (the claim is the first
 *   step of the teardown), so host actions, self-join and assignment writes are
 *   already refused: nothing re-applies what the hook restores. Read the event
 *   fresh (`Event.findById`); the context carries ids only.
 * - It runs once per ending. A hook is not retried by the teardown, and a
 *   crash between saving `ended` and running the hooks skips them for that
 *   ending. A hook whose work must not be lost (a nickname restore) has to
 *   make itself retryable, for example by recording what is still to restore
 *   and finishing it from the scan.
 * - A hook that throws or does not finish within `HOOK_TIMEOUT_MS` is reported
 *   to the host and logged; the teardown goes on. A timed-out hook is not
 *   cancelled, so it must be safe to finish late.
 * - Hooks run one after the other, in registration order.
 */

import type { Client } from "discord.js";
import logger from "../utils/logger.js";
import { sanitizeForLog } from "../utils/log-sanitize.js";

export type EventEndTrigger = "manual" | "scheduled";

export interface EventEndHookContext {
  eventId: string;
  guildId: string;
  trigger: EventEndTrigger;
  client: Client;
}

/** A hook may return warnings (things it could not do) for the host's summary. */
export type EventEndHook = (
  ctx: EventEndHookContext,
) => Promise<string[] | void>;

export interface EventEndHookResult {
  name: string;
  ok: boolean;
  /** Shown to the host, already safe to display. */
  warnings: string[];
}

/** How long one hook may take before the teardown reports it and moves on. */
export const HOOK_TIMEOUT_MS = 60_000;

const hooks = new Map<string, EventEndHook>();

/**
 * Register a hook under a unique name (registering the same name again
 * replaces the earlier hook). Returns a function that removes it.
 */
export function registerEventEndHook(
  name: string,
  hook: EventEndHook,
): () => void {
  hooks.set(name, hook);
  return () => {
    if (hooks.get(name) === hook) hooks.delete(name);
  };
}

export function listEventEndHooks(): string[] {
  return [...hooks.keys()];
}

/** Tests only. */
export function resetEventEndHooksForTests(): void {
  hooks.clear();
}

function timeoutAfter(ms: number): {
  promise: Promise<never>;
  stop: () => void;
} {
  let handle: ReturnType<typeof setTimeout> | undefined;
  const promise = new Promise<never>((_resolve, reject) => {
    handle = setTimeout(() => reject(new Error("did not finish in time")), ms);
    handle.unref?.();
  });
  return { promise, stop: () => clearTimeout(handle) };
}

/** Run every registered hook, one at a time; one failing never stops the rest. */
export async function runEventEndHooks(
  ctx: EventEndHookContext,
  timeoutMs: number = HOOK_TIMEOUT_MS,
): Promise<EventEndHookResult[]> {
  // A snapshot: a hook registered while these run belongs to the next ending.
  const snapshot = [...hooks.entries()];
  const results: EventEndHookResult[] = [];
  for (const [name, hook] of snapshot) {
    const timer = timeoutAfter(timeoutMs);
    try {
      const warnings = await Promise.race([hook(ctx), timer.promise]);
      results.push({
        name,
        ok: true,
        warnings: Array.isArray(warnings) ? warnings : [],
      });
    } catch (error) {
      logger.error(
        `Event ${sanitizeForLog(ctx.eventId)}: end hook ${sanitizeForLog(name)} failed:`,
        error,
      );
      results.push({
        name,
        ok: false,
        warnings: [
          `The "${name}" step could not be completed${
            error instanceof Error && error.message === "did not finish in time"
              ? " (it did not finish in time)"
              : ""
          }.`,
        ],
      });
    } finally {
      timer.stop();
    }
  }
  return results;
}
