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
const mockDigestReload = jest.fn<() => Promise<void>>();
const mockLeaderboardReload = jest.fn<() => Promise<void>>();
const mockBirthdayReload = jest.fn<() => Promise<void>>();
const mockRewindNudgeReload = jest.fn<() => Promise<void>>();
const mockEventReload = jest.fn<() => Promise<void>>();
const mockReminderReload = jest.fn<() => Promise<void>>();
const mockLfgReload = jest.fn<() => Promise<void>>();

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

// A save that touches the digest schedule re-arms the digest job (#976).
jest.unstable_mockModule("../../src/services/digest-service.js", () => ({
  DigestService: {
    getInstance: (): unknown => ({ reload: mockDigestReload }),
  },
}));

// Likewise for the leaderboard-role recalculation job (#985).
jest.unstable_mockModule(
  "../../src/services/leaderboard-role-service.js",
  () => ({
    LeaderboardRoleService: {
      getInstance: (): unknown => ({ reload: mockLeaderboardReload }),
    },
  }),
);

// And every other ScheduledService in SCHEDULE_REARMS (#1013).
jest.unstable_mockModule("../../src/services/birthday-service.js", () => ({
  BirthdayService: {
    getInstance: (): unknown => ({ reload: mockBirthdayReload }),
  },
}));
jest.unstable_mockModule("../../src/services/rewind-nudge-service.js", () => ({
  RewindNudgeService: {
    getInstance: (): unknown => ({ reload: mockRewindNudgeReload }),
  },
}));
jest.unstable_mockModule("../../src/services/event-service.js", () => ({
  EventService: {
    getInstance: (): unknown => ({ reload: mockEventReload }),
  },
}));
jest.unstable_mockModule("../../src/services/reminder-service.js", () => ({
  ReminderService: {
    getInstance: (): unknown => ({ reload: mockReminderReload }),
  },
}));
jest.unstable_mockModule("../../src/services/lfg-service.js", () => ({
  LfgService: {
    getInstance: (): unknown => ({ reload: mockLfgReload }),
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
  mockDigestReload.mockResolvedValue(undefined);
  mockLeaderboardReload.mockResolvedValue(undefined);
  mockBirthdayReload.mockResolvedValue(undefined);
  mockRewindNudgeReload.mockResolvedValue(undefined);
  mockEventReload.mockResolvedValue(undefined);
  mockReminderReload.mockResolvedValue(undefined);
  mockLfgReload.mockResolvedValue(undefined);
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
  it("re-arms the digest job when the enable notice switches it on (#976)", async () => {
    const res = await harness.post("/settings/set", {
      key: "digest.enabled",
      value: "true",
      redirect: "/admin/digest",
    });
    const flash = parseFlashRedirect(res.headers.get("location"));
    expect(flash.path).toBe("/admin/digest");
    expect(flash.type).toBe("ok");
    expect(mockDigestReload).toHaveBeenCalledTimes(1);
  });

  it("does not re-arm the digest job when the value is re-saved unchanged (#976)", async () => {
    mockConfigGet.mockResolvedValue("0 9 * * 1");
    await harness.post("/settings/set", {
      key: "digest.cron",
      value: "0 9 * * 1",
    });
    expect(mockConfigSet).toHaveBeenCalledTimes(1);
    expect(mockDigestReload).not.toHaveBeenCalled();
  });

  it("does not re-arm the digest job for an unrelated key (#976)", async () => {
    await harness.post("/settings/set", {
      key: "quotes.max_length",
      value: "500",
    });
    expect(mockDigestReload).not.toHaveBeenCalled();
  });

  // One key per scheduled service (#1013): each re-arms only its own job.
  const allReloads = (): Array<jest.Mock<() => Promise<void>>> => [
    mockDigestReload,
    mockLeaderboardReload,
    mockBirthdayReload,
    mockRewindNudgeReload,
    mockEventReload,
    mockReminderReload,
    mockLfgReload,
  ];
  it.each([
    ["birthdays.cron", "0 8 * * *", () => mockBirthdayReload],
    ["birthdays.enabled", "true", () => mockBirthdayReload],
    ["rewind.nudge.enabled", "true", () => mockRewindNudgeReload],
    ["rewind.cron", "0 10 1 12 *", () => mockRewindNudgeReload],
    ["leaderboard_roles.update_cron", "0 6 * * 1", () => mockLeaderboardReload],
    ["events.enabled", "true", () => mockEventReload],
    ["reminders.enabled", "true", () => mockReminderReload],
    ["lfg.enabled", "true", () => mockLfgReload],
  ])(
    "re-arms only its own job when %s changes (#1013)",
    async (key, value, reload) => {
      const res = await harness.post("/settings/set", { key, value });
      expect(parseFlashRedirect(res.headers.get("location")).type).toBe("ok");
      const expected = reload();
      expect(expected).toHaveBeenCalledTimes(1);
      for (const other of allReloads()) {
        if (other !== expected) expect(other).not.toHaveBeenCalled();
      }
    },
  );

  it("warns when the LFG sweep can't be re-armed but keeps the save (#1013)", async () => {
    mockLfgReload.mockRejectedValueOnce(new Error("boom"));
    const res = await harness.post("/settings/set", {
      key: "lfg.enabled",
      value: "true",
    });
    const flash = parseFlashRedirect(res.headers.get("location"));
    expect(flash.type).toBe("warn");
    expect(flash.msg).toContain("The LFG schedule could not be re-armed");
    expect(mockConfigSet).toHaveBeenCalledTimes(1);
  });
});

describe("POST /settings/reset", () => {
  it("does not re-arm when resetting a schedule that was never overridden (#976)", async () => {
    await harness.post("/settings/reset", { key: "digest.cron" });
    expect(mockDigestReload).not.toHaveBeenCalled();
  });

  it("re-arms the digest job when its schedule is reset (#976)", async () => {
    mockConfigGet.mockResolvedValue("0 16 * * 5");
    const res = await harness.post("/settings/reset", {
      key: "digest.cron",
      redirect: "/admin/digest",
    });
    const flash = parseFlashRedirect(res.headers.get("location"));
    expect(flash.path).toBe("/admin/digest");
    expect(flash.msg).toBe("Reset digest.cron to default.");
    expect(mockDigestReload).toHaveBeenCalledTimes(1);
  });

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

  it("re-arms every scheduled job after the reset (#1013)", async () => {
    const res = await harness.post("/settings/reset-defaults", {
      confirm: "Kool Guild",
    });
    expect(parseFlashRedirect(res.headers.get("location")).type).toBe("ok");
    // Not diffed against stored rows: a missing row may have been running on
    // an env fallback, so every job is re-armed from the new defaults.
    for (const reload of [
      mockDigestReload,
      mockLeaderboardReload,
      mockBirthdayReload,
      mockRewindNudgeReload,
      mockEventReload,
      mockReminderReload,
      mockLfgReload,
    ]) {
      expect(reload).toHaveBeenCalledTimes(1);
    }
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

  it("saves the Voice Channels page card and returns to that page (#979)", async () => {
    const res = await harness.post("/settings/save-section", {
      category: "voicechannels",
      redirect: "/admin/voice-channels",
      keys: [
        "voicechannels.enabled",
        "voicechannels.lobby.name",
        "voicechannels.presets.max_per_user",
      ],
      "value_voicechannels.enabled": "true",
      "value_voicechannels.lobby.name": "Lobby",
      "value_voicechannels.presets.max_per_user": "5",
    });
    const flash = parseFlashRedirect(res.headers.get("location"));
    expect(flash.path).toBe("/admin/voice-channels");
    expect(flash.type).toBe("ok");
    expect(flash.msg).toBe("Saved 3 settings in voicechannels.");
    expect(mockConfigSet).toHaveBeenCalledTimes(3);
    expect(mockConfigSet).toHaveBeenCalledWith(
      "voicechannels.presets.max_per_user",
      5,
      expect.any(String),
      "voicechannels",
      expect.anything(),
    );
  });

  it("disables Voice Channels from its page without blanking the other settings (#979)", async () => {
    // Unchecked master: the checkbox posts nothing, as a browser would.
    const res = await harness.post("/settings/save-section", {
      category: "voicechannels",
      redirect: "/admin/voice-channels",
      keys: [
        "voicechannels.enabled",
        "voicechannels.lobby.name",
        "voicechannels.presets.max_per_user",
      ],
      "value_voicechannels.lobby.name": "Lobby",
      "value_voicechannels.presets.max_per_user": "5",
    });
    const flash = parseFlashRedirect(res.headers.get("location"));
    expect(flash.path).toBe("/admin/voice-channels");
    expect(flash.type).toBe("ok");
    expect(mockConfigSet).toHaveBeenCalledTimes(1);
    expect(mockConfigSet.mock.calls[0][0]).toBe("voicechannels.enabled");
    expect(mockConfigSet.mock.calls[0][1]).toBe(false);
  });

  it("saves the Polls page card and returns to /admin/polls (#973)", async () => {
    const res = await harness.post("/settings/save-section", {
      category: "polls",
      redirect: "/admin/polls",
      keys: [
        "polls.enabled",
        "polls.default_duration_hours",
        "polls.cooldown_days",
      ],
      "value_polls.enabled": "true",
      "value_polls.default_duration_hours": "48",
      "value_polls.cooldown_days": "14",
    });
    const flash = parseFlashRedirect(res.headers.get("location"));
    expect(flash.path).toBe("/admin/polls");
    expect(flash.type).toBe("ok");
    expect(flash.msg).toBe("Saved 3 settings in polls.");
    expect(mockConfigSet).toHaveBeenCalledTimes(3);
  });

  it("disables Polls from its page without blanking the other settings (#973)", async () => {
    const res = await harness.post("/settings/save-section", {
      category: "polls",
      redirect: "/admin/polls",
      keys: ["polls.enabled", "polls.default_duration_hours"],
    });
    const flash = parseFlashRedirect(res.headers.get("location"));
    expect(flash.path).toBe("/admin/polls");
    expect(flash.type).toBe("ok");
    expect(mockConfigSet).toHaveBeenCalledTimes(1);
    expect(mockConfigSet.mock.calls[0][0]).toBe("polls.enabled");
    expect(mockConfigSet.mock.calls[0][1]).toBe(false);
  });

  it("saves the Command Metrics page card and returns to /admin/metrics (#978)", async () => {
    const res = await harness.post("/settings/save-section", {
      category: "core",
      redirect: "/admin/metrics",
      no_cascade: "1",
      keys: [
        "monitoring.metrics_persistence.enabled",
        "monitoring.metrics_retention_days",
      ],
      "value_monitoring.metrics_persistence.enabled": "true",
      "value_monitoring.metrics_retention_days": "60",
    });
    const flash = parseFlashRedirect(res.headers.get("location"));
    expect(flash.path).toBe("/admin/metrics");
    expect(flash.type).toBe("ok");
    expect(flash.msg).toBe("Saved 2 settings in core.");
    expect(mockConfigSet).toHaveBeenCalledTimes(2);
  });

  it("switches command auditing off from its page and still saves retention (#978)", async () => {
    const res = await harness.post("/settings/save-section", {
      category: "core",
      redirect: "/admin/audit/commands",
      no_cascade: "1",
      keys: [
        "core.command_audit.enabled",
        "core.command_audit.retention_days",
        "core.web_audit.retention_days",
      ],
      "value_core.command_audit.retention_days": "30",
      "value_core.web_audit.retention_days": "0",
    });
    const flash = parseFlashRedirect(res.headers.get("location"));
    expect(flash.path).toBe("/admin/audit/commands");
    expect(flash.type).toBe("ok");
    expect(flash.msg).toBe("Saved 3 settings in core.");
    const writes = Object.fromEntries(
      mockConfigSet.mock.calls.map((c: unknown[]) => [c[0], c[1]]),
    );
    expect(writes).toEqual({
      "core.command_audit.enabled": false,
      "core.command_audit.retention_days": 30,
      "core.web_audit.retention_days": 0,
    });
  });

  it("saves the Digest page card and returns to /admin/digest (#976)", async () => {
    const res = await harness.post("/settings/save-section", {
      category: "digest",
      redirect: "/admin/digest",
      keys: [
        "digest.enabled",
        "digest.cron",
        "digest.min_active_minutes",
        "digest.streak_min_minutes",
        "digest.include_achievements",
      ],
      "value_digest.enabled": "true",
      "value_digest.cron": "0 16 * * 5",
      "value_digest.min_active_minutes": "45",
      "value_digest.streak_min_minutes": "20",
      "value_digest.include_achievements": "true",
    });
    const flash = parseFlashRedirect(res.headers.get("location"));
    expect(flash.path).toBe("/admin/digest");
    expect(flash.type).toBe("ok");
    expect(flash.msg).toBe("Saved 5 settings in digest.");
    expect(mockConfigSet).toHaveBeenCalledWith(
      "digest.cron",
      "0 16 * * 5",
      expect.any(String),
      "digest",
      expect.anything(),
    );
    // The new schedule is armed now, not on the next restart.
    expect(mockDigestReload).toHaveBeenCalledTimes(1);
  });

  it("saves the Birthdays page card and re-arms only the birthday job (#986)", async () => {
    const res = await harness.post("/settings/save-section", {
      category: "birthdays",
      redirect: "/admin/birthdays",
      keys: ["birthdays.enabled", "birthdays.cron", "birthdays.message"],
      "value_birthdays.enabled": "true",
      "value_birthdays.cron": "0 */2 * * *",
      "value_birthdays.message": "Happy birthday {user}",
    });
    const flash = parseFlashRedirect(res.headers.get("location"));
    expect(flash.path).toBe("/admin/birthdays");
    expect(flash.type).toBe("ok");
    expect(mockBirthdayReload).toHaveBeenCalledTimes(1);
    expect(mockDigestReload).not.toHaveBeenCalled();
  });

  it("saves the Leaderboard Roles card and re-arms its job (#985)", async () => {
    const res = await harness.post("/settings/save-section", {
      category: "leaderboard_roles",
      redirect: "/admin/leaderboard-roles",
      keys: [
        "leaderboard_roles.enabled",
        "leaderboard_roles.period",
        "leaderboard_roles.update_cron",
        "leaderboard_roles.announcement_channel_id",
      ],
      "value_leaderboard_roles.enabled": "true",
      "value_leaderboard_roles.period": "week",
      "value_leaderboard_roles.update_cron": "0 6 * * 1",
      "value_leaderboard_roles.announcement_channel_id": "",
    });
    const flash = parseFlashRedirect(res.headers.get("location"));
    expect(flash.path).toBe("/admin/leaderboard-roles");
    expect(flash.type).toBe("ok");
    expect(mockConfigSet).toHaveBeenCalledWith(
      "leaderboard_roles.update_cron",
      "0 6 * * 1",
      expect.any(String),
      "leaderboard_roles",
      expect.anything(),
    );
    expect(mockLeaderboardReload).toHaveBeenCalledTimes(1);
    expect(mockDigestReload).not.toHaveBeenCalled();
  });

  it("re-arms the digest job when disabled from its page (#976)", async () => {
    mockConfigGet.mockImplementation(async (key) =>
      key === "digest.enabled" ? true : null,
    );
    const res = await harness.post("/settings/save-section", {
      category: "digest",
      redirect: "/admin/digest",
      keys: ["digest.enabled", "digest.cron", "digest.min_active_minutes"],
      "value_digest.cron": "0 16 * * 5",
      "value_digest.min_active_minutes": "45",
    });
    const flash = parseFlashRedirect(res.headers.get("location"));
    expect(flash.path).toBe("/admin/digest");
    expect(flash.type).toBe("ok");
    expect(mockConfigSet).toHaveBeenCalledTimes(1);
    expect(mockConfigSet.mock.calls[0][0]).toBe("digest.enabled");
    expect(mockDigestReload).toHaveBeenCalledTimes(1);
  });

  it("does not re-arm the digest job for a threshold-only save (#976)", async () => {
    // The card re-posts every row, so the unchanged enable flag and cron
    // arrive alongside the edited threshold, exactly as a browser sends it.
    const stored: Record<string, unknown> = {
      "digest.enabled": true,
      "digest.cron": "0 16 * * 5",
      "digest.min_active_minutes": 30,
      "digest.streak_min_minutes": 30,
      "digest.include_achievements": true,
    };
    mockConfigGet.mockImplementation(async (key) => stored[key] ?? null);
    const res = await harness.post("/settings/save-section", {
      category: "digest",
      redirect: "/admin/digest",
      keys: Object.keys(stored),
      "value_digest.enabled": "true",
      "value_digest.cron": "0 16 * * 5",
      "value_digest.min_active_minutes": "45",
      "value_digest.streak_min_minutes": "30",
      "value_digest.include_achievements": "true",
    });
    expect(parseFlashRedirect(res.headers.get("location")).type).toBe("ok");
    expect(mockConfigSet).toHaveBeenCalledTimes(5);
    expect(mockDigestReload).not.toHaveBeenCalled();
  });

  it("re-arms the digest job when only the cron changes in a full card save (#976)", async () => {
    mockConfigGet.mockImplementation(async (key) =>
      key === "digest.enabled"
        ? true
        : key === "digest.cron"
          ? "0 9 * * 1"
          : null,
    );
    await harness.post("/settings/save-section", {
      category: "digest",
      redirect: "/admin/digest",
      keys: ["digest.enabled", "digest.cron", "digest.min_active_minutes"],
      "value_digest.enabled": "true",
      "value_digest.cron": "0 16 * * 5",
      "value_digest.min_active_minutes": "30",
    });
    expect(mockDigestReload).toHaveBeenCalledTimes(1);
  });

  it("rejects an invalid digest cron without writing or re-arming (#976)", async () => {
    const res = await harness.post("/settings/save-section", {
      category: "digest",
      redirect: "/admin/digest",
      keys: ["digest.enabled", "digest.cron"],
      "value_digest.enabled": "true",
      "value_digest.cron": "every monday",
    });
    const flash = parseFlashRedirect(res.headers.get("location"));
    expect(flash.path).toBe("/admin/digest");
    expect(flash.type).toBe("err");
    expect(flash.msg).toContain("digest.cron (invalid cron expression)");
    expect(mockConfigSet).not.toHaveBeenCalled();
    expect(mockDigestReload).not.toHaveBeenCalled();
  });

  it("warns when the digest job can't be re-armed but keeps the save (#976)", async () => {
    mockDigestReload.mockRejectedValueOnce(new Error("boom"));
    const res = await harness.post("/settings/save-section", {
      category: "digest",
      no_cascade: "1",
      redirect: "/admin/digest",
      keys: ["digest.cron"],
      "value_digest.cron": "0 16 * * 5",
    });
    const flash = parseFlashRedirect(res.headers.get("location"));
    expect(flash.path).toBe("/admin/digest");
    expect(flash.type).toBe("warn");
    expect(flash.msg).toContain("Saved 1 setting in digest.");
    expect(flash.msg).toContain("could not be re-armed");
    expect(mockConfigSet).toHaveBeenCalledTimes(1);
  });

  it("saves the Events page card and returns to /admin/events (#975)", async () => {
    const res = await harness.post("/settings/save-section", {
      category: "events",
      redirect: "/admin/events",
      keys: ["events.enabled", "events.timezone", "events.reminder_minutes"],
      "value_events.enabled": "true",
      "value_events.timezone": "Europe/Oslo",
      "value_events.reminder_minutes": "45",
    });
    const flash = parseFlashRedirect(res.headers.get("location"));
    expect(flash.path).toBe("/admin/events");
    expect(flash.type).toBe("ok");
    expect(flash.msg).toBe("Saved 3 settings in events.");
    expect(mockConfigSet).toHaveBeenCalledTimes(3);
  });

  it("disables Events from its page without blanking the other settings (#975)", async () => {
    const res = await harness.post("/settings/save-section", {
      category: "events",
      redirect: "/admin/events",
      keys: ["events.enabled", "events.category_id", "events.timezone"],
      "value_events.category_id": "123456789012345678",
      "value_events.timezone": "Europe/Oslo",
    });
    const flash = parseFlashRedirect(res.headers.get("location"));
    expect(flash.path).toBe("/admin/events");
    expect(flash.type).toBe("ok");
    expect(mockConfigSet).toHaveBeenCalledTimes(1);
    expect(mockConfigSet.mock.calls[0][0]).toBe("events.enabled");
    expect(mockConfigSet.mock.calls[0][1]).toBe(false);
  });

  it("saves the Reaction Roles page card and returns to that page (#974)", async () => {
    const res = await harness.post("/settings/save-section", {
      category: "reactionroles",
      redirect: "/admin/reaction-roles",
      keys: [
        "reactionroles.enabled",
        "reactionroles.message_channel_id",
        "reactionroles.style",
      ],
      "value_reactionroles.enabled": "true",
      "value_reactionroles.message_channel_id": "chan-9",
      "value_reactionroles.style": "button",
    });
    const flash = parseFlashRedirect(res.headers.get("location"));
    expect(flash.path).toBe("/admin/reaction-roles");
    expect(flash.type).toBe("ok");
    expect(mockConfigSet.mock.calls.map((c) => [c[0], c[1]])).toEqual([
      ["reactionroles.enabled", true],
      ["reactionroles.message_channel_id", "chan-9"],
      ["reactionroles.style", "button"],
    ]);
  });

  it("disables Reaction Roles from its page without clobbering its settings (#974)", async () => {
    // The master is unticked, so the browser greys out and omits the
    // dependents; only the master may be written.
    const res = await harness.post("/settings/save-section", {
      category: "reactionroles",
      redirect: "/admin/reaction-roles",
      keys: [
        "reactionroles.enabled",
        "reactionroles.message_channel_id",
        "reactionroles.style",
      ],
    });
    const flash = parseFlashRedirect(res.headers.get("location"));
    expect(flash.path).toBe("/admin/reaction-roles");
    expect(flash.type).toBe("ok");
    expect(mockConfigSet).toHaveBeenCalledTimes(1);
    expect(mockConfigSet.mock.calls[0][0]).toBe("reactionroles.enabled");
    expect(mockConfigSet.mock.calls[0][1]).toBe(false);
  });

  it("saves the Moderation page card, core.moderation.* included, and returns there (#977)", async () => {
    const res = await harness.post("/settings/save-section", {
      category: "moderation",
      redirect: "/admin/moderation",
      keys: [
        "moderation.enabled",
        "moderation.retention_days",
        "core.moderation.enabled",
        "core.moderation.channel_id",
      ],
      "value_moderation.enabled": "true",
      "value_moderation.retention_days": "30",
      "value_core.moderation.enabled": "true",
      "value_core.moderation.channel_id": "chan-mod",
    });
    const flash = parseFlashRedirect(res.headers.get("location"));
    expect(flash.path).toBe("/admin/moderation");
    expect(flash.type).toBe("ok");
    expect(flash.msg).toBe("Saved 4 settings in moderation.");
    expect(mockConfigSet.mock.calls.map((c) => [c[0], c[1]])).toEqual([
      ["moderation.enabled", true],
      ["moderation.retention_days", 30],
      ["core.moderation.enabled", true],
      ["core.moderation.channel_id", "chan-mod"],
    ]);
    // core.moderation.* keeps its own Settings category, so Settings is
    // unchanged by editing it here.
    expect(mockConfigSet.mock.calls[2][3]).toBe("core");
    expect(mockConfigSet.mock.calls[3][3]).toBe("core");
  });

  it("disables Moderation from its page without clobbering its settings (#977)", async () => {
    const res = await harness.post("/settings/save-section", {
      category: "moderation",
      redirect: "/admin/moderation",
      keys: [
        "moderation.enabled",
        "moderation.retention_days",
        "core.moderation.enabled",
        "core.moderation.channel_id",
      ],
    });
    const flash = parseFlashRedirect(res.headers.get("location"));
    expect(flash.path).toBe("/admin/moderation");
    expect(flash.type).toBe("ok");
    expect(mockConfigSet).toHaveBeenCalledTimes(1);
    expect(mockConfigSet.mock.calls[0][0]).toBe("moderation.enabled");
    expect(mockConfigSet.mock.calls[0][1]).toBe(false);
  });

  it("toggles Announcements from its page and returns there (#977)", async () => {
    const on = await harness.post("/settings/save-section", {
      category: "announcements",
      redirect: "/admin/announcements",
      keys: ["announcements.enabled"],
      "value_announcements.enabled": "true",
    });
    const onFlash = parseFlashRedirect(on.headers.get("location"));
    expect(onFlash.path).toBe("/admin/announcements");
    expect(onFlash.type).toBe("ok");
    expect(onFlash.msg).toBe("Saved 1 setting in announcements.");

    const off = await harness.post("/settings/save-section", {
      category: "announcements",
      redirect: "/admin/announcements",
      keys: ["announcements.enabled"],
    });
    expect(parseFlashRedirect(off.headers.get("location")).path).toBe(
      "/admin/announcements",
    );
    expect(mockConfigSet.mock.calls.map((c) => [c[0], c[1]])).toEqual([
      ["announcements.enabled", true],
      ["announcements.enabled", false],
    ]);
  });

  it("saves the Notices page card and returns there (#972)", async () => {
    const res = await harness.post("/settings/save-section", {
      category: "notices",
      redirect: "/admin/notices",
      keys: [
        "notices.enabled",
        "notices.channel_id",
        "notices.header_enabled",
        "notices.header_pin_enabled",
      ],
      "value_notices.enabled": "true",
      "value_notices.channel_id": "123456789012345678",
      "value_notices.header_enabled": "true",
    });
    const flash = parseFlashRedirect(res.headers.get("location"));
    expect(flash.path).toBe("/admin/notices");
    expect(flash.type).toBe("ok");
    const writes = Object.fromEntries(
      mockConfigSet.mock.calls.map((c) => {
        const [k, v] = c as unknown as [string, unknown];
        return [k, v];
      }),
    );
    expect(writes).toEqual({
      "notices.enabled": true,
      "notices.channel_id": "123456789012345678",
      "notices.header_enabled": true,
      "notices.header_pin_enabled": false,
    });
  });

  it("switching notices off from its page writes only the master (#972)", async () => {
    // The greyed-out dependents are not submitted; the cascade keeps their
    // stored values instead of blanking the channel.
    const res = await harness.post("/settings/save-section", {
      category: "notices",
      redirect: "/admin/notices",
      keys: [
        "notices.enabled",
        "notices.channel_id",
        "notices.header_enabled",
        "notices.header_pin_enabled",
      ],
    });
    const flash = parseFlashRedirect(res.headers.get("location"));
    expect(flash.path).toBe("/admin/notices");
    expect(flash.type).toBe("ok");
    expect(mockConfigSet).toHaveBeenCalledTimes(1);
    expect(mockConfigSet.mock.calls[0][0]).toBe("notices.enabled");
    expect(mockConfigSet.mock.calls[0][1]).toBe(false);
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

// Issue #971: a feature-page settings card includes its `<feature>.enabled`
// master, so disabling works from the page. The card keeps the cascade (no
// `no_cascade`), so these pin what switching the master off does to the
// dependents submitted alongside it.
describe("POST /settings/save-section — feature card with its master (#971)", () => {
  const CARD = {
    category: "digest",
    redirect: "/admin/digest",
    keys: ["digest.enabled", "digest.min_active_minutes", "digest.cron"],
  };

  it("writes the master and every dependent when the feature is on", async () => {
    const res = await harness.post("/settings/save-section", {
      ...CARD,
      "value_digest.enabled": "true",
      "value_digest.min_active_minutes": "45",
      "value_digest.cron": "0 9 * * 1",
    });
    const flash = parseFlashRedirect(res.headers.get("location"));
    expect(flash.path).toBe("/admin/digest");
    expect(flash.type).toBe("ok");
    expect(mockConfigSet.mock.calls.map((c) => [c[0], c[1]])).toEqual([
      ["digest.enabled", true],
      ["digest.min_active_minutes", 45],
      ["digest.cron", "0 9 * * 1"],
    ]);
  });

  it("disabling writes only the master — greyed dependents are not wiped", async () => {
    // The cascade script disables the dependents, so the browser omits them.
    // Under `no_cascade` they would coerce to "" / blank and be rejected or
    // clobbered; with the cascade they are left exactly as stored.
    const res = await harness.post("/settings/save-section", CARD);
    const flash = parseFlashRedirect(res.headers.get("location"));
    expect(flash.path).toBe("/admin/digest");
    expect(flash.type).toBe("ok");
    expect(flash.msg).toBe("Saved 1 setting in digest.");
    expect(mockConfigSet).toHaveBeenCalledTimes(1);
    expect(mockConfigSet.mock.calls[0][0]).toBe("digest.enabled");
    expect(mockConfigSet.mock.calls[0][1]).toBe(false);
    // Only the master reaches dependency validation.
    expect(mockFindDependencyIssues).toHaveBeenCalledWith({
      "digest.enabled": false,
    });
  });

  it("disabling without JS skips dependents even though they were submitted", async () => {
    // No-JS path: nothing greys out, so the dependents arrive — possibly
    // edited. The save matches what the JS page shows (dependents inert
    // while off) and never applies a half-edited dependent.
    const res = await harness.post("/settings/save-section", {
      ...CARD,
      "value_digest.min_active_minutes": "5",
      "value_digest.cron": "0 9 * * 1",
    });
    expect(parseFlashRedirect(res.headers.get("location")).type).toBe("ok");
    expect(mockConfigSet).toHaveBeenCalledTimes(1);
    expect(mockConfigSet.mock.calls[0][0]).toBe("digest.enabled");
  });

  it("disabling is refused, not silently half-applied, while a dependent still needs the master", async () => {
    // `voicetracking.announcements.enabled` hard-depends on
    // `voicetracking.enabled`. The skipped sub-toggle stays on, so the
    // reverse dependency rule (#663) blocks the disable and says why,
    // instead of leaving announcements on over a disabled tracker.
    mockFindDependencyIssues.mockResolvedValue([
      {
        key: "voicetracking.enabled",
        message:
          "Cannot disable Voice tracking: Voice announcements still depends on it.",
      },
    ]);
    const res = await harness.post("/settings/save-section", {
      category: "voicetracking",
      keys: ["voicetracking.enabled", "voicetracking.announcements.enabled"],
    });
    const flash = parseFlashRedirect(res.headers.get("location"));
    expect(mockFindDependencyIssues).toHaveBeenCalledWith({
      "voicetracking.enabled": false,
    });
    expect(flash.type).toBe("err");
    expect(flash.msg).toContain("still depends on it");
    expect(flash.invalid).toEqual(["voicetracking.enabled"]);
    expect(mockConfigSet).not.toHaveBeenCalled();
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

  it("re-arms the jobs whose schedule keys were imported (#1013)", async () => {
    // A stored value can't prove the key is unchanged (a failed read comes
    // back null), so an imported key re-arms even when it looks the same.
    mockConfigGet.mockImplementation(async (key) =>
      key === "reminders.enabled" ? true : null,
    );
    const res = await harness.post("/settings/import/apply", {
      yaml: "rewind.cron: 0 10 1 12 *\nreminders.enabled: true\nquotes.max_length: 500",
    });
    expect(parseFlashRedirect(res.headers.get("location")).type).toBe("ok");
    expect(mockRewindNudgeReload).toHaveBeenCalledTimes(1);
    expect(mockReminderReload).toHaveBeenCalledTimes(1);
    expect(mockDigestReload).not.toHaveBeenCalled();
  });

  it("warns when an imported schedule can't be re-armed (#1013)", async () => {
    mockBirthdayReload.mockRejectedValueOnce(new Error("boom"));
    const res = await harness.post("/settings/import/apply", {
      yaml: "birthdays.cron: 0 8 * * *",
    });
    const flash = parseFlashRedirect(res.headers.get("location"));
    expect(flash.type).toBe("warn");
    expect(flash.msg).toContain("Imported 1 setting.");
    expect(flash.msg).toContain("birthdays schedule could not be re-armed");
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
