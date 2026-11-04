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
 * A save may hold text channels and categories (#1664: the events section has
 * both `events.announcement_channel_id` and `events.category_id`); the
 * permission is checked for each kind present and every name goes into the same
 * apply. Two settings that type the same new CATEGORY share one (the list is
 * de-duplicated before planning); a repeated text channel name is still
 * refused by the helper, as before.
 *
 * All names of one save go into ONE apply, so the helper's rollback covers them
 * together: either every channel exists and every id is stored, or none is
 * created and none is stored. The caller does the writes of the settings.
 */

import { REST, type Client } from "discord.js";
import { canBotCreate } from "../services/bot-create-check.js";
import { CommandManager } from "../services/command-manager.js";
import logger from "../utils/logger.js";
import type {
  CreatedForKey,
  CreatePendingResult,
  PendingCreate,
} from "./setting-create.js";
import {
  applyChannelPlan,
  normaliseChannelName,
  planChannels,
  type ChannelPlanEntry,
} from "./channel-create.js";
import type { ManagedChannelView } from "./channel-manager.js";
import { fetchChannelViews } from "./channel-manager-data.js";
import { ChannelReadTimeoutError, readWithin } from "./channel-write-lock.js";
import { cancellableCall, createWriteRest } from "./channel-write-rest.js";

/** One write-REST client per bot token, built when first needed. */
const restByToken = new Map<string, REST>();
export function writeRestFor(token: string): REST {
  let rest = restByToken.get(token);
  if (!rest) {
    rest = createWriteRest(token);
    restByToken.set(token, rest);
  }
  return rest;
}

/** The pending names of one save, one group per channel or category to plan. */
interface PendingGroup {
  /** The first entry of the group: what is planned. */
  rep: PendingCreate;
  /** Every setting that points at it, in order. */
  keys: string[];
}

/**
 * Two settings that type the same new category name (compared as the helper
 * does, ignoring case) are one group, so ONE category is created and both get
 * its id. Text channels are never merged here: a repeated name stays two
 * entries and the helper refuses it, as it always has.
 */
function groupPending(pending: readonly PendingCreate[]): PendingGroup[] {
  const groups: PendingGroup[] = [];
  const byName = new Map<string, PendingGroup>();
  for (const p of pending) {
    if (p.kind === "category") {
      const id = normaliseChannelName("category", p.name).toLowerCase();
      const group = byName.get(id);
      if (group) {
        group.keys.push(p.key);
        continue;
      }
      const made = { rep: p, keys: [p.key] };
      byName.set(id, made);
      groups.push(made);
      continue;
    }
    groups.push({ rep: p, keys: [p.key] });
  }
  return groups;
}

/** The permission, asked for each kind the save holds; the refusal to give, or null. */
async function createRefusal(
  client: Client,
  guildId: string,
  pending: readonly PendingCreate[],
): Promise<string | null> {
  const targets: Array<{
    kind: "text" | "category";
    target: Parameters<typeof canBotCreate>[2];
  }> = [];
  if (pending.some((p) => p.kind !== "category")) {
    targets.push({ kind: "text", target: { kind: "channel" } });
  }
  if (pending.some((p) => p.kind === "category")) {
    targets.push({ kind: "category", target: { kind: "category" } });
  }
  for (const { kind, target } of targets) {
    const can = await canBotCreate(client, guildId, target);
    if (can.ok === false) return can.reason;
    if (can.ok !== true) {
      return `KoolBot could not check whether it may create ${kind === "category" ? "categories" : "channels"}, so nothing was created. Try again.`;
    }
  }
  return null;
}

export async function createPendingChannels(
  client: Client,
  guildId: string,
  actorId: string,
  pending: readonly PendingCreate[],
  signal?: AbortSignal,
): Promise<CreatePendingResult> {
  // The server checks again: the Picker's row is only a convenience.
  const refusal = await createRefusal(client, guildId, pending);
  if (refusal) return { ok: false, error: refusal };
  if (!client.token) {
    return {
      ok: false,
      error: "The bot isn't signed in to Discord yet, so nothing was created.",
    };
  }
  try {
    const guild = await readWithin(() => client.guilds.fetch(guildId));
    const live = await readWithin(() => fetchChannelViews(guild));
    const groups = groupPending(pending);
    const reps = groups.map((g) => g.rep);
    const resolved = resolveExisting(reps, live);
    if (!resolved.ok) return { ok: false, error: resolved.error };
    const entries = resolved.entries;
    const before = matchSignature(reps, live);
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
        // The entries were decided from the read above, outside the lock: a
        // match that appeared (or became ambiguous) since refuses the apply.
        liveUnchanged: (now) => matchSignature(reps, now) === before,
      },
      entries,
      plan.planId,
    );
    if (!applied.ok) return { ok: false, error: applied.error };
    const channels: CreatedForKey[] = [];
    groups.forEach((group, i) => {
      const made = applied.channels[i];
      group.keys.forEach((key, n) => {
        channels.push({
          key,
          id: made.id,
          name: made.name,
          // The settings after the first use what the first one created.
          created: made.created && n === 0,
          kind: group.rep.kind ?? "text",
        });
      });
    });
    return { ok: true, channels };
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

export const AMBIGUOUS_NAME_MESSAGE =
  "More than one text channel on this server has that name. Pick the one you want from the list.";
export const AMBIGUOUS_CATEGORY_MESSAGE =
  "More than one category on this server has that name. Pick the one you want from the list.";

/**
 * One entry per pending name. The helper only looks for an existing channel in
 * the entry's own parent (none, top level), so a name that already exists
 * inside a category would be created again at the top. The caller looks across
 * the whole server first: one normalised match keeps its own parent, so the
 * helper selects it; two or more are ambiguous and refused.
 */
function matchesOf(
  kind: "text" | "category",
  name: string,
  live: readonly ManagedChannelView[],
): ManagedChannelView[] {
  const wanted = normaliseChannelName(kind, name).toLowerCase();
  return live.filter(
    (c) =>
      c.kind === kind &&
      normaliseChannelName(kind, c.name).toLowerCase() === wanted,
  );
}

export function resolveExisting(
  pending: readonly PendingCreate[],
  live: readonly ManagedChannelView[],
): { ok: true; entries: ChannelPlanEntry[] } | { ok: false; error: string } {
  const entries: ChannelPlanEntry[] = [];
  for (const p of pending) {
    const kind = p.kind ?? "text";
    const matches = matchesOf(kind, p.name, live);
    if (matches.length > 1) {
      return {
        ok: false,
        error:
          kind === "category"
            ? AMBIGUOUS_CATEGORY_MESSAGE
            : AMBIGUOUS_NAME_MESSAGE,
      };
    }
    // A category has no parent, so only a text channel keeps the one it has.
    entries.push({
      kind,
      name: p.name,
      ...(kind === "text" && matches.length === 1
        ? { parentId: matches[0].parentId }
        : {}),
    });
  }
  return { ok: true, entries };
}

/** The ids matching each pending name, in order: what the entries were decided from. */
export function matchSignature(
  pending: readonly PendingCreate[],
  live: readonly ManagedChannelView[],
): string {
  return JSON.stringify(
    pending.map((p) =>
      matchesOf(p.kind ?? "text", p.name, live)
        .map((c) => `${c.id}:${c.parentId ?? ""}`)
        .sort(),
    ),
  );
}
