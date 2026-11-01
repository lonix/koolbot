/**
 * Does the bot hold the Discord Administrator permission in the server? (#1617)
 *
 * The Setup wizard asks for it at the start and again at Review, because the
 * easy path is to give the bot Administrator when it is invited and narrow it
 * afterwards (Bot permissions). The check is read-only and cheap:
 *
 * - It reads the bot's own member (`me.permissions`), which folds in every role
 *   the bot holds, so an Administrator role added by hand counts as much as the
 *   managed role's own bits. The bot permission check (`bot-permission-check.ts`)
 *   is not used: it reads the role's own bits and reuses a read for 30 seconds,
 *   which would show the old answer to an admin who just fixed it in Discord.
 * - First view: the gateway cache. After *Check again* and at Apply
 *   (`refresh: true`): the server's roles and the bot's member are read again
 *   through the shared REST backoff (the member's permissions are worked out
 *   from the role cache, so both must be fresh).
 * - It never guesses. When the server, the bot's membership or its roles cannot
 *   be read, the answer is `unknown`, which the wizard says out loud and never
 *   treats as "has" or "lacks".
 * - Nothing is stored and nothing is logged beyond a debug line.
 */

import { PermissionFlagsBits, type Client, type Guild } from "discord.js";
import { defaultCall } from "./bot-permission-check.js";
import logger from "../utils/logger.js";

export type AdministratorCheck =
  | { state: "has" }
  | { state: "missing" }
  | { state: "unknown"; reason: string };

export interface AdministratorCheckOptions {
  /** Read the bot's member from Discord instead of trusting the gateway cache. */
  refresh?: boolean;
  /** Test seam: the REST wrapper. */
  call?: <T>(fn: () => Promise<T>, name: string) => Promise<T>;
}

const UNKNOWN = (reason: string): AdministratorCheck => ({
  state: "unknown",
  reason,
});

export async function checkBotAdministrator(
  client: Client,
  guildId: string,
  opts: AdministratorCheckOptions = {},
): Promise<AdministratorCheck> {
  const call =
    opts.call ??
    (<T>(fn: () => Promise<T>, name: string): Promise<T> =>
      defaultCall(client, fn, name));
  try {
    let guild: Guild | undefined = client.guilds?.cache?.get(guildId);
    if (!guild)
      guild = await call(() => client.guilds.fetch(guildId), "admin-guild");
    const members = guild?.members;
    if (!members) return UNKNOWN("The bot could not read this server.");
    let me = members.me;
    if (opts.refresh || !me) {
      try {
        // `me.permissions` resolves the member's role ids against the guild's
        // role cache, so a refresh reads the roles too: a member read alone
        // would answer from stale role bits.
        if (opts.refresh) {
          const roles = guild?.roles;
          if (!roles)
            return UNKNOWN("The bot could not read this server's roles.");
          await call(() => roles.fetch(), "admin-roles");
        }
        me = await call(() => members.fetchMe({ force: true }), "admin-me");
      } catch (err) {
        logger.debug(
          "Wizard: the bot's own membership could not be read:",
          err,
        );
        return UNKNOWN("Discord could not be reached.");
      }
    }
    // Without the bot's roles in view, `permissions` reads as empty and would
    // look like "lacks Administrator".
    if (!me || !me.roles?.cache || me.roles.cache.size === 0) {
      return UNKNOWN("The bot's own roles could not be read.");
    }
    return me.permissions.has(PermissionFlagsBits.Administrator)
      ? { state: "has" }
      : { state: "missing" };
  } catch (err) {
    logger.debug("Wizard: the Administrator check could not run:", err);
    return UNKNOWN("The bot could not read this server.");
  }
}

/**
 * The invite link that asks for Administrator, from the application id. Null
 * when the bot does not know its own id. Whether Discord applies new bits to the
 * bot's existing role when it is invited again is not verified, so the wizard
 * also names the role setting in Discord.
 */
export function administratorInviteUrl(client: Client): string | null {
  const id = client.application?.id ?? client.user?.id;
  if (!id || !/^\d{1,25}$/.test(id)) return null;
  return `https://discord.com/oauth2/authorize?client_id=${id}&permissions=8&scope=bot%20applications.commands`;
}
