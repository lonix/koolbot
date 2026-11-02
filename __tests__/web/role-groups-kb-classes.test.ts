import { describe, it, expect } from "@jest/globals";
import {
  renderAdminFixPage,
  renderRoleDeletePage,
  renderRoleGroupsPage,
  type RoleGroupRow,
  type RoleGroupsPageProps,
} from "../../src/web/role-groups-views.js";

/**
 * The Role groups pages render only `kb-` classes (#1649, epic #1639): no
 * `card`, `notice`, `tag`, `btn`, `subtitle`, `empty`, `muted`, `mono`,
 * `check`, `stack`, bare `<table>`, `<h1>`, `<h2>` or `<fieldset>`.
 *
 * Two things are out of the check on purpose: the plan diff
 * (`renderAdoptionDiff`, shared with other pages and migrated with them) and
 * the JavaScript hook `rg-preset` on the preset select.
 */

const JS_HOOKS = new Set(["rg-preset", "rg-perm-count"]);

const row = (over: Partial<RoleGroupRow> = {}): RoleGroupRow => ({
  id: "g1",
  name: "Mods",
  roleId: "r1",
  rank: 2,
  permissions: "0",
  capabilities: ["staff"],
  colour: null,
  hoist: false,
  createdByKoolbot: false,
  gateOnly: false,
  createdAt: new Date(),
  roleName: "Moderator",
  unlinked: false,
  lostRoleId: null,
  recreateRequestedAt: null,
  syncPolicy: null,
  driftSignature: null,
  roleMissing: false,
  memberCount: 3,
  roleLock: null,
  drift: [],
  ...over,
});

const plan = (over = {}) =>
  ({
    id: "plan-1",
    guildId: "g",
    plannedBy: "a",
    operations: [
      {
        id: "op1",
        type: "role.create",
        class: "additive",
        summary: "Create role Admin",
        before: null,
        after: { name: "Admin", permissions: "8" },
      },
    ],
    warnings: [],
    errors: [],
    baseline: { absentRoleNames: [], roles: [], channels: [], config: {} },
    ...over,
  }) as unknown as NonNullable<RoleGroupsPageProps["plan"]>;

const props = (
  over: Partial<RoleGroupsPageProps> = {},
): RoleGroupsPageProps => ({
  csrfToken: "tok",
  remainingMs: 1000,
  groups: [row()],
  roleOptions: [
    {
      id: "r2",
      name: "Booster",
      memberCount: 4,
      lock: "managed",
      taken: false,
    },
    { id: "r3", name: "Helpers", memberCount: 5, lock: null, taken: false },
  ],
  plan: null,
  extraErrors: [],
  botScanUnavailable: false,
  botsMissing: 0,
  adminReport: null,
  adminGroupLacksAdministrator: false,
  membersUnavailable: false,
  roleNames: { legacy: "Old admins" },
  globalPolicy: "flag",
  ...over,
});

const drift = [
  {
    groupId: "g1",
    groupName: "Mods",
    kind: "permissions" as const,
    detail: "Permissions in Discord differ.",
  },
];

const issues = [{ code: "admin-lockout", message: "Your own access" }];

const states: Array<[string, string]> = [
  ["no groups", renderRoleGroupsPage(props({ groups: [] }))],
  ["a group", renderRoleGroupsPage(props())],
  [
    "unlinked, role missing, gate-only, locked",
    renderRoleGroupsPage(
      props({
        groups: [
          row({ id: "g1", unlinked: true, lostRoleId: "r9", roleId: null }),
          row({ id: "g2", name: "Gone", roleMissing: true }),
          row({ id: "g3", name: "Boost", gateOnly: true, roleLock: "managed" }),
          row({ id: "g4", name: "New", roleId: null }),
          row({ id: "g5", name: "None", capabilities: [], memberCount: null }),
        ],
      }),
    ),
  ],
  [
    "drift",
    renderRoleGroupsPage(props({ groups: [row({ drift })], jobId: "job-1" })),
  ],
  [
    "plan that can apply, bots, extra errors",
    renderRoleGroupsPage(props({ plan: plan(), botsMissing: 2 })),
  ],
  [
    "plan with blockers and no bot scan",
    renderRoleGroupsPage(
      props({
        plan: plan({ errors: [{ code: "x", message: "Blocked" }] }),
        extraErrors: issues,
        botScanUnavailable: true,
      }),
    ),
  ],
  [
    "plan unavailable",
    renderRoleGroupsPage(
      props({ planUnavailable: "Roles could not be read." }),
    ),
  ],
  [
    "administrators to move, bots, grant",
    renderRoleGroupsPage(
      props({
        adminReport: {
          humans: [{ id: "u1", name: "Bob", viaRoleIds: ["legacy"] }],
          bots: [{ id: "b2", name: "Music", viaRoleIds: ["bots"], self: true }],
        },
        adminGroupLacksAdministrator: true,
      }),
    ),
  ],
  [
    "administrators all fine",
    renderRoleGroupsPage(props({ adminReport: { humans: [], bots: [] } })),
  ],
  [
    "member list unavailable",
    renderRoleGroupsPage(
      props({ membersUnavailable: true, adminGroupLacksAdministrator: true }),
    ),
  ],
  [
    "flash",
    renderRoleGroupsPage(props({ flash: { type: "ok", text: "Saved." } })),
  ],
  [
    "admin fix page",
    renderAdminFixPage({
      csrfToken: "tok",
      remainingMs: 1000,
      plan: plan(),
      extraErrors: [],
      moveIds: ["u1"],
      dropIds: ["legacy"],
      grant: true,
      losing: ["Bob"],
    }),
  ],
  [
    "admin fix page, blocked",
    renderAdminFixPage({
      csrfToken: "tok",
      remainingMs: 1000,
      plan: plan(),
      extraErrors: issues,
      moveIds: [],
      dropIds: [],
      grant: false,
      losing: [],
    }),
  ],
  [
    "delete role page",
    renderRoleDeletePage({
      csrfToken: "tok",
      remainingMs: 1000,
      groupId: "g1",
      groupName: "Mods",
      plan: plan(),
      extraErrors: [],
      approvedAt: "2026-10-17T10:00:00.000Z",
      reviewToken: "review-token",
      confirmName: "Mods",
      roleId: "r1",
      validForMinutes: 15,
    }),
  ],
  [
    "delete role page, blocked",
    renderRoleDeletePage({
      csrfToken: "tok",
      remainingMs: 1000,
      groupId: "g1",
      groupName: "Mods",
      plan: plan(),
      extraErrors: issues,
      approvedAt: "2026-10-17T10:00:00.000Z",
      reviewToken: null,
      confirmName: null,
      roleId: null,
      validForMinutes: 15,
    }),
  ],
];

/** The page's own content: `<main>` without scripts and without the shared plan diff. */
function content(html: string): string {
  const main = /<main[^>]*>([\s\S]*?)<\/main>/.exec(html)?.[1] ?? "";
  return main
    .replace(/<script[\s\S]*?<\/script>/g, "")
    .replace(/<section class="adoption-plan">[\s\S]*?<\/section>/g, "");
}

describe.each(states)("Role groups pages: %s", (_name, html) => {
  const body = content(html);

  it("renders content", () => {
    expect(body.length).toBeGreaterThan(100);
  });

  it("uses only kb- classes", () => {
    const tokens = [...body.matchAll(/\bclass="([^"]*)"/g)].flatMap((m) =>
      m[1].split(/\s+/).filter(Boolean),
    );
    const old = tokens.filter((t) => !t.startsWith("kb-") && !JS_HOOKS.has(t));
    expect([...new Set(old)]).toEqual([]);
  });

  it("has no bare table, heading, fieldset or inline style", () => {
    expect(body).not.toMatch(/<table(?![^>]*class="kb-table")/);
    expect(body).not.toMatch(/<h[1-3](?![^>]*class="kb-)/);
    expect(body).not.toContain("<fieldset");
    expect(body).not.toMatch(/\sstyle="/);
  });
});

describe("Role groups pages: one h1 and one primary button", () => {
  it.each(states)("%s", (_name, html) => {
    const body = content(html);
    expect(body.match(/<h1[ >]/g)?.length ?? 0).toBe(1);
    expect(body.match(/kb-btn--primary/g)?.length ?? 0).toBeLessThanOrEqual(1);
  });
});

describe("Role groups page behaviour kept through the migration", () => {
  it("keeps the apply job's id on the Callout title, which the poller rewrites", () => {
    const html = renderRoleGroupsPage(props({ jobId: "job-1" }));
    expect(html).toContain(
      '<p class="kb-callout__title" id="rg-job">Applying…</p>',
    );
  });

  it("offers every administrator choice as an unticked switch that posts the same field and value", () => {
    const html = renderRoleGroupsPage(
      props({
        adminReport: {
          humans: [{ id: "u1", name: "Bob", viaRoleIds: ["legacy"] }],
          bots: [],
        },
        adminGroupLacksAdministrator: true,
      }),
    );
    for (const [name, value] of [
      ["move", "u1"],
      ["drop", "legacy"],
      ["grant", "1"],
    ]) {
      expect(html).toMatch(
        new RegExp(
          `<input type="checkbox" role="switch"[^>]* name="${name}" value="${value}"(?![^>]*checked)`,
        ),
      );
    }
    expect(html).toContain(
      'method="GET" action="/admin/role-groups/admin-fix"',
    );
  });

  it("puts the blocking problems and the problems of the Discord sync above the Groups panel", () => {
    const html = renderRoleGroupsPage(props({ groups: [row({ drift })] }));
    expect(html.indexOf("differ from Discord")).toBeLessThan(
      html.indexOf('id="rg-groups"'),
    );
  });
});
