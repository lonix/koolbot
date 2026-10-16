import { Client, DiscordAPIError } from "discord.js";
import logger from "../utils/logger.js";
import { sanitizeForLog } from "../utils/log-sanitize.js";

/**
 * "Expected to show up" for the admin Events page (#1175): who marked
 * Interested on an event's native Discord scheduled event, read live from
 * Discord when the page is opened. Nothing is stored.
 *
 * Bounded on purpose, because it runs inside a page render: a short timeout
 * and a single attempt per REST call, at most `MAX_PAGES` pages of
 * `PAGE_SIZE` subscribers per event, and at most `MAX_NAMES` names listed. It
 * never throws; a failure becomes an `unavailable` result the page renders as
 * a message.
 */

export const PAGE_SIZE = 100;
export const MAX_PAGES = 3;
export const MAX_NAMES = 20;
/** At most this many events are looked up per page view. */
export const MAX_EVENTS_PER_VIEW = 10;
const CALL_TIMEOUT_MS = 8000;
const DISCORD_UNKNOWN_SCHEDULED_EVENT = 10070;

export type InterestedResult =
  | {
      kind: "ok";
      /** Counted members (a lower bound when `truncated`). */
      count: number;
      /** Display names, at most `MAX_NAMES`; escape before rendering. */
      names: string[];
      /** More subscribers may exist than were read. */
      truncated: boolean;
    }
  | { kind: "unavailable"; message: string };

type ApiCaller = <T>(call: () => Promise<T>, name: string) => Promise<T>;

interface Subscriber {
  user: { id: string; username?: string; globalName?: string | null };
  member?: { displayName?: string } | null;
}

function defaultApiCaller(client: Client): ApiCaller {
  return async <T>(call: () => Promise<T>, name: string): Promise<T> => {
    const { CommandManager } = await import("./command-manager.js");
    // One attempt and a short timeout: this runs while a page is rendering.
    return CommandManager.getInstance(client).makeDiscordApiCall(
      call,
      name,
      CALL_TIMEOUT_MS,
      1,
    );
  };
}

function compareIds(a: string, b: string): number {
  const x = BigInt(a);
  const y = BigInt(b);
  return x === y ? 0 : x > y ? 1 : -1;
}

function displayName(sub: Subscriber): string {
  return (
    sub.member?.displayName || sub.user.globalName || sub.user.username || "?"
  );
}

/** Read the Interested members of one native scheduled event. Never throws. */
export async function loadInterested(
  client: Client,
  guildId: string,
  nativeEventId: string,
  callApi: ApiCaller = defaultApiCaller(client),
): Promise<InterestedResult> {
  try {
    const guild =
      client.guilds.cache.get(guildId) ??
      (await callApi(() => client.guilds.fetch(guildId), "fetch guild"));
    const native = await callApi(
      () => guild.scheduledEvents.fetch(nativeEventId),
      "fetch guild scheduled event",
    );

    const seen = new Map<string, string>();
    let after: string | undefined;
    let truncated = false;
    for (let page = 0; page < MAX_PAGES; page++) {
      // `after` is passed through by discord.js at runtime but is missing from
      // its option typings.
      const options = {
        limit: PAGE_SIZE,
        withMember: true,
        ...(after ? { after } : {}),
      } as Parameters<typeof native.fetchSubscribers>[0];
      const batch = await callApi(
        () => native.fetchSubscribers(options),
        "fetch scheduled event subscribers",
      );
      const subs = [...batch.values()] as unknown as Subscriber[];
      let fresh = 0;
      for (const sub of subs) {
        if (!seen.has(sub.user.id)) {
          seen.set(sub.user.id, displayName(sub));
          fresh += 1;
        }
      }
      if (subs.length < PAGE_SIZE || fresh === 0) break;
      after = subs.map((s) => s.user.id).sort(compareIds)[subs.length - 1];
      // A full last allowed page may have a successor we did not read.
      if (page === MAX_PAGES - 1) truncated = true;
    }

    return {
      kind: "ok",
      count: seen.size,
      names: [...seen.values()].slice(0, MAX_NAMES),
      truncated,
    };
  } catch (error) {
    if (
      error instanceof DiscordAPIError &&
      error.code === DISCORD_UNKNOWN_SCHEDULED_EVENT
    ) {
      return {
        kind: "unavailable",
        message: "The Discord event no longer exists.",
      };
    }
    logger.warn(
      `Could not read Interested members for event ${sanitizeForLog(nativeEventId)}:`,
      error,
    );
    return {
      kind: "unavailable",
      message: "Could not read Interested members from Discord right now.",
    };
  }
}
