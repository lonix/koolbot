/**
 * The page the Setup wizard ends on (#1617): an optional "narrow the bot's
 * permissions" step. It says which Discord permissions the switched-on features
 * need (the registry's list, as the Bot permissions page rolls it up), which are
 * not needed, and how to swap Administrator for the needed set in Discord. It
 * only reads: nothing here changes a permission in Discord.
 *
 * Built from existing components only: Callout, Button, Panel, Disclosure and
 * the Bot permissions page's chips. The copy is a proposal for the owner.
 */
import type { BotPermissionReport } from "../services/bot-permission-check.js";
import type { AdministratorCheck } from "../services/wizard-admin-check.js";
import { buildMatrix, ROLE_POSITION_LABEL } from "./bot-permissions-view.js";
import { allFlagRows } from "../services/bot-permission-flags.js";
import { FEATURE_REQUIREMENTS } from "../services/bot-permission-registry.js";
import {
  escapeHtml,
  renderAdminPage,
  type NavFeatureStatus,
} from "./admin-layout.js";
import { renderFlash, type FlashMessage } from "./admin-views.js";
import { BOT_PERMISSIONS_HREF } from "./dashboard-data.js";
import { toneIcon } from "./icons.js";

export interface WizardDonePageProps {
  csrfToken: string;
  remainingMs: number;
  navFeatureStatus?: NavFeatureStatus;
  report: BotPermissionReport;
  admin: AdministratorCheck;
  flash?: FlashMessage | null;
}

function callout(
  tone: "" | "ok" | "warn",
  title: string,
  text: string,
): string {
  return `<div class="kb-callout${tone ? ` kb-callout--${tone}` : ""}" role="status">${toneIcon(tone)}<div class="kb-callout__body"><p class="kb-callout__title">${escapeHtml(title)}</p><p class="kb-callout__text">${escapeHtml(text)}</p></div></div>`;
}

function chips(names: string[], off: boolean): string {
  return names
    .map(
      (n) =>
        `<span class="kb-chip${off ? " is-off" : ""}">${escapeHtml(n)}</span>`,
    )
    .join(" ");
}

/** Name of a registry need, "A or B" when either one is enough. */
function needLabel(req: (typeof FEATURE_REQUIREMENTS)[number]): string[] {
  return req.anyOf
    ? [req.needs.map((n) => n.name).join(" or ")]
    : req.needs.map((n) => n.name);
}

/**
 * What the switched-on features need, and what only switched-off ones would.
 * "Needed" is not the matrix's status alone: a feature that is on but posts in
 * whichever channel it is used in (looking for group with no channel set) has
 * nothing to check, so the matrix reads it as off, yet it needs its permissions
 * wherever it runs (`needsServerWide`). Telling an admin to remove one of those
 * would break the feature, so they count as needed here.
 */
function splitNeeded(report: BotPermissionReport): {
  needed: Map<string, string[]>;
  notNeeded: string[];
} {
  const rows = buildMatrix(report);
  const needed = new Map<string, string[]>();
  const add = (label: string, feature: string): void => {
    const list = needed.get(label) ?? [];
    if (!list.includes(feature)) list.push(feature);
    needed.set(label, list);
  };
  for (const r of rows) {
    if (r.status === "off") continue;
    // One entry per permission: it can come back as several rows (different
    // results in different places), and each row's features are merged.
    if (!needed.has(r.label)) needed.set(r.label, []);
    for (const f of r.features) add(r.label, `${f.area}: ${f.feature}`);
  }
  for (const c of report.checks) {
    if (!c.needsServerWide || c.kind !== "permission") continue;
    const req = FEATURE_REQUIREMENTS.find((x) => x.id === c.feature.id);
    if (!req) continue;
    for (const label of needLabel(req)) {
      add(label, `${c.feature.area}: ${c.feature.feature}`);
    }
  }
  const notNeeded = rows
    .filter((r) => r.status === "off" && !needed.has(r.label))
    .map((r) => r.label);
  return { needed, notNeeded };
}

function neededPanel(needed: Map<string, string[]>): string {
  const body =
    needed.size > 0
      ? `<div class="kb-panel__body--flush"><table class="kb-table"><thead><tr><th scope="col">Permission</th><th scope="col">Needed by</th></tr></thead><tbody>${[
          ...needed.entries(),
        ]
          .map(
            ([label, features]) =>
              `<tr><th scope="row">${escapeHtml(label)}</th><td>${chips(features, false)}${label === ROLE_POSITION_LABEL ? ' <span class="kb-muted">Keep the bot role above the roles it manages.</span>' : ""}</td></tr>`,
          )
          .join("")}</tbody></table></div>`
      : '<div class="kb-panel__body"><p class="kb-muted">No switched-on feature needs a Discord permission from the bot right now.</p></div>';
  return `<section class="kb-panel" aria-labelledby="needed-h">
  <header class="kb-panel__head"><h2 class="kb-panel__title" id="needed-h">What your features need</h2><span class="kb-panel__meta">${needed.size} in use</span></header>
  ${body}
</section>`;
}

/**
 * The permissions the bot's code uses that the Bot permissions page does not
 * check (`bot-permission-flags.ts`, the same list as its all-permissions view).
 * They are not tied to a switched-on feature, so the page does not guess: it
 * names what each is for and leaves the choice to the admin.
 */
function usedPanel(): string {
  const rows = allFlagRows().filter((r) => r.use.kind === "used");
  if (rows.length === 0) return "";
  return `<section class="kb-panel" aria-labelledby="used-h">
  <header class="kb-panel__head"><h2 class="kb-panel__title" id="used-h">Used, but not checked here</h2><span class="kb-panel__meta">${rows.length} permissions</span></header>
  <div class="kb-panel__body"><p class="kb-muted">KoolBot uses these too, but this page cannot tell which of your switched-on features rely on them. Keep each one whose command or action you use.</p></div>
  <div class="kb-panel__body--flush"><table class="kb-table"><thead><tr><th scope="col">Permission</th><th scope="col">What KoolBot uses it for</th></tr></thead><tbody>${rows
    .map(
      (r) =>
        `<tr><th scope="row">${escapeHtml(r.name)}</th><td>${r.use.kind === "used" ? escapeHtml(r.use.for) : ""}</td></tr>`,
    )
    .join("")}</tbody></table></div>
</section>`;
}

function notNeededPanel(notNeeded: string[]): string {
  if (notNeeded.length === 0) return "";
  return `<section class="kb-panel" aria-labelledby="notneeded-h">
  <header class="kb-panel__head"><h2 class="kb-panel__title" id="notneeded-h">Not needed by your features</h2></header>
  <div class="kb-panel__body"><details class="kb-disclosure"><summary>Not needed by your features <span class="kb-badge kb-badge--count">${notNeeded.length}</span><span class="kb-disclosure__hint">only switched-off features use these</span></summary><div class="kb-disclosure__body"><p>${chips(notNeeded, true)}</p><p class="kb-muted">These are checked permissions that only switched-off features would use. A permission that is on none of these lists is not classified as safe to remove: Role groups can hand out only the permissions the bot holds.</p></div></details></div>
</section>`;
}

const SWAP_STEPS = [
  "In Discord, open Server Settings, then Roles, and open the bot's role.",
  "Switch on every permission under What your features need, and the ones under Used, but not checked here that you rely on, if the role does not have them yet.",
  "Switch off Administrator. If you gave the bot another role that has Administrator, take that role off the bot instead.",
  "Open Bot permissions and check that nothing is missing. If a feature stops working, switch on the permission it names.",
];

export function renderWizardDonePage(props: WizardDonePageProps): string {
  const { report, admin } = props;
  const parts: string[] = [];
  const flash = renderFlash(props.flash);
  if (flash) parts.push(flash);
  if (admin.state === "has") {
    parts.push(
      callout(
        "",
        "The bot still has Administrator",
        "That is fine to start with. The permissions below are the target: narrowing the bot to them means a compromised bot or Web UI session cannot do more than your features need.",
      ),
    );
  } else if (admin.state === "missing") {
    parts.push(
      callout(
        "",
        "The bot does not have Administrator",
        "There is nothing to swap. The permissions below are what your features need, and Bot permissions shows whether any is missing.",
      ),
    );
  }
  if (report.available) {
    const { needed, notNeeded } = splitNeeded(report);
    parts.push(
      `<p class="kb-muted">This list is what KoolBot checks and uses. <a href="${BOT_PERMISSIONS_HREF}">Bot permissions</a> shows every Discord permission and what KoolBot does with it.</p>`,
      neededPanel(needed),
      usedPanel(),
      notNeededPanel(notNeeded),
    );
    if (admin.state !== "missing") {
      parts.push(`<section class="kb-panel" aria-labelledby="swap-h">
  <header class="kb-panel__head"><h2 class="kb-panel__title" id="swap-h">Swap Administrator for these</h2><span class="kb-panel__meta">${SWAP_STEPS.length} steps</span></header>
  <div class="kb-panel__body"><ol class="kb-steps">${SWAP_STEPS.map((s) => `<li>${escapeHtml(s)}</li>`).join("")}</ol><p class="kb-muted">This step is optional. KoolBot never changes the bot's permissions in Discord itself.</p></div>
</section>`);
    }
  } else {
    parts.push(
      callout(
        "",
        "The permissions your features need could not be checked",
        `${report.reason ?? "The bot's permissions could not be checked right now."} Open Bot permissions to try again.`,
      ),
    );
  }
  parts.push(
    `<div class="kb-row"><a class="kb-btn kb-btn--primary" href="${BOT_PERMISSIONS_HREF}">Open Bot permissions</a><a class="kb-btn" href="/admin/settings">Skip for now</a></div>`,
  );
  return renderAdminPage({
    title: "Wizard: narrow the bot's permissions",
    active: "/admin/wizard",
    body: `<div class="kb-stack"><header class="kb-pagehead"><div class="kb-pagehead__text"><h1 class="kb-pagehead__title">Narrow the bot's permissions</h1>
<p class="kb-pagehead__sub">Setup is applied. This last step is optional: it shows which Discord permissions your features need and how to give the bot only those.</p></div></header>
${parts.join("\n")}</div>`,
    csrfToken: props.csrfToken,
    remainingMs: props.remainingMs,
    navFeatureStatus: props.navFeatureStatus,
  });
}
