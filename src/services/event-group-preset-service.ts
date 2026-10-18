import {
  BUILTIN_PRESET_PREFIX,
  EVENT_GROUP_PRESETS,
  LIBRARY_PRESET_PREFIX,
  getEventGroupPreset,
  type EventGroupPreset,
} from "../content/event-group-presets.js";
import {
  EventGroupPreset as EventGroupPresetModel,
  EventGroupPresetToggle,
  type IEventGroupPreset,
} from "../models/event-group-preset.js";
import {
  GROUP_COUNT_HARD_MAX,
  GROUP_FORM_FIELDS,
  GROUP_NAME_MAX,
  normalizeGroupText,
  parseGroupForm,
  validateGroupSetup,
  type EventGroupSetup,
  type PresetResolver,
} from "./event-groups.js";
import logger from "../utils/logger.js";
import { createKeyedLock } from "../utils/keyed-lock.js";

/**
 * The server-wide event group preset library (#1200).
 *
 * Built-in presets stay in code (`src/content/event-group-presets.ts`); the
 * admin's own presets live in Mongo, and either kind can be switched on or off
 * for the whole server. This module is the one place that merges the two
 * lists, so the event form, the create route and later issues (host panel
 * #1189, live editing #1197) all see the same "enabled presets".
 *
 * Ids: `builtin:<slug>` for built-ins, `lib:<ObjectId>` for library presets.
 * An id is minted once and never changes, so an event's `presetId` stays a
 * valid reference through renames and edits. An event keeps its own copy of
 * the groups, so nothing here ever touches an event.
 */

/** Most presets a server's library may hold. */
export const MAX_LIBRARY_PRESETS = 50;
/** Longest preset description. */
export const PRESET_DESCRIPTION_MAX = 200;

/** Form field names of the preset editor (the group rows reuse the event form's). */
export const PRESET_FORM_FIELDS = {
  id: "preset_id",
  name: "preset_name",
  description: "preset_description",
} as const;

/** One preset as the admin page lists it, built-in or from the library. */
export interface PresetEntry extends EventGroupPreset {
  source: "builtin" | "library";
  enabled: boolean;
}

/** What the read of the catalog could and could not see. */
export type CatalogReadState = "ok" | "library-unreadable" | "all-unreadable";

export interface PresetCatalog {
  /** Every preset with its switch. Complete only when `state` is `ok`. */
  entries: PresetEntry[];
  state: CatalogReadState;
}

/** Plain row shape read with `.lean()`. */
interface PresetRow {
  _id: unknown;
  name: string;
  description?: string;
  groupLabel?: string;
  leaderLabel?: string;
  channelLeadMinutes?: number | null;
  tagsEnabled?: boolean;
  groups?: Array<{
    name: string;
    kind?: string;
    size?: number | null;
    tag?: string;
    marker?: string;
  }>;
  enabled?: boolean;
}

export function libraryPresetId(rowId: unknown): string {
  return `${LIBRARY_PRESET_PREFIX}${String(rowId)}`;
}

const LIBRARY_ID_PATTERN = /^lib:([0-9a-f]{24})$/;

/** The ObjectId string inside a library preset id, or null. */
export function parseLibraryPresetId(id: string): string | null {
  const match = LIBRARY_ID_PATTERN.exec(id);
  return match ? (match[1] as string) : null;
}

function rowToEntry(row: PresetRow): PresetEntry {
  return {
    id: libraryPresetId(row._id),
    source: "library",
    label: row.name,
    description: row.description ?? "",
    groupLabel: row.groupLabel || "Team",
    leaderLabel: row.leaderLabel || undefined,
    channelLeadMinutes:
      typeof row.channelLeadMinutes === "number"
        ? row.channelLeadMinutes
        : null,
    // A row from before the field existed has none: off, no migration.
    tagsEnabled: row.tagsEnabled === true,
    groups: (row.groups ?? []).map((g) => ({
      name: g.name,
      kind: (g.kind as "team" | "open" | "leads") || "team",
      size: typeof g.size === "number" ? g.size : null,
      tag: g.tag ?? "",
      marker: g.marker ?? "",
    })),
    enabled: row.enabled !== false,
  };
}

async function readSwitches(guildId: string): Promise<unknown[]> {
  return await EventGroupPresetToggle.find({ guildId }).lean();
}

async function readLibrary(guildId: string): Promise<unknown[]> {
  return await EventGroupPresetModel.find({ guildId })
    .sort({ nameKey: 1 })
    .lean();
}

/**
 * Read the built-in switches and the library for one server. Never throws: a
 * read that fails is reported in `state` and the entries are left out, so the
 * callers can fail closed (see {@link enabledPresets}).
 *
 * A built-in with no switch row is ON, so a server that never used the library
 * (or whose database has no such collection yet) sees every built-in.
 */
export async function loadPresetCatalog(
  guildId: string,
): Promise<PresetCatalog> {
  const [toggleResult, libraryResult] = await Promise.allSettled([
    // Async helpers, so a throw while building a query is a rejected read too.
    readSwitches(guildId),
    readLibrary(guildId),
  ]);
  if (toggleResult.status === "rejected") {
    logger.warn("event presets: reading the built-in switches failed", {
      error: toggleResult.reason,
    });
    return { entries: [], state: "all-unreadable" };
  }
  const off = new Set<string>();
  for (const row of toggleResult.value as Array<{
    builtinId: string;
    enabled: boolean;
  }>) {
    if (row.enabled === false) off.add(row.builtinId);
  }
  const entries: PresetEntry[] = EVENT_GROUP_PRESETS.map((preset) => ({
    ...preset,
    source: "builtin" as const,
    enabled: !off.has(preset.id),
  }));
  if (libraryResult.status === "rejected") {
    logger.warn("event presets: reading the preset library failed", {
      error: libraryResult.reason,
    });
    return { entries, state: "library-unreadable" };
  }
  for (const row of libraryResult.value as unknown as PresetRow[]) {
    entries.push(rowToEntry(row));
  }
  return { entries, state: "ok" };
}

/**
 * The presets a host may pick: the enabled built-ins plus the enabled library
 * presets. Fails closed: when the switches cannot be read nothing is offered
 * (Custom still works); when only the library cannot be read, the enabled
 * built-ins are.
 */
export function enabledPresets(catalog: PresetCatalog): EventGroupPreset[] {
  return catalog.entries.filter((e) => e.enabled);
}

/** A notice for the picker when the catalog could not be fully read. */
export function catalogNotice(state: CatalogReadState): string | null {
  if (state === "ok") return null;
  return state === "all-unreadable"
    ? "The preset library could not be read, so no presets are offered right now. Custom still works."
    : "The server's own presets could not be read, so only the built-in presets that are switched on are offered.";
}

/**
 * Build the resolver the validator uses from one catalog read. The caller
 * reads the catalog once per request and uses the result for the whole
 * request, so what is validated is what the page offered.
 */
export function presetResolver(catalog: PresetCatalog): PresetResolver {
  const byId = new Map(catalog.entries.map((e) => [e.id, e]));
  return (id) => {
    if (catalog.state === "all-unreadable") return { refused: "unreadable" };
    const entry = byId.get(id);
    if (entry) {
      return entry.enabled
        ? { preset: entry }
        : { refused: "disabled", label: entry.label };
    }
    if (catalog.state === "library-unreadable" && id.startsWith("lib:")) {
      return { refused: "unreadable" };
    }
    return { refused: "unknown" };
  };
}

/** Read the catalog and build the resolver in one step. */
export async function loadPresetResolver(guildId: string): Promise<{
  catalog: PresetCatalog;
  resolve: PresetResolver;
}> {
  const catalog = await loadPresetCatalog(guildId);
  return { catalog, resolve: presetResolver(catalog) };
}

// ---------- Validation of the preset editor ----------

export interface PresetData {
  name: string;
  description: string;
  groupLabel: string;
  leaderLabel: string;
  channelLeadMinutes: number | null;
  /** Default for the event form's clan tags box (#1194). */
  tagsEnabled: boolean;
  groups: Array<{
    name: string;
    kind: "team" | "open" | "leads";
    size: number | null;
    tag: string;
    marker: string;
  }>;
}

export type PresetValidation =
  { ok: true; data: PresetData } | { ok: false; errors: string[] };

// eslint-disable-next-line no-control-regex
const CONTROL_CHARS = /[\u0000-\u001f\u007f-\u009f]/;

/**
 * Validate the preset editor's body. The groups, labels and lead time go
 * through the very validator the event form uses (`validateGroupSetup`), so
 * the library cannot hold a preset the form would reject; only the preset's
 * own name and description are checked here. `maxCount` is the configured
 * `events.groups.max_count` (already resolved).
 */
export function validatePresetForm(
  body: unknown,
  options: { maxCount: number },
): PresetValidation {
  const source = (body ?? {}) as Record<string, unknown>;
  const str = (name: string): string => {
    const raw = source[name];
    return typeof raw === "string" ? raw : "";
  };
  const errors: string[] = [];

  const name = normalizeGroupText(str(PRESET_FORM_FIELDS.name));
  if (!name) {
    errors.push("Preset name: a name is required.");
  } else if (name.length > GROUP_NAME_MAX) {
    errors.push(
      `Preset name: at most ${GROUP_NAME_MAX} characters (got ${name.length}).`,
    );
  } else if (CONTROL_CHARS.test(name)) {
    errors.push("Preset name: control characters are not allowed.");
  } else if (getEventGroupPresetByLabel(name)) {
    errors.push(
      `Preset name: "${name}" is the name of a built-in preset. Choose another name.`,
    );
  }
  const description = normalizeGroupText(str(PRESET_FORM_FIELDS.description));
  if (description.length > PRESET_DESCRIPTION_MAX) {
    errors.push(
      `Preset description: at most ${PRESET_DESCRIPTION_MAX} characters (got ${description.length}).`,
    );
  } else if (CONTROL_CHARS.test(description)) {
    errors.push("Preset description: control characters are not allowed.");
  }

  const input = { ...parseGroupForm(body), enabled: true, presetId: "" };
  const result = validateGroupSetup(input, {
    maxCount: Math.min(options.maxCount, GROUP_COUNT_HARD_MAX),
  });
  if (!result.ok) {
    errors.push(
      ...result.errors.map((e) =>
        e.startsWith("Add at least one group")
          ? "Add at least one group, each with a name."
          : e,
      ),
    );
  }
  if (errors.length > 0 || !result.ok) return { ok: false, errors };
  const setup = result.setup;
  return {
    ok: true,
    data: {
      name,
      description,
      groupLabel: setup.groupLabel,
      leaderLabel: setup.leaderLabel,
      channelLeadMinutes: setup.channelLeadMinutes,
      tagsEnabled: setup.tagsEnabled,
      groups: setup.groups.map((g) => ({
        name: g.name,
        kind: g.kind,
        size: g.size,
        tag: g.tag,
        marker: g.marker,
      })),
    },
  };
}

function getEventGroupPresetByLabel(
  name: string,
): EventGroupPreset | undefined {
  const folded = name.toLowerCase();
  return EVENT_GROUP_PRESETS.find((p) => p.label.toLowerCase() === folded);
}

/**
 * A preset (or an event's setup) as the editor's form body, so the editor can
 * be prefilled for "Duplicate" and "Save from an event" with the same field
 * names the form posts.
 */
export function presetToFormValues(source: {
  label?: string;
  description?: string;
  groupLabel: string;
  leaderLabel?: string | null;
  channelLeadMinutes?: number | null;
  tagsEnabled?: boolean;
  groups: ReadonlyArray<{
    name: string;
    kind: string;
    size: number | null;
    tag: string;
    marker: string;
  }>;
}): Record<string, string> {
  const values: Record<string, string> = {
    [PRESET_FORM_FIELDS.name]: source.label ?? "",
    [PRESET_FORM_FIELDS.description]: source.description ?? "",
    [GROUP_FORM_FIELDS.label]: source.groupLabel,
    [GROUP_FORM_FIELDS.leaderLabel]: source.leaderLabel ?? "",
    [GROUP_FORM_FIELDS.leadMinutes]:
      typeof source.channelLeadMinutes === "number"
        ? String(source.channelLeadMinutes)
        : "",
    // A checkbox: present only when ticked, like a posted form.
    ...(source.tagsEnabled === true ? { [GROUP_FORM_FIELDS.tags]: "1" } : {}),
  };
  source.groups.forEach((g, i) => {
    values[`group_${i}_name`] = g.name;
    values[`group_${i}_kind`] = g.kind;
    values[`group_${i}_size`] = g.size === null ? "" : String(g.size);
    values[`group_${i}_tag`] = g.tag;
    values[`group_${i}_marker`] = g.marker;
  });
  return values;
}

/** Same as {@link presetToFormValues} for a stored event's setup. */
export function eventSetupToFormValues(
  event: Pick<
    EventGroupSetup,
    | "groupLabel"
    | "leaderLabel"
    | "channelLeadMinutes"
    | "tagsEnabled"
    | "groups"
  >,
): Record<string, string> {
  return presetToFormValues({
    groupLabel: event.groupLabel,
    leaderLabel: event.leaderLabel,
    channelLeadMinutes: event.channelLeadMinutes,
    tagsEnabled: event.tagsEnabled,
    groups: event.groups,
  });
}

// ---------- Writes ----------

export type WriteResult<T = object> =
  ({ ok: true } & T) | { ok: false; error: string };

function isDuplicateKey(err: unknown): boolean {
  return (
    typeof err === "object" &&
    err !== null &&
    (err as { code?: unknown }).code === 11000
  );
}

const DUPLICATE_NAME =
  "A preset with that name already exists (names are compared ignoring case).";

function toDoc(data: PresetData): Record<string, unknown> {
  return {
    name: data.name,
    nameKey: data.name.toLowerCase(),
    description: data.description,
    groupLabel: data.groupLabel,
    leaderLabel: data.leaderLabel,
    channelLeadMinutes: data.channelLeadMinutes,
    tagsEnabled: data.tagsEnabled,
    groups: data.groups,
  };
}

/**
 * Serialises the count-then-insert of a create per server, so two saves at
 * 49 presets cannot both pass the 50 limit. The bot is one process, so this is
 * enough; the unique name index still guards names in storage.
 */
const createLock = createKeyedLock();

export function createLibraryPreset(
  guildId: string,
  data: PresetData,
): Promise<WriteResult<{ id: string }>> {
  return createLock.run(guildId, () =>
    createLibraryPresetLocked(guildId, data),
  );
}

async function createLibraryPresetLocked(
  guildId: string,
  data: PresetData,
): Promise<WriteResult<{ id: string }>> {
  try {
    const count = await EventGroupPresetModel.countDocuments({ guildId });
    if (count >= MAX_LIBRARY_PRESETS) {
      return {
        ok: false,
        error: `The library is full: at most ${MAX_LIBRARY_PRESETS} presets. Delete one first.`,
      };
    }
    const created = await EventGroupPresetModel.create({
      guildId,
      ...toDoc(data),
      enabled: true,
    });
    return { ok: true, id: libraryPresetId(created._id) };
  } catch (err) {
    if (isDuplicateKey(err)) return { ok: false, error: DUPLICATE_NAME };
    logger.error("event presets: create failed", err);
    return { ok: false, error: "Saving the preset failed. Try again." };
  }
}

export async function updateLibraryPreset(
  guildId: string,
  id: string,
  data: PresetData,
): Promise<WriteResult> {
  const rowId = parseLibraryPresetId(id);
  if (!rowId) return { ok: false, error: "That preset was not found." };
  try {
    const updated = await EventGroupPresetModel.findOneAndUpdate(
      { _id: rowId, guildId },
      { $set: toDoc(data) },
      { returnDocument: "after", runValidators: true },
    );
    return updated
      ? { ok: true }
      : { ok: false, error: "That preset was not found." };
  } catch (err) {
    if (isDuplicateKey(err)) return { ok: false, error: DUPLICATE_NAME };
    logger.error("event presets: update failed", err);
    return { ok: false, error: "Saving the preset failed. Try again." };
  }
}

export async function deleteLibraryPreset(
  guildId: string,
  id: string,
): Promise<WriteResult> {
  const rowId = parseLibraryPresetId(id);
  if (!rowId) return { ok: false, error: "That preset was not found." };
  try {
    const result = await EventGroupPresetModel.deleteOne({
      _id: rowId,
      guildId,
    });
    return result.deletedCount > 0
      ? { ok: true }
      : { ok: false, error: "That preset was not found." };
  } catch (err) {
    logger.error("event presets: delete failed", err);
    return { ok: false, error: "Deleting the preset failed. Try again." };
  }
}

/**
 * Switch one preset, built-in or library, on or off for the server. Takes the
 * wanted state (not a flip) so a repeated submit changes nothing.
 */
export async function setPresetEnabled(
  guildId: string,
  id: string,
  enabled: boolean,
): Promise<WriteResult<{ label: string }>> {
  try {
    if (id.startsWith(BUILTIN_PRESET_PREFIX)) {
      const builtin = getEventGroupPreset(id);
      if (!builtin) return { ok: false, error: "That preset was not found." };
      await EventGroupPresetToggle.updateOne(
        { guildId, builtinId: id },
        { $set: { enabled } },
        { upsert: true },
      );
      return { ok: true, label: builtin.label };
    }
    const rowId = parseLibraryPresetId(id);
    if (!rowId) return { ok: false, error: "That preset was not found." };
    const row = (await EventGroupPresetModel.findOneAndUpdate(
      { _id: rowId, guildId },
      { $set: { enabled } },
      { returnDocument: "after" },
    )) as IEventGroupPreset | null;
    return row
      ? { ok: true, label: row.name }
      : { ok: false, error: "That preset was not found." };
  } catch (err) {
    logger.error("event presets: toggle failed", err);
    return { ok: false, error: "Saving the switch failed. Try again." };
  }
}
