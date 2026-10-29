/**
 * The leaders and tags fields of the host panel's "Live settings" form (#1240).
 * A separate module so the form in `host-settings-view.ts` only has to call
 * `renderLeadersTagsFields`. Every field posts its new value (`s_<row>`) with the
 * value it showed (`b_<row>`), exactly like the other rows (see
 * `services/event-live-edit.ts`, rule 3); a switch posts `1` only while on, and
 * `prepareSettingsBody` (`host-settings-rows.ts`) reads its missing value as off.
 * A team's tag is not here any more: its input is in the group rows
 * (`host-settings-groups.ts`). The rows are SettingRows (#1514).
 * Everything dynamic goes through `escapeHtml`.
 */

import { escapeHtml } from "./html.js";
import { GROUP_LABEL_MAX, hasCaptainsLobby } from "../services/event-groups.js";
import { baseField, valueField } from "../services/event-live-edit.js";
import { renderSegmented } from "./setting-controls.js";
import {
  hidden,
  renderSettingRow,
  renderSwitchRow,
} from "./host-settings-rows.js";

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

/**
 * The Captains lobby switch (#1251). Always enabled, never `disabled`: it can be
 * turned on in the same save that turns leaders on (the server judges it against
 * what the save leaves behind), and a lobby that exists can always be turned off.
 * A disabled switch posts nothing, so it could not be turned off while leaders
 * are off. The one line says what it needs instead.
 */
function renderLobby(d: LeadersTagsView): string {
  if (!d.leaders) {
    return renderSwitchRow(
      "captainsLobby",
      "Captains lobby",
      d.lobby,
      d.lobby
        ? {
            line: "Leaders are off, so only you can join the lobby now.",
            more: "Turn it off to remove its channel, or turn leaders on to let the current leaders in.",
          }
        : {
            line: "Needs leaders on; switching both on in this save is fine.",
            more: "The lobby is a voice channel for the host and the current leaders. Turning it on creates the channel (at once while the event runs).",
          },
    );
  }
  return renderSwitchRow("captainsLobby", "Captains lobby", d.lobby, {
    line: "A voice channel only you and the current leaders can join. Off: leaders talk in the main channel.",
    more: "Nobody is assigned to it. Turning it on creates the channel (at once while the event runs). Turning it off moves everybody in it to the main channel, you included, and deletes it; you are asked to confirm first when anybody is connected to a voice channel of this event.",
  });
}

/** What leaders are called: the one place to rename them (#1514). */
function renderLeaderLabel(d: LeadersTagsView): string {
  const id = "host-settings-leader-label";
  return renderSettingRow({
    id,
    name: "What leaders are called",
    line: "For example Captain or Squad Lead.",
    labelFor: `${id}-input`,
    fields: hidden(baseField("leaderLabel"), d.leaderLabel),
    control: `<input class="kb-input" id="${id}-input" type="text" maxlength="${GROUP_LABEL_MAX}" name="${escapeHtml(valueField("leaderLabel"))}" value="${escapeHtml(d.leaderLabel)}" aria-describedby="${id}-desc">`,
  });
}

/** Where the tag goes, shown as the result on a nickname (a segmented control). */
function renderTagPosition(d: LeadersTagsView): string {
  const id = "host-settings-tagsSuffix";
  return renderSettingRow({
    id,
    name: "Where the tag goes",
    line: "Only has an effect while clan tags are on.",
    more:
      d.teams.length === 0
        ? ""
        : `Each team's tag is set in its row under "Change the groups", next to its marker, name and size. A changed tag is put on the members' nicknames from their original nickname, never on top of the old tag.`,
    fields: hidden(baseField("tagsSuffix"), d.tagsSuffix ? "1" : "0"),
    control: renderSegmented(
      valueField("tagsSuffix"),
      [
        { value: "0", label: "[RED] Alice" },
        { value: "1", label: "Alice [RED]" },
      ],
      d.tagsSuffix ? "1" : "0",
      {
        id: `${id}-input`,
        labelledBy: `${id}-name`,
        describedBy: `${id}-desc`,
      },
    ),
  });
}

/** The leaders and tags part of the form. Empty when the event has no groups. */
export function renderLeadersTagsFields(d: LeadersTagsView | null): string {
  if (!d) return "";
  const leaders = renderSwitchRow(
    "captainsEnabled",
    "Leaders",
    d.leaders,
    {
      line: "Each team can have a leader with their own controls and leaders-only access.",
      more: "Turning leaders off hides the Leaders section and removes the leaders-only channel access at once. Who was chosen is kept, and comes back when you turn leaders on again.",
    },
    [
      renderLeaderLabel(d),
      renderSwitchRow(
        "captainCustomisationEnabled",
        "Leaders may rename their team and set its tag",
        d.customisation,
        {
          line: "Only has an effect while leaders are on.",
          more: "Turning it off removes the Customise button at once and refuses a form that is already open. The names and tags leaders chose are kept; reset a team in the Customise section to put the originals back.",
        },
      ),
      renderLobby(d),
    ].join("\n"),
  );
  const tags = renderSwitchRow(
    "tagsEnabled",
    "Clan tags on server nicknames",
    d.tags,
    {
      line: "Members of a tagged team carry its tag on their nickname.",
      more: "Turning it off puts the nicknames back as they were. Nicknames follow in the background, a few every second, so a big team takes a moment. Original nicknames are kept and always put back.",
    },
    renderTagPosition(d),
  );
  return `<div class="kb-settings__group"><p class="kb-overline">Group leaders</p>
${leaders}
</div>
<div class="kb-settings__group"><p class="kb-overline">Clan tags</p>
${tags}
</div>`;
}
