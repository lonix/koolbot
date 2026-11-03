import {
  escapeHtml,
  renderAdminPage,
  type NavFeatureStatus,
} from "./admin-layout.js";
import { CONFIRM_NEUTRAL_ATTR, scriptTag } from "./html.js";
import { toneIcon, type Tone } from "./icons.js";
import { kbEmptyState, renderFlash, type FlashMessage } from "./admin-views.js";
import { renderAdoptionDiff } from "./adoption-diff.js";
import {
  renderPermissionNotice,
  type PermissionNotice,
} from "./permission-notice.js";
import {
  eventPlanIsApplicable,
  type EventAdoptionPlan,
} from "../services/event-adoption.js";

/**
 * Adopt existing Discord events (#1034). Lists the server's native scheduled
 * events with the ones KoolBot can take over, previews exactly what adopting
 * the chosen ones does, and applies it through the adoption engine (snapshot
 * first, rollback from Adoption). The Discord event itself is never changed.
 */

export const EVENT_ADOPTION_PATH = "/admin/adopt/events";

export interface EventAdoptionPageProps {
  csrfToken: string;
  remainingMs: number;
  navFeatureStatus?: NavFeatureStatus;
  /** Null when the server could not be read. */
  planned: EventAdoptionPlan | null;
  error?: string;
  /** The admin asked for a preview of the chosen events. */
  previewing: boolean;
  jobId?: string | null;
  flash?: FlashMessage | null;
  /** What the bot lacks for what adopting sets up (#1478). The page is admin-only, so it always links. */
  permissionNotice?: PermissionNotice | null;
}

export const JOB_SCRIPT = (jobId: string): string =>
  `(function(){var id=${JSON.stringify(jobId)};var el=document.getElementById('ea-job');` +
  "function tick(){fetch('/admin/role-groups/job/'+encodeURIComponent(id),{credentials:'same-origin'})" +
  ".then(function(r){return r.json()}).then(function(j){" +
  `el.textContent=j.text;if(j.status==='running'){setTimeout(tick,1500)}else{setTimeout(function(){location.href='${EVENT_ADOPTION_PATH}'},1500)}})` +
  ".catch(function(){el.textContent='Lost contact with the bot; reload to see the result.'})}tick()})();";

/** A Callout; `title` and `text` are HTML the caller has already escaped. */
function callout(
  tone: Tone,
  role: "status" | "alert",
  title: string,
  opts: { text?: string; textHtml?: string; titleId?: string } = {},
): string {
  const cls = tone ? ` kb-callout--${tone}` : "";
  const id = opts.titleId ? ` id="${opts.titleId}"` : "";
  return `<div class="kb-callout${cls}" role="${role}">${toneIcon(tone)}<div class="kb-callout__body"><p class="kb-callout__title"${id}>${title}</p>${opts.textHtml ? `<div class="kb-callout__text">${opts.textHtml}</div>` : opts.text ? `<p class="kb-callout__text">${opts.text}</p>` : ""}</div></div>`;
}

/** A Panel's head; the title is a plain wrapping flex row, never `kb-row`. */
function panelHead(id: string, title: string): string {
  return `<header class="kb-panel__head"><h2 class="kb-panel__title" id="${id}">${title}</h2></header>`;
}

/**
 * The verdict the page leads with: how many of the server's events can be
 * adopted and whether applying is open. A warning when events are off (the
 * plan then carries a blocking error) or there is no announcement channel
 * (adopted events would be silent); never "fine" while either holds.
 */
function renderVerdict(p: EventAdoptionPlan): string {
  const total = p.candidates.length;
  if (total === 0) {
    return callout("", "status", "There are no events to adopt", {
      text: "Scheduled events created in Discord show up here.",
    });
  }
  const adoptable = p.candidates.filter((c) => c.adoptable).length;
  if (adoptable === 0) {
    return callout(
      "",
      "status",
      `None of the ${total} Discord events can be adopted`,
      { text: "Each one says why below." },
    );
  }
  const title = `${adoptable} of ${total} Discord events can be adopted`;
  if (!p.eventsEnabled) {
    return callout("warn", "status", title, {
      text: "You can preview the changes, but applying needs the Events feature on.",
    });
  }
  if (!p.announcementConfigured) {
    return callout("warn", "status", title, {
      text: "Adopted events get no announcement post or reminder until an announcement channel is set.",
    });
  }
  return callout("ok", "status", title, {
    text: "Choose the ones to take over and preview the changes. Nothing changes until you apply.",
  });
}

function renderNotices(p: EventAdoptionPlan): string {
  const out: string[] = [];
  if (!p.eventsEnabled) {
    out.push(
      callout("warn", "status", "The Events feature is off", {
        text: `Turn on <code class="kb-mono">events.enabled</code> on the <a href="/admin/settings">Settings</a> page before adopting: adopted events are run by it.`,
      }),
    );
  }
  if (!p.announcementConfigured) {
    out.push(
      callout("warn", "status", "No announcement channel is set", {
        text: `Without <code class="kb-mono">events.announcement_channel_id</code>, adopted events would get no announcement post or reminder.`,
      }),
    );
  }
  if (!p.canManageEvents) {
    out.push(
      callout("warn", "status", "The bot lacks the Manage Events permission", {
        text: "Events members created can't be adopted. Grant it to the bot's role in Discord, then reload.",
      }),
    );
  }
  return out.join("\n");
}

function renderRow(
  c: EventAdoptionPlan["candidates"][number],
  i: number,
  chosen: ReadonlySet<string>,
): string {
  const id = `ea-${i}`;
  const detail = c.adoptable
    ? c.notes
    : [`Can't be adopted: ${c.reason ?? ""}`];
  const descId = `${id}-detail`;
  const described = detail.length > 0 ? ` aria-describedby="${descId}"` : "";
  const detailHtml =
    detail.length > 0
      ? `<span class="kb-list__desc" id="${descId}">${detail.map(escapeHtml).join(" ")}</span>`
      : "";
  return `<li><input type="checkbox" id="${id}"${described} name="ev" value="${escapeHtml(c.info.id)}"${chosen.has(c.info.id) ? " checked" : ""}${c.adoptable ? "" : " disabled"}><span class="kb-list__main"><label for="${id}"><strong>${escapeHtml(c.info.name)}</strong></label><span class="kb-list__desc">${escapeHtml(c.info.startsAt ?? "no start time")}</span>${detailHtml}</span></li>`;
}

function renderList(p: EventAdoptionPlan, applicable: boolean): string {
  if (p.candidates.length === 0) {
    return `<section class="kb-panel" aria-labelledby="ea-events">
  ${panelHead("ea-events", "Discord events (0)")}
  <div class="kb-panel__body">${kbEmptyState("calendar", "The server has no Discord scheduled events", "Scheduled events created in Discord show up here, ready to adopt.")}</div>
</section>`;
  }
  const chosen = new Set(p.selectedIds);
  const rows = p.candidates.map((c, i) => renderRow(c, i, chosen)).join("");
  const any = p.candidates.some((c) => c.adoptable);
  const cls = any && !applicable ? "kb-btn kb-btn--primary" : "kb-btn";
  return `<form method="GET" action="${EVENT_ADOPTION_PATH}">
  <input type="hidden" name="preview" value="1">
  <section class="kb-panel" aria-labelledby="ea-events">
    ${panelHead("ea-events", `Discord events (${p.candidates.length})`)}
    <div class="kb-panel__body"><p class="kb-help">Adopting makes a KoolBot event for a Discord event: KoolBot posts the event link in the announcement channel, sends the reminder and, for an event with no channel of its own, makes the temporary voice channel. The Discord event stays as it is, and members keep marking Interested on it. KoolBot follows later edits to its name, time and description, and drops its event if the Discord one is deleted or cancelled. Rolling back removes only the KoolBot event and its announcement.</p></div>
    <div class="kb-panel__body--flush"><ul class="kb-list" aria-label="Events to adopt">${rows}</ul></div>
    <footer class="kb-panel__foot"><button type="submit" class="${cls}"${any ? "" : " disabled"}>Preview changes</button>${any ? "" : "<span>No event can be adopted, so there is nothing to preview.</span>"}</footer>
  </section>
</form>`;
}

/** Plan problems or advice as a Callout: each code is a Badge. */
function issueCallout(
  tone: "warn" | "err",
  title: string,
  issues: ReadonlyArray<{ code: string; message: string }>,
): string {
  const badge = tone === "err" ? "kb-badge--off" : "kb-badge--warn";
  return callout(tone, "status", `${title} (${issues.length})`, {
    textHtml: `<ul>${issues
      .map(
        (i) =>
          `<li><span class="kb-badge ${badge}">${escapeHtml(i.code)}</span> ${escapeHtml(i.message)}</li>`,
      )
      .join("")}</ul>`,
  });
}

function renderPlan(p: EventAdoptionPlan, csrf: string): string {
  const head = panelHead("ea-plan", "Preview");
  if (p.plan.operations.length === 0) {
    // renderAdoptionDiff would say "the server already matches"; for events
    // the truth is that no adoptable event was chosen.
    const warnings = p.plan.warnings.length
      ? issueCallout("warn", "Left out", p.plan.warnings)
      : "";
    return `<section class="kb-panel" aria-labelledby="ea-plan">
  ${head}
  <div class="kb-panel__body kb-stack">${callout("warn", "status", "Nothing chosen to adopt", { text: "Tick at least one event that can be adopted, then preview again." })}${warnings}</div>
</section>`;
  }
  const hidden =
    `<input type="hidden" name="planId" value="${escapeHtml(p.plan.id)}">` +
    p.selectedIds
      .map((id) => `<input type="hidden" name="ev" value="${escapeHtml(id)}">`)
      .join("");
  const applicable = eventPlanIsApplicable(p);
  const verdict = applicable
    ? ""
    : `<div class="kb-panel__body">${callout("err", "status", "This plan can't be applied yet", { text: "Fix the blocking errors below, then preview again." })}</div>`;
  const apply = applicable
    ? `<div class="kb-panel__body"><form method="POST" action="${EVENT_ADOPTION_PATH}/apply" class="kb-stack" data-confirm="Adopt these events as KoolBot events? A snapshot is saved first and the Discord events are not changed."${CONFIRM_NEUTRAL_ATTR}>${csrf}${hidden}<div class="kb-row"><button type="submit" class="kb-btn kb-btn--primary" aria-describedby="ea-apply-help">Apply plan</button><span class="kb-help" id="ea-apply-help">Roll it back later from <a href="/admin/adopt/history">Adoption</a>.</span></div></form></div>`
    : "";
  // The diff keeps its own markup (#1715); the flush body is its scroll
  // container, so a wide plan table never scrolls the page.
  return `<section class="kb-panel" aria-labelledby="ea-plan">
  ${head}
  ${verdict}
  <div class="kb-panel__body kb-panel__body--flush">${renderAdoptionDiff(p.plan)}</div>
  ${apply}
</section>`;
}

export function renderEventAdoptionPage(props: EventAdoptionPageProps): string {
  const csrf = `<input type="hidden" name="_csrf" value="${escapeHtml(props.csrfToken)}">`;
  const job = props.jobId
    ? callout("", "status", "Applying…", { titleId: "ea-job" })
    : "";
  const p = props.planned;
  const permission = renderPermissionNotice(props.permissionNotice ?? null, {
    canLinkToPage: true,
  });
  const content = p
    ? `${renderVerdict(p)}
${renderNotices(p)}${permission ? `\n${permission}` : ""}
${renderList(p, props.previewing && eventPlanIsApplicable(p))}
${props.previewing ? renderPlan(p, csrf) : ""}`
    : callout("err", "alert", "The server couldn't be read", {
        text: `${escapeHtml(props.error ?? "unknown error")}. Check that the bot is in the server, then reload.`,
      });
  const body = `
<div class="kb-stack">
<header class="kb-pagehead">
  <div class="kb-pagehead__text">
    <h1 class="kb-pagehead__title">Adopt Discord Events</h1>
    <p class="kb-pagehead__sub">Take over the scheduled events your server already uses, so KoolBot announces them, reminds people and handles their voice channel. See <a href="/admin/adopt">Server Scan</a> for the rest of the server.</p>
  </div>
</header>
${renderFlash(props.flash)}
${job}
${content}
</div>
${props.jobId ? scriptTag(JOB_SCRIPT(props.jobId)) : ""}
`;
  return renderAdminPage({
    title: "Adopt Discord Events",
    active: "/admin/adopt",
    body,
    csrfToken: props.csrfToken,
    remainingMs: props.remainingMs,
    navFeatureStatus: props.navFeatureStatus,
  });
}
