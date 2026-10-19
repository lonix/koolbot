/**
 * The group editor of the host panel's "Live settings" section (#1241): the
 * names and sizes of the groups, and the preset switch. Kept apart from
 * `host-settings-view.ts` (which only calls `renderGroupEditor` and
 * `renderPresetForm`) so another step's controls do not collide with these.
 *
 * Every field follows the core's form convention (`services/event-live-edit.ts`
 * rule 3): the value it SHOWED (`b_<row>`) next to the value it holds
 * (`s_<row>`). The names and sizes are one text and one number field per group
 * (rows `groupNameA`, `groupSizeA`, ... by position). The preset switch is its
 * own form: the select names a preset by id (`preset_pick`), and the SERVER
 * turns that id into the preset's content (`prepareGroupEditBody`); a posted
 * `s_groupPreset` is never read, so the content that is applied and confirmed
 * always comes from the server's own catalog. Everything dynamic goes through
 * `escapeHtml`.
 */

import { escapeHtml } from "./html.js";
import {
  GROUP_NAME_MAX,
  GROUP_SIZE_MAX,
  GROUP_SIZE_MIN,
} from "../services/event-groups.js";
import {
  GROUP_PRESET_ROW_ID,
  groupNameRowId,
  groupSizeRowId,
  presetToValue,
  readPresetValue,
  type PresetValue,
} from "../services/event-live-edit-groups.js";
import {
  baseField,
  isGroupOverSize,
  valueField,
} from "../services/event-live-edit.js";
import {
  enabledPresets,
  loadPresetCatalog,
  presetResolver,
  catalogNotice,
} from "../services/event-group-preset-service.js";
import type { IEvent } from "../models/event.js";
import type { EventGroupPreset } from "../content/event-group-presets.js";

/** The select of the preset form: a preset id, or empty for "no change". */
export const PRESET_PICK_FIELD = "preset_pick";

export interface GroupEditGroupView {
  name: string;
  marker: string;
  /** Stored size, null = no limit. */
  size: number | null;
  memberCount: number;
  /** Derived (members above size), never stored. */
  overSize: boolean;
  /** The channel still has the old name (a rename is owed). */
  namePending: boolean;
  /** The channel still has the old user limit (a size change is owed). */
  sizePending: boolean;
}

export interface GroupEditViewData {
  groups: GroupEditGroupView[];
  /** Presets that fit this event's groups by position, enabled for the server. */
  presets: Array<{ id: string; label: string }>;
  /** Why the preset list is short (the library could not be read), or null. */
  presetNotice: string | null;
  /** The stored setup in the preset row's shape: the form's base value. */
  presetBase: string;
  groupLabel: string;
}

function hidden(name: string, value: string): string {
  return `<input type="hidden" name="${escapeHtml(name)}" value="${escapeHtml(value)}">`;
}

/** Names and sizes, one row per group; goes INSIDE the settings form. */
export function renderGroupEditor(d: GroupEditViewData): string {
  if (d.groups.length === 0) return "";
  const rows = d.groups
    .map((g, i) => {
      const n = i + 1;
      const nameId = groupNameRowId(i);
      const sizeId = groupSizeRowId(i);
      const sizeText = g.size === null ? "" : String(g.size);
      const notes: string[] = [];
      if (g.overSize) notes.push('<span class="tag tag-off">over size</span>');
      if (g.namePending) {
        notes.push('<span class="muted">channel rename pending</span>');
      }
      if (g.sizePending) {
        notes.push('<span class="muted">channel limit pending</span>');
      }
      return (
        `<tr><td>${g.marker ? `${escapeHtml(g.marker)} ` : ""}${escapeHtml(n)}</td>` +
        `<td><input type="text" maxlength="${GROUP_NAME_MAX}" name="${escapeHtml(valueField(nameId))}" value="${escapeHtml(g.name)}" aria-label="Name of group ${n}">${hidden(baseField(nameId), g.name)}</td>` +
        `<td><input type="number" inputmode="numeric" min="${GROUP_SIZE_MIN}" max="${GROUP_SIZE_MAX}" step="1" name="${escapeHtml(valueField(sizeId))}" value="${escapeHtml(sizeText)}" placeholder="No limit" aria-label="Size of group ${n}">${hidden(baseField(sizeId), sizeText)}</td>` +
        `<td><span class="mono">${escapeHtml(g.memberCount)}</span> ${notes.join(" ")}</td></tr>`
      );
    })
    .join("");
  return `<div class="field"><table class="prefs-table"><thead><tr><th scope="col">#</th><th scope="col">${escapeHtml(d.groupLabel)} name</th><th scope="col">Size</th><th scope="col">People</th></tr></thead><tbody>${rows}</tbody></table>
<p class="muted">A name another ${escapeHtml(d.groupLabel.toLowerCase())} has, or goes back to when a leader's rename is reset, is refused. A rename changes the channel in place (Discord allows about 2 renames per channel every 10 minutes: if it is used up, the name is saved and the channel follows by itself). A size is the most people a group takes and the channel's user limit; lowering it below the number of people moves nobody, the group is marked over size and takes nobody new until it is below its size again. Leave a size empty for no limit.</p></div>`;
}

/** The preset switch, its own form so it never shares a save with name edits. */
export function renderPresetForm(
  d: GroupEditViewData,
  actionPath: string,
  csrfToken: string,
): string {
  if (d.groups.length === 0) return "";
  const options = d.presets
    .map(
      (p) =>
        `<option value="${escapeHtml(p.id)}">${escapeHtml(p.label)}</option>`,
    )
    .join("");
  const notice = d.presetNotice
    ? `<p class="muted">${escapeHtml(d.presetNotice)}</p>`
    : "";
  if (d.presets.length === 0) {
    return `<div class="field"><p class="muted">No preset on this server fits this event's ${escapeHtml(d.groups.length)} groups.</p>${notice}</div>`;
  }
  return `<form method="POST" action="${escapeHtml(actionPath)}">${hidden("_csrf", csrfToken)}
<div class="field"><label for="host-settings-preset">Switch preset</label>
<select id="host-settings-preset" name="${PRESET_PICK_FIELD}">
<option value="">Keep the current groups</option>${options}
</select>
${hidden(baseField(GROUP_PRESET_ROW_ID), d.presetBase)}
<p class="muted">The preset's names, sizes and tags are applied to the existing groups by position. Only presets with the same number of groups and the same kinds are offered: adding or removing groups and changing a kind are separate changes. Every name that would change is shown for confirmation first, including names a leader chose.</p>${notice}</div>
<button type="submit">Apply preset</button>
</form>`;
}

/** The group editor's data for one event (the fresh row) and the server's presets. */
export async function buildGroupEditView(
  event: IEvent,
): Promise<GroupEditViewData> {
  const groups = event.groups ?? [];
  const catalog = await loadPresetCatalog(event.guildId);
  const fits = (preset: EventGroupPreset): boolean =>
    preset.groups.length === groups.length &&
    preset.groups.every((g, i) => g.kind === groups[i].kind);
  return {
    groupLabel: event.groupLabel || "Group",
    groups: groups.map((g) => ({
      name: g.name,
      marker: g.marker ?? "",
      size: typeof g.size === "number" ? g.size : null,
      memberCount: (g.memberIds ?? []).length,
      overSize: isGroupOverSize(g),
      namePending: g.nameSyncPending === true && !!g.channelId,
      sizePending: g.sizeSyncPending === true && !!g.channelId,
    })),
    presets: enabledPresets(catalog)
      .filter(fits)
      .map((p) => ({ id: p.id, label: p.label })),
    presetNotice: catalogNotice(catalog.state),
    presetBase: JSON.stringify(readPresetValue(event)),
  };
}

export type PreparedBody =
  | { ok: true; body: Record<string, unknown> }
  | { ok: false; error: string };

const REFUSED_TEXT = {
  disabled: "That preset is switched off on this server.",
  unreadable:
    "The preset library could not be read, so no preset was applied. Try again.",
  unknown: "That preset does not exist (any more). Reload the page.",
} as const;

/**
 * Turn the posted form into what `parseSubmission` reads. A posted
 * `s_groupPreset` is DROPPED (the content of a preset is never taken from the
 * client); a chosen preset id (`preset_pick`) is resolved against the server's
 * own catalog, read now, and its content becomes the row's value. An id that
 * cannot be resolved fails closed with a reason, and nothing is saved.
 */
export async function prepareGroupEditBody(
  body: unknown,
  guildId: string,
): Promise<PreparedBody> {
  const source = { ...((body ?? {}) as Record<string, unknown>) };
  delete source[valueField(GROUP_PRESET_ROW_ID)];
  const pick = source[PRESET_PICK_FIELD];
  delete source[PRESET_PICK_FIELD];
  if (typeof pick !== "string" || pick === "") return { ok: true, body: source };
  const catalog = await loadPresetCatalog(guildId);
  const found = presetResolver(catalog)(pick);
  if (!("preset" in found)) {
    return { ok: false, error: REFUSED_TEXT[found.refused] };
  }
  const value: PresetValue = presetToValue(found.preset);
  source[valueField(GROUP_PRESET_ROW_ID)] = JSON.stringify(value);
  return { ok: true, body: source };
}
