import {
  escapeHtml,
  renderAdminPage,
  type NavFeatureStatus,
} from "./admin-layout.js";
import { CONFIRM_NEUTRAL_ATTR, scriptTag } from "./html.js";
import { renderFlash, type FlashMessage } from "./admin-views.js";
import { renderAdoptionDiff } from "./adoption-diff.js";
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
}

const JOB_SCRIPT = (jobId: string): string =>
  `(function(){var id=${JSON.stringify(jobId)};var el=document.getElementById('ea-job');` +
  "function tick(){fetch('/admin/role-groups/job/'+encodeURIComponent(id),{credentials:'same-origin'})" +
  ".then(function(r){return r.json()}).then(function(j){" +
  `el.textContent=j.text;if(j.status==='running'){setTimeout(tick,1500)}else{setTimeout(function(){location.href='${EVENT_ADOPTION_PATH}'},1500)}})` +
  ".catch(function(){el.textContent='Lost contact with the bot; reload to see the result.'})}tick()})();";

function renderNotices(p: EventAdoptionPlan): string {
  const out: string[] = [];
  if (!p.eventsEnabled) {
    out.push(
      `<div class="notice warn" role="status">The Events feature is off. Turn on <code>events.enabled</code> on the <a href="/admin/settings">Settings</a> page before adopting: adopted events are run by it.</div>`,
    );
  }
  if (!p.announcementConfigured) {
    out.push(
      `<div class="notice warn" role="status">No announcement channel is set (<code>events.announcement_channel_id</code>), so adopted events would get no announcement post or reminder.</div>`,
    );
  }
  if (!p.canManageEvents) {
    out.push(
      `<div class="notice warn" role="status">The bot lacks the Manage Events permission, so events members created can't be adopted. Grant it to the bot's role in Discord, then reload.</div>`,
    );
  }
  return out.join("");
}

function renderList(p: EventAdoptionPlan): string {
  if (p.candidates.length === 0) {
    return `<p class="muted">The server has no Discord scheduled events.</p>`;
  }
  const chosen = new Set(p.selectedIds);
  const rows = p.candidates
    .map((c, i) => {
      const id = `ea-${i}`;
      const detail = c.adoptable
        ? c.notes
            .map((n) => `<div class="muted">${escapeHtml(n)}</div>`)
            .join("")
        : `<div class="muted">Can't be adopted: ${escapeHtml(c.reason ?? "")}</div>`;
      return `<li class="ea-row"><label class="check" for="${id}"><input type="checkbox" id="${id}" name="ev" value="${escapeHtml(c.info.id)}"${chosen.has(c.info.id) ? " checked" : ""}${c.adoptable ? "" : " disabled"}> <strong>${escapeHtml(c.info.name)}</strong> <span class="muted">${escapeHtml(c.info.startsAt ?? "no start time")}</span></label>${detail}</li>`;
    })
    .join("");
  const any = p.candidates.some((c) => c.adoptable);
  return `<form method="GET" action="${EVENT_ADOPTION_PATH}" class="stack">
  <input type="hidden" name="preview" value="1">
  <fieldset><legend>Events to adopt</legend><ul class="plain">${rows}</ul></fieldset>
  <button type="submit" class="btn"${any ? "" : " disabled"}>Preview changes</button>
</form>`;
}

function renderPlan(p: EventAdoptionPlan, csrf: string): string {
  const hidden =
    `<input type="hidden" name="planId" value="${escapeHtml(p.plan.id)}">` +
    p.selectedIds
      .map((id) => `<input type="hidden" name="ev" value="${escapeHtml(id)}">`)
      .join("");
  const apply = eventPlanIsApplicable(p)
    ? `<form method="POST" action="${EVENT_ADOPTION_PATH}/apply" data-confirm="Adopt these events as KoolBot events? A snapshot is saved first and the Discord events are not changed."${CONFIRM_NEUTRAL_ATTR}>${csrf}${hidden}<button type="submit" class="btn btn-primary">Apply plan</button> <span class="muted">Roll it back later from <a href="/admin/adopt/history">Adoption</a>.</span></form>`
    : "";
  return `<h3>Preview</h3>${renderAdoptionDiff(p.plan)}${apply}`;
}

export function renderEventAdoptionPage(props: EventAdoptionPageProps): string {
  const csrf = `<input type="hidden" name="_csrf" value="${escapeHtml(props.csrfToken)}">`;
  const job = props.jobId
    ? `<div class="notice" id="ea-job" role="status">Applying…</div>`
    : "";
  const p = props.planned;
  const content = p
    ? `${renderNotices(p)}
<div class="card">
  <h2>Discord events (${p.candidates.length})</h2>
  <p class="muted">Adopting makes a KoolBot event for a Discord event: KoolBot posts the event link in the announcement channel, sends the reminder and, for an event with no channel of its own, makes the temporary voice channel. The Discord event stays as it is, and members keep marking Interested on it. KoolBot follows later edits to its name, time and description, and drops its event if the Discord one is deleted or cancelled. Rolling back removes only the KoolBot event and its announcement.</p>
  ${renderList(p)}
  ${props.previewing ? renderPlan(p, csrf) : ""}
</div>`
    : `<div class="notice err">The server couldn't be read: ${escapeHtml(props.error ?? "unknown error")}. Check that the bot is in the server, then reload.</div>`;
  const body = `
<h1>Adopt Discord Events</h1>
<p class="subtitle">Take over the scheduled events your server already uses, so KoolBot announces them, reminds people and handles their voice channel. See <a href="/admin/adopt">Server Scan</a> for the rest of the server.</p>
${renderFlash(props.flash)}
${job}
${content}
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
