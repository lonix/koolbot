import { describe, it, expect, jest, beforeEach } from "@jest/globals";
import type { Client } from "discord.js";

const mockPlanFix = jest.fn<(...a: any[]) => Promise<any>>();
const mockPlanRoles = jest.fn<(...a: any[]) => Promise<any>>();
const mockPlanDelete = jest.fn<(...a: any[]) => Promise<any>>();
const mockGetGroup = jest.fn<(...a: any[]) => Promise<any>>();
jest.unstable_mockModule("../../src/services/role-group-adoption.js", () => ({
  planAdminFix: mockPlanFix,
  planRoleGroups: mockPlanRoles,
  planRoleDeletion: mockPlanDelete,
  linkCreatedRoles: jest.fn(),
}));
const mockFeatureUses =
  jest.fn<(...a: any[]) => Promise<Map<string, string[]>>>();
jest.unstable_mockModule("../../src/services/role-group-service.js", () => ({
  RoleGroupService: {
    getInstance: () => ({
      list: jest.fn(async () => []),
      get: mockGetGroup,
      featureRoleUses: mockFeatureUses,
    }),
  },
}));
jest.unstable_mockModule("../../src/services/config-service.js", () => ({
  ConfigService: {
    getInstance: () => ({ getString: jest.fn(async () => "flag") }),
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

const { loadAdminFixPreview, loadRoleDeletePreview, loadRoleGroupsPage } =
  await import("../../src/web/role-groups-page.js");

const client = {
  guilds: { fetch: jest.fn(async () => ({})) },
} as unknown as Client;
const report = {
  humans: [
    { id: "u1", name: "Alice", viaRoleIds: ["legacy"] },
    { id: "u2", name: "Bob", viaRoleIds: ["legacy"] },
    { id: "u3", name: "Cy", viaRoleIds: ["legacy", "other"] },
  ],
  bots: [],
};

beforeEach(() => {
  jest.clearAllMocks();
});

describe("loadAdminFixPreview", () => {
  const built = (moveKeepsAdmin: boolean) => ({
    plan: { id: "p" },
    extraErrors: [],
    report,
    moveKeepsAdmin,
  });

  it("warns about members who lose their last Administrator source", async () => {
    mockPlanFix.mockResolvedValue(built(true));
    const out = await loadAdminFixPreview(
      client,
      "g",
      "me",
      [],
      ["legacy"],
      false,
    );
    expect(out.losing).toEqual(["Alice", "Bob"]);
    expect(out.grant).toBe(false);
  });

  it("doesn't warn for a moved member when the admin role carries Administrator", async () => {
    mockPlanFix.mockResolvedValue(built(true));
    const out = await loadAdminFixPreview(
      client,
      "g",
      "me",
      ["u1"],
      ["legacy"],
      false,
    );
    expect(out.losing).toEqual(["Bob"]);
  });

  it("still warns for a moved member when the admin role lacks Administrator and it isn't granted", async () => {
    mockPlanFix.mockResolvedValue(built(false));
    const out = await loadAdminFixPreview(
      client,
      "g",
      "me",
      ["u1"],
      ["legacy"],
      false,
    );
    expect(out.losing).toEqual(["Alice", "Bob"]);
  });

  it("passes the grant choice through", async () => {
    mockPlanFix.mockResolvedValue(built(true));
    const out = await loadAdminFixPreview(
      client,
      "g",
      "me",
      ["u1"],
      ["legacy"],
      true,
    );
    expect(mockPlanFix.mock.calls[0][2]).toEqual({
      moveMemberIds: ["u1"],
      dropRoleIds: ["legacy"],
      grantAdministrator: true,
    });
    expect(out.grant).toBe(true);
  });
});

describe("loadRoleGroupsPage role options (#1023)", () => {
  const built = {
    groups: [{ id: "g1", roleId: "rGroup", capabilities: [], gateOnly: false }],
    scan: {
      scanned: {
        guildId: "g",
        botHighestRolePosition: 50,
        roles: [
          { id: "rGroup", name: "Mod", position: 3, managed: false },
          { id: "rBday", name: "Birthday", position: 2, managed: false },
          { id: "rFree", name: "Free", position: 1, managed: false },
        ],
      },
      memberCounts: new Map<string, number>(),
      botIds: null,
    },
    plan: { id: "p" },
    extraErrors: [],
    botScanUnavailable: false,
    drift: [],
    adminReport: null,
    membersUnavailable: false,
  };

  it("marks the roles features hold, and leaves the rest free", async () => {
    mockPlanRoles.mockResolvedValue(built);
    mockFeatureUses.mockResolvedValue(new Map([["rBday", ["Birthdays"]]]));
    const out = await loadRoleGroupsPage(client, "g", "me");
    const byId = Object.fromEntries(out.roleOptions.map((r) => [r.id, r]));
    expect(byId.rBday.usedBy).toEqual(["Birthdays"]);
    expect(byId.rFree.usedBy).toEqual([]);
    expect(byId.rGroup.taken).toBe(true);
  });

  it("falls back to no filtering when the features can't be read", async () => {
    mockPlanRoles.mockResolvedValue(built);
    mockFeatureUses.mockRejectedValue(new Error("db down"));
    const out = await loadRoleGroupsPage(client, "g", "me");
    expect(out.roleOptions.every((r) => r.usedBy?.length === 0)).toBe(true);
  });
});

describe("loadRoleDeletePreview (#1184)", () => {
  const STAMP = "2026-10-17T10:00:00.000Z";
  const deletePlan = {
    id: "p1",
    errors: [],
    operations: [
      {
        type: "role.delete",
        class: "destructive",
        before: { name: "Mods", permissions: "0" },
      },
    ],
  };

  it("plans the deletion with the caller's stamp and reads the name to confirm from the plan", async () => {
    mockGetGroup.mockResolvedValue({
      id: "g1",
      name: "Moderators",
      roleId: "r1",
      createdByKoolbot: false,
    });
    mockPlanDelete.mockResolvedValue({ plan: deletePlan, extraErrors: [] });
    const out = await loadRoleDeletePreview(client, "g", "me", "g1", STAMP);
    expect(mockPlanDelete).toHaveBeenCalledWith(
      expect.anything(),
      "me",
      expect.objectContaining({ id: "g1" }),
      true,
      STAMP,
    );
    expect(out).toMatchObject({
      groupId: "g1",
      groupName: "Moderators",
      confirmName: "Mods",
      approvedAt: STAMP,
      roleId: "r1",
    });
  });

  it("plans a KoolBot-created role without an approval", async () => {
    mockGetGroup.mockResolvedValue({
      id: "g1",
      name: "Moderators",
      roleId: "r1",
      createdByKoolbot: true,
    });
    mockPlanDelete.mockResolvedValue({ plan: deletePlan, extraErrors: [] });
    await loadRoleDeletePreview(client, "g", "me", "g1", STAMP);
    expect(mockPlanDelete.mock.calls[0][3]).toBe(false);
  });

  it("offers no name to confirm when the plan has no role delete step", async () => {
    mockGetGroup.mockResolvedValue({ id: "g1", name: "M", roleId: "r1" });
    mockPlanDelete.mockResolvedValue({
      plan: { id: "p", errors: [], operations: [] },
      extraErrors: [],
    });
    const out = await loadRoleDeletePreview(client, "g", "me", "g1", STAMP);
    expect(out?.confirmName).toBeNull();
  });

  it("returns null for an unknown group and plans nothing", async () => {
    mockGetGroup.mockResolvedValue(null);
    expect(
      await loadRoleDeletePreview(client, "g", "me", "x", STAMP),
    ).toBeNull();
    expect(mockPlanDelete).not.toHaveBeenCalled();
  });

  it("fails closed: a Discord outage throws instead of offering a plan", async () => {
    mockGetGroup.mockResolvedValue({ id: "g1", name: "M", roleId: "r1" });
    const down = {
      guilds: {
        fetch: jest.fn(async () => {
          throw new Error("down");
        }),
      },
    } as unknown as Client;
    await expect(
      loadRoleDeletePreview(down, "g", "me", "g1", STAMP),
    ).rejects.toThrow("down");
    expect(mockPlanDelete).not.toHaveBeenCalled();
  });
});
