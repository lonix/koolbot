import { describe, it, expect } from "@jest/globals";
import {
  renderRoleGroupsPage,
  type RoleGroupRow,
  type RoleGroupsPageProps,
} from "../../src/web/role-groups-views.js";

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
  roleMissing: false,
  memberCount: 3,
  roleLock: null,
  ...over,
});

const props = (
  over: Partial<RoleGroupsPageProps> = {},
): RoleGroupsPageProps => ({
  csrfToken: "tok",
  remainingMs: 1000,
  groups: [row()],
  roleOptions: [
    { id: "r1", name: "Moderator", memberCount: 3, lock: null, taken: true },
    {
      id: "r2",
      name: "Server Booster",
      memberCount: 40,
      lock: "managed",
      taken: false,
    },
    {
      id: "r3",
      name: "Above",
      memberCount: 1,
      lock: "hierarchy",
      taken: false,
    },
  ],
  plan: null,
  extraErrors: [],
  botScanUnavailable: false,
  botsMissing: 0,
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
  }) as unknown as RoleGroupsPageProps["plan"];

describe("renderRoleGroupsPage", () => {
  it("shows groups with role, members and capabilities, and a CSRF token on every form", () => {
    const html = renderRoleGroupsPage(props());
    expect(html).toContain("Mods");
    expect(html).toContain("@Moderator");
    expect(html).toContain(">3<");
    expect(html).toContain("staff");
    const forms = html.match(/<form /g)?.length ?? 0;
    const tokens = html.match(/name="_csrf" value="tok"/g)?.length ?? 0;
    expect(forms).toBeGreaterThan(0);
    expect(tokens).toBe(forms);
  });

  it("explains that groups are optional when there are none", () => {
    const html = renderRoleGroupsPage(props({ groups: [] }));
    expect(html).toContain("No groups yet");
    expect(html).toContain("keeps its current behaviour");
  });

  it("locks @everyone/hierarchy roles and offers managed roles as gate-only", () => {
    const html = renderRoleGroupsPage(props());
    expect(html).toMatch(/value="r3" disabled/);
    expect(html).toMatch(/value="r1" disabled/);
    expect(html).toMatch(/<option value="r2">@Server Booster/);
    expect(html).toContain("gate-only");
  });

  it("marks pending new roles, missing roles and locked groups", () => {
    const html = renderRoleGroupsPage(
      props({
        groups: [
          row({ id: "a", roleId: null, roleName: null, memberCount: null }),
          row({ id: "b", roleMissing: true }),
          row({ id: "c", roleLock: "hierarchy" }),
        ],
      }),
    );
    expect(html).toContain("created on apply");
    expect(html).toContain("role not found");
    expect(html).toContain("locked: at or above the bot");
  });

  it("disables the first up and last down buttons", () => {
    const html = renderRoleGroupsPage(
      props({
        groups: [row({ id: "a", name: "A" }), row({ id: "b", name: "B" })],
      }),
    );
    expect(html).toMatch(/aria-label="Move A up" disabled/);
    expect(html).toMatch(/aria-label="Move B down" disabled/);
    expect(html).not.toMatch(/aria-label="Move A down" disabled/);
  });

  it("offers Apply only for a clean plan with operations", () => {
    expect(renderRoleGroupsPage(props({ plan: plan() }))).toContain(
      'action="/admin/role-groups/apply"',
    );
    const blocked = renderRoleGroupsPage(
      props({
        plan: plan(),
        extraErrors: [{ code: "groups-do-not-fit", message: "No room" }],
      }),
    );
    expect(blocked).not.toContain('action="/admin/role-groups/apply"');
    expect(blocked).toContain("No room");
    expect(
      renderRoleGroupsPage(props({ plan: plan({ operations: [] }) })),
    ).not.toContain('action="/admin/role-groups/apply"');
    expect(
      renderRoleGroupsPage(
        props({ plan: plan({ errors: [{ code: "x", message: "bad" }] }) }),
      ),
    ).not.toContain('action="/admin/role-groups/apply"');
  });

  it("requires approval wording for deleting a pre-existing role, not a created one", () => {
    const existing = renderRoleGroupsPage(props());
    expect(existing).toContain('name="approveRoleDelete"');
    expect(existing).toContain("3 member(s)");
    const created = renderRoleGroupsPage(
      props({ groups: [row({ createdByKoolbot: true })] }),
    );
    expect(created).not.toContain('name="approveRoleDelete"');
    expect(created).toContain("KoolBot created it");
  });

  it("explains bot handling and notices when bots can't be listed", () => {
    expect(
      renderRoleGroupsPage(props({ plan: plan(), botsMissing: 2 })),
    ).toContain("2 bot(s) are not in the bot group");
    expect(
      renderRoleGroupsPage(props({ plan: plan(), botScanUnavailable: true })),
    ).toContain("Server Members intent");
  });

  it("shows a notice instead of a plan when Discord was unreachable", () => {
    const html = renderRoleGroupsPage(
      props({ planUnavailable: "Roles could not be read." }),
    );
    expect(html).toContain("Roles could not be read.");
  });

  it("escapes names and wires the job poller only for a job", () => {
    const html = renderRoleGroupsPage(
      props({ groups: [row({ name: "<img src=x onerror=1>" })] }),
    );
    expect(html).not.toContain("<img src=x");
    expect(html).not.toContain("/admin/role-groups/job/'+");
    const job = renderRoleGroupsPage(
      props({ jobId: "11111111-1111-1111-1111-111111111111" }),
    );
    expect(job).toContain('id="rg-job"');
    expect(job).toContain("11111111-1111-1111-1111-111111111111");
  });
});
