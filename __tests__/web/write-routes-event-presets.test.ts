/**
 * Route tests for the preset library admin routes (#1200). The service's
 * Mongo writes are mocked; the real form validator, CSRF and admin-role
 * middleware, audit calls and flash redirects run.
 */

import {
  describe,
  it,
  expect,
  jest,
  beforeEach,
  afterEach,
} from "@jest/globals";
import {
  startAdminHarness,
  stubRequireSession,
  createTestSession,
  parseFlashRedirect,
  type AdminHarness,
} from "./admin-harness.js";

const mockRecordAudit = jest.fn(async () => undefined);
const mockCreate = jest.fn<(g: string, d: unknown) => Promise<unknown>>();
const mockUpdate =
  jest.fn<(g: string, id: string, d: unknown) => Promise<unknown>>();
const mockDelete = jest.fn<(g: string, id: string) => Promise<unknown>>();
const mockToggle =
  jest.fn<(g: string, id: string, on: boolean) => Promise<unknown>>();

jest.unstable_mockModule("../../src/web/audit.js", () => ({
  recordAudit: mockRecordAudit,
}));
jest.unstable_mockModule("../../src/utils/logger.js", () => ({
  default: { info: jest.fn(), warn: jest.fn(), error: jest.fn() },
}));
jest.unstable_mockModule("../../src/services/config-service.js", () => ({
  ConfigService: {
    getInstance: (): unknown => ({
      getNumber: async (key: string, fallback: number) =>
        key === "events.groups.max_count" ? 4 : fallback,
      getString: async () => "",
      getBoolean: async () => true,
      registerReloadCallback: jest.fn(),
    }),
  },
}));
const actualService =
  await import("../../src/services/event-group-preset-service.js");
jest.unstable_mockModule(
  "../../src/services/event-group-preset-service.js",
  () => ({
    ...actualService,
    createLibraryPreset: mockCreate,
    updateLibraryPreset: mockUpdate,
    deleteLibraryPreset: mockDelete,
    setPresetEnabled: mockToggle,
  }),
);

const { createEventPresetsRouter } =
  await import("../../src/web/routes/write/event-presets.js");
const { requireCsrf } = await import("../../src/web/csrf.js");
const { requireAdminRoleMiddleware } = await import("../../src/web/session.js");

const OID = "0123456789abcdef01234567";

let harness: AdminHarness;

beforeEach(async () => {
  jest.clearAllMocks();
  mockCreate.mockResolvedValue({ ok: true, id: `lib:${OID}` });
  mockUpdate.mockResolvedValue({ ok: true });
  mockDelete.mockResolvedValue({ ok: true });
  mockToggle.mockResolvedValue({ ok: true, label: "Wardogs" });
  harness = await startAdminHarness([
    stubRequireSession(createTestSession()),
    requireAdminRoleMiddleware(),
    requireCsrf,
    createEventPresetsRouter(),
  ]);
});

afterEach(async () => {
  await harness.close();
});

async function post(
  path: string,
  body: Record<string, string>,
): Promise<ReturnType<typeof parseFlashRedirect>> {
  const res = await harness.post(path, body);
  expect(res.status).toBe(303);
  return parseFlashRedirect(res.headers.get("location"));
}

const goodBody = {
  preset_name: "Clan match",
  groups_label: "Squad",
  group_0_name: "Assault",
  group_0_size: "8",
  group_1_name: "Logi",
};

describe("POST /events/presets/save", () => {
  it("creates a preset, audits it and says events are unaffected on edits", async () => {
    const flash = await post("/events/presets/save", goodBody);
    expect(flash).toMatchObject({ path: "/admin/events/presets", type: "ok" });
    expect(mockCreate).toHaveBeenCalledTimes(1);
    expect(mockCreate.mock.calls[0][0]).toBe("guild-1");
    expect(mockCreate.mock.calls[0][1]).toMatchObject({
      name: "Clan match",
      groupLabel: "Squad",
    });
    expect(mockRecordAudit.mock.calls[0][1]).toMatchObject({
      action: "event-preset.create",
      targetId: `lib:${OID}`,
      result: "success",
    });
  });

  it("edits when an id is posted", async () => {
    const flash = await post("/events/presets/save", {
      ...goodBody,
      preset_id: `lib:${OID}`,
    });
    expect(flash.type).toBe("ok");
    expect(flash.msg).toContain("unchanged");
    expect(mockUpdate).toHaveBeenCalledWith(
      "guild-1",
      `lib:${OID}`,
      expect.objectContaining({ name: "Clan match" }),
    );
    expect(mockCreate).not.toHaveBeenCalled();
    expect(mockRecordAudit.mock.calls[0][1]).toMatchObject({
      action: "event-preset.update",
      targetId: `lib:${OID}`,
    });
  });

  it("stores nothing for input the event form would refuse", async () => {
    for (const bad of [
      { ...goodBody, group_0_size: "100" },
      { ...goodBody, group_1_name: "assault" },
      { ...goodBody, preset_name: "" },
      { ...goodBody, preset_name: "Wardogs" },
      { preset_name: "Big", g: "x" },
    ]) {
      const flash = await post("/events/presets/save", bad);
      expect(flash.type).toBe("err");
    }
    expect(mockCreate).not.toHaveBeenCalled();
    expect(mockUpdate).not.toHaveBeenCalled();
  });

  it("refuses more groups than events.groups.max_count (4 here)", async () => {
    const body: Record<string, string> = { preset_name: "Big" };
    for (let i = 0; i < 5; i++) body[`group_${i}_name`] = `G${i}`;
    const flash = await post("/events/presets/save", body);
    expect(flash.type).toBe("err");
    expect(flash.msg).toContain("at most 4 groups");
  });

  it("reports and audits a refused write (duplicate name, full library)", async () => {
    mockCreate.mockResolvedValue({
      ok: false,
      error: "A preset with that name already exists.",
    });
    const flash = await post("/events/presets/save", goodBody);
    expect(flash.type).toBe("err");
    expect(flash.msg).toContain("already exists");
    expect(mockRecordAudit.mock.calls[0][1]).toMatchObject({
      action: "event-preset.create",
      result: "failure",
    });
  });
});

describe("POST /events/presets/toggle", () => {
  it("sets the wanted state, not a flip, and audits it", async () => {
    const off = await post("/events/presets/toggle", {
      id: "builtin:wardogs",
      enabled: "0",
    });
    expect(off.type).toBe("ok");
    expect(mockToggle).toHaveBeenLastCalledWith(
      "guild-1",
      "builtin:wardogs",
      false,
    );
    await post("/events/presets/toggle", {
      id: "builtin:wardogs",
      enabled: "0",
    });
    expect(mockToggle).toHaveBeenLastCalledWith(
      "guild-1",
      "builtin:wardogs",
      false,
    );
    expect(mockRecordAudit.mock.calls[0][1]).toMatchObject({
      action: "event-preset.toggle",
      targetId: "builtin:wardogs",
      details: { enabled: false },
    });
  });

  it("changes nothing without an explicit 0 or 1", async () => {
    const flash = await post("/events/presets/toggle", {
      id: "builtin:wardogs",
    });
    expect(flash.type).toBe("err");
    expect(mockToggle).not.toHaveBeenCalled();
  });

  it("reports a preset that does not exist", async () => {
    mockToggle.mockResolvedValue({
      ok: false,
      error: "That preset was not found.",
    });
    const flash = await post("/events/presets/toggle", {
      id: "builtin:nope",
      enabled: "1",
    });
    expect(flash.type).toBe("err");
    expect(mockRecordAudit.mock.calls[0][1]).toMatchObject({
      result: "failure",
    });
  });
});

describe("POST /events/presets/delete", () => {
  it("deletes in the session's guild and audits it", async () => {
    const flash = await post("/events/presets/delete", { id: `lib:${OID}` });
    expect(flash.type).toBe("ok");
    expect(mockDelete).toHaveBeenCalledWith("guild-1", `lib:${OID}`);
    expect(mockRecordAudit.mock.calls[0][1]).toMatchObject({
      action: "event-preset.delete",
      result: "success",
    });
  });

  it("reports a missing preset as an error", async () => {
    mockDelete.mockResolvedValue({
      ok: false,
      error: "That preset was not found.",
    });
    expect((await post("/events/presets/delete", { id: "x" })).type).toBe(
      "err",
    );
  });
});

describe("access", () => {
  it("is behind the CSRF check", async () => {
    const res = await harness.post(
      "/events/presets/toggle",
      { id: "builtin:wardogs", enabled: "0" },
      { csrfField: null },
    );
    expect(res.status).toBe(403);
    expect(mockToggle).not.toHaveBeenCalled();
  });
});
