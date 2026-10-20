import type { EventGroupKind } from "../models/event-group-kinds.js";

/**
 * Built-in event group presets (#1188). Static content, kept in code like the
 * other definitions here; the server-wide preset library (#1200) adds the
 * admin's own presets on top and may switch these on or off, but never edits
 * them. An event copies a preset's groups when it is created, so changing a
 * preset here later never alters an event that already used it.
 *
 * Ids are namespaced `builtin:` so the library's own ids can never collide
 * with them. "Custom" (any number of groups and names) is not a preset: an
 * event made that way stores `presetId: null`.
 */

export interface EventGroupPresetGroup {
  name: string;
  kind: EventGroupKind;
  /** Max members (1 to 99), null = unlimited. */
  size: number | null;
  /** Clan tag; empty = none. */
  tag: string;
  /** Colour or emoji marker shown in the channel name; empty = none. */
  marker: string;
}

export interface EventGroupPreset {
  id: string;
  /** Name shown in the preset picker. */
  label: string;
  description: string;
  /** What a group is called for this preset ("Team", "Squad", ...). */
  groupLabel: string;
  /** What a leader is called; absent = the default ("Leader"). Library presets only. */
  leaderLabel?: string;
  /** Channel creation time in minutes before the start; absent = server default. Library presets only. */
  channelLeadMinutes?: number | null;
  /**
   * Default for the event form's "clan tags on nicknames" box (#1194); absent
   * means off. Library presets only (no built-in sets it). A default only: the
   * host can still change it for each event. There is deliberately no such
   * default for leaders.
   */
  tagsEnabled?: boolean;
  groups: readonly EventGroupPresetGroup[];
}

/** Id prefix every built-in preset carries. */
export const BUILTIN_PRESET_PREFIX = "builtin:";
/**
 * Id prefix of a preset in the server-wide library (#1200): `lib:` plus the
 * row's ObjectId. The id is minted once and survives renames and edits, so
 * `presetId` on an event stays a meaningful reference. Not `custom:`: the
 * literal "custom" already means "no preset".
 */
export const LIBRARY_PRESET_PREFIX = "lib:";
/**
 * Id prefix of a host's personal preset (#1216): `my:` plus the row's
 * ObjectId. Only ever resolved for its owner.
 */
export const PERSONAL_PRESET_PREFIX = "my:";

function team(name: string, marker = ""): EventGroupPresetGroup {
  return { name, kind: "team", size: null, tag: "", marker };
}

/** "Red 🔴, Blue 🔵": the team list as text, so a description cannot drift from it. */
function describeTeams(groups: readonly EventGroupPresetGroup[]): string {
  return groups
    .map((g) => (g.marker ? `${g.name} ${g.marker}` : g.name))
    .join(", ");
}

function teamPreset(
  id: string,
  groups: readonly EventGroupPresetGroup[],
): EventGroupPreset {
  return {
    id,
    label: `${groups.length} teams`,
    description: describeTeams(groups),
    groupLabel: "Team",
    groups,
  };
}

/**
 * Named by team count, ordered by it. The ids are historical (they once named
 * the themes: Red vs Blue, Wardogs, EVE factions). They are stored on events
 * (`presetId`) and in the per-guild switches (`builtinId`), so they must never
 * change; only the label and description are free to.
 */
export const EVENT_GROUP_PRESETS: readonly EventGroupPreset[] = [
  teamPreset("builtin:red-vs-blue", [team("Red", "🔴"), team("Blue", "🔵")]),
  teamPreset("builtin:wardogs", [
    team("Manticore", "🟢"),
    team("Valkyra", "🔴"),
    team("Lonestar", "🔵"),
  ]),
  teamPreset("builtin:eve-factions", [
    team("Amarr", "🟡"),
    team("Caldari", "🔵"),
    team("Gallente", "🟢"),
    team("Minmatar", "🔴"),
  ]),
];

/** The built-in preset with this id, or undefined (also for Custom/null). */
export function getEventGroupPreset(
  id: string | null | undefined,
): EventGroupPreset | undefined {
  if (!id) return undefined;
  return EVENT_GROUP_PRESETS.find((preset) => preset.id === id);
}
