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
import { refusal } from "./refused-form-test-utils.js";

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

jest.unstable_mockModule(
  "../../src/services/reaction-role-group-service.js",
  () => ({
    ReactionRoleGroupService: { getInstance: (): unknown => ({}) },
  }),
);

const { createReactionRolesRouter } =
  await import("../../src/web/routes/write/reaction-roles.js");
const { requireCsrf } = await import("../../src/web/csrf.js");
const { requireAdminRoleMiddleware } = await import("../../src/web/session.js");
const { registerFormPage } = await import("../../src/web/form-pages.js");
const { renderReactionRolesPage } =
  await import("../../src/web/admin-views.js");

const client = { user: { id: "bot" } } as unknown as Client;
const session = createTestSession();
let harness: AdminHarness;

const OK = { success: true, message: "Done." };

// The read router registers the page's renderer in the app (#1520); here the
// real view stands in, so a refusal is checked as the markup the person gets.
const registerPage = (): void =>
  registerFormPage("/admin/reaction-roles", async (_req, refused) =>
    renderReactionRolesPage({
      guildId: "guild-1",
      csrfToken: "csrf",
      remainingMs: 1000,
      navFeatureStatus: {},
      enabled: true,
      configChannel: null,
      active: [],
      archived: [],
      refusedForm: refused,
    }),
  );

beforeEach(async () => {
  jest.clearAllMocks();
  registerPage();
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
  it("marks a missing role name and emoji and says what to enter", async () => {
    const res = await harness.post("/reaction-roles/create", {});
    const r = await refusal(res);
    expect(r.invalidIds).toEqual([
      "reaction-role-create-name",
      "reaction-role-create-emoji",
    ]);
    expect(r.errorLines["reaction-role-create-name-error"]).toBe(
      "Enter a name for the role.",
    );
    expect(r.errorLines["reaction-role-create-emoji-error"]).toBe(
      "Enter an emoji.",
    );
    expect(mockCreateReactionRole).not.toHaveBeenCalled();
    expect(mockRecordAudit).not.toHaveBeenCalled();
  });

  it("rejects a role name past Discord's 100-character cap and keeps what was typed", async () => {
    const res = await harness.post("/reaction-roles/create", {
      name: "v".repeat(101),
      emoji: "🎉",
      mode: "sticky",
    });
    const r = await refusal(res);
    expect(r.invalidIds).toEqual(["reaction-role-create-name"]);
    expect(r.errorLines["reaction-role-create-name-error"]).toBe(
      "At most 100 characters.",
    );
    expect(r.html).toContain(`value="${"v".repeat(101)}"`);
    expect(r.html).toContain('value="🎉"');
    // The unticked box and the chosen mode come back as submitted.
    expect(r.html).toMatch(/name="createChannel" value="1"> Create/);
    expect(r.html).toContain('<option value="sticky" selected>');
    expect(mockCreateReactionRole).not.toHaveBeenCalled();
  });

  it("rejects an oversized emoji field", async () => {
    const res = await harness.post("/reaction-roles/create", {
      name: "VIP",
      emoji: "e".repeat(101),
    });
    const r = await refusal(res);
    expect(r.invalidIds).toEqual(["reaction-role-create-emoji"]);
    expect(r.errorLines["reaction-role-create-emoji-error"]).toBe(
      "At most 100 characters.",
    );
  });

  it("echoes the text as typed, with its spaces, while saving the trimmed value", async () => {
    const res = await harness.post("/reaction-roles/create", {
      name: "  VIP  ",
      emoji: "",
    });
    const r = await refusal(res);
    expect(r.html).toContain('value="  VIP  "');
  });

  it("falls back to a flash with the first message when the page cannot be drawn", async () => {
    registerFormPage("/admin/reaction-roles", async () => {
      throw new Error("page down");
    });
    const res = await harness.post("/reaction-roles/create", { name: "VIP" });
    expect(res.status).toBe(303);
    const flash = parseFlashRedirect(res.headers.get("location"));
    expect(flash.path).toBe("/admin/reaction-roles");
    expect(flash.msg).toBe("Not saved. Enter an emoji.");
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
  it("marks a missing role id and keeps the emoji and message id", async () => {
    const res = await harness.post("/reaction-roles/bind", {
      emoji: "🎉",
      messageId: " 777 ",
    });
    const r = await refusal(res);
    expect(r.invalidIds).toEqual(["reaction-role-bind-roleId"]);
    expect(r.errorLines["reaction-role-bind-roleId-error"]).toBe(
      "Choose a role.",
    );
    expect(r.html).toContain('value="🎉"');
    expect(r.html).toContain('value=" 777 "');
    expect(mockBindReactionRole).not.toHaveBeenCalled();
  });

  it("binds onto the message picked from a list cut at the cap", async () => {
    await harness.post("/reaction-roles/bind", {
      roleId: "role-1",
      emoji: "🎉",
      messageIdListed: "message-8",
    });
    expect(mockBindReactionRole).toHaveBeenCalledWith(
      session.guildId,
      "role-1",
      "🎉",
      { messageId: "message-8" },
    );
  });

  it("lets a typed older message id win over the picked one", async () => {
    await harness.post("/reaction-roles/bind", {
      roleId: "role-1",
      emoji: "🎉",
      messageId: "message-old",
      messageIdListed: "message-8",
    });
    expect(mockBindReactionRole).toHaveBeenCalledWith(
      session.guildId,
      "role-1",
      "🎉",
      { messageId: "message-old" },
    );
  });

  it.each([
    ["", "", undefined],
    ["   ", "", undefined],
    ["", "message-8", "message-8"],
    ["   ", "message-8", "message-8"],
    ["message-old", "", "message-old"],
    [" message-old ", "message-8", "message-old"],
  ])(
    "aims at the typed id, else the picked one: typed %j, picked %j",
    async (typed, listed, want) => {
      mockBindReactionRole.mockClear();
      await harness.post("/reaction-roles/bind", {
        roleId: "role-1",
        emoji: "🎉",
        messageId: typed,
        messageIdListed: listed,
      });
      expect(mockBindReactionRole).toHaveBeenCalledWith(
        session.guildId,
        "role-1",
        "🎉",
        want === undefined ? {} : { messageId: want },
      );
    },
  );

  it("marks an oversized emoji", async () => {
    const res = await harness.post("/reaction-roles/bind", {
      roleId: "role-1",
      emoji: "e".repeat(101),
    });
    const r = await refusal(res);
    expect(r.invalidIds).toEqual(["reaction-role-bind-emoji"]);
    expect(mockBindReactionRole).not.toHaveBeenCalled();
  });

  it("leaves a refusal from Discord as a page flash", async () => {
    mockBindReactionRole.mockResolvedValue({
      success: false,
      message: "Role `role-1` was not found in this server.",
    });
    const res = await harness.post("/reaction-roles/bind", {
      roleId: "role-1",
      emoji: "🎉",
    });
    expect(res.status).toBe(303);
    const flash = parseFlashRedirect(res.headers.get("location"));
    expect(flash.type).toBe("err");
    expect(flash.msg).toBe("Role `role-1` was not found in this server.");
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
  it("marks a missing group name and keeps the option rows", async () => {
    const res = await harness.post("/reaction-roles/group/create", {
      roleName: ["A", "B"],
      emoji: ["🅰️", "🅱️"],
      mode: "sticky",
    });
    const r = await refusal(res);
    expect(r.invalidIds).toEqual(["reaction-role-group-create-groupName"]);
    expect(r.errorLines["reaction-role-group-create-groupName-error"]).toBe(
      "Enter a name for the group.",
    );
    expect(r.html).toContain('value="A"');
    expect(r.html).toContain('value="🅱️"');
    expect(r.html).toContain('<option value="sticky" selected>');
    expect(mockCreateReactionRoleGroup).not.toHaveBeenCalled();
  });

  it("marks the first blank row when fewer than two options are filled in", async () => {
    const res = await harness.post("/reaction-roles/group/create", {
      groupName: "Pronouns",
      roleName: ["A", "", " "],
      // Only one row has any content; the blank rows are ignored.
      emoji: ["🅰️", "", ""],
    });
    const r = await refusal(res);
    expect(r.invalidIds).toEqual(["reaction-role-group-create-roleName-1"]);
    expect(r.errorLines["reaction-role-group-create-roleName-1-error"]).toBe(
      "A role group needs at least two options, each with a role name and an emoji.",
    );
    expect(r.html).toContain('value="Pronouns"');
    expect(mockCreateReactionRoleGroup).not.toHaveBeenCalled();
  });

  it("opens the folded rows when a refused form typed into one", async () => {
    const roleName = Array.from({ length: 8 }, (_unused, i) =>
      i === 7 ? "Far row" : "",
    );
    const res = await harness.post("/reaction-roles/group/create", {
      groupName: "Colour",
      roleName,
      emoji: roleName.map(() => ""),
    });
    const r = await refusal(res);
    expect(r.html).toContain('value="Far row"');
    expect(r.html).toMatch(/<details open><summary>More options/);
  });

  it("passes a half-filled row to the service so its validation error is shown", async () => {
    mockCreateReactionRoleGroup.mockResolvedValue({
      success: false,
      message: "Every role option needs an emoji.",
    });
    const res = await harness.post("/reaction-roles/group/create", {
      groupName: "Pronouns",
      roleName: ["A", "B"],
      emoji: ["🅰️", ""],
    });
    expect(mockCreateReactionRoleGroup).toHaveBeenCalledWith(
      expect.anything(),
      "Pronouns",
      [
        { roleName: "A", emoji: "🅰️" },
        { roleName: "B", emoji: "" },
      ],
      "unique",
    );
    expect(parseFlashRedirect(res.headers.get("location")).msg).toBe(
      "Every role option needs an emoji.",
    );
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

  it("flashes the deleted and kept role outcome of a group delete", async () => {
    const text =
      "Deleted the role group: removed 1 role, kept 2 that were reused or still used elsewhere.";
    mockDeleteReactionRoleGroup.mockResolvedValue({
      success: true,
      message: text,
      rolesDeleted: 1,
      rolesKept: 2,
    });
    const res = await harness.post("/reaction-roles/group/delete", {
      groupId: "group-1",
    });
    expect(parseFlashRedirect(res.headers.get("location")).msg).toBe(text);
  });
});
