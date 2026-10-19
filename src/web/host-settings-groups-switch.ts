/**
 * The "Groups on or off" forms of the host panel's "Live settings" section
 * (#1243). Kept apart from `host-settings-groups.ts` and `host-settings-view.ts`
 * (which only call `renderGroupsSwitchForms`), and every form is its own, so the
 * switch never shares a save with the positional name and size fields.
 *
 * The forms follow the core's convention (`services/event-live-edit.ts` rule 3):
 * the value the page SHOWED (`b_groupsEnabled`) next to the value it holds
 * (`s_groupsEnabled`, `{"on":true}` or `{"on":false}`). The CONTENT of the
 * groups a switch-on creates is never posted: the select names a preset by id
 * (`groups_pick`) and the SERVER turns that id into the preset's content
 * (`prepareGroupsSwitchBody`), from its own catalog, read at that moment; a
 * posted `setup` is dropped. Switching off always goes through the
 * confirmation page. Everything dynamic goes through `escapeHtml`.
 */

import { escapeHtml } from "./html.js";
import {
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
): string {
  return `<form method="POST" action="${escapeHtml(actionPath)}">${hidden("_csrf", csrfToken)}
${body}
<button type="submit">${escapeHtml(button)}</button>
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
  if (v.presets.length === 0) {
    return `<div class="field"><p><strong>Groups are off.</strong></p><p class="muted">Groups are switched on from a preset, and no preset is available on this server right now. Presets are managed in the Web UI under Events.</p>${notice}</div>`;
  }
  const options = v.presets
    .map(
      (p) =>
        `<option value="${escapeHtml(p.id)}">${escapeHtml(p.label)} (${escapeHtml(p.count)} ${p.count === 1 ? "group" : "groups"})</option>`,
    )
    .join("");
  return form(
    actionPath,
    csrfToken,
    `<div class="field"><p><strong>Groups are off.</strong> This event has no groups yet.</p>
<label for="host-settings-groups-pick">Switch groups on with</label>
<select id="host-settings-groups-pick" name="${GROUPS_PICK_FIELD}" required>
<option value="">Choose a preset</option>${options}
</select>
${hidden(base, OFF)}
<p class="muted">The preset's groups are created with their voice channels next to the main channel. Leaders, leader customisation and the lock stay off (switch them on afterwards), and clan tags follow the preset's default. Nobody is assigned yet. Rename, add or remove groups afterwards if the preset is not quite right.</p>${notice}</div>`,
    "Switch groups on",
  );
}

const REFUSED_TEXT = {
  disabled: "That preset is switched off on this server.",
  unreadable:
    "The preset library could not be read, so groups were not switched on. Try again.",
  unknown: "That preset does not exist (any more). Reload the page.",
} as const;

/**
 * Turn the posted form into what `parseSubmission` reads. The content of the
 * groups is never taken from the client: a posted `s_groupsEnabled` keeps only
 * its on flag, and a chosen preset id (`groups_pick`) is resolved against the
 * server's own catalog, read now, and its content becomes the row's value. An
 * id that cannot be resolved fails closed with a reason, and nothing is saved.
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
  if (typeof pick !== "string" || pick === "")
    return { ok: true, body: source };
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
