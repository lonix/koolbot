import {
  escapeHtml,
  renderAdminPage,
  type NavFeatureStatus,
} from "./admin-layout.js";
import { CONFIRM_NEUTRAL_ATTR, scriptTag } from "./html.js";
import {
  channelMention,
  namedChannelMention,
  roleMention,
  roleText,
} from "./discord-labels.js";
import { ChannelType } from "discord.js";
import { renderFlash, type FlashMessage } from "./admin-views.js";
import { icon, toneIcon, type Tone } from "./icons.js";
import { renderEmojiField } from "./setting-pickers.js";
import {
  renderAdoptionDiff,
  renderDestructiveConfirm,
} from "./adoption-diff.js";
import {
  CLAIM_ACTIONS,
  FEATURE_TARGETS,
  featureFitsChannel,
  type ChannelClaim,
  type ClaimAction,
} from "../services/channel-claims.js";
import type { ClaimsPlan } from "../services/channel-claims-adoption.js";
import type {
  ServerScan,
  ScanChannel,
} from "../services/server-scan-service.js";
import type { RoleGroupView } from "../services/role-group-service.js";
import {
  DEFAULT_PAIR_EMOJI,
  detectFeeds,
  detectRolePairings,
  type FeedDetection,
  type RolePairing,
} from "../services/channel-claims-suggestions.js";

/**
 * Category and channel claims page (#1022). The admin picks, per category or
 * channel, what KoolBot should do: leave it alone (the default for
 * everything), make it read-only, gate it to groups, sync it to its category,
 * or bind it to a feature. Nothing is written until the plan below the form is
 * applied, and every apply is snapshotted by the adoption engine.
 */

const ACTION_LABELS: Record<ClaimAction, string> = {
  leave: "Leave alone",
  "read-only": "Read-only (bot posts)",
  gate: "Group-gated",
  sync: "Sync to category (replaces permissions)",
};

export interface ClaimsPageProps {
  csrfToken: string;
  remainingMs: number;
  navFeatureStatus?: NavFeatureStatus;
  /** Null when the scan failed outright. */
  scan: ServerScan | null;
  error?: string;
  groups: RoleGroupView[];
  /** What the form shows as already chosen (after a preview). */
  claims: ChannelClaim[];
  plan: ClaimsPlan | null;
  /** Things ignored while reading the form. */
  problems: string[];
  /** Server-side handle on the previewed claims; the apply step sends only this. */
  previewToken: string | null;
  jobId?: string | null;
  flash?: FlashMessage | null;
  /**
   * A channel and feature arriving from the Server scan's *Claim* link: the
   * form shows the feature already chosen for that channel and says so. Only
   * a choice the form offers is ever set, and nothing is written until the
   * plan is previewed and applied.
   */
  prefill?: {
    channelId: string;
    channelName: string;
    /** Discord channel type name (`GuildVoice`), so the notice can label it. */
    channelTypeName?: string;
    featureLabel: string;
  } | null;
}

const checked = (v: boolean | undefined): string => (v ? " checked" : "");

/**
 * A Callout. `title` and `text` are HTML the caller has already escaped. A
 * state is a `status`; only the failure of an action is an `alert`.
 */
function callout(
  tone: Tone,
  role: "status" | "alert",
  title: string,
  o: { text?: string; textHtml?: string; titleId?: string } = {},
): string {
  const cls = tone ? ` kb-callout--${tone}` : "";
  const id = o.titleId ? ` id="${o.titleId}"` : "";
  const body = o.textHtml
    ? `<div class="kb-callout__text">${o.textHtml}</div>`
    : o.text
      ? `<p class="kb-callout__text">${o.text}</p>`
      : "";
  return `<div class="kb-callout${cls}" role="${role}">${toneIcon(tone)}<div class="kb-callout__body"><p class="kb-callout__title"${id}>${title}</p>${body}</div></div>`;
}

/** A labelled control: `kb-field` with a `for`/`id` pair, so the label names the control. */
function field(id: string, label: string, control: string): string {
  return `<div class="kb-field"><label class="kb-label" for="${id}">${label}</label>${control}</div>`;
}

/**
 * A checkbox with its label, in normal flow so a long text wraps beside the
 * box (a `kb-row` would put the box alone on a line). No component exists for
 * a plain checkbox; the label stays a bare element, with no class.
 */
function check(input: string, text: string): string {
  return `<label>${input} <span>${text}</span></label>`;
}

/** A Panel's head; the title is a plain wrapping flex row, never `kb-row`. */
function panelHead(id: string, title: string): string {
  return `<header class="kb-panel__head"><h2 class="kb-panel__title" id="${id}">${title}</h2></header>`;
}

function featureOptions(channel: ScanChannel, selected: string): string {
  const fits = FEATURE_TARGETS.filter((f) => featureFitsChannel(f, channel));
  if (fits.length === 0) return "";
  const name = `bind_${escapeHtml(channel.id)}`;
  return field(
    name,
    "Bind to a feature",
    `<select class="kb-select" id="${name}" name="${name}"><option value="">(none)</option>${fits
      .map(
        (f) =>
          `<option value="${escapeHtml(f.key)}"${f.key === selected ? " selected" : ""}>${escapeHtml(f.label)}</option>`,
      )
      .join("")}</select>`,
  );
}

function roleOptions(scan: ServerScan, selected: readonly string[]): string {
  return scan.roles
    .filter((r) => !r.isEveryone)
    .slice()
    .sort((a, b) => b.position - a.position)
    .map((r) => {
      const disabled = r.botId !== null;
      const note = disabled
        ? " (bot integration)"
        : r.managed
          ? " (managed: gate only)"
          : "";
      return `<option value="${escapeHtml(r.id)}"${selected.includes(r.id) ? " selected" : ""}${disabled ? " disabled" : ""}>${escapeHtml(roleText(r.name))}${escapeHtml(note)}</option>`;
    })
    .join("");
}

function notes(
  c: ScanChannel,
  feeds: FeedDetection,
  pairing: RolePairing | undefined,
): string {
  const out: string[] = [];
  if (c.usedBy.length) out.push(`used by ${c.usedBy.join(", ")}`);
  if (feeds.feeds.some((f) => f.channelId === c.id))
    out.push("news feed: read-only is suggested; webhooks are never touched");
  if (c.flags.announcement)
    out.push(
      "announcement channel: read-only is suggested (not selected for you)",
    );
  if (pairing) out.push("gated by one role: can be registered as a game role");
  else if (c.gatedByRoleIds.length) out.push("already gated by a role");
  if (c.flags.rules || c.flags.system || c.flags.publicUpdates)
    out.push("a Discord community channel");
  if (c.syncedToParent === false) out.push("own permissions");
  return out.length
    ? `<div class="kb-muted">${escapeHtml(out.join("; "))}</div>`
    : "";
}

function claimRow(
  c: ScanChannel,
  scan: ServerScan,
  groups: RoleGroupView[],
  claim: ChannelClaim | undefined,
  bulk: boolean,
  feeds: FeedDetection,
  pairing: RolePairing | undefined,
): string {
  const id = escapeHtml(c.id);
  const action = claim?.action ?? "leave";
  const actionSelect = `<select class="kb-select" name="action_${id}" aria-label="Action for ${escapeHtml(c.name)}">${CLAIM_ACTIONS.filter(
    (a) => a !== "sync" || c.parentId !== null,
  )
    .map(
      (a) =>
        `<option value="${a}"${a === action ? " selected" : ""}>${escapeHtml(ACTION_LABELS[a])}</option>`,
    )
    .join("")}</select>`;
  const bulkSelect = bulk
    ? field(
        `bulk_${id}`,
        "For every channel here left alone",
        `<select class="kb-select" id="bulk_${id}" name="bulk_${id}"><option value="">(no change)</option>${CLAIM_ACTIONS.filter(
          (a) => a !== "leave",
        )
          .map(
            (a) =>
              `<option value="${a}">${escapeHtml(ACTION_LABELS[a])}</option>`,
          )
          .join("")}</select>`,
      )
    : "";
  const groupSelect = groups.length
    ? field(
        `min_${id}`,
        "Group and above",
        `<select class="kb-select" id="min_${id}" name="min_${id}"><option value="">(none)</option>${groups
          .map(
            (g) =>
              `<option value="${escapeHtml(g.id)}"${claim?.minGroupId === g.id ? " selected" : ""}>${escapeHtml(g.name)}</option>`,
          )
          .join("")}</select>`,
      )
    : "";
  const voiceBind =
    c.kind === "category"
      ? `${check(`<input type="checkbox" name="vmo_${id}" value="1"${checked(claim?.voiceManagedOnly)}>`, "If bound as the voice category: also turn on managed-only cleanup (only channels KoolBot created are ever deleted)")}
${check(`<input type="checkbox" name="prefix_${id}" value="1"${checked(claim?.usePrefix)}>`, `If bound as the voice category: use this server's naming prefix${scan.naming.suggestedPrefix ? ` (<code class="kb-mono">${escapeHtml(scan.naming.suggestedPrefix)}</code>)` : " (none detected)"}`)}`
      : "";
  const forumLock = c.flags.forum
    ? check(
        `<input type="checkbox" name="lock_${id}" value="1"${checked(claim?.lockReplies)}>`,
        "Forum: also stop replies inside posts",
      )
    : "";
  const stageSpeakers = c.flags.stage
    ? field(
        `speakers_${id}`,
        "Stage: only these roles may request to speak (gate; they can also join)",
        `<select class="kb-select" id="speakers_${id}" name="speakers_${id}" multiple size="5">${roleOptions(scan, claim?.speakerRoleIds ?? [])}</select>`,
      )
    : "";
  const options = `<details class="kb-disclosure"><summary>${icon("chevron-right", { className: "kb-chev" })}Options</summary><div class="kb-disclosure__body kb-stack">
${field(
  `roles_${id}`,
  "Roles (gate: allowed in; read-only: may still post)",
  `<select class="kb-select" id="roles_${id}" name="roles_${id}" multiple size="5">${roleOptions(scan, claim?.roleIds ?? [])}</select>`,
)}
${stageSpeakers}
${groupSelect}
${check(`<input type="checkbox" name="react_${id}" value="1"${checked(claim?.allowReactions)}>`, "Read-only: members may still react")}
${forumLock}
${check(`<input type="checkbox" name="replace_${id}" value="1"${checked(claim?.approveReplace)}>`, "Sync: I approve replacing the permission overwrites this channel has of its own. The previous ones are saved in the snapshot.")}
${voiceBind}
</div></details>`;
  const isCategory = c.kind === "category";
  return `<tr id="claim-${id}">
<th scope="row"${isCategory ? "" : ' class="kb-tree__child"'}>${isCategory ? `<strong>${namedChannelMention(c.name, c.typeName)}</strong>` : namedChannelMention(c.name, c.typeName)}<div class="kb-muted">${escapeHtml(c.typeName)}</div>${notes(c, feeds, pairing)}</th>
<td><div class="kb-stack">${actionSelect}${bulkSelect}</div></td>
<td>${featureOptions(c, claim?.bindKey ?? "")}</td>
<td>${options}</td>
</tr>`;
}

/**
 * A table inside its Panel: it scrolls there, never the page. `scroll: false`
 * leaves the scroll container out: the pairing table holds the emoji picker,
 * whose popup is absolutely positioned inside the table and would be clipped
 * (scrolled inside a box the height of the table) by an overflow container.
 */
function flushTable(
  caption: string,
  head: string[],
  rows: string,
  scroll = true,
): string {
  const table = `<table class="kb-table"><caption class="kb-visually-hidden">${caption}</caption><thead><tr>${head.map((h) => `<th scope="col">${h}</th>`).join("")}</tr></thead><tbody>${rows}</tbody></table>`;
  return scroll ? `<div class="kb-panel__body--flush">${table}</div>` : table;
}

function renderSuggestions(
  scan: ServerScan,
  props: ClaimsPageProps,
  pairings: RolePairing[],
  feeds: FeedDetection,
): string {
  const claimOf = new Map(props.claims.map((c) => [c.channelId, c]));
  const proposed = pairings.filter((p) => p.state === "proposed");
  const pairRows = pairings
    .map((p) => {
      const cid = escapeHtml(p.categoryId);
      const claim = claimOf.get(p.categoryId);
      const action =
        p.state === "proposed"
          ? `<div class="kb-row">${check(`<input type="checkbox" name="pair_${cid}" value="1"${checked(claim?.registerPairing)}>`, `Register <span class="kb-visually-hidden">${escapeHtml(p.roleName)} for ${escapeHtml(p.categoryName)}</span>`)} <span class="kb-muted">Emoji <span class="kb-visually-hidden">for ${escapeHtml(p.categoryName)}</span></span> ${renderEmojiField(`pairemoji_${p.categoryId}`, claim?.pairEmoji ?? DEFAULT_PAIR_EMOJI, { label: p.categoryName, inputLabel: `Emoji for ${p.categoryName}`, maxLength: 64 })}</div>`
          : `<span class="kb-badge ${p.state === "refused" ? "kb-badge--off" : "kb-badge--on"}">${p.state === "refused" ? "refused" : "already a reaction role"}</span> ${escapeHtml(p.reason ?? "")}`;
      return `<tr><th scope="row">${channelMention({ name: p.categoryName, type: ChannelType.GuildCategory })}</th><td>${roleMention(p.roleName)}</td><td>${action}</td></tr>`;
    })
    .join("");
  const pairing = pairings.length
    ? `<div class="kb-stack">
<h3 class="kb-overline">Game-role categories</h3>
<p class="kb-help">These categories are hidden from @everyone and visible to exactly one role. Registering one makes that role pickable through a new KoolBot picker and keeps the category gated: the role and the category are reused as they are and nothing new is created. A role with powerful permissions (Administrator, Manage Roles and similar) is refused.</p>
${flushTable("Detected game-role categories", ["Category", "Role", "Register"], pairRows, false)}
${proposed.length ? `<div class="kb-row">${check(`<input type="checkbox" name="pairs_all" value="1">`, `Register all ${proposed.length} detected pair${proposed.length === 1 ? "" : "s"} when previewing`)} <span class="kb-muted">Refused pairs are skipped; each one keeps the emoji shown above.</span></div>` : ""}
</div>`
    : "";
  let feedHtml: string;
  if (!feeds.known) {
    feedHtml = callout(
      "warn",
      "status",
      `Webhook data is unavailable${feeds.unavailable === "missing-permission" ? " because KoolBot lacks the Manage Webhooks permission" : " because it could not be read"}.`,
      {
        text: "No feed suggestions are made: this does not mean no channel is fed by a webhook or a followed channel.",
      },
    );
  } else if (feeds.feeds.length === 0) {
    feedHtml = `<p class="kb-help">No channel is fed by a webhook or a followed announcement channel.</p>`;
  } else {
    const byId = new Map(scan.channels.map((c) => [c.id, c]));
    feedHtml = `<p class="kb-help">These channels are fed by a webhook or a followed announcement channel. Making one a feed makes it read-only for everyone (reactions stay open). Its webhooks and follower integrations are never modified or removed.</p>
<div class="kb-panel__body--flush"><ul class="kb-list">${feeds.feeds
      .map((f) => {
        const ch = byId.get(f.channelId);
        const fid = escapeHtml(f.channelId);
        const name = escapeHtml(ch?.name ?? f.channelId);
        const kinds = f.kinds
          .map((k) =>
            k === "channel-follower" ? "followed channel" : "webhook",
          )
          .join(" + ");
        return `<li>${check(`<input type="checkbox" name="feed_${fid}" value="1"${checked(claimOf.get(f.channelId)?.feed)}>`, `Treat <strong>${name}</strong> as a feed`)} <span class="kb-muted">(${escapeHtml(kinds)})</span></li>`;
      })
      .join("")}</ul></div>`;
  }
  return `<section class="kb-panel" aria-labelledby="cc-suggestions">
${panelHead("cc-suggestions", "Suggestions")}
<div class="kb-panel__body kb-stack">
${pairing}
<div class="kb-stack"><h3 class="kb-overline">Feeds</h3>${feedHtml}</div>
</div>
</section>`;
}

function renderForm(props: ClaimsPageProps, csrf: string): string {
  const { scan } = props;
  if (!scan) return "";
  const pairings = detectRolePairings(scan, props.groups);
  const pairingOf = new Map(pairings.map((p) => [p.categoryId, p]));
  const feeds = detectFeeds(scan);
  const byParent = new Map<string | null, ScanChannel[]>();
  for (const c of scan.channels) {
    const list = byParent.get(c.parentId) ?? [];
    list.push(c);
    byParent.set(c.parentId, list);
  }
  const claimOf = new Map(props.claims.map((c) => [c.channelId, c]));
  const sortChannels = (list: ScanChannel[]): ScanChannel[] =>
    list.slice().sort((a, b) => a.position - b.position);
  const categories = sortChannels(
    scan.channels.filter((c) => c.kind === "category"),
  );
  // A channel whose category is not in the scan is listed with the
  // uncategorised ones, as the Server scan tree does, so every channel the scan
  // offers *Claim* on has a row here.
  const categoryIds = new Set(categories.map((c) => c.id));
  const loose = sortChannels(
    scan.channels.filter(
      (c) =>
        c.kind !== "category" &&
        (c.parentId === null || !categoryIds.has(c.parentId)),
    ),
  );
  const rows: string[] = [];
  for (const cat of categories) {
    rows.push(
      claimRow(
        cat,
        scan,
        props.groups,
        claimOf.get(cat.id),
        true,
        feeds,
        pairingOf.get(cat.id),
      ),
    );
    for (const child of sortChannels(byParent.get(cat.id) ?? [])) {
      rows.push(
        claimRow(
          child,
          scan,
          props.groups,
          claimOf.get(child.id),
          false,
          feeds,
          undefined,
        ),
      );
    }
  }
  for (const c of loose) {
    rows.push(
      claimRow(
        c,
        scan,
        props.groups,
        claimOf.get(c.id),
        false,
        feeds,
        undefined,
      ),
    );
  }
  return `<form method="POST" action="/admin/adopt/claims/preview" class="kb-stack">
${csrf}
${renderSuggestions(scan, props, pairings, feeds)}
<section class="kb-panel" aria-labelledby="cc-categories">
${panelHead("cc-categories", "Categories and channels")}
<div class="kb-panel__body"><p class="kb-help">Everything is left alone unless you choose an action. Overwrites for other bots, other roles and members are kept, and unrelated settings on a changed overwrite stay as they are. Webhooks, followed-channel feeds, messages and pins are never touched.</p></div>
${flushTable("Categories and channels", ["Category / channel", "Action", "Feature", "Options"], rows.join(""))}
<footer class="kb-panel__foot"><button type="submit" class="${planCanApply(props) ? "kb-btn" : "kb-btn kb-btn--primary"}">Preview changes</button><span>Nothing is written to Discord yet.</span></footer>
</section>
</form>`;
}

/** True when the page shows a plan whose Apply button is offered (#1512). */
function planCanApply(props: ClaimsPageProps): boolean {
  const { plan } = props;
  return Boolean(
    plan &&
    plan.plan.errors.length === 0 &&
    plan.errors.length === 0 &&
    plan.plan.operations.length > 0 &&
    props.previewToken,
  );
}

/** A list of plan problems or advice as a Callout: each code is a Badge. */
function issueCallout(
  tone: "warn" | "err",
  title: string,
  issues: ClaimsPlan["errors"],
): string {
  const badge = tone === "err" ? "kb-badge--off" : "kb-badge--warn";
  return callout(tone, "status", `${title} (${issues.length})`, {
    textHtml: `<ul>${issues
      .map(
        (i) =>
          `<li><span class="kb-badge ${badge}">${escapeHtml(i.code)}</span> ${escapeHtml(i.message)}</li>`,
      )
      .join("")}</ul>`,
  });
}

function renderPlan(props: ClaimsPageProps, csrf: string): string {
  const { plan } = props;
  if (!plan) return "";
  const extra = plan.errors.length
    ? issueCallout("err", "Needs attention", plan.errors)
    : "";
  const advice = plan.warnings.length
    ? issueCallout("warn", "Worth knowing", plan.warnings)
    : "";
  const applicable =
    plan.plan.errors.length === 0 &&
    plan.errors.length === 0 &&
    plan.plan.operations.length > 0;
  const form =
    applicable && props.previewToken
      ? `<div class="kb-panel__body"><form method="POST" action="/admin/adopt/claims/apply" class="kb-stack" data-confirm="Apply this plan to Discord? A snapshot is saved first so it can be rolled back."${CONFIRM_NEUTRAL_ATTR}>${csrf}<input type="hidden" name="planId" value="${escapeHtml(plan.plan.id)}"><input type="hidden" name="token" value="${escapeHtml(props.previewToken)}">${renderDestructiveConfirm(plan.plan)}<div class="kb-row"><button type="submit" class="kb-btn kb-btn--primary">Apply plan</button><span class="kb-muted">A snapshot of everything touched is saved first.</span></div></form></div>`
      : "";
  const issues =
    extra || advice
      ? `<div class="kb-panel__body kb-stack">${extra}${advice}</div>`
      : "";
  // The diff keeps its own markup (#1715); the flush body is its scroll
  // container, so a wide plan table never scrolls the page.
  return `${issues}<div class="kb-panel__body--flush">${renderAdoptionDiff(plan.plan)}</div>${form}`;
}

export const JOB_SCRIPT = (jobId: string): string =>
  `(function(){var id=${JSON.stringify(jobId)};var el=document.getElementById('cc-job');` +
  "function tick(){fetch('/admin/role-groups/job/'+encodeURIComponent(id),{credentials:'same-origin'})" +
  ".then(function(r){return r.json()}).then(function(j){" +
  "el.textContent=j.text;if(j.status==='running'){setTimeout(tick,1500)}else{setTimeout(function(){location.href='/admin/adopt/claims'},1500)}})" +
  ".catch(function(){el.textContent='Lost contact with the bot; reload to see the result.'})}tick()})();";

export function renderChannelClaimsPage(props: ClaimsPageProps): string {
  const csrf = `<input type="hidden" name="_csrf" value="${escapeHtml(props.csrfToken)}">`;
  // `JOB_SCRIPT` sets the text of #cc-job, so the id sits on the Callout's title.
  const job = props.jobId
    ? callout("", "status", "Applying…", { titleId: "cc-job" })
    : "";
  const prefill = props.prefill
    ? callout(
        "",
        "status",
        `Prefilled from the Server scan: <strong>${namedChannelMention(props.prefill.channelName, props.prefill.channelTypeName)}</strong> is set to be bound to <strong>${escapeHtml(props.prefill.featureLabel)}</strong>.`,
        { text: "Nothing changes until you preview the plan and apply it." },
      )
    : "";
  const problems = props.problems.length
    ? callout(
        "warn",
        "status",
        props.problems.map((p) => escapeHtml(p)).join(" "),
      )
    : "";
  const content = props.scan
    ? `${renderForm(props, csrf)}
<section class="kb-panel" aria-labelledby="cc-plan">
  ${panelHead("cc-plan", "Plan")}
  <div class="kb-panel__body"><p class="kb-help">What applying would change in Discord and in KoolBot's settings. Steps that replace existing permissions are listed as destructive, run last, and only appear when you approved them.</p>${props.plan ? "" : `<p class="kb-help">Choose actions above and preview them.</p>`}</div>
  ${props.plan ? renderPlan(props, csrf) : ""}
</section>`
    : callout(
        "err",
        "alert",
        `The scan failed: ${escapeHtml(props.error ?? "unknown error")}.`,
        { text: "Check that the bot is in the server, then reload." },
      );
  const body = `<div class="kb-stack">
<header class="kb-pagehead">
  <div class="kb-pagehead__text">
    <h1 class="kb-pagehead__title">Channel Claims</h1>
    <p class="kb-pagehead__sub">Take over existing categories and channels: make them read-only, gate them to groups, sync them with their category, or bind them to a KoolBot feature. See <a href="/admin/adopt">Server Scan</a> for what is there now.</p>
  </div>
</header>
${renderFlash(props.flash)}
${job}
${prefill}
${problems}
${content}
</div>
${props.jobId ? `${scriptTag(JOB_SCRIPT(props.jobId))}` : ""}
`;
  return renderAdminPage({
    title: "Channel Claims",
    active: "/admin/adopt/claims",
    body,
    csrfToken: props.csrfToken,
    remainingMs: props.remainingMs,
    navFeatureStatus: props.navFeatureStatus,
  });
}
