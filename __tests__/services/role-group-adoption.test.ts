import { describe, it, expect, beforeEach, jest } from "@jest/globals";
import type { Guild } from "discord.js";

const mockList = jest.fn<(...a: any[]) => Promise<any[]>>();
const mockLink = jest.fn<(...a: any[]) => Promise<void>>();
const mockUses = jest.fn<(...a: any[]) => Promise<string[]>>();
const mockScan = jest.fn<(...a: any[]) => Promise<any>>();
jest.unstable_mockModule("../../src/services/role-group-service.js", () => ({
  RoleGroupService: {
    getInstance: () => ({
      list: mockList,
      linkRole: mockLink,
      featureUsesOfRole: mockUses,
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

const { planRoleGroups, planRoleDeletion, linkCreatedRoles, planIsApplicable } =
  await import("../../src/services/role-group-adoption.js");

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
    expect(mockLink).toHaveBeenCalledWith("g", "g1", "r99", true);
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
