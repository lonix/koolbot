import { describe, it, expect, jest, beforeEach } from "@jest/globals";
import type { Client } from "discord.js";

const mockPlanFix = jest.fn<(...a: any[]) => Promise<any>>();
jest.unstable_mockModule("../../src/services/role-group-adoption.js", () => ({
  planAdminFix: mockPlanFix,
  planRoleGroups: jest.fn(),
  linkCreatedRoles: jest.fn(),
}));
jest.unstable_mockModule("../../src/services/role-group-service.js", () => ({
  RoleGroupService: { getInstance: () => ({ list: jest.fn(async () => []) }) },
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

const { loadAdminFixPreview } =
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
