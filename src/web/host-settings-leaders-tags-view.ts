/**
 * The leaders and tags fields of the host panel's "Live settings" form (#1240).
 * A separate module so the form in `host-settings-view.ts` only has to call
 * `renderLeadersTagsFields`. Every field posts its new value (`s_<row>`) with the
 * value it showed (`b_<row>`), exactly like the other rows (see
 * `services/event-live-edit.ts`, rule 3); a team's tag is one input per team
 * (`s_groupTags_<key>` and `b_groupTags_<key>`, read by the row's `collect`).
 * Everything dynamic goes through `escapeHtml`.
 */

import { escapeHtml } from "./html.js";
import {
  GROUP_LABEL_MAX,
  GROUP_TAG_MAX,
  hasCaptainsLobby,
} from "../services/event-groups.js";
import { baseField, valueField } from "../services/event-live-edit.js";
import {
  groupTagBaseField,
  groupTagField,
} from "../services/event-live-edit-leaders-tags.js";

export interface LeadersTagsTeamView {
  key: string;
  name: string;
  marker: string;
  /** Stored tag; empty = none. */
  tag: string;
}

export interface LeadersTagsView {
  leaders: boolean;
  customisation: boolean;
  leaderLabel: string;
  tags: boolean;
  tagsSuffix: boolean;
  /** The Captains lobby switch (#1251): the event has a leads group. */
  lobby: boolean;
  teams: LeadersTagsTeamView[];
}

/** The fields of an event this view reads (a lean row may lack any). */
export interface LeadersTagsSource {
  groupsEnabled?: boolean | null;
  captainsEnabled?: boolean | null;
  captainCustomisationEnabled?: boolean | null;
  leaderLabel?: string | null;
  tagsEnabled?: boolean | null;
  tagsSuffix?: boolean | null;
  groups?: ReadonlyArray<{
    key: string;
    name: string;
    kind?: string;
    marker?: string | null;
    tag?: string | null;
  }> | null;
}

/** The view data of an event, or null when it has no groups (nothing to edit). */
export function leadersTagsViewOf(
  event: LeadersTagsSource,
): LeadersTagsView | null {
  if (event.groupsEnabled !== true || (event.groups ?? []).length === 0) {
    return null;
  }
  return {
    leaders: event.captainsEnabled === true,
    customisation: event.captainCustomisationEnabled === true,
    leaderLabel: event.leaderLabel ? event.leaderLabel : "Leader",
    tags: event.tagsEnabled === true,
    tagsSuffix: event.tagsSuffix === true,
    lobby: hasCaptainsLobby(event.groups),
    teams: (event.groups ?? [])
      .filter((g) => g.kind === "team")
      .map((g) => ({
        key: g.key,
        name: g.name,
        marker: g.marker ?? "",
        tag: (g.tag ?? "").trim(),
      })),
  };
}

function hidden(name: string, value: string): string {
  return `<input type="hidden" name="${escapeHtml(name)}" value="${escapeHtml(value)}">`;
}

function onOff(
  rowId: string,
  id: string,
  label: string,
  on: boolean,
  texts: { on: string; off: string },
  hint: string,
): string {
  return `<div class="field"><label for="${escapeHtml(id)}">${escapeHtml(label)}</label>
<select id="${escapeHtml(id)}" name="${escapeHtml(valueField(rowId))}">
<option value="1"${on ? " selected" : ""}>${escapeHtml(texts.on)}</option>
<option value="0"${on ? "" : " selected"}>${escapeHtml(texts.off)}</option>
</select>
${hidden(baseField(rowId), on ? "1" : "0")}
<p class="muted">${escapeHtml(hint)}</p></div>`;
}

/**
 * The Captains lobby switch (#1251). It follows the leaders switch: with leaders
 * off and no lobby it is disabled (a disabled field is not posted, so the row is
 * untouched); a lobby that exists can always be turned off.
 */
function renderLobby(d: LeadersTagsView): string {
  const disabled = !d.leaders && !d.lobby;
  const hint = disabled
    ? "Turn leaders on and save first: the lobby is for the host and the current leaders."
    : !d.leaders
      ? "Leaders are off, so only you can join the lobby now. Turn it off to remove its channel, or turn leaders on to let the current leaders in."
      : "A separate voice channel that only you and the current leaders can join; nobody is assigned to it. Off by default: leaders then talk in the main channel. Turning it on creates the channel (at once while the event runs). Turning it off moves everybody in it to the main channel, you included, and deletes it; you are asked to confirm first when the channel exists.";
  return `<div class="field"><label for="host-settings-lobby">Captains lobby</label>
<select id="host-settings-lobby" name="${escapeHtml(valueField("captainsLobby"))}"${disabled ? " disabled" : ""}>
<option value="1"${d.lobby ? " selected" : ""}>On: a leaders-only voice channel</option>
<option value="0"${d.lobby ? "" : " selected"}>Off: leaders talk in the main channel</option>
</select>
${hidden(baseField("captainsLobby"), d.lobby ? "1" : "0")}
<p class="muted">${escapeHtml(hint)}</p></div>`;
}

function renderTeamTags(d: LeadersTagsView): string {
  if (d.teams.length === 0) return "";
  const items = d.teams
    .map((t, i) => {
      const id = `host-settings-tag-${i}`;
      const name = `${t.marker ? `${t.marker} ` : ""}${t.name}`;
      return `<div class="field"><label for="${id}">Tag of ${escapeHtml(name)}</label>
<input id="${id}" type="text" maxlength="${GROUP_TAG_MAX}" name="${escapeHtml(groupTagField(t.key))}" value="${escapeHtml(t.tag)}" placeholder="no tag">
${hidden(groupTagBaseField(t.key), t.tag)}</div>`;
    })
    .join("\n");
  return `${items}
<p class="muted">An empty tag means that team carries no tag. A changed tag is put on the members' nicknames from their original nickname, never on top of the old tag.</p>`;
}

/** The leaders and tags part of the form. Empty when the event has no groups. */
export function renderLeadersTagsFields(d: LeadersTagsView | null): string {
  if (!d) return "";
  return `<fieldset class="field"><legend>Leaders</legend>
${onOff(
  "captainsEnabled",
  "host-settings-leaders",
  "Leaders",
  d.leaders,
  {
    on: "On: each team can have a leader",
    off: "Off: no leaders, no controls, no leaders-only access",
  },
  "Turning leaders off hides the Leaders section and removes the leaders-only channel access at once. Who was chosen is kept, and comes back when you turn leaders on again.",
)}
<div class="field"><label for="host-settings-leader-label">What leaders are called</label>
<input id="host-settings-leader-label" type="text" maxlength="${GROUP_LABEL_MAX}" name="${escapeHtml(valueField("leaderLabel"))}" value="${escapeHtml(d.leaderLabel)}">
${hidden(baseField("leaderLabel"), d.leaderLabel)}</div>
${onOff(
  "captainCustomisationEnabled",
  "host-settings-customisation",
  "Leaders may rename their team and set its tag",
  d.customisation,
  { on: "On", off: "Off" },
  "Only has an effect while leaders are on. Turning it off removes the Customise button at once and refuses a form that is already open. The names and tags leaders chose are kept; reset a team in the Customise section to put the originals back.",
)}
${renderLobby(d)}
</fieldset>
<fieldset class="field"><legend>Clan tags</legend>
${onOff(
  "tagsEnabled",
  "host-settings-tags",
  "Clan tags on server nicknames",
  d.tags,
  {
    on: "On: members of a tagged team carry its tag",
    off: "Off: nicknames are put back as they were",
  },
  "Nicknames follow in the background, a few every second, so a big team takes a moment. Original nicknames are kept and always put back.",
)}
${onOff(
  "tagsSuffix",
  "host-settings-tags-position",
  "Where the tag goes",
  d.tagsSuffix,
  { on: "After the name (Alice [RED])", off: "Before the name ([RED] Alice)" },
  "Only has an effect while clan tags are on.",
)}
${renderTeamTags(d)}
</fieldset>`;
}
