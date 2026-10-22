import { describe, it, expect, beforeEach, jest } from "@jest/globals";
import type { Guild } from "discord.js";

const mockList = jest.fn<(...a: any[]) => Promise<any[]>>();
const mockLink = jest.fn<(...a: any[]) => Promise<void>>();
const mockUses = jest.fn<(...a: any[]) => Promise<string[]>>();
const mockTrack = jest.fn<(...a: any[]) => Promise<void>>();
const mockScan = jest.fn<(...a: any[]) => Promise<any>>();
jest.unstable_mockModule("../../src/services/role-group-service.js", () => ({
  RoleGroupService: {
    getInstance: () => ({
      list: mockList,
      linkRole: mockLink,
      featureUsesOfRole: mockUses,
      trackRoleNames: mockTrack,
    }),
  },
  scanGuildRoles: mockScan,
}));
const mockSnapshots = jest.fn<(...a: any[]) => Promise<any[]>>();
jest.unstable_mockModule("../../src/models/adoption-snapshot.js", () => ({
  AdoptionSnapshot: {
    find: () => ({ sort: () => ({ limit: () => ({ lean: mockSnapshots }) }) }),
  },
}));
jest.unstable_mockModule("../../src/utils/logger.js", () => ({
  default: {
    info: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
    debug: jest.fn(),
  },
}));

const {
  planRoleGroups,
  planRoleDeletion,
  roleDeletionRevalidator,
  linkCreatedRoles,
  planIsApplicable,
  planAdminFix,
  adminGroupRoleIds,
} = await import("../../src/services/role-group-adoption.js");

const role = (id: string, position: number, over = {}) => ({
  id,
  name: `role-${id}`,
  color: 0,
  permissions: "0",
  position,
  managed: false,
  ...over,
});
const scanned = (over = {}) => ({
  guildId: "g",
  ownerId: "owner",
  botUserId: "kool",
  botRoleIds: ["botrole"],
  botHighestRolePosition: 20,
  adminUserId: "admin",
  adminRoleIds: [],
  otherBotIds: [],
  roles: [
    role("g", 0),
    role("r1", 3),
    role("botrole", 20, { permissions: "268435456" }),
  ],
  channels: [],
  config: {},
  boundChannelIds: [],
  koolbotCreatedIds: [],
  ...over,
});
const grp = (over = {}) => ({
  id: "g1",
  name: "Mods",
  roleId: "r1",
  rank: 1,
  permissions: null,
  capabilities: [],
  colour: null,
  createdByKoolbot: false,
  gateOnly: false,
  hoist: false,
  roleName: null,
  unlinked: false,
  lostRoleId: null,
  recreateRequestedAt: null,
  syncPolicy: null,
  driftSignature: null,
  createdAt: new Date(),
  ...over,
});
const guild = { id: "g" } as unknown as Guild;

beforeEach(() => {
  jest.clearAllMocks();
  mockUses.mockResolvedValue([]);
});

describe("planRoleGroups", () => {
  it("is empty when Discord already matches the groups", async () => {
    mockList.mockResolvedValue([grp()]);
    mockScan.mockResolvedValue({
      scanned: scanned(),
      memberCounts: new Map(),
      botIds: null,
    });
    const built = await planRoleGroups(guild, "admin");
    expect(built.plan.operations).toEqual([]);
    expect(planIsApplicable(built)).toBe(true);
    expect(mockScan).toHaveBeenCalledWith(
      guild,
      "admin",
      expect.any(Array),
      false,
      false,
    );
  });

  it("plans a role create for a group without a role", async () => {
    mockList.mockResolvedValue([grp({ roleId: null, permissions: "8" })]);
    mockScan.mockResolvedValue({
      scanned: scanned(),
      memberCounts: new Map(),
      botIds: null,
    });
    const built = await planRoleGroups(guild, "admin");
    expect(built.plan.operations.map((o) => o.type)).toContain("role.create");
  });

  it("reports when bots can't be listed for a bot group", async () => {
    mockList.mockResolvedValue([grp({ capabilities: ["bot"] })]);
    mockScan.mockResolvedValue({
      scanned: scanned(),
      memberCounts: new Map(),
      botIds: null,
    });
    const built = await planRoleGroups(guild, "admin");
    expect(built.botScanUnavailable).toBe(true);
    expect(mockScan).toHaveBeenCalledWith(
      guild,
      "admin",
      expect.any(Array),
      true,
      false,
    );
  });

  it("plans adding the missing bots and blocks when groups don't fit", async () => {
    mockList.mockResolvedValue([grp({ capabilities: ["bot"] })]);
    mockScan.mockResolvedValue({
      scanned: scanned({ otherBotIds: ["b1"], memberRoles: { b1: [] } }),
      memberCounts: new Map(),
      botIds: ["b1"],
    });
    const built = await planRoleGroups(guild, "admin");
    expect(built.plan.operations.map((o) => o.type)).toContain(
      "member.role.add",
    );

    mockList.mockResolvedValue([
      grp({ roleId: null }),
      grp({ id: "g2", name: "B", roleId: null, rank: 2 }),
    ]);
    mockScan.mockResolvedValue({
      scanned: scanned({ botHighestRolePosition: 1 }),
      memberCounts: new Map(),
      botIds: null,
    });
    const tight = await planRoleGroups(guild, "admin");
    expect(planIsApplicable(tight)).toBe(false);
  });
});

describe("planRoleDeletion", () => {
  beforeEach(() => {
    mockList.mockResolvedValue([grp()]);
    mockScan.mockResolvedValue({
      scanned: scanned(),
      memberCounts: new Map(),
      botIds: null,
    });
  });

  it("is not planned for a pre-existing role without approval", async () => {
    const { plan } = await planRoleDeletion(guild, "admin", grp(), false);
    expect(plan.operations).toEqual([]);
    expect(plan.errors.length).toBeGreaterThan(0);
  });

  it("plans a destructive delete once explicitly approved", async () => {
    const { plan, extraErrors } = await planRoleDeletion(
      guild,
      "admin",
      grp(),
      true,
    );
    expect(extraErrors).toEqual([]);
    expect(plan.errors).toEqual([]);
    expect(plan.operations).toEqual([
      expect.objectContaining({
        type: "role.delete",
        class: "destructive",
        roleId: "r1",
      }),
    ]);
  });

  it("gives the reviewed plan id back for the same approval stamp, so apply can compare ids (#1184)", async () => {
    const stamp = "2026-10-17T10:00:00.000Z";
    const first = await planRoleDeletion(guild, "admin", grp(), true, stamp);
    const again = await planRoleDeletion(guild, "admin", grp(), true, stamp);
    expect(again.plan.id).toBe(first.plan.id);
    const later = await planRoleDeletion(
      guild,
      "admin",
      grp(),
      true,
      "2026-10-17T10:05:00.000Z",
    );
    expect(later.plan.id).not.toBe(first.plan.id);
    // A different server state is a different plan id even with the same stamp.
    mockScan.mockResolvedValue({
      scanned: scanned({ koolbotCreatedIds: ["r1"] }),
      memberCounts: new Map(),
      botIds: null,
    });
    const moved = await planRoleDeletion(guild, "admin", grp(), false, stamp);
    expect(moved.plan.id).not.toBe(first.plan.id);
  });

  it("needs no approval for a role KoolBot created", async () => {
    mockScan.mockResolvedValue({
      scanned: scanned({ koolbotCreatedIds: ["r1"] }),
      memberCounts: new Map(),
      botIds: null,
    });
    const { plan } = await planRoleDeletion(
      guild,
      "admin",
      grp({ createdByKoolbot: true }),
      false,
    );
    expect(plan.errors).toEqual([]);
    expect(plan.operations).toHaveLength(1);
  });

  it("refuses while a feature still uses the role", async () => {
    mockUses.mockResolvedValue(["Leaderboard Roles"]);
    const { extraErrors } = await planRoleDeletion(guild, "admin", grp(), true);
    expect(extraErrors[0]).toMatchObject({ code: "role-in-use" });
    expect(extraErrors[0].message).toContain("Leaderboard Roles");
  });

  it("refuses a group that has no role", async () => {
    const { extraErrors } = await planRoleDeletion(
      guild,
      "admin",
      grp({ roleId: null }),
      true,
    );
    expect(extraErrors[0]).toMatchObject({ code: "no-role" });
  });
});

describe("roleDeletionRevalidator (#1097)", () => {
  const fresh = (over = {}) =>
    mockScan.mockResolvedValue({
      scanned: scanned(over),
      memberCounts: new Map(),
      botIds: null,
    });
  beforeEach(() => {
    mockList.mockResolvedValue([grp()]);
    mockUses.mockResolvedValue([]);
    fresh();
  });
  const pendingDelete = async () =>
    (await planRoleDeletion(guild, "admin", grp(), true)).plan.operations;

  it("accepts the pending delete while the role is unchanged", async () => {
    const pending = await pendingDelete();
    const check = roleDeletionRevalidator(guild, "admin", grp(), true);
    expect(await check(pending)).toEqual([]);
  });

  // Like the real scan: created-by-KoolBot ids come from the groups passed in.
  const scanFromGroups = () =>
    mockScan.mockImplementation(async (_g, _a, groups: any[]) => ({
      scanned: scanned({
        koolbotCreatedIds: groups
          .filter((x) => x.createdByKoolbot)
          .map((x) => x.roleId),
      }),
      memberCounts: new Map(),
      botIds: null,
    }));

  it("keeps the KoolBot-created exemption after the route removed the group", async () => {
    const created = grp({ createdByKoolbot: true });
    scanFromGroups();
    mockList.mockResolvedValue([created]);
    const pending = (await planRoleDeletion(guild, "admin", created, false))
      .plan.operations;
    expect(pending).toHaveLength(1);
    // The delete route removes the group right after startApply; the engine's
    // live check runs later, against a list that no longer has it.
    mockList.mockResolvedValue([]);
    const problems = await roleDeletionRevalidator(
      guild,
      "admin",
      created,
      false,
    )(pending);
    expect(problems).toEqual([]);
  });

  it("still needs approval for a pre-existing role once the group is gone", async () => {
    scanFromGroups();
    mockList.mockResolvedValue([]);
    const problems = await roleDeletionRevalidator(
      guild,
      "admin",
      grp(),
      false,
    )([{ type: "role.delete", class: "destructive", roleId: "r1" } as never]);
    expect(problems.length).toBeGreaterThan(0);
  });

  it("refuses when a feature started using the role since the preview", async () => {
    const pending = await pendingDelete();
    mockUses.mockResolvedValue(["Leaderboard Roles"]);
    const problems = await roleDeletionRevalidator(
      guild,
      "admin",
      grp(),
      true,
    )(pending);
    expect(problems.join(" ")).toContain("Leaderboard Roles");
  });

  it("refuses when the role became managed or rose above the bot", async () => {
    const pending = await pendingDelete();
    fresh({
      roles: [
        role("g", 0),
        role("r1", 30, { managed: true }),
        role("botrole", 20, { permissions: "268435456" }),
      ],
    });
    const problems = await roleDeletionRevalidator(
      guild,
      "admin",
      grp(),
      true,
    )(pending);
    expect(problems.length).toBeGreaterThan(0);
  });

  it("refuses when the role is gone and the delete no longer matches", async () => {
    const pending = await pendingDelete();
    fresh({ roles: [role("g", 0), role("botrole", 20)] });
    const problems = await roleDeletionRevalidator(
      guild,
      "admin",
      grp(),
      true,
    )(pending);
    expect(problems.join(" ")).toContain("no longer matches the live server");
  });
});

describe("linkCreatedRoles", () => {
  it("links a pending group to the role an applied snapshot created", async () => {
    mockList.mockResolvedValue([
      grp({ roleId: null, name: "Admin" }),
      grp({ id: "g2", name: "Linked" }),
    ]);
    mockSnapshots.mockResolvedValue([
      { createdRoles: [{ ref: "new:admin", roleId: "r99", name: "admin" }] },
    ]);
    expect(await linkCreatedRoles("g")).toBe(1);
    expect(mockLink).toHaveBeenCalledWith("g", "g1", "r99", true, "admin");
  });

  it("does nothing when nothing is pending", async () => {
    mockList.mockResolvedValue([grp()]);
    expect(await linkCreatedRoles("g")).toBe(0);
    expect(mockSnapshots).not.toHaveBeenCalled();
  });

  it("never throws when the snapshot lookup fails", async () => {
    mockList.mockResolvedValue([grp({ roleId: null })]);
    mockSnapshots.mockRejectedValue(new Error("db"));
    expect(await linkCreatedRoles("g")).toBe(0);
  });
});

describe("link safety for a repeated create", () => {
  it("never links a role an earlier apply created before the group existed", async () => {
    // "Event host" was created, then deleted with its group. A new group of the
    // same name must wait for its own apply, not take the old, gone role.
    mockList.mockResolvedValue([
      grp({
        roleId: null,
        name: "Event host",
        createdAt: new Date("2026-02-01"),
      }),
    ]);
    mockSnapshots.mockResolvedValue([
      {
        createdAt: new Date("2026-02-01T00:00:05Z"),
        createdRoles: [],
      },
      {
        createdAt: new Date("2026-01-01"),
        createdRoles: [{ roleId: "r-gone", name: "Event host" }],
      },
    ]);
    expect(await linkCreatedRoles("g")).toBe(0);
    expect(mockLink).not.toHaveBeenCalled();
  });

  it("links the role its own apply created", async () => {
    mockList.mockResolvedValue([
      grp({
        roleId: null,
        name: "Event host",
        createdAt: new Date("2026-02-01"),
      }),
    ]);
    mockSnapshots.mockResolvedValue([
      {
        createdAt: new Date("2026-02-01T00:00:05Z"),
        createdRoles: [{ roleId: "r-new", name: "Event host" }],
      },
      {
        createdAt: new Date("2026-01-01"),
        createdRoles: [{ roleId: "r-gone", name: "Event host" }],
      },
    ]);
    expect(await linkCreatedRoles("g")).toBe(1);
    expect(mockLink).toHaveBeenCalledWith(
      "g",
      "g1",
      "r-new",
      true,
      "Event host",
    );
  });
});

describe("link safety for recreated groups (#1021)", () => {
  it("never links an unlinked group", async () => {
    mockList.mockResolvedValue([
      grp({ roleId: null, unlinked: true, name: "Admin" }),
    ]);
    expect(await linkCreatedRoles("g")).toBe(0);
    expect(mockSnapshots).not.toHaveBeenCalled();
  });

  it("ignores roles created before the recreate was requested, and the lost role", async () => {
    mockList.mockResolvedValue([
      grp({
        roleId: null,
        name: "Admin",
        lostRoleId: "r-old",
        createdAt: new Date("2025-12-01"),
        recreateRequestedAt: new Date("2026-01-02"),
      }),
    ]);
    mockSnapshots.mockResolvedValue([
      {
        createdAt: new Date("2026-01-01"),
        createdRoles: [{ roleId: "r-older", name: "Admin" }],
      },
      {
        createdAt: new Date("2026-01-03"),
        createdRoles: [{ roleId: "r-old", name: "Admin" }],
      },
      {
        createdAt: new Date("2026-01-03"),
        createdRoles: [{ roleId: "r-new", name: "Admin" }],
      },
    ]);
    expect(await linkCreatedRoles("g")).toBe(1);
    expect(mockLink).toHaveBeenCalledWith("g", "g1", "r-new", true, "Admin");
  });
});

describe("admin group sync (#1021)", () => {
  const adminBot = (extra = {}) =>
    role("botrole", 20, { permissions: "8", ...extra });
  const members = [
    { id: "kool", name: "KoolBot", bot: true, roleIds: ["botrole"] },
    { id: "admin", name: "Alice", bot: false, roleIds: ["r1"] },
    { id: "u2", name: "Bob", bot: false, roleIds: ["r5"] },
    { id: "b9", name: "OtherBot", bot: true, roleIds: ["r5"] },
  ];
  const adminScan = (over = {}) => ({
    scanned: scanned({
      adminRoleIds: ["r1"],
      roles: [
        role("g", 0),
        role("r1", 3, { name: "Admin" }),
        role("r5", 4, { name: "Old admins", permissions: "8" }),
        adminBot(),
      ],
      memberRoles: {},
    }),
    memberCounts: new Map(),
    botIds: ["b9"],
    members,
    ...over,
  });

  it("flags an admin group lacking Administrator without folding it into the plan, and reports out-of-group administrators", async () => {
    mockList.mockResolvedValue([grp({ capabilities: ["admin"] })]);
    // The realistic bot role: ManageRoles, but not Administrator.
    mockScan.mockResolvedValue(
      adminScan({
        scanned: scanned({
          adminRoleIds: ["r1"],
          roles: [
            role("g", 0),
            role("r1", 3, { name: "Admin" }),
            role("r5", 4, { name: "Old admins", permissions: "8" }),
            role("botrole", 20, { permissions: "268435456" }),
          ],
          memberRoles: {},
        }),
      }),
    );
    const built = await planRoleGroups(guild, "admin");
    expect(mockScan).toHaveBeenCalledWith(
      guild,
      "admin",
      expect.any(Array),
      false,
      true,
    );
    // Reordering etc. stays applicable: no Administrator grant, no error.
    expect(built.plan.errors).toEqual([]);
    expect(built.plan.operations).toEqual([]);
    expect(planIsApplicable(built)).toBe(true);
    expect(built.adminReport?.humans.map((h) => h.id)).toEqual(["u2"]);
    expect(built.adminReport?.bots.map((b) => b.id)).toEqual(["b9"]);
    expect(built.drift.map((d) => d.kind)).toContain("admin-permission");
    expect(adminGroupRoleIds(built.groups)).toEqual(["r1"]);
  });

  it("starts tracking role names for groups linked before name tracking", async () => {
    mockList.mockResolvedValue([grp({ roleName: null })]);
    mockScan.mockResolvedValue({
      scanned: scanned(),
      memberCounts: new Map(),
      botIds: null,
      members: null,
    });
    const built = await planRoleGroups(guild, "admin");
    expect(mockTrack).toHaveBeenCalledWith("g", [
      { groupId: "g1", roleName: "role-r1" },
    ]);
    expect(built.groups[0].roleName).toBe("role-r1");
    expect(built.drift).toEqual([]);
  });

  it("resolves tracked names in memory and writes nothing for a transformed preview", async () => {
    mockList.mockResolvedValue([grp({ roleName: null })]);
    mockScan.mockResolvedValue({
      scanned: scanned(),
      memberCounts: new Map(),
      botIds: null,
      members: null,
    });
    const built = await planRoleGroups(guild, "admin", (saved) => [...saved]);
    expect(mockTrack).not.toHaveBeenCalled();
    expect(built.groups[0].roleName).toBe("role-r1");
    expect(built.drift).toEqual([]);
  });

  it("carries on when name tracking can't be saved", async () => {
    mockTrack.mockRejectedValue(new Error("db"));
    mockList.mockResolvedValue([grp({ roleName: null })]);
    mockScan.mockResolvedValue({
      scanned: scanned(),
      memberCounts: new Map(),
      botIds: null,
      members: null,
    });
    const built = await planRoleGroups(guild, "admin");
    expect(built.drift).toEqual([]);
  });

  it("skips the report and the member scan when there is no admin group", async () => {
    mockList.mockResolvedValue([grp()]);
    mockScan.mockResolvedValue({
      scanned: scanned(),
      memberCounts: new Map(),
      botIds: null,
      members: null,
    });
    const built = await planRoleGroups(guild, "admin");
    expect(built.adminReport).toBeNull();
    expect(built.membersUnavailable).toBe(false);
  });

  it("says so when the member list is unavailable", async () => {
    mockList.mockResolvedValue([grp({ capabilities: ["admin"] })]);
    mockScan.mockResolvedValue(adminScan({ members: null, botIds: null }));
    const built = await planRoleGroups(guild, "admin");
    expect(built.membersUnavailable).toBe(true);
    expect(built.adminReport).toBeNull();
  });

  it("plans moving a human into the admin group without touching roles", async () => {
    mockList.mockResolvedValue([
      grp({ capabilities: ["admin"], permissions: "8" }),
    ]);
    mockScan.mockResolvedValue(
      adminScan({
        scanned: scanned({
          adminRoleIds: ["r1"],
          roles: [
            role("g", 0),
            role("r1", 3, { permissions: "8" }),
            role("r5", 4, { permissions: "8" }),
            adminBot(),
          ],
          memberRoles: { u2: ["r5"] },
        }),
      }),
    );
    const { plan, extraErrors, moveKeepsAdmin } = await planAdminFix(
      guild,
      "admin",
      {
        moveMemberIds: ["u2"],
        dropRoleIds: [],
      },
    );
    expect(moveKeepsAdmin).toBe(true);
    expect(extraErrors).toEqual([]);
    expect(plan.errors).toEqual([]);
    expect(plan.operations).toEqual([
      expect.objectContaining({
        type: "member.role.add",
        roleId: "r1",
        memberIds: ["u2"],
      }),
    ]);
  });

  it("plans dropping Administrator from another role as a snapshotted edit", async () => {
    mockList.mockResolvedValue([
      grp({ capabilities: ["admin"], permissions: "8" }),
    ]);
    mockScan.mockResolvedValue(
      adminScan({
        members: members.filter((m) => m.id !== "b9"),
        scanned: scanned({
          adminRoleIds: ["r1"],
          roles: [
            role("g", 0),
            role("r1", 3, { permissions: "8" }),
            role("r5", 4, { permissions: "8200" }),
            adminBot(),
          ],
        }),
      }),
    );
    const { plan, extraErrors } = await planAdminFix(guild, "admin", {
      moveMemberIds: [],
      dropRoleIds: ["r5"],
    });
    expect(extraErrors).toEqual([]);
    expect(plan.operations).toEqual([
      expect.objectContaining({
        type: "role.edit",
        roleId: "r5",
        changes: { permissions: "8192" },
      }),
    ]);
  });

  it("plans giving the admin group Administrator as its own choice, without a member list", async () => {
    mockList.mockResolvedValue([grp({ capabilities: ["admin"] })]);
    mockScan.mockResolvedValue(adminScan({ members: null, botIds: null }));
    const { plan, extraErrors } = await planAdminFix(guild, "admin", {
      moveMemberIds: [],
      dropRoleIds: [],
      grantAdministrator: true,
    });
    expect(extraErrors).toEqual([]);
    expect(plan.errors).toEqual([]);
    expect(plan.operations).toEqual([
      expect.objectContaining({
        type: "role.edit",
        roleId: "r1",
        changes: { permissions: "8" },
      }),
    ]);
  });

  it("blocks the grant while KoolBot itself lacks Administrator", async () => {
    mockList.mockResolvedValue([grp({ capabilities: ["admin"] })]);
    mockScan.mockResolvedValue(
      adminScan({
        scanned: scanned({
          adminRoleIds: ["r1"],
          roles: [
            role("g", 0),
            role("r1", 3),
            role("botrole", 20, { permissions: "268435456" }),
          ],
        }),
      }),
    );
    const { plan } = await planAdminFix(guild, "admin", {
      moveMemberIds: [],
      dropRoleIds: [],
      grantAdministrator: true,
    });
    expect(plan.errors.map((e) => e.code)).toContain("bot-lacks-permission");
  });

  it("needs the member list to move or drop, and says so", async () => {
    mockList.mockResolvedValue([grp({ capabilities: ["admin"] })]);
    mockScan.mockResolvedValue(adminScan({ members: null, botIds: null }));
    const { extraErrors } = await planAdminFix(guild, "admin", {
      moveMemberIds: ["u2"],
      dropRoleIds: [],
    });
    expect(extraErrors[0]).toMatchObject({ code: "no-report" });
    expect(extraErrors[0].message).toContain("Server Members intent");
  });

  it("reports there is nothing to sync without an admin group", async () => {
    mockList.mockResolvedValue([grp()]);
    mockScan.mockResolvedValue(adminScan());
    const { extraErrors, plan } = await planAdminFix(guild, "admin", {
      moveMemberIds: [],
      dropRoleIds: [],
    });
    expect(extraErrors[0]).toMatchObject({ code: "no-report" });
    expect(plan.operations).toEqual([]);
  });
});
