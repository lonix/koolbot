/**
 * The page-wide answer for the Picker's create row on the Settings pages
 * (#1663): the bot-permission check (#1660), asked once for a text channel.
 */

import type { Client } from "discord.js";
import { canBotCreate, toPickerCreate } from "../services/bot-create-check.js";
import { offersCreateChannel } from "./setting-create.js";
import type { PickerCreate } from "./setting-pickers.js";

/**
 * The page-wide answer for a text channel, or nothing when no row of the page
 * is flagged (no permission read is made then) or the permissions could not be
 * read.
 */
export async function loadCreateChannelAnswer(
  client: Client,
  guildId: string,
  keys: readonly string[],
): Promise<PickerCreate | undefined> {
  if (!keys.some(offersCreateChannel)) return undefined;
  return toPickerCreate(
    "channel",
    await canBotCreate(client, guildId, { kind: "channel" }),
    "text",
  );
}
