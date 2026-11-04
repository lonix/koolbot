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
import { icon, toneIcon, type Tone } from "./icons.js";
import {
  REORDER_SCRIPT,
  REORDER_STATUS_HTML,
  orderToken,
  renderReorderCell,
  reorderListAttrs,
  reorderRowAttrs,
} from "./reorder-view.js";
import {
  formView,
  type FormControlAttrs,
  type FormView,
  type RefusedForm,
} from "./form-errors.js";
import { renderSwitch } from "./setting-controls.js";
import { renderSettingRow } from "./host-settings-rows.js";
import {
  ADMINISTRATOR_FLAG,
  groupPermissionRows,
} from "./role-group-permission-groups.js";
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

/** The page's PageHeader: the title and one line of what the page is for. */
function pageHeader(title: string, sub: string): string {
  return `<header class="kb-pagehead">
  <div class="kb-pagehead__text">
    <h1 class="kb-pagehead__title">${escapeHtml(title)}</h1>
    <p class="kb-pagehead__sub">${escapeHtml(sub)}</p>
  </div>
</header>`;
}

/** A Panel for one topic: title (and a count) in its head, an optional footer note. */
function panel(
  id: string,
  title: string,
  body: string,
  opts: {
    meta?: string;
    flush?: boolean;
    foot?: string;
    danger?: boolean;
    /** Space the body's children (a help line, Callouts, a form). */
    stack?: boolean;
  } = {},
): string {
  const meta = opts.meta
    ? `<span class="kb-panel__meta">${escapeHtml(opts.meta)}</span>`
    : "";
  const foot = opts.foot
    ? `\n  <footer class="kb-panel__foot">${opts.foot}</footer>`
    : "";
  return `<section class="kb-panel${opts.danger ? " kb-panel--danger" : ""}" id="${id}" aria-labelledby="${id}-h">
  <header class="kb-panel__head"><h2 class="kb-panel__title" id="${id}-h">${escapeHtml(title)}</h2>${meta}</header>
  <div class="kb-panel__body${opts.flush ? " kb-panel__body--flush" : ""}">${opts.stack ? `<div class="kb-stack">${body}</div>` : body}</div>${foot}
</section>`;
}

/** An EmptyState: what is missing, and how the area fills up. */
function emptyState(title: string, text: string): string {
  return `<div class="kb-empty"><div class="kb-empty__icon">${icon("users")}</div><p class="kb-empty__title">${escapeHtml(title)}</p><p class="kb-empty__text">${escapeHtml(text)}</p></div>`;
}

/**
 * A Callout. `title` is plain text; `text` and `actions` are HTML the caller
 * has escaped. A failure is an alert, everything else a status.
 */
function callout(o: {
  tone: Tone;
  title: string;
  text?: string;
  actions?: string;
  id?: string;
  wrap?: boolean;
}): string {
  const role = o.tone === "err" ? "alert" : "status";
  const cls = [
    "kb-callout",
    o.tone ? `kb-callout--${o.tone}` : "",
    o.wrap ? "kb-callout--wrap" : "",
  ]
    .filter(Boolean)
    .join(" ");
  const titleId = o.id ? ` id="${escapeHtml(o.id)}"` : "";
  return `<div class="${cls}" role="${role}">${toneIcon(o.tone)}<div class="kb-callout__body"><p class="kb-callout__title"${titleId}>${escapeHtml(o.title)}</p>${o.text ? `<p class="kb-callout__text">${o.text}</p>` : ""}</div>${o.actions ? `<div class="kb-callout__actions">${o.actions}</div>` : ""}</div>`;
}

/** The plan's blocking problems that the plan itself does not list: one error Callout, a code badge and a message each. */
function issuesCallout(issues: PlanIssue[]): string {
  if (issues.length === 0) return "";
  const items = issues
    .map(
      (i) =>
        `<li><span class="kb-badge kb-badge--off">${escapeHtml(i.code)}</span> ${escapeHtml(i.message)}</li>`,
    )
    .join("");
  return `<div class="kb-callout kb-callout--err" role="alert">${toneIcon("err")}<div class="kb-callout__body"><p class="kb-callout__title">Needs attention (${issues.length})</p><div class="kb-callout__text"><ul>${items}</ul></div></div></div>`;
}

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

/** The list the move form names: one rank list per server (#1616). */
export const ROLE_GROUP_REORDER_SCOPE = "role-groups";

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

/** The attributes of a Field's control from a form view (id, and the error link when refused). */
function controlAttrs(c: FormControlAttrs): string {
  return ` id="${escapeHtml(c.id)}"${
    c.invalid
      ? ` aria-invalid="true" aria-describedby="${escapeHtml(c.describedBy ?? "")}"`
      : c.describedBy
        ? ` aria-describedby="${escapeHtml(c.describedBy)}"`
        : ""
  }`;
}

/**
 * The line under each capability: the Access step's own text
 * (`wizard-access-view.ts`) where it has one, and the form's existing
 * sentence for the Bot capability.
 */
const CAPABILITY_LINES: Record<string, string> = {
  admin: "Change every setting and run the setup wizard",
  staff: "Read the moderation log and cases in the Web UI",
  host: "Run the host panel: teams, moves, clan tags",
  bot: "Only ever matches bot accounts",
};

const ADMINISTRATOR_CALLOUT = `<div class="kb-callout kb-callout--warn"><div class="kb-callout__body"><p class="kb-callout__title">Administrator gives every other permission as well.</p><p class="kb-callout__text">A role that has it can do everything on the server, and channel permissions no longer limit it. Switch it on only when that is the point.</p></div></div>`;

/**
 * The Switch rows of the Discord permissions, in the groups of Discord's role
 * editor (#1615). Every group is `open` in the markup, so without JavaScript
 * nothing is hidden; `PRESET_SCRIPT` folds the groups with nothing on. A refused
 * form keeps them all open (`data-keep-open`) so focus can reach any control.
 */
function permissionSettings(bits: string | null, f: FormView): string {
  // `has(bit, false)`: a stored Administrator bit must not tick every other switch
  // (`has` answers true for all of them otherwise), or saving would grant them all.
  const set = new PermissionsBitField(BigInt(bits ?? "0"));
  return groupPermissionRows()
    .map((group) => {
      let onCount = 0;
      const rows = group.rows.map((r) => {
        const on = f.checked(
          roleGroupBoxKey("perm", r.key),
          set.has(r.bit, false),
        );
        if (on) onCount += 1;
        const rowId = f.id(`perm-${r.key}`);
        const row = renderSettingRow({
          id: rowId,
          name: r.name,
          line: "",
          control: renderSwitch("perm", on, {
            id: `${rowId}-input`,
            labelledBy: `${rowId}-name`,
            onValue: r.key,
          }),
        });
        return r.key === ADMINISTRATOR_FLAG
          ? `${ADMINISTRATOR_CALLOUT}\n${row}`
          : row;
      });
      return `<details class="kb-disclosure" data-perm-group="${escapeHtml(group.key)}"${f.refused ? " data-keep-open" : ""} open><summary>${icon("chevron-right", { className: "kb-chev" })}${escapeHtml(group.title)}<span class="rg-perm-count">, ${onCount > 0 ? `${onCount} on` : "none on"}</span></summary>
<div class="kb-disclosure__body"><div class="kb-settings__group">
${rows.join("\n")}
</div></div></details>`;
    })
    .join("\n");
}

/**
 * The Capabilities rows: a SettingRow with a Switch each. A gate-only group's
 * switches are disabled, and `help` (HTML) says why beside them.
 */
function capabilitySettings(
  caps: readonly string[],
  gateOnly: boolean,
  f: FormView,
  help: string,
): string {
  const titleId = `${f.id("capabilities")}-title`;
  const helpId = `${f.id("capability")}-help`;
  const rows = ROLE_GROUP_CAPABILITIES.map((c, i) => {
    const rowId = f.id(`capability-${c}`);
    const on = f.checked(roleGroupBoxKey("capability", c), caps.includes(c));
    const describedBy = [`${rowId}-desc`, help ? helpId : ""]
      .filter(Boolean)
      .join(" ");
    // The error belongs to the set of switches; the first one carries it.
    const refused = i === 0 ? f.control("capability", describedBy) : null;
    return renderSettingRow({
      id: rowId,
      name: capabilityLabel(c),
      line: CAPABILITY_LINES[c] ?? "",
      control: renderSwitch("capability", on, {
        ...(refused ?? { describedBy }),
        id: refused?.id ?? `${rowId}-input`,
        labelledBy: `${rowId}-name`,
        disabled: gateOnly,
        onValue: c,
      }),
    });
  }).join("\n");
  return `<div class="kb-settings"><div class="kb-settings__group" role="group" aria-labelledby="${escapeHtml(titleId)}"><p class="kb-overline" id="${escapeHtml(titleId)}">Capabilities</p>
${rows}
</div></div>${f.error("capability")}${help ? `\n<p class="kb-help" id="${escapeHtml(helpId)}">${help}</p>` : ""}`;
}

/** The "set the role's permissions" Switch and the grouped permission switches under one overline. */
function permissionsSection(
  bits: string | null,
  f: FormView,
  intro: string,
  editChecked: boolean,
): string {
  const titleId = `${f.id("permissions")}-title`;
  const editId = f.id("editPermissions");
  const edit = renderSettingRow({
    id: editId,
    name: "Set the role's permissions to the selection below",
    line: "",
    control: renderSwitch("editPermissions", editChecked, {
      id: `${editId}-input`,
      labelledBy: `${editId}-name`,
      onValue: "1",
    }),
  });
  return `<div class="kb-settings"><div class="kb-settings__group" role="group" aria-labelledby="${escapeHtml(titleId)}"><p class="kb-overline" id="${escapeHtml(titleId)}">Permissions</p>
${intro ? `<p class="kb-help">${escapeHtml(intro)}</p>\n` : ""}${edit}
</div></div>
${permissionSettings(bits, f)}`;
}

const presetSelect = (f: FormView): string =>
  `<div class="kb-field"><label class="kb-label" for="${escapeHtml(f.id("preset"))}">Start from a preset</label><select class="kb-select rg-preset" id="${escapeHtml(f.id("preset"))}"><option value="">(none)</option>${PERMISSION_PRESETS.map(
    (p) =>
      `<option value="${escapeHtml(p.key)}" data-permissions="${escapeHtml(new PermissionsBitField(BigInt(p.permissions)).toArray().join(","))}" data-capabilities="${escapeHtml(p.capabilities.join(","))}">${escapeHtml(p.label)}</option>`,
  ).join("")}</select></div>`;

// Progressive enhancement: a preset ticks its permission and capability switches
// (and the "set permissions" switch) so the admin can adjust them before saving.
// The permission groups are all open in the markup; this folds the ones with
// nothing on (a refused form keeps them open), and keeps each "N on" in step.
export const PRESET_SCRIPT =
  "(function(){" +
  "function count(d){var n=d.querySelectorAll('input[name=perm]:checked').length;" +
  "var s=d.querySelector('.rg-perm-count');if(s)s.textContent=', '+(n?n+' on':'none on');return n}" +
  "document.querySelectorAll('details[data-perm-group]').forEach(function(d){" +
  "if(count(d)===0&&!d.hasAttribute('data-keep-open'))d.removeAttribute('open');" +
  "d.addEventListener('change',function(){count(d)})});" +
  "document.querySelectorAll('.rg-preset').forEach(function(sel){" +
  "sel.addEventListener('change',function(){var o=sel.selectedOptions[0];if(!o||!o.value)return;" +
  "var f=sel.closest('form');var perms=(o.dataset.permissions||'').split(',');" +
  "var caps=(o.dataset.capabilities||'').split(',');" +
  "f.querySelectorAll('input[name=perm]').forEach(function(c){c.checked=perms.indexOf(c.value)>=0});" +
  "f.querySelectorAll('input[name=capability]').forEach(function(c){if(!c.disabled)c.checked=caps.indexOf(c.value)>=0});" +
  "f.querySelectorAll('details[data-perm-group]').forEach(function(d){if(count(d)>0)d.setAttribute('open','')});" +
  "var sw=f.querySelector('input[name=editPermissions]');if(sw)sw.checked=true})})})();";

const POLICY_LABELS: Record<string, string> = {
  flag: "Flag only",
  adopt: "Adopt (group follows Discord)",
  enforce: "Enforce (re-apply the group)",
};

function driftCell(g: RoleGroupRow): string {
  if (g.drift.length === 0) return "";
  return `<div class="kb-stack">${g.drift
    .map(
      (d) =>
        `<div class="kb-row"><span class="kb-badge kb-badge--warn">${escapeHtml(d.kind)}</span><span class="kb-help">${escapeHtml(d.detail)}</span></div>`,
    )
    .join("")}</div>`;
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
    : `<form method="POST" action="/admin/role-groups/${escapeHtml(g.id)}/relink" class="kb-row">${csrf}<input type="hidden" name="mode" value="recreate"><button type="submit" class="kb-btn kb-btn--sm">Create a new role</button></form>`;
  const lost = g.lostRoleId ?? g.roleId;
  const selectId = `relink-${escapeHtml(g.id)}`;
  const link = `<form method="POST" action="/admin/role-groups/${escapeHtml(g.id)}/relink" class="kb-row">${csrf}<input type="hidden" name="mode" value="link"><label class="kb-label" for="${selectId}">Link another role</label><select class="kb-select" id="${selectId}" name="roleId" required><option value="">Choose…</option>${choices}</select><button type="submit" class="kb-btn kb-btn--sm">Link</button></form>`;
  return callout({
    tone: "warn",
    wrap: true,
    title: "Unlinked: the Discord role was deleted.",
    text: `${lost ? `<span class="kb-mono">${escapeHtml(lost)}</span> is gone. ` : ""}KoolBot does not recreate it on its own.`,
    actions: `${recreate}${link}`,
  });
}

function roleCell(g: RoleGroupRow): string {
  if (g.unlinked) {
    return `<span class="kb-badge kb-badge--warn">unlinked: role deleted</span>`;
  }
  if (g.roleId === null) {
    return `<span class="kb-badge kb-badge--info">new role — created on apply</span>`;
  }
  const name = g.roleName ? roleMention(g.roleName) : "";
  const badges = [
    g.roleMissing
      ? `<span class="kb-badge kb-badge--warn">role not found</span>`
      : "",
    g.gateOnly ? `<span class="kb-badge kb-badge--info">gate-only</span>` : "",
    g.roleLock
      ? `<span class="kb-badge kb-badge--warn">locked: ${escapeHtml(ROLE_LOCK_LABELS[g.roleLock])}</span>`
      : "",
  ].join(" ");
  return `${name} <span class="kb-mono kb-muted">${escapeHtml(g.roleId)}</span> ${badges}`;
}

function editForm(
  g: RoleGroupRow,
  csrf: string,
  globalPolicy: string,
  refused?: RefusedForm | null,
): string {
  const f = formView(refused, roleGroupEditForm(g.id));
  const locked = g.gateOnly || g.roleLock !== null;
  const capabilityHelp = `Features ask for capabilities instead of role ids. <strong>Admin</strong> also counts as <strong>Moderator</strong> and <strong>Event host</strong>. <strong>Event host</strong> lets members open the host panel of events they created, from <code class="kb-mono">/me</code>; <strong>Moderator</strong> opens the moderation pages in <code>/me</code>; neither opens the admin console. <strong>Bot</strong> groups only ever match bot accounts.${g.gateOnly ? " Integration-managed roles become gate-only groups: they can be used for gating but never carry capabilities." : ""}`;
  const nameControl = f.control("name");
  return `<details class="kb-disclosure"${f.open()}><summary>${icon("chevron-right", { className: "kb-chev" })}Edit<span class="kb-visually-hidden">: ${escapeHtml(g.name)}</span></summary>
<div class="kb-disclosure__body"><form method="POST" action="/admin/role-groups/${escapeHtml(g.id)}/edit" class="kb-stack">
${csrf}
<div class="kb-field"><label class="kb-label" for="${escapeHtml(nameControl.id)}">Name</label><input class="kb-input" type="text" name="name" value="${escapeHtml(f.value("name", g.name))}" maxlength="100" required${controlAttrs(nameControl)}>${f.error("name")}</div>
${capabilitySettings(g.capabilities, g.gateOnly, f, capabilityHelp)}
${
  locked
    ? `<p class="kb-help">The role is ${g.gateOnly ? "integration-managed" : "locked"}, so its permissions and colour are not edited.</p>`
    : `${presetSelect(f)}
${permissionsSection(g.permissions, f, g.permissions === null ? "The permissions are currently left as they are." : "", f.checked("editPermissions", g.permissions !== null))}
${renderColourField(f, "colour", "Colour", formatColour(g.colour), "Leave as it is")}`
}
<div class="kb-field"><label class="kb-label" for="${escapeHtml(f.id("syncPolicy"))}">When its Discord role changes</label><select class="kb-select" id="${escapeHtml(f.id("syncPolicy"))}" name="syncPolicy">${syncPolicyOptions(g.syncPolicy, globalPolicy, f)}</select></div>
<div class="kb-row"><button type="submit" class="kb-btn">Save group</button></div>
</form></div></details>`;
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

/**
 * Delete is a Dialog trigger (#1616): the consequences are listed in the
 * dialog, not in the row. Without JavaScript the button posts to the same
 * route, which only ever keeps the Discord role.
 */
function deleteForm(g: RoleGroupRow, csrf: string): string {
  const name = escapeHtml(g.name);
  return `<form method="POST" action="/admin/role-groups/${escapeHtml(g.id)}/delete" class="kb-row" data-confirm="Delete the group ${name}?"${confirmListAttr(
    [
      "The group is removed from KoolBot, with its capabilities and its place in the rank.",
      "Its Discord role is kept, and so are its members.",
      "Features that used this group for a capability stop counting its members.",
    ],
  )}>
${csrf}
<input type="hidden" name="roleAction" value="keep">
<button type="submit" class="kb-btn kb-btn--sm kb-btn--danger" aria-label="Delete group, keep role: ${name}">Delete group, keep role</button>
</form>`;
}

/**
 * Deleting the Discord role too is a separate, reviewed step (#1184): the
 * link opens the plan preview, where the role is deleted only after its name
 * is typed. It stays a link next to the Delete button.
 */
function deleteRoleLink(g: RoleGroupRow): string {
  const canDeleteRole = g.roleId !== null && !g.roleMissing && !g.gateOnly;
  return canDeleteRole
    ? `<a class="kb-btn kb-btn--sm" href="/admin/role-groups/${escapeHtml(g.id)}/delete-role">Review deleting the group and its Discord role…<span class="kb-visually-hidden">: ${escapeHtml(g.name)}</span></a>`
    : "";
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
  const applicable =
    props.plan.errors.length === 0 &&
    props.extraErrors.length === 0 &&
    props.confirmName !== null &&
    props.reviewToken !== null;
  const confirmName = props.confirmName ?? "";
  const form = applicable
    ? `<form method="POST" action="/admin/role-groups/${escapeHtml(props.groupId)}/delete-role/apply" class="kb-stack" data-confirm="Delete this role in Discord and remove the group? A snapshot is saved first, but the role's ID and its member assignments can't be restored."${confirmListAttr(
        [
          "The role is deleted in Discord, so everyone who holds it loses it.",
          "The group is removed from KoolBot.",
          "A snapshot is saved first, but the role's ID and its member assignments cannot be restored.",
        ],
      )}>${csrf}<input type="hidden" name="planId" value="${escapeHtml(props.plan.id)}"><input type="hidden" name="approvedAt" value="${escapeHtml(props.approvedAt)}"><input type="hidden" name="reviewToken" value="${escapeHtml(props.reviewToken ?? "")}">
<p>The role is named exactly (spaces included, ${confirmName.length} characters):</p>
<pre class="kb-mono">${escapeHtml(confirmName)}</pre>
<p>I understand that deleting this role removes it from every member who holds it. A rollback can recreate a role with the same settings, but not its role ID or its member assignments, so anything that referred to the old ID stays disconnected.</p>
<div class="kb-field"><label class="kb-label" for="rg-confirm-name">Type the role name to confirm</label><input class="kb-input" type="text" id="rg-confirm-name" name="confirmName" required autocomplete="off" placeholder="${escapeHtml(confirmName)}"></div>
<div class="kb-row"><button type="submit" class="kb-btn kb-btn--danger">Delete role and group</button><a class="kb-btn kb-btn--ghost" href="/admin/role-groups">Cancel</a></div>
<p class="kb-help">This review is valid for ${props.validForMinutes} minutes. A snapshot is saved first.</p></form>`
    : `<div class="kb-row"><a class="kb-btn" href="/admin/role-groups">Back</a></div>`;
  const body = `
<div class="kb-stack">
${pageHeader(`Delete group "${props.groupName}" and its role`, "Review what would change in Discord. Nothing is deleted until you confirm below.")}
${panel("rg-delete-plan", "Plan", `<div class="kb-stack">${issuesCallout(props.extraErrors)}${renderAdoptionDiff(props.plan)}</div>`)}
${panel("rg-delete-confirm", "Confirm", form, { danger: true })}
</div>`;
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
    return panel(
      "rg-groups",
      "Groups",
      emptyState(
        "No groups yet",
        "Groups are optional: with none, every feature keeps its current behaviour.",
      ),
    );
  }
  const shownOrder = orderToken(props.groups.map((g) => g.id));
  const rows = props.groups
    .map((g, i) => {
      const caps = g.capabilities.length
        ? `<span class="kb-row">${g.capabilities
            .map(
              (c) =>
                `<span class="kb-badge kb-badge--info">${escapeHtml(capabilityLabel(c))}</span>`,
            )
            .join("")}</span>`
        : `<span class="kb-muted">none (gating only)</span>`;
      return `<tr${reorderRowAttrs(`role-group-${g.id}`, g.name)}>
<td>${renderReorderCell({ action: `/admin/role-groups/${g.id}/move`, scope: ROLE_GROUP_REORDER_SCOPE, csrfInput: csrf, index: i, count: props.groups.length, orderToken: shownOrder, label: g.name })}</td>
<th scope="row">${escapeHtml(g.name)}</th>
<td>${roleCell(g)}${driftCell(g)}${g.unlinked || g.roleMissing ? relinkForm(g, csrf, props.roleOptions) : ""}</td>
<td class="kb-num">${g.memberCount === null ? `<span class="kb-muted">?</span>` : g.memberCount}</td>
<td>${caps}</td>
<td class="kb-actions"><div class="kb-row kb-row--nowrap">${editForm(g, csrf, props.globalPolicy, props.refusedForm)}${deleteForm(g, csrf)}${deleteRoleLink(g)}</div></td>
</tr>`;
    })
    .join("");
  const table = `<table class="kb-table"><thead><tr><th scope="col">Rank</th><th scope="col">Group</th><th scope="col">Role</th><th scope="col" class="kb-num">Members</th><th scope="col">Capabilities</th><th scope="col"><span class="kb-visually-hidden">Actions</span></th></tr></thead><tbody${reorderListAttrs("Role groups")}>${rows}</tbody></table>
${REORDER_STATUS_HTML}`;
  return panel("rg-groups", "Groups", table, {
    meta: String(props.groups.length),
    flush: true,
    foot: "Listed highest first: a group ranks above the ones below it, and role positions in Discord follow this order when applied. Member counts come from Discord without loading every member.",
  });
}

/** True when the page shows a plan whose Apply plan button is offered; that is then the view's primary (#1512). */
function planCanApply(props: RoleGroupsPageProps): boolean {
  return Boolean(
    props.plan &&
    !props.planUnavailable &&
    props.plan.errors.length === 0 &&
    props.extraErrors.length === 0 &&
    props.plan.operations.length > 0,
  );
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
  const roleControl = f.control("roleId");
  const nameControl = f.control("name");
  return `<form method="POST" action="/admin/role-groups/create" class="kb-stack">
${csrf}
<div class="kb-field"><label class="kb-label" for="${escapeHtml(roleControl.id)}">Backing role</label><select class="kb-select" name="roleId"${controlAttrs(roleControl)}><option value="">Create a new role</option>${missingPicked}${options}</select>${f.error("roleId")}
<p class="kb-help">Linking an existing role keeps its members and never changes its permissions unless you edit them. Integration-managed roles (Server Booster, subscriptions) become gate-only groups: they can be used for gating but are never edited.</p></div>
<div class="kb-field"><label class="kb-label" for="${escapeHtml(nameControl.id)}">Name</label><input class="kb-input" type="text" name="name" maxlength="100" placeholder="(a linked role's own name if empty)"${f.valueAttr("name")}${controlAttrs(nameControl)}>${f.error("name")}</div>
${capabilitySettings([], false, f, "")}
${presetSelect(f)}
${permissionsSection(null, f, "New roles get the selection below. An existing role is left alone unless you switch this on.", f.checked("editPermissions"))}
${renderColourField(f, "colour", "Colour", "", "No colour")}
<div class="kb-row"><button type="submit" class="${planCanApply(props) ? "kb-btn" : "kb-btn kb-btn--primary"}">Add group</button></div>
</form>`;
}

function renderPlan(props: RoleGroupsPageProps, csrf: string): string {
  if (props.planUnavailable) {
    return callout({ tone: "warn", title: props.planUnavailable });
  }
  if (!props.plan) return "";
  const bots = props.botScanUnavailable
    ? callout({
        tone: "warn",
        title:
          "Bot accounts couldn't be listed (the Server Members intent is off), so no bot-group grants are planned.",
      })
    : props.botsMissing > 0
      ? `<p class="kb-help">${props.botsMissing} bot(s) are not in the bot group; the plan adds the shared role. Their own managed roles are untouched.</p>`
      : "";
  const form = planCanApply(props)
    ? `<form method="POST" action="/admin/role-groups/apply" class="kb-row" data-confirm="Apply this plan to Discord? A snapshot is saved first so it can be rolled back."${CONFIRM_NEUTRAL_ATTR}>${csrf}<input type="hidden" name="planId" value="${escapeHtml(props.plan.id)}"><button type="submit" class="kb-btn kb-btn--primary">Apply plan</button><span class="kb-help">A snapshot of everything touched is saved first.</span></form>`
    : "";
  return `${issuesCallout(props.extraErrors)}${bots}${renderAdoptionDiff(props.plan)}${form}`;
}

/** A group of Switch rows under one overline, the markup the Capabilities and Permissions rows use. */
function switchGroup(
  id: string,
  title: string,
  rows: string,
  intro = "",
): string {
  return `<div class="kb-settings"><div class="kb-settings__group" role="group" aria-labelledby="${id}-title"><p class="kb-overline" id="${id}-title">${escapeHtml(title)}</p>
${intro}${rows}
</div></div>`;
}

/** One Switch row that posts `name=value` while on. It starts off: nothing is selected for the admin. */
function choiceRow(
  id: string,
  name: string,
  label: string,
  value: string,
  line = "",
): string {
  return renderSettingRow({
    id,
    name: label,
    line,
    control: renderSwitch(name, false, {
      id: `${id}-input`,
      labelledBy: `${id}-name`,
      describedBy: line ? `${id}-desc` : undefined,
      onValue: value,
    }),
  });
}

function renderAdminSync(props: RoleGroupsPageProps): string {
  const roleName = (id: string): string =>
    escapeHtml(props.roleNames[id] ?? id);
  const report = props.adminReport;
  const humans = report?.humans ?? [];
  const grant = props.adminGroupLacksAdministrator
    ? switchGroup(
        "rg-sync-grant",
        "Give the admin group Administrator",
        choiceRow(
          "rg-sync-grant-row",
          "grant",
          "Add the Administrator permission to the admin group's role",
          "1",
          "Everyone holding that role gets it.",
        ),
      )
    : "";
  const intro = props.adminGroupLacksAdministrator
    ? callout({
        tone: "warn",
        title:
          "The admin group's role doesn't carry Administrator. That is a choice, not something applied automatically: tick it below and review the plan.",
      })
    : "";
  const unavailable = props.membersUnavailable
    ? callout({
        tone: "warn",
        title:
          "Other administrators can't be checked: the Server Members intent is off, so the member list is unavailable.",
      })
    : "";
  if (!report && !props.membersUnavailable && !grant) {
    return `<p class="kb-help">No admin group with a role is defined, so there is nothing to sync. The server owner counts as admin for web sign-in on their own, and nobody is flagged.</p>`;
  }
  const bots = report?.bots.length
    ? `<p class="kb-overline">Bots with Administrator (${report.bots.length})</p>
<p class="kb-help">Bots are never counted as out-of-group administrators and are never touched. Consider reducing each to the permissions it actually needs.</p>
<ul class="kb-list">${report.bots
        .map(
          (bot) =>
            `<li><span class="kb-list__main">${escapeHtml(bot.name)}${bot.self ? " (KoolBot)" : ""}</span><span class="kb-muted">via ${bot.viaRoleIds.map(roleName).join(", ")}</span></li>`,
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
      ? `${switchGroup(
          "rg-sync-move",
          "Move into the admin group (adds the admin role; removes nothing)",
          humans
            .map((h, i) =>
              choiceRow(
                `rg-sync-move-${i}`,
                "move",
                h.name,
                h.id,
                `via ${h.viaRoleIds.map((id) => props.roleNames[id] ?? id).join(", ")}`,
              ),
            )
            .join("\n"),
        )}
${switchGroup(
  "rg-sync-drop",
  "Or drop Administrator from the other role (edits the role for everyone in it)",
  viaRoles
    .map((id, i) =>
      choiceRow(
        `rg-sync-drop-${i}`,
        "drop",
        `@${props.roleNames[id] ?? id}`,
        id,
      ),
    )
    .join("\n"),
  `<p class="kb-help">Integration-managed roles and KoolBot's own role can't be edited. You can't drop a role if that would remove your own Administrator access.</p>\n`,
)}`
      : "";
  const status =
    report && humans.length === 0
      ? `<p class="kb-help">Everyone with Administrator is in the admin group (or is the server owner).</p>`
      : humans.length > 0
        ? `<p>${humans.length} member(s) hold Administrator through a role outside the admin group. Choose what to do, then review the plan: nothing is selected for you.</p>`
        : "";
  const form =
    fixes || grant
      ? `<form method="GET" action="/admin/role-groups/admin-fix" class="kb-stack">
${grant}${fixes}
<div class="kb-row"><button type="submit" class="kb-btn">Preview the plan</button></div>
</form>`
      : "";
  return `<div class="kb-stack">${intro}${unavailable}${status}${form}${bots}</div>`;
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
  const losing = props.losing.length
    ? callout({
        tone: "warn",
        title: `${props.losing.length} member(s) lose Administrator and are not moved into the admin group: ${props.losing.join(", ")}.`,
      })
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
    ? `<form method="POST" action="/admin/role-groups/admin-fix/apply" class="kb-row" data-confirm="Apply this plan to Discord? A snapshot is saved first so it can be rolled back."${CONFIRM_NEUTRAL_ATTR}>${csrf}${hidden}<input type="hidden" name="planId" value="${escapeHtml(props.plan.id)}"><button type="submit" class="kb-btn kb-btn--primary">Apply plan</button><a class="kb-btn" href="/admin/role-groups">Back</a></form>`
    : `<div class="kb-row"><a class="kb-btn" href="/admin/role-groups">Back</a></div>`;
  const body = `
<div class="kb-stack">
${pageHeader("Administrators outside the admin group", "Review what would change in Discord. Nothing is written until you apply, and a snapshot is saved first.")}
${panel("rg-fix-plan", "Plan", `<div class="kb-stack">${issuesCallout(props.extraErrors)}${losing}${renderAdoptionDiff(props.plan)}${form}</div>`)}
</div>`;
  return renderAdminPage({
    title: "Role Groups",
    active: "/admin/role-groups",
    body,
    csrfToken: props.csrfToken,
    remainingMs: props.remainingMs,
    navFeatureStatus: props.navFeatureStatus,
  });
}

export const JOB_SCRIPT = (jobId: string): string =>
  `(function(){var id=${JSON.stringify(jobId)};var el=document.getElementById('rg-job');` +
  "function tick(){fetch('/admin/role-groups/job/'+encodeURIComponent(id),{credentials:'same-origin'})" +
  ".then(function(r){return r.json()}).then(function(j){" +
  "el.textContent=j.text;if(j.status==='running'){setTimeout(tick,1500)}else{setTimeout(function(){location.href='/admin/role-groups'},1500)}})" +
  ".catch(function(){el.textContent='Lost contact with the bot; reload to see the result.'})}tick()})();";

function renderDriftSummary(props: RoleGroupsPageProps): string {
  const drifted = props.groups.filter((g) => g.drift.length > 0 || g.unlinked);
  if (drifted.length === 0) return "";
  return callout({
    tone: "warn",
    title: `${drifted.length} group(s) differ from Discord.`,
    text: `Sync policy: ${escapeHtml(POLICY_LABELS[props.globalPolicy] ?? props.globalPolicy)}. Changes made in Discord are shown per group below; fix them by applying the plan, or set a group's policy to adopt or enforce.`,
  });
}

export function renderRoleGroupsPage(props: RoleGroupsPageProps): string {
  const csrf = `<input type="hidden" name="_csrf" value="${escapeHtml(props.csrfToken)}">`;
  // `JOB_SCRIPT` sets the text of #rg-job, so the id sits on the Callout's title.
  const job = props.jobId
    ? callout({ tone: "", title: "Applying…", id: "rg-job" })
    : "";
  const plan = renderPlan(props, csrf);
  const body = `
<div class="kb-stack">
${pageHeader("Role Groups", "Name the roles that matter on your server (Admin, Mod, VIP, Friends, Bots …), rank them, and let features ask for a capability instead of a role id. Groups are optional.")}
${renderFlash(props.flash)}
${job}${renderPermissionNotice(props.permissionNotice ?? null, { canLinkToPage: true })}
${renderDriftSummary(props)}
${renderGroups(props, csrf)}
${panel("rg-plan", "Plan", `<p class="kb-help">Saving a group only records what you want. This is what applying would change in Discord: nothing is written until you apply, and every apply is snapshotted.</p>${plan}`, { stack: true })}
${panel("rg-admins", "Administrators and the admin group", `<p class="kb-help">The group flagged <code class="kb-mono">admin</code> carries Discord's Administrator permission. If the role lacks it you can add it here, as a separate choice you review first. Web sign-in accepts either the admin group or Administrator.</p>${renderAdminSync(props)}`, { stack: true })}
${panel("rg-add", "Add a group", renderAddForm(props, csrf))}
<p class="kb-help">The server owner and members with the Administrator permission always count as <code class="kb-mono">admin</code>, with or without a group.</p>
</div>
${scriptTag(PRESET_SCRIPT)}
${props.groups.length > 0 ? scriptTag(REORDER_SCRIPT) : ""}
${props.jobId ? `${scriptTag(JOB_SCRIPT(props.jobId))}` : ""}
`;
  return renderAdminPage({
    title: "Role Groups",
    wide: true,
    active: "/admin/role-groups",
    body,
    csrfToken: props.csrfToken,
    remainingMs: props.remainingMs,
    navFeatureStatus: props.navFeatureStatus,
  });
}
