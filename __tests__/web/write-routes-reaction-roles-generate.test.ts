/**
 * Route tests for POST /reaction-roles/group/generate (#1064): preset and
 * custom sources, mode handling and the audit trail.
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
  parseFlashRedirect,
  type AdminHarness,
} from "./admin-harness.js";

const mockRecordAudit = jest.fn(async () => undefined);
const mockProvision = jest.fn<() => Promise<unknown>>();

jest.unstable_mockModule("../../src/web/audit.js", () => ({
  recordAudit: mockRecordAudit,
}));
jest.unstable_mockModule("../../src/utils/logger.js", () => ({
  default: {
    info: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
    debug: jest.fn(),
  },
}));
jest.unstable_mockModule("../../src/services/reaction-role-service.js", () => ({
  ReactionRoleService: { getInstance: (): unknown => ({}) },
}));
jest.unstable_mockModule(
  "../../src/services/reaction-role-group-service.js",
  () => ({
    ReactionRoleGroupService: {
      getInstance: (): unknown => ({ provisionGroup: mockProvision }),
    },
  }),
);

const { createReactionRolesRouter } =
  await import("../../src/web/routes/write/reaction-roles.js");
const { requireCsrf } = await import("../../src/web/csrf.js");
const { requireAdminRoleMiddleware } = await import("../../src/web/session.js");

const client = { user: { id: "bot" } } as unknown as Client;
const session = createTestSession();
let harness: AdminHarness;

beforeEach(async () => {
  jest.clearAllMocks();
  mockProvision.mockResolvedValue({
    success: true,
    message: "Done.",
    groupId: "g1",
    createdRoles: ["r1"],
    reusedRoles: [],
    addedEntries: 1,
    skippedEntries: 0,
  });
  harness = await startAdminHarness([
    stubRequireSession(session),
    requireAdminRoleMiddleware(),
    requireCsrf,
    createReactionRolesRouter(client),
  ]);
});

afterEach(async () => {
  await harness.close();
});

describe("POST /reaction-roles/group/generate", () => {
  it("expands the regions preset with its default mode", async () => {
    const res = await harness.post("/reaction-roles/group/generate", {
      preset: "regions",
    });
    const call = mockProvision.mock.calls[0] as unknown as unknown[];
    expect(call[0]).toBe(session.guildId);
    expect(call[1]).toBe("Region");
    expect((call[2] as unknown[]).length).toBeGreaterThanOrEqual(5);
    expect(call[3]).toBe("unique");
    expect(parseFlashRedirect(res.headers.get("location")).type).toBe("ok");
    expect(mockRecordAudit).toHaveBeenCalledWith(
      session,
      expect.objectContaining({ action: "reactionrole.group.generate" }),
    );
  });

  it("rejects an unknown preset", async () => {
    const res = await harness.post("/reaction-roles/group/generate", {
      preset: "nope",
    });
    expect(parseFlashRedirect(res.headers.get("location")).msg).toBe(
      "Unknown preset.",
    );
    expect(mockProvision).not.toHaveBeenCalled();
  });

  it("pairs custom rows, drops blanks and honours the mode", async () => {
    await harness.post("/reaction-roles/group/generate", {
      preset: "custom",
      groupName: "Platform",
      mode: "toggle",
      roleName: ["PC", "", "Console"],
      emoji: ["🖥️", "x", "🎮"],
    });
    expect(mockProvision).toHaveBeenCalledWith(
      session.guildId,
      "Platform",
      [
        { roleName: "PC", emoji: "🖥️" },
        { roleName: "Console", emoji: "🎮" },
      ],
      "toggle",
    );
  });

  it("requires a name for a custom group", async () => {
    const res = await harness.post("/reaction-roles/group/generate", {
      preset: "custom",
      roleName: ["A"],
      emoji: ["🅰️"],
    });
    expect(parseFlashRedirect(res.headers.get("location")).msg).toBe(
      "Group name is required.",
    );
  });
});
