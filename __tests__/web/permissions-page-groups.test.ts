/**
 * GET /admin/permissions with role groups (#1023): the page must tell "no
 * groups" apart from "groups couldn't be read", because the runtime check
 * refuses the moderation commands in the second case.
 */

import {
  describe,
  it,
  expect,
  jest,
  beforeEach,
  afterEach,
} from "@jest/globals";
import type { Client } from "discord.js";
import {
  startAdminHarness,
  stubRequireSession,
  createTestSession,
  type AdminHarness,
} from "./admin-harness.js";

jest.unstable_mockModule("../../src/utils/logger.js", () => ({
  default: {
    info: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
    debug: jest.fn(),
  },
  isDebugMode: jest.fn(() => false),
}));

jest.unstable_mockModule("../../src/services/config-service.js", () => ({
  ConfigService: {
    getInstance: (): unknown => ({
      getBoolean: jest.fn(async () => false),
      getString: jest.fn(async () => ""),
      getNumber: jest.fn(async () => 0),
      getAll: jest.fn(async () => []),
      get: jest.fn(async () => null),
      registerReloadCallback: jest.fn(),
    }),
  },
}));

jest.unstable_mockModule("../../src/services/permissions-service.js", () => ({
  PermissionCheckError: class PermissionCheckError extends Error {},
  PermissionsService: {
    getInstance: (): unknown => ({
      listAllPermissions: jest.fn(async () => []),
    }),
  },
}));

const { RoleGroupService } =
  await import("../../src/services/role-group-service.js");
const { createReadOnlyRouter } =
  await import("../../src/web/read-only-routes.js");

const client = {
  user: { id: "bot" },
  guilds: {
    fetch: jest.fn(async () => {
      throw new Error("discord down");
    }),
  },
  commands: new Map([
    ["warn", {}],
    ["ping", {}],
  ]),
} as unknown as Client;

let harness: AdminHarness;

beforeEach(async () => {
  harness = await startAdminHarness([
    createReadOnlyRouter(client, stubRequireSession(createTestSession())),
  ]);
});

afterEach(async () => {
  jest.restoreAllMocks();
  await harness.close();
});

const page = async (): Promise<string> =>
  (await harness.get("/permissions")).text();

describe("GET /permissions", () => {
  it("marks the moderation commands staff only when a staff group exists", async () => {
    jest.spyOn(RoleGroupService.getInstance(), "list").mockResolvedValue([
      {
        id: "g1",
        name: "Mods",
        rank: 1,
        roleId: "r1",
        capabilities: ["staff"],
      },
    ] as never);
    const html = await page();
    expect(html).toContain("staff only (default)");
    expect(html).toContain("Mods and above (group)");
  });

  it("shows them as open when the guild has no groups", async () => {
    jest.spyOn(RoleGroupService.getInstance(), "list").mockResolvedValue([]);
    const html = await page();
    expect(html).not.toContain("staff only (default)");
    expect(html).not.toContain("role groups unavailable");
    expect(html).toContain("open");
  });

  it("shows an unknown status, not open, when the groups can't be read", async () => {
    jest
      .spyOn(RoleGroupService.getInstance(), "list")
      .mockRejectedValue(new Error("database offline"));
    const html = await page();
    expect(html).toContain("unknown (role groups unavailable)");
    expect(html).not.toContain("staff only (default)");
    expect(html).toContain("couldn't be read");
  });
});
