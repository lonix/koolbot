/**
 * Saving a Settings section that holds a pending creation (#1663).
 *
 * The Picker (#1658) posts `create:<name>` for a flagged channel setting. This
 * turns every such name of one save into channels through the shared helper
 * (`channel-create.ts`, #1659) and hands back the ids to store. Settings have
 * no Review step, so the plan and the apply happen in the same request: the
 * plan is made from a fresh read, the apply reads again inside the shared lock
 * and refuses ("changed since Review") if the answer differs, for example when
 * the name was created in between. Nothing is selected silently then.
 *
 * All names of one save go into ONE apply, so the helper's rollback covers them
 * together: either every channel exists and every id is stored, or none is
 * created and none is stored. The caller does the writes of the settings.
 */

import { REST, type Client } from "discord.js";
import { canBotCreate } from "../services/bot-create-check.js";
import { CommandManager } from "../services/command-manager.js";
import logger from "../utils/logger.js";
import type { CreatePendingResult, PendingCreate } from "./setting-create.js";
import { applyChannelPlan, planChannels } from "./channel-create.js";
import { fetchChannelViews } from "./channel-manager-data.js";
import { ChannelReadTimeoutError, readWithin } from "./channel-write-lock.js";
import { cancellableCall, createWriteRest } from "./channel-write-rest.js";

/** One write-REST client per bot token, built when first needed. */
const restByToken = new Map<string, REST>();
function writeRestFor(token: string): REST {
  let rest = restByToken.get(token);
  if (!rest) {
    rest = createWriteRest(token);
    restByToken.set(token, rest);
  }
  return rest;
}

export async function createPendingChannels(
  client: Client,
  guildId: string,
  actorId: string,
  pending: readonly PendingCreate[],
  signal?: AbortSignal,
): Promise<CreatePendingResult> {
  // The server checks again: the Picker's row is only a convenience.
  const can = await canBotCreate(client, guildId, { kind: "channel" });
  if (can.ok === false) return { ok: false, error: can.reason };
  if (can.ok !== true) {
    return {
      ok: false,
      error:
        "KoolBot could not check whether it may create channels, so nothing was created. Try again.",
    };
  }
  if (!client.token) {
    return {
      ok: false,
      error: "The bot isn't signed in to Discord yet, so nothing was created.",
    };
  }
  const entries = pending.map((p) => ({
    kind: "text" as const,
    name: p.name,
  }));
  try {
    const guild = await readWithin(() => client.guilds.fetch(guildId));
    const live = await readWithin(() => fetchChannelViews(guild));
    const plan = planChannels(entries, live);
    if (!plan.ok) return { ok: false, error: plan.errors.join(" ") };
    const manager = CommandManager.getInstance(client);
    const applied = await applyChannelPlan(
      {
        guildId,
        rest: writeRestFor(client.token),
        call: (fn, opName, retryOnTimeout) =>
          cancellableCall(manager, fn, opName, retryOnTimeout),
        listChannels: () => fetchChannelViews(guild),
        reason: `KoolBot web UI, by ${actorId}`,
        signal,
      },
      entries,
      plan.planId,
    );
    if (!applied.ok) return { ok: false, error: applied.error };
    return {
      ok: true,
      channels: applied.channels.map((c, i) => ({
        key: pending[i].key,
        id: c.id,
        name: c.name,
        created: c.created,
      })),
    };
  } catch (error) {
    logger.warn("settings: creating channels failed", error);
    return {
      ok: false,
      error:
        error instanceof ChannelReadTimeoutError
          ? error.message
          : "KoolBot couldn't read the channels from Discord, so nothing was created. Try again.",
    };
  }
}
