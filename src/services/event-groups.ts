import { randomBytes } from "node:crypto";
import {
  EVENT_GROUP_KINDS,
  type EventGroupKind,
} from "../models/event-group-kinds.js";
import type { IEventGroup } from "../models/event.js";
import {
  getEventGroupPreset,
  type EventGroupPreset,
} from "../content/event-group-presets.js";

/**
 * Event group setup (#1188): the pure helpers for validating, building and
 * copying the `groups` block of an event. Kept free of Discord and Mongo so
 * the event form, the recurrence spawn and the later issues of the groups
 * epic (#1187: host panel, channel lifecycle, live editing) share one set of
 * rules instead of each re-implementing them.
 */

/** Longest group name. The channel name is "<marker> <name>", far under 100. */
export const GROUP_NAME_MAX = 50;
/** Longest clan tag. See {@link MIN_NICKNAME_ROOM}. */
export const GROUP_TAG_MAX = 8;
/** Longest colour or emoji marker, in characters (code points). */
export const GROUP_MARKER_MAX_CHARS = 4;
/** Longest group or leader label ("Squad", "Captain"). */
export const GROUP_LABEL_MAX = 20;
/** Discord's voice channel user limit range. */
export const GROUP_SIZE_MIN = 1;
export const GROUP_SIZE_MAX = 99;
/** The most groups an event may have, whatever `events.groups.max_count` says
 * (a category holds 50 channels, and the main channel needs one). */
export const GROUP_COUNT_HARD_MAX = 25;
/** Range of the per-event channel lead time, in minutes (0 = at the start). */
export const CHANNEL_LEAD_MIN = 0;
export const CHANNEL_LEAD_MAX = 1440;

export const DEFAULT_GROUP_LABEL = "Team";
export const DEFAULT_LEADER_LABEL = "Leader";

/** Discord's nickname cap. */
export const NICKNAME_MAX = 32;
/** Characters a tag adds to a nickname ("[TAG] " = brackets and a space). */
export const TAG_DECORATION_LENGTH = 3;
/**
 * Nickname characters left once the longest tag is applied: 32 - (8 + 3) = 21.
 * Most nicknames fit; the tagging step (#1194) shortens the rest, and this is
 * why the tag cap is not higher.
 */
export const MIN_NICKNAME_ROOM =
  NICKNAME_MAX - (GROUP_TAG_MAX + TAG_DECORATION_LENGTH);

/** How many `group_<n>_*` rows of the form are read. */
export const GROUP_FORM_MAX_ROWS = 100;

/** The stored setup: the group fields of an event. */
export interface EventGroupSetup {
  groupsEnabled: boolean;
  presetId: string | null;
  groupLabel: string;
  leaderLabel: string;
  channelLeadMinutes: number | null;
  groups: IEventGroup[];
  captainsEnabled: boolean;
  captainCustomisationEnabled: boolean;
  tagsEnabled: boolean;
  /** Tag after the name instead of before it (#1194). */
  tagsSuffix: boolean;
}

/** What a plain event stores: no groups, every toggle off. */
export function emptyGroupSetup(): EventGroupSetup {
  return {
    groupsEnabled: false,
    presetId: null,
    groupLabel: DEFAULT_GROUP_LABEL,
    leaderLabel: DEFAULT_LEADER_LABEL,
    channelLeadMinutes: null,
    groups: [],
    captainsEnabled: false,
    captainCustomisationEnabled: false,
    tagsEnabled: false,
    tagsSuffix: false,
  };
}

/** One group row as typed into the form, before validation. */
export interface RawGroupRow {
  /** 1-based position on the form, for error messages. */
  position: number;
  name: string;
  kind: string;
  size: string;
  tag: string;
  marker: string;
  /**
   * The key of an existing group when its setup is re-validated (host panel,
   * live editing), so edits keep each group's identity. Kept only when it is a
   * well-formed key not used twice; otherwise a new one is minted. The form of
   * a new event leaves it out.
   */
  key?: string;
}

/** The group section of the event form, before validation. */
export interface GroupSetupInput {
  enabled: boolean;
  /** `""` or `"custom"` for Custom, else a built-in preset id. */
  presetId: string;
  groupLabel: string;
  leaderLabel: string;
  /**
   * Group leaders on for this event (#1195). Optional: only the event form
   * posts it. The preset library never does (a preset has no default for
   * leaders), so a preset can neither store nor apply it.
   */
  captainsEnabled?: boolean;
  /**
   * Leaders may rename their group and set its tag from Discord (#1196). Only
   * stored as on while `captainsEnabled` is on. Optional like the other
   * toggles; the preset library never posts it.
   */
  captainCustomisationEnabled?: boolean;
  /**
   * Temporary clan tags on nicknames for this event (#1194). Optional: the
   * event form posts it (a chosen preset only pre-ticks the box in the browser,
   * the host's final choice is what arrives here); the preset editor posts it
   * too, as the preset's default.
   */
  tagsEnabled?: boolean;
  /** The tag goes after the name (#1194); only meaningful with `tagsEnabled`. */
  tagsSuffix?: boolean;
  /** `""` falls back to the global lead time. */
  channelLeadMinutes: string;
  rows: RawGroupRow[];
}

/**
 * How the validator finds a preset by id. The event form passes a resolver
 * built from the server's enabled presets (#1200); without one only the
 * built-ins are known, all on, as before the library existed.
 */
export type PresetLookup =
  | { preset: EventGroupPreset }
  | {
      /**
       * `disabled`: switched off for the server; `unreadable`: the library
       * could not be read, so availability is unknown (fail closed);
       * `unknown`: no such preset (never existed, or deleted).
       */
      refused: "disabled" | "unreadable" | "unknown";
      label?: string;
    };

export type PresetResolver = (id: string) => PresetLookup;

/** The default lookup: the built-in presets, all on. */
export const builtinPresetResolver: PresetResolver = (id) => {
  const preset = getEventGroupPreset(id);
  return preset ? { preset } : { refused: "unknown" };
};

function presetRefusal(
  refused: "disabled" | "unreadable" | "unknown",
  label?: string,
): string {
  const name = label ? `"${label}"` : "that preset";
  if (refused === "disabled") {
    return `Preset ${name} is switched off on this server. Choose another preset or Custom.`;
  }
  if (refused === "unreadable") {
    return `Preset ${name} cannot be checked right now because the preset library could not be read. Choose Custom, or try again.`;
  }
  return "Unknown group preset: it does not exist or was deleted. Choose another preset or Custom.";
}

export type GroupSetupResult =
  { ok: true; setup: EventGroupSetup } | { ok: false; errors: string[] };

/** The form field names, shared by the view, the parser and the script. */
export const GROUP_FORM_FIELDS = {
  enabled: "groups_enabled",
  preset: "groups_preset",
  label: "groups_label",
  leaderLabel: "groups_leader_label",
  captains: "groups_captains",
  captainCustom: "groups_captain_custom",
  tags: "groups_tags",
  tagsSuffix: "groups_tags_suffix",
  leadMinutes: "groups_lead_minutes",
} as const;

export function groupRowField(
  index: number,
  field: "name" | "kind" | "size" | "tag" | "marker",
): string {
  return `group_${index}_${field}`;
}

/** Read the group section from a posted urlencoded body. */
export function parseGroupForm(body: unknown): GroupSetupInput {
  const source = (body ?? {}) as Record<string, unknown>;
  const str = (name: string): string => {
    const raw = source[name];
    return typeof raw === "string" ? raw.trim() : "";
  };
  const rows: RawGroupRow[] = [];
  for (let i = 0; i < GROUP_FORM_MAX_ROWS; i++) {
    const row: RawGroupRow = {
      position: i + 1,
      name: str(groupRowField(i, "name")),
      kind: str(groupRowField(i, "kind")) || "team",
      size: str(groupRowField(i, "size")),
      tag: str(groupRowField(i, "tag")),
      marker: str(groupRowField(i, "marker")),
    };
    if (isBlankRow(row)) continue;
    rows.push(row);
  }
  return {
    enabled: str(GROUP_FORM_FIELDS.enabled).length > 0,
    presetId: str(GROUP_FORM_FIELDS.preset),
    groupLabel: str(GROUP_FORM_FIELDS.label),
    leaderLabel: str(GROUP_FORM_FIELDS.leaderLabel),
    captainsEnabled: str(GROUP_FORM_FIELDS.captains).length > 0,
    captainCustomisationEnabled:
      str(GROUP_FORM_FIELDS.captainCustom).length > 0,
    tagsEnabled: str(GROUP_FORM_FIELDS.tags).length > 0,
    tagsSuffix: str(GROUP_FORM_FIELDS.tagsSuffix).length > 0,
    channelLeadMinutes: str(GROUP_FORM_FIELDS.leadMinutes),
    rows,
  };
}

/** The kind select always posts a value, so it does not make a row non-blank. */
function isBlankRow(row: RawGroupRow): boolean {
  return !row.name && !row.size && !row.tag && !row.marker;
}

// eslint-disable-next-line no-control-regex
const CONTROL_CHARS = /[\u0000-\u001f\u007f-\u009f]/;

/**
 * The one rule for the per-event channel lead time (the event form, the host
 * panel's live edit #1239): empty is "use the server default" (null), else a
 * whole number of minutes from `CHANNEL_LEAD_MIN` to `CHANNEL_LEAD_MAX`.
 */
export function checkChannelLead(
  raw: string,
): { ok: true; value: number | null } | { ok: false; error: string } {
  const text = raw.trim();
  if (!text) return { ok: true, value: null };
  const lead = /^\d{1,5}$/.test(text) ? Number(text) : NaN;
  if (!(lead >= CHANNEL_LEAD_MIN && lead <= CHANNEL_LEAD_MAX)) {
    return {
      ok: false,
      error: `Channel creation time must be a whole number of minutes from ${CHANNEL_LEAD_MIN} to ${CHANNEL_LEAD_MAX}, or empty to use the server default.`,
    };
  }
  return { ok: true, value: lead };
}

/** Collapse runs of whitespace and trim, so "  Red   Team " is "Red Team". */
export function normalizeGroupText(value: string): string {
  return value.replace(/\s+/g, " ").trim();
}

/** A checked piece of group text: the normalised value, and why it is refused if it is. */
export type GroupTextCheck =
  { ok: true; value: string } | { ok: false; value: string; error: string };

/**
 * The one rule for a group's name (the event form, a leader's edit in Discord
 * #1196, the host panel's reset): whitespace collapsed, 1 to `GROUP_NAME_MAX`
 * characters, no control characters. Uniqueness among the groups of an event is
 * the caller's check (it needs the other groups). `error` reads after
 * "Group 3 name: ".
 */
export function checkGroupName(raw: string): GroupTextCheck {
  const value = normalizeGroupText(raw);
  if (!value) return { ok: false, value, error: "a name is required." };
  if (value.length > GROUP_NAME_MAX) {
    return {
      ok: false,
      value,
      error: `at most ${GROUP_NAME_MAX} characters (got ${value.length}).`,
    };
  }
  if (CONTROL_CHARS.test(value)) {
    return { ok: false, value, error: "control characters are not allowed." };
  }
  return { ok: true, value };
}

/**
 * The one rule for a group's clan tag: whitespace collapsed, empty (no tag) up
 * to `GROUP_TAG_MAX` characters, no control characters. `error` reads after
 * "Group 3 tag: ".
 */
export function checkGroupTag(raw: string): GroupTextCheck {
  const value = normalizeGroupText(raw);
  if (value.length > GROUP_TAG_MAX) {
    return {
      ok: false,
      value,
      error: `at most ${GROUP_TAG_MAX} characters, so a nickname keeps ${MIN_NICKNAME_ROOM} of Discord's ${NICKNAME_MAX} (got ${value.length}).`,
    };
  }
  if (CONTROL_CHARS.test(value)) {
    return { ok: false, value, error: "control characters are not allowed." };
  }
  return { ok: true, value };
}

/**
 * The one rule for a group's size (the event form, the host panel's live edit
 * #1241): empty is no limit (null), else a whole number from `GROUP_SIZE_MIN`
 * to `GROUP_SIZE_MAX`. `error` reads after "Group 3 size: ".
 */
export function checkGroupSize(
  raw: string,
): { ok: true; value: number | null } | { ok: false; error: string } {
  const text = raw.trim();
  if (!text) return { ok: true, value: null };
  const parsed = /^\d{1,3}$/.test(text) ? Number(text) : NaN;
  if (!(parsed >= GROUP_SIZE_MIN && parsed <= GROUP_SIZE_MAX)) {
    return {
      ok: false,
      error: `a whole number from ${GROUP_SIZE_MIN} to ${GROUP_SIZE_MAX}, or empty for no limit.`,
    };
  }
  return { ok: true, value: parsed };
}

/** A group key: `g_` and eight hex digits. */
const GROUP_KEY_PATTERN = /^g_[0-9a-f]{8}$/;

function newGroupKey(taken: ReadonlySet<string>): string {
  let key: string;
  do {
    key = `g_${randomBytes(4).toString("hex")}`;
  } while (taken.has(key));
  return key;
}

/** Clamp the two config values to a usable pair: 1 <= default <= max <= hard max. */
export function resolveGroupCountLimits(
  defaultCount: number,
  maxCount: number,
): { defaultCount: number; maxCount: number } {
  const max = clampInt(maxCount, 1, GROUP_COUNT_HARD_MAX, 15);
  const def = clampInt(defaultCount, 1, max, Math.min(2, max));
  return { defaultCount: def, maxCount: max };
}

function clampInt(
  value: number,
  min: number,
  max: number,
  fallback: number,
): number {
  if (!Number.isFinite(value)) return fallback;
  return Math.min(max, Math.max(min, Math.trunc(value)));
}

/**
 * Validate the form's group section and build the setup to store. No I/O: the
 * caller supplies the configured group cap. The groups it returns carry only
 * the setup (channel, captain and members are empty), so a caller re-validating
 * a live event merges those back by `key`. A section that is switched off
 * yields the empty setup whatever else was posted, so a plain event stores
 * exactly what it did before groups existed.
 *
 * Errors name the row and the field ("Group 3 size: ...") and are all
 * collected, so the organiser can fix them in one go.
 */
export function validateGroupSetup(
  input: GroupSetupInput,
  options: { maxCount: number; resolvePreset?: PresetResolver },
): GroupSetupResult {
  if (!input.enabled) return { ok: true, setup: emptyGroupSetup() };

  const errors: string[] = [];
  const maxCount = clampInt(
    options.maxCount,
    1,
    GROUP_COUNT_HARD_MAX,
    GROUP_COUNT_HARD_MAX,
  );

  // Preset: "" and "custom" are Custom; anything else must be a preset the
  // resolver offers (a switched-off or deleted one is refused, never silently
  // accepted or dropped).
  let presetId: string | null = null;
  let preset: EventGroupPreset | undefined;
  const rawPreset = input.presetId.trim();
  if (rawPreset && rawPreset !== "custom") {
    const found = (options.resolvePreset ?? builtinPresetResolver)(rawPreset);
    if ("preset" in found) {
      presetId = rawPreset;
      preset = found.preset;
    } else {
      errors.push(presetRefusal(found.refused, found.label));
    }
  }
  // A preset bigger than the cap is refused, never saved as a truncated copy
  // under its own id.
  if (preset && preset.groups.length > maxCount) {
    errors.push(
      `Preset "${preset.label}" needs ${preset.groups.length} groups but the limit is ${maxCount} (events.groups.max_count). Choose Custom or raise the limit.`,
    );
  }

  const groupLabel = checkLabel(
    "Group label",
    input.groupLabel,
    preset?.groupLabel ?? DEFAULT_GROUP_LABEL,
    errors,
  );
  const leaderLabel = checkLabel(
    "Leader label",
    input.leaderLabel,
    preset?.leaderLabel ?? DEFAULT_LEADER_LABEL,
    errors,
  );

  const lead = checkChannelLead(input.channelLeadMinutes);
  if (!lead.ok) errors.push(lead.error);
  const channelLeadMinutes = lead.ok ? lead.value : null;

  // No rows typed in and a preset chosen: use the preset's groups (this is
  // what a browser without scripts posts).
  let rows = input.rows;
  if (rows.length === 0 && preset) {
    rows = preset.groups.map((group, i) => ({
      position: i + 1,
      name: group.name,
      kind: group.kind,
      size: group.size === null ? "" : String(group.size),
      tag: group.tag,
      marker: group.marker,
    }));
  }
  if (rows.length === 0) {
    errors.push(
      "Add at least one group, or switch groups off. Give each group a name.",
    );
  } else if (rows.length > maxCount) {
    errors.push(
      `An event can have at most ${maxCount} groups (events.groups.max_count); this has ${rows.length}.`,
    );
  }

  const groups: IEventGroup[] = [];
  const seenNames = new Map<string, number>();
  // Keys the caller asked to keep, reserved first so a minted key can never
  // collide with one a later row keeps.
  const keys = new Set<string>(
    rows.flatMap((r) =>
      r.key && GROUP_KEY_PATTERN.test(r.key) ? [r.key] : [],
    ),
  );
  const usedKeys = new Set<string>();
  let leadsRow: number | null = null;
  for (const row of rows) {
    const where = `Group ${row.position}`;
    const nameCheck = checkGroupName(row.name);
    const name = nameCheck.value;
    if (!nameCheck.ok) {
      errors.push(`${where} name: ${nameCheck.error}`);
    } else {
      const folded = name.toLowerCase();
      const earlier = seenNames.get(folded);
      if (earlier !== undefined) {
        errors.push(
          `${where} name: "${name}" is already used by group ${earlier}; names must be unique.`,
        );
      } else {
        seenNames.set(folded, row.position);
      }
    }

    let kind: EventGroupKind = "team";
    if ((EVENT_GROUP_KINDS as readonly string[]).includes(row.kind)) {
      kind = row.kind as EventGroupKind;
    } else {
      errors.push(`${where} kind: must be team, open or leads.`);
    }
    if (kind === "leads") {
      if (leadsRow !== null) {
        errors.push(
          `${where} kind: only one leads group is allowed (group ${leadsRow} already is one).`,
        );
      } else {
        leadsRow = row.position;
      }
    }

    let size: number | null = null;
    const sizeCheck = checkGroupSize(row.size);
    if (sizeCheck.ok) {
      size = sizeCheck.value;
    } else {
      errors.push(`${where} size: ${sizeCheck.error}`);
    }

    const tagCheck = checkGroupTag(row.tag);
    const tag = tagCheck.value;
    if (!tagCheck.ok) errors.push(`${where} tag: ${tagCheck.error}`);

    const marker = normalizeGroupText(row.marker);
    if (Array.from(marker).length > GROUP_MARKER_MAX_CHARS) {
      errors.push(
        `${where} marker: at most ${GROUP_MARKER_MAX_CHARS} characters, for example one coloured circle emoji.`,
      );
    } else if (CONTROL_CHARS.test(marker)) {
      errors.push(`${where} marker: control characters are not allowed.`);
    }

    let key = row.key ?? "";
    if (!GROUP_KEY_PATTERN.test(key) || usedKeys.has(key)) {
      key = newGroupKey(keys);
      keys.add(key);
    }
    usedKeys.add(key);
    groups.push({
      key,
      name,
      kind,
      size,
      tag,
      marker,
      channelId: null,
      captainId: null,
      memberIds: [],
    });
  }

  if (errors.length > 0) return { ok: false, errors };
  return {
    ok: true,
    setup: {
      groupsEnabled: true,
      presetId,
      groupLabel,
      leaderLabel,
      channelLeadMinutes,
      groups,
      captainsEnabled: input.captainsEnabled === true,
      // Only effective with leaders on, so only stored that way (like the tag
      // position below).
      captainCustomisationEnabled:
        input.captainsEnabled === true &&
        input.captainCustomisationEnabled === true,
      tagsEnabled: input.tagsEnabled === true,
      tagsSuffix: input.tagsEnabled === true && input.tagsSuffix === true,
    },
  };
}

/**
 * Validate a leader label typed on the host panel (#1195): empty falls back to
 * "Leader"; control characters and more than `GROUP_LABEL_MAX` characters are
 * refused. Same rules as the event form's label.
 */
export function validateLeaderLabel(
  raw: string,
): { ok: true; value: string } | { ok: false; error: string } {
  const errors: string[] = [];
  const value = checkLabel("Leader label", raw, DEFAULT_LEADER_LABEL, errors);
  return errors.length > 0
    ? { ok: false, error: errors.join(" ") }
    : { ok: true, value };
}

function checkLabel(
  field: string,
  raw: string,
  fallback: string,
  errors: string[],
): string {
  const value = normalizeGroupText(raw);
  if (!value) return fallback;
  if (value.length > GROUP_LABEL_MAX) {
    errors.push(
      `${field}: at most ${GROUP_LABEL_MAX} characters (got ${value.length}).`,
    );
    return fallback;
  }
  if (CONTROL_CHARS.test(value)) {
    errors.push(`${field}: control characters are not allowed.`);
    return fallback;
  }
  return value;
}

/** The group fields of an event row, each possibly missing (old or lean rows). */
export interface GroupSetupSource {
  groupsEnabled?: boolean | null;
  presetId?: string | null;
  groupLabel?: string | null;
  leaderLabel?: string | null;
  channelLeadMinutes?: number | null;
  groups?: ReadonlyArray<Partial<IEventGroup>> | null;
  captainsEnabled?: boolean | null;
  captainCustomisationEnabled?: boolean | null;
  tagsEnabled?: boolean | null;
  tagsSuffix?: boolean | null;
}

/**
 * The setup a recurring series' next occurrence starts with: the names, kinds,
 * sizes, tags, markers, labels, lead time and toggles, with the keys kept so
 * the series stays recognisable. Memberships, captains and channel ids are
 * reset: those belong to one occurrence. A source without group fields (an
 * event from before groups) gives the empty setup.
 */
export function copyGroupSetup(source: GroupSetupSource): EventGroupSetup {
  const groups: IEventGroup[] = (source.groups ?? []).map((group) => ({
    key: String(group.key ?? ""),
    // A leader's rename (#1196) belongs to one occurrence: the next one starts
    // from what the host set (`originalName` is set with `originalTag`).
    name: String(group.originalName || (group.name ?? "")),
    kind: (EVENT_GROUP_KINDS as readonly string[]).includes(group.kind ?? "")
      ? (group.kind as EventGroupKind)
      : "team",
    size: typeof group.size === "number" ? group.size : null,
    tag: group.originalName ? (group.originalTag ?? "") : (group.tag ?? ""),
    marker: group.marker ?? "",
    channelId: null,
    captainId: null,
    memberIds: [],
  }));
  const empty = emptyGroupSetup();
  return {
    groupsEnabled: source.groupsEnabled === true,
    presetId: source.presetId ?? null,
    groupLabel: source.groupLabel || empty.groupLabel,
    leaderLabel: source.leaderLabel || empty.leaderLabel,
    channelLeadMinutes:
      typeof source.channelLeadMinutes === "number"
        ? source.channelLeadMinutes
        : null,
    groups,
    captainsEnabled: source.captainsEnabled === true,
    captainCustomisationEnabled: source.captainCustomisationEnabled === true,
    tagsEnabled: source.tagsEnabled === true,
    tagsSuffix: source.tagsSuffix === true,
  };
}

/**
 * Minutes before the start that this event's channels are created: the
 * event's own value when it has one, else the server-wide
 * `events.create_lead_minutes`. A missing field (an old row) is the global.
 */
export function effectiveChannelLeadMinutes(
  event: { channelLeadMinutes?: number | null },
  globalLeadMinutes: number,
): number {
  const own = event.channelLeadMinutes;
  return typeof own === "number" && own >= 0 ? own : globalLeadMinutes;
}
