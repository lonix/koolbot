/**
 * The Picker's create row on the Settings pages (#1663).
 *
 * Which settings offer it is `SettingMetadata.createChannel` (the schema, not a
 * list here). Whether it can work is the bot-permission check (#1660), asked
 * once per page (`setting-create-load.ts`). This file is pure, so the views can
 * import it: `ok` shows the row, a refusal shows its help line, and an
 * unreadable answer shows nothing. The save side is `createPendingChannels` in
 * `routes/write/settings.ts`.
 */

import { ChannelType } from "discord.js";
import { channelText } from "./discord-labels.js";
import { settingsMetadata } from "../services/config-schema.js";
import type { PickerCreate } from "./setting-pickers.js";

/** Whether a setting offers the create row: a text `channel` setting that the schema flags. */
export function offersCreateChannel(key: string): boolean {
  const meta = settingsMetadata[key as keyof typeof settingsMetadata];
  return (
    meta?.type === "channel" &&
    meta.createChannel === true &&
    meta.channelKind !== "voice"
  );
}

/** The per-row callback the renderers take: the answer for a flagged row, nothing for any other. */
export function pickerCreateFor(
  answer: PickerCreate | undefined,
):
  ((r: { key: string; type: string }) => PickerCreate | undefined) | undefined {
  if (!answer) return undefined;
  return (r) =>
    r.type === "channel" && offersCreateChannel(r.key) ? answer : undefined;
}

export interface PendingCreate {
  key: string;
  /** The name as typed (already checked by `parsePickerCreateValue`). */
  name: string;
}

export interface CreatedForKey {
  key: string;
  id: string;
  /** The name Discord has. */
  name: string;
  /** False when the name already existed and was selected. */
  created: boolean;
}

export type CreatePendingResult =
  { ok: true; channels: CreatedForKey[] } | { ok: false; error: string };

/** The plain-text sentence for the flash: what was created and what was selected. */
export function createdNote(
  channels: readonly CreatedForKey[],
  labelOf: (key: string) => string,
): string {
  if (channels.length === 0) return "";
  const parts = channels.map((c) =>
    c.created
      ? `created ${channelText({ name: c.name, type: ChannelType.GuildText })} for ${labelOf(c.key)}`
      : `used the existing ${channelText({ name: c.name, type: ChannelType.GuildText })} for ${labelOf(c.key)}`,
  );
  const text = parts.join("; ");
  return ` ${text.charAt(0).toUpperCase()}${text.slice(1)}.`;
}
