/**
 * Page body of the event host panel (#1189), rendered inside `renderUserPage`.
 *
 * The page is a summary plus a fixed list of control sections. The sections
 * are the extension point: each later issue of the event groups epic (#1187)
 * fills its own section by passing HTML for that id in `controls`, and adds no
 * new page. Ended and cancelled events show the summary only.
 */

import { escapeHtml } from "./html.js";
import { channelMention } from "./discord-labels.js";
import { hostControlsAvailable, hostPanelPath } from "./host-panel-shared.js";
import { CHEVRON_ICON } from "./feature-page.js";
import type { EventGroupKind } from "../models/event-group-kinds.js";
import { nativeSyncPaused } from "../services/event-native-rules.js";
import {
  renderPermissionNotice,
  type PermissionNotice,
} from "./permission-notice.js";

export type HostSectionId = "board" | "end" | "settings" | "groupchanges";

export interface HostSectionDef {
  id: HostSectionId;
  title: string;
  /** What the section will hold; shown until its issue fills it. */
  placeholder: string;
  /** Only meaningful when the event has groups. */
  needsGroups: boolean;
}

/**
 * The control sections, in page order. Anchors are `#host-<id>`. Owners:
 * `board` #1424 (the toolbar and the team board: assign, randomise, move,
 * send, lock, leaders, reset a team; it replaced the cards of #1191, #1192,
 * #1195 and #1196), `end` #1193, `settings` #1197 and `groupchanges` #1424
 * (the folded "Live settings" of #1319, split in two). The last two are
 * folds at the bottom of the page and are not cards.
 */
export const HOST_SECTIONS: readonly HostSectionDef[] = [
  {
    id: "board",
    title: "Teams",
    placeholder: "Put people into teams, randomise, and move them.",
    needsGroups: true,
  },
  {
    id: "end",
    title: "End the event",
    placeholder: "End the event and tidy up its channels.",
    needsGroups: false,
  },
  {
    id: "settings",
    title: "Event settings",
    placeholder: "Change the settings of the event while it runs.",
    needsGroups: false,
  },
  {
    id: "groupchanges",
    title: "Change the groups",
    placeholder: "Add or remove groups, switch preset, or switch groups off.",
    needsGroups: false,
  },
];

export interface HostPanelGroup {
  name: string;
  marker: string;
  kind: EventGroupKind;
  size: number | null;
  tag: string;
  hasChannel: boolean;
  memberCount: number;
  /** Display name of the group's leader (#1195); null = none. Only given while leaders are on. */
  leaderName?: string | null;
  /** "2/2" for a sized group, "5" for an unsized one (#1191). */
  fill: string;
}

export interface HostPanelEvent {
  id: string;
  title: string;
  description: string;
  state: string;
  /** Pre-formatted start line (`formatDateTimeInZone`, in the member's zone). */
  when: string;
  durationMinutes: number;
  /** Recurrence label (e.g. "weekly") or null for a one-off event. */
  recurrence: string | null;
  /** Main voice channel: its name when known, else its id; null before it exists. */
  channel: string | null;
  /**
   * Discord's type of the main channel when it resolved; null or absent when
   * it did not, so `channel` is its id and the panel shows it as unavailable.
   */
  channelType?: number | null;
  groupsEnabled: boolean;
  groupLabel: string;
  leaderLabel: string;
  /** Leaders switched on for this event (#1195). */
  captainsEnabled?: boolean;
  /** Minutes before the start that channels are created; null = server default. */
  channelLeadMinutes: number | null;
  /**
   * The Captains lobby (#1251) when the event has one: it is a switch, not a
   * row of the group list, so it is not in `groups`. Null/absent = no lobby.
   */
  captainsLobby?: { hasChannel: boolean } | null;
  groups: HostPanelGroup[];
  /** The event can be edited (#1298): open, not recurring, not adopted. */
  editable?: boolean;
  /** What the last group-channel pass could not do (#1190): warnings and
   * per-group failures, as plain text. Absent or empty when all is well. */
  groupNotices?: string[];
  /** Clan tags on nicknames are switched on for this event (#1194). */
  tagsEnabled?: boolean;
  /** The tag goes after the name instead of before it. */
  tagsSuffix?: boolean;
  /** What the tag passes could not do (missing permission, a backup being
   * retried), as plain text. */
  tagNotices?: string[];
  /** Members who are not tagged, and why (the server owner, a role above the
   * bot's, a refused edit). Names come from the gateway cache. */
  tagSkipped?: Array<{ name: string; reason: string }>;
  adopted: boolean;
  /**
   * The channel ids the event records (#1467), for the permission notice,
   * which asks the check whether they still exist. Unlike `hasChannel` (what the
   * table shows, from the stored ids) this is not taken as proof of existence.
   */
  recordedChannels?: {
    main: string | null;
    groups: Array<string | null>;
    /** The Captains lobby's recorded channel ids; null when the event has no lobby. */
    lobby: Array<string | null> | null;
  };
  /** The event's Discord event was deleted there; native sync leaves it alone. */
  nativeDetached?: boolean;
}

const KIND_LABEL: Record<EventGroupKind, string> = {
  team: "Members",
  open: "Open to anyone",
  leads: "Leaders only",
};

function stateTag(state: string): string {
  const cls = state === "cancelled" ? "tag-off" : "tag-info";
  return `<span class="tag ${cls}">${escapeHtml(state)}</span>`;
}

function row(label: string, valueHtml: string): string {
  return `<tr><th scope="row">${escapeHtml(label)}</th><td>${valueHtml}</td></tr>`;
}

function renderSummary(e: HostPanelEvent): string {
  const rows = [
    row("State", stateTag(e.state)),
    row("Starts", `<span class="mono">${escapeHtml(e.when)}</span>`),
    row("Duration", `${escapeHtml(e.durationMinutes)} minutes`),
    e.recurrence ? row("Repeats", escapeHtml(e.recurrence)) : "",
    row(
      "Main voice channel",
      e.channel
        ? channelMention({ name: e.channel, type: e.channelType })
        : '<span class="muted">Not created yet</span>',
    ),
    e.adopted
      ? row(
          "Discord event",
          "Existing Discord event; KoolBot reads it but never changes it.",
        )
      : "",
  ].join("");
  const description = e.description
    ? `<p>${escapeHtml(e.description)}</p>`
    : "";
  return `<section class="card" id="host-summary" aria-labelledby="host-summary-h">
<h2 id="host-summary-h">Summary</h2>
${description}<table class="prefs-table"><tbody>${rows}</tbody></table>
</section>`;
}

function renderGroups(e: HostPanelEvent): string {
  // A legacy event with only a leaders-only group has no listed group but still
  // has the lobby's status line and the channel warnings to show (#1251).
  if (!e.groupsEnabled || (e.groups.length === 0 && !e.captainsLobby)) {
    return `<section class="card" id="host-groups" aria-labelledby="host-groups-h">
<h2 id="host-groups-h">Groups</h2>
<p class="muted">This event has no groups.</p>
</section>`;
  }
  const label = e.groupLabel || "Group";
  const body = e.groups
    .map(
      (g) =>
        `<tr><td>${g.marker ? `${escapeHtml(g.marker)} ` : ""}${escapeHtml(g.name)}</td>` +
        `<td>${escapeHtml(KIND_LABEL[g.kind] ?? g.kind)}</td>` +
        `<td>${g.size === null ? '<span class="muted">No limit</span>' : escapeHtml(g.size)}</td>` +
        `<td>${g.tag ? escapeHtml(g.tag) : '<span class="muted">None</span>'}</td>` +
        `<td>${g.hasChannel ? "Created" : '<span class="muted">Not created yet</span>'}</td>` +
        `<td>${g.kind === "team" ? `<span class="mono">${escapeHtml(g.fill)}</span>` : '<span class="muted">n/a</span>'}</td>` +
        (e.captainsEnabled
          ? `<td>${g.kind === "team" ? (g.leaderName ? escapeHtml(g.leaderName) : '<span class="muted">None</span>') : '<span class="muted">n/a</span>'}</td>`
          : "") +
        `</tr>`,
    )
    .join("");
  const lead =
    e.channelLeadMinutes === null
      ? "the server default"
      : `${escapeHtml(e.channelLeadMinutes)} minutes before the start`;
  const notices = (e.groupNotices ?? []).length
    ? `<div class="notice warn" role="status"><p>Some group channels could not be set up:</p><ul>${(e.groupNotices ?? []).map((n) => `<li>${escapeHtml(n)}</li>`).join("")}</ul></div>`
    : "";
  return `<section class="card" id="host-groups" aria-labelledby="host-groups-h">
<h2 id="host-groups-h">Groups</h2>
<p class="muted">Set up when the event was created. Channels are created ${lead}.</p>
${notices}
${renderTags(e)}
${e.groups.length > 0 ? `<table class="prefs-table"><thead><tr><th scope="col">${escapeHtml(label)}</th><th scope="col">Who</th><th scope="col">Size</th><th scope="col">Tag</th><th scope="col">Channel</th><th scope="col">People</th>${e.captainsEnabled ? `<th scope="col">${escapeHtml(e.leaderLabel || "Leader")}</th>` : ""}</tr></thead><tbody>${body}</tbody></table>` : ""}
${renderLobbyLine(e)}
</section>`;
}

/** One line about the Captains lobby (#1251), which is a switch and not a row of the table. */
function renderLobbyLine(e: HostPanelEvent): string {
  if (!e.captainsLobby) return "";
  const who = e.captainsEnabled
    ? "only you and the current leaders can join"
    : "leaders are off, so only you can join";
  const channel = e.captainsLobby.hasChannel
    ? "its channel is created"
    : "its channel is not created yet";
  return `<p class="muted"><strong>Captains lobby:</strong> on, ${who}; ${channel}.</p>`;
}

/**
 * The clan tags status (#1194): how they are applied, who could not be tagged
 * (the server owner and members whose top role is at or above the bot's can
 * never be), and anything that needs the host's attention.
 */
function renderTags(e: HostPanelEvent): string {
  if (e.tagsEnabled !== true) return "";
  const where = e.tagsSuffix ? "after" : "before";
  const notices = (e.tagNotices ?? []).length
    ? `<div class="notice warn" role="status"><ul>${(e.tagNotices ?? []).map((n) => `<li>${escapeHtml(n)}</li>`).join("")}</ul></div>`
    : "";
  const skipped = (e.tagSkipped ?? []).length
    ? `<p>Not tagged:</p><ul>${(e.tagSkipped ?? []).map((s) => `<li>${escapeHtml(s.name)}: ${escapeHtml(s.reason)}</li>`).join("")}</ul>`
    : "";
  return `<h3>Clan tags</h3>
<p class="muted">While the event runs, each member of a team with a tag gets that tag ${where} their server nickname. The original nickname is put back when the event ends or is cancelled, or when the member leaves the team.</p>
${notices}${skipped}`;
}

/** What "Event settings" holds right now, so people can skip it. */
function settingsHint(e: HostPanelEvent): string {
  const parts = [
    e.channelLeadMinutes === null
      ? "Channels at the server default"
      : `Channels ${e.channelLeadMinutes} min before the start`,
  ];
  if (e.groupsEnabled) {
    parts.push(
      e.captainsEnabled === true
        ? `${e.leaderLabel || "Leader"}s on`
        : "Leaders off",
      e.tagsEnabled === true ? "Clan tags on" : "Clan tags off",
    );
  }
  return parts.join(" · ");
}

/** What "Change the groups" holds right now. */
function groupChangesHint(e: HostPanelEvent): string {
  if (!e.groupsEnabled) return "Groups are off";
  const names = e.groups.map((g) => g.name);
  const shown = names.slice(0, 3).join(", ");
  const more = names.length > 3 ? ` and ${names.length - 3} more` : "";
  return `${e.groups.length} ${e.groups.length === 1 ? "group" : "groups"}${names.length ? `: ${shown}${more}` : ""}`;
}

function fold(
  id: string,
  title: string,
  hint: string,
  open: boolean,
  inner: string,
): string {
  return `<details class="kb-disclosure" id="${id}"${open ? " open" : ""}>
<summary>${CHEVRON_ICON}${escapeHtml(title)}<span class="kb-disclosure__hint">${escapeHtml(hint)}</span></summary>
<div class="kb-disclosure__body">${inner}</div>
</details>`;
}

function renderControls(
  e: HostPanelEvent,
  controls: Partial<Record<HostSectionId, string>>,
  settingsOpen: boolean,
): string {
  if (!hostControlsAvailable({ state: e.state })) {
    return `<div class="notice info" role="note">This event is ${escapeHtml(e.state)}, so this page is a read-only summary.</div>`;
  }
  return HOST_SECTIONS.filter((s) => !s.needsGroups || e.groupsEnabled)
    .map((s) => {
      const html = controls[s.id];
      const inner =
        html ??
        `<p class="muted">${escapeHtml(s.placeholder)} Not available yet.</p>`;
      // The board is the page (#1424): it renders its own section.
      if (s.id === "board") return html ?? "";
      // Settings and group changes sit folded at the bottom (#1319, #1424):
      // they are not what a host does while the event runs. Open after a
      // settings save, so the flash and the result are in view.
      if (s.id === "settings") {
        return fold(
          "host-settings",
          s.title,
          settingsHint(e),
          settingsOpen,
          inner,
        );
      }
      if (s.id === "groupchanges") {
        return fold(
          "host-groupchanges",
          s.title,
          groupChangesHint(e),
          settingsOpen,
          inner,
        );
      }
      return `<section class="card" id="host-${s.id}" aria-labelledby="host-${s.id}-h">
<h2 id="host-${s.id}-h">${escapeHtml(s.title)}</h2>
${inner}
</section>`;
    })
    .join("\n");
}

/**
 * The registry entries (#1253) this event's panel can be affected by: the
 * event's channels always, and the group features only where the event uses
 * them. A finished event has nothing left to set up.
 */
export function hostPanelPermissionFeatures(
  e: HostPanelEvent,
  /** Whether each recorded channel exists, from the permission check's snapshot (`PlacementReport.present`). */
  present?: Readonly<Record<string, boolean>>,
): string[] {
  if (e.state === "ended" || e.state === "cancelled") return [];
  // An adopted voice or stage event happens in its own Discord channel and
  // gets no temporary one (`EventService.adoptedHasOwnChannel`), so the
  // channel entry applies only once a channel of KoolBot's own exists for it.
  // Whether an adopted event has a channel of its own is known only from the
  // native listing (a Discord read), so before that it is left out.
  const ids = e.adopted && e.channel === null ? [] : ["event-channels"];
  // Native sync skips an adopted event and an open detached one (`nativeSyncPaused`).
  if (
    !e.adopted &&
    !nativeSyncPaused({ state: e.state, nativeDetached: e.nativeDetached })
  ) {
    ids.push("event-native");
  }
  if (e.groupsEnabled) {
    // The host's access is granted when a channel is created: the main channel
    // (`createEventChannel`) or a group's (`createOne`). Once every channel
    // exists a missing permission changes nothing until one is re-created.
    // Existence comes from the check's snapshot; a deleted channel is made
    // again by reconciliation and then needs the host's access granted again.
    // Without it (the check could not run) the recorded ids stand in.
    const recorded = e.recordedChannels;
    const exists = (id: string | null | undefined): boolean =>
      !!id && present?.[id] !== false;
    const channelToMake = recorded
      ? !exists(recorded.main) ||
        recorded.groups.some((id) => !exists(id)) ||
        (recorded.lobby !== null && !recorded.lobby.some(exists))
      : e.channel === null ||
        e.groups.some((g) => !g.hasChannel) ||
        e.captainsLobby?.hasChannel === false;
    if (channelToMake) ids.push("event-host-access");
    // `moveEventMembers` refuses an event without a group to move into.
    if (e.groups.length > 0) ids.push("event-moves");
    if (e.groups.some((g) => g.kind === "leads") || e.captainsLobby) {
      ids.push("event-leads-channel");
    }
    if (e.tagsEnabled === true) ids.push("event-tags");
  }
  return ids;
}

/**
 * The registry entries (#1478) the edit form can be affected by. Saving a
 * change updates the Discord Events list card (not for an adopted event or one
 * whose sync is paused, as on the panel) and the announcement post (only when
 * the event has one, in the channel it is stored in), so those two; the
 * channels are not touched by an edit. A finished event has nothing left to change.
 */
export function hostEditPermissionFeatures(
  e: HostPanelEvent,
  /** The event has an announcement post (`announcementChannelId` and `announcementMessageId` stored); an edit only updates a post that exists. */
  announced: boolean,
): string[] {
  if (e.state === "ended" || e.state === "cancelled") return [];
  const ids = announced ? ["events-announce"] : [];
  if (
    !e.adopted &&
    !nativeSyncPaused({ state: e.state, nativeDetached: e.nativeDetached })
  ) {
    ids.unshift("event-native");
  }
  return ids;
}

/** The recorded warning texts this panel shows, so the notice does not say them twice. */
export function hostPanelShownWarnings(e: HostPanelEvent): string[] {
  return [...(e.groupNotices ?? []), ...(e.tagNotices ?? [])];
}

export function renderHostPanelBody(opts: {
  event: HostPanelEvent;
  /** What the bot lacks for this event (#1253), built with the two helpers above. */
  permissionNotice?: PermissionNotice | null;
  /** The Bot permissions page is admin-only; a host gets a sentence instead of the link. */
  canLinkToPermissions?: boolean;
  /** Section HTML supplied by later issues, keyed by section id. */
  controls?: Partial<Record<HostSectionId, string>>;
  /** Open the two folds at the bottom (after a settings save, a flash is showing). */
  settingsOpen?: boolean;
}): string {
  const e = opts.event;
  // A line of its own only when there is something to show, so a panel without
  // a notice is byte-for-byte what it was.
  const notice = renderPermissionNotice(opts.permissionNotice ?? null, {
    canLinkToPage: opts.canLinkToPermissions === true,
  });
  const noticeBlock = notice ? `${notice}\n` : "";
  const edit = e.editable
    ? `\n  <div class="kb-pagehead__actions"><a class="kb-btn" href="${escapeHtml(hostPanelPath(e.id))}/edit">Edit event</a></div>`
    : "";
  return `<header class="kb-pagehead">
  <div class="kb-pagehead__text">
    <p class="kb-pagehead__crumbs"><a href="/me/events">Your events</a></p>
    <h1 class="kb-pagehead__title">Host panel</h1>
    <p class="kb-pagehead__sub"><strong>${escapeHtml(e.title)}</strong></p>
  </div>${edit}
</header>
${renderSummary(e)}
${noticeBlock}${renderGroups(e)}
${renderControls(e, opts.controls ?? {}, opts.settingsOpen === true)}`;
}
