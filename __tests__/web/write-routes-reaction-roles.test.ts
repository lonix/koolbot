/**
 * Route-handler tests for the Reaction Roles write router (issue #849).
 *
 * Reaction-role management is configuration and lives only in the Web UI
 * (issue #812 closed the "add /reactrole back" request), so this router is
 * the sole way to create a role, bind an emoji, or tear a mapping down —
 * and it was at ~6% coverage. The tests pin the validation, the mode
 * fallbacks that keep a crafted form value out of the DB enum, and the
 * positional pairing of the group form's parallel arrays.
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
const mockCreateReactionRole = jest.fn<() => Promise<unknown>>();
const mockBindReactionRole = jest.fn<() => Promise<unknown>>();
const mockRemoveReactionRoleMapping = jest.fn<() => Promise<unknown>>();
const mockArchiveReactionRole = jest.fn<() => Promise<unknown>>();
const mockUnarchiveReactionRole = jest.fn<() => Promise<unknown>>();
const mockDeleteReactionRole = jest.fn<() => Promise<unknown>>();
const mockCreateReactionRoleGroup = jest.fn<() => Promise<unknown>>();
const mockDeleteReactionRoleGroup = jest.fn<() => Promise<unknown>>();

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
  ReactionRoleService: {
    getInstance: (): unknown => ({
      createReactionRole: mockCreateReactionRole,
      bindReactionRole: mockBindReactionRole,
      removeReactionRoleMapping: mockRemoveReactionRoleMapping,
      archiveReactionRole: mockArchiveReactionRole,
      unarchiveReactionRole: mockUnarchiveReactionRole,
      deleteReactionRole: mockDeleteReactionRole,
      createReactionRoleGroup: mockCreateReactionRoleGroup,
      deleteReactionRoleGroup: mockDeleteReactionRoleGroup,
    }),
  },
}));

const { createReactionRolesRouter } =
  await import("../../src/web/routes/write/reaction-roles.js");
const { requireCsrf } = await import("../../src/web/csrf.js");
const { requireAdminRoleMiddleware } = await import("../../src/web/session.js");

const client = { user: { id: "bot" } } as unknown as Client;
const session = createTestSession();
let harness: AdminHarness;

const OK = { success: true, message: "Done." };

beforeEach(async () => {
  jest.clearAllMocks();
  mockCreateReactionRole.mockResolvedValue({ ...OK, roleId: "role-1" });
  mockBindReactionRole.mockResolvedValue({ ...OK, roleId: "role-1" });
  mockRemoveReactionRoleMapping.mockResolvedValue(OK);
  mockArchiveReactionRole.mockResolvedValue(OK);
  mockUnarchiveReactionRole.mockResolvedValue(OK);
  mockDeleteReactionRole.mockResolvedValue(OK);
  mockCreateReactionRoleGroup.mockResolvedValue({ ...OK, groupId: "group-1" });
  mockDeleteReactionRoleGroup.mockResolvedValue(OK);
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

function lastAudit(): Record<string, unknown> {
  const calls = mockRecordAudit.mock.calls;
  expect(calls.length).toBeGreaterThan(0);
  return calls[calls.length - 1][1] as Record<string, unknown>;
}

describe("POST /reaction-roles/create", () => {
  it("requires both a role name and an emoji", async () => {
    const res = await harness.post("/reaction-roles/create", { name: "VIP" });
    const flash = parseFlashRedirect(res.headers.get("location"));
    expect(flash.path).toBe("/admin/reaction-roles");
    expect(flash.msg).toBe("Role name and emoji are both required.");
    expect(mockCreateReactionRole).not.toHaveBeenCalled();
  });

  it("rejects a role name past Discord's 100-character cap", async () => {
    const res = await harness.post("/reaction-roles/create", {
      name: "v".repeat(101),
      emoji: "🎉",
    });
    expect(parseFlashRedirect(res.headers.get("location")).msg).toBe(
      "Role name must be 100 characters or fewer.",
    );
    expect(mockCreateReactionRole).not.toHaveBeenCalled();
  });

  it("rejects an oversized emoji field", async () => {
    const res = await harness.post("/reaction-roles/create", {
      name: "VIP",
      emoji: "e".repeat(101),
    });
    expect(parseFlashRedirect(res.headers.get("location")).msg).toBe(
      "Emoji input must be 100 characters or fewer.",
    );
  });

  it("creates the role with the requested sticky mode (#814)", async () => {
    const res = await harness.post("/reaction-roles/create", {
      name: "VIP",
      emoji: "🎉",
      mode: "sticky",
      createChannel: "on",
    });
    expect(mockCreateReactionRole).toHaveBeenCalledWith(
      session.guildId,
      "VIP",
      "🎉",
      { createChannel: true, mode: "sticky" },
    );
    expect(parseFlashRedirect(res.headers.get("location")).type).toBe("ok");
    expect(lastAudit()).toMatchObject({
      action: "reactionrole.create",
      targetId: "role-1",
      result: "success",
      details: { mode: "sticky", createChannel: true },
    });
  });

  it("falls back to toggle so a crafted mode can't reach the DB enum", async () => {
    await harness.post("/reaction-roles/create", {
      name: "VIP",
      emoji: "🎉",
      mode: "drop-tables",
    });
    expect(mockCreateReactionRole.mock.calls[0][3]).toMatchObject({
      mode: "toggle",
    });
  });

  it("surfaces an unsuccessful service result as an error flash", async () => {
    mockCreateReactionRole.mockResolvedValue({
      success: false,
      message: "Missing Manage Roles.",
      roleId: null,
    });
    const res = await harness.post("/reaction-roles/create", {
      name: "VIP",
      emoji: "🎉",
    });
    const flash = parseFlashRedirect(res.headers.get("location"));
    expect(flash.type).toBe("err");
    expect(flash.msg).toBe("Missing Manage Roles.");
    expect(lastAudit()).toMatchObject({
      result: "failure",
      errorMessage: "Missing Manage Roles.",
    });
  });

  it("turns a thrown service call into a flash", async () => {
    mockCreateReactionRole.mockRejectedValue(new Error("rate limited"));
    const res = await harness.post("/reaction-roles/create", {
      name: "VIP",
      emoji: "🎉",
    });
    const flash = parseFlashRedirect(res.headers.get("location"));
    expect(flash.type).toBe("err");
    expect(flash.msg).toContain("rate limited");
    expect(lastAudit()).toMatchObject({ result: "failure" });
  });
});

describe("POST /reaction-roles/bind and /remove-mapping", () => {
  it("requires a role id and an emoji to bind", async () => {
    const res = await harness.post("/reaction-roles/bind", { emoji: "🎉" });
    expect(parseFlashRedirect(res.headers.get("location")).msg).toBe(
      "Role ID and emoji are both required.",
    );
    expect(mockBindReactionRole).not.toHaveBeenCalled();
  });

  it("binds to a new message when no message id was supplied", async () => {
    await harness.post("/reaction-roles/bind", {
      roleId: "role-1",
      emoji: "🎉",
    });
    expect(mockBindReactionRole).toHaveBeenCalledWith(
      session.guildId,
      "role-1",
      "🎉",
      {},
    );
  });

  it("binds onto an existing message when one was supplied", async () => {
    await harness.post("/reaction-roles/bind", {
      roleId: "role-1",
      emoji: "🎉",
      messageId: "message-7",
    });
    expect(mockBindReactionRole).toHaveBeenCalledWith(
      session.guildId,
      "role-1",
      "🎉",
      { messageId: "message-7" },
    );
    expect(lastAudit()).toMatchObject({
      action: "reactionrole.bind",
      details: { messageId: "message-7" },
    });
  });

  it("requires a message id and emoji to remove a mapping", async () => {
    const res = await harness.post("/reaction-roles/remove-mapping", {
      emoji: "🎉",
    });
    expect(parseFlashRedirect(res.headers.get("location")).msg).toBe(
      "Message ID and emoji are both required.",
    );
    expect(mockRemoveReactionRoleMapping).not.toHaveBeenCalled();
  });

  it("removes a mapping scoped to the session's guild", async () => {
    const res = await harness.post("/reaction-roles/remove-mapping", {
      messageId: "message-7",
      emoji: "🎉",
    });
    expect(mockRemoveReactionRoleMapping).toHaveBeenCalledWith(
      session.guildId,
      "message-7",
      "🎉",
    );
    expect(parseFlashRedirect(res.headers.get("location")).type).toBe("ok");
  });
});

describe("POST /reaction-roles/{archive,unarchive,delete}", () => {
  it.each([
    ["archive", mockArchiveReactionRole, "reactionrole.archive"],
    ["unarchive", mockUnarchiveReactionRole, "reactionrole.unarchive"],
    ["delete", mockDeleteReactionRole, "reactionrole.delete"],
  ])("%s requires a mapping id", async (path, serviceMock) => {
    const res = await harness.post(`/reaction-roles/${path}`, {});
    expect(parseFlashRedirect(res.headers.get("location")).msg).toBe(
      "Mapping id is required.",
    );
    expect(serviceMock).not.toHaveBeenCalled();
    expect(mockRecordAudit).not.toHaveBeenCalled();
  });

  it.each([
    ["archive", mockArchiveReactionRole, "reactionrole.archive"],
    ["unarchive", mockUnarchiveReactionRole, "reactionrole.unarchive"],
    ["delete", mockDeleteReactionRole, "reactionrole.delete"],
  ])(
    "%s passes the guild and mapping id and audits it",
    async (path, serviceMock, action) => {
      const res = await harness.post(`/reaction-roles/${path}`, {
        mappingId: "mapping-3",
      });
      expect(serviceMock).toHaveBeenCalledWith(session.guildId, "mapping-3");
      expect(parseFlashRedirect(res.headers.get("location")).type).toBe("ok");
      expect(lastAudit()).toMatchObject({
        action,
        targetId: "mapping-3",
        result: "success",
      });
    },
  );
});

describe("POST /reaction-roles/group/create", () => {
  it("requires a group name", async () => {
    const res = await harness.post("/reaction-roles/group/create", {
      roleName: ["A", "B"],
      emoji: ["🅰️", "🅱️"],
    });
    expect(parseFlashRedirect(res.headers.get("location")).msg).toBe(
      "Group name is required.",
    );
    expect(mockCreateReactionRoleGroup).not.toHaveBeenCalled();
  });

  it("requires at least two complete role/emoji rows", async () => {
    const res = await harness.post("/reaction-roles/group/create", {
      groupName: "Pronouns",
      roleName: ["A", "B"],
      // The second row's emoji is blank, so only one usable pair remains.
      emoji: ["🅰️", ""],
    });
    expect(parseFlashRedirect(res.headers.get("location")).msg).toBe(
      "A role group needs at least two role/emoji options.",
    );
    expect(mockCreateReactionRoleGroup).not.toHaveBeenCalled();
  });

  it("pairs the parallel arrays positionally and defaults to unique mode", async () => {
    const res = await harness.post("/reaction-roles/group/create", {
      groupName: "Pronouns",
      roleName: ["  she/her ", "he/him", "they/them"],
      emoji: ["🅰️", "🅱️", "🆎"],
    });
    expect(mockCreateReactionRoleGroup).toHaveBeenCalledWith(
      session.guildId,
      "Pronouns",
      [
        { roleName: "she/her", emoji: "🅰️" },
        { roleName: "he/him", emoji: "🅱️" },
        { roleName: "they/them", emoji: "🆎" },
      ],
      "unique",
    );
    expect(parseFlashRedirect(res.headers.get("location")).type).toBe("ok");
    expect(lastAudit()).toMatchObject({
      action: "reactionrole.group.create",
      targetId: "group-1",
      details: { count: 3, mode: "unique" },
    });
  });

  it("honours an explicit toggle mode", async () => {
    await harness.post("/reaction-roles/group/create", {
      groupName: "Games",
      roleName: ["A", "B"],
      emoji: ["🅰️", "🅱️"],
      mode: "toggle",
    });
    expect(mockCreateReactionRoleGroup.mock.calls[0][3]).toBe("toggle");
  });

  it("requires a group id to delete", async () => {
    const res = await harness.post("/reaction-roles/group/delete", {});
    expect(parseFlashRedirect(res.headers.get("location")).msg).toBe(
      "Group id is required.",
    );
    expect(mockDeleteReactionRoleGroup).not.toHaveBeenCalled();
  });

  it("deletes a group scoped to the session's guild", async () => {
    const res = await harness.post("/reaction-roles/group/delete", {
      groupId: "group-1",
    });
    expect(mockDeleteReactionRoleGroup).toHaveBeenCalledWith(
      session.guildId,
      "group-1",
    );
    expect(parseFlashRedirect(res.headers.get("location")).type).toBe("ok");
    expect(lastAudit()).toMatchObject({
      action: "reactionrole.group.delete",
      result: "success",
    });
  });
});
