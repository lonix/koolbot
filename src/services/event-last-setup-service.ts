import { EventGroupLastSetup } from "../models/event-group-last-setup.js";
import type { EventGroupPreset } from "../content/event-group-presets.js";
import {
  DEFAULT_GROUP_LABEL,
  DEFAULT_LEADER_LABEL,
  hasCaptainsLobby,
  validateGroupSetup,
  type EventGroupSetup,
  type GroupSetupInput,
  type RawGroupRow,
} from "./event-groups.js";
import logger from "../utils/logger.js";

/**
 * The group setup a host used for their last event, offered as the default of
 * the next event form (#1406).
 *
 * Two rules keep it from ever getting in the way:
 *
 * - Writing is a convenience after a successful create. A failed write is
 *   logged and swallowed; it never turns a created event into an error.
 * - Reading never throws and never trusts the stored row. What comes back is
 *   re-validated with the real group validator against the limits that apply
 *   today (group cap, text lengths, the presets on offer now). Anything that
 *   does not pass, or a read that fails, means "no prefill": the form shows
 *   its normal defaults.
 *
 * Both are keyed on the signed-in host (`guildId` + `ownerId`) and nothing
 * else, so one host's setup can never prefill another host's form.
 */

/** What the form shows for a remembered setup, as plain strings for the markup. */
export interface GroupFormPrefill {
  /** The preset card to check; `""` is Custom. */
  presetId: string;
  /** Empty when it is the default wording, so the placeholder shows. */
  groupLabel: string;
  leaderLabel: string;
  /** Empty = the server default. */
  channelLeadMinutes: string;
  rows: Array<{
    name: string;
    kind: string;
    size: string;
    tag: string;
    marker: string;
  }>;
  captainsEnabled: boolean;
  captainCustomisationEnabled: boolean;
  captainsLobby: boolean;
  tagsEnabled: boolean;
  tagsSuffix: boolean;
}

/** What the current form offers, for validating a stored setup against today's limits. */
export interface PrefillContext {
  /** The effective cap on groups (`events.groups.max_count`, clamped). */
  maxCount: number;
  /** The presets the picker shows now (enabled ones; library, personal, built-in). */
  presets: readonly EventGroupPreset[];
}

function text(value: unknown): string {
  return typeof value === "string" ? value : "";
}

function bool(value: unknown): boolean {
  return value === true;
}

/**
 * Turn a stored row into what the form can prefill, or null. Pure: no I/O, so
 * the rules are testable without a database. A preset that is gone, switched
 * off or too big for the cap today is dropped to Custom with the stored rows
 * kept (the rows are what the host made); everything else that fails the
 * validator drops the whole prefill.
 */
export function prefillFromStored(
  stored: unknown,
  ctx: PrefillContext,
): GroupFormPrefill | null {
  if (!stored || typeof stored !== "object") return null;
  const doc = stored as Record<string, unknown>;
  if (!Array.isArray(doc.groups) || doc.groups.length === 0) return null;

  const storedPreset = text(doc.presetId);
  const offered = storedPreset
    ? ctx.presets.find(
        (p) => p.id === storedPreset && p.groups.length <= ctx.maxCount,
      )
    : undefined;

  const rows: RawGroupRow[] = [];
  for (const item of doc.groups) {
    if (!item || typeof item !== "object") return null;
    const g = item as Record<string, unknown>;
    // A stored lobby never reaches the rows; the switch carries it.
    if (g.kind === "leads") continue;
    rows.push({
      position: rows.length + 1,
      name: text(g.name),
      kind: text(g.kind) || "team",
      size:
        typeof g.size === "number" && Number.isFinite(g.size)
          ? String(g.size)
          : "",
      tag: text(g.tag),
      marker: text(g.marker),
    });
  }
  const captainsEnabled = bool(doc.captainsEnabled);
  const input: GroupSetupInput = {
    enabled: true,
    presetId: offered ? offered.id : "",
    groupLabel: text(doc.groupLabel),
    leaderLabel: text(doc.leaderLabel),
    captainsEnabled,
    captainCustomisationEnabled: bool(doc.captainCustomisationEnabled),
    captainsLobby: captainsEnabled && bool(doc.captainsLobby),
    tagsEnabled: bool(doc.tagsEnabled),
    tagsSuffix: bool(doc.tagsSuffix),
    channelLeadMinutes:
      typeof doc.channelLeadMinutes === "number" &&
      Number.isFinite(doc.channelLeadMinutes)
        ? String(doc.channelLeadMinutes)
        : "",
    rows,
  };
  const result = validateGroupSetup(input, {
    maxCount: ctx.maxCount,
    resolvePreset: (id) =>
      offered && id === offered.id
        ? { preset: offered }
        : { refused: "unknown" },
  });
  if (!result.ok) return null;

  const setup = result.setup;
  return {
    presetId: setup.presetId ?? "",
    groupLabel:
      setup.groupLabel === DEFAULT_GROUP_LABEL ? "" : setup.groupLabel,
    leaderLabel:
      setup.leaderLabel === DEFAULT_LEADER_LABEL ? "" : setup.leaderLabel,
    channelLeadMinutes:
      setup.channelLeadMinutes === null ? "" : String(setup.channelLeadMinutes),
    rows: setup.groups
      .filter((g) => g.kind !== "leads")
      .map((g) => ({
        name: g.name,
        kind: g.kind,
        size: g.size === null ? "" : String(g.size),
        tag: g.tag,
        marker: g.marker,
      })),
    captainsEnabled: setup.captainsEnabled,
    captainCustomisationEnabled: setup.captainCustomisationEnabled,
    captainsLobby: hasCaptainsLobby(setup.groups),
    tagsEnabled: setup.tagsEnabled,
    tagsSuffix: setup.tagsSuffix,
  };
}

/**
 * The host's remembered setup for the form, or null. Never throws: a failed
 * read is logged and means "use the defaults", so it can never block creating
 * an event.
 */
export async function loadGroupPrefill(
  guildId: string,
  ownerId: string | undefined,
  ctx: PrefillContext,
): Promise<GroupFormPrefill | null> {
  if (!guildId || !ownerId) return null;
  try {
    const row = await EventGroupLastSetup.findOne({ guildId, ownerId }).lean();
    return prefillFromStored(row, ctx);
  } catch (err) {
    logger.warn("Could not read the remembered event group setup", err);
    return null;
  }
}

/**
 * Remember the setup an event was just created with, replacing the host's
 * previous one. `setup` is what the form was accepted as (the validator's
 * output), not what was posted. A plain event (groups off) leaves the stored
 * setup alone. Never throws.
 */
export async function rememberLastSetup(
  guildId: string,
  ownerId: string,
  setup: EventGroupSetup,
): Promise<void> {
  if (!guildId || !ownerId || !setup.groupsEnabled) return;
  try {
    await EventGroupLastSetup.findOneAndUpdate(
      { guildId, ownerId },
      {
        $set: {
          presetId: setup.presetId,
          groupLabel: setup.groupLabel,
          leaderLabel: setup.leaderLabel,
          channelLeadMinutes: setup.channelLeadMinutes,
          groups: setup.groups
            .filter((g) => g.kind !== "leads")
            .map((g) => ({
              name: g.name,
              kind: g.kind,
              size: g.size,
              tag: g.tag,
              marker: g.marker,
            })),
          captainsEnabled: setup.captainsEnabled,
          captainCustomisationEnabled: setup.captainCustomisationEnabled,
          captainsLobby: hasCaptainsLobby(setup.groups),
          tagsEnabled: setup.tagsEnabled,
          tagsSuffix: setup.tagsSuffix,
        },
      },
      { upsert: true, runValidators: true },
    );
  } catch (err) {
    logger.warn("Could not remember the event group setup", err);
  }
}
