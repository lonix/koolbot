import type { Client } from "discord.js";
import { env } from "../config/env.js";
import logger from "../utils/logger.js";
import { ConfigService } from "../services/config-service.js";
import { RulesAcceptance } from "../models/rules-acceptance.js";
import {
  linkCreatedRulesRole,
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
import { renderFlash, type FlashMessage } from "./admin-views.js";
import { renderAdoptionDiff } from "./adoption-diff.js";

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
  accepted: number;
  native: { screening: boolean; community: boolean };
  intentMissing: boolean;
  /** The rollout plan, only when the admin asked for a preview. */
  plan: RulesPlan | null;
  channels: Array<{ id: string; name: string }>;
  roleName: string | null;
  unavailable: string | null;
}

export async function loadRulesPage(
  client: Client,
  guildId: string,
  adminUserId: string,
  options: RulesPlanOptions | null,
): Promise<RulesPageData> {
  await linkCreatedRulesRole(guildId);
  const config = ConfigService.getInstance();
  const data: RulesPageData = {
    enabled: await config.getBoolean("rules.enabled", false),
    channelId: (await config.getString("rules.channel_id", "")).trim(),
    roleId: (await config.getString("rules.role_id", "")).trim(),
    messagePosted: !!(await config.getString("rules.message_id", "")).trim(),
    accepted: await RulesAcceptance.countDocuments({ guildId }).catch(() => 0),
    native: { screening: false, community: false },
    intentMissing: !env.guildMembersIntent,
    plan: null,
    channels: [],
    roleName: null,
    unavailable: null,
  };
  try {
    const guild = await client.guilds.fetch(guildId);
    data.native = RulesService.nativeGate(guild);
    if (options) {
      data.plan = await planRulesGate(guild, adminUserId, options);
      data.roleName = data.plan.roleName;
    }
    const channels = await guild.channels.fetch();
    data.channels = [...channels.values()]
      .filter((c) => c && (c.isTextBased() || c.isVoiceBased()))
      .map((c) => ({ id: c!.id, name: c!.name }))
      .sort((a, b) => a.name.localeCompare(b.name));
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
  csrfToken: string;
  remainingMs: number;
  navFeatureStatus?: NavFeatureStatus;
  options: RulesPlanOptions;
  jobId: string | null;
  flash?: FlashMessage | null;
}

const JOB_SCRIPT = (jobId: string): string =>
  `(function(){var id=${JSON.stringify(jobId)};var el=document.getElementById('rules-job');` +
  "function tick(){fetch('/admin/role-groups/job/'+encodeURIComponent(id),{credentials:'same-origin'})" +
  ".then(function(r){return r.json()}).then(function(j){" +
  "el.textContent=j.text;if(j.status==='running'){setTimeout(tick,1500)}else{setTimeout(function(){location.href='/admin/rules'},1500)}})" +
  ".catch(function(){el.textContent='Lost contact with the bot; reload to see the result.'})}tick()})();";

function renderNotices(p: RulesPageProps): string {
  const out: string[] = [];
  if (p.native.screening) {
    out.push(
      `<div class="notice warn" role="status"><strong>Discord's Membership Screening is on.</strong> It already asks new members to accept the rules. Using the KoolBot role as well means members accept twice. Prefer the native gate on Community servers; use this role for non-Community servers or when you want a custom message or button.</div>`,
    );
  } else if (p.native.community) {
    out.push(
      `<div class="notice" role="status">This is a Community server, which has Discord's own rules channel, Membership Screening and Onboarding. If you use those, you don't need the KoolBot role; two gates make new members accept twice.</div>`,
    );
  }
  if (p.intentMissing) {
    out.push(
      `<div class="notice warn" role="status">The Server Members intent is off (<code>GUILD_MEMBERS_INTENT</code>), so the member list can't be read. Granting the role to existing members and recording current holders won't work until it is on.</div>`,
    );
  }
  if (p.unavailable) {
    out.push(
      `<div class="notice warn" role="status">${escapeHtml(p.unavailable)}</div>`,
    );
  }
  return out.join("");
}

function renderStatus(p: RulesPageProps, csrf: string): string {
  const row = (k: string, v: string): string =>
    `<tr><th scope="row">${k}</th><td>${v}</td></tr>`;
  return `<div class="card">
  <h2>Status</h2>
  <table class="kv"><tbody>
    ${row("Feature", p.enabled ? `<span class="tag tag-on">on</span>` : `<span class="tag tag-off">off</span>`)}
    ${row("Rules channel", p.channelId ? `<code>${escapeHtml(p.channelId)}</code>` : "not set")}
    ${row("Acceptance role", p.roleId ? `${escapeHtml(p.roleName ?? "unknown role")} <code>${escapeHtml(p.roleId)}</code>` : "not set")}
    ${row("Rules message", p.messagePosted ? "posted" : "not posted yet")}
    ${row("Acceptances recorded", String(p.accepted))}
  </tbody></table>
  <p class="muted">Turn the feature on and pick the channel, role and texts on the <a href="/admin/settings">Settings</a> page. Make the rules channel read-only for members in Discord.</p>
  <div class="row">
    <form method="POST" action="/admin/rules/post">${csrf}<button type="submit" class="btn btn-primary"${p.enabled && p.channelId ? "" : " disabled"}>${p.messagePosted ? "Update the rules message" : "Post the rules message"}</button></form>
    <form method="POST" action="/admin/rules/sync" onsubmit="return confirm('Record everyone who already holds the acceptance role as accepted (adopted)? Nothing is changed in Discord.');">${csrf}<button type="submit" class="btn"${p.roleId ? "" : " disabled"}>Record current role holders as accepted</button></form>
  </div>
</div>`;
}

function renderRollout(p: RulesPageProps, csrf: string): string {
  const gated = new Set(p.options.gateChannelIds);
  const channelBoxes = p.channels
    .map(
      (c) =>
        `<label class="check"><input type="checkbox" name="gate" value="${escapeHtml(c.id)}"${gated.has(c.id) ? " checked" : ""}> #${escapeHtml(c.name)}</label>`,
    )
    .join("");
  const form = `<form method="GET" action="/admin/rules" class="stack">
    <input type="hidden" name="preview" value="1">
    ${
      p.roleId
        ? ""
        : `<label class="check"><input type="checkbox" name="createRole" value="1"${p.options.createRole ? " checked" : ""}> Create a role named "${escapeHtml(DEFAULT_RULES_ROLE_NAME)}" to use as the acceptance role</label>`
    }
    <label class="check"><input type="checkbox" name="grantExisting" value="1"${p.options.grantExisting ? " checked" : ""}> Grant the role to all current members, so the existing community isn't locked out</label>
    <fieldset><legend>Hide these channels from everyone except members with the role</legend>
      <div class="checks">${channelBoxes || `<span class="muted">No channels found.</span>`}</div>
    </fieldset>
    <button type="submit" class="btn">Preview changes</button>
  </form>`;
  return `<div class="card">
  <h2>Roll out to this server</h2>
  <p class="muted">Optional and off until you choose it. Nothing is changed in Discord until you apply a previewed plan; every apply saves a snapshot that can be rolled back. Members of the server who already hold a picked role count as accepted.</p>
  ${form}
  ${p.plan ? renderPlan(p, csrf) : ""}
</div>`;
}

function renderPlan(p: RulesPageProps, csrf: string): string {
  const plan = p.plan!;
  const pv = plan.preview;
  const n = (v: number | null): string => (v === null ? "unknown" : String(v));
  const counts = `<ul>
    <li>Members in the server: <strong>${n(pv.totalMembers)}</strong></li>
    <li>Already hold the acceptance role: <strong>${n(pv.holders)}</strong></li>
    <li>Would lose sight of the gated channels: <strong>${n(pv.lockedOut)}</strong> <span class="muted">(owner and administrators always see everything)</span></li>
  </ul>`;
  const extra = plan.extraErrors.length
    ? `<div class="card adoption-issues blockers"><h3>Needs attention (${plan.extraErrors.length})</h3><ul>${plan.extraErrors
        .map(
          (i) =>
            `<li><span class="tag tag-off">${escapeHtml(i.code)}</span> ${escapeHtml(i.message)}</li>`,
        )
        .join("")}</ul></div>`
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
    ? `<form method="POST" action="/admin/rules/apply" onsubmit="return confirm('Apply this plan to Discord? A snapshot is saved first so it can be rolled back.');">${csrf}${hidden}<button type="submit" class="btn btn-primary">Apply plan</button></form>`
    : plan.plan.operations.length === 0 && plan.extraErrors.length === 0
      ? `<p class="muted">Nothing to change: the server already matches.</p>`
      : "";
  return `<h3>Preview</h3>${counts}${extra}${renderAdoptionDiff(plan.plan)}${apply}`;
}

export function renderRulesPage(props: RulesPageProps): string {
  const csrf = `<input type="hidden" name="_csrf" value="${escapeHtml(props.csrfToken)}">`;
  const job = props.jobId
    ? `<div class="notice" id="rules-job" role="status">Applying…</div>`
    : "";
  const body = `
<h1>Rules Acceptance</h1>
<p class="subtitle">An optional rules gate: members press Accept in a read-only channel and receive an acceptance role. Off by default.</p>
${renderFlash(props.flash)}
${job}
${renderNotices(props)}
${renderStatus(props, csrf)}
${renderRollout(props, csrf)}
${props.jobId ? `<script>${JOB_SCRIPT(props.jobId)}</script>` : ""}
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
