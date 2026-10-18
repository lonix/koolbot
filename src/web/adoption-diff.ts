import { escapeHtml } from "./html.js";
import {
  permissionNames,
  type AdoptionPlan,
  type PlanIssue,
  type PlanOperation,
} from "../services/server-adoption-planner.js";

/**
 * Reusable Web UI partial that renders a server-adoption plan (#1018):
 * blockers, warnings, then each operation as before → after. Later adoption
 * pages embed `renderAdoptionDiff(plan)` inside their own page body; it
 * returns a fragment (no layout) and escapes every dynamic value.
 */

const permList = (bits: unknown): string => {
  const names = permissionNames(String(bits ?? "0"));
  return names.length ? names.join(", ") : "none";
};

function renderValue(key: string, value: unknown): string {
  if (value === null || value === undefined) return "—";
  if (key === "permissions" || key === "allow" || key === "deny") {
    return escapeHtml(permList(value));
  }
  return escapeHtml(value);
}

function renderSide(side: Record<string, unknown> | null): string {
  if (!side) return `<span class="muted">—</span>`;
  const rows = Object.entries(side).map(
    ([k, v]) =>
      `<div><span class="muted">${escapeHtml(k)}:</span> ${renderValue(k, v)}</div>`,
  );
  return rows.join("") || `<span class="muted">—</span>`;
}

function renderIssues(title: string, cls: string, issues: PlanIssue[]): string {
  if (issues.length === 0) return "";
  return `<div class="card adoption-issues ${cls}">
  <h3>${escapeHtml(title)} (${issues.length})</h3>
  <ul>${issues.map((i) => `<li><span class="tag ${cls === "blockers" ? "tag-off" : "tag-warn"}">${escapeHtml(i.code)}</span> ${escapeHtml(i.message)}</li>`).join("")}</ul>
</div>`;
}

function renderRow(op: PlanOperation): string {
  const destructive = op.class === "destructive";
  const approval =
    "approval" in op && op.approval
      ? `<div class="muted">Approved by <span class="mono">${escapeHtml(op.approval.approvedBy)}</span> at ${escapeHtml(op.approval.approvedAt)}</div>`
      : "";
  const members =
    op.type === "member.role.add"
      ? `<div class="muted">${op.memberCount} member(s); sample: <span class="mono">${escapeHtml(op.sample.join(", "))}</span></div>`
      : "";
  return `<tr class="${destructive ? "adoption-destructive" : ""}">
  <td class="mono">${escapeHtml(op.id)}</td>
  <td><span class="tag ${destructive ? "tag-off" : "tag-on"}">${destructive ? "destructive" : "additive"}</span></td>
  <td>${escapeHtml(op.summary)}${members}${approval}</td>
  <td>${renderSide(op.before)}</td>
  <td>${renderSide(op.after)}</td>
</tr>`;
}

function renderTable(ops: PlanOperation[], caption: string): string {
  return `<table class="adoption-diff">
  <caption class="visually-hidden">${escapeHtml(caption)}</caption>
  <thead><tr><th>#</th><th>Kind</th><th>Change</th><th>Before</th><th>After</th></tr></thead>
  <tbody>${ops.map(renderRow).join("")}</tbody>
</table>`;
}

/** Name of the form field that carries the separate destructive confirmation. */
export const DESTRUCTIVE_CONFIRM_FIELD = "confirmDestructive";

/** True when the plan has at least one destructive step. */
export function hasDestructiveSteps(
  plan: Pick<AdoptionPlan, "operations">,
): boolean {
  return plan.operations.some((o) => o.class === "destructive");
}

/**
 * Plan preview: blockers, warnings, the additive changes, then the destructive
 * steps in a section of their own (#1184). The page's apply form asks for a
 * separate confirmation of that section (`renderDestructiveConfirm`).
 */
export function renderAdoptionDiff(plan: AdoptionPlan): string {
  const header = `<p class="muted">Plan <span class="mono">${escapeHtml(plan.id)}</span> · ${plan.operations.length} operation(s)</p>`;
  const blockers = renderIssues("Blocking errors", "blockers", plan.errors);
  const warnings = renderIssues("Warnings", "warnings", plan.warnings);
  if (plan.operations.length === 0) {
    return `<section class="adoption-plan">${header}${blockers}${warnings}<p class="muted">Nothing to change: the server already matches.</p></section>`;
  }
  const additive = plan.operations.filter((o) => o.class !== "destructive");
  const destructive = plan.operations.filter((o) => o.class === "destructive");
  const changes =
    additive.length > 0
      ? `<div class="adoption-changes"><h3>Changes (${additive.length})</h3>${renderTable(additive, "Changes")}</div>`
      : "";
  const destructiveSection =
    destructive.length > 0
      ? `<div class="card adoption-destructive-section" role="group" aria-labelledby="adoption-destructive-title">
  <h3 id="adoption-destructive-title">Destructive steps (${destructive.length})</h3>
  <p class="muted">These run last, only if everything above succeeds. Messages, pins, threads, webhooks and IDs can't be restored by a rollback: a deleted channel or role comes back with a new ID. Deleting a role also removes it from every member who holds it, and those assignments are not restored.</p>
  ${renderTable(destructive, "Destructive steps")}
</div>`
      : "";
  return `<section class="adoption-plan">${header}${blockers}${warnings}${changes}${destructiveSection}</section>`;
}

/**
 * The separate confirmation for a plan's destructive steps: a required tick
 * box, rendered only when the plan has any. The apply route must check it with
 * `destructiveConfirmed`; the browser `required` is only a convenience.
 */
export function renderDestructiveConfirm(
  plan: Pick<AdoptionPlan, "operations">,
): string {
  const count = plan.operations.filter((o) => o.class === "destructive").length;
  if (count === 0) return "";
  return `<label class="check"><input type="checkbox" name="${DESTRUCTIVE_CONFIRM_FIELD}" value="1" required> I have read the ${count} destructive step(s) above. I understand that what they delete or replace can't be restored by a rollback.</label>`;
}
