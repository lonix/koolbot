import logger from "./logger.js";
import { sanitizeForLog } from "./log-sanitize.js";
import { getErrorMessage } from "./error-guards.js";
import { env } from "../config/env.js";

/**
 * Guild scoping (#1144).
 *
 * KoolBot keeps all its state for one community, the guild named by
 * `GUILD_ID`. A Discord application can be added to any guild by anyone while
 * "Public Bot" is on, and gateway events from such a guild would otherwise be
 * fed into the operator's own trackers, logs and leaderboards.
 *
 * The default behaviour here is to ignore events from any other guild and warn
 * once per guild. Leaving those guilds is a separate opt-in
 * (`core.guild_scope.leave_other_guilds`, off by default) so an operator who
 * deliberately keeps the bot in a second guild is never surprised by it.
 */

/** Guilds already reported, so a busy foreign guild logs one warning, not thousands. */
const warnedGuilds = new Set<string>();

/**
 * True when `guildId` names a guild other than the configured one.
 *
 * `null` / `undefined` (a DM, or an event with no guild) is not foreign, so DM
 * paths keep working. An unset configured guild fails open: startup refuses to
 * proceed without `GUILD_ID`, so this only matters before configuration is
 * read, and dropping every event then would be worse than letting it through.
 */
export function isForeignGuild(
  guildId: string | null | undefined,
  configuredGuildId: string | undefined,
): boolean {
  if (!guildId || !configuredGuildId) return false;
  return guildId !== configuredGuildId;
}

/**
 * Gate for event handlers: returns true when the event belongs to another
 * guild and must be ignored, logging one warning per foreign guild.
 */
export function shouldIgnoreGuild(
  guildId: string | null | undefined,
  configuredGuildId: string | undefined,
): boolean {
  if (!guildId || !isForeignGuild(guildId, configuredGuildId)) return false;
  warnForeignGuildOnce(guildId);
  return true;
}

/** Log a clear warning the first time a foreign guild is seen. */
export function warnForeignGuildOnce(guildId: string, name?: string): void {
  if (warnedGuilds.has(guildId)) return;
  warnedGuilds.add(guildId);
  const label = name
    ? `"${sanitizeForLog(name)}" (${sanitizeForLog(guildId)})`
    : sanitizeForLog(guildId);
  logger.warn(
    `Ignoring events from guild ${label}: this bot is scoped to GUILD_ID. ` +
      "Remove the bot from that guild, turn off Public Bot in the Discord " +
      "developer portal, or enable core.guild_scope.leave_other_guilds to " +
      "have the bot leave guilds other than GUILD_ID.",
  );
}

/** The slice of a discord.js `Guild` that scoping needs. */
export interface ScopableGuild {
  id: string;
  name?: string;
  leave: () => Promise<unknown>;
}

/**
 * Warn about, and when `leaveEnabled` is true leave, every guild other than
 * the configured one. Never leaves the configured guild, and does nothing at
 * all when no guild is configured. Returns the ids of the guilds it left.
 */
export async function applyGuildScope(
  guilds: Iterable<ScopableGuild>,
  configuredGuildId: string | undefined,
  leaveEnabled: boolean,
): Promise<string[]> {
  const left: string[] = [];
  if (!configuredGuildId) return left;
  for (const guild of guilds) {
    if (!isForeignGuild(guild.id, configuredGuildId)) continue;
    warnForeignGuildOnce(guild.id, guild.name);
    if (!leaveEnabled) continue;
    try {
      await guild.leave();
      left.push(guild.id);
      logger.info(
        `Left guild ${sanitizeForLog(guild.id)}: not the configured GUILD_ID ` +
          "(core.guild_scope.leave_other_guilds is on).",
      );
    } catch (error) {
      logger.error(
        `Failed to leave guild ${sanitizeForLog(guild.id)}: ${getErrorMessage(error)}`,
      );
    }
  }
  return left;
}

/** Test hook: forget which guilds were already warned about. */
export function resetForeignGuildWarnings(): void {
  warnedGuilds.clear();
}

/** The slice of a discord.js `Client` that the membership check needs. */
export interface MembershipClient {
  guilds: {
    cache: {
      get: (id: string) =>
        | {
            members: {
              cache: { has: (userId: string) => boolean };
              fetch: (options: {
                user: string;
                force: boolean;
              }) => Promise<unknown>;
            };
          }
        | undefined;
    };
  };
}

/** Runs a Discord REST call with a timeout (`CommandManager.makeDiscordApiCall`). */
export type DiscordApiCall = <T>(
  call: () => Promise<T>,
  operationName: string,
) => Promise<T>;

/**
 * Whether `userId` is a member of the configured guild, for events that carry
 * no guild (`userUpdate`, #1144).
 *
 * With the GuildMembers intent on, removals are delivered and the member cache
 * is exact, so it answers. With the intent off no removal event arrives and a
 * cached member may have left, so a cache hit is not trusted: the member is
 * read fresh from Discord, bounded by `callApi`. A failed or timed-out lookup
 * counts as "not a member" (fail closed), so a stranger's name is never
 * attributed to the guild. `userUpdate` only fires when a cached user changes
 * their profile, so this is not a hot path.
 */
export async function isConfiguredGuildMember(
  client: MembershipClient,
  configuredGuildId: string | undefined,
  userId: string,
  callApi: DiscordApiCall,
): Promise<boolean> {
  if (!configuredGuildId) return false;
  const guild = client.guilds.cache.get(configuredGuildId);
  if (!guild) return false;
  if (env.guildMembersIntent) return guild.members.cache.has(userId);
  try {
    await callApi(
      () => guild.members.fetch({ user: userId, force: true }),
      "userUpdate membership check",
    );
    return true;
  } catch (error) {
    logger.debug(
      `userUpdate membership check for ${sanitizeForLog(userId)} treated as not a member: ${getErrorMessage(error)}`,
    );
    return false;
  }
}
