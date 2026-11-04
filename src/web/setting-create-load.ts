/**
 * The page-wide answer for the Picker's create row on the Settings pages
 * (#1663): the bot-permission check (#1660), asked once for a text channel.
 */

import type { Client } from "discord.js";
import { canBotCreate, toPickerCreate } from "../services/bot-create-check.js";
import { offersCreateCategory, offersCreateChannel } from "./setting-create.js";
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

/**
 * The page-wide answer for the category create row (#1664): the same check made
 * for a category, asked once and only when a flagged category setting is on the
 * page. Nothing when none is, or when the permissions could not be read.
 */
export async function loadCreateCategoryAnswer(
  client: Client,
  guildId: string,
  keys: readonly string[],
): Promise<PickerCreate | undefined> {
  if (!keys.some(offersCreateCategory)) return undefined;
  return toPickerCreate(
    "category",
    await canBotCreate(client, guildId, { kind: "category" }),
  );
}

/**
 * The same answer for a page whose channel choice is not a settings key (the
 * Announcements and Polls forms, #1665): one `canBotCreate` per page, nothing
 * when the permissions could not be read.
 */
export async function loadTextChannelCreateAnswer(
  client: Client,
  guildId: string,
): Promise<PickerCreate | undefined> {
  return toPickerCreate(
    "channel",
    await canBotCreate(client, guildId, { kind: "channel" }),
    "text",
  );
}
