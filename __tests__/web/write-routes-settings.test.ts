/**
 * Route-handler tests for the Settings write router (issue #849).
 *
 * `src/web/routes/write/settings.ts` is the largest and least-covered file
 * on the admin write surface, and it is the one that actually mutates
 * configuration: single-key set/reset, the destructive "reset to defaults"
 * confirmation, the bulk section save with its cascade + all-or-nothing
 * coercion, and the command reload. These tests drive it over HTTP with the
 * real middleware, the real config schema and the real coercion helpers —
 * only `ConfigService` and the two Discord-side services are mocked.
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
import { PROTECTED_KEYS } from "../../src/web/bootstrap-vars.js";

const mockRecordAudit = jest.fn(async () => undefined);
const mockConfigGet = jest.fn<(key: string) => Promise<unknown>>();
const mockConfigSet = jest.fn<() => Promise<void>>();
const mockConfigDelete = jest.fn<() => Promise<void>>();
const mockConfigGetAll =
  jest.fn<() => Promise<Array<{ key: string; value: unknown }>>>();
const mockFindDependencyIssues =
  jest.fn<() => Promise<Array<{ key: string; message: string }>>>();
const mockRegisterCommands = jest.fn<() => Promise<void>>();
const mockPopulateClientCommands = jest.fn<() => Promise<void>>();
const mockSetConfigReloadStatus = jest.fn();
const mockGuildsFetch = jest.fn<() => Promise<{ name: string }>>();

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

jest.unstable_mockModule("../../src/services/config-service.js", () => ({
  ConfigService: {
    getInstance: (): unknown => ({
      get: mockConfigGet,
      set: mockConfigSet,
      delete: mockConfigDelete,
      getAll: mockConfigGetAll,
      findDependencyIssues: mockFindDependencyIssues,
      getString: jest.fn(async () => ""),
      getNumber: jest.fn(async () => 0),
      getBoolean: jest.fn(async () => false),
      registerReloadCallback: jest.fn(),
    }),
  },
}));

jest.unstable_mockModule("../../src/services/bot-status-service.js", () => ({
  BotStatusService: {
    getInstance: (): unknown => ({
      setConfigReloadStatus: mockSetConfigReloadStatus,
    }),
  },
}));

jest.unstable_mockModule("../../src/services/command-manager.js", () => ({
  CommandManager: {
    getInstance: (): unknown => ({
      registerCommands: mockRegisterCommands,
      populateClientCommands: mockPopulateClientCommands,
    }),
  },
}));

const { createSettingsRouter } =
  await import("../../src/web/routes/write/settings.js");
const { requireCsrf } = await import("../../src/web/csrf.js");
const { requireAdminRoleMiddleware } = await import("../../src/web/session.js");

const client = {
  user: { id: "bot" },
  guilds: { fetch: mockGuildsFetch },
} as unknown as Client;
const session = createTestSession();

let harness: AdminHarness;

beforeEach(async () => {
  jest.clearAllMocks();
  mockConfigGet.mockResolvedValue(null);
  mockConfigSet.mockResolvedValue(undefined);
  mockConfigDelete.mockResolvedValue(undefined);
  mockConfigGetAll.mockResolvedValue([]);
  mockFindDependencyIssues.mockResolvedValue([]);
  mockGuildsFetch.mockResolvedValue({ name: "Kool Guild" });
  harness = await startAdminHarness([
    stubRequireSession(session),
    requireAdminRoleMiddleware(),
    requireCsrf,
    createSettingsRouter(client),
  ]);
});

afterEach(async () => {
  await harness.close();
});

/** The most recent audit entry a handler recorded. */
function lastAudit(): Record<string, unknown> {
  const calls = mockRecordAudit.mock.calls;
  expect(calls.length).toBeGreaterThan(0);
  return calls[calls.length - 1][1] as Record<string, unknown>;
}

describe("POST /settings/set", () => {
  it("writes a coerced value with its schema description and category", async () => {
    const res = await harness.post("/settings/set", {
      key: "quotes.max_length",
      value: "500",
    });
    const flash = parseFlashRedirect(res.headers.get("location"));
    expect(flash.path).toBe("/admin/settings");
    expect(flash.type).toBe("ok");
    expect(flash.msg).toBe("Set quotes.max_length = 500.");
    // Coerced to a real number, not the "500" string the form posted.
    expect(mockConfigSet).toHaveBeenCalledWith(
      "quotes.max_length",
      500,
      expect.any(String),
      expect.any(String),
    );
    expect(lastAudit()).toMatchObject({
      action: "setting.set",
      targetId: "quotes.max_length",
      result: "success",
      details: { after: 500 },
    });
  });

  it("treats an absent checkbox as false rather than skipping the write", async () => {
    await harness.post("/settings/set", { key: "quotes.enabled" });
    expect(mockConfigSet).toHaveBeenCalledWith(
      "quotes.enabled",
      false,
      expect.any(String),
      expect.any(String),
    );
  });

  it("refuses an unknown key and echoes it back for field highlighting (#854)", async () => {
    const res = await harness.post("/settings/set", {
      key: "not.a.real.key",
      value: "1",
    });
    const flash = parseFlashRedirect(res.headers.get("location"));
    expect(flash.type).toBe("err");
    expect(flash.msg).toContain("unknown key");
    expect(flash.invalid).toEqual(["not.a.real.key"]);
    expect(mockConfigSet).not.toHaveBeenCalled();
    expect(lastAudit()).toMatchObject({
      action: "setting.set",
      result: "failure",
      errorMessage: "unknown key",
    });
  });

  it("refuses a blank number rather than silently storing 0 (#835)", async () => {
    const res = await harness.post("/settings/set", {
      key: "quotes.max_length",
      value: "",
    });
    const flash = parseFlashRedirect(res.headers.get("location"));
    expect(flash.type).toBe("err");
    expect(flash.msg).toContain("invalid number");
    expect(mockConfigSet).not.toHaveBeenCalled();
  });

  it("honours an allowlisted post-action redirect (#610)", async () => {
    const res = await harness.post("/settings/set", {
      key: "quotes.enabled",
      value: "true",
      redirect: "/admin/voice-channels",
    });
    const flash = parseFlashRedirect(res.headers.get("location"));
    expect(flash.path).toBe("/admin/voice-channels");
  });

  it("falls back to /admin/settings for an off-allowlist redirect (open redirect)", async () => {
    const res = await harness.post("/settings/set", {
      key: "quotes.enabled",
      value: "true",
      redirect: "https://evil.example/steal",
    });
    const flash = parseFlashRedirect(res.headers.get("location"));
    expect(flash.path).toBe("/admin/settings");
  });

  it("audits and flashes a write that threw", async () => {
    mockConfigSet.mockRejectedValue(new Error("write concern failed"));
    const res = await harness.post("/settings/set", {
      key: "quotes.max_length",
      value: "500",
    });
    const flash = parseFlashRedirect(res.headers.get("location"));
    expect(flash.type).toBe("err");
    expect(flash.msg).toContain("write concern failed");
    expect(flash.invalid).toEqual(["quotes.max_length"]);
    expect(lastAudit()).toMatchObject({
      result: "failure",
      errorMessage: "write concern failed",
    });
  });
});

describe("POST /settings/reset", () => {
  it("deletes the stored override and reports the default", async () => {
    const res = await harness.post("/settings/reset", {
      key: "quotes.max_length",
    });
    const flash = parseFlashRedirect(res.headers.get("location"));
    expect(flash.type).toBe("ok");
    expect(flash.msg).toBe("Reset quotes.max_length to default.");
    expect(mockConfigDelete).toHaveBeenCalledWith("quotes.max_length");
    expect(lastAudit()).toMatchObject({
      action: "setting.reset",
      result: "success",
      details: { after: 1000 },
    });
  });

  it("refuses a key that is not in the schema", async () => {
    const res = await harness.post("/settings/reset", { key: "made.up" });
    const flash = parseFlashRedirect(res.headers.get("location"));
    expect(flash.type).toBe("err");
    expect(flash.msg).toBe("Unknown setting: made.up.");
    expect(mockConfigDelete).not.toHaveBeenCalled();
    expect(lastAudit()).toMatchObject({ errorMessage: "unknown key" });
  });

  it("audits and flashes a delete that threw", async () => {
    mockConfigDelete.mockRejectedValue(new Error("nope"));
    const res = await harness.post("/settings/reset", {
      key: "quotes.enabled",
    });
    const flash = parseFlashRedirect(res.headers.get("location"));
    expect(flash.type).toBe("err");
    expect(flash.msg).toContain("nope");
    expect(lastAudit()).toMatchObject({ result: "failure" });
  });
});

describe("POST /settings/reset-defaults", () => {
  it("refuses a payload smuggling a protected bootstrap key", async () => {
    const res = await harness.post("/settings/reset-defaults", {
      confirm: "Kool Guild",
      DISCORD_TOKEN: "leaked",
    });
    const flash = parseFlashRedirect(res.headers.get("location"));
    expect(flash.type).toBe("err");
    expect(flash.msg).toContain("protected bootstrap key");
    expect(mockConfigSet).not.toHaveBeenCalled();
    expect(lastAudit()).toMatchObject({
      action: "settings.reset-defaults",
      result: "failure",
      errorMessage: "protected key in payload",
      details: { protectedKey: "DISCORD_TOKEN" },
    });
  });

  it("refuses when the typed confirmation does not match the guild", async () => {
    const res = await harness.post("/settings/reset-defaults", {
      confirm: "wrong name",
    });
    const flash = parseFlashRedirect(res.headers.get("location"));
    expect(flash.type).toBe("err");
    expect(flash.msg).toContain('type "Kool Guild" exactly');
    expect(lastAudit()).toMatchObject({
      errorMessage: "confirmation text did not match",
    });
  });

  it("refuses an empty confirmation", async () => {
    const res = await harness.post("/settings/reset-defaults", {});
    expect(parseFlashRedirect(res.headers.get("location")).type).toBe("err");
  });

  it("accepts the guild id when Discord could not be reached", async () => {
    mockGuildsFetch.mockRejectedValue(new Error("Missing Access") as never);
    const res = await harness.post("/settings/reset-defaults", {
      confirm: session.guildId,
    });
    const flash = parseFlashRedirect(res.headers.get("location"));
    expect(flash.type).toBe("ok");
    expect(lastAudit()).toMatchObject({
      action: "settings.reset-defaults",
      result: "success",
    });
  });

  it("resets every stored key and reports the counts", async () => {
    mockConfigGetAll.mockResolvedValue([
      { key: "quotes.enabled", value: true },
      { key: "quotes.max_length", value: 5 },
    ]);
    const res = await harness.post("/settings/reset-defaults", {
      confirm: "Kool Guild",
    });
    const flash = parseFlashRedirect(res.headers.get("location"));
    expect(flash.type).toBe("ok");
    expect(flash.msg).toContain("Settings reset to defaults");
    expect(mockConfigSet).toHaveBeenCalled();
    expect(lastAudit()).toMatchObject({
      action: "settings.reset-defaults",
      result: "success",
      details: { outcome: "ok" },
    });
  });
});

describe("POST /settings/save-section", () => {
  it("rejects a submission with no keys", async () => {
    const res = await harness.post("/settings/save-section", {
      category: "quotes",
    });
    const flash = parseFlashRedirect(res.headers.get("location"));
    expect(flash.type).toBe("err");
    expect(flash.msg).toContain("No settings submitted for section quotes");
    expect(mockConfigSet).not.toHaveBeenCalled();
    expect(lastAudit()).toMatchObject({ errorMessage: "no keys submitted" });
  });

  it("writes every submitted key when the master toggle is on", async () => {
    const res = await harness.post("/settings/save-section", {
      category: "quotes",
      keys: ["quotes.enabled", "quotes.max_length"],
      "value_quotes.enabled": "true",
      "value_quotes.max_length": "250",
    });
    const flash = parseFlashRedirect(res.headers.get("location"));
    expect(flash.type).toBe("ok");
    expect(flash.msg).toBe("Saved 2 settings in quotes.");
    expect(mockConfigSet).toHaveBeenCalledTimes(2);
    expect(lastAudit()).toMatchObject({
      action: "settings.save-section",
      targetId: "quotes",
      result: "success",
      details: { appliedCount: 2, outcome: "ok" },
    });
  });

  it("writes only the master flag when the section was switched off (#485)", async () => {
    // Dependent controls are greyed out client-side and not submitted;
    // writing them anyway would clobber the sub-settings.
    const res = await harness.post("/settings/save-section", {
      category: "quotes",
      keys: ["quotes.enabled", "quotes.max_length"],
      "value_quotes.max_length": "",
    });
    const flash = parseFlashRedirect(res.headers.get("location"));
    expect(flash.type).toBe("ok");
    expect(mockConfigSet).toHaveBeenCalledTimes(1);
    expect(mockConfigSet.mock.calls[0][0]).toBe("quotes.enabled");
    expect(mockConfigSet.mock.calls[0][1]).toBe(false);
  });

  it("writes every key when the form opted out of the cascade (#705)", async () => {
    const res = await harness.post("/settings/save-section", {
      category: "quotes",
      no_cascade: "1",
      keys: ["quotes.enabled", "quotes.max_length"],
      "value_quotes.max_length": "250",
    });
    expect(parseFlashRedirect(res.headers.get("location")).type).toBe("ok");
    expect(mockConfigSet).toHaveBeenCalledTimes(2);
  });

  it("de-duplicates repeated keys so a doubled input can't double-write", async () => {
    const res = await harness.post("/settings/save-section", {
      category: "quotes",
      no_cascade: "1",
      keys: ["quotes.max_length", "quotes.max_length"],
      "value_quotes.max_length": "250",
    });
    expect(parseFlashRedirect(res.headers.get("location")).msg).toBe(
      "Saved 1 setting in quotes.",
    );
    expect(mockConfigSet).toHaveBeenCalledTimes(1);
  });

  it("is all-or-nothing: one bad value blocks the whole section", async () => {
    const res = await harness.post("/settings/save-section", {
      category: "quotes",
      no_cascade: "1",
      keys: ["quotes.max_length", "quotes.cooldown"],
      "value_quotes.max_length": "250",
      "value_quotes.cooldown": "not-a-number",
    });
    const flash = parseFlashRedirect(res.headers.get("location"));
    expect(flash.type).toBe("err");
    expect(flash.msg).toContain("No changes saved");
    expect(flash.invalid).toEqual(["quotes.cooldown"]);
    expect(mockConfigSet).not.toHaveBeenCalled();
    expect(lastAudit()).toMatchObject({ result: "failure" });
  });

  it("blocks the save when the batch would break a dependency (#663)", async () => {
    mockFindDependencyIssues.mockResolvedValue([
      { key: "quotes.max_length", message: "requires quotes.enabled" },
    ]);
    const res = await harness.post("/settings/save-section", {
      category: "quotes",
      no_cascade: "1",
      keys: ["quotes.max_length"],
      "value_quotes.max_length": "250",
    });
    const flash = parseFlashRedirect(res.headers.get("location"));
    expect(flash.type).toBe("err");
    expect(flash.msg).toContain("requires quotes.enabled");
    expect(mockConfigSet).not.toHaveBeenCalled();
  });

  it("reports a partial save as a warning, not a failure", async () => {
    mockConfigSet.mockImplementation(async (...args: unknown[]) => {
      if (args[0] === "quotes.cooldown") throw new Error("disk full");
    });
    const res = await harness.post("/settings/save-section", {
      category: "quotes",
      no_cascade: "1",
      keys: ["quotes.max_length", "quotes.cooldown"],
      "value_quotes.max_length": "250",
      "value_quotes.cooldown": "30",
    });
    const flash = parseFlashRedirect(res.headers.get("location"));
    expect(flash.type).toBe("warn");
    expect(flash.msg).toContain("Saved 1/2");
    expect(flash.invalid).toEqual(["quotes.cooldown"]);
    // A partial save still audits as `success` so an audit query for
    // successes doesn't hide it; `outcome` carries the nuance.
    expect(lastAudit()).toMatchObject({
      result: "success",
      details: { outcome: "partial", appliedCount: 1, failedCount: 1 },
    });
  });

  it("audits as a failure when every write threw", async () => {
    mockConfigSet.mockRejectedValue(new Error("disk full"));
    const res = await harness.post("/settings/save-section", {
      category: "quotes",
      no_cascade: "1",
      keys: ["quotes.max_length"],
      "value_quotes.max_length": "250",
    });
    const flash = parseFlashRedirect(res.headers.get("location"));
    expect(flash.type).toBe("err");
    expect(lastAudit()).toMatchObject({
      result: "failure",
      details: { outcome: "failed" },
    });
  });

  it("answers AJAX saves with JSON instead of a redirect (#555/#854)", async () => {
    const res = await harness.post(
      "/settings/save-section",
      {
        category: "quotes",
        no_cascade: "1",
        keys: ["quotes.cooldown"],
        "value_quotes.cooldown": "bad",
      },
      { json: true },
    );
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("application/json");
    await expect(res.json()).resolves.toMatchObject({
      type: "err",
      invalidKeys: ["quotes.cooldown"],
    });
  });
});

describe("POST /settings/reload", () => {
  it("re-registers the commands and audits the reload", async () => {
    mockRegisterCommands.mockResolvedValue(undefined);
    mockPopulateClientCommands.mockResolvedValue(undefined);
    const res = await harness.post("/settings/reload");
    const flash = parseFlashRedirect(res.headers.get("location"));
    expect(flash.type).toBe("ok");
    expect(flash.msg).toBe("Reloaded slash commands.");
    expect(mockSetConfigReloadStatus).toHaveBeenCalled();
    expect(mockRegisterCommands).toHaveBeenCalled();
    expect(mockPopulateClientCommands).toHaveBeenCalled();
    expect(lastAudit()).toMatchObject({
      action: "commands.reload",
      result: "success",
    });
  });

  it("audits and flashes a failed reload", async () => {
    mockRegisterCommands.mockRejectedValue(new Error("rate limited"));
    const res = await harness.post("/settings/reload");
    const flash = parseFlashRedirect(res.headers.get("location"));
    expect(flash.type).toBe("err");
    expect(flash.msg).toContain("rate limited");
    expect(lastAudit()).toMatchObject({
      action: "commands.reload",
      result: "failure",
    });
  });
});

describe("GET /settings/export", () => {
  it("serves a YAML attachment with defaults overlaid by stored values", async () => {
    mockConfigGetAll.mockResolvedValue([
      { key: "quotes.max_length", value: 42 },
    ]);
    const res = await harness.get("/settings/export");

    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("yaml");
    expect(res.headers.get("content-disposition")).toMatch(
      /attachment; filename="koolbot-config-\d{4}-\d{2}-\d{2}\.yaml"/,
    );
    const body = await res.text();
    // Stored value wins over the schema default (1000).
    expect(body).toContain("quotes.max_length: 42");
    // Unset keys still appear, so the dump is a complete snapshot.
    expect(body).toContain("quotes.enabled: false");
    expect(lastAudit()).toMatchObject({
      action: "settings.export",
      result: "success",
    });
  });

  it("never exports a protected bootstrap key", async () => {
    const res = await harness.get("/settings/export");
    const body = await res.text();
    for (const key of PROTECTED_KEYS) {
      expect(body).not.toContain(`${key}:`);
    }
  });

  it("flashes rather than 500s when the export throws", async () => {
    mockConfigGetAll.mockRejectedValue(new Error("mongo down"));
    const res = await harness.get("/settings/export");
    expect(res.status).toBe(303);
    const flash = parseFlashRedirect(res.headers.get("location"));
    expect(flash.type).toBe("err");
    expect(flash.msg).toContain("mongo down");
    expect(lastAudit()).toMatchObject({
      action: "settings.export",
      result: "failure",
    });
  });
});

describe("POST /settings/import (preview)", () => {
  it("requires some YAML", async () => {
    const res = await harness.post("/settings/import", {});
    expect(parseFlashRedirect(res.headers.get("location")).msg).toBe(
      "Paste YAML before previewing.",
    );
  });

  it("rejects unparseable YAML", async () => {
    const res = await harness.post("/settings/import", {
      yaml: "key: [unclosed",
    });
    expect(parseFlashRedirect(res.headers.get("location")).msg).toContain(
      "Invalid YAML",
    );
  });

  it.each(["- a\n- b", "just a string"])(
    "rejects YAML that isn't a mapping (%s)",
    async (yamlText) => {
      const res = await harness.post("/settings/import", { yaml: yamlText });
      expect(parseFlashRedirect(res.headers.get("location")).msg).toContain(
        "key→value mapping",
      );
    },
  );

  it("renders a diff marking each row pending or rejected", async () => {
    mockConfigGetAll.mockResolvedValue([
      { key: "quotes.max_length", value: 100 },
    ]);
    const res = await harness.post("/settings/import", {
      yaml: [
        "quotes.max_length: 500",
        "quotes.cooldown: not-a-number",
        "made.up.key: 1",
        "DISCORD_TOKEN: hunter2",
      ].join("\n"),
    });

    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).toContain("quotes.max_length");
    expect(html).toContain("unknown key");
    expect(html).toContain("protected key");
    expect(html).toContain("type mismatch");
    // Previewing must not write anything.
    expect(mockConfigSet).not.toHaveBeenCalled();
  });
});

describe("POST /settings/import/apply", () => {
  it("rejects unparseable YAML and audits the parse failure", async () => {
    const res = await harness.post("/settings/import/apply", {
      yaml: "key: [unclosed",
    });
    expect(parseFlashRedirect(res.headers.get("location")).type).toBe("err");
    expect(mockConfigSet).not.toHaveBeenCalled();
    expect(lastAudit()).toMatchObject({
      action: "settings.import",
      result: "failure",
    });
  });

  it("rejects YAML that isn't a mapping", async () => {
    const res = await harness.post("/settings/import/apply", {
      yaml: "- one\n- two",
    });
    expect(parseFlashRedirect(res.headers.get("location")).msg).toBe(
      "YAML must be a mapping.",
    );
    expect(lastAudit()).toMatchObject({ errorMessage: "not a mapping" });
  });

  it("applies every valid key in the snapshot", async () => {
    const res = await harness.post("/settings/import/apply", {
      yaml: "quotes.enabled: true\nquotes.max_length: 500",
    });
    const flash = parseFlashRedirect(res.headers.get("location"));
    expect(flash.type).toBe("ok");
    expect(flash.msg).toBe("Imported 2 settings.");
    expect(mockConfigSet).toHaveBeenCalledTimes(2);
    expect(lastAudit()).toMatchObject({
      action: "settings.import",
      result: "success",
      details: { applied: 2, failed: 0, outcome: "ok" },
    });
  });

  it("skips protected, unknown and mistyped keys but applies the rest", async () => {
    const res = await harness.post("/settings/import/apply", {
      yaml: [
        "quotes.max_length: 500",
        "DISCORD_TOKEN: hunter2",
        "made.up.key: 1",
        "quotes.cooldown: not-a-number",
      ].join("\n"),
    });
    const flash = parseFlashRedirect(res.headers.get("location"));
    expect(flash.type).toBe("warn");
    expect(flash.msg).toContain("Imported 1, skipped 3");
    expect(mockConfigSet).toHaveBeenCalledTimes(1);
    expect(mockConfigSet.mock.calls[0][0]).toBe("quotes.max_length");
    // A partial import still audits as success; `outcome` carries the nuance.
    expect(lastAudit()).toMatchObject({
      result: "success",
      details: { applied: 1, failed: 3, outcome: "partial" },
    });
  });

  it("rejects only the keys that break a dependency (#663)", async () => {
    mockFindDependencyIssues.mockResolvedValue([
      { key: "quotes.max_length", message: "requires quotes.enabled" },
    ]);
    const res = await harness.post("/settings/import/apply", {
      yaml: "quotes.max_length: 500\nquotes.cooldown: 30",
    });
    expect(mockConfigSet).toHaveBeenCalledTimes(1);
    expect(mockConfigSet.mock.calls[0][0]).toBe("quotes.cooldown");
    expect(parseFlashRedirect(res.headers.get("location")).msg).toContain(
      "requires quotes.enabled",
    );
  });

  it("audits a failure when nothing landed at all", async () => {
    const res = await harness.post("/settings/import/apply", {
      yaml: "made.up.key: 1",
    });
    expect(parseFlashRedirect(res.headers.get("location")).type).toBe("err");
    expect(lastAudit()).toMatchObject({
      result: "failure",
      details: { applied: 0, outcome: "failed" },
    });
  });

  it("reports a key whose write threw", async () => {
    mockConfigSet.mockRejectedValue(new Error("disk full"));
    const res = await harness.post("/settings/import/apply", {
      yaml: "quotes.max_length: 500",
    });
    const flash = parseFlashRedirect(res.headers.get("location"));
    expect(flash.type).toBe("err");
    expect(flash.msg).toContain("disk full");
  });
});
