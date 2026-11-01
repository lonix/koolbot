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
  /** An Event host role job the wizard started; Role groups shows how it ends. */
  hostJobId?: string | null;
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

function neededPanel(report: BotPermissionReport): string {
  const rows = buildMatrix(report);
  const needed = rows.filter((r) => r.status !== "off");
  const notNeeded = rows.filter((r) => r.status === "off");
  const body =
    needed.length > 0
      ? `<div class="kb-panel__body--flush"><table class="kb-table"><thead><tr><th scope="col">Permission</th><th scope="col">Needed by</th></tr></thead><tbody>${needed
          .map(
            (r) =>
              `<tr><th scope="row">${escapeHtml(r.label)}</th><td>${chips(
                [...new Set(r.features.map((f) => `${f.area}: ${f.feature}`))],
                false,
              )}${r.label === ROLE_POSITION_LABEL ? ' <span class="kb-muted">Keep the bot role above the roles it manages.</span>' : ""}</td></tr>`,
          )
          .join("")}</tbody></table></div>`
      : '<div class="kb-panel__body"><p class="kb-muted">No switched-on feature needs a Discord permission from the bot right now.</p></div>';
  const folded =
    notNeeded.length > 0
      ? `<div class="kb-panel__body"><details class="kb-disclosure"><summary>Not needed by your features <span class="kb-badge kb-badge--count">${notNeeded.length}</span><span class="kb-disclosure__hint">only switched-off features would use these</span></summary><div class="kb-disclosure__body"><p>${chips(
          notNeeded.map((r) => r.label),
          true,
        )}</p><p class="kb-muted">Every other Discord permission, including Administrator, is not needed either.</p></div></details></div>`
      : '<div class="kb-panel__body"><p class="kb-muted">Every other Discord permission, including Administrator, is not needed by your features.</p></div>';
  return `<section class="kb-panel" aria-labelledby="needed-h">
  <header class="kb-panel__head"><h2 class="kb-panel__title" id="needed-h">What your features need</h2><span class="kb-panel__meta">${needed.length} in use</span></header>
  ${body}
  ${folded}
</section>`;
}

const SWAP_STEPS = [
  "In Discord, open Server Settings, then Roles, and open the bot's role.",
  "Switch on every permission in the list above, if the role does not have it yet.",
  "Switch off Administrator. If you gave the bot another role that has Administrator, take that role off the bot instead.",
  "Open Bot permissions and check that nothing is missing. If a feature stops working, switch on the permission it names.",
];

export function renderWizardDonePage(props: WizardDonePageProps): string {
  const { report, admin } = props;
  const parts: string[] = [];
  const flash = renderFlash(props.flash);
  if (flash) parts.push(flash);
  if (props.hostJobId) {
    parts.push(
      `<div class="kb-callout" role="status">${toneIcon("")}<div class="kb-callout__body"><p class="kb-callout__title">The Event host role is being created</p><p class="kb-callout__text">Role groups shows how it ends.</p></div><div class="kb-callout__actions"><a class="kb-btn kb-btn--sm" href="/admin/role-groups?job=${encodeURIComponent(props.hostJobId)}">Open Role groups</a></div></div>`,
    );
  }
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
    parts.push(neededPanel(report));
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
