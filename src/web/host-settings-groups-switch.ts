/**
 * The "Groups on or off" forms of the host panel's "Live settings" section
 * (#1243). Kept apart from `host-settings-groups.ts` and `host-settings-view.ts`
 * (which only call `renderGroupsSwitchForms`), and every form is its own, so the
 * switch never shares a save with the positional name and size fields.
 *
 * The forms follow the core's convention (`services/event-live-edit.ts` rule 3):
 * the value the page SHOWED (`b_groupsEnabled`) next to the value it holds
 * (`s_groupsEnabled`, `{"on":true}` or `{"on":false}`). A posted `setup` is
 * always dropped: the content of the groups a switch-on creates is either a
 * PRESET (the select names it by id, `groups_pick`, and the SERVER turns the id
 * into its content from its own catalog, read at that moment) or the host's OWN
 * starter groups (the `custom_*` rows, read and checked by the server with the
 * event form's rules, then validated again by the row as the whole edited
 * setup). Switching off always goes through the confirmation page. Everything dynamic goes through `escapeHtml`.
 */

import { escapeHtml } from "./html.js";
import {
  type SwitchSetup,
  GROUPS_PICK_FIELD,
  GROUPS_SWITCH_ROW_ID,
  parseSwitchValue,
  presetToSetup,
} from "../services/event-live-edit-groups-switch.js";
import { baseField, valueField } from "../services/event-live-edit.js";
import {
  catalogNotice,
  enabledPresets,
  loadPresetCatalog,
  presetResolver,
} from "../services/event-group-preset-service.js";
import { GROUP_KIND_OPTIONS } from "./admin-views.js";
import {
  DEFAULT_GROUP_LABEL,
  DEFAULT_LEADER_LABEL,
  GROUP_NAME_MAX,
  GROUP_SIZE_MAX,
  GROUP_SIZE_MIN,
  GROUP_TAG_MAX,
  checkGroupName,
  checkGroupSize,
  checkGroupTag,
} from "../services/event-groups.js";
import { EVENT_GROUP_KINDS } from "../models/event-group-kinds.js";
import type { PreparedBody } from "./host-settings-groups.js";
import type { IEvent } from "../models/event.js";

export interface GroupsSwitchView {
  /** Groups are on for this event. */
  on: boolean;
  /** What a group is called ("Team", "Squad"), for the texts. */
  groupLabel: string;
  /** Groups are on and the main channel exists but a group has no channel yet. */
  channelOwed: boolean;
  /** Why groups cannot be switched on (an adopted Discord event), or null. */
  blocked: string | null;
  /** Groups and people of the groups kept from before (off only). */
  kept: Array<{ name: string; people: number }>;
  /** Presets to switch on with (off, nothing kept). */
  presets: Array<{ id: string; label: string; count: number }>;
  /** Why the preset list is short (the library could not be read), or null. */
  presetNotice: string | null;
  /** Groups and channels now (on only), for the texts. */
  groupCount: number;
  channelCount: number;
}

/** How many starter groups the custom setup form has (blank names are skipped). */
export const CUSTOM_GROUP_ROWS = 6;
const customField = (part: string, i: number): string => `custom_${part}_${i}`;

function hidden(name: string, value: string): string {
  return `<input type="hidden" name="${escapeHtml(name)}" value="${escapeHtml(value)}">`;
}

const ON = JSON.stringify({ on: true });
const OFF = JSON.stringify({ on: false });

/** The data of the forms for one event (the fresh row) and the server's presets. */
export async function buildGroupsSwitchView(
  event: IEvent,
): Promise<GroupsSwitchView> {
  const groups = event.groups ?? [];
  const on = event.groupsEnabled === true;
  const base = {
    on,
    groupLabel: event.groupLabel || "Group",
    channelOwed: on && !!event.channelId && groups.some((g) => !g.channelId),
    blocked:
      event.nativeAdopted === true
        ? "This is an existing Discord event KoolBot only reads, so it cannot have groups."
        : null,
    groupCount: groups.length,
    channelCount: groups.filter((g) => !!g.channelId).length,
  };
  if (on || base.blocked !== null || groups.length > 0) {
    return {
      ...base,
      kept: on
        ? []
        : groups.map((g) => ({
            name: g.name,
            people: (g.memberIds ?? []).length,
          })),
      presets: [],
      presetNotice: null,
    };
  }
  const catalog = await loadPresetCatalog(event.guildId);
  return {
    ...base,
    kept: [],
    presets: enabledPresets(catalog).map((p) => ({
      id: p.id,
      label: p.label,
      count: p.groups.length,
    })),
    presetNotice: catalogNotice(catalog.state),
  };
}

function form(
  actionPath: string,
  csrfToken: string,
  body: string,
  button: string,
  /** Skip the browser's own field checks (the server checks what is used). */
  noValidate = false,
): string {
  return `<form method="POST" action="${escapeHtml(actionPath)}">${hidden("_csrf", csrfToken)}
${body}
<button type="submit"${noValidate ? " formnovalidate" : ""}>${escapeHtml(button)}</button>
</form>`;
}

/** The switch forms: its own card of the settings section. */
export function renderGroupsSwitchForms(
  v: GroupsSwitchView,
  actionPath: string,
  csrfToken: string,
): string {
  const label = v.groupLabel.toLowerCase();
  const id = valueField(GROUPS_SWITCH_ROW_ID);
  const base = baseField(GROUPS_SWITCH_ROW_ID);
  if (v.on) {
    const off = form(
      actionPath,
      csrfToken,
      `<div class="field"><p><strong>Groups are on</strong> (${escapeHtml(v.groupCount)} ${escapeHtml(label)}${v.groupCount === 1 ? "" : "s"}, ${escapeHtml(v.channelCount)} with a voice channel).</p>
${hidden(id, OFF)}${hidden(base, ON)}
<p class="muted">Switching groups off asks you to confirm first. Everybody in the group channels, you included, is moved to the main channel, then the channels are deleted and the clan tags come off the nicknames. The ${escapeHtml(label)}s and who was in them are kept, but nobody counts as in a ${escapeHtml(label)} while groups are off; switching groups on again brings them back with new channels. If somebody cannot be moved, nothing is deleted and groups stay on: the result says who, and you can save again to move the rest.</p></div>`,
      "Switch groups off",
    );
    const owed = v.channelOwed
      ? form(
          actionPath,
          csrfToken,
          `<div class="field"><p class="muted">A ${escapeHtml(label)} has no voice channel yet. KoolBot keeps trying every minute; this tries now.</p>${hidden(id, ON)}${hidden(base, ON)}</div>`,
          "Create the missing channels",
        )
      : "";
    return `${off}\n${owed}`;
  }
  if (v.blocked !== null) {
    return `<div class="field"><p class="muted">${escapeHtml(v.blocked)}</p></div>`;
  }
  if (v.kept.length > 0) {
    const list = v.kept
      .map(
        (g) =>
          `<li>${escapeHtml(g.name)} <span class="muted">(${g.people === 0 ? "nobody assigned" : `${escapeHtml(g.people)} assigned`})</span></li>`,
      )
      .join("");
    return form(
      actionPath,
      csrfToken,
      `<div class="field"><p><strong>Groups are off.</strong> These ${escapeHtml(label)}s were kept:</p><ul>${list}</ul>
${hidden(id, ON)}${hidden(base, OFF)}
<p class="muted">Switching groups on brings them back as they were, with the people assigned to them (and their leaders), and creates their voice channels next to the main channel. Clan tags go back on the nicknames when tags are on and the event is running.</p></div>`,
      "Switch groups on",
    );
  }
  const notice = v.presetNotice
    ? `<p class="muted">${escapeHtml(v.presetNotice)}</p>`
    : "";
  const options = v.presets
    .map(
      (p) =>
        `<option value="${escapeHtml(p.id)}">${escapeHtml(p.label)} (${escapeHtml(p.count)} ${p.count === 1 ? "group" : "groups"})</option>`,
    )
    .join("");
  const picker =
    v.presets.length === 0
      ? `<p class="muted">No preset is available on this server right now, so set the groups up yourself below.</p>`
      : `<label for="host-settings-groups-pick">Switch groups on with a preset</label>
<select id="host-settings-groups-pick" name="${GROUPS_PICK_FIELD}">
<option value="">No preset: use my own groups below</option>${options}
</select>`;
  const kinds = GROUP_KIND_OPTIONS.map(
    ([value, text]) =>
      `<option value="${escapeHtml(value)}">${escapeHtml(text)}</option>`,
  ).join("");
  const rows = Array.from({ length: CUSTOM_GROUP_ROWS }, (_, k) => {
    const i = k + 1;
    return `<tr><td>${i}</td><td><input type="text" maxlength="${GROUP_NAME_MAX}" name="${customField("name", i)}" aria-label="Name of group ${i}"></td>
<td><select name="${customField("kind", i)}" aria-label="Kind of group ${i}">${kinds}</select></td>
<td><input type="number" inputmode="numeric" min="${GROUP_SIZE_MIN}" max="${GROUP_SIZE_MAX}" step="1" name="${customField("size", i)}" placeholder="No limit" aria-label="Size of group ${i}"></td>
<td><input type="text" maxlength="${GROUP_TAG_MAX}" name="${customField("tag", i)}" aria-label="Tag of group ${i}"></td></tr>`;
  }).join("");
  return form(
    actionPath,
    csrfToken,
    `<div class="field"><p><strong>Groups are off.</strong> This event has no groups yet.</p>
${picker}
<table class="prefs-table"><caption class="muted">Or your own groups (leave a name empty to skip a row)</caption><thead><tr><th scope="col">#</th><th scope="col">Name</th><th scope="col">Kind</th><th scope="col">Size</th><th scope="col">Tag</th></tr></thead><tbody>${rows}</tbody></table>
${hidden(base, OFF)}
<p class="muted">A chosen preset wins over the rows. The groups are created with their voice channels next to the main channel. Leaders, leader customisation and the lock stay off (switch them on afterwards), and clan tags follow the preset's default (off for your own groups). Nobody is assigned yet. Add, rename, resize or remove groups afterwards with the other forms; the same limits as when an event is made apply.</p>${notice}</div>`,
    "Switch groups on",
    // Six rows, most of them blank or ignored (a chosen preset wins, a blank
    // name skips its row): the browser must not refuse the submit over a size in
    // a row the server does not use. Every row that IS used is checked by the
    // server (name, size, tag, kind) and by the row's whole-setup validation.
    true,
  );
}

/**
 * The host's own starter groups, read from the `custom_*` fields with the
 * rules of the event form (the typed content is the host's own, unlike a preset's;
 * the row validates it again as the whole edited setup). Null when no row has a
 * name; an error names the row and the field.
 */
function customSetup(
  source: Record<string, unknown>,
): { setup: SwitchSetup } | { error: string } | null {
  const str = (part: string, i: number): string => {
    const v = source[customField(part, i)];
    return typeof v === "string" ? v : "";
  };
  const groups: SwitchSetup["groups"] = [];
  for (let i = 1; i <= CUSTOM_GROUP_ROWS; i++) {
    if (str("name", i).trim() === "") continue;
    const name = checkGroupName(str("name", i));
    if (!name.ok) return { error: `Group ${i} name: ${name.error}` };
    const size = checkGroupSize(str("size", i));
    if (!size.ok) return { error: `Group ${i} size: ${size.error}` };
    const tag = checkGroupTag(str("tag", i));
    if (!tag.ok) return { error: `Group ${i} tag: ${tag.error}` };
    const kind = str("kind", i) || "team";
    if (!(EVENT_GROUP_KINDS as readonly string[]).includes(kind)) {
      return { error: `Group ${i} kind: must be team, open or leads.` };
    }
    groups.push({
      name: name.value,
      kind,
      size: size.value,
      tag: tag.value,
      marker: "",
    });
  }
  if (groups.length === 0) return null;
  return {
    setup: {
      id: "",
      groupLabel: DEFAULT_GROUP_LABEL,
      leaderLabel: DEFAULT_LEADER_LABEL,
      tagsEnabled: false,
      groups,
    },
  };
}

const REFUSED_TEXT = {
  disabled: "That preset is switched off on this server.",
  unreadable:
    "The preset library could not be read, so groups were not switched on. Try again.",
  unknown: "That preset does not exist (any more). Reload the page.",
} as const;

/**
 * Turn the posted form into what `parseSubmission` reads. A posted
 * `s_groupsEnabled` keeps only its on flag; a chosen preset id (`groups_pick`)
 * is resolved against the server's own catalog, read now, and its content becomes
 * the row's value (an id that cannot be resolved fails closed with a reason, and
 * nothing is saved); without one, the filled `custom_*` rows become the value.
 */
export async function prepareGroupsSwitchBody(
  body: Record<string, unknown>,
  guildId: string,
): Promise<PreparedBody> {
  const source = { ...body };
  const field = valueField(GROUPS_SWITCH_ROW_ID);
  const pick = source[GROUPS_PICK_FIELD];
  delete source[GROUPS_PICK_FIELD];
  const posted = source[field];
  if (typeof posted === "string") {
    const value = parseSwitchValue(posted);
    // An unreadable value is left as it is: the parser refuses it.
    if (value) source[field] = JSON.stringify({ on: value.on });
  }
  const custom = customSetup(source);
  for (let i = 1; i <= CUSTOM_GROUP_ROWS; i++) {
    for (const part of ["name", "kind", "size", "tag"]) {
      delete source[customField(part, i)];
    }
  }
  if (typeof pick !== "string" || pick === "") {
    if (custom === null) return { ok: true, body: source };
    if ("error" in custom) return { ok: false, error: custom.error };
    source[field] = JSON.stringify({ on: true, setup: custom.setup });
    return { ok: true, body: source };
  }
  const catalog = await loadPresetCatalog(guildId);
  const found = presetResolver(catalog)(pick);
  if (!("preset" in found)) {
    return { ok: false, error: REFUSED_TEXT[found.refused] };
  }
  source[field] = JSON.stringify({
    on: true,
    setup: presetToSetup(found.preset),
  });
  return { ok: true, body: source };
}
