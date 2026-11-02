/**
 * Can the bot create a channel or a category here? (#1660) The answer the
 * Picker's create row (#1658) needs, read from the same snapshot of the server
 * as the Bot permissions page (`bot-permission-check.ts`), never guessed.
 *
 * Discord lets the bot create a channel or category when it holds Manage
 * Channels server-wide. A channel under a category also needs Manage Channels
 * in that category, where an overwrite can take it away. Administrator holds
 * every permission everywhere, and discord.js's `permissions` and
 * `permissionsIn` already fold that in, so it is not special-cased here.
 *
 * Three answers: `{ ok: true }`, `{ ok: false, reason }` with a plain-text help
 * line for the Picker's hint area, and `{ ok: "unknown" }` when the permissions
 * could not be read. Unknown is its own answer: the Picker shows no create row
 * for it, and no help line either (`toPickerCreate` returns nothing).
 */

import { ChannelType, PermissionFlagsBits, type Client } from "discord.js";
import { getSnapshot, type CheckDeps } from "./bot-permission-check.js";
import { PERM } from "./bot-permission-registry.js";
import logger from "../utils/logger.js";

export type CreateTarget =
  { kind: "channel"; parentId?: string } | { kind: "category" };

export type CanCreate =
  { ok: true } | { ok: false; reason: string } | { ok: "unknown" };

/**
 * The help lines (a proposal for the owner, #1660). Plain text, no markup: the
 * Picker escapes it. Each names the permission, where to fix it and the page.
 */
export const CREATE_REASON = {
  channel: `The bot needs ${PERM.manageChannels.name} to create a channel. Give the bot's role ${PERM.manageChannels.name} in Server Settings, Roles; the Bot permissions page shows what is missing.`,
  category: `The bot needs ${PERM.manageChannels.name} to create a category. Give the bot's role ${PERM.manageChannels.name} in Server Settings, Roles; the Bot permissions page shows what is missing.`,
  parent: `The bot has ${PERM.manageChannels.name}, but the chosen category denies it for the bot, so it cannot create a channel there. Check the category's permission overwrites for the bot; the Bot permissions page shows what is missing.`,
} as const;

export async function canBotCreate(
  client: Client,
  guildId: string,
  target: CreateTarget,
  deps: CheckDeps = {},
): Promise<CanCreate> {
  const unknown: CanCreate = { ok: "unknown" };
  try {
    const snapshot = await getSnapshot(client, guildId, deps);
    const me = snapshot?.me;
    if (!snapshot || !me) return unknown;
    const bit = PermissionFlagsBits.ManageChannels;
    if (!me.permissions.has(bit)) {
      return {
        ok: false,
        reason:
          target.kind === "category"
            ? CREATE_REASON.category
            : CREATE_REASON.channel,
      };
    }
    if (target.kind === "channel" && target.parentId) {
      const parent = snapshot.channels?.get(target.parentId);
      if (!parent || parent.type !== ChannelType.GuildCategory) return unknown;
      if (!me.permissionsIn(parent).has(bit)) {
        return { ok: false, reason: CREATE_REASON.parent };
      }
    }
    return { ok: true };
  } catch (err) {
    logger.warn("Create check: permissions could not be read:", err);
    return unknown;
  }
}

/** The Picker's `create` flag (#1658) for an answer; nothing for unknown, so no row and no line. */
export function toPickerCreate(
  kind: "channel" | "category",
  answer: CanCreate,
  channelKind?: "text" | "voice",
):
  | {
      kind: "channel" | "category";
      channelKind?: "text" | "voice";
      ok: boolean;
      reason?: string;
    }
  | undefined {
  if (answer.ok === "unknown") return undefined;
  return {
    kind,
    ...(kind === "channel" && channelKind ? { channelKind } : {}),
    ok: answer.ok,
    ...(answer.ok === false ? { reason: answer.reason } : {}),
  };
}
