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

export function renderAdoptionDiff(plan: AdoptionPlan): string {
  const header = `<p class="muted">Plan <span class="mono">${escapeHtml(plan.id)}</span> · ${plan.operations.length} operation(s)</p>`;
  const blockers = renderIssues("Blocking errors", "blockers", plan.errors);
  const warnings = renderIssues("Warnings", "warnings", plan.warnings);
  const destructiveCount = plan.operations.filter(
    (o) => o.class === "destructive",
  ).length;
  const note =
    destructiveCount > 0
      ? `<p class="muted">${destructiveCount} destructive step(s) run last, only if everything before them succeeds. Messages, pins, threads, webhooks and IDs can't be restored by a rollback, and deleting a role removes it from every member who holds it; those assignments are not restored either.</p>`
      : "";
  const body =
    plan.operations.length === 0
      ? `<p class="muted">Nothing to change: the server already matches.</p>`
      : `<table class="adoption-diff">
  <thead><tr><th>#</th><th>Kind</th><th>Change</th><th>Before</th><th>After</th></tr></thead>
  <tbody>${plan.operations.map(renderRow).join("")}</tbody>
</table>`;
  return `<section class="adoption-plan">${header}${blockers}${warnings}${note}${body}</section>`;
}
