/**
 * The wizard's feature steps create the channels their settings point at
 * (#1662): what Review shows and what Apply does.
 *
 * A step records a planned creation per setting key (`WizardState.creations`,
 * by `parsePickerCreateValue` on the step's POST). Nothing is created then.
 * Review and Apply both turn those into ONE plan through `planFromLive`, so the
 * plan id Review showed is the plan id Apply must reproduce:
 *
 *  - Two settings that type the same new name (normalised alike, any case)
 *    share one channel and both point at it (the owner's call, listed as a
 *    decision in the PR). The helper would refuse a name that appears twice in
 *    a plan, so the entries are de-duplicated here, before planning.
 *  - A name matching exactly one existing text channel anywhere on the server
 *    selects it with its own parent; two or more are refused (the Settings
 *    save's rule, `setting-create-save.ts`, whose functions are reused).
 *  - Creation goes through the shared helper only: `planChannels` for the
 *    preview and `applyChannelPlan` for the apply, which takes the per-server
 *    lock itself and refuses ("changed since Review") when the live server no
 *    longer gives the reviewed plan id. The helper creates channels with no
 *    permission overwrites and no parent.
 *
 * The caller (`routes/write/wizard.ts`) stores the returned ids and removes the
 * channels again with `undo` when something after the creation fails.
 */

import { ChannelType, type Client } from "discord.js";
import { canBotCreate } from "../services/bot-create-check.js";
import { CommandManager } from "../services/command-manager.js";
import { settingsMetadata } from "../services/config-schema.js";
import { ConfigService } from "../services/config-service.js";
import type { WizardCreation } from "../services/wizard-service.js";
import logger from "../utils/logger.js";
import {
  applyChannelPlan,
  normaliseChannelName,
  planChannels,
  removeCreatedChannels,
  type ChannelPlanEntry,
} from "./channel-create.js";
import type { ManagedChannelView } from "./channel-manager.js";
import { fetchChannelViews } from "./channel-manager-data.js";
import {
  ChannelReadTimeoutError,
  readWithin,
  withChannelLock,
} from "./channel-write-lock.js";
import { cancellableCall } from "./channel-write-rest.js";
import { channelText } from "./discord-labels.js";
import type { PlannedCreation } from "./wizard-create-review.js";
import {
  matchSignature,
  resolveExisting,
  writeRestFor,
} from "./setting-create-save.js";
import { offersCreateChannel } from "./setting-create.js";

export type WizardCreations = Record<string, WizardCreation>;

const NOT_CHECKED =
  "KoolBot could not check whether it may create channels, so nothing was created. Try again.";
const NOT_READ =
  "KoolBot couldn't read the channels from Discord, so nothing was created. Try again.";
const NOT_SIGNED_IN =
  "The bot isn't signed in to Discord yet, so nothing was created.";

/**
 * The planned creations that still count: a flagged channel key that belongs to
 * a feature the admin chose. Anything else (a stale key, a feature no longer
 * chosen) is ignored, so Review and Apply never act on it.
 */
export function activeWizardCreations(
  state: {
    selectedFeatures: readonly string[];
    creations?: WizardCreations;
  },
  featureSettings: Record<string, string[]>,
): WizardCreations {
  const allowed = new Set(
    state.selectedFeatures.flatMap((f) => featureSettings[f] ?? []),
  );
  const out: WizardCreations = {};
  for (const key of Object.keys(state.creations ?? {}).sort()) {
    if (allowed.has(key) && offersCreateChannel(key)) {
      out[key] = (state.creations as WizardCreations)[key];
    }
  }
  return out;
}

/** The label of a setting as the pages show it. */
export function settingLabelOf(key: string): string {
  return (
    (settingsMetadata as Record<string, { label?: string } | undefined>)[key]
      ?.label ?? key
  );
}

interface NameGroup {
  /** The name as first typed for this group. */
  name: string;
  /** The setting keys that point at the channel, sorted. */
  keys: string[];
}

/** One group per normalised name, in the order of each group's first key. */
function groupByName(creations: WizardCreations): NameGroup[] {
  const groups = new Map<string, NameGroup>();
  for (const key of Object.keys(creations).sort()) {
    const { name } = creations[key];
    const id = normaliseChannelName("text", name).toLowerCase();
    const group = groups.get(id);
    if (group) group.keys.push(key);
    else groups.set(id, { name, keys: [key] });
  }
  return [...groups.values()];
}

type Planned =
  | {
      ok: true;
      groups: NameGroup[];
      entries: ChannelPlanEntry[];
      plan: Extract<ReturnType<typeof planChannels>, { ok: true }>;
      /** What the entries were decided from; see `liveUnchanged`. */
      signature: string;
    }
  | { ok: false; error: string };

function planFromLive(
  creations: WizardCreations,
  live: readonly ManagedChannelView[],
): Planned {
  const groups = groupByName(creations);
  const pending = groups.map((g) => ({ key: g.keys[0], name: g.name }));
  const resolved = resolveExisting(pending, live);
  if (!resolved.ok) return { ok: false, error: resolved.error };
  const plan = planChannels(resolved.entries, live);
  if (!plan.ok) return { ok: false, error: plan.errors.join(" ") };
  return {
    ok: true,
    groups,
    entries: resolved.entries,
    plan,
    signature: matchSignature(pending, live),
  };
}

/** `A`, `A and B`, `A, B and C`. */
function joinLabels(labels: readonly string[]): string {
  if (labels.length <= 1) return labels.join("");
  return `${labels.slice(0, -1).join(", ")} and ${labels[labels.length - 1]}`;
}

async function readLive(
  client: Client,
  guildId: string,
): Promise<ManagedChannelView[]> {
  const guild = await readWithin(() => client.guilds.fetch(guildId));
  return readWithin(() => fetchChannelViews(guild));
}

export interface WizardCreateReview {
  /** The channels Apply would create, for `renderCreateReview`. */
  creations: PlannedCreation[];
  /** One row per setting for Review's table: the key and what it will point at. */
  rows: Array<[string, string]>;
  /** The plan Apply must reproduce; null when nothing is planned or it has a problem. */
  planId: string | null;
  /** Why Apply cannot go ahead; empty when it can. */
  problems: string[];
}

const NONE: WizardCreateReview = {
  creations: [],
  rows: [],
  planId: null,
  problems: [],
};

/**
 * What Review shows for the planned creations, with nothing written. The
 * permission is checked here too, so a bot that cannot create blocks Apply
 * with the reason instead of failing there.
 */
export async function reviewWizardCreations(
  client: Client,
  guildId: string,
  creations: WizardCreations,
): Promise<WizardCreateReview> {
  if (Object.keys(creations).length === 0) return NONE;
  const refuse = (problem: string): WizardCreateReview => ({
    ...NONE,
    problems: [problem],
  });
  const can = await canBotCreate(client, guildId, { kind: "channel" });
  if (can.ok === false) return refuse(can.reason);
  if (can.ok !== true) return refuse(NOT_CHECKED);
  let live: ManagedChannelView[];
  try {
    live = await readLive(client, guildId);
  } catch (error) {
    logger.warn("wizard: review could not read the channels", error);
    return refuse(
      error instanceof ChannelReadTimeoutError ? error.message : NOT_READ,
    );
  }
  const planned = planFromLive(creations, live);
  if (!planned.ok) return refuse(planned.error);
  const toCreate: PlannedCreation[] = [];
  const rows: Array<[string, string]> = [];
  planned.groups.forEach((group, i) => {
    const entry = planned.plan.entries[i];
    const text = channelText({ name: entry.name, type: ChannelType.GuildText });
    if (entry.action === "create") {
      toCreate.push({
        kind: "text",
        name: entry.name,
        settingLabel: joinLabels(group.keys.map(settingLabelOf)),
        parent: null,
      });
    }
    for (const key of group.keys) {
      rows.push([
        key,
        `${text} (${entry.action === "create" ? "will be created" : "existing channel"})`,
      ]);
    }
  });
  rows.sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0));
  return {
    creations: toCreate,
    rows,
    planId: planned.plan.planId,
    problems: [],
  };
}

export interface CreatedForSetting {
  key: string;
  id: string;
  /** The name Discord has. */
  name: string;
  /** False when the name already existed and was selected. */
  created: boolean;
}

/** What became of the channels one apply created, once something after the creation failed. */
export interface ChannelCleanup {
  /** Deleted again. */
  removed: string[];
  /** Left in place because a saved setting points at them. */
  kept: string[];
  /** Could not be deleted, or could not be decided: they may still exist. */
  stuck: string[];
}

export type WizardCreateApply =
  | {
      ok: true;
      /** One per setting key, to store. */
      channels: CreatedForSetting[];
      /**
       * After a failure that came later: decide per created channel, inside the
       * shared lock and from a fresh read of the stored settings. A channel
       * that any stored setting still (or now) points at is kept and reported;
       * the rest are deleted. A read that fails keeps every channel and says so.
       */
      cleanup: () => Promise<ChannelCleanup>;
    }
  | {
      ok: false;
      /** The helper's whole message. */
      error: string;
      /** Only why a create failed; absent when no create was attempted (a refusal). */
      cause?: string;
      /** Channels this call created and removed again, and ones it could not remove. */
      removed?: string[];
      stuck?: string[];
    };

/** The ids a stored setting value names: the value itself, or the entries of a comma list or array. */
export function idsIn(value: unknown): string[] {
  if (Array.isArray(value)) return value.flatMap(idsIn);
  if (typeof value === "string") {
    return value.split(",").map((v) => v.trim());
  }
  if (typeof value === "number") return [String(value)];
  return [];
}

/**
 * Creates the planned channels in one go, for the plan Review showed. The
 * permission, the live server and the plan id are checked again; nothing is
 * created unless they all agree, and one failure removes what the same call
 * had created (the helper's rollback).
 */
export async function applyWizardCreations(
  client: Client,
  guildId: string,
  actorId: string,
  creations: WizardCreations,
  reviewedPlanId: string,
  signal?: AbortSignal,
): Promise<WizardCreateApply> {
  const can = await canBotCreate(client, guildId, { kind: "channel" });
  if (can.ok === false) return { ok: false, error: can.reason };
  if (can.ok !== true) return { ok: false, error: NOT_CHECKED };
  if (!client.token) return { ok: false, error: NOT_SIGNED_IN };
  try {
    const guild = await readWithin(() => client.guilds.fetch(guildId));
    const live = await readWithin(() => fetchChannelViews(guild));
    const planned = planFromLive(creations, live);
    if (!planned.ok) return { ok: false, error: planned.error };
    const manager = CommandManager.getInstance(client);
    const deps = {
      guildId,
      rest: writeRestFor(client.token),
      call: <T>(
        fn: (signal: AbortSignal) => Promise<T>,
        opName: string,
        retryOnTimeout: boolean,
      ): Promise<T> => cancellableCall(manager, fn, opName, retryOnTimeout),
      listChannels: (): Promise<ManagedChannelView[]> =>
        fetchChannelViews(guild),
      reason: `KoolBot web UI, setup wizard, by ${actorId}`,
      signal,
      // The entries were decided from the read above, outside the lock: a
      // match that appeared (or became ambiguous) since refuses the apply.
      liveUnchanged: (now: readonly ManagedChannelView[]): boolean => {
        const again = planFromLive(creations, now);
        return again.ok && again.signature === planned.signature;
      },
    };
    const applied = await applyChannelPlan(
      deps,
      planned.entries,
      reviewedPlanId,
    );
    if (!applied.ok) {
      return {
        ok: false,
        error: applied.error,
        cause: applied.cause,
        removed: applied.removed,
        stuck: applied.stuck,
      };
    }
    const channels: CreatedForSetting[] = [];
    planned.groups.forEach((group, i) => {
      const made = applied.channels[i];
      for (const key of group.keys) {
        channels.push({
          key,
          id: made.id,
          name: made.name,
          created: made.created,
        });
      }
    });
    const createdIds = applied.channels
      .filter((c) => c.created)
      .map((c) => c.id);
    return {
      ok: true,
      channels,
      cleanup: async (): Promise<ChannelCleanup> => {
        if (createdIds.length === 0)
          return { removed: [], kept: [], stuck: [] };
        // No signal: a cleanup that has started is never cut short by the
        // closed request. Both the read and the deletes sit inside the lock,
        // so no other writer of this server's channels runs between them.
        const held = await withChannelLock(guildId, async () => {
          let referenced: Set<string>;
          try {
            // Bounded like every read made inside the lock: a stalled
            // database must not hold the server's channel writes. A timeout
            // lands in the catch below, which reports the channels as
            // possibly still there and releases the lock.
            const rows = await readWithin(() =>
              ConfigService.getInstance().getAll(),
            );
            referenced = new Set(rows.flatMap((r) => idsIn(r.value)));
          } catch (error) {
            logger.warn("wizard: cleanup could not read the settings", error);
            return { removed: [], kept: [], stuck: [...createdIds] };
          }
          const kept = createdIds.filter((id) => referenced.has(id));
          const gone = await removeCreatedChannels(
            deps,
            createdIds.filter((id) => !referenced.has(id)),
          );
          return { removed: gone.removed, kept, stuck: gone.stuck };
        });
        // Busy for the whole wait: nothing was decided, nothing was deleted.
        return held.ok
          ? held.value
          : { removed: [], kept: [], stuck: [...createdIds] };
      },
    };
  } catch (error) {
    logger.warn("wizard: creating channels failed", error);
    return {
      ok: false,
      error:
        error instanceof ChannelReadTimeoutError ? error.message : NOT_READ,
    };
  }
}
