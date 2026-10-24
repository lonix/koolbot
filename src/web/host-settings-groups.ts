/**
 * The group editor of the host panel's "Live settings" section (#1241): the
 * markers, names, sizes and tags of the groups (the event form's rows,
 * `renderGroupRow`, #1406), and the preset switch. Kept apart from
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
import { CONFIRM_FETCH_ATTR, confirmFetchError } from "./confirm-fetch.js";
import {
  GROUP_KIND_OPTIONS,
  GROUP_ROWS_HEAD,
  renderGroupRow,
} from "./admin-views.js";
import { renderSeriesTick } from "./host-settings-series.js";
import {
  GROUP_NAME_MAX,
  GROUP_SIZE_MAX,
  GROUP_SIZE_MIN,
  GROUP_TAG_MAX,
  newGroupKey,
} from "../services/event-groups.js";
import {
  GROUP_ADD_FIELDS,
  GROUP_REMOVE_BASE_FIELD,
  groupRemoveField,
} from "../services/event-live-edit-group-set.js";
import {
  GROUP_PRESET_ROW_ID,
  groupNameRowId,
  groupMarkerBaseField,
  groupMarkerField,
  groupNameKeyField,
  groupSizeKeyField,
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
  groupTagBaseField,
  groupTagField,
} from "../services/event-live-edit-leaders-tags.js";
import {
  enabledPresets,
  loadPresetCatalog,
  presetResolver,
  catalogNotice,
} from "../services/event-group-preset-service.js";
import type { IEvent } from "../models/event.js";
import {
  PERSONAL_PRESET_PREFIX,
  type EventGroupPreset,
} from "../content/event-group-presets.js";

/** The select of the preset form: a preset id, or empty for "no change". */
export const PRESET_PICK_FIELD = "preset_pick";

export interface GroupEditGroupView {
  /** The group's key: the identity the name and size fields are guarded by, and the remove checkbox's name. */
  key: string;
  /** `team`, `open` or `leads` (the hidden captains lobby: not listed or editable here). */
  kind: string;
  name: string;
  marker: string;
  /** Stored tag, empty = none (only a team carries one). */
  tag: string;
  /** Stored size, null = no limit. */
  size: number | null;
  memberCount: number;
  /** Derived (members above size), never stored. */
  overSize: boolean;
  /** The channel still has the old name (a rename is owed). */
  namePending: boolean;
  /** The channel still has the old user limit (a size change is owed). */
  sizePending: boolean;
  /** The group has a voice channel (removing it deletes the channel). */
  hasChannel: boolean;
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
  /**
   * Where "Save as my preset" goes (#1216): the host's own presets page,
   * prefilled from this event. Absent = no link.
   */
  savePresetHref?: string;
  /**
   * The key the "add a group" form would give a new group, minted when the page
   * is built: posting the same form twice is the same request (the second finds
   * the key stored and adds nothing).
   */
  addKey: string;
}

function hidden(name: string, value: string): string {
  return `<input type="hidden" name="${escapeHtml(name)}" value="${escapeHtml(value)}">`;
}

/**
 * Marker, name, size and tag, one row per group; goes INSIDE the settings form.
 * The rows are the event form's (`renderGroupRow` and the group rows script), so
 * the places that edit groups look and work the same; only the field names are
 * the live edit's (see the options passed below).
 */
export function renderGroupEditor(d: GroupEditViewData): string {
  if (d.groups.length === 0) return "";
  // The hidden captains lobby (#1251) has no row here. The row ids are the
  // STORED positions (`groupNameC` names the third stored group), so the lobby
  // is skipped, never renumbered around: the groups after it keep their ids.
  let shown = 0;
  const rows = d.groups
    .map((g, i) => {
      if (g.kind === "leads") return "";
      const n = ++shown;
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
      const isTeam = g.kind === "team";
      // The shown values (`b_`) and the key each positional row was shown for
      // (`k_`, the guard of the name and size rows). The marker and the tag are
      // addressed by key and carry no guard.
      const extra =
        hidden(baseField(nameId), g.name) +
        hidden(groupNameKeyField(i), g.key) +
        hidden(baseField(sizeId), sizeText) +
        hidden(groupSizeKeyField(i), g.key) +
        hidden(groupMarkerBaseField(g.key), g.marker) +
        (isTeam ? hidden(groupTagBaseField(g.key), g.tag) : "") +
        `<p class="muted"><span class="mono">${escapeHtml(g.memberCount)}</span> ${g.memberCount === 1 ? "person" : "people"} ${notes.join(" ")}</p>`;
      return renderGroupRow(
        String(i),
        String(n),
        {
          marker: g.marker,
          name: g.name,
          size: sizeText,
          tag: g.tag,
          kind: g.kind,
        },
        {
          names: {
            marker: groupMarkerField(g.key),
            name: valueField(nameId),
            size: valueField(sizeId),
            tag: groupTagField(g.key),
          },
          fixedKind: true,
          noTag: !isTeam,
          extra,
        },
      );
    })
    .join("\n");
  // Only the hidden lobby: nothing to edit here.
  if (shown === 0) return "";
  const label = escapeHtml(d.groupLabel.toLowerCase());
  return `<div class="field"><div class="kb-grouprows" data-group-rows>
${GROUP_ROWS_HEAD}
${rows}
</div>
<p class="muted">A name another ${label} has, or goes back to when a leader's rename is reset, is refused. A marker is the emoji in front of the channel's name, so changing it renames the channel like a name does (Discord allows about 2 renames per channel every 10 minutes: if it is used up, the change is saved and the channel follows by itself). A size is the most people a group takes and the channel's user limit; lowering it below the number of people moves nobody, the group is marked over size and takes nobody new until it is below its size again. Leave a size empty for no limit. An empty tag means that team carries no tag; a changed tag is put on the members' nicknames from their original nickname, never on top of the old tag. Only a team has a tag.</p></div>`;
}

/** The preset switch, its own form so it never shares a save with name edits. */
export function renderPresetForm(
  d: GroupEditViewData,
  actionPath: string,
  csrfToken: string,
  seriesTick?: boolean,
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
  const links = d.savePresetHref
    ? `<p class="muted"><a href="${escapeHtml(d.savePresetHref)}">Save these groups as my preset</a> · <a href="/me/events/presets">My presets</a></p>`
    : "";
  if (d.presets.length === 0) {
    // The hidden captains lobby is not counted: the host sees no such group.
    const listed = d.groups.filter((g) => g.kind !== "leads").length;
    return `<div class="field"><p class="muted">No preset on this server fits this event's ${escapeHtml(listed)} groups.</p>${notice}${links}</div>`;
  }
  return `<form method="POST" action="${escapeHtml(actionPath)}">${hidden("_csrf", csrfToken)}
<div class="field"><label for="host-settings-preset">Switch preset</label>
<select id="host-settings-preset" name="${PRESET_PICK_FIELD}">
<option value="">Keep the current groups</option>${options}
</select>
${hidden(baseField(GROUP_PRESET_ROW_ID), d.presetBase)}
<p class="muted">The preset's names, sizes and tags are applied to the existing groups by position. Only presets with the same number of groups and the same kinds are offered: adding or removing groups and changing a kind are separate changes. The captains lobby is not counted and is never changed by a preset (use its own switch above). Every name that would change is shown for confirmation first, including names a leader chose.</p>${notice}${links}</div>
${renderSeriesTick(seriesTick)}
<button type="submit">Apply preset</button>
</form>`;
}

/**
 * Removing and adding groups (#1242): two forms of their own, so that neither
 * ever shares a save with the positional name and size fields (the groups they
 * address are named by key, never by position). Removal always goes through the
 * confirmation page.
 */
export function renderGroupSetForms(
  d: GroupEditViewData,
  actionPath: string,
  csrfToken: string,
  seriesTick?: boolean,
): string {
  if (d.groups.length === 0) return "";
  const tick = renderSeriesTick(seriesTick);
  const label = d.groupLabel.toLowerCase();
  // The captains lobby is a switch, not a group to tick or add (#1251).
  const listed = d.groups.filter((g) => g.kind !== "leads");
  const boxes = listed
    .map((g) => {
      const facts = [
        g.memberCount === 0
          ? "nobody assigned"
          : `${g.memberCount} ${g.memberCount === 1 ? "person" : "people"} assigned`,
        g.hasChannel ? "has a voice channel" : "no channel yet",
      ].join(", ");
      return `<label class="check"><input type="checkbox" name="${escapeHtml(groupRemoveField(g.key))}" value="1"> ${g.marker ? `${escapeHtml(g.marker)} ` : ""}${escapeHtml(g.name)} <span class="muted">(${escapeHtml(facts)})</span></label>`;
    })
    .join("\n");
  const remove =
    listed.length <= 1
      ? `<div class="field"><p class="muted">An event keeps at least one ${escapeHtml(label)}, so the last one cannot be removed.</p></div>`
      : `<form method="POST" action="${escapeHtml(actionPath)}"${CONFIRM_FETCH_ATTR}>${hidden("_csrf", csrfToken)}
<fieldset class="field"><legend>Remove ${escapeHtml(label)}s</legend>
${boxes}
${hidden(GROUP_REMOVE_BASE_FIELD, "[]")}
<p class="muted">Tick the ${escapeHtml(label)}s to remove. You are asked to confirm first. Everybody in a removed ${escapeHtml(label)}'s channel, you included, is moved to the main channel, its members are unassigned (their clan tags come off), and then the channel is deleted. If somebody cannot be moved, that ${escapeHtml(label)} is kept and the result says why: save again to move the rest.</p></fieldset>
${tick}
<button type="submit">Remove selected</button>
${confirmFetchError()}
</form>`;
  const kinds = GROUP_KIND_OPTIONS.map(
    ([value, text]) =>
      `<option value="${escapeHtml(value)}">${escapeHtml(text)}</option>`,
  ).join("");
  const add = `<form method="POST" action="${escapeHtml(actionPath)}">${hidden("_csrf", csrfToken)}
<fieldset class="field"><legend>Add a ${escapeHtml(label)}</legend>
<label for="host-settings-add-name">Name</label>
<input id="host-settings-add-name" type="text" maxlength="${GROUP_NAME_MAX}" name="${escapeHtml(GROUP_ADD_FIELDS.name)}" required>
<label for="host-settings-add-kind">Kind</label>
<select id="host-settings-add-kind" name="${escapeHtml(GROUP_ADD_FIELDS.kind)}">${kinds}</select>
<label for="host-settings-add-size">Size</label>
<input id="host-settings-add-size" type="number" inputmode="numeric" min="${GROUP_SIZE_MIN}" max="${GROUP_SIZE_MAX}" step="1" name="${escapeHtml(GROUP_ADD_FIELDS.size)}" placeholder="No limit">
<label for="host-settings-add-tag">Tag</label>
<input id="host-settings-add-tag" type="text" maxlength="${GROUP_TAG_MAX}" name="${escapeHtml(GROUP_ADD_FIELDS.tag)}">
${hidden(GROUP_ADD_FIELDS.key, d.addKey)}${hidden(GROUP_ADD_FIELDS.base, "[]")}
<p class="muted">The new ${escapeHtml(label)} goes last and gets its voice channel next to the others. Everybody stays where they are. The same limits as when the event was made apply, and a name another ${escapeHtml(label)} has is refused.</p></fieldset>
${tick}
<button type="submit">Add ${escapeHtml(label)}</button>
</form>`;
  return `${remove}\n${add}`;
}

/** The group editor's data for one event (the fresh row) and the server's presets. */
export async function buildGroupEditView(
  event: IEvent,
  viewerId?: string,
): Promise<GroupEditViewData> {
  const groups = event.groups ?? [];
  // The viewer's own presets are offered next to the server's (#1216), even
  // when an admin is looking at an event somebody else hosts.
  const catalog = await loadPresetCatalog(event.guildId, {
    ownerId: viewerId,
  });
  // The captains lobby is left out on both sides (#1263): a preset with a lobby
  // fits an event without one and the reverse. Applying a preset never touches
  // the lobby; the Captains lobby switch of this panel owns it.
  const visible = groups.filter((g) => g.kind !== "leads");
  const fits = (preset: EventGroupPreset): boolean => {
    const listed = preset.groups.filter((g) => g.kind !== "leads");
    return (
      listed.length > 0 &&
      listed.length === visible.length &&
      listed.every((g, i) => g.kind === visible[i].kind)
    );
  };
  return {
    groupLabel: event.groupLabel || "Group",
    addKey: newGroupKey(new Set(groups.map((g) => g.key))),
    groups: groups.map((g) => ({
      key: g.key,
      kind: g.kind,
      hasChannel: !!g.channelId,
      name: g.name,
      marker: g.marker ?? "",
      tag: (g.tag ?? "").trim(),
      size: typeof g.size === "number" ? g.size : null,
      memberCount: (g.memberIds ?? []).length,
      overSize: isGroupOverSize(g),
      namePending: g.nameSyncPending === true && !!g.channelId,
      sizePending: g.sizeSyncPending === true && !!g.channelId,
    })),
    presets: enabledPresets(catalog)
      .filter(fits)
      .map((p) => ({
        id: p.id,
        label: p.id.startsWith(PERSONAL_PRESET_PREFIX)
          ? `${p.label} (yours)`
          : p.label,
      })),
    presetNotice: catalogNotice(catalog.state, catalog.personalUnreadable),
    savePresetHref: `/me/events/presets?fromEvent=${encodeURIComponent(String(event._id))}`,
    presetBase: JSON.stringify(readPresetValue(event)),
  };
}

export type PreparedBody =
  { ok: true; body: Record<string, unknown> } | { ok: false; error: string };

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
  viewerId?: string,
): Promise<PreparedBody> {
  const source = { ...((body ?? {}) as Record<string, unknown>) };
  delete source[valueField(GROUP_PRESET_ROW_ID)];
  const pick = source[PRESET_PICK_FIELD];
  delete source[PRESET_PICK_FIELD];
  if (typeof pick !== "string" || pick === "")
    return { ok: true, body: source };
  // Only the viewer's own personal presets resolve (#1216): another host's
  // `my:` id is "unknown" here, exactly as if it did not exist.
  const catalog = await loadPresetCatalog(guildId, { ownerId: viewerId });
  const found = presetResolver(catalog)(pick);
  if (!("preset" in found)) {
    return { ok: false, error: REFUSED_TEXT[found.refused] };
  }
  const value: PresetValue = presetToValue(found.preset);
  source[valueField(GROUP_PRESET_ROW_ID)] = JSON.stringify(value);
  return { ok: true, body: source };
}
