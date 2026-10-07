import {
  escapeHtml,
  renderAdminPage,
  type NavFeatureStatus,
} from "./admin-layout.js";
import { renderFlash, type FlashMessage } from "./admin-views.js";
import { renderAdoptionDiff } from "./adoption-diff.js";
import {
  CLAIM_ACTIONS,
  FEATURE_TARGETS,
  type ChannelClaim,
  type ClaimAction,
} from "../services/channel-claims.js";
import type { ClaimsPlan } from "../services/channel-claims-adoption.js";
import type {
  ServerScan,
  ScanChannel,
} from "../services/server-scan-service.js";
import type { RoleGroupView } from "../services/role-group-service.js";

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
  /** Approval stamp the preview used; the apply step must reuse it. */
  approvedAt: string | null;
  jobId?: string | null;
  flash?: FlashMessage | null;
}

const checked = (v: boolean | undefined): string => (v ? " checked" : "");

function featureOptions(channel: ScanChannel, selected: string): string {
  const fits = FEATURE_TARGETS.filter((f) =>
    f.kind === "category"
      ? channel.kind === "category"
      : f.kind === "voice"
        ? channel.kind === "voice" && !channel.flags.stage
        : channel.kind === "text" && !channel.flags.forum,
  );
  if (fits.length === 0) return "";
  return `<label>Bind to a feature <select name="bind_${escapeHtml(channel.id)}"><option value="">(none)</option>${fits
    .map(
      (f) =>
        `<option value="${escapeHtml(f.key)}"${f.key === selected ? " selected" : ""}>${escapeHtml(f.label)}</option>`,
    )
    .join("")}</select></label>`;
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
      return `<option value="${escapeHtml(r.id)}"${selected.includes(r.id) ? " selected" : ""}${disabled ? " disabled" : ""}>@${escapeHtml(r.name)}${escapeHtml(note)}</option>`;
    })
    .join("");
}

function notes(c: ScanChannel): string {
  const out: string[] = [];
  if (c.usedBy.length) out.push(`used by ${c.usedBy.join(", ")}`);
  if (c.flags.webhookFed || c.flags.followed)
    out.push("news feed: read-only is suggested; webhooks are never touched");
  if (c.gatedByRoleIds.length) out.push("already gated by a role");
  if (c.flags.rules || c.flags.system || c.flags.publicUpdates)
    out.push("a Discord community channel");
  if (c.syncedToParent === false) out.push("own permissions");
  return out.length
    ? `<div class="muted">${escapeHtml(out.join("; "))}</div>`
    : "";
}

function claimRow(
  c: ScanChannel,
  scan: ServerScan,
  groups: RoleGroupView[],
  claim: ChannelClaim | undefined,
  bulk: boolean,
): string {
  const id = escapeHtml(c.id);
  const action = claim?.action ?? "leave";
  const actionSelect = `<select name="action_${id}" aria-label="Action for ${escapeHtml(c.name)}">${CLAIM_ACTIONS.filter(
    (a) => a !== "sync" || c.parentId !== null,
  )
    .map(
      (a) =>
        `<option value="${a}"${a === action ? " selected" : ""}>${escapeHtml(ACTION_LABELS[a])}</option>`,
    )
    .join("")}</select>`;
  const bulkSelect = bulk
    ? `<label>For every channel here left alone <select name="bulk_${id}"><option value="">(no change)</option>${CLAIM_ACTIONS.filter(
        (a) => a !== "leave",
      )
        .map(
          (a) =>
            `<option value="${a}">${escapeHtml(ACTION_LABELS[a])}</option>`,
        )
        .join("")}</select></label>`
    : "";
  const groupSelect = groups.length
    ? `<label>Group and above <select name="min_${id}"><option value="">(none)</option>${groups
        .map(
          (g) =>
            `<option value="${escapeHtml(g.id)}"${claim?.minGroupId === g.id ? " selected" : ""}>${escapeHtml(g.name)}</option>`,
        )
        .join("")}</select></label>`
    : "";
  const voiceBind =
    c.kind === "category"
      ? `<label class="check"><input type="checkbox" name="vmo_${id}" value="1"${checked(claim?.voiceManagedOnly)}> If bound as the voice category: also turn on managed-only cleanup (only channels KoolBot created are ever deleted)</label>
<label class="check"><input type="checkbox" name="prefix_${id}" value="1"${checked(claim?.usePrefix)}> If bound as the voice category: use this server's naming prefix${scan.naming.suggestedPrefix ? ` (<code>${escapeHtml(scan.naming.suggestedPrefix)}</code>)` : " (none detected)"}</label>`
      : "";
  const forumLock = c.flags.forum
    ? `<label class="check"><input type="checkbox" name="lock_${id}" value="1"${checked(claim?.lockReplies)}> Forum: also stop replies inside posts</label>`
    : "";
  const options = `<details><summary>Options</summary><div class="stack">
<label>Roles (gate: allowed in; read-only: may still post) <select name="roles_${id}" multiple size="5">${roleOptions(scan, claim?.roleIds ?? [])}</select></label>
${groupSelect}
<label class="check"><input type="checkbox" name="react_${id}" value="1"${checked(claim?.allowReactions)}> Read-only: members may still react</label>
${forumLock}
<label class="check"><input type="checkbox" name="replace_${id}" value="1"${checked(claim?.approveReplace)}> Sync: I approve replacing the permission overwrites this channel has of its own. The previous ones are saved in the snapshot.</label>
${voiceBind}
</div></details>`;
  return `<tr>
<td>${c.kind === "category" ? `<strong>${escapeHtml(c.name)}</strong>` : `<span aria-hidden="true">&nbsp;&nbsp;</span>${escapeHtml(c.name)}`}<div class="muted">${escapeHtml(c.typeName)}</div>${notes(c)}</td>
<td>${actionSelect}${bulkSelect}</td>
<td>${featureOptions(c, claim?.bindKey ?? "")}</td>
<td>${options}</td>
</tr>`;
}

function renderForm(props: ClaimsPageProps, csrf: string): string {
  const { scan } = props;
  if (!scan) return "";
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
  const loose = sortChannels(
    (byParent.get(null) ?? []).filter((c) => c.kind !== "category"),
  );
  const rows: string[] = [];
  for (const cat of categories) {
    rows.push(claimRow(cat, scan, props.groups, claimOf.get(cat.id), true));
    for (const child of sortChannels(byParent.get(cat.id) ?? [])) {
      rows.push(
        claimRow(child, scan, props.groups, claimOf.get(child.id), false),
      );
    }
  }
  for (const c of loose) {
    rows.push(claimRow(c, scan, props.groups, claimOf.get(c.id), false));
  }
  return `<form method="POST" action="/admin/adopt/claims/preview" class="stack">
${csrf}
<table><caption class="visually-hidden">Categories and channels</caption><thead><tr><th scope="col">Category / channel</th><th scope="col">Action</th><th scope="col">Feature</th><th scope="col">Options</th></tr></thead><tbody>${rows.join("")}</tbody></table>
<button type="submit" class="btn btn-primary">Preview changes</button>
<span class="muted">Nothing is written to Discord yet.</span>
</form>`;
}

function renderPlan(props: ClaimsPageProps, csrf: string): string {
  const { plan } = props;
  if (!plan) return "";
  const extra = plan.errors.length
    ? `<div class="card adoption-issues blockers"><h3>Needs attention (${plan.errors.length})</h3><ul>${plan.errors
        .map(
          (i) =>
            `<li><span class="tag tag-off">${escapeHtml(i.code)}</span> ${escapeHtml(i.message)}</li>`,
        )
        .join("")}</ul></div>`
    : "";
  const advice = plan.warnings.length
    ? `<div class="card adoption-issues warnings"><h3>Worth knowing (${plan.warnings.length})</h3><ul>${plan.warnings
        .map(
          (i) =>
            `<li><span class="tag tag-warn">${escapeHtml(i.code)}</span> ${escapeHtml(i.message)}</li>`,
        )
        .join("")}</ul></div>`
    : "";
  const applicable =
    plan.plan.errors.length === 0 &&
    plan.errors.length === 0 &&
    plan.plan.operations.length > 0;
  const form =
    applicable && props.approvedAt
      ? `<form method="POST" action="/admin/adopt/claims/apply" onsubmit="return confirm('Apply this plan to Discord? A snapshot is saved first so it can be rolled back.');">${csrf}<input type="hidden" name="planId" value="${escapeHtml(plan.plan.id)}"><input type="hidden" name="at" value="${escapeHtml(props.approvedAt)}"><input type="hidden" name="payload" value="${escapeHtml(JSON.stringify(props.claims))}"><button type="submit" class="btn btn-primary">Apply plan</button> <span class="muted">A snapshot of everything touched is saved first.</span></form>`
      : "";
  return `${extra}${advice}${renderAdoptionDiff(plan.plan)}${form}`;
}

const JOB_SCRIPT = (jobId: string): string =>
  `(function(){var id=${JSON.stringify(jobId)};var el=document.getElementById('cc-job');` +
  "function tick(){fetch('/admin/role-groups/job/'+encodeURIComponent(id),{credentials:'same-origin'})" +
  ".then(function(r){return r.json()}).then(function(j){" +
  "el.textContent=j.text;if(j.status==='running'){setTimeout(tick,1500)}else{setTimeout(function(){location.href='/admin/adopt/claims'},1500)}})" +
  ".catch(function(){el.textContent='Lost contact with the bot; reload to see the result.'})}tick()})();";

export function renderChannelClaimsPage(props: ClaimsPageProps): string {
  const csrf = `<input type="hidden" name="_csrf" value="${escapeHtml(props.csrfToken)}">`;
  const job = props.jobId
    ? `<div class="notice" id="cc-job" role="status">Applying…</div>`
    : "";
  const problems = props.problems.length
    ? `<div class="notice warn" role="status">${props.problems.map((p) => escapeHtml(p)).join(" ")}</div>`
    : "";
  const content = props.scan
    ? `<div class="card">
  <h2>Categories and channels</h2>
  <p class="muted">Everything is left alone unless you choose an action. Overwrites for other bots, other roles and members are kept, and unrelated settings on a changed overwrite stay as they are. Webhooks, followed-channel feeds, messages and pins are never touched.</p>
  ${renderForm(props, csrf)}
</div>
<div class="card">
  <h2>Plan</h2>
  <p class="muted">What applying would change in Discord and in KoolBot's settings. Steps that replace existing permissions are listed as destructive, run last, and only appear when you approved them.</p>
  ${props.plan ? renderPlan(props, csrf) : `<p class="muted">Choose actions above and preview them.</p>`}
</div>`
    : `<div class="notice err">The scan failed: ${escapeHtml(props.error ?? "unknown error")}. Check that the bot is in the server, then reload.</div>`;
  const body = `
<h1>Channel Claims</h1>
<p class="subtitle">Take over existing categories and channels: make them read-only, gate them to groups, sync them with their category, or bind them to a KoolBot feature. See <a href="/admin/adopt">Server Scan</a> for what is there now.</p>
${renderFlash(props.flash)}
${job}
${problems}
${content}
${props.jobId ? `<script>${JOB_SCRIPT(props.jobId)}</script>` : ""}
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
