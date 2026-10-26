/**
 * Page bodies of the moderator's `/me/moderation` section (#1320): the Mod log,
 * one case, and the Command audit. Each renderer returns the body only; the
 * route wraps it in `renderUserPage` today and the app shell (#1317) can wrap
 * it later without touching this file.
 *
 * Read-only by construction apart from the one Review form on a case: the log
 * and the audit have no forms that write, no link to `/admin`, and no settings.
 * The header says why the person sees the page, because a moderator has no
 * admin console to explain it.
 */

import { CONFIRM_NEUTRAL_ATTR, confirmListAttr, escapeHtml } from "./html.js";
import {
  CASE_OUTCOME_LABELS,
  CASE_STATUS_LABELS,
  MODERATION_ACTION_LABELS,
  type CommandAuditRow,
  type ModerationRow,
} from "./admin-views.js";
import {
  DECISION_CONFIRM_TEXT,
  DECISION_LABELS,
  PERMANENT_CONFIRM_ITEMS,
  REVIEW_JOB_NOTE,
} from "../utils/moderation-labels.js";
import type { CaseView } from "./moderation-case-groups.js";
import { channelMention, roleMention } from "./discord-labels.js";
import { CASE_DECISIONS } from "./moderation-case-actions.js";
import type { ModerationAction } from "../models/moderation-log.js";

export const MOD_BASE = "/me/moderation";

/** The kinds the Actions list can be narrowed to, and what each one covers. */
export const MOD_LOG_KINDS = ["all", "warnings", "timeouts", "bans"] as const;
export type ModLogKind = (typeof MOD_LOG_KINDS)[number];

export const MOD_LOG_KIND_LABELS: Record<ModLogKind, string> = {
  all: "All",
  warnings: "Warnings",
  timeouts: "Timeouts",
  bans: "Bans",
};

/** Log actions behind each kind; `all` has no restriction. */
export const MOD_LOG_KIND_ACTIONS: Record<
  ModLogKind,
  readonly ModerationAction[] | undefined
> = {
  all: undefined,
  warnings: ["warn"],
  timeouts: ["timeout", "untimeout"],
  bans: ["ban", "unban"],
};

/**
 * Anything unknown means All: the query string is the member's to type. The
 * result is always one of our own constants, never the submitted value, so
 * nothing the member typed reaches a renderer (an array, an object or a string
 * that merely looks like a kind all fall back to All).
 */
export function parseModLogKind(raw: unknown): ModLogKind {
  if (typeof raw !== "string") return "all";
  return MOD_LOG_KINDS.find((k) => k === raw) ?? "all";
}

/** Why the viewer holds the Moderator scope. */
export type ModeratorReason =
  { kind: "admin" } | { kind: "groups"; names: string[] };

function reasonLine(reason: ModeratorReason): string {
  if (reason.kind === "admin") {
    return "You see it because you are a server administrator.";
  }
  const names = reason.names.length > 0 ? reason.names : ["Moderator"];
  return `You see it because you are in ${names.map(roleMention).join(", ")}.`;
}

type Tab = "log" | "audit";

function header(
  title: string,
  reason: ModeratorReason,
  active: Tab | null,
  crumbs: string,
): string {
  const tab = (id: Tab, href: string, label: string): string =>
    `<a href="${href}"${active === id ? ' aria-current="page"' : ""}>${label}</a>`;
  return `<header class="kb-pagehead">
  <div class="kb-pagehead__text">
    <p class="kb-pagehead__crumbs">${crumbs}</p>
    <h1 class="kb-pagehead__title">${escapeHtml(title)}</h1>
    <p class="kb-pagehead__sub">${reasonLine(reason)}</p>
  </div>
</header>
<nav class="kb-tabs" aria-label="Moderation">
  ${tab("log", MOD_BASE, "Mod log")}
  ${tab("audit", `${MOD_BASE}/audit`, "Command audit")}
</nav>`;
}

const crumbsLog = "Moderation";

function badgeClass(action: ModerationAction): string {
  // Same reading as the admin log: undo actions positive, removals severe,
  // warnings and timeouts cautionary.
  if (action === "unban" || action === "untimeout" || action === "raid_clear") {
    return "kb-badge--on";
  }
  if (action === "ban" || action === "kick" || action === "raid_lockdown") {
    return "kb-badge--off";
  }
  return "kb-badge--warn";
}

function actionBadge(action: ModerationAction): string {
  const label = MODERATION_ACTION_LABELS[action] ?? action;
  return `<span class="kb-badge ${badgeClass(action)}">${escapeHtml(label)}</span>`;
}

function caseStatusBadge(status: string): string {
  const cls =
    status === "under_review"
      ? "kb-badge--warn"
      : status === "lifted"
        ? "kb-badge--on"
        : "kb-badge--off";
  return `<span class="kb-badge ${cls}">${escapeHtml(CASE_STATUS_LABELS[status] ?? status)}</span>`;
}

/**
 * A UTC instant as `2026-10-21 07:30 UTC` (DESIGN.md: times carry their zone).
 * Every date and time on the moderator pages goes through this one helper.
 *
 * UTC on purpose, unlike the other `/me` pages (#1538): these pages show the
 * same log as the admin Moderation page, which staff in different timezones
 * read together, and DESIGN.md gives admin facts in UTC. Do not switch it to
 * the member's own zone (`member-timezone.ts`).
 */
const stamp = (iso: string | null): string =>
  iso ? `${iso.slice(0, 16).replace("T", " ")} UTC` : "";

// ---------- Mod log ----------

export interface OpenCaseItem {
  id: string;
  caseNumber: number;
  userId: string;
  userLabel: string;
  action: "kick" | "ban";
  status: string;
  /** ISO date; null for a case with no review date. */
  reviewAt: string | null;
  /** The review date has passed. */
  due: boolean;
}

export interface ModLogBodyProps {
  reason: ModeratorReason;
  /** `moderation.enabled`. Off shows an empty state and queries nothing. */
  enabled: boolean;
  /** Cases are on as well as the master. */
  casesEnabled: boolean;
  tiles: {
    /** Null: could not be read. */
    openCases: number | null;
    /** Null: could not be read. Never shown as zero. */
    overdueCases: number | null;
    actionsLast7Days: number | null;
    /** Null: not known (the GuildMembers intent is off, or the read failed). */
    timeoutsNow: number | null;
  };
  /** Null: the queue could not be read. */
  openCases: OpenCaseItem[] | null;
  kind: ModLogKind;
  rows: ModerationRow[];
  /** The log could not be read: not an empty log. */
  rowsUnavailable: boolean;
  /** The cases for these rows could not be looked up. */
  caseLookupFailed: boolean;
  total: number;
  page: number;
  pageSize: number;
}

function tile(opts: {
  label: string;
  value: string;
  detail: string;
  href?: string;
  warn?: boolean;
}): string {
  const cls = `kb-tile${opts.warn ? " kb-tile--warn" : ""}`;
  const inner = `<div class="kb-tile__top"><span class="kb-overline">${escapeHtml(opts.label)}</span></div>
  <div class="kb-tile__value">${escapeHtml(opts.value)}</div>
  <div class="kb-tile__detail">${escapeHtml(opts.detail)}</div>`;
  return opts.href
    ? `<a class="${cls}" href="${opts.href}">${inner}</a>`
    : `<div class="${cls}">${inner}</div>`;
}

const count = (n: number | null): string => (n === null ? "—" : String(n));

function plural(n: number, one: string, many: string): string {
  return n === 1 ? one : many;
}

function renderTiles(p: ModLogBodyProps): string {
  const t = p.tiles;
  const open = t.openCases;
  const openTile = !p.casesEnabled
    ? tile({
        label: "Open cases",
        value: "Off",
        detail: "Cases are switched off on this server.",
      })
    : tile({
        label: "Open cases",
        value: count(open),
        detail:
          open === null
            ? "Could not be read."
            : t.overdueCases === null
              ? "How many need a decision could not be read."
              : t.overdueCases > 0
                ? `${t.overdueCases} ${plural(t.overdueCases, "needs", "need")} a decision`
                : "None need a decision",
        href: "#open-cases",
        warn: (open ?? 0) > 0,
      });
  const actions = tile({
    label: "Actions, last 7 days",
    value: count(t.actionsLast7Days),
    detail:
      t.actionsLast7Days === null
        ? "Could not be read."
        : "Every logged action",
    href: "#actions",
  });
  const timeouts = tile({
    label: "Timeouts running now",
    value: count(t.timeoutsNow),
    detail:
      t.timeoutsNow === null
        ? "Needs the Server Members intent and a fully loaded member list to count."
        : "Members who cannot talk right now",
    href: `${MOD_BASE}?kind=timeouts#actions`,
  });
  return `<div class="kb-tiles">${openTile}${actions}${timeouts}</div>`;
}

function renderOpenCases(p: ModLogBodyProps): string {
  if (!p.casesEnabled) return "";
  const items = p.openCases;
  let body: string;
  if (items === null) {
    body =
      '<div class="kb-callout kb-callout--warn" role="status"><div class="kb-callout__body"><p class="kb-callout__title">The cases could not be read.</p><p class="kb-callout__text">Reload the page in a moment.</p></div></div>';
  } else if (items.length === 0) {
    body = `<div class="kb-empty"><p class="kb-empty__title">No open cases.</p><p class="kb-empty__text">A case appears here when a kick or ban gets a review date.</p></div>`;
  } else {
    body = `<div class="kb-panel__body--flush"><table class="kb-table">
<thead><tr><th scope="col">Case</th><th scope="col">Member</th><th scope="col">Action</th><th scope="col">Status</th><th scope="col">Review</th><th scope="col"><span class="kb-visually-hidden">Review case</span></th></tr></thead>
<tbody>${items
      .map((c) => {
        const href = `${MOD_BASE}/cases/${encodeURIComponent(c.id)}`;
        const review = c.reviewAt
          ? `${escapeHtml(stamp(c.reviewAt))}${c.due ? ' <span class="kb-badge kb-badge--warn">Needs a decision</span>' : ""}`
          : '<span class="kb-muted">No date</span>';
        return `<tr>
<th scope="row"><a href="${href}">#${c.caseNumber}</a></th>
<td title="${escapeHtml(c.userId)}">${escapeHtml(c.userLabel)}</td>
<td>${actionBadge(c.action)}</td>
<td>${caseStatusBadge(c.status)}</td>
<td>${review}</td>
<td class="kb-actions"><a class="kb-btn kb-btn--sm" href="${href}#review" aria-label="Review case ${c.caseNumber}">Review</a></td>
</tr>`;
      })
      .join("\n")}</tbody></table></div>`;
  }
  return `<section class="kb-panel" id="open-cases" aria-labelledby="open-cases-h">
  <header class="kb-panel__head"><h2 class="kb-panel__title" id="open-cases-h">Open cases</h2>${
    items ? `<span class="kb-panel__meta">${items.length}</span>` : ""
  }</header>
  ${items !== null && items.length > 0 ? body : `<div class="kb-panel__body">${body}</div>`}
</section>`;
}

function pageQuery(kind: ModLogKind, page: number): string {
  const parts: string[] = [];
  if (kind !== "all") parts.push(`kind=${encodeURIComponent(kind)}`);
  if (page > 1) parts.push(`page=${page}`);
  return parts.length === 0 ? "" : `?${parts.join("&")}`;
}

function renderActions(p: ModLogBodyProps): string {
  const totalPages = Math.max(1, Math.ceil(p.total / p.pageSize));
  const page = Math.min(Math.max(1, p.page), totalPages);
  const kinds = MOD_LOG_KINDS.map(
    (k) =>
      `<a href="${MOD_BASE}${pageQuery(k, 1)}#actions"${k === p.kind ? ' aria-current="page"' : ""}>${escapeHtml(MOD_LOG_KIND_LABELS[k])}</a>`,
  ).join("\n  ");

  let table: string;
  if (p.rowsUnavailable) {
    table = `<div class="kb-panel__body"><div class="kb-callout kb-callout--warn" role="status"><div class="kb-callout__body"><p class="kb-callout__title">The log could not be read.</p><p class="kb-callout__text">This is not an empty log. Reload the page in a moment.</p></div></div></div>`;
  } else if (p.rows.length === 0) {
    table = `<div class="kb-panel__body"><div class="kb-empty"><p class="kb-empty__title">${
      p.kind === "all"
        ? "No actions logged yet."
        : `No ${escapeHtml(MOD_LOG_KIND_LABELS[p.kind].toLowerCase())} logged.`
    }</p><p class="kb-empty__text">Warnings, timeouts, kicks and bans show up here as they happen.</p></div></div>`;
  } else {
    table = `<div class="kb-panel__body--flush"><table class="kb-table">
<thead><tr><th scope="col">When</th><th scope="col">Member</th><th scope="col">Action</th><th scope="col">Moderator</th><th scope="col">Reason</th>${
      p.casesEnabled ? '<th scope="col">Case</th>' : ""
    }</tr></thead>
<tbody>${p.rows
      .map((r) => {
        const moderator = r.moderatorId
          ? `<span title="${escapeHtml(r.moderatorId)}">${escapeHtml(r.moderatorLabel ?? r.moderatorId)}</span>`
          : '<span class="kb-muted">Unknown</span>';
        const caseCell =
          r.caseId && r.caseNumber !== null
            ? `<a href="${MOD_BASE}/cases/${encodeURIComponent(r.caseId)}">Case #${r.caseNumber}</a> ${caseStatusBadge(r.caseStatus ?? "open")}`
            : p.caseLookupFailed
              ? '<span class="kb-muted">Unavailable</span>'
              : '<span class="kb-muted">—</span>';
        return `<tr>
<td class="kb-mono">${escapeHtml(stamp(r.createdAt))}</td>
<th scope="row" title="${escapeHtml(r.userId)}">${escapeHtml(r.userLabel)}</th>
<td>${actionBadge(r.action)}</td>
<td>${moderator}</td>
<td>${r.reason ? escapeHtml(r.reason.slice(0, 200)) : '<span class="kb-muted">—</span>'}</td>${
          p.casesEnabled ? `\n<td>${caseCell}</td>` : ""
        }
</tr>`;
      })
      .join("\n")}</tbody></table></div>`;
  }

  const prev =
    page > 1
      ? `<a class="kb-btn kb-btn--sm" href="${MOD_BASE}${pageQuery(p.kind, page - 1)}#actions">Previous</a>`
      : "";
  const next =
    page < totalPages
      ? `<a class="kb-btn kb-btn--sm" href="${MOD_BASE}${pageQuery(p.kind, page + 1)}#actions">Next</a>`
      : "";
  const foot =
    totalPages > 1
      ? `<footer class="kb-panel__foot"><span>Page ${page} of ${totalPages}</span>${prev}${next}</footer>`
      : "";
  return `<section class="kb-panel" id="actions" aria-labelledby="actions-h">
  <header class="kb-panel__head"><h2 class="kb-panel__title" id="actions-h">Actions</h2><span class="kb-panel__meta">${p.rowsUnavailable ? "unavailable" : `${p.total} ${plural(p.total, "entry", "entries")}`}</span></header>
  <nav class="kb-tabs" aria-label="Filter actions by kind">
  ${kinds}
  </nav>
  ${table}
  ${foot}
</section>`;
}

export function renderModLogBody(p: ModLogBodyProps): string {
  const head = header("Mod log", p.reason, "log", crumbsLog);
  if (!p.enabled) {
    return `${head}
<div class="kb-empty"><p class="kb-empty__title">Moderation is switched off on this server.</p><p class="kb-empty__text">There is nothing to read yet. A server admin can switch it on.</p></div>`;
  }
  return `${head}
<div class="kb-stack">
${renderTiles(p)}
${renderOpenCases(p)}
${renderActions(p)}
</div>`;
}

// ---------- One case ----------

export interface ModCaseBodyProps {
  reason: ModeratorReason;
  csrfToken: string;
  case: CaseView;
  defaultReviewDays: number;
}

function caseEvents(c: CaseView): string {
  if (c.events.length === 0) {
    return '<p class="kb-muted">No decisions yet.</p>';
  }
  return `<ul>${c.events
    .map((e) => {
      const what = e.outcome
        ? escapeHtml(CASE_OUTCOME_LABELS[e.outcome] ?? e.outcome)
        : e.to === "under_review"
          ? "marked as needing a decision"
          : "opened";
      return `<li><span class="kb-mono">${escapeHtml(stamp(e.at))}</span> ${what} by ${escapeHtml(e.byLabel)}${
        e.note && e.note !== REVIEW_JOB_NOTE ? `: ${escapeHtml(e.note)}` : ""
      }</li>`;
    })
    .join("")}</ul>`;
}

function caseHistory(c: CaseView): string {
  if (c.historyUnavailable) {
    return '<p class="kb-muted">The earlier actions could not be read. Reload the page in a moment.</p>';
  }
  if (c.history.length === 0) {
    return '<p class="kb-muted">No earlier actions on file.</p>';
  }
  return `<ul>${c.history
    .map(
      (h) =>
        `<li><span class="kb-mono">${escapeHtml(stamp(h.createdAt))}</span> ${actionBadge(h.action)} ${
          h.reason
            ? escapeHtml(h.reason.slice(0, 200))
            : '<span class="kb-muted">no reason</span>'
        }</li>`,
    )
    .join("")}</ul>`;
}

function reviewForm(p: ModCaseBodyProps): string {
  const base = `${MOD_BASE}/cases/${encodeURIComponent(p.case.id)}`;
  const buttons = CASE_DECISIONS.map((d) => {
    const cls =
      d === "permanent"
        ? "kb-btn kb-btn--danger"
        : d === "readmit"
          ? "kb-btn kb-btn--primary"
          : "kb-btn";
    // Terminal decisions ask first, with the admin page's own wording.
    // The consequence list and the neutral tone are the admin page's, too.
    const tone =
      d === "permanent"
        ? confirmListAttr(PERMANENT_CONFIRM_ITEMS)
        : d === "readmit"
          ? CONFIRM_NEUTRAL_ATTR
          : "";
    const confirm = DECISION_CONFIRM_TEXT[d]
      ? ` data-confirm="${escapeHtml(DECISION_CONFIRM_TEXT[d])}"${tone}`
      : "";
    return `<button type="submit" class="${cls}" formaction="${base}/${d}"${confirm}>${DECISION_LABELS[d]}</button>`;
  }).join("\n    ");
  return `<form method="POST" action="${base}/uphold" class="kb-stack">
  <input type="hidden" name="_csrf" value="${escapeHtml(p.csrfToken)}">
  <div class="kb-field">
    <label class="kb-label" for="next-review">Next review in (days)</label>
    <input class="kb-input" type="number" id="next-review" name="next_review_in_days" min="1" max="3650" value="${p.defaultReviewDays}">
    <p class="kb-help">${DECISION_LABELS.uphold}: the member stays out and the next review is set (clear the days for none). ${DECISION_LABELS.extend}: needs a new date.</p>
  </div>
  <div class="kb-field">
    <label class="kb-label" for="review-note">Note</label>
    <input class="kb-input" type="text" id="review-note" name="note" maxlength="500">
  </div>
  <div class="kb-toolbar">
    ${buttons}
  </div>
  <p class="kb-help">${DECISION_LABELS.permanent}: closes the case with no more reviews. ${DECISION_LABELS.readmit}: records the decision only; KoolBot does not lift the ban in Discord, do that there.</p>
</form>`;
}

export function renderModCaseBody(p: ModCaseBodyProps): string {
  const c = p.case;
  const head = header(
    `Case #${c.caseNumber}`,
    p.reason,
    "log",
    `<a href="${MOD_BASE}">Moderation</a> / Mod log`,
  );
  const review = c.live
    ? c.reviewAt
      ? escapeHtml(stamp(c.reviewAt))
      : "No review date"
    : `Closed ${escapeHtml(stamp(c.events[c.events.length - 1]?.at ?? null))}`;
  return `${head}
<div class="kb-stack">
<section class="kb-panel" aria-labelledby="case-h">
  <header class="kb-panel__head"><h2 class="kb-panel__title" id="case-h">${actionBadge(c.action)} ${caseStatusBadge(c.status)}</h2></header>
  <div class="kb-panel__body">
    <dl class="kb-kv">
      <dt>Member</dt><dd title="${escapeHtml(c.userId)}">${escapeHtml(c.userLabel)}</dd>
      <dt>Review</dt><dd>${review}</dd>
      <dt>Opened</dt><dd>${escapeHtml(stamp(c.openedAt))} by ${escapeHtml(c.openedByLabel)}</dd>${
        c.originModeratorLabel
          ? `\n      <dt>Action by</dt><dd>${escapeHtml(c.originModeratorLabel)}</dd>`
          : ""
      }
      <dt>Reason</dt><dd>${c.reason ? escapeHtml(c.reason.slice(0, 300)) : '<span class="kb-muted">No reason recorded.</span>'}</dd>
    </dl>
  </div>
</section>
<section class="kb-panel" aria-labelledby="case-history-h">
  <header class="kb-panel__head"><h2 class="kb-panel__title" id="case-history-h">Earlier actions</h2></header>
  <div class="kb-panel__body">${caseHistory(c)}</div>
</section>
<section class="kb-panel" aria-labelledby="case-events-h">
  <header class="kb-panel__head"><h2 class="kb-panel__title" id="case-events-h">Decisions</h2></header>
  <div class="kb-panel__body">${caseEvents(c)}</div>
</section>
${
  c.live
    ? `<section class="kb-panel" id="review" aria-labelledby="review-h">
  <header class="kb-panel__head"><h2 class="kb-panel__title" id="review-h">Review</h2></header>
  <div class="kb-panel__body">${reviewForm(p)}</div>
</section>`
    : `<p class="kb-muted">This case is closed, so there is nothing left to review.</p>`
}
</div>`;
}

/** The case id did not match a case on this server, or cases are switched off. */
export function renderModCaseMissingBody(
  reason: ModeratorReason,
  casesEnabled: boolean,
): string {
  return `${header("Case not found", reason, "log", `<a href="${MOD_BASE}">Moderation</a> / Mod log`)}
<div class="kb-empty"><p class="kb-empty__title">${
    casesEnabled
      ? "There is no such case."
      : "Cases are switched off on this server."
  }</p><p class="kb-empty__text"><a href="${MOD_BASE}">Back to the mod log</a></p></div>`;
}

// ---------- Command audit (read-only) ----------

export interface ModAuditBodyProps {
  reason: ModeratorReason;
  /** `core.command_audit.enabled`. */
  enabled: boolean;
  commandOptions: string[];
  userOptions: Array<{ id: string; label: string }>;
  filters: {
    commandName: string;
    userId: string;
    result: string;
    from: string;
    to: string;
  };
  rows: CommandAuditRow[];
  /** The audit could not be read: not an empty audit. */
  unavailable?: boolean;
  total: number;
  page: number;
  pageSize: number;
}

function auditQuery(f: ModAuditBodyProps["filters"], page: number): string {
  const parts: string[] = [];
  if (f.commandName) parts.push(`command=${encodeURIComponent(f.commandName)}`);
  if (f.userId) parts.push(`user=${encodeURIComponent(f.userId)}`);
  if (f.result) parts.push(`result=${encodeURIComponent(f.result)}`);
  if (f.from) parts.push(`from=${encodeURIComponent(f.from)}`);
  if (f.to) parts.push(`to=${encodeURIComponent(f.to)}`);
  if (page > 1) parts.push(`page=${page}`);
  return parts.length === 0 ? "" : `?${parts.join("&")}`;
}

function resultBadge(result: "success" | "error" | "denied"): string {
  if (result === "success") {
    return '<span class="kb-badge kb-badge--on">success</span>';
  }
  if (result === "denied") {
    return '<span class="kb-badge kb-badge--warn">denied</span>';
  }
  return '<span class="kb-badge kb-badge--off">error</span>';
}

export function renderModAuditBody(p: ModAuditBodyProps): string {
  const head = header("Command audit", p.reason, "audit", crumbsLog);
  const totalPages = Math.max(1, Math.ceil(p.total / p.pageSize));
  const page = Math.min(Math.max(1, p.page), totalPages);
  const option = (value: string, label: string, selected: string): string =>
    `<option value="${escapeHtml(value)}"${value === selected ? " selected" : ""}>${escapeHtml(label)}</option>`;
  const commands = p.commandOptions
    .map((c) =>
      option(
        c,
        c.startsWith("component:") ? c : `/${c}`,
        p.filters.commandName,
      ),
    )
    .join("");
  const users = p.userOptions
    .map((u) => option(u.id, u.label, p.filters.userId))
    .join("");
  const results = ["success", "error", "denied"]
    .map((r) => option(r, r, p.filters.result))
    .join("");

  const table = p.unavailable
    ? `<div class="kb-panel__body"><div class="kb-callout kb-callout--warn" role="status"><div class="kb-callout__body"><p class="kb-callout__title">The command audit could not be read.</p><p class="kb-callout__text">This is not an empty audit. Reload the page in a moment.</p></div></div></div>`
    : p.rows.length === 0
      ? `<div class="kb-panel__body"><div class="kb-empty"><p class="kb-empty__title">No command invocations match.</p><p class="kb-empty__text">${
          p.enabled
            ? "Commands show up here as people use them."
            : "Command auditing is switched off on this server, so nothing is recorded."
        }</p></div></div>`
      : `<div class="kb-panel__body--flush"><table class="kb-table">
<thead><tr><th scope="col">When</th><th scope="col">Member</th><th scope="col">Command</th><th scope="col">Channel</th><th scope="col">Result</th><th scope="col">Error</th></tr></thead>
<tbody>${p.rows
          .map((r) => {
            const lead = r.commandName.startsWith("component:") ? "" : "/";
            const cmd = `${lead}${escapeHtml(r.commandName)}${
              r.subcommand ? ` ${escapeHtml(r.subcommand)}` : ""
            }`;
            return `<tr>
<td class="kb-mono">${escapeHtml(stamp(r.createdAt))}</td>
<th scope="row" title="${escapeHtml(r.discordUserId)}">${escapeHtml(r.userLabel)}</th>
<td class="kb-mono">${cmd}</td>
<td>${r.channelId ? channelMention({ name: r.channelLabel ?? r.channelId, type: r.channelType, storedName: r.channelStoredName }) : '<span class="kb-muted">—</span>'}</td>
<td>${resultBadge(r.result)}</td>
<td>${r.errorMessage ? escapeHtml(r.errorMessage.slice(0, 80)) : '<span class="kb-muted">—</span>'}</td>
</tr>`;
          })
          .join("\n")}</tbody></table></div>`;

  const prev =
    page > 1
      ? `<a class="kb-btn kb-btn--sm" href="${MOD_BASE}/audit${auditQuery(p.filters, page - 1)}">Previous</a>`
      : "";
  const next =
    page < totalPages
      ? `<a class="kb-btn kb-btn--sm" href="${MOD_BASE}/audit${auditQuery(p.filters, page + 1)}">Next</a>`
      : "";
  const foot =
    totalPages > 1
      ? `<footer class="kb-panel__foot"><span>Page ${page} of ${totalPages}</span>${prev}${next}</footer>`
      : "";
  return `${head}
<div class="kb-stack">
<section class="kb-panel" aria-labelledby="audit-filter-h">
  <header class="kb-panel__head"><h2 class="kb-panel__title" id="audit-filter-h">Filter</h2></header>
  <div class="kb-panel__body">
    <form method="GET" action="${MOD_BASE}/audit" class="kb-stack">
      <div class="kb-fields">
        <div class="kb-field"><label class="kb-label" for="f-command">Command</label>
          <select class="kb-select" id="f-command" name="command"><option value="">Any</option>${commands}</select></div>
        <div class="kb-field"><label class="kb-label" for="f-user">Member</label>
          <select class="kb-select" id="f-user" name="user"><option value="">Any</option>${users}</select></div>
        <div class="kb-field"><label class="kb-label" for="f-result">Result</label>
          <select class="kb-select" id="f-result" name="result"><option value="">Any</option>${results}</select></div>
        <div class="kb-field"><label class="kb-label" for="f-from">From</label>
          <input class="kb-input" type="date" id="f-from" name="from" value="${escapeHtml(p.filters.from)}"></div>
        <div class="kb-field"><label class="kb-label" for="f-to">To</label>
          <input class="kb-input" type="date" id="f-to" name="to" value="${escapeHtml(p.filters.to)}"></div>
      </div>
      <div class="kb-toolbar">
        <button type="submit" class="kb-btn kb-btn--primary">Apply</button>
        <a class="kb-btn" href="${MOD_BASE}/audit">Reset</a>
      </div>
    </form>
  </div>
</section>
<section class="kb-panel" aria-labelledby="audit-h">
  <header class="kb-panel__head"><h2 class="kb-panel__title" id="audit-h">Invocations</h2><span class="kb-panel__meta">${p.unavailable ? "unavailable" : `${p.total} ${plural(p.total, "row", "rows")}, newest first`}</span></header>
  ${table}
  <footer class="kb-panel__foot"><span>Read only. Command arguments and submitted text are not recorded.</span></footer>
  ${foot}
</section>
</div>`;
}
