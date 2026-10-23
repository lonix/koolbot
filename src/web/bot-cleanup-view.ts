import { URLSearchParams } from "node:url";
import {
  escapeHtml,
  renderAdminPage,
  type NavFeatureStatus,
} from "./admin-layout.js";
import { scriptTag } from "./html.js";
import { renderFlash, type FlashMessage } from "./admin-views.js";
import {
  renderAdoptionDiff,
  renderDestructiveConfirm,
} from "./adoption-diff.js";
import {
  cleanupPlanIsApplicable,
  type BotCleanupPlan,
  type RemovedBotCandidate,
} from "../services/bot-removal-cleanup.js";

/**
 * Cleanup after a removed bot (#1179). The admin removes the bot in Discord
 * first (KoolBot never kicks other bots); this page lists what it left behind,
 * previews removing the permission overwrites that still point at it, and
 * applies the plan through the adoption engine (snapshot first, rollback from
 * the adoption history). Nothing is ticked for the admin to apply by accident:
 * the preview is a GET and the apply is a CSRF-checked POST with the engine's
 * separate destructive confirmation.
 */

export const BOT_CLEANUP_PATH = "/admin/adopt/cleanup";
const CLAIMS_PATH = "/admin/adopt/claims";
const HISTORY_PATH = "/admin/adopt/history";

export interface BotCleanupPageProps {
  csrfToken: string;
  remainingMs: number;
  navFeatureStatus?: NavFeatureStatus;
  /** The removed bot the page is about; null when none is chosen. */
  botId: string | null;
  /** Candidates found in the scan; null when the server could not be read. */
  candidates: RemovedBotCandidate[] | null;
  /** Accounts Discord could not be asked about, so they are not listed. */
  unchecked?: number;
  /** The previewed plan, when the admin asked for one. */
  planned: BotCleanupPlan | null;
  /** The channels ticked for the preview (default: none). */
  selectedChannelIds: readonly string[];
  /** Ownership hints were on for this page. */
  sampled: boolean;
  /** Stamp of the preview, carried to the apply step. */
  approvedAt: string | null;
  error?: string;
  jobId?: string | null;
  flash?: FlashMessage | null;
}

const JOB_SCRIPT = (jobId: string): string =>
  `(function(){var id=${JSON.stringify(jobId)};var el=document.getElementById('bc-job');` +
  "function tick(){fetch('/admin/role-groups/job/'+encodeURIComponent(id),{credentials:'same-origin'})" +
  ".then(function(r){return r.json()}).then(function(j){" +
  `el.textContent=j.text;if(j.status==='running'){setTimeout(tick,1500)}else{setTimeout(function(){location.href='${BOT_CLEANUP_PATH}'},1500)}})` +
  ".catch(function(){el.textContent='Lost contact with the bot; reload to see the result.'})}tick()})();";

function callout(kind: "" | "warn" | "ok" | "err", text: string): string {
  const role = kind === "err" || kind === "warn" ? "alert" : "status";
  return `<div class="kb-callout${kind ? ` kb-callout--${kind}` : ""}" role="${role}"><div class="kb-callout__body"><p class="kb-callout__text">${text}</p></div></div>`;
}

function panel(title: string, id: string, body: string): string {
  return `<section class="kb-panel" aria-labelledby="${id}">
  <header class="kb-panel__head"><h2 class="kb-panel__title" id="${id}">${escapeHtml(title)}</h2></header>
  <div class="kb-panel__body kb-stack">${body}</div>
</section>`;
}

function cleanupHref(
  botId: string,
  sampled: boolean,
  extra: Record<string, string> = {},
): string {
  const q = new URLSearchParams({ bot: botId, ...extra });
  if (sampled) q.set("sample", "1");
  return `${BOT_CLEANUP_PATH}?${q.toString()}`;
}

function claimHref(channelId: string, key: string): string {
  const q = new URLSearchParams({ channel: channelId, feature: key });
  return `${CLAIMS_PATH}?${q.toString()}`;
}

function renderPicker(p: BotCleanupPageProps): string {
  const list = p.candidates ?? [];
  const note = p.unchecked
    ? callout(
        "warn",
        `${p.unchecked} account(s) with a leftover overwrite could not be checked with Discord and are not listed. Reload to try again.`,
      )
    : "";
  if (list.length === 0) {
    return `${note}<div class="kb-empty"><p class="kb-empty__title">No removed bot found.</p><p class="kb-empty__text">Remove the bot in Discord first. Bots that were removed show up here when a permission overwrite, a catalogue id or a channel it wrote to still points at them. Turn on channel ownership hints on the <a href="/admin/adopt?sample=1&amp;tab=bots">Server scan</a> to also find channels a removed bot wrote to.</p></div>`;
  }
  const rows = list
    .map(
      (c) =>
        `<tr><th scope="row">${escapeHtml(c.name)}${c.name === c.userId ? "" : ` <span class="kb-muted kb-mono">${escapeHtml(c.userId)}</span>`}</th><td>${escapeHtml(c.reason)}</td><td>${c.overwriteChannels.length}</td><td><a class="kb-btn kb-btn--sm" href="${escapeHtml(cleanupHref(c.userId, p.sampled))}">Review cleanup<span class="kb-visually-hidden"> for ${escapeHtml(c.name)}</span></a></td></tr>`,
    )
    .join("");
  return `${note}<div class="kb-panel__body--flush"><table class="kb-table"><caption class="kb-visually-hidden">Removed bots with leftovers</caption><thead><tr><th scope="col">Bot</th><th scope="col">Why it is listed</th><th scope="col">Overwrites left</th><th scope="col"><span class="kb-visually-hidden">Action</span></th></tr></thead><tbody>${rows}</tbody></table></div>`;
}

function renderChoice(c: RemovedBotCandidate, p: BotCleanupPageProps): string {
  const chosen = new Set(p.selectedChannelIds);
  const rows = c.overwriteChannels
    .map((ch, i) => {
      const id = `bc-ch-${i}`;
      return `<li><label for="${id}"><input type="checkbox" id="${id}" name="ch" value="${escapeHtml(ch.id)}"${chosen.has(ch.id) ? " checked" : ""}> Remove the overwrite for the removed bot on <strong>${escapeHtml(ch.name)}</strong></label></li>`;
    })
    .join("");
  const owned = c.ownedChannels.length
    ? `<h3>Channels it mostly wrote to</h3><ul class="kb-list">${c.ownedChannels
        .map(
          (ch) =>
            `<li><span class="kb-list__main"><strong>${escapeHtml(ch.name)}</strong>${ch.usedBy.length ? ` <span class="kb-muted">bound to ${escapeHtml(ch.usedBy.join(", "))}</span>` : ""}</span>${ch.claimKey ? `<a class="kb-btn kb-btn--sm" href="${escapeHtml(claimHref(ch.id, ch.claimKey))}">Claim<span class="kb-visually-hidden"> ${escapeHtml(ch.name)}</span></a>` : ""}</li>`,
        )
        .join(
          "",
        )}</ul><p class="kb-muted">Claiming is done on Channel claims, with its own preview. This page never archives, deletes or edits these channels.</p>`
    : "";
  const form =
    c.overwriteChannels.length > 0
      ? `<form method="get" action="${BOT_CLEANUP_PATH}" class="kb-stack">
  <input type="hidden" name="bot" value="${escapeHtml(c.userId)}">
  <input type="hidden" name="preview" value="1">${p.sampled ? `<input type="hidden" name="sample" value="1">` : ""}
  <fieldset class="kb-stack"><legend>Overwrites to remove (nothing is ticked for you)</legend><ul class="kb-list">${rows}</ul></fieldset>
  <div><button type="submit" class="kb-btn">Preview changes</button></div>
</form>`
      : `<p class="kb-muted">No permission overwrite for this bot is left on any channel, so there is nothing to remove.</p>`;
  return `<p>${escapeHtml(c.reason)}</p>${form}${owned}`;
}

function renderPlan(p: BotCleanupPageProps, plan: BotCleanupPlan): string {
  const csrf = `<input type="hidden" name="_csrf" value="${escapeHtml(p.csrfToken)}">`;
  const problems = plan.errors.length
    ? `<div class="kb-callout kb-callout--err" role="alert"><div class="kb-callout__body"><p class="kb-callout__title">This can't be planned</p><ul>${plan.errors.map((e) => `<li>${escapeHtml(e.message)}</li>`).join("")}</ul></div></div>`
    : "";
  const apply =
    cleanupPlanIsApplicable(plan) && p.approvedAt
      ? `<form method="POST" action="${BOT_CLEANUP_PATH}/apply" class="kb-stack" data-confirm="Apply this cleanup to Discord? A snapshot is saved first so it can be rolled back.">${csrf}<input type="hidden" name="planId" value="${escapeHtml(plan.plan.id)}"><input type="hidden" name="bot" value="${escapeHtml(p.botId ?? "")}"><input type="hidden" name="at" value="${escapeHtml(p.approvedAt)}">${p.sampled ? `<input type="hidden" name="sample" value="1">` : ""}${plan.channelIds.map((id) => `<input type="hidden" name="ch" value="${escapeHtml(id)}">`).join("")}${renderDestructiveConfirm(plan.plan)}<div><button type="submit" class="kb-btn kb-btn--primary">Apply plan</button> <span class="kb-muted">A snapshot of everything touched is saved first. Roll it back from <a href="${HISTORY_PATH}">Adoption history</a>.</span></div></form>`
      : "";
  return `${problems}${renderAdoptionDiff(plan.plan)}${apply}`;
}

export function renderBotCleanupPage(props: BotCleanupPageProps): string {
  const job = props.jobId
    ? `<div class="kb-callout" role="status"><div class="kb-callout__body"><p class="kb-callout__text" id="bc-job">Applying…</p></div></div>`
    : "";
  const chosen =
    props.candidates?.find((c) => c.userId === props.botId) ?? null;
  const notFound =
    props.candidates && props.botId && !chosen
      ? callout(
          "warn",
          "That bot is not in the list below any more. Pick one again.",
        )
      : "";
  const content =
    props.candidates === null
      ? callout(
          "err",
          `The server couldn't be read: ${escapeHtml(props.error ?? "unknown error")}. Nothing was planned. Check that the bot is in the server, then reload.`,
        )
      : `${notFound}${panel("Removed bots", "p-removed", renderPicker(props))}${
          chosen
            ? panel(
                `Clean up after ${chosen.name}`,
                "p-choice",
                renderChoice(chosen, props),
              )
            : ""
        }${
          props.planned
            ? panel("Plan", "p-plan", renderPlan(props, props.planned))
            : ""
        }`;
  const body = `<div class="kb-stack">
<header class="kb-pagehead"><div class="kb-pagehead__text">
  <h1 class="kb-pagehead__title">Clean up after a removed bot</h1>
  <p class="kb-pagehead__sub">KoolBot never removes another bot: remove it in Discord yourself, then tidy what it left behind here. Discord removes the bot's own role, but not permission overwrites that name it. Everything is previewed, snapshotted before it runs, and can be rolled back from <a href="${HISTORY_PATH}">Adoption history</a>.</p>
</div></header>
${renderFlash(props.flash)}
${job}
${content}
</div>
${props.jobId ? scriptTag(JOB_SCRIPT(props.jobId)) : ""}`;
  return renderAdminPage({
    title: "Clean up after a removed bot",
    active: "/admin/adopt",
    body,
    csrfToken: props.csrfToken,
    remainingMs: props.remainingMs,
    navFeatureStatus: props.navFeatureStatus,
  });
}
