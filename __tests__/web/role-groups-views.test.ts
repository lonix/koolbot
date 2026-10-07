import { describe, it, expect } from "@jest/globals";
import {
  renderAdminFixPage,
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
  adminReport: null,
  adminGroupLacksAdministrator: false,
  membersUnavailable: false,
  roleNames: {},
  globalPolicy: "flag",
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

describe("sync with Discord (#1021)", () => {
  it("shows drift badges per group and a summary notice", () => {
    const html = renderRoleGroupsPage(
      props({
        groups: [
          row({
            drift: [
              {
                groupId: "g1",
                groupName: "Mods",
                kind: "permissions",
                detail: "Permissions in Discord differ <b>.",
              },
            ],
          }),
        ],
      }),
    );
    expect(html).toContain("1 group(s) differ from Discord");
    expect(html).toContain("permissions");
    expect(html).toContain("differ &lt;b&gt;");
    expect(html).not.toContain("differ <b>");
  });

  it("is quiet when nothing drifted", () => {
    expect(renderRoleGroupsPage(props())).not.toContain("differ from Discord");
  });

  it("shows an unlinked group with re-link choices, and no silent recreate", () => {
    const html = renderRoleGroupsPage(
      props({
        groups: [
          row({
            roleId: null,
            roleName: null,
            unlinked: true,
            lostRoleId: "r-old",
            memberCount: null,
          }),
        ],
        roleOptions: [
          { id: "r5", name: "Free", memberCount: 1, lock: null, taken: false },
          { id: "r6", name: "Taken", memberCount: 1, lock: null, taken: true },
          {
            id: "r7",
            name: "Top",
            memberCount: 1,
            lock: "hierarchy",
            taken: false,
          },
        ],
      }),
    );
    expect(html).toContain("unlinked: role deleted");
    expect(html).toContain("r-old");
    expect(html).toContain("does not recreate it on its own");
    expect(html).toContain('name="mode" value="recreate"');
    expect(html).toContain('<option value="r5">@Free</option>');
    expect(html).not.toContain('<option value="r6">');
    expect(html).not.toContain('<option value="r7">');
    expect(html).not.toContain("created on apply");
  });

  it("offers no recreate for an unlinked gate-only group", () => {
    const html = renderRoleGroupsPage(
      props({
        groups: [row({ roleId: null, unlinked: true, gateOnly: true })],
      }),
    );
    expect(html).not.toContain('value="recreate"');
    expect(html).toContain('value="link"');
  });

  it("offers a gate-only group only managed roles, and others only editable ones", () => {
    const options = [
      {
        id: "rm",
        name: "Booster",
        memberCount: 1,
        lock: "managed" as const,
        taken: false,
      },
      { id: "re", name: "Plain", memberCount: 1, lock: null, taken: false },
    ];
    const relinkOptions = (html: string): string =>
      /name="roleId" required>(.*?)<\/select>/s.exec(html)?.[1] ?? "";
    const gate = renderRoleGroupsPage(
      props({
        groups: [row({ roleId: null, unlinked: true, gateOnly: true })],
        roleOptions: options,
      }),
    );
    expect(relinkOptions(gate)).toContain(
      '<option value="rm">@Booster</option>',
    );
    expect(relinkOptions(gate)).not.toContain('<option value="re">');
    const plain = renderRoleGroupsPage(
      props({
        groups: [row({ roleId: null, unlinked: true })],
        roleOptions: options,
      }),
    );
    expect(relinkOptions(plain)).toContain(
      '<option value="re">@Plain</option>',
    );
    expect(relinkOptions(plain)).not.toContain('<option value="rm">');
  });

  it("lets a group pick its sync policy, defaulting to the global one", () => {
    const html = renderRoleGroupsPage(
      props({
        groups: [row({ syncPolicy: "adopt" })],
        globalPolicy: "enforce",
      }),
    );
    expect(html).toContain('name="syncPolicy"');
    expect(html).toContain("Use the global setting (Enforce");
    expect(html).toMatch(/<option value="adopt" selected>/);
  });

  describe("administrators and the admin group", () => {
    const report = {
      humans: [{ id: "u1", name: "Bob <b>", viaRoleIds: ["legacy"] }],
      bots: [
        { id: "kool", name: "KoolBot", viaRoleIds: ["bots"], self: true },
        { id: "b2", name: "Music", viaRoleIds: ["bots"] },
      ],
    };

    it("skips the report without an admin group and says why", () => {
      const html = renderRoleGroupsPage(props());
      expect(html).toContain("nothing to sync");
      expect(html).not.toContain("admin-fix");
    });

    it("says so when the member list is unavailable", () => {
      const html = renderRoleGroupsPage(props({ membersUnavailable: true }));
      expect(html).toContain("Server Members intent is off");
    });

    it("lists out-of-group humans unchecked, and bots apart", () => {
      const html = renderRoleGroupsPage(
        props({
          adminReport: report,
          roleNames: { legacy: "Old admins", bots: "Bots" },
        }),
      );
      expect(html).toContain('action="/admin/role-groups/admin-fix"');
      expect(html).toContain('name="move" value="u1"');
      expect(html).toContain('name="drop" value="legacy"');
      expect(html).toContain("Bob &lt;b&gt;");
      expect(html).not.toMatch(/name="(move|drop)"[^>]*checked/);
      expect(html).toContain("Bots with Administrator (2)");
      expect(html).toContain("(KoolBot)");
      expect(html).not.toContain('name="move" value="kool"');
      expect(html).not.toContain('name="drop" value="bots"');
    });

    it("offers giving the admin group Administrator as an unticked choice", () => {
      const html = renderRoleGroupsPage(
        props({
          adminReport: { humans: [], bots: [] },
          adminGroupLacksAdministrator: true,
        }),
      );
      expect(html).toContain("doesn't carry Administrator");
      expect(html).toContain('name="grant" value="1"');
      expect(html).not.toMatch(/name="grant"[^>]*checked/);
      expect(html).toContain('action="/admin/role-groups/admin-fix"');
    });

    it("still offers the grant when the member list is unavailable", () => {
      const html = renderRoleGroupsPage(
        props({
          membersUnavailable: true,
          adminGroupLacksAdministrator: true,
        }),
      );
      expect(html).toContain("Server Members intent is off");
      expect(html).toContain('name="grant" value="1"');
    });

    it("offers re-linking for a group whose role vanished before the sync noticed", () => {
      const html = renderRoleGroupsPage(
        props({ groups: [row({ roleMissing: true })] }),
      );
      expect(html).toContain('name="mode" value="recreate"');
      expect(html).toContain("does not recreate it on its own");
    });

    it("doesn't offer dropping a role a bot also holds Administrator through", () => {
      const html = renderRoleGroupsPage(
        props({
          adminReport: {
            humans: [
              { id: "u1", name: "Bob", viaRoleIds: ["legacy", "shared"] },
            ],
            bots: [{ id: "b2", name: "Music", viaRoleIds: ["shared"] }],
          },
          roleNames: { legacy: "Old admins", shared: "Staff bots" },
        }),
      );
      expect(html).toContain('name="drop" value="legacy"');
      expect(html).not.toContain('name="drop" value="shared"');
      expect(html).toContain('name="move" value="u1"');
    });

    it("confirms when everyone is in the group", () => {
      const html = renderRoleGroupsPage(
        props({ adminReport: { humans: [], bots: [] } }),
      );
      expect(html).toContain(
        "Everyone with Administrator is in the admin group",
      );
    });
  });
});

describe("renderAdminFixPage", () => {
  const p = (over = {}) => ({
    csrfToken: "tok",
    remainingMs: 1000,
    plan: plan() as NonNullable<RoleGroupsPageProps["plan"]>,
    extraErrors: [],
    moveIds: ["u1"],
    dropIds: ["legacy"],
    grant: false,
    losing: [],
    ...over,
  });

  it("previews the plan and offers apply with the choices carried over", () => {
    const html = renderAdminFixPage(p());
    expect(html).toContain('action="/admin/role-groups/admin-fix/apply"');
    expect(html).toContain('name="planId" value="plan-1"');
    expect(html).toContain('name="move" value="u1"');
    expect(html).toContain('name="drop" value="legacy"');
    expect(html).toContain('name="_csrf" value="tok"');
  });

  it("offers no apply when there are blocking problems", () => {
    const html = renderAdminFixPage(
      p({
        extraErrors: [{ code: "admin-lockout", message: "Your own access" }],
      }),
    );
    expect(html).toContain("Your own access");
    expect(html).not.toContain("admin-fix/apply");
  });

  it("carries the grant choice into the apply form", () => {
    const html = renderAdminFixPage(p({ grant: true }));
    expect(html).toContain('name="grant" value="1"');
    expect(renderAdminFixPage(p())).not.toContain('name="grant"');
  });

  it("names members who would lose Administrator", () => {
    const html = renderAdminFixPage(p({ losing: ["Bob <b>"] }));
    expect(html).toContain("1 member(s) lose Administrator");
    expect(html).toContain("Bob &lt;b&gt;");
  });
});
