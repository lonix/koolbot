import {
  escapeHtml,
  renderAdminPage,
  type NavFeatureStatus,
} from "./admin-layout.js";
import { renderFlash, type FlashMessage } from "./admin-views.js";
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
  applying: { text: "Applying", cls: "tag-warn" },
  rolling_back: { text: "Rolling back", cls: "tag-warn" },
  applied: { text: "Applied", cls: "tag-on" },
  partial: { text: "Partly applied", cls: "tag-warn" },
  rollback_partial: { text: "Rollback incomplete", cls: "tag-warn" },
  rolled_back: { text: "Rolled back", cls: "tag-off" },
};

function statusTag(status: string): string {
  const s = STATUS_LABEL[status] ?? { text: status, cls: "tag-off" };
  return `<span class="tag ${s.cls}">${escapeHtml(s.text)}</span>`;
}

const when = (d: Date | null): string =>
  d ? escapeHtml(d.toISOString().replace("T", " ").slice(0, 16) + " UTC") : "";

export interface AdoptionHistoryPageProps {
  csrfToken: string;
  remainingMs: number;
  navFeatureStatus?: NavFeatureStatus;
  /** Null when the history could not be read. */
  snapshots: SnapshotSummary[] | null;
  flash?: FlashMessage | null;
  /** A rollback started from the confirm page; the page polls it. */
  jobId?: string | null;
}

const JOB_SCRIPT = (jobId: string): string =>
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
      ? `rolled back by <span class="mono">${escapeHtml(s.rolledBackBy)}</span> ${when(s.rolledBackAt)}`
      : "",
  ].filter(Boolean);
  const action = canRollback(s.status)
    ? `<a class="btn" href="${HISTORY_PATH}/${escapeHtml(s.id)}/restore">Restore…</a>`
    : `<span class="muted">${s.status === "rolled_back" ? "Already restored" : "In progress"}</span>`;
  return `<tr>
  <td>${when(s.createdAt)}</td>
  <td>${statusTag(s.status)}</td>
  <td>${escapeHtml(outcome)}${extras.length ? `<div class="muted">${extras.join(" · ")}</div>` : ""}</td>
  <td class="mono">${escapeHtml(s.appliedBy)}</td>
  <td>${action}</td>
</tr>`;
}

export function renderAdoptionHistoryPage(
  props: AdoptionHistoryPageProps,
): string {
  const job = props.jobId
    ? `<div class="notice" id="ah-job" role="status">Restoring…</div>`
    : "";
  const list =
    props.snapshots === null
      ? `<div class="notice err">The history couldn't be read from the database. Reload to try again.</div>`
      : props.snapshots.length === 0
        ? `<p class="muted">Nothing has been applied yet. Snapshots appear here after you apply a plan from Role Groups, Rules or Channel Claims.</p>`
        : `<table class="adoption-diff">
  <thead><tr><th>When</th><th>Status</th><th>Changes</th><th>Applied by</th><th></th></tr></thead>
  <tbody>${props.snapshots.map(row).join("")}</tbody>
</table>`;
  const body = `
<h1>Adoption history</h1>
<p class="subtitle">Every adoption apply saves a snapshot of what it changed. Restore puts the saved state back. Start from the <a href="/admin/wizard">Setup Wizard</a> or <a href="/admin/adopt">Server Scan</a> to adopt a server.</p>
${renderFlash(props.flash)}
${job}
<div class="card">
  <h2>Snapshots</h2>
  ${list}
  <p class="muted">Snapshots are kept for the number of days set in <code>adoption.snapshot.retention_days</code> (0 keeps them forever).</p>
</div>
${props.jobId ? `<script>${JOB_SCRIPT(props.jobId)}</script>` : ""}
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
  const applied = s.operations.filter(
    (o) => o.status === "applied" || o.status === "failed",
  );
  const items = applied
    .map(
      (o) =>
        `<li>${escapeHtml(o.summary)}${o.destructive ? ' <span class="tag tag-off">destructive</span>' : ""}${o.status === "failed" ? ' <span class="tag tag-warn">failed when applied</span>' : ""}</li>`,
    )
    .join("");
  const roles = s.createdRoles
    ? `<label><input type="checkbox" name="deleteCreatedRoles" value="1"> Also delete the ${s.createdRoles} role(s) this plan created. Unticked, they are left in place (members who hold them keep them).</label>`
    : "";
  const note = s.destructive
    ? `<div class="notice warn" role="status">${escapeHtml(props.destructiveNote)}</div>`
    : "";
  const form = canRollback(s.status)
    ? `<form method="POST" action="${HISTORY_PATH}/${escapeHtml(s.id)}/restore">
  <input type="hidden" name="_csrf" value="${escapeHtml(props.csrfToken)}">
  ${roles}
  <div class="actions">
    <button type="submit" class="btn btn-primary">Restore this snapshot</button>
    <a href="${HISTORY_PATH}" class="btn">Cancel</a>
  </div>
</form>`
    : `<div class="notice info">This snapshot can't be restored (${escapeHtml(STATUS_LABEL[s.status]?.text ?? s.status)}).</div><div class="actions"><a href="${HISTORY_PATH}" class="btn">Back</a></div>`;
  const body = `
<h1>Restore snapshot</h1>
<p class="subtitle">Applied ${when(s.createdAt)} by <span class="mono">${escapeHtml(s.appliedBy)}</span>. Only steps that were applied are reverted, newest first.</p>
${note}
<div class="card">
  <h2>What will be reverted</h2>
  ${items ? `<ul>${items}</ul>` : `<p class="muted">No step of this plan was applied, so there is nothing to revert.</p>`}
  ${form}
</div>
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
