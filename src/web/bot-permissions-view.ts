/**
 * "Bot permissions" admin page (#1217, #1306): `/admin/bot-permissions`. The
 * deduplicated "How to fix" steps come first (or one green line), then one row
 * per Discord permission with its status, where it applies and which features
 * need it. Read-only: nothing here changes anything in Discord. Every name and
 * text is escaped.
 *
 * The rows are rolled up from `report.checks` (what the check found for each
 * entry of `bot-permission-registry.ts`) and the registry's own needs; there is
 * no second list of permissions here. `report.problems` is untouched, so the
 * navigation badge count is unchanged.
 *
 * Folded at the bottom, "All Discord permissions" (#1366) lists every flag with
 * whether the bot role holds it and what KoolBot does with it
 * (`bot-permission-flags.ts`). It reads the role's own bits, so Administrator
 * does not make every row read "Has".
 *
 * Not built here: a "Re-authorise" invite link (whether Discord applies new
 * permission bits to the bot's existing role is not verified, and the posting
 * permissions are #1254). Places use plain names; the Discord-style
 * channel-type labels are #1303.
 */

import { PermissionFlagsBits } from "discord.js";
import {
  escapeHtml,
  renderAdminPage,
  type NavFeatureStatus,
} from "./admin-layout.js";
import {
  ROLE_ABOVE_BOT,
  type BotPermissionReport,
  type FeatureCheck,
  type FeatureRef,
  type PermissionTarget,
} from "../services/bot-permission-check.js";
import { allFlagRows, type FlagRow } from "../services/bot-permission-flags.js";
import {
  FEATURE_REQUIREMENTS,
  PERM,
  PERMISSION_ORDER,
} from "../services/bot-permission-registry.js";

/** "server-wide" or `in the category "X"`, as an escaped sentence part. */
export function describeTarget(target: PermissionTarget): string {
  if (target.kind === "server") return "server-wide";
  if (target.kind === "role") {
    return `for the role “${escapeHtml(target.name)}”`;
  }
  return `in the ${target.kind} “${escapeHtml(target.name)}”`;
}

/** Lucide icons (ISC licence), inlined: children of a 24x24 `svg.kb-icon`. */
const ICON_PATHS = {
  ok: '<circle cx="12" cy="12" r="10"/><path d="m9 12 2 2 4-4"/>',
  missing:
    '<circle cx="12" cy="12" r="10"/><path d="m15 9-6 6"/><path d="m9 9 6 6"/>',
  warn: '<path d="m21.73 18-8-14a2 2 0 0 0-3.48 0l-8 14A2 2 0 0 0 4 21h16a2 2 0 0 0 1.73-3"/><path d="M12 9v4"/><path d="M12 17h.01"/>',
  off: '<path d="M5 12h14"/>',
  chev: '<polyline points="9 6 15 12 9 18"/>',
} as const;

function icon(name: keyof typeof ICON_PATHS, extra = ""): string {
  return `<svg class="kb-icon${extra}" viewBox="0 0 24 24" aria-hidden="true" focusable="false">${ICON_PATHS[name]}</svg>`;
}

/** The row for `ROLE_ABOVE_BOT` checks (the role hierarchy, not a permission bit). */
export const ROLE_POSITION_LABEL = "Role position";

export type MatrixStatus = "missing" | "unknown" | "has" | "off";

export interface MatrixRow {
  /** A Discord permission name ("Manage Nicknames", "Create Events or Manage Events") or `ROLE_POSITION_LABEL`. */
  label: string;
  status: MatrixStatus;
  /** Where it was checked (empty for a row nothing checked). */
  places: (PermissionTarget | null)[];
  /** Features in use that need it here. */
  features: FeatureRef[];
  /** Switched-off features that would need it. */
  offFeatures: FeatureRef[];
  /** Why a check could not run, for `unknown` rows. */
  notes: string[];
}

const STATUS_RANK: Record<MatrixStatus, number> = {
  missing: 0,
  unknown: 1,
  has: 2,
  off: 3,
};

/** Position of a permission name in Discord's role editor (unknown names sort last, Role position after them). */
function orderOf(label: string): number {
  const byName = new Map<string, number>(
    PERMISSION_ORDER.map((key, i) => [PERM[key].name, i] as const),
  );
  if (label === ROLE_POSITION_LABEL) return PERMISSION_ORDER.length + 1;
  const parts = label.split(" or ");
  return Math.min(
    ...parts.map((n) => byName.get(n) ?? PERMISSION_ORDER.length),
  );
}

function sameTarget(
  a: PermissionTarget | null,
  b: PermissionTarget | null,
): boolean {
  if (!a || !b) return a === b;
  return a.kind === b.kind && a.id === b.id && a.name === b.name;
}

/**
 * One row per Discord permission (and the role position), split into several
 * rows only where the same permission has different results in different
 * places. Sorted Missing, Not checked, Has, then Not needed; Discord's order
 * inside each group.
 */
export function buildMatrix(report: BotPermissionReport): MatrixRow[] {
  type Cell = {
    check: FeatureCheck;
    label: string;
    status: MatrixStatus;
  };
  const cells: Cell[] = [];
  for (const check of report.checks) {
    let labels: string[];
    if (check.kind === "role-position") {
      labels = [ROLE_POSITION_LABEL];
    } else {
      const req = FEATURE_REQUIREMENTS.find((r) => r.id === check.feature.id);
      if (!req) continue;
      // "Either one is enough" is one row, named as the check names it.
      labels = req.anyOf
        ? [req.needs.map((n) => n.name).join(" or ")]
        : req.needs.map((n) => n.name);
    }
    for (const label of labels) {
      let status: MatrixStatus;
      if (!check.enabled) status = "off";
      else if (check.outcome === "unknown" || check.outcome === "unchecked") {
        status = "unknown";
      } else if (check.outcome === "missing") {
        const lacks =
          check.kind === "role-position"
            ? check.missing.includes(ROLE_ABOVE_BOT)
            : check.missing.includes(label);
        status = lacks ? "missing" : "has";
      } else status = "has";
      cells.push({ check, label, status });
    }
  }

  const rows: MatrixRow[] = [];
  const labels = [...new Set(cells.map((c) => c.label))];
  for (const label of labels) {
    const mine = cells.filter((c) => c.label === label);
    const off = mine.filter((c) => c.status === "off");
    const offFeatures = uniqueFeatures(off.map((c) => c.check.feature));
    const live = (["missing", "unknown", "has"] as const).flatMap((status) => {
      const group = mine.filter((c) => c.status === status);
      return group.length > 0 ? [{ status, group }] : [];
    });
    if (live.length === 0) {
      rows.push({
        label,
        status: "off",
        places: [],
        features: [],
        offFeatures,
        notes: [],
      });
      continue;
    }
    live.forEach(({ status, group }, i) => {
      const places: (PermissionTarget | null)[] = [];
      for (const c of group) {
        if (!places.some((p) => sameTarget(p, c.check.target))) {
          places.push(c.check.target);
        }
      }
      const notes =
        status === "unknown"
          ? [
              ...new Set(
                group.flatMap((c) =>
                  report.unknown
                    .filter(
                      (u) =>
                        u.feature.id === c.check.feature.id &&
                        sameTarget(u.target, c.check.target),
                    )
                    .map((u) => u.note),
                ),
              ),
            ]
          : [];
      rows.push({
        label,
        status,
        places,
        features: uniqueFeatures(group.map((c) => c.check.feature)),
        // The switched-off features' chips go on the row that comes first.
        offFeatures: i === 0 ? offFeatures : [],
        notes,
      });
    });
  }
  return rows.sort(
    (a, b) =>
      STATUS_RANK[a.status] - STATUS_RANK[b.status] ||
      orderOf(a.label) - orderOf(b.label),
  );
}

function uniqueFeatures(list: FeatureRef[]): FeatureRef[] {
  const seen = new Set<string>();
  return list.filter((f) => !seen.has(f.id) && seen.add(f.id));
}

/** Escaped "where" markup: plain names (the channel-type labels of #1303 are not used yet). */
function placeHtml(target: PermissionTarget | null): string {
  if (!target) return '<span class="kb-muted">No channel set</span>';
  const name = escapeHtml(target.name);
  switch (target.kind) {
    case "server":
      return '<span class="kb-pill">Server-wide</span>';
    case "category":
      return `<span class="kb-mention kb-mention--category"><span class="kb-visually-hidden">Category </span>${name}</span>`;
    case "channel":
      return `<span class="kb-mention"><span class="kb-visually-hidden">Channel </span>${name}</span>`;
    default:
      return `<span class="kb-mention"><span class="kb-visually-hidden">Role </span>${name}</span>`;
  }
}

function chipHtml(f: FeatureRef, off: boolean): string {
  const text = `${escapeHtml(f.area)}: ${escapeHtml(f.feature)}`;
  return off
    ? `<span class="kb-chip is-off">${text} (off)</span>`
    : `<span class="kb-chip">${text}</span>`;
}

const STATUS_TEXT: Record<
  MatrixStatus,
  { permission: string; rolePosition: string }
> = {
  missing: { permission: "Missing", rolePosition: "Too low" },
  unknown: { permission: "Not checked", rolePosition: "Not checked" },
  has: { permission: "Has", rolePosition: "Above" },
  off: { permission: "Not needed", rolePosition: "Not needed" },
};

function rowHtml(row: MatrixRow): string {
  const word =
    STATUS_TEXT[row.status][
      row.label === ROLE_POSITION_LABEL ? "rolePosition" : "permission"
    ];
  const cls = row.status === "off" ? "quiet" : row.status;
  const iconName =
    row.status === "has"
      ? "ok"
      : row.status === "missing"
        ? "missing"
        : row.status === "unknown"
          ? "warn"
          : "off";
  const trClass =
    row.status === "missing"
      ? ' class="is-missing"'
      : row.status === "off"
        ? ' class="is-quiet"'
        : "";
  const places =
    row.places.length > 0
      ? row.places.map(placeHtml).join(" ")
      : '<span class="kb-muted">None</span>';
  const notes = row.notes
    .map((n) => `<br><span class="kb-muted">${escapeHtml(n)}</span>`)
    .join("");
  const chips = [
    ...row.features.map((f) => chipHtml(f, false)),
    ...row.offFeatures.map((f) => chipHtml(f, true)),
  ].join(" ");
  return `<tr${trClass}><th scope="row">${escapeHtml(row.label)}</th><td><span class="kb-perm kb-perm--${cls}">${icon(iconName)}${word}</span></td><td>${places}${notes}</td><td>${chips}</td></tr>`;
}

const MATRIX_HEAD =
  '<thead><tr><th scope="col">Permission</th><th scope="col">Status</th><th scope="col">Where</th><th scope="col">Needed by</th></tr></thead>';

/** "A", "A and B", "A, B and C", each name in bold. */
function boldList(names: string[]): string {
  const bold = names.map((n) => `<strong>${escapeHtml(n)}</strong>`);
  return bold.length < 2
    ? bold.join("")
    : `${bold.slice(0, -1).join(", ")} and ${bold[bold.length - 1]}`;
}

/**
 * The steps to take, from `problems` only: one step per place (the same
 * permission missing for two features is one name in one step) and one step
 * for every role that sits above the bot. Server-wide first.
 */
export function fixSteps(report: BotPermissionReport): string[] {
  const steps: string[] = [];
  const byTarget = new Map<
    string,
    { target: PermissionTarget; names: string[] }
  >();
  const roles = new Map<string, string>();
  for (const p of report.problems) {
    if (p.target.kind === "role") {
      roles.set(p.target.id ?? p.target.name, p.target.name);
      continue;
    }
    const key = `${p.target.kind}|${p.target.id ?? ""}`;
    const entry = byTarget.get(key) ?? { target: p.target, names: [] };
    if (!entry.names.includes(p.permission)) entry.names.push(p.permission);
    byTarget.set(key, entry);
  }
  const places = [...byTarget.values()].sort(
    (a, b) =>
      Number(b.target.kind === "server") - Number(a.target.kind === "server"),
  );
  for (const { target, names } of places) {
    const sorted = [...names].sort((a, b) => orderOf(a) - orderOf(b));
    steps.push(
      target.kind === "server"
        ? `Give the bot’s role ${boldList(sorted)} (server-wide).`
        : `Give the bot’s role ${boldList(sorted)}, and make sure the ${target.kind} “${escapeHtml(target.name)}” does not deny ${sorted.length === 1 ? "it" : "them"}.`,
    );
  }
  if (roles.size > 0) {
    const names = [...roles.values()].map((n) => `“${escapeHtml(n)}”`);
    steps.push(
      `Move the bot’s role <strong>above</strong> ${names.length === 1 ? `the role ${names[0]}` : `these roles: ${names.join(", ")}`} in Server Settings → Roles.`,
    );
  }
  return steps;
}

const ADMINISTRATOR_BIT = PermissionFlagsBits.Administrator;

/**
 * What the switched-on features need that the bot role itself lacks
 * server-wide (names, "A or B" for an either-is-enough need). Meaningful when
 * the role holds Administrator: that is what would stop working without it,
 * unless a channel overwrite grants it.
 */
export function neededButNotInRole(
  report: BotPermissionReport,
  bits: bigint,
): string[] {
  const names: string[] = [];
  for (const check of report.checks) {
    // A feature that is on but has no category or channel set is `unchecked`
    // with no target: what it would need is not known, so it is not listed.
    if (check.kind !== "permission" || !check.enabled || check.target === null)
      continue;
    const req = FEATURE_REQUIREMENTS.find((r) => r.id === check.feature.id);
    if (!req) continue;
    const lacking = req.needs.filter((n) => (bits & n.bit) === 0n);
    if (req.anyOf) {
      if (lacking.length === req.needs.length) {
        names.push(req.needs.map((n) => n.name).join(" or "));
      }
    } else names.push(...lacking.map((n) => n.name));
  }
  return [...new Set(names)];
}

function flagRowHtml(
  row: FlagRow,
  bits: bigint,
  hasAdmin: boolean,
  lackingWithoutAdmin: string[],
  hasUnchecked: boolean,
): string {
  const held = (bits & row.bit) !== 0n;
  const role = held
    ? `<span class="kb-perm kb-perm--has">${icon("ok")}Has</span>`
    : `<span class="kb-perm kb-perm--quiet">${icon("off")}Not in the role</span>${hasAdmin ? ' <span class="kb-muted">(Administrator covers it)</span>' : ""}`;
  let use: string;
  if (row.use.kind === "checked") {
    use = "Checked in the table above.";
  } else if (row.use.kind === "used") {
    use = `Used, not checked on this page. ${escapeHtml(row.use.for)}`;
  } else if (row.use.kind === "unclassified") {
    use = "Not classified yet. Do not remove it on this page’s account.";
  } else if (row.bit === ADMINISTRATOR_BIT) {
    use =
      "Not required for the bot's own features, but the bot can only hand out permissions it holds: without Administrator, a Role group cannot grant it (the Admin preset does), and every other permission a Role group grants must be held by the bot's role." +
      (held
        ? ` If you ever remove it, check three things. ${
            lackingWithoutAdmin.length > 0
              ? `The role itself lacks ${boldList(lackingWithoutAdmin)}, which the switched-on features need server-wide: give them first. `
              : "The role itself holds the checked server-wide permissions the switched-on features need. "
          }${hasUnchecked ? "Switched-on features with no category or channel set were not checked, so what they would need is not listed. " : ""}The permissions marked “Used, not checked on this page” are not verified here, so make sure the role holds the ones you rely on. And channel overwrites that deny something start to apply once Administrator is gone.`
        : "");
  } else {
    use =
      "Only needed if a Role group grants it. KoolBot itself does not use it, but the bot can only hand out a permission it holds.";
  }
  return `<tr><th scope="row">${escapeHtml(row.name)}</th><td>${role}</td><td>${use}</td></tr>`;
}

/** The folded "All Discord permissions" list; empty when the bot role's bits are unknown. */
function allFlagsPanel(report: BotPermissionReport): string {
  const bits = report.serverPermissions;
  if (typeof bits !== "bigint") return "";
  const rows = allFlagRows();
  const hasAdmin = (bits & ADMINISTRATOR_BIT) !== 0n;
  const lacking = hasAdmin ? neededButNotInRole(report, bits) : [];
  const hasUnchecked = report.checks.some(
    (c) => c.kind === "permission" && c.enabled && c.target === null,
  );
  const body = rows
    .map((r) => flagRowHtml(r, bits, hasAdmin, lacking, hasUnchecked))
    .join("");
  return `<section class="kb-panel" aria-labelledby="flags-h">
  <header class="kb-panel__head"><h2 class="kb-panel__title" id="flags-h">All Discord permissions</h2></header>
  <details class="kb-disclosure"><summary>${icon("chev", " kb-chev")}Show every permission <span class="kb-badge kb-badge--count">${rows.length}</span><span class="kb-disclosure__hint">what the bot’s role holds and what KoolBot uses</span></summary><div class="kb-disclosure__body"><p class="kb-muted">This is the bot role’s own server-wide list. Channel overwrites are not included, and Administrator would give the bot all of them.</p><div class="kb-panel__body--flush"><table class="kb-table"><thead><tr><th scope="col">Permission</th><th scope="col">Bot role</th><th scope="col">KoolBot</th></tr></thead><tbody>${body}</tbody></table></div></div></details>
</section>`;
}

export interface BotPermissionsPageProps {
  csrfToken: string;
  remainingMs: number;
  navFeatureStatus?: NavFeatureStatus;
  report: BotPermissionReport;
}

function calloutHtml(
  tone: "ok" | "warn",
  title: string,
  text?: string,
): string {
  return `<div class="kb-callout kb-callout--${tone}" role="status">${icon(tone === "ok" ? "ok" : "warn")}<div class="kb-callout__body"><p class="kb-callout__title">${escapeHtml(title)}</p>${text ? `<p class="kb-callout__text">${escapeHtml(text)}</p>` : ""}</div></div>`;
}

function fixPanel(report: BotPermissionReport): string {
  const steps = fixSteps(report);
  return `<section class="kb-panel" aria-labelledby="fix-h">
  <header class="kb-panel__head"><h2 class="kb-panel__title" id="fix-h">How to fix</h2><span class="kb-panel__meta">${steps.length} ${steps.length === 1 ? "step" : "steps"}</span></header>
  <div class="kb-panel__body"><ol class="kb-steps">${steps.map((x) => `<li>${x}</li>`).join("")}</ol></div>
</section>`;
}

function matrixPanels(rows: MatrixRow[]): string {
  const needed = rows.filter((r) => r.status !== "off");
  const quiet = rows.filter((r) => r.status === "off");
  const table = (list: MatrixRow[]): string =>
    `<div class="kb-panel__body--flush"><table class="kb-table">${MATRIX_HEAD}<tbody>${list.map(rowHtml).join("")}</tbody></table></div>`;
  const main =
    needed.length > 0
      ? table(needed)
      : '<div class="kb-panel__body"><p class="kb-muted">No switched-on feature needs a Discord permission from the bot right now.</p></div>';
  const folded =
    quiet.length > 0
      ? `<details class="kb-disclosure"><summary>${icon("chev", " kb-chev")}Not needed <span class="kb-badge kb-badge--count">${quiet.length}</span><span class="kb-disclosure__hint">only switched-off features would use these</span></summary><div class="kb-disclosure__body">${table(quiet)}</div></details>`
      : "";
  return `<section class="kb-panel" aria-labelledby="perm-h">
  <header class="kb-panel__head"><h2 class="kb-panel__title" id="perm-h">Permissions</h2><span class="kb-panel__meta">${needed.length} in use</span></header>
  ${main}
  ${folded ? `<div class="kb-panel__body">${folded}</div>` : ""}
</section>`;
}

export function renderBotPermissionsPage(
  props: BotPermissionsPageProps,
): string {
  const { report } = props;
  let body: string;
  if (!report.available) {
    body = calloutHtml(
      "warn",
      report.reason ?? "The permissions could not be checked.",
    );
  } else {
    const notes = report.notes.map((n) => calloutHtml("warn", n)).join("");
    const rows = buildMatrix(report);
    const unchecked = report.checks.some(
      (c) => c.enabled && c.outcome === "unchecked",
    );
    const lead =
      report.problems.length > 0
        ? fixPanel(report)
        : report.unknown.length === 0 && !unchecked
          ? calloutHtml(
              "ok",
              "All permissions your switched-on features need are in place.",
            )
          : "";
    const footer = `<p class="kb-muted">${report.fresh ? "Read from Discord when this page was opened (and reused for up to 30 seconds)." : "Discord could not be reached; this is the bot's cached view."} Channel overwrites are taken into account, not only the bot role's server-wide permissions. Nothing here changes anything in Discord.</p>`;
    body = `${notes}${lead}${matrixPanels(rows)}${allFlagsPanel(report)}${footer}`;
  }
  return renderAdminPage({
    title: "Bot permissions",
    active: "/admin/bot-permissions",
    body: `<header class="kb-pagehead"><div class="kb-pagehead__text"><h1 class="kb-pagehead__title">Bot permissions</h1>
<p class="kb-pagehead__sub">Which Discord permissions the bot has for the features you have switched on, and where it is missing any.</p></div></header>
<div class="kb-stack">${body}</div>`,
    csrfToken: props.csrfToken,
    remainingMs: props.remainingMs,
    navFeatureStatus: props.navFeatureStatus,
  });
}
