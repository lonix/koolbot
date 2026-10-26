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
import { refusal } from "./refused-form-test-utils.js";

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
const { registerFormPage } = await import("../../src/web/form-pages.js");
const { renderReactionRolesPage } =
  await import("../../src/web/admin-views.js");

const client = { user: { id: "bot" } } as unknown as Client;
const session = createTestSession();
let harness: AdminHarness;

// The real view stands in for the read router's renderer (#1520).
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

  it("audits the effective mode of a top-up, not the submitted one", async () => {
    mockProvision.mockResolvedValue({
      success: true,
      message: "Done.",
      groupId: "g1",
      mode: "unique",
      createdRoles: [],
      reusedRoles: [],
      addedEntries: 1,
      skippedEntries: 0,
    });
    await harness.post("/reaction-roles/group/generate", {
      preset: "regions",
      mode: "toggle",
    });
    const call = mockProvision.mock.calls[0] as unknown as unknown[];
    expect(call[3]).toBe("toggle");
    expect(mockRecordAudit).toHaveBeenCalledWith(
      session,
      expect.objectContaining({
        details: expect.objectContaining({ mode: "unique" }),
      }),
    );
  });

  it("marks an unknown source and keeps the typed rows", async () => {
    const res = await harness.post("/reaction-roles/group/generate", {
      preset: "nope",
      groupName: " Platform ",
      mode: "toggle",
      roleName: ["PC"],
      emoji: ["🖥️"],
    });
    const r = await refusal(res);
    expect(r.invalidIds).toEqual(["reaction-role-group-generate-preset"]);
    expect(r.errorLines["reaction-role-group-generate-preset-error"]).toBe(
      "Choose one of the listed sources.",
    );
    expect(r.html).toContain('value=" Platform "');
    expect(r.html).toContain('value="PC"');
    expect(r.html).toContain('<option value="toggle" selected>');
    expect(mockProvision).not.toHaveBeenCalled();
  });

  it("pairs custom rows, ignores fully blank rows and honours the mode", async () => {
    await harness.post("/reaction-roles/group/generate", {
      preset: "custom",
      groupName: "Platform",
      mode: "toggle",
      roleName: ["PC", "  ", "Console"],
      emoji: ["🖥️", "", "🎮"],
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

  it("passes half-filled rows through so the service validation error is shown", async () => {
    mockProvision.mockResolvedValue({
      success: false,
      message: "Every option needs both a role name and an emoji.",
      createdRoles: [],
      reusedRoles: [],
      addedEntries: 0,
      skippedEntries: 0,
    });
    const res = await harness.post("/reaction-roles/group/generate", {
      preset: "custom",
      groupName: "Platform",
      roleName: ["PC", "Console", "Mobile"],
      emoji: ["🖥️", "🎮", ""],
    });
    expect(mockProvision).toHaveBeenCalledWith(
      session.guildId,
      "Platform",
      [
        { roleName: "PC", emoji: "🖥️" },
        { roleName: "Console", emoji: "🎮" },
        { roleName: "Mobile", emoji: "" },
      ],
      "unique",
    );
    expect(parseFlashRedirect(res.headers.get("location"))).toMatchObject({
      type: "err",
      msg: "Every option needs both a role name and an emoji.",
    });
  });

  it("marks a missing name for a custom group and keeps the chosen source", async () => {
    const res = await harness.post("/reaction-roles/group/generate", {
      preset: "custom",
      roleName: ["A"],
      emoji: ["🅰️"],
    });
    const r = await refusal(res);
    expect(r.invalidIds).toEqual(["reaction-role-group-generate-groupName"]);
    expect(r.errorLines["reaction-role-group-generate-groupName-error"]).toBe(
      "Enter a name for the custom group.",
    );
    expect(r.html).toContain('<option value="custom" selected>');
    expect(r.html).toContain('value="A"');
    expect(mockProvision).not.toHaveBeenCalled();
  });
});
