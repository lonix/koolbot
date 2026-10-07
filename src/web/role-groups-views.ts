import { PermissionsBitField } from "discord.js";
import {
  escapeHtml,
  renderAdminPage,
  type NavFeatureStatus,
} from "./admin-layout.js";
import { renderFlash, type FlashMessage } from "./admin-views.js";
import { renderAdoptionDiff } from "./adoption-diff.js";
import {
  formatColour,
  PERMISSION_PRESETS,
} from "../services/role-group-plan.js";
import { ROLE_GROUP_CAPABILITIES } from "../models/role-group.js";
import type { RoleGroupView } from "../services/role-group-service.js";
import type {
  AdoptionPlan,
  PlanIssue,
} from "../services/server-adoption-planner.js";

/**
 * Role Groups admin page (#1020). Groups are the admin's *desired* state; the
 * plan card previews what applying them would change in Discord, and only the
 * Apply button writes (through the adoption engine, snapshotted).
 */

export type RoleLock = "everyone" | "managed" | "hierarchy";

export const ROLE_LOCK_LABELS: Record<RoleLock, string> = {
  everyone: "@everyone can't be a group",
  managed: "managed by an integration",
  hierarchy: "at or above the bot's role",
};

export interface RoleGroupRow extends RoleGroupView {
  roleName: string | null;
  /** The role is gone from Discord. */
  roleMissing: boolean;
  memberCount: number | null;
  roleLock: RoleLock | null;
}

export interface RoleGroupRoleOption {
  id: string;
  name: string;
  memberCount: number | null;
  lock: RoleLock | null;
  /** Already backs a group. */
  taken: boolean;
}

export interface RoleGroupsPageProps {
  csrfToken: string;
  remainingMs: number;
  navFeatureStatus?: NavFeatureStatus;
  groups: RoleGroupRow[];
  roleOptions: RoleGroupRoleOption[];
  plan: AdoptionPlan | null;
  extraErrors: PlanIssue[];
  /** Why no plan could be built (e.g. Discord unreachable). */
  planUnavailable?: string | null;
  botScanUnavailable: boolean;
  /** Bots in the guild that do not hold a bot group's role. */
  botsMissing: number;
  /** Id of a running/finished apply the page should report on. */
  jobId?: string | null;
  flash?: FlashMessage | null;
}

const PERMISSION_NAMES = Object.keys(PermissionsBitField.Flags);

function permissionChecks(bits: string | null): string {
  const set = new PermissionsBitField(BigInt(bits ?? "0"));
  return PERMISSION_NAMES.map((name) => {
    const flag = PermissionsBitField.Flags[
      name as keyof typeof PermissionsBitField.Flags
    ] as bigint;
    return `<label class="check"><input type="checkbox" name="perm" value="${escapeHtml(name)}"${set.has(flag) ? " checked" : ""}> ${escapeHtml(name)}</label>`;
  }).join(" ");
}

function capabilityChecks(caps: readonly string[], disabled: boolean): string {
  return ROLE_GROUP_CAPABILITIES.map(
    (c) =>
      `<label class="check"><input type="checkbox" name="capability" value="${c}"${caps.includes(c) ? " checked" : ""}${disabled ? " disabled" : ""}> ${c}</label>`,
  ).join(" ");
}

const presetSelect = (): string =>
  `<label>Start from a preset <select class="rg-preset"><option value="">(none)</option>${PERMISSION_PRESETS.map(
    (p) =>
      `<option value="${escapeHtml(p.key)}" data-permissions="${escapeHtml(new PermissionsBitField(BigInt(p.permissions)).toArray().join(","))}" data-capabilities="${escapeHtml(p.capabilities.join(","))}">${escapeHtml(p.label)}</option>`,
  ).join("")}</select></label>`;

// Progressive enhancement: a preset ticks its permission and capability boxes
// (and the "set permissions" switch) so the admin can adjust them before saving.
const PRESET_SCRIPT =
  "(function(){document.querySelectorAll('.rg-preset').forEach(function(sel){" +
  "sel.addEventListener('change',function(){var o=sel.selectedOptions[0];if(!o||!o.value)return;" +
  "var f=sel.closest('form');var perms=(o.dataset.permissions||'').split(',');" +
  "var caps=(o.dataset.capabilities||'').split(',');" +
  "f.querySelectorAll('input[name=perm]').forEach(function(c){c.checked=perms.indexOf(c.value)>=0});" +
  "f.querySelectorAll('input[name=capability]').forEach(function(c){if(!c.disabled)c.checked=caps.indexOf(c.value)>=0});" +
  "var sw=f.querySelector('input[name=editPermissions]');if(sw)sw.checked=true})})})();";

function roleCell(g: RoleGroupRow): string {
  if (g.roleId === null) {
    return `<span class="tag tag-info">new role — created on apply</span>`;
  }
  const name = g.roleName ? `@${escapeHtml(g.roleName)}` : "";
  const badges = [
    g.roleMissing ? `<span class="tag tag-warn">role not found</span>` : "",
    g.gateOnly ? `<span class="tag tag-info">gate-only</span>` : "",
    g.roleLock
      ? `<span class="tag tag-warn">locked: ${escapeHtml(ROLE_LOCK_LABELS[g.roleLock])}</span>`
      : "",
  ].join(" ");
  return `${name} <span class="mono muted">${escapeHtml(g.roleId)}</span> ${badges}`;
}

function editForm(g: RoleGroupRow, csrf: string): string {
  const locked = g.gateOnly || g.roleLock !== null;
  return `<details><summary>Edit</summary>
<form method="POST" action="/admin/role-groups/${escapeHtml(g.id)}/edit" class="stack">
${csrf}
<label>Name <input type="text" name="name" value="${escapeHtml(g.name)}" maxlength="100" required></label>
<fieldset><legend>Capabilities</legend>${capabilityChecks(g.capabilities, g.gateOnly)}
<p class="muted">Features ask for capabilities instead of role ids. <code>admin</code> also counts as <code>staff</code>. <code>bot</code> groups only ever match bot accounts.</p></fieldset>
${
  locked
    ? `<p class="muted">The role is ${g.gateOnly ? "integration-managed" : "locked"}, so its permissions and colour are not edited.</p>`
    : `${presetSelect()}
<fieldset><legend>Permissions${g.permissions === null ? " (currently left as they are)" : ""}</legend>
<label class="check"><input type="checkbox" name="editPermissions" value="1"${g.permissions !== null ? " checked" : ""}> Set the role's permissions to the selection below</label>
${permissionChecks(g.permissions)}</fieldset>
<label>Colour <input type="text" name="colour" value="${escapeHtml(formatColour(g.colour))}" placeholder="#RRGGBB (empty = leave as is)" maxlength="7"></label>`
}
<button type="submit" class="btn btn-primary">Save group</button>
</form></details>`;
}

function deleteForm(g: RoleGroupRow, csrf: string): string {
  const canDeleteRole = g.roleId !== null && !g.roleMissing && !g.gateOnly;
  const members =
    g.memberCount === null ? "an unknown number of" : String(g.memberCount);
  const roleOption = canDeleteRole
    ? `<label class="check"><input type="radio" name="roleAction" value="delete"> Also delete the Discord role${g.createdByKoolbot ? " (KoolBot created it)" : ""}</label>
${
  g.createdByKoolbot
    ? ""
    : `<label class="check"><input type="checkbox" name="approveRoleDelete" value="1"> I approve deleting <strong>@${escapeHtml(g.roleName ?? g.roleId ?? "")}</strong>, a role that already existed. It removes it from its ${escapeHtml(members)} member(s); that can't be restored.</label>`
}`
    : "";
  return `<details><summary>Delete</summary>
<form method="POST" action="/admin/role-groups/${escapeHtml(g.id)}/delete" class="stack">
${csrf}
<label class="check"><input type="radio" name="roleAction" value="keep" checked> Remove the group and keep the Discord role (default)</label>
${roleOption}
<button type="submit" class="btn btn-danger">Delete group</button>
</form></details>`;
}

function renderGroups(props: RoleGroupsPageProps, csrf: string): string {
  if (props.groups.length === 0) {
    return `<div class="empty">No groups yet. Groups are optional: with none, every feature keeps its current behaviour.</div>`;
  }
  const last = props.groups.length - 1;
  const rows = props.groups
    .map((g, i) => {
      const move = (dir: "up" | "down", disabled: boolean): string =>
        `<form method="POST" action="/admin/role-groups/reorder" class="inline-form">${csrf}<input type="hidden" name="groupId" value="${escapeHtml(g.id)}"><input type="hidden" name="direction" value="${dir}"><button type="submit" class="btn" aria-label="Move ${escapeHtml(g.name)} ${dir}"${disabled ? " disabled" : ""}>${dir === "up" ? "↑" : "↓"}</button></form>`;
      const caps = g.capabilities.length
        ? g.capabilities
            .map((c) => `<span class="tag tag-info">${escapeHtml(c)}</span>`)
            .join(" ")
        : `<span class="muted">none (gating only)</span>`;
      return `<tr>
<td>${i + 1}</td>
<td><strong>${escapeHtml(g.name)}</strong></td>
<td>${roleCell(g)}</td>
<td>${g.memberCount === null ? `<span class="muted">?</span>` : g.memberCount}</td>
<td>${caps}</td>
<td>${move("up", i === 0)} ${move("down", i === last)}</td>
<td>${editForm(g, csrf)} ${deleteForm(g, csrf)}</td>
</tr>`;
    })
    .join("");
  return `<table><thead><tr><th scope="col">Rank</th><th scope="col">Group</th><th scope="col">Role</th><th scope="col">Members</th><th scope="col">Capabilities</th><th scope="col">Order</th><th scope="col"><span class="visually-hidden">Actions</span></th></tr></thead><tbody>${rows}</tbody></table>
<p class="muted">Listed highest first: a group ranks above the ones below it, and role positions in Discord follow this order when applied. Member counts come from Discord without loading every member.</p>`;
}

function renderAddForm(props: RoleGroupsPageProps, csrf: string): string {
  const options = props.roleOptions
    .map((r) => {
      const disabled =
        r.lock === "everyone" || r.lock === "hierarchy" || r.taken;
      const note = r.taken
        ? "already a group"
        : r.lock
          ? ROLE_LOCK_LABELS[r.lock]
          : "";
      const count =
        r.memberCount === null ? "" : ` · ${r.memberCount} member(s)`;
      return `<option value="${escapeHtml(r.id)}"${disabled ? " disabled" : ""}>@${escapeHtml(r.name)}${escapeHtml(count)}${note ? ` — ${escapeHtml(note)}` : ""}</option>`;
    })
    .join("");
  return `<form method="POST" action="/admin/role-groups/create" class="stack">
${csrf}
<label>Backing role <select name="roleId"><option value="">Create a new role</option>${options}</select></label>
<p class="muted">Linking an existing role keeps its members and never changes its permissions unless you edit them. Integration-managed roles (Server Booster, subscriptions) become gate-only groups: they can be used for gating but are never edited.</p>
<label>Name <input type="text" name="name" maxlength="100" placeholder="(a linked role's own name if empty)"></label>
<fieldset><legend>Capabilities</legend>${capabilityChecks([], false)}</fieldset>
${presetSelect()}
<fieldset><legend>Permissions (new roles; an existing role is left alone unless you tick below)</legend>
<label class="check"><input type="checkbox" name="editPermissions" value="1"> Set the role's permissions to the selection below</label>
${permissionChecks(null)}</fieldset>
<label>Colour <input type="text" name="colour" placeholder="#RRGGBB (optional)" maxlength="7"></label>
<button type="submit" class="btn btn-primary">Add group</button>
</form>`;
}

function renderPlan(props: RoleGroupsPageProps, csrf: string): string {
  if (props.planUnavailable) {
    return `<div class="notice warn" role="status">${escapeHtml(props.planUnavailable)}</div>`;
  }
  if (!props.plan) return "";
  const extra = props.extraErrors.length
    ? `<div class="card adoption-issues blockers"><h3>Needs attention (${props.extraErrors.length})</h3><ul>${props.extraErrors
        .map(
          (i) =>
            `<li><span class="tag tag-off">${escapeHtml(i.code)}</span> ${escapeHtml(i.message)}</li>`,
        )
        .join("")}</ul></div>`
    : "";
  const bots = props.botScanUnavailable
    ? `<div class="notice warn" role="status">Bot accounts couldn't be listed (the Server Members intent is off), so no bot-group grants are planned.</div>`
    : props.botsMissing > 0
      ? `<p class="muted">${props.botsMissing} bot(s) are not in the bot group; the plan adds the shared role. Their own managed roles are untouched.</p>`
      : "";
  const applicable =
    props.plan.errors.length === 0 &&
    props.extraErrors.length === 0 &&
    props.plan.operations.length > 0;
  const form = applicable
    ? `<form method="POST" action="/admin/role-groups/apply" onsubmit="return confirm('Apply this plan to Discord? A snapshot is saved first so it can be rolled back.');">${csrf}<input type="hidden" name="planId" value="${escapeHtml(props.plan.id)}"><button type="submit" class="btn btn-primary">Apply plan</button> <span class="muted">A snapshot of everything touched is saved first.</span></form>`
    : "";
  return `${extra}${bots}${renderAdoptionDiff(props.plan)}${form}`;
}

const JOB_SCRIPT = (jobId: string): string =>
  `(function(){var id=${JSON.stringify(jobId)};var el=document.getElementById('rg-job');` +
  "function tick(){fetch('/admin/role-groups/job/'+encodeURIComponent(id),{credentials:'same-origin'})" +
  ".then(function(r){return r.json()}).then(function(j){" +
  "el.textContent=j.text;if(j.status==='running'){setTimeout(tick,1500)}else{setTimeout(function(){location.href='/admin/role-groups'},1500)}})" +
  ".catch(function(){el.textContent='Lost contact with the bot; reload to see the result.'})}tick()})();";

export function renderRoleGroupsPage(props: RoleGroupsPageProps): string {
  const csrf = `<input type="hidden" name="_csrf" value="${escapeHtml(props.csrfToken)}">`;
  const job = props.jobId
    ? `<div class="notice" id="rg-job" role="status">Applying…</div>`
    : "";
  const body = `
<h1>Role Groups</h1>
<p class="subtitle">Name the roles that matter on your server (Admin, Mod, VIP, Friends, Bots …), rank them, and let features ask for a capability instead of a role id. Groups are optional.</p>
${renderFlash(props.flash)}
${job}
<div class="card">
  <h2>Groups</h2>
  ${renderGroups(props, csrf)}
</div>
<div class="card">
  <h2>Plan</h2>
  <p class="muted">Saving a group only records what you want. This is what applying would change in Discord: nothing is written until you apply, and every apply is snapshotted.</p>
  ${renderPlan(props, csrf)}
</div>
<div class="card">
  <h2>Add a group</h2>
  ${renderAddForm(props, csrf)}
</div>
<p class="muted">The server owner and members with the Administrator permission always count as <code>admin</code>, with or without a group.</p>
<script>${PRESET_SCRIPT}</script>
${props.jobId ? `<script>${JOB_SCRIPT(props.jobId)}</script>` : ""}
`;
  return renderAdminPage({
    title: "Role Groups",
    active: "/admin/role-groups",
    body,
    csrfToken: props.csrfToken,
    remainingMs: props.remainingMs,
    navFeatureStatus: props.navFeatureStatus,
  });
}
