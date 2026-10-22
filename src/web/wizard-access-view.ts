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
import type {
  HostCreateState,
  HostReview,
} from "../services/wizard-host-role.js";

/**
 * The Setup wizard's Access step (#1321) and the step indicator the other
 * wizard pages share. See `docs/design/pages.md` (WizardAccessPage) and
 * `docs/design/components.md` (AccessCard, Steps).
 */

export type WizardStepId = "features" | "access" | "channels" | "review";

const STEPS: ReadonlyArray<{ id: WizardStepId; label: string; href: string }> =
  [
    { id: "features", label: "Features", href: "/admin/wizard" },
    { id: "access", label: "Access", href: "/admin/wizard?step=access" },
    { id: "channels", label: "Channels", href: "/admin/wizard?step=0" },
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

const CHECK_ICON =
  '<svg class="kb-icon" viewBox="0 0 24 24" aria-hidden="true" focusable="false"><polyline points="5 12 10 17 19 7"/></svg>';
const MINUS_ICON =
  '<svg class="kb-icon" viewBox="0 0 24 24" aria-hidden="true" focusable="false"><line x1="6" y1="12" x2="18" y2="12"/></svg>';

function callout(
  kind: "" | "warn" | "ok" | "err",
  title: string,
  text = "",
  role: "status" | "alert" = "status",
): string {
  const cls = kind ? `kb-callout kb-callout--${kind}` : "kb-callout";
  return `<div class="${cls}" role="${role}"><div class="kb-callout__body"><p class="kb-callout__title">${escapeHtml(title)}</p>${
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

function roleSelect(
  scope: AccessScope,
  options: readonly AccessRole[],
  chosen: readonly string[],
): string {
  const known = new Set(options.map((r) => r.id));
  const picked = new Set(chosen);
  // A saved role that can no longer be picked (deleted, or moved above the bot)
  // stays listed and selected, so saving does not silently drop it.
  const missing = chosen
    .filter((id) => !known.has(id))
    .map(
      (id) =>
        `<option value="${escapeHtml(id)}" selected>Unavailable role ${escapeHtml(id)}</option>`,
    );
  const opts = options.map(
    (r) =>
      `<option value="${escapeHtml(r.id)}"${picked.has(r.id) ? " selected" : ""}>@${escapeHtml(r.name)}</option>`,
  );
  const id = `access-${scope}`;
  const size = Math.min(8, Math.max(4, opts.length + missing.length));
  return `<label class="kb-label" for="${id}">Discord roles</label>
<select class="kb-select" id="${id}" name="roles_${scope}" multiple size="${size}" aria-describedby="${id}-help">${[...missing, ...opts].join("")}</select>
<p class="kb-help" id="${id}-help">Hold Ctrl or Cmd to pick more than one. Leave it empty for none.</p>`;
}

/**
 * The Event host card's option to create the role (#1365). Offered only when
 * no such role exists; a bot without Manage Roles gets the switch disabled and
 * the reason beside it, so the refusal is never silent.
 */
function hostCreateControl(state: HostCreateState, checked: boolean): string {
  if (!state.available && state.reason === "exists") return "";
  const id = "access-host-create";
  const help = state.available
    ? "There is no Event host role yet. Applying creates one with no Discord permissions and adds nobody to it. Review shows exactly what it will do first."
    : state.message;
  return `<div class="kb-field">
  <label class="kb-switch"><input type="checkbox" role="switch" name="create_host" value="1" aria-describedby="${id}-help"${state.available && checked ? " checked" : ""}${state.available ? "" : " disabled"}><span class="kb-switch__track" aria-hidden="true"></span><span class="kb-switch__state" aria-hidden="true"></span>Create @Event host</label>
  <p class="kb-help" id="${id}-help">${escapeHtml(help)}</p>
</div>`;
}

export interface WizardAccessPageProps {
  csrfToken: string;
  remainingMs: number;
  navFeatureStatus?: NavFeatureStatus;
  selection: AccessSelection;
  /** Roles that may be picked; `null` when Discord or the groups couldn't be read. */
  options: AccessRole[] | null;
  gaps: AccessGap[];
  /** Whether the Event host role can be created here; `null` = not known. */
  hostCreate?: HostCreateState | null;
  /** *Create @Event host* is ticked. */
  createHost?: boolean;
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
        : roleSelect(c.scope, options, props.selection[c.scope]);
    const noRole =
      options !== null && c.scope === "host" && props.hostCreate
        ? hostCreateControl(props.hostCreate, props.createHost === true)
        : "";
    return `<article class="kb-access__card" aria-labelledby="access-${c.scope}-title">
  <header class="kb-access__head"><div><h3 class="kb-access__title" id="access-${c.scope}-title">${escapeHtml(c.title)}</h3><p class="kb-access__how">${escapeHtml(c.how)}</p></div></header>
  ${canList(c.can, c.cannot)}
  <div class="kb-access__roles">
    <div class="kb-field">${picker}</div>
    ${c.help ? `<p class="kb-help">${escapeHtml(c.help)}</p>` : ""}
    ${noRole}
  </div>
</article>`;
  }).join("\n");

  const members = `<article class="kb-access__card" aria-labelledby="access-members-title">
  <header class="kb-access__head"><div><h3 class="kb-access__title" id="access-members-title">Members</h3><p class="kb-access__how">Sign in to their own page with /me.</p></div></header>
  ${canList(["Set their own preferences", "See their own stats and reminders"], ["Change settings", "See other people's private data"])}
  <div class="kb-access__roles">
    <p class="kb-help">Everyone on the server may use /me. To narrow it to some roles, use <a href="/admin/permissions">Command permissions</a>.</p>
  </div>
</article>`;

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
${members}
  </div>
  <div class="actions">
    <button type="submit" class="kb-btn kb-btn--primary"${options === null ? " disabled" : ""}>Save access and continue</button>
    <a href="/admin/wizard" class="kb-btn kb-btn--ghost">Back to features</a>
  </div>
</form>
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

/** The role-mapping part of the review step: what Apply will write to role groups. */
export function renderAccessReview(
  changes: readonly AccessChange[],
  problem: string | null,
  gaps: readonly AccessGap[],
  host: HostReview | null = null,
): string {
  const parts: string[] = [];
  const hostBlock = host ? renderHostReview(host) : "";
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
    parts.push(hostBlock);
    if (!problem && !host) {
      parts.push(
        `<div class="card"><h2>Role access</h2><p class="muted">No role mapping changes.</p></div>`,
      );
    }
    return parts.filter(Boolean).join("\n");
  }
  const rows = changes
    .map(
      (c) =>
        `<tr><td>@${escapeHtml(c.roleName)}</td><td>${escapeHtml(scopeNames(c.scopesBefore))}</td><td>${escapeHtml(scopeNames(c.scopesAfter))}</td><td class="muted">${
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
  parts.push(hostBlock);
  return parts.filter(Boolean).join("\n");
}

/** The plan for creating the Event host role: what the engine will do, or why it can't. */
function renderHostReview(host: HostReview): string {
  const problems =
    host.problems.length > 0
      ? callout(
          "err",
          "The Event host role can't be created.",
          `${host.problems.join(" ")} Go back to Access and untick it, or apply is blocked.`,
          "alert",
        )
      : "";
  const ops =
    host.problems.length === 0 && host.operations.length > 0
      ? `<ul>${host.operations.map((o) => `<li>${escapeHtml(o)}</li>`).join("")}</ul>
  <p class="muted">Applying starts this as a background job and takes you to Role groups to follow it. The role has no Discord permissions and nobody is added to it. The group is mapped to Event hosts when the role exists; if the job fails, no group is mapped.</p>`
      : "";
  return `${problems}
<div class="card">
  <h2>Event host role</h2>
  ${ops || `<p class="muted">Not created.</p>`}
</div>`;
}
