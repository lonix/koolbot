import { icon, toneIcon } from "./icons.js";
import { roleMention } from "./discord-labels.js";
import { renderRolePicker } from "./admin-views.js";
import {
  escapeHtml,
  renderAdminPage,
  type NavFeatureStatus,
} from "./admin-layout.js";
import {
  ACCESS_SCOPES,
  scopeLabel,
  type AccessChange,
  type AccessGap,
  type AccessRole,
  type AccessScope,
  type AccessSelection,
} from "../services/wizard-access.js";
import { pickerCreateValue, type PickerCreate } from "./setting-pickers.js";
import type { WizardRoleReview } from "./wizard-role-create.js";

/**
 * The Setup wizard's Access step (#1321) and the step indicator the other
 * wizard pages share. See `docs/design/pages.md` (WizardAccessPage) and
 * `docs/design/components.md` (AccessCard, Steps).
 */

/**
 * The wizard's four steps (#1620). `features` is choosing which features to turn
 * on (labelled "Choose features"); `settings` is the run of per-feature pages
 * (labelled "Features"). The wizard has no channel step: channel settings are
 * ordinary settings on the feature page that owns them.
 */
export type WizardStepId = "features" | "access" | "settings" | "review";

const STEPS: ReadonlyArray<{ id: WizardStepId; label: string; href: string }> =
  [
    { id: "features", label: "Choose features", href: "/admin/wizard" },
    { id: "access", label: "Access", href: "/admin/wizard?step=access" },
    { id: "settings", label: "Features", href: "/admin/wizard?step=0" },
    { id: "review", label: "Review", href: "/admin/wizard?step=confirm" },
  ];

/** Progress through the wizard: done steps link back, the current one is marked. */
export function renderWizardSteps(current: WizardStepId): string {
  const at = STEPS.findIndex((s) => s.id === current);
  const items = STEPS.map((s, i) => {
    if (i < at) {
      return `<li class="is-done"><a href="${escapeHtml(s.href)}">${escapeHtml(s.label)}</a></li>`;
    }
    if (i === at) {
      return `<li aria-current="step">${escapeHtml(s.label)}</li>`;
    }
    return `<li>${escapeHtml(s.label)}</li>`;
  }).join("");
  return `<ol class="kb-steps-bar" aria-label="Setup wizard steps">${items}</ol>`;
}

/**
 * The sub-progress bar of the Features step (#1620): one marker per chosen
 * feature, with the position as text ("Feature 2 of 3: Name history"). Finished
 * features link back to their page. The marker of the page being shown carries
 * `aria-current="step"`; the main bar keeps its own. A single feature draws
 * nothing, because there is nothing to count. PROPOSAL: not in the manual until
 * the owner approves it.
 */
export function renderWizardSubSteps(
  items: ReadonlyArray<{ label: string }>,
  current: number,
): string {
  if (items.length < 2) return "";
  const marks = items
    .map((item, i) => {
      const label = escapeHtml(item.label);
      if (i < current) {
        return `<li class="is-done"><a class="kb-substeps__mark" href="/admin/wizard?step=${i}" title="${label}"><span class="kb-visually-hidden">${label}, done</span></a></li>`;
      }
      const mark = `<span class="kb-substeps__mark" title="${label}"><span class="kb-visually-hidden">${label}</span></span>`;
      return i === current
        ? `<li aria-current="step">${mark}</li>`
        : `<li>${mark}</li>`;
    })
    .join("");
  const at = items[current]?.label ?? "";
  return `<div class="kb-substeps"><p class="kb-substeps__label">${escapeHtml(`Feature ${current + 1} of ${items.length}: ${at}`)}</p><ol class="kb-substeps__bar" aria-label="Features to set up">${marks}</ol></div>`;
}

const CHECK_ICON = icon("check");
const MINUS_ICON = icon("minus");

function callout(
  kind: "" | "warn" | "ok" | "err",
  title: string,
  text = "",
  role: "status" | "alert" = "status",
): string {
  const cls = kind ? `kb-callout kb-callout--${kind}` : "kb-callout";
  return `<div class="${cls}" role="${role}">${toneIcon(kind)}<div class="kb-callout__body"><p class="kb-callout__title">${escapeHtml(title)}</p>${
    text ? `<p class="kb-callout__text">${escapeHtml(text)}</p>` : ""
  }</div></div>`;
}

function gapCallouts(gaps: readonly AccessGap[]): string {
  return gaps
    .map((g) =>
      callout(
        "warn",
        g.message,
        `Pick a role under ${scopeLabel(g.scope)}s below, or an admin role will be the only one that can.`,
      ),
    )
    .join("\n");
}

interface ScopeCopy {
  scope: AccessScope;
  title: string;
  how: string;
  can: string[];
  cannot: string[];
  help: string;
}

const SCOPE_COPY: readonly ScopeCopy[] = [
  {
    scope: "admin",
    title: "Admins",
    how: "Sign in to the Web UI with /config.",
    can: [
      "Change every setting and run the setup wizard",
      "Manage role groups, channels and the server scan",
      "Do everything Moderators and Event hosts can",
    ],
    cannot: [],
    help: "The owner and anyone with Discord's Administrator permission are always admins. Discord only lets /config run for members with the Administrator permission, unless you allow it for a role under Server settings, Integrations. Removing an admin role is done on Role groups.",
  },
  {
    scope: "staff",
    title: "Moderators",
    how: "Sign in to their own pages with /me.",
    can: ["Read the moderation log and cases in the Web UI"],
    cannot: [
      "Change settings",
      "Run /warn unless Discord grants them Moderate Members",
    ],
    help: "A mapped role does not give any Discord permission. Slash commands stay limited by Discord's own permissions.",
  },
  {
    scope: "host",
    title: "Event hosts",
    how: "Sign in to their own pages with /me.",
    can: [
      "Run the host panel: teams, moves, clan tags",
      "Start, edit and cancel the events they created",
    ],
    cannot: ["Change settings", "Edit other people's events"],
    help: "",
  },
];

function canList(can: readonly string[], cannot: readonly string[]): string {
  const items = [
    ...can.map((t) => `<li>${CHECK_ICON}<span>${escapeHtml(t)}</span></li>`),
    ...cannot.map(
      (t) =>
        `<li class="is-not">${MINUS_ICON}<span>Cannot: ${escapeHtml(t.charAt(0).toLowerCase() + t.slice(1))}</span></li>`,
    ),
  ];
  return `<ul class="kb-access__can">${items.join("")}</ul>`;
}

/**
 * The help line under a card's Picker. The create sentence is only written when
 * the Picker really offers the row (`create.ok`), and the reason only when the
 * Picker shows it; an unreadable answer says nothing more.
 */
function roleHelp(create: PickerCreate | undefined): string {
  const base = "Leave it empty for none.";
  if (create?.ok === true) {
    return `${base} To create a role, type its name and choose Create new role. It is created with no Discord permissions and nobody is added to it; Review lists it first.`;
  }
  if (create?.reason) return `${base} ${create.reason}`;
  return base;
}

function roleSelect(
  scope: AccessScope,
  options: readonly AccessRole[],
  chosen: readonly string[],
  create: PickerCreate | undefined,
  pending: readonly string[],
): string {
  // A saved role that can no longer be picked (deleted, or moved above the bot)
  // stays selected and is listed as unavailable, so saving does not silently
  // drop it. A role chosen to be created is drawn as a pending choice
  // ("(will be created)") whether or not the Picker can still offer the row.
  const id = `access-${scope}`;
  return `<label class="kb-label" for="${id}">Discord roles</label>
${renderRolePicker({
  id,
  name: `roles_${scope}`,
  options: options.map((r) => ({ id: r.id, name: r.name })),
  selected: [...chosen, ...pending.map(pickerCreateValue)],
  describedBy: `${id}-help`,
  ...(create ? { create } : {}),
})}
<p class="kb-help" id="${id}-help">${escapeHtml(roleHelp(create))}</p>`;
}

export interface WizardAccessPageProps {
  csrfToken: string;
  remainingMs: number;
  navFeatureStatus?: NavFeatureStatus;
  selection: AccessSelection;
  /** Roles that may be picked; `null` when Discord or the groups couldn't be read. */
  options: AccessRole[] | null;
  gaps: AccessGap[];
  /**
   * The role Picker's create flag (#1618, #1658): `ok` offers "Create new
   * role", a refusal shows its reason instead. Absent when the permission could
   * not be read (no row, no line) or the page offers nothing.
   */
  create?: PickerCreate;
  /** Names chosen to be created, per scope; drawn as pending choices. */
  pending?: Partial<Record<AccessScope, readonly string[]>>;
  flash?: { type: "ok" | "warn" | "err"; text: string } | null;
}

export function renderWizardAccessPage(props: WizardAccessPageProps): string {
  const csrf = escapeHtml(props.csrfToken);
  const flash = props.flash
    ? callout(
        props.flash.type,
        props.flash.text,
        "",
        props.flash.type === "err" ? "alert" : "status",
      )
    : "";
  const options = props.options;

  const cards = SCOPE_COPY.map((c) => {
    const picker =
      options === null
        ? `<p class="kb-help">Roles can't be listed right now.</p>`
        : roleSelect(
            c.scope,
            options,
            props.selection[c.scope],
            props.create,
            props.pending?.[c.scope] ?? [],
          );
    return `<article class="kb-access__card" aria-labelledby="access-${c.scope}-title">
  <header class="kb-access__head"><div><h3 class="kb-access__title" id="access-${c.scope}-title">${escapeHtml(c.title)}</h3><p class="kb-access__how">${escapeHtml(c.how)}</p></div></header>
  ${canList(c.can, c.cannot)}
  <div class="kb-access__roles">
    <div class="kb-field">${picker}</div>
    ${c.help ? `<p class="kb-help">${escapeHtml(c.help)}</p>` : ""}
  </div>
</article>`;
  }).join("\n");

  const form =
    options === null
      ? callout(
          "warn",
          "The roles could not be read from Discord.",
          "Reload the page in a moment. Nothing is saved until you press Save access.",
          "alert",
        )
      : "";

  const body = `
<div class="kb-stack">
<header class="kb-pagehead"><div class="kb-pagehead__text"><h1 class="kb-pagehead__title">Setup wizard</h1><p class="kb-pagehead__sub">Map your Discord roles to what people can do, before any channel is set up. Nothing changes until you apply on the last step.</p></div></header>
${renderWizardSteps("access")}
${flash}
${gapCallouts(props.gaps)}
${form}
<form method="POST" action="/admin/wizard/access">
  <input type="hidden" name="_csrf" value="${csrf}">
  <h2 class="kb-panel__title">Who can do what</h2>
  <div class="kb-access">
${cards}
  </div>
  <div class="actions">
    <button type="submit" class="kb-btn kb-btn--primary"${options === null ? " disabled" : ""}>Save access and continue</button>
    <a href="/admin/wizard" class="kb-btn kb-btn--ghost">Back to Choose features</a>
  </div>
</form>
</div>
`;
  return renderAdminPage({
    title: "Wizard: Access",
    active: "/admin/wizard",
    body,
    csrfToken: props.csrfToken,
    remainingMs: props.remainingMs,
    navFeatureStatus: props.navFeatureStatus,
  });
}

function scopeNames(scopes: readonly AccessScope[]): string {
  return scopes.length === 0
    ? "no scope"
    : ACCESS_SCOPES.filter((s) => scopes.includes(s))
        .map(scopeLabel)
        .join(", ");
}

/** A typed name that selected an EXISTING role, for Review's warning. */
export interface ReviewRoleMatch {
  /** The role's own name. */
  name: string;
  scopes: AccessScope[];
  /** Everyone who holds it already; `null` when Discord could not say. */
  members: number | null;
}

/**
 * Review's first line for a typed name that matched an existing role (#1618):
 * no role is created, and everyone who already holds that role gets what the
 * scope gives. A warning Callout when a scope is Admins or Moderators, a plain
 * one for Event hosts only. The wording is a PROPOSAL for the owner.
 */
function renderRoleMatches(matches: readonly ReviewRoleMatch[]): string {
  if (matches.length === 0) return "";
  const strong = matches.some((m) => m.scopes.some((s) => s !== "host"));
  const rows = matches
    .map((m) => {
      const who =
        m.members === null
          ? "its members could not be counted"
          : `${m.members} ${m.members === 1 ? "member holds" : "members hold"} it now`;
      return `<li>${roleMention(m.name)} is an existing role, ${escapeHtml(who)}. It will be mapped to ${escapeHtml(
        m.scopes.map((s) => SCOPE_NAMES[s]).join(" and "),
      )}; no role is created.</li>`;
    })
    .join("");
  return `<div class="kb-callout${strong ? " kb-callout--warn" : ""}" role="status" id="wizard-role-matches">${toneIcon(strong ? "warn" : "")}<div class="kb-callout__body"><p class="kb-callout__title">A name you typed is an existing role</p><ul>${rows}</ul><p class="kb-callout__text">Everyone who already holds an existing role gets what its scope allows. Go back to Access if you meant a new role.</p></div></div>`;
}

/** The role-mapping part of the review step: what Apply will write to role groups. */
export function renderAccessReview(
  changes: readonly AccessChange[],
  problem: string | null,
  gaps: readonly AccessGap[],
  roles: WizardRoleReview | null = null,
  matches: readonly ReviewRoleMatch[] = [],
): string {
  const parts: string[] = [renderRoleMatches(matches)];
  const roleBlock = roles ? renderRoleCreateReview(roles) : "";
  if (problem) {
    parts.push(
      callout(
        "err",
        "The role mapping can't be applied.",
        `${problem} Go back to Access and fix it, or apply is blocked.`,
        "alert",
      ),
    );
  }
  parts.push(gapCallouts(gaps));
  if (changes.length === 0) {
    parts.push(roleBlock);
    if (!problem && !roles) {
      parts.push(
        `<div class="card"><h2>Role access</h2><p class="muted">No role mapping changes.</p></div>`,
      );
    }
    return parts.filter(Boolean).join("\n");
  }
  const rows = changes
    .map(
      (c) =>
        `<tr><th scope="row">${roleMention(c.roleName)}</th><td>${escapeHtml(scopeNames(c.scopesBefore))}</td><td>${escapeHtml(scopeNames(c.scopesAfter))}</td><td class="muted">${
          c.kind === "create"
            ? `Creates the role group "${escapeHtml(c.groupName)}"`
            : `Updates the role group "${escapeHtml(c.groupName)}"`
        }</td></tr>`,
    )
    .join("");
  parts.push(`<div class="card">
  <h2>Role access</h2>
  <p class="muted">Applying saves these role groups. It links existing Discord roles to groups and changes what they may do in KoolBot; it does not change the roles in Discord.</p>
  <table>
    <thead><tr><th scope="col">Role</th><th scope="col">Now</th><th scope="col">After</th><th scope="col">Change</th></tr></thead>
    <tbody>${rows}</tbody>
  </table>
</div>`);
  parts.push(roleBlock);
  return parts.filter(Boolean).join("\n");
}

const SCOPE_NAMES: Record<AccessScope, string> = {
  admin: "Admins",
  staff: "Moderators",
  host: "Event hosts",
};

/**
 * The Review entry for the roles the Access step will create (#1618): one list
 * row per role, in a Panel, with a Mention for the name, and a line saying which
 * scopes it is mapped to. Nothing is created and nobody is added; the role has
 * no Discord permissions. The wording is a PROPOSAL for the owner. Empty when
 * there is nothing planned and nothing wrong, so a Review without roles renders
 * as before.
 */
export function renderRoleCreateReview(review: WizardRoleReview): string {
  const problems =
    review.problems.length > 0
      ? `<div class="kb-callout kb-callout--err" role="alert" id="wizard-role-problems">${toneIcon("err")}<div class="kb-callout__body"><p class="kb-callout__title">The roles can't be created</p><ul>${review.problems
          .map((p) => `<li>${escapeHtml(p)}</li>`)
          .join(
            "",
          )}</ul><p class="kb-callout__text">Nothing is changed until this is fixed. Go back to Access and change it, or fix it in Discord and open Review again.</p></div></div>`
      : "";
  if (review.roles.length === 0) return problems;
  const id = "wizard-role-review";
  const rows = review.roles
    .map(
      (r) =>
        `<li><span class="kb-list__main"><span>Create the role ${roleMention(r.name)} (no Discord permissions, nobody added)</span><span class="kb-list__desc">Mapped to ${escapeHtml(r.scopes.map((s) => SCOPE_NAMES[s]).join(" and "))}.</span></span></li>`,
    )
    .join("");
  return `${problems}
<section class="kb-panel" id="${id}" aria-labelledby="${id}-h">
  <header class="kb-panel__head"><h2 class="kb-panel__title" id="${id}-h">Roles to create</h2><span class="kb-panel__meta">${review.roles.length}</span></header>
  <div class="kb-panel__body kb-panel__body--flush">
    <ul class="kb-list">${rows}</ul>
  </div>
  <footer class="kb-panel__foot"><p class="kb-help">Nothing is created until you apply. If applying fails, nothing it created is left behind.</p></footer>
</section>`;
}
