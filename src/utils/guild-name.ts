import type { Client } from "discord.js";

/** What a member reads when the guild is not cached (no gateway data yet). */
export const FALLBACK_SERVER_NAME = "your server";

/**
 * The name of the configured guild for text a member reads ("Your weekly digest
 * from Koolbot Dev", #1526). Cache only: the gateway holds the guild once the
 * bot is ready, so a DM never waits on a REST call for its first line. Falls
 * back to "your server" when the guild is missing, unnamed or `guildId` is empty.
 */
export function getGuildName(client: Client, guildId: string): string {
  if (!guildId) return FALLBACK_SERVER_NAME;
  const name = client.guilds?.cache?.get(guildId)?.name?.trim();
  return name ? name : FALLBACK_SERVER_NAME;
}
