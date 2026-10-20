import { REST, RESTEvents, type RateLimitData } from "discord.js";
import logger from "./logger.js";
import { sanitizeForLog } from "./log-sanitize.js";

/**
 * One shared REST client for guild/global command calls (#1307). discord.js
 * tracks rate-limit buckets per REST instance, so separate instances each
 * think a route is free and a second one can queue behind a limit the first
 * already hit. Keeping a single instance also means the RateLimited listener
 * (#1293) sits on the client that actually sends the requests.
 *
 * Standalone operational scripts (unregister-guild-commands,
 * cleanup-global-commands) run in their own process and keep their own client.
 */
let sharedRest: REST | undefined;
let sharedToken: string | undefined;

/**
 * Log every 429 that @discordjs/rest handles internally. The client queues
 * and waits out a rate limit without raising an error, so without this a
 * stalled request is only ever seen as a timeout. Only the route template,
 * method, scope and timings are logged; never the token, the request body or
 * the bucket hash.
 */
function logRestRateLimits(rest: REST): void {
  rest.on(RESTEvents.RateLimited, (info: RateLimitData) => {
    logger.warn(
      `Discord REST rate limited: ${sanitizeForLog(info.method, 16)} ${sanitizeForLog(info.route, 128)} ` +
        `(scope=${sanitizeForLog(info.scope, 16)}, global=${info.global}, limit=${Number(info.limit)}, ` +
        `retryAfter=${Number(info.retryAfter)}ms, timeToReset=${Number(info.timeToReset)}ms)`,
    );
  });
}

/** Return the shared REST client, creating it on first use (or if the token changed). */
export function getSharedRest(token: string): REST {
  if (!sharedRest || sharedToken !== token) {
    sharedRest = new REST({ version: "10" }).setToken(token);
    sharedToken = token;
    logRestRateLimits(sharedRest);
  }
  return sharedRest;
}

/** Test helper: drop the shared instance. */
export function resetSharedRest(): void {
  sharedRest = undefined;
  sharedToken = undefined;
}
