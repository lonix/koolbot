import type { ChannelType, Client, GuildBasedChannel } from "discord.js";
import { CONFIRM_NEUTRAL_ATTR, scriptTag } from "./html.js";
import { channelMention } from "./discord-labels.js";
import { env } from "../config/env.js";
import { GUILD_MEMBERS_INTENT_HOWTO } from "../utils/guild-members-intent.js";
import logger from "../utils/logger.js";
import { ConfigService } from "../services/config-service.js";
import { RulesAcceptance } from "../models/rules-acceptance.js";
import {
  planRulesGate,
  rulesPlanIsApplicable,
  DEFAULT_RULES_ROLE_NAME,
  type RulesPlan,
  type RulesPlanOptions,
} from "../services/rules-adoption.js";
import { RulesService } from "../services/rules-service.js";
import {
  escapeHtml,
  renderAdminPage,
  type NavFeatureStatus,
} from "./admin-layout.js";
import {
  kbEmptyState,
  renderFlash,
  renderRepostCard,
  type FlashMessage,
} from "./admin-views.js";
import { renderAdoptionDiff } from "./adoption-diff.js";
import { toneIcon, type Tone } from "./icons.js";
import { renderSettingRow } from "./host-settings-rows.js";
import { renderSwitch } from "./setting-controls.js";
import {
  renderPermissionNotice,
  type PermissionNotice,
} from "./permission-notice.js";

/**
 * Rules acceptance admin page (#1024). Settings live on the Settings page; this
 * page posts the rules message and previews/applies the adoption rollout
 * (create the role, grant it to existing members, gate channels) through the
 * engine. Nothing is written to Discord until Apply.
 */

const SNOWFLAKE = /^\d{5,25}$/;

/** Read the rollout options from a query string or form body. */
export function parseRulesOptions(
  source: Record<string, unknown>,
): RulesPlanOptions {
  const raw = source["gate"];
  const list = Array.isArray(raw) ? raw : raw === undefined ? [] : [raw];
  return {
    createRole: source["createRole"] === "1",
    grantExisting: source["grantExisting"] === "1",
    gateChannelIds: [
      ...new Set(list.map(String).filter((id) => SNOWFLAKE.test(id))),
    ],
  };
}

export interface RulesPageData {
  enabled: boolean;
  channelId: string;
  roleId: string;
  messagePosted: boolean;
  /** `rules.message_id`, sent back by Re-post so a double submit re-posts once. */
  messageId: string;
  accepted: number;
  native: { screening: boolean; community: boolean };
  intentMissing: boolean;
  /** The rollout plan, only when the admin asked for a preview. */
  plan: RulesPlan | null;
  channels: Array<{ id: string; name: string; type: ChannelType }>;
  roleName: string | null;
  unavailable: string | null;
}

/** Channels offered as gate targets: threads have no overwrites of their own. */
export function gateableChannels(
  channels: Array<GuildBasedChannel | null | undefined>,
): Array<{ id: string; name: string; type: ChannelType }> {
  return channels
    .filter(
      (c): c is GuildBasedChannel =>
        !!c &&
        !c.isThread() &&
        (c.isTextBased() || c.isVoiceBased() || c.isThreadOnly()),
    )
    .map((c) => ({ id: c.id, name: c.name, type: c.type }))
    .sort((a, b) => a.name.localeCompare(b.name));
}

export async function loadRulesPage(
  client: Client,
  guildId: string,
  adminUserId: string,
  options: RulesPlanOptions | null,
): Promise<RulesPageData> {
  const config = ConfigService.getInstance();
  const data: RulesPageData = {
    enabled: await config.getBoolean("rules.enabled", false),
    channelId: (await config.getString("rules.channel_id", "")).trim(),
    roleId: (await config.getString("rules.role_id", "")).trim(),
    messagePosted: false,
    messageId: "",
    accepted: await RulesAcceptance.countDocuments({ guildId }).catch(() => 0),
    native: { screening: false, community: false },
    intentMissing: !env.guildMembersIntent,
    plan: null,
    channels: [],
    roleName: null,
    unavailable: null,
  };
  data.messageId = (await config.getString("rules.message_id", "")).trim();
  data.messagePosted = data.messageId !== "";
  try {
    const guild = await client.guilds.fetch(guildId);
    data.native = RulesService.nativeGate(guild);
    if (options) {
      data.plan = await planRulesGate(guild, adminUserId, options);
      data.roleName = data.plan.roleName;
    }
    const channels = await guild.channels.fetch();
    data.channels = gateableChannels([...channels.values()]);
    if (!data.roleName && data.roleId) {
      data.roleName = (await guild.roles.fetch(data.roleId))?.name ?? null;
    }
  } catch (error) {
    logger.warn("rules: could not read the server", error);
    data.unavailable =
      "The server couldn't be read from Discord, so no preview is shown. Reload to try again.";
  }
  return data;
}

export interface RulesPageProps extends RulesPageData {
  /** What the bot lacks for the rules channel and the acceptance role (#1491). Null: nothing to say. */
  permissionNotice?: PermissionNotice | null;
  csrfToken: string;
  remainingMs: number;
  navFeatureStatus?: NavFeatureStatus;
  options: RulesPlanOptions;
  jobId: string | null;
  flash?: FlashMessage | null;
}

export const JOB_SCRIPT = (jobId: string): string =>
  `(function(){var id=${JSON.stringify(jobId)};var el=document.getElementById('rules-job');` +
  "function tick(){fetch('/admin/role-groups/job/'+encodeURIComponent(id),{credentials:'same-origin'})" +
  ".then(function(r){return r.json()}).then(function(j){" +
  "el.textContent=j.text;if(j.status==='running'){setTimeout(tick,1500)}else{setTimeout(function(){location.href='/admin/rules'},1500)}})" +
  ".catch(function(){el.textContent='Lost contact with the bot; reload to see the result.'})}tick()})();";

/** A Callout. `title` is plain text; `text` is HTML the caller has escaped. A failure is an alert, everything else a status. */
function callout(o: {
  tone: Tone;
  title: string;
  text?: string;
  id?: string;
}): string {
  const role = o.tone === "err" ? "alert" : "status";
  const cls = o.tone ? `kb-callout kb-callout--${o.tone}` : "kb-callout";
  const titleId = o.id ? ` id="${escapeHtml(o.id)}"` : "";
  return `<div class="${cls}" role="${role}">${toneIcon(o.tone)}<div class="kb-callout__body"><p class="kb-callout__title"${titleId}>${escapeHtml(o.title)}</p>${o.text ? `<p class="kb-callout__text">${o.text}</p>` : ""}</div></div>`;
}

/** A Panel: `body` is HTML the caller has escaped; the body is spaced as a stack. */
function panel(id: string, title: string, body: string): string {
  return `<section class="kb-panel" id="${id}" aria-labelledby="${id}-h">
  <header class="kb-panel__head"><h2 class="kb-panel__title" id="${id}-h">${escapeHtml(title)}</h2></header>
  <div class="kb-panel__body"><div class="kb-stack">${body}</div></div>
</section>`;
}

/** Why the rules message can't be posted yet, or null when it can. */
function postBlockedReason(p: RulesPageProps): string | null {
  if (!p.enabled) return "Turn on Rules acceptance in Settings first.";
  if (!p.channelId) return "Set the rules channel first.";
  return null;
}

/**
 * The rollout in one sentence: all the page knows is whether a plan is
 * previewed, and whether it can be applied. A plan that is blocked is not the
 * same as one with nothing to change (`rulesPlanIsApplicable` is false for both).
 */
function rolloutLine(p: RulesPageProps): string {
  const plan = p.plan;
  if (!plan) return "No rollout is previewed.";
  if (rulesPlanIsApplicable(plan)) {
    return "A rollout is previewed below and can be applied.";
  }
  if (plan.plan.errors.length > 0 || plan.extraErrors.length > 0) {
    return "A rollout is previewed below, but it can't be applied until the listed problems are fixed.";
  }
  return "A rollout is previewed below; there is nothing to apply.";
}

/** The verdict the page opens with: the state of the rules message, then of the rollout. */
function renderVerdict(p: RulesPageProps): string {
  const settings = `<a href="/admin/settings">Settings</a>`;
  const rollout = escapeHtml(rolloutLine(p));
  if (!p.enabled) {
    return callout({
      tone: "",
      title: "Rules acceptance is off.",
      text: `Turn it on in ${settings} to post the rules message. ${rollout}`,
    });
  }
  if (!p.channelId) {
    return callout({
      tone: "warn",
      title: "No rules channel is set.",
      text: `The rules message is posted in the channel you pick in ${settings}. ${rollout}`,
    });
  }
  if (!p.messagePosted) {
    return callout({
      tone: "warn",
      title: "The rules message is not posted yet.",
      text: `Post it below so members can accept. ${rollout}`,
    });
  }
  return callout({
    tone: "ok",
    title: "The rules message is posted.",
    text: `${p.accepted} ${p.accepted === 1 ? "acceptance" : "acceptances"} recorded. ${rollout}`,
  });
}

function renderNotices(p: RulesPageProps): string {
  const out: string[] = [];
  if (p.native.screening) {
    out.push(
      callout({
        tone: "warn",
        title: "Discord's Membership Screening is on.",
        text: "It already asks new members to accept the rules. Using the KoolBot role as well means members accept twice. Prefer the native gate on Community servers; use this role for non-Community servers or when you want a custom message or button.",
      }),
    );
  } else if (p.native.community) {
    out.push(
      callout({
        tone: "",
        title:
          "This is a Community server, which has Discord's own rules channel, Membership Screening and Onboarding.",
        text: "If you use those, you don't need the KoolBot role; two gates make new members accept twice.",
      }),
    );
  }
  if (p.intentMissing) {
    out.push(
      callout({
        tone: "warn",
        title:
          "The Server Members intent is off, so the member list can't be read.",
        text: `Granting the role to existing members and recording current holders won't work until it is on. ${escapeHtml(GUILD_MEMBERS_INTENT_HOWTO)}`,
      }),
    );
  }
  if (p.unavailable) {
    out.push(callout({ tone: "warn", title: p.unavailable }));
  }
  return out.join("");
}

function renderStatus(p: RulesPageProps, csrf: string): string {
  const row = (k: string, v: string): string => `<dt>${k}</dt><dd>${v}</dd>`;
  const mono = (v: string): string =>
    `<code class="kb-mono">${escapeHtml(v)}</code>`;
  const blocked = postBlockedReason(p);
  const syncBlocked = p.roleId
    ? null
    : "Set the acceptance role in Settings first.";
  const why = [blocked, syncBlocked]
    .filter((r): r is string => r !== null)
    .map((r) => `<p class="kb-help">${escapeHtml(r)}</p>`)
    .join("");
  const postClass =
    p.plan && rulesPlanIsApplicable(p.plan)
      ? "kb-btn"
      : "kb-btn kb-btn--primary";
  return panel(
    "rules-status",
    "Status",
    `<dl class="kb-kv">
    ${row("Feature", p.enabled ? `<span class="kb-badge kb-badge--on">On</span>` : `<span class="kb-badge kb-badge--off">Off</span>`)}
    ${row("Rules channel", p.channelId ? mono(p.channelId) : "not set")}
    ${row("Acceptance role", p.roleId ? `${escapeHtml(p.roleName ?? "unknown role")} ${mono(p.roleId)}` : "not set")}
    ${row("Rules message", p.messagePosted ? "posted" : "not posted yet")}
    ${row("Acceptances recorded", String(p.accepted))}
  </dl>
  <p class="kb-help">Turn the feature on and pick the channel, role and texts on the <a href="/admin/settings">Settings</a> page. Make the rules channel read-only for members in Discord.</p>
  <div class="kb-row">
    <form method="POST" action="/admin/rules/post">${csrf}<button type="submit" class="${postClass}"${blocked === null ? "" : " disabled"}>${p.messagePosted ? "Update the rules message" : "Post the rules message"}</button></form>
    <form method="POST" action="/admin/rules/sync" data-confirm="Record everyone who already holds the acceptance role as accepted (adopted)? Nothing is changed in Discord."${CONFIRM_NEUTRAL_ATTR}>${csrf}<button type="submit" class="kb-btn" aria-describedby="rules-sync-help"${syncBlocked === null ? "" : " disabled"}>Record current role holders</button></form>
  </div><p class="kb-help" id="rules-sync-help">Record current role holders marks everyone who already holds the acceptance role as accepted. Nothing is changed in Discord.</p>${why}`,
  );
}

function renderRepost(p: RulesPageProps, csrf: string): string {
  return renderRepostCard({
    id: "repost-message",
    heading: "Re-post the rules message",
    intro:
      "Update edits the posted message in place. Re-post makes a brand new message and takes the old one down, for example if the old one looks broken or was buried.",
    action: "/admin/rules/repost",
    csrfInput: csrf,
    messageId: p.messageId,
    buttonLabel: "Re-post the rules message",
    confirmText: "Re-post the rules message?",
    consequences: [
      "A new rules message with its Accept button is posted in the rules channel.",
      "The old message is deleted if KoolBot can find it in this channel. Its Accept button stops working either way.",
      "Members who already accepted keep their acceptance and role.",
    ],
    blockedReason: postBlockedReason(p),
  });
}

function renderRollout(p: RulesPageProps, csrf: string): string {
  const gated = new Set(p.options.gateChannelIds);
  const channelBoxes = p.channels
    .map((c) => {
      const id = `rules-gate-${c.id}`;
      return `<li><label for="${escapeHtml(id)}"><input type="checkbox" id="${escapeHtml(id)}" name="gate" value="${escapeHtml(c.id)}"${gated.has(c.id) ? " checked" : ""}> ${channelMention({ name: c.name, type: c.type })}</label></li>`;
    })
    .join("");
  const option = (
    id: string,
    name: string,
    label: string,
    line: string,
    on: boolean,
  ): string =>
    renderSettingRow({
      id,
      name: label,
      line,
      control: renderSwitch(name, on, {
        id: `${id}-input`,
        labelledBy: `${id}-name`,
        describedBy: `${id}-desc`,
        onValue: "1",
      }),
    });
  const options = [
    p.roleId
      ? ""
      : option(
          "rules-create-role",
          "createRole",
          `Create a role named "${DEFAULT_RULES_ROLE_NAME}"`,
          "To use as the acceptance role.",
          p.options.createRole,
        ),
    option(
      "rules-grant-existing",
      "grantExisting",
      "Grant the role to all current members",
      "So the existing community isn't locked out.",
      p.options.grantExisting,
    ),
  ].join("");
  const form = `<form method="GET" action="/admin/rules" class="kb-stack">
    <input type="hidden" name="preview" value="1">
    <div class="kb-settings">${options}</div>
    <fieldset class="kb-field"><legend class="kb-label">Hide these channels from everyone except members with the role</legend>
      ${channelBoxes ? `<ul class="kb-list">${channelBoxes}</ul>` : `<p class="kb-help">No channels found.</p>`}
    </fieldset>
    <div><button type="submit" class="kb-btn">Preview changes</button></div>
  </form>`;
  const rollout = panel(
    "rules-rollout",
    "Roll out to this server",
    `<p class="kb-help">Optional and off until you choose it. Nothing is changed in Discord until you apply a previewed plan; every apply saves a snapshot first. Rolling back from the Web UI is not available yet. Members of the server who already hold a picked role count as accepted.</p>
  ${form}`,
  );
  return `${rollout}${p.plan ? renderPlan(p, csrf) : ""}`;
}

function renderPlan(p: RulesPageProps, csrf: string): string {
  const plan = p.plan!;
  const pv = plan.preview;
  const n = (v: number | null): string => (v === null ? "unknown" : String(v));
  const counts = `<dl class="kb-numbers">
    <div><dt>Members in the server</dt><dd>${n(pv.totalMembers)}</dd></div>
    <div><dt>Already hold the acceptance role</dt><dd>${n(pv.holders)}</dd></div>
    <div><dt>Would lose sight of the gated channels</dt><dd>${n(pv.lockedOut)}</dd></div>
  </dl>
  <p class="kb-help">Owner and administrators always see everything.</p>`;
  const extra = plan.extraErrors.length
    ? `<div class="kb-callout kb-callout--err" role="alert">${toneIcon("err")}<div class="kb-callout__body"><p class="kb-callout__title">Needs attention (${plan.extraErrors.length})</p><div class="kb-callout__text"><ul>${plan.extraErrors
        .map(
          (i) =>
            `<li><span class="kb-badge kb-badge--off">${escapeHtml(i.code)}</span> ${escapeHtml(i.message)}</li>`,
        )
        .join("")}</ul></div></div></div>`
    : "";
  const hidden =
    `<input type="hidden" name="planId" value="${escapeHtml(plan.plan.id)}">` +
    (p.options.createRole
      ? `<input type="hidden" name="createRole" value="1">`
      : "") +
    (p.options.grantExisting
      ? `<input type="hidden" name="grantExisting" value="1">`
      : "") +
    p.options.gateChannelIds
      .map(
        (id) => `<input type="hidden" name="gate" value="${escapeHtml(id)}">`,
      )
      .join("");
  const apply = rulesPlanIsApplicable(plan)
    ? `<form method="POST" action="/admin/rules/apply" data-confirm="Apply this plan to Discord? A snapshot is saved first."${CONFIRM_NEUTRAL_ATTR}>${csrf}${hidden}<button type="submit" class="kb-btn kb-btn--primary">Apply plan</button></form>`
    : plan.plan.operations.length === 0 && plan.extraErrors.length === 0
      ? kbEmptyState(
          "circle-check",
          "Nothing to change",
          "The server already matches.",
        )
      : "";
  return panel(
    "rules-preview",
    "Preview",
    `${counts}${extra}<div class="kb-panel__body--flush">${renderAdoptionDiff(plan.plan)}</div>${apply}`,
  );
}

export function renderRulesPage(props: RulesPageProps): string {
  const csrf = `<input type="hidden" name="_csrf" value="${escapeHtml(props.csrfToken)}">`;
  // `JOB_SCRIPT` sets the text of #rules-job, so the id sits on the Callout's title.
  const job = props.jobId
    ? callout({ tone: "", title: "Applying…", id: "rules-job" })
    : "";
  const body = `<div class="kb-stack">
<header class="kb-pagehead"><div class="kb-pagehead__text">
  <h1 class="kb-pagehead__title">Rules Acceptance</h1>
  <p class="kb-pagehead__sub">An optional rules gate: members press Accept in a read-only channel and receive an acceptance role. Off by default.</p>
</div></header>
${renderFlash(props.flash)}
${job}
${renderVerdict(props)}
${renderPermissionNotice(props.permissionNotice ?? null, { canLinkToPage: true })}
${renderNotices(props)}
${renderStatus(props, csrf)}
${renderRepost(props, csrf)}
${renderRollout(props, csrf)}
</div>
${props.jobId ? `${scriptTag(JOB_SCRIPT(props.jobId))}` : ""}
`;
  return renderAdminPage({
    title: "Rules Acceptance",
    active: "/admin/rules",
    body,
    csrfToken: props.csrfToken,
    remainingMs: props.remainingMs,
    navFeatureStatus: props.navFeatureStatus,
  });
}
