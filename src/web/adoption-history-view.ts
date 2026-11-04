import {
  escapeHtml,
  renderAdminPage,
  type NavFeatureStatus,
} from "./admin-layout.js";
import { scriptTag } from "./html.js";
import { toneIcon, type Tone } from "./icons.js";
import { confirmLinkAttr, confirmLinkPageAttr } from "./confirm-fetch.js";
import { kbEmptyState, renderFlash, type FlashMessage } from "./admin-views.js";
import {
  canRollback,
  type SnapshotDetail,
  type SnapshotSummary,
} from "../services/adoption-snapshot-history.js";

/**
 * Adoption history (#1025): the saved snapshots of every adoption apply, and
 * the rollback action for each. Pure rendering; the routes own the Discord and
 * database work. Only counts and operation summaries are shown, never member
 * ids or the stored baseline.
 */

export const HISTORY_PATH = "/admin/adopt/history";

const STATUS_LABEL: Record<string, { text: string; cls: string }> = {
  applying: { text: "Applying", cls: "kb-badge--warn" },
  rolling_back: { text: "Rolling back", cls: "kb-badge--warn" },
  applied: { text: "Applied", cls: "kb-badge--on" },
  partial: { text: "Partly applied", cls: "kb-badge--warn" },
  rollback_partial: { text: "Rollback incomplete", cls: "kb-badge--warn" },
  rolled_back: { text: "Rolled back", cls: "kb-badge--off" },
};

function statusTag(status: string): string {
  const s = STATUS_LABEL[status] ?? { text: status, cls: "kb-badge--off" };
  return `<span class="kb-badge ${s.cls}">${escapeHtml(s.text)}</span>`;
}

/** A Callout; `title` and `text` are HTML the caller has already escaped. */
function callout(
  tone: Tone,
  role: "status" | "alert",
  title: string,
  opts: { text?: string; titleId?: string; attrs?: string } = {},
): string {
  const cls = tone ? ` kb-callout--${tone}` : "";
  const id = opts.titleId ? ` id="${opts.titleId}"` : "";
  return `<div class="kb-callout${cls}" role="${role}"${opts.attrs ?? ""}>${toneIcon(tone)}<div class="kb-callout__body"><p class="kb-callout__title"${id}>${title}</p>${opts.text ? `<p class="kb-callout__text">${opts.text}</p>` : ""}</div></div>`;
}

const when = (d: Date | null): string =>
  d ? escapeHtml(d.toISOString().replace("T", " ").slice(0, 16) + " UTC") : "";

export interface AdoptionHistoryPageProps {
  csrfToken: string;
  remainingMs: number;
  navFeatureStatus?: NavFeatureStatus;
  /** Null when the history could not be read. */
  snapshots: SnapshotSummary[] | null;
  /** 1-based page of the history; older snapshots are reached by paging. */
  page?: number;
  hasMore?: boolean;
  flash?: FlashMessage | null;
  /** A rollback started from the confirm page; the page polls it. */
  jobId?: string | null;
}

export const JOB_SCRIPT = (jobId: string): string =>
  `(function(){var id=${JSON.stringify(jobId)};var el=document.getElementById('ah-job');` +
  `function tick(){fetch('${HISTORY_PATH}/job/'+encodeURIComponent(id),{credentials:'same-origin'})` +
  ".then(function(r){return r.json()}).then(function(j){" +
  `el.textContent=j.text;if(j.status==='running'){setTimeout(tick,1500)}else{setTimeout(function(){location.href='${HISTORY_PATH}'},2500)}})` +
  ".catch(function(){el.textContent='Lost contact with the bot; reload to see the result.'})}tick()})();";

function row(s: SnapshotSummary): string {
  const outcome =
    `${s.applied} applied` +
    (s.failed ? `, ${s.failed} failed` : "") +
    (s.skipped ? `, ${s.skipped} skipped` : "");
  const extras = [
    s.destructive ? `${s.destructive} destructive step(s) in the plan` : "",
    s.createdRoles ? `${s.createdRoles} role(s) created` : "",
    s.rolledBackBy
      ? `rolled back by <span class="kb-mono">${escapeHtml(s.rolledBackBy)}</span> ${when(s.rolledBackAt)}`
      : "",
  ].filter(Boolean);
  const action = canRollback(s.status)
    ? `<a class="kb-btn kb-btn--sm" href="${HISTORY_PATH}/${escapeHtml(s.id)}/restore"${confirmLinkAttr("snapshot-restore")}>Restore…<span class="kb-visually-hidden"> the snapshot from ${when(s.createdAt)}</span></a>`
    : `<span class="kb-muted">${s.status === "rolled_back" ? "Already restored" : "In progress"}</span>`;
  return `<tr>
  <th scope="row">${when(s.createdAt)}</th>
  <td>${statusTag(s.status)}</td>
  <td>${escapeHtml(outcome)}${extras.length ? `<div class="kb-muted">${extras.join(" · ")}</div>` : ""}</td>
  <td class="kb-mono">${escapeHtml(s.appliedBy)}</td>
  <td class="kb-actions">${action}</td>
</tr>`;
}

/**
 * The verdict the list leads with (page 1 only, where the newest snapshot is):
 * how the latest apply ended and whether it can still be restored.
 */
const VERDICT: Record<string, { title: string; next: string }> = {
  applied: {
    title: "The latest apply is in place",
    next: "It can still be restored from the list below.",
  },
  applying: {
    title: "The latest apply is still running",
    next: "Restore is offered when it has finished.",
  },
  partial: {
    title: "The latest apply was only partly applied",
    next: "It can still be restored from the list below.",
  },
  rolling_back: {
    title: "The latest apply is being restored",
    next: "Reload this page to see how it ended.",
  },
  rollback_partial: {
    title: "The latest apply was only partly restored",
    next: "Restore it again from the list below to retry the rest.",
  },
  rolled_back: {
    title: "The latest apply has been restored",
    next: "Nothing is left to restore.",
  },
};

function verdict(latest: SnapshotSummary): string {
  const v = VERDICT[latest.status] ?? {
    title: `The latest apply is ${escapeHtml(latest.status)}`,
    next: "",
  };
  const needsAttention =
    latest.status === "partial" || latest.status === "rollback_partial";
  return callout(needsAttention ? "warn" : "", "status", v.title, {
    text: `${when(latest.createdAt)} by <span class="kb-mono">${escapeHtml(latest.appliedBy)}</span>. ${v.next}`,
  });
}

const RETENTION_NOTE = `<span>Snapshots are kept for the number of days set in <code class="kb-mono">adoption.snapshot.retention_days</code> (0 keeps them forever).</span>`;

export function renderAdoptionHistoryPage(
  props: AdoptionHistoryPageProps,
): string {
  const job = props.jobId
    ? callout("", "status", "Restoring…", { titleId: "ah-job" })
    : "";
  const page = props.page ?? 1;
  const paging =
    page > 1 || props.hasMore
      ? `${page > 1 ? `<a class="kb-btn kb-btn--sm" href="${HISTORY_PATH}?page=${page - 1}">Newer</a>` : ""}${props.hasMore ? `<a class="kb-btn kb-btn--sm" href="${HISTORY_PATH}?page=${page + 1}">Older</a>` : ""}<span>Page ${page}</span>`
      : "";
  const snapshots = props.snapshots;
  let panelBody: string;
  if (snapshots === null) {
    panelBody = `<div class="kb-panel__body">${callout("err", "alert", "The history couldn't be read from the database. Reload to try again.")}</div>`;
  } else if (snapshots.length === 0 && page > 1) {
    panelBody = `<div class="kb-panel__body"><p class="kb-muted">No older snapshots.</p></div>`;
  } else if (snapshots.length === 0) {
    panelBody = `<div class="kb-panel__body">${kbEmptyState("history", "Nothing has been applied yet", "Snapshots appear here after you apply a plan from Role Groups, Rules or Channel Claims.")}</div>`;
  } else {
    panelBody = `<div class="kb-panel__body kb-panel__body--flush"><table class="kb-table">
  <caption class="kb-visually-hidden">Adoption snapshots, newest first</caption>
  <thead><tr><th scope="col">When</th><th scope="col">Status</th><th scope="col">Changes</th><th scope="col">Applied by</th><th scope="col"><span class="kb-visually-hidden">Action</span></th></tr></thead>
  <tbody>${snapshots.map(row).join("")}</tbody>
</table></div>`;
  }
  const lead =
    snapshots !== null && snapshots.length > 0 && page === 1
      ? verdict(snapshots[0])
      : "";
  const body = `
<div class="kb-stack">
<header class="kb-pagehead">
  <div class="kb-pagehead__text">
    <h1 class="kb-pagehead__title">Adoption history</h1>
    <p class="kb-pagehead__sub">Every adoption apply saves a snapshot of what it changed. Restore puts the saved state back. Start from the <a href="/admin/wizard">Setup Wizard</a> or <a href="/admin/adopt">Server Scan</a> to adopt a server.</p>
  </div>
</header>
${renderFlash(props.flash)}
${job}
${lead}
<section class="kb-panel" aria-labelledby="ah-snapshots">
  <header class="kb-panel__head"><h2 class="kb-panel__title" id="ah-snapshots">Snapshots</h2></header>
  ${panelBody}
  <footer class="kb-panel__foot">${paging}${RETENTION_NOTE}</footer>
</section>
</div>
${props.jobId ? `${scriptTag(JOB_SCRIPT(props.jobId))}` : ""}
`;
  return renderAdminPage({
    title: "Adoption history",
    active: HISTORY_PATH,
    body,
    csrfToken: props.csrfToken,
    remainingMs: props.remainingMs,
    navFeatureStatus: props.navFeatureStatus,
  });
}

export interface RestoreConfirmProps {
  csrfToken: string;
  remainingMs: number;
  navFeatureStatus?: NavFeatureStatus;
  snapshot: SnapshotDetail;
  /** The engine's plain-language limits (`DESTRUCTIVE_RESTORE_NOTE`). */
  destructiveNote: string;
}

export function renderRestoreConfirmPage(props: RestoreConfirmProps): string {
  const s = props.snapshot;
  const restorable = canRollback(s.status);
  // `operations` is already exactly what the engine would still revert.
  const items = s.operations
    .map(
      (o) =>
        `<li data-confirm-item="${escapeHtml(o.summary + (o.destructive ? " (destructive)" : ""))}">${escapeHtml(o.summary)}${o.destructive ? ' <span class="kb-badge kb-badge--off">destructive</span>' : ""}</li>`,
    )
    .join("");
  // Only roles this restore can still reach: a role.create already rolled back
  // by an earlier restore is not revisited, so it must not be offered.
  // An interrupted role creation counts too: if Discord did create the role the
  // restore promotes the step, and only then can the option delete it.
  const reachableRoles = s.revertibleCreatedRoles + s.uncertainCreatedRoles;
  // One plain label: the dialog upgrade reads its text and adds its own checkbox.
  const roles = reachableRoles
    ? `<label><input type="checkbox" name="deleteCreatedRoles" value="1"> Also delete the ${reachableRoles} role(s) this plan created${s.uncertainCreatedRoles ? ` (${s.uncertainCreatedRoles} of them only if the restore finds the role on the server)` : ""}. Unticked, they are left in place (members who hold them keep them).</label>`
    : "";
  const note = s.destructive
    ? callout("warn", "status", escapeHtml(props.destructiveNote), {
        attrs: " data-confirm-item",
      })
    : "";
  const form = restorable
    ? `<form method="POST" action="${HISTORY_PATH}/${escapeHtml(s.id)}/restore" class="kb-stack" data-confirm-form data-confirm-title="Restore this snapshot?">
  <input type="hidden" name="_csrf" value="${escapeHtml(props.csrfToken)}">
  ${roles}
  <div class="kb-row">
    <button type="submit" class="kb-btn kb-btn--danger">Restore this snapshot</button>
    <a href="${HISTORY_PATH}" class="kb-btn kb-btn--ghost">Cancel</a>
  </div>
</form>`
    : `${callout("", "status", `This snapshot can't be restored (${escapeHtml(STATUS_LABEL[s.status]?.text ?? s.status)}).`)}<div class="kb-row"><a href="${HISTORY_PATH}" class="kb-btn">Back</a></div>`;
  const repairs = s.dependentRepairs
    ? callout(
        "warn",
        "status",
        `${s.dependentRepairs} follow-up repair(s) from an earlier restore are still pending (permissions on recreated roles, channels placed back under recreated categories). Restoring again retries them.`,
        { attrs: " data-confirm-item" },
      )
    : "";
  const interrupted = s.interrupted
    ? callout(
        "warn",
        "status",
        `${s.interrupted} more step(s) were interrupted (started but not recorded as finished, or in flight). The restore checks Discord first and also reverts any that did go through.`,
        { attrs: " data-confirm-item" },
      )
    : "";
  // The marked section is what the dialog upgrade reads (`confirm-fetch.ts`,
  // #1536): the consequences in `data-confirm-item`, the checkbox, the verb.
  // A snapshot that cannot be restored has no form, so it is never read.
  const body = `
${restorable ? `<div${confirmLinkPageAttr("snapshot-restore")}>\n` : ""}<div class="kb-stack">
<header class="kb-pagehead">
  <div class="kb-pagehead__text">
    <h1 class="kb-pagehead__title">Restore snapshot</h1>
    <p class="kb-pagehead__sub">Applied ${when(s.createdAt)} by <span class="kb-mono">${escapeHtml(s.appliedBy)}</span>. Only steps that were applied are reverted, newest first.</p>
  </div>
</header>
${note}
<section class="kb-panel${restorable ? " kb-panel--danger" : ""}" aria-labelledby="ah-revert">
  <header class="kb-panel__head"><h2 class="kb-panel__title" id="ah-revert">What will be reverted</h2></header>
  <div class="kb-panel__body kb-stack">
  ${items ? `<ul>${items}</ul>` : `<p class="kb-muted">Nothing recorded as applied is left to revert in this snapshot.</p>`}
  ${repairs}
  ${interrupted}
  ${form}
  </div>
</section>
</div>${restorable ? "\n</div>" : ""}
`;
  return renderAdminPage({
    title: "Restore snapshot",
    active: HISTORY_PATH,
    body,
    csrfToken: props.csrfToken,
    remainingMs: props.remainingMs,
    navFeatureStatus: props.navFeatureStatus,
  });
}
