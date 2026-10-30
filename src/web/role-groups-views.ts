import { PermissionsBitField } from "discord.js";
import { CONFIRM_NEUTRAL_ATTR, confirmListAttr, scriptTag } from "./html.js";
import {
  escapeHtml,
  renderAdminPage,
  type NavFeatureStatus,
} from "./admin-layout.js";
import {
  renderColourField,
  renderFlash,
  type FlashMessage,
} from "./admin-views.js";
import { formView, type FormView, type RefusedForm } from "./form-errors.js";
import { renderAdoptionDiff } from "./adoption-diff.js";
import { roleMention } from "./discord-labels.js";
import {
  renderPermissionNotice,
  type PermissionNotice,
} from "./permission-notice.js";
import {
  formatColour,
  PERMISSION_PRESETS,
} from "../services/role-group-plan.js";
import {
  ROLE_GROUP_CAPABILITIES,
  capabilityLabel,
  ROLE_GROUP_SYNC_POLICIES,
} from "../models/role-group.js";
import {
  resolvePolicy,
  type AdminReport,
  type DriftItem,
} from "../services/role-group-sync.js";
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
  /** Differences from the Discord role (#1021). */
  drift: DriftItem[];
}

export interface RoleGroupRoleOption {
  id: string;
  name: string;
  memberCount: number | null;
  lock: RoleLock | null;
  /** Already backs a group. */
  taken: boolean;
  /** Features that hold the role (leaderboard, reaction roles, birthdays). */
  usedBy?: string[];
}

export interface RoleGroupsPageProps {
  csrfToken: string;
  remainingMs: number;
  navFeatureStatus?: NavFeatureStatus;
  /** What the bot lacks for Manage Roles and the log channel (#1490). Null: nothing to say. */
  permissionNotice?: PermissionNotice | null;
  groups: RoleGroupRow[];
  roleOptions: RoleGroupRoleOption[];
  plan: AdoptionPlan | null;
  extraErrors: PlanIssue[];
  /** Why no plan could be built (e.g. Discord unreachable). */
  planUnavailable?: string | null;
  botScanUnavailable: boolean;
  /** Bots in the guild that do not hold a bot group's role. */
  botsMissing: number;
  /** Administrators outside the admin group; `null` = report skipped (#1021). */
  adminReport: AdminReport | null;
  /** The admin group's role doesn't carry Administrator (drift). */
  adminGroupLacksAdministrator: boolean;
  /** An admin group exists but the member list couldn't be read. */
  membersUnavailable: boolean;
  /** Role id to name, for the administrator report. */
  roleNames: Record<string, string>;
  /** `adoption.role_groups.sync_policy`. */
  globalPolicy: string;
  /** Id of a running/finished apply the page should report on. */
  jobId?: string | null;
  /** The create or edit form the last save refused (#1523). */
  refusedForm?: RefusedForm | null;
  flash?: FlashMessage | null;
}

/** Form id of the Add group form (#1523). */
export const ROLE_GROUP_CREATE_FORM = "role-group-create";

/** Form id of one group's Edit form (#1523). */
export const roleGroupEditForm = (groupId: string): string =>
  `role-group-edit-${groupId}`;

/**
 * The key a ticked capability or permission box has in a refused form's values
 * (`capability-admin`, `perm-BanMembers`): the submission is a list, a form
 * view holds one string per name.
 */
export const roleGroupBoxKey = (
  kind: "capability" | "perm",
  value: string,
): string => `${kind}-${value}`;

const PERMISSION_NAMES = Object.keys(PermissionsBitField.Flags);

function permissionChecks(bits: string | null, f: FormView): string {
  const set = new PermissionsBitField(BigInt(bits ?? "0"));
  return PERMISSION_NAMES.map((name) => {
    const flag = PermissionsBitField.Flags[
      name as keyof typeof PermissionsBitField.Flags
    ] as bigint;
    const on = f.checked(roleGroupBoxKey("perm", name), set.has(flag));
    return `<label class="check"><input type="checkbox" name="perm" value="${escapeHtml(name)}"${on ? " checked" : ""}> ${escapeHtml(name)}</label>`;
  }).join(" ");
}

function capabilityChecks(
  caps: readonly string[],
  disabled: boolean,
  f: FormView,
): string {
  return ROLE_GROUP_CAPABILITIES.map((c, i) => {
    const on = f.checked(roleGroupBoxKey("capability", c), caps.includes(c));
    // The error belongs to the group of boxes; the first box carries it.
    const refused = i === 0 ? f.attrs("capability") : "";
    return `<label class="check"><input type="checkbox" name="capability" value="${c}"${on ? " checked" : ""}${disabled ? " disabled" : ""}${refused}> ${escapeHtml(capabilityLabel(c))}</label>`;
  }).join(" ");
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

const POLICY_LABELS: Record<string, string> = {
  flag: "Flag only",
  adopt: "Adopt (group follows Discord)",
  enforce: "Enforce (re-apply the group)",
};

function driftCell(g: RoleGroupRow): string {
  if (g.drift.length === 0) return "";
  return `<ul class="drift">${g.drift
    .map(
      (d) =>
        `<li><span class="tag tag-warn">${escapeHtml(d.kind)}</span> ${escapeHtml(d.detail)}</li>`,
    )
    .join("")}</ul>`;
}

function relinkForm(
  g: RoleGroupRow,
  csrf: string,
  options: RoleGroupRoleOption[],
): string {
  const choices = options
    // A gate-only group links an integration-managed role; any other group
    // an editable one (the same rule the POST handler enforces).
    .filter(
      (r) =>
        (g.gateOnly ? r.lock === "managed" : r.lock === null) &&
        !r.taken &&
        !r.usedBy?.length,
    )
    .map(
      (r) =>
        `<option value="${escapeHtml(r.id)}">@${escapeHtml(r.name)}</option>`,
    )
    .join("");
  const recreate = g.gateOnly
    ? ""
    : `<form method="POST" action="/admin/role-groups/${escapeHtml(g.id)}/relink" class="inline-form">${csrf}<input type="hidden" name="mode" value="recreate"><button type="submit" class="btn">Create a new role</button></form>`;
  return `<div class="notice warn" role="status"><strong>Unlinked:</strong> the Discord role${(g.lostRoleId ?? g.roleId) ? ` <span class="mono">${escapeHtml(g.lostRoleId ?? g.roleId ?? "")}</span>` : ""} was deleted. KoolBot does not recreate it on its own.
${recreate}
<form method="POST" action="/admin/role-groups/${escapeHtml(g.id)}/relink" class="inline-form">${csrf}<input type="hidden" name="mode" value="link"><label>Link another role <select name="roleId" required><option value="">Choose…</option>${choices}</select></label> <button type="submit" class="btn">Link</button></form></div>`;
}

function roleCell(g: RoleGroupRow): string {
  if (g.unlinked) {
    return `<span class="tag tag-warn">unlinked: role deleted</span>`;
  }
  if (g.roleId === null) {
    return `<span class="tag tag-info">new role — created on apply</span>`;
  }
  const name = g.roleName ? roleMention(g.roleName) : "";
  const badges = [
    g.roleMissing ? `<span class="tag tag-warn">role not found</span>` : "",
    g.gateOnly ? `<span class="tag tag-info">gate-only</span>` : "",
    g.roleLock
      ? `<span class="tag tag-warn">locked: ${escapeHtml(ROLE_LOCK_LABELS[g.roleLock])}</span>`
      : "",
  ].join(" ");
  return `${name} <span class="mono muted">${escapeHtml(g.roleId)}</span> ${badges}`;
}

function editForm(
  g: RoleGroupRow,
  csrf: string,
  globalPolicy: string,
  refused?: RefusedForm | null,
): string {
  const f = formView(refused, roleGroupEditForm(g.id));
  const locked = g.gateOnly || g.roleLock !== null;
  return `<details${f.open()}><summary>Edit</summary>
<form method="POST" action="/admin/role-groups/${escapeHtml(g.id)}/edit" class="stack">
${csrf}
<label>Name <input type="text" name="name" value="${escapeHtml(f.value("name", g.name))}" maxlength="100" required${f.attrs("name")}></label>${f.error("name")}
<fieldset><legend>Capabilities</legend>${capabilityChecks(g.capabilities, g.gateOnly, f)}${f.error("capability")}
<p class="muted">Features ask for capabilities instead of role ids. <strong>Admin</strong> also counts as <strong>Moderator</strong> and <strong>Event host</strong>. <strong>Event host</strong> lets members open the host panel of events they created, from <code>/me</code>; <strong>Moderator</strong> opens the moderation pages in <code>/me</code>; neither opens the admin console. <strong>Bot</strong> groups only ever match bot accounts.</p></fieldset>
${
  locked
    ? `<p class="muted">The role is ${g.gateOnly ? "integration-managed" : "locked"}, so its permissions and colour are not edited.</p>`
    : `${presetSelect()}
<fieldset><legend>Permissions${g.permissions === null ? " (currently left as they are)" : ""}</legend>
<label class="check"><input type="checkbox" name="editPermissions" value="1"${f.checked("editPermissions", g.permissions !== null) ? " checked" : ""}> Set the role's permissions to the selection below</label>
${permissionChecks(g.permissions, f)}</fieldset>
${renderColourField(f, "colour", "Colour", formatColour(g.colour), "Leave as it is")}`
}
<label>When its Discord role changes <select name="syncPolicy">${syncPolicyOptions(g.syncPolicy, globalPolicy, f)}</select></label>
<button type="submit" class="btn btn-primary">Save group</button>
</form></details>`;
}

/** The options of the sync-policy select; a refused form keeps the chosen one. */
function syncPolicyOptions(
  stored: string | null,
  globalPolicy: string,
  f: FormView,
): string {
  const chosen = f.selected("syncPolicy", stored ?? "");
  return `<option value=""${chosen === "" ? " selected" : ""}>Use the global setting (${escapeHtml(POLICY_LABELS[resolvePolicy({ syncPolicy: null }, globalPolicy)] ?? globalPolicy)})</option>${ROLE_GROUP_SYNC_POLICIES.map(
    (p) =>
      `<option value="${p}"${chosen === p ? " selected" : ""}>${escapeHtml(POLICY_LABELS[p])}</option>`,
  ).join("")}`;
}

function deleteForm(g: RoleGroupRow, csrf: string): string {
  const canDeleteRole = g.roleId !== null && !g.roleMissing && !g.gateOnly;
  // Deleting the Discord role too is a separate, reviewed step (#1184): the
  // link opens the plan preview, where the role is deleted only after its
  // name is typed.
  const roleOption = canDeleteRole
    ? `<p><a class="btn btn-danger" href="/admin/role-groups/${escapeHtml(g.id)}/delete-role">Review deleting the group and its Discord role…</a></p>`
    : "";
  return `<details><summary>Delete</summary>
<form method="POST" action="/admin/role-groups/${escapeHtml(g.id)}/delete" class="stack">
${csrf}
<input type="hidden" name="roleAction" value="keep">
<p class="muted">Removes the group and keeps its Discord role.</p>
<button type="submit" class="btn btn-danger">Delete group, keep role</button>
</form>
${roleOption}</details>`;
}

/** How long a role-deletion review can be applied after it was shown. */
export const ROLE_DELETE_REVIEW_MINUTES = 15;

export interface RoleDeletePageProps {
  csrfToken: string;
  remainingMs: number;
  navFeatureStatus?: NavFeatureStatus;
  groupId: string;
  groupName: string;
  plan: AdoptionPlan;
  extraErrors: PlanIssue[];
  /** Fixed at preview time and sent back on apply, so the plan id matches. */
  approvedAt: string;
  /** Server-issued MAC over session, group, plan id and stamp; null = none can be issued. */
  reviewToken: string | null;
  /** Name to type to confirm; null when the plan has no role delete step. */
  confirmName: string | null;
  /** The role id the delete step targets. */
  roleId: string | null;
  /** How long the review stays valid, in minutes. */
  validForMinutes: number;
}

/** Preview of deleting a group's Discord role, applied by POST (#1184). */
export function renderRoleDeletePage(props: RoleDeletePageProps): string {
  const csrf = `<input type="hidden" name="_csrf" value="${escapeHtml(props.csrfToken)}">`;
  const errors = props.extraErrors.length
    ? `<div class="card adoption-issues blockers"><h3>Needs attention (${props.extraErrors.length})</h3><ul>${props.extraErrors
        .map(
          (i) =>
            `<li><span class="tag tag-off">${escapeHtml(i.code)}</span> ${escapeHtml(i.message)}</li>`,
        )
        .join("")}</ul></div>`
    : "";
  const applicable =
    props.plan.errors.length === 0 &&
    props.extraErrors.length === 0 &&
    props.confirmName !== null &&
    props.reviewToken !== null;
  const form = applicable
    ? `<form method="POST" action="/admin/role-groups/${escapeHtml(props.groupId)}/delete-role/apply" class="stack" data-confirm="Delete this role in Discord and remove the group? A snapshot is saved first, but the role's ID and its member assignments can't be restored."${confirmListAttr(
        [
          "The role is deleted in Discord, so everyone who holds it loses it.",
          "The group is removed from KoolBot.",
          "A snapshot is saved first, but the role's ID and its member assignments cannot be restored.",
        ],
      )}>${csrf}<input type="hidden" name="planId" value="${escapeHtml(props.plan.id)}"><input type="hidden" name="approvedAt" value="${escapeHtml(props.approvedAt)}"><input type="hidden" name="reviewToken" value="${escapeHtml(props.reviewToken ?? "")}">
<p>The role is named exactly (spaces included, ${(props.confirmName ?? "").length} characters):</p>
<pre class="mono">${escapeHtml(props.confirmName ?? "")}</pre>
<p>I understand that deleting this role removes it from every member who holds it. A rollback can recreate a role with the same settings, but not its role ID or its member assignments, so anything that referred to the old ID stays disconnected.</p>
<label>Type the role name to confirm <input type="text" name="confirmName" required autocomplete="off" placeholder="${escapeHtml(props.confirmName ?? "")}"></label>
<button type="submit" class="btn btn-danger">Delete role and group</button> <a class="btn" href="/admin/role-groups">Cancel</a>
<span class="muted">This review is valid for ${props.validForMinutes} minutes. A snapshot is saved first.</span></form>`
    : `<a class="btn" href="/admin/role-groups">Back</a>`;
  const body = `
<h1>Delete group "${escapeHtml(props.groupName)}" and its role</h1>
<p class="subtitle">Review what would change in Discord. Nothing is deleted until you confirm below.</p>
<h2>Plan</h2>
${errors}${renderAdoptionDiff(props.plan)}
<h2>Confirm</h2>
${form}`;
  return renderAdminPage({
    title: "Role Groups",
    active: "/admin/role-groups",
    body,
    csrfToken: props.csrfToken,
    remainingMs: props.remainingMs,
    navFeatureStatus: props.navFeatureStatus,
  });
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
            .map(
              (c) =>
                `<span class="tag tag-info">${escapeHtml(capabilityLabel(c))}</span>`,
            )
            .join(" ")
        : `<span class="muted">none (gating only)</span>`;
      return `<tr>
<td>${i + 1}</td>
<th scope="row"><strong>${escapeHtml(g.name)}</strong></th>
<td>${roleCell(g)}${driftCell(g)}${g.unlinked || g.roleMissing ? relinkForm(g, csrf, props.roleOptions) : ""}</td>
<td>${g.memberCount === null ? `<span class="muted">?</span>` : g.memberCount}</td>
<td>${caps}</td>
<td>${move("up", i === 0)} ${move("down", i === last)}</td>
<td>${editForm(g, csrf, props.globalPolicy, props.refusedForm)} ${deleteForm(g, csrf)}</td>
</tr>`;
    })
    .join("");
  return `<table><thead><tr><th scope="col">Rank</th><th scope="col">Group</th><th scope="col">Role</th><th scope="col">Members</th><th scope="col">Capabilities</th><th scope="col">Order</th><th scope="col"><span class="visually-hidden">Actions</span></th></tr></thead><tbody>${rows}</tbody></table>
<p class="muted">Listed highest first: a group ranks above the ones below it, and role positions in Discord follow this order when applied. Member counts come from Discord without loading every member.</p>`;
}

function renderAddForm(props: RoleGroupsPageProps, csrf: string): string {
  const f = formView(props.refusedForm, ROLE_GROUP_CREATE_FORM);
  const pickedRole = f.selected("roleId", "");
  const options = props.roleOptions
    .map((r) => {
      // The role a refused form submitted stays selectable: a disabled option
      // is not posted, so the retry would create a new role instead of
      // linking this one. The server checks it again and refuses it again.
      const disabled =
        r.id !== pickedRole &&
        (r.lock === "everyone" ||
          r.lock === "hierarchy" ||
          r.taken ||
          !!r.usedBy?.length);
      const usedNote = r.usedBy?.length ? `used by ${r.usedBy.join(", ")}` : "";
      const note = r.taken
        ? ["already a group", usedNote].filter(Boolean).join("; ")
        : usedNote || (r.lock ? ROLE_LOCK_LABELS[r.lock] : "");
      const count =
        r.memberCount === null ? "" : ` · ${r.memberCount} member(s)`;
      return `<option value="${escapeHtml(r.id)}"${disabled ? " disabled" : ""}${r.id === pickedRole ? " selected" : ""}>@${escapeHtml(r.name)}${escapeHtml(count)}${note ? ` — ${escapeHtml(note)}` : ""}</option>`;
    })
    .join("");
  // A refused role that is no longer in the list stays selected too, or the
  // retry would silently create a new role.
  const missingPicked =
    pickedRole && !props.roleOptions.some((r) => r.id === pickedRole)
      ? `<option value="${escapeHtml(pickedRole)}" selected>Role ${escapeHtml(pickedRole)} (not found)</option>`
      : "";
  return `<form method="POST" action="/admin/role-groups/create" class="stack">
${csrf}
<label>Backing role <select name="roleId"${f.attrs("roleId")}><option value="">Create a new role</option>${missingPicked}${options}</select></label>${f.error("roleId")}
<p class="muted">Linking an existing role keeps its members and never changes its permissions unless you edit them. Integration-managed roles (Server Booster, subscriptions) become gate-only groups: they can be used for gating but are never edited.</p>
<label>Name <input type="text" name="name" maxlength="100" placeholder="(a linked role's own name if empty)"${f.valueAttr("name")}${f.attrs("name")}></label>${f.error("name")}
<fieldset><legend>Capabilities</legend>${capabilityChecks([], false, f)}${f.error("capability")}</fieldset>
${presetSelect()}
<fieldset><legend>Permissions (new roles; an existing role is left alone unless you tick below)</legend>
<label class="check"><input type="checkbox" name="editPermissions" value="1"${f.checked("editPermissions") ? " checked" : ""}> Set the role's permissions to the selection below</label>
${permissionChecks(null, f)}</fieldset>
${renderColourField(f, "colour", "Colour", "", "No colour")}
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
    ? `<form method="POST" action="/admin/role-groups/apply" data-confirm="Apply this plan to Discord? A snapshot is saved first so it can be rolled back."${CONFIRM_NEUTRAL_ATTR}>${csrf}<input type="hidden" name="planId" value="${escapeHtml(props.plan.id)}"><button type="submit" class="btn btn-primary">Apply plan</button> <span class="muted">A snapshot of everything touched is saved first.</span></form>`
    : "";
  return `${extra}${bots}${renderAdoptionDiff(props.plan)}${form}`;
}

function renderAdminSync(props: RoleGroupsPageProps): string {
  const roleName = (id: string): string =>
    escapeHtml(props.roleNames[id] ?? id);
  const report = props.adminReport;
  const humans = report?.humans ?? [];
  const grant = props.adminGroupLacksAdministrator
    ? `<fieldset><legend>Give the admin group Administrator</legend>
<label class="check"><input type="checkbox" name="grant" value="1"> Add the Administrator permission to the admin group's role. Everyone holding that role gets it.</label></fieldset>`
    : "";
  const intro = props.adminGroupLacksAdministrator
    ? `<div class="notice warn" role="status">The admin group's role doesn't carry Administrator. That is a choice, not something applied automatically: tick it below and review the plan.</div>`
    : "";
  const unavailable = props.membersUnavailable
    ? `<div class="notice warn" role="status">Other administrators can't be checked: the Server Members intent is off, so the member list is unavailable.</div>`
    : "";
  if (!report && !props.membersUnavailable && !grant) {
    return `<p class="muted">No admin group with a role is defined, so there is nothing to sync. The server owner counts as admin for web sign-in on their own, and nobody is flagged.</p>`;
  }
  const bots = report?.bots.length
    ? `<h3>Bots with Administrator (${report.bots.length})</h3>
<p class="muted">Bots are never counted as out-of-group administrators and are never touched. Consider reducing each to the permissions it actually needs.</p>
<ul>${report.bots
        .map(
          (bot) =>
            `<li>${escapeHtml(bot.name)}${bot.self ? " (KoolBot)" : ""} <span class="muted">via ${bot.viaRoleIds.map(roleName).join(", ")}</span></li>`,
        )
        .join("")}</ul>`
    : "";
  // A role a bot holds Administrator through isn't offered: bots are never
  // touched (the plan refuses it too).
  const botRoles = new Set((report?.bots ?? []).flatMap((b) => b.viaRoleIds));
  const viaRoles = [...new Set(humans.flatMap((h) => h.viaRoleIds))].filter(
    (id) => !botRoles.has(id),
  );
  const fixes =
    humans.length > 0
      ? `<fieldset><legend>Move into the admin group (adds the admin role; removes nothing)</legend>${humans
          .map(
            (h) =>
              `<label class="check"><input type="checkbox" name="move" value="${escapeHtml(h.id)}"> ${escapeHtml(h.name)} <span class="muted">via ${h.viaRoleIds.map(roleName).join(", ")}</span></label>`,
          )
          .join(" ")}</fieldset>
<fieldset><legend>Or drop Administrator from the other role (edits the role for everyone in it)</legend>${viaRoles
          .map(
            (id) =>
              `<label class="check"><input type="checkbox" name="drop" value="${escapeHtml(id)}"> @${roleName(id)}</label>`,
          )
          .join(" ")}
<p class="muted">Integration-managed roles and KoolBot's own role can't be edited. You can't drop a role if that would remove your own Administrator access.</p></fieldset>`
      : "";
  const status =
    report && humans.length === 0
      ? `<p class="muted">Everyone with Administrator is in the admin group (or is the server owner).</p>`
      : humans.length > 0
        ? `<p>${humans.length} member(s) hold Administrator through a role outside the admin group. Choose what to do, then review the plan: nothing is selected for you.</p>`
        : "";
  const form =
    fixes || grant
      ? `<form method="GET" action="/admin/role-groups/admin-fix" class="stack">
${grant}${fixes}
<button type="submit" class="btn">Preview the plan</button>
</form>`
      : "";
  return `${intro}${unavailable}${status}${form}${bots}`;
}

export interface AdminFixPageProps {
  csrfToken: string;
  remainingMs: number;
  navFeatureStatus?: NavFeatureStatus;
  plan: AdoptionPlan;
  extraErrors: PlanIssue[];
  moveIds: string[];
  dropIds: string[];
  /** Give the admin group's role Administrator. */
  grant: boolean;
  /** Names of members who would lose Administrator and were not moved. */
  losing: string[];
}

/** Preview of an out-of-group administrator fix (#1021), applied by POST. */
export function renderAdminFixPage(props: AdminFixPageProps): string {
  const csrf = `<input type="hidden" name="_csrf" value="${escapeHtml(props.csrfToken)}">`;
  const errors = props.extraErrors.length
    ? `<div class="card adoption-issues blockers"><h3>Needs attention (${props.extraErrors.length})</h3><ul>${props.extraErrors
        .map(
          (i) =>
            `<li><span class="tag tag-off">${escapeHtml(i.code)}</span> ${escapeHtml(i.message)}</li>`,
        )
        .join("")}</ul></div>`
    : "";
  const losing = props.losing.length
    ? `<div class="notice warn" role="status">${props.losing.length} member(s) lose Administrator and are not moved into the admin group: ${props.losing.map(escapeHtml).join(", ")}.</div>`
    : "";
  const applicable =
    props.plan.errors.length === 0 &&
    props.extraErrors.length === 0 &&
    props.plan.operations.length > 0;
  const hidden = [
    ...props.moveIds.map(
      (id) => `<input type="hidden" name="move" value="${escapeHtml(id)}">`,
    ),
    ...props.dropIds.map(
      (id) => `<input type="hidden" name="drop" value="${escapeHtml(id)}">`,
    ),
    ...(props.grant ? [`<input type="hidden" name="grant" value="1">`] : []),
  ].join("");
  const form = applicable
    ? `<form method="POST" action="/admin/role-groups/admin-fix/apply" data-confirm="Apply this plan to Discord? A snapshot is saved first so it can be rolled back."${CONFIRM_NEUTRAL_ATTR}>${csrf}${hidden}<input type="hidden" name="planId" value="${escapeHtml(props.plan.id)}"><button type="submit" class="btn btn-primary">Apply plan</button> <a class="btn" href="/admin/role-groups">Back</a></form>`
    : `<a class="btn" href="/admin/role-groups">Back</a>`;
  const body = `
<h1>Administrators outside the admin group</h1>
<p class="subtitle">Review what would change in Discord. Nothing is written until you apply, and a snapshot is saved first.</p>
<h2>Plan</h2>
${errors}${losing}${renderAdoptionDiff(props.plan)}${form}`;
  return renderAdminPage({
    title: "Role Groups",
    active: "/admin/role-groups",
    body,
    csrfToken: props.csrfToken,
    remainingMs: props.remainingMs,
    navFeatureStatus: props.navFeatureStatus,
  });
}

const JOB_SCRIPT = (jobId: string): string =>
  `(function(){var id=${JSON.stringify(jobId)};var el=document.getElementById('rg-job');` +
  "function tick(){fetch('/admin/role-groups/job/'+encodeURIComponent(id),{credentials:'same-origin'})" +
  ".then(function(r){return r.json()}).then(function(j){" +
  "el.textContent=j.text;if(j.status==='running'){setTimeout(tick,1500)}else{setTimeout(function(){location.href='/admin/role-groups'},1500)}})" +
  ".catch(function(){el.textContent='Lost contact with the bot; reload to see the result.'})}tick()})();";

function renderDriftSummary(props: RoleGroupsPageProps): string {
  const drifted = props.groups.filter((g) => g.drift.length > 0 || g.unlinked);
  if (drifted.length === 0) return "";
  return `<div class="notice warn" role="status"><strong>${drifted.length} group(s) differ from Discord.</strong> Sync policy: ${escapeHtml(POLICY_LABELS[props.globalPolicy] ?? props.globalPolicy)}. Changes made in Discord are shown per group below; fix them by applying the plan, or set a group's policy to adopt or enforce.</div>`;
}

export function renderRoleGroupsPage(props: RoleGroupsPageProps): string {
  const csrf = `<input type="hidden" name="_csrf" value="${escapeHtml(props.csrfToken)}">`;
  const job = props.jobId
    ? `<div class="notice" id="rg-job" role="status">Applying…</div>`
    : "";
  const body = `
<h1>Role Groups</h1>
<p class="subtitle">Name the roles that matter on your server (Admin, Mod, VIP, Friends, Bots …), rank them, and let features ask for a capability instead of a role id. Groups are optional.</p>
${renderFlash(props.flash)}
${job}${renderPermissionNotice(props.permissionNotice ?? null, { canLinkToPage: true })}
<div class="card">
  <h2>Groups</h2>
  ${renderGroups(props, csrf)}
</div>
${renderDriftSummary(props)}
<div class="card">
  <h2>Plan</h2>
  <p class="muted">Saving a group only records what you want. This is what applying would change in Discord: nothing is written until you apply, and every apply is snapshotted.</p>
  ${renderPlan(props, csrf)}
</div>
<div class="card">
  <h2>Administrators and the admin group</h2>
  <p class="muted">The group flagged <code>admin</code> carries Discord's Administrator permission. If the role lacks it you can add it below, as a separate choice you review first. Web sign-in accepts either the admin group or Administrator.</p>
  ${renderAdminSync(props)}
</div>
<div class="card">
  <h2>Add a group</h2>
  ${renderAddForm(props, csrf)}
</div>
<p class="muted">The server owner and members with the Administrator permission always count as <code>admin</code>, with or without a group.</p>
${scriptTag(PRESET_SCRIPT)}
${props.jobId ? `${scriptTag(JOB_SCRIPT(props.jobId))}` : ""}
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
