/**
 * "Bot permissions" admin page (#1217): `/admin/bot-permissions`. Lists every
 * Discord permission the bot is missing for a feature that is in use, where it
 * is missing, which enabled features that affects and how to fix it. Read-only:
 * nothing here changes anything in Discord. Every name and text is escaped.
 */

import {
  escapeHtml,
  renderAdminPage,
  type NavFeatureStatus,
} from "./admin-layout.js";
import type {
  BotPermissionReport,
  PermissionTarget,
} from "../services/bot-permission-check.js";

/** "server-wide" or `in the category "X"`, as an escaped sentence part. */
export function describeTarget(target: PermissionTarget): string {
  if (target.kind === "server") return "server-wide";
  if (target.kind === "role") {
    return `for the role “${escapeHtml(target.name)}”`;
  }
  return `in the ${target.kind} “${escapeHtml(target.name)}”`;
}

export interface BotPermissionsPageProps {
  csrfToken: string;
  remainingMs: number;
  navFeatureStatus?: NavFeatureStatus;
  report: BotPermissionReport;
}

export function renderBotPermissionsPage(
  props: BotPermissionsPageProps,
): string {
  const { report } = props;
  let body: string;
  if (!report.available) {
    body = `<div class="notice warn" role="status">${escapeHtml(report.reason ?? "The permissions could not be checked.")}</div>`;
  } else {
    const notes = report.notes
      .map(
        (n) => `<div class="notice warn" role="status">${escapeHtml(n)}</div>`,
      )
      .join("");
    const count = report.problems.length;
    const summary =
      count === 0 && report.unknown.length === 0
        ? '<div class="notice ok" role="status">Every permission the enabled features need is in place.</div>'
        : count === 0
          ? ""
          : `<div class="notice warn" role="status">${count} missing ${count === 1 ? "permission affects" : "permissions affect"} features that are switched on.</div>`;
    const rows = report.problems
      .map((p) => {
        const features = p.features
          .map(
            (f) =>
              `<li><strong>${escapeHtml(f.area)}</strong>: ${escapeHtml(f.feature)}. ${escapeHtml(f.effect)}</li>`,
          )
          .join("");
        const fixes = [...new Set(p.features.map((f) => f.fix))]
          .map((x) => `<p>${escapeHtml(x)}</p>`)
          .join("");
        const what =
          p.target.kind === "role"
            ? "Role above the bot"
            : escapeHtml(p.permission);
        return `<tr><td><strong>${what}</strong></td><td>${describeTarget(p.target)}</td><td><ul>${features}</ul></td><td>${fixes}</td></tr>`;
      })
      .join("");
    const table =
      count > 0
        ? `<div class="card"><h2>Missing permissions</h2>
  <table class="prefs-table"><thead><tr><th scope="col">Missing</th><th scope="col">Where</th><th scope="col">Enabled features affected</th><th scope="col">How to fix it</th></tr></thead><tbody>${rows}</tbody></table></div>`
        : "";
    const unknown =
      report.unknown.length > 0
        ? `<div class="card"><h2>Could not be checked</h2>
  <p class="muted">These are not known to be fine.</p><ul>${report.unknown
    .map(
      (u) =>
        `<li><strong>${escapeHtml(u.feature.area)}</strong>: ${escapeHtml(u.feature.feature)} ${describeTarget(u.target)}. ${escapeHtml(u.note)}</li>`,
    )
    .join("")}</ul></div>`
        : "";
    const ok =
      report.okFeatures.length > 0
        ? `<div class="card"><h2>In place</h2><ul>${report.okFeatures
            .map(
              (f) =>
                `<li><strong>${escapeHtml(f.area)}</strong>: ${escapeHtml(f.feature)}</li>`,
            )
            .join("")}</ul></div>`
        : "";
    const quiet =
      report.quiet.length > 0
        ? `<div class="card"><h2>Not needed right now</h2>
  <p class="muted">These features are switched off. If you switch them on, they would need the permissions below. A permission listed above as missing stays missing whatever is switched on.</p><ul>${report.quiet
    .map(
      (q) =>
        `<li><strong>${escapeHtml(q.feature.area)}</strong>: ${escapeHtml(q.feature.feature)} would need ${q.missing.map((m) => escapeHtml(m)).join(", ")} ${describeTarget(q.target)}.</li>`,
    )
    .join("")}</ul></div>`
        : "";
    const footer = `<p class="muted">${report.fresh ? "Read from Discord when this page was opened (and reused for up to 30 seconds)." : "Discord could not be reached; this is the bot's cached view."} Channel overwrites are taken into account, not only the bot role's server-wide permissions. Nothing here changes anything in Discord.</p>`;
    body = `${summary}${notes}${table}${unknown}${ok}${quiet}${footer}`;
  }
  return renderAdminPage({
    title: "Bot permissions",
    active: "/admin/bot-permissions",
    body: `<h1>Bot permissions</h1>
<p class="subtitle">Which Discord permissions the bot is missing for the features you have switched on, and where.</p>
${body}`,
    csrfToken: props.csrfToken,
    remainingMs: props.remainingMs,
    navFeatureStatus: props.navFeatureStatus,
  });
}
