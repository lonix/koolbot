/**
 * Page body of the event host panel (#1189), rendered inside `renderUserPage`.
 *
 * The page is a summary plus a fixed list of control sections. The sections
 * are the extension point: each later issue of the event groups epic (#1187)
 * fills its own section by passing HTML for that id in `controls`, and adds no
 * new page. Ended and cancelled events show the summary only.
 */

import { escapeHtml } from "./html.js";
import { hostControlsAvailable } from "./host-panel-shared.js";
import type { EventGroupKind } from "../models/event-group-kinds.js";

export type HostSectionId =
  "assignment" | "moves" | "leaders" | "end" | "settings";

export interface HostSectionDef {
  id: HostSectionId;
  title: string;
  /** What the section will hold; shown until its issue fills it. */
  placeholder: string;
  /** Only meaningful when the event has groups. */
  needsGroups: boolean;
  /** Only shown while the event has leaders switched on (#1195). */
  needsLeaders?: boolean;
}

/**
 * The control sections, in page order. Anchors are `#host-<id>`. Owners:
 * `assignment` #1191, `moves` #1192, `leaders` #1195, `end` #1193,
 * `settings` #1197.
 */
export const HOST_SECTIONS: readonly HostSectionDef[] = [
  {
    id: "assignment",
    title: "Assign people",
    placeholder: "Put people into groups, let them pick one, or randomise.",
    needsGroups: true,
  },
  {
    id: "moves",
    title: "Move people",
    placeholder:
      "Send people to their groups, bring them back, or move one person.",
    needsGroups: true,
  },
  {
    id: "leaders",
    title: "Leaders",
    placeholder: "Pick a leader for each group and pull just the leaders.",
    needsGroups: true,
    needsLeaders: true,
  },
  {
    id: "end",
    title: "End the event",
    placeholder: "End the event and tidy up its channels.",
    needsGroups: false,
  },
  {
    id: "settings",
    title: "Live settings",
    placeholder: "Change names, sizes and tags while the event runs.",
    needsGroups: true,
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
  /** Pre-formatted start line (`formatEventWhen`). */
  when: string;
  durationMinutes: number;
  /** Recurrence label (e.g. "weekly") or null for a one-off event. */
  recurrence: string | null;
  /** Main voice channel: its name when known, else its id; null before it exists. */
  channel: string | null;
  groupsEnabled: boolean;
  groupLabel: string;
  leaderLabel: string;
  /** Leaders switched on for this event (#1195). */
  captainsEnabled?: boolean;
  /** Minutes before the start that channels are created; null = server default. */
  channelLeadMinutes: number | null;
  groups: HostPanelGroup[];
  /** What the last group-channel pass could not do (#1190): warnings and
   * per-group failures, as plain text. Absent or empty when all is well. */
  groupNotices?: string[];
  adopted: boolean;
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
        ? `<span class="mono">${escapeHtml(e.channel)}</span>`
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
  if (!e.groupsEnabled || e.groups.length === 0) {
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
<table class="prefs-table"><thead><tr><th scope="col">${escapeHtml(label)}</th><th scope="col">Who</th><th scope="col">Size</th><th scope="col">Tag</th><th scope="col">Channel</th><th scope="col">People</th>${e.captainsEnabled ? `<th scope="col">${escapeHtml(e.leaderLabel || "Leader")}</th>` : ""}</tr></thead><tbody>${body}</tbody></table>
</section>`;
}

function renderControls(
  e: HostPanelEvent,
  controls: Partial<Record<HostSectionId, string>>,
): string {
  if (!hostControlsAvailable({ state: e.state })) {
    return `<div class="notice info" role="note">This event is ${escapeHtml(e.state)}, so this page is a read-only summary.</div>`;
  }
  return HOST_SECTIONS.filter((s) => !s.needsGroups || e.groupsEnabled)
    .filter((s) => !s.needsLeaders || e.captainsEnabled === true)
    .map((s) => {
      const html = controls[s.id];
      const inner =
        html ??
        `<p class="muted">${escapeHtml(s.placeholder)} Not available yet.</p>`;
      return `<section class="card" id="host-${s.id}" aria-labelledby="host-${s.id}-h">
<h2 id="host-${s.id}-h">${escapeHtml(s.title)}</h2>
${inner}
</section>`;
    })
    .join("\n");
}

export function renderHostPanelBody(opts: {
  event: HostPanelEvent;
  /** Section HTML supplied by later issues, keyed by section id. */
  controls?: Partial<Record<HostSectionId, string>>;
}): string {
  const e = opts.event;
  return `<h1>Host panel</h1>
<p class="subtitle"><strong>${escapeHtml(e.title)}</strong> · <a href="/me/">Back to overview</a></p>
${renderSummary(e)}
${renderGroups(e)}
${renderControls(e, opts.controls ?? {})}`;
}
