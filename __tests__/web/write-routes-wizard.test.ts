/**
 * Route-handler tests for the Setup Wizard write router (issue #849).
 *
 * The wizard is the guided path through the admin surface and was at ~5%
 * coverage. The behaviours worth pinning are the ones an operator would
 * only discover by losing work: the feature allowlist on start, the audit
 * trail when a start clobbers someone else's in-progress session, the
 * cascade that skips greyed-out dependents (#485), the "stay on this step"
 * rule when a value fails coercion, and the fact that apply explicitly
 * disables every unticked feature.
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
const mockGetSession = jest.fn<() => unknown>();
const mockCreateSession = jest.fn();
const mockAddConfiguration = jest.fn();
const mockApplyConfiguration = jest.fn<() => Promise<unknown>>();
const mockEndSession = jest.fn();

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
  // `read-only-routes.js` (pulled in for the wizard's channel/role pickers)
  // imports this named export alongside the default logger.
  isDebugMode: (): boolean => false,
}));

jest.unstable_mockModule("../../src/services/wizard-service.js", () => ({
  WizardService: {
    getInstance: (): unknown => ({
      getSession: mockGetSession,
      createSession: mockCreateSession,
      addConfiguration: mockAddConfiguration,
      applyConfiguration: mockApplyConfiguration,
      endSession: mockEndSession,
    }),
  },
}));

jest.unstable_mockModule("../../src/services/config-service.js", () => ({
  ConfigService: {
    getInstance: (): unknown => ({
      get: jest.fn(async () => null),
      getString: jest.fn(async () => ""),
      getNumber: jest.fn(async () => 0),
      getBoolean: jest.fn(async () => false),
      getAll: jest.fn(async () => new Map()),
      registerReloadCallback: jest.fn(),
    }),
  },
}));

const { createWizardRouter } =
  await import("../../src/web/routes/write/wizard.js");
const { requireCsrf } = await import("../../src/web/csrf.js");
const { requireAdminRoleMiddleware } = await import("../../src/web/session.js");
const { WIZARD_FEATURE_ORDER } =
  await import("../../src/web/routes/write/helpers.js");

const client = { user: { id: "bot" } } as unknown as Client;
const session = createTestSession();
let harness: AdminHarness;

/** A wizard session as `WizardService.getSession` would return it. */
function wizardState(
  selectedFeatures: string[],
  configuration: Record<string, unknown> = {},
): Record<string, unknown> {
  return { selectedFeatures, configuration };
}

beforeEach(async () => {
  jest.clearAllMocks();
  mockGetSession.mockReturnValue(null);
  harness = await startAdminHarness([
    stubRequireSession(session),
    requireAdminRoleMiddleware(),
    requireCsrf,
    createWizardRouter(client),
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

describe("POST /wizard/start", () => {
  it("requires at least one recognised feature", async () => {
    const res = await harness.post("/wizard/start", {});
    const flash = parseFlashRedirect(res.headers.get("location"));
    expect(flash.path).toBe("/admin/wizard");
    expect(flash.msg).toBe("Pick at least one feature to configure.");
    expect(mockCreateSession).not.toHaveBeenCalled();
  });

  it("drops feature names that are not in the wizard's allowlist", async () => {
    const res = await harness.post("/wizard/start", {
      features: ["quotes", "not-a-feature"],
    });
    expect(mockCreateSession).toHaveBeenCalledWith(
      session.discordUserId,
      session.guildId,
      ["quotes"],
    );
    expect(res.headers.get("location")).toBe("/admin/wizard?step=0");
  });

  it("rejects a submission whose only feature is unrecognised", async () => {
    const res = await harness.post("/wizard/start", {
      features: "not-a-feature",
    });
    expect(parseFlashRedirect(res.headers.get("location")).type).toBe("err");
    expect(mockCreateSession).not.toHaveBeenCalled();
  });

  it("audits what a restart discarded so a clobbered session is traceable", async () => {
    mockGetSession.mockReturnValue(
      wizardState(["polls"], { "polls.enabled": true }),
    );
    await harness.post("/wizard/start", { features: "quotes" });
    expect(lastAudit()).toMatchObject({
      action: "wizard.start",
      result: "success",
      details: {
        features: ["quotes"],
        replacedExisting: true,
        discardedKeys: ["polls.enabled"],
      },
    });
  });

  it("records replacedExisting: false for a fresh start", async () => {
    await harness.post("/wizard/start", { features: "quotes" });
    expect(lastAudit()).toMatchObject({
      details: { replacedExisting: false, discardedKeys: [] },
    });
  });
});

describe("POST /wizard/step/:n", () => {
  it("sends the operator back to the start when the session expired", async () => {
    const res = await harness.post("/wizard/step/0", {});
    const flash = parseFlashRedirect(res.headers.get("location"));
    expect(flash.type).toBe("warn");
    expect(flash.msg).toContain("Wizard session expired");
    expect(mockAddConfiguration).not.toHaveBeenCalled();
  });

  it.each(["-1", "5", "notanumber"])(
    "rejects an out-of-range step index (%s)",
    async (step) => {
      mockGetSession.mockReturnValue(wizardState(["quotes"]));
      const res = await harness.post(`/wizard/step/${step}`, {});
      const flash = parseFlashRedirect(res.headers.get("location"));
      expect(flash.type).toBe("err");
      expect(flash.msg).toBe("Invalid wizard step.");
      expect(mockAddConfiguration).not.toHaveBeenCalled();
    },
  );

  it("records every submitted key and advances to the confirm page", async () => {
    mockGetSession.mockReturnValue(wizardState(["quotes"]));
    const res = await harness.post("/wizard/step/0", {
      "value_quotes.enabled": "true",
      "value_quotes.channel_id": "channel-9",
      "value_quotes.max_length": "800",
      "value_quotes.cooldown": "30",
      "value_quotes.header_enabled": "true",
    });
    expect(res.headers.get("location")).toBe("/admin/wizard?step=confirm");
    const recorded = Object.fromEntries(
      mockAddConfiguration.mock.calls.map((c) => [c[2], c[3]]),
    );
    expect(recorded).toMatchObject({
      "quotes.enabled": true,
      "quotes.channel_id": "channel-9",
      "quotes.max_length": 800,
      "quotes.cooldown": 30,
    });
    expect(lastAudit()).toMatchObject({
      action: "wizard.step",
      result: "success",
    });
  });

  it("advances to the next step when more features remain", async () => {
    mockGetSession.mockReturnValue(wizardState(["quotes", "polls"]));
    const res = await harness.post("/wizard/step/0", {
      "value_quotes.enabled": "true",
      "value_quotes.channel_id": "",
      "value_quotes.max_length": "800",
      "value_quotes.cooldown": "30",
      "value_quotes.header_enabled": "true",
    });
    expect(res.headers.get("location")).toBe("/admin/wizard?step=1");
  });

  it("records only the master flag when the feature was switched off (#485)", async () => {
    mockGetSession.mockReturnValue(wizardState(["quotes"]));
    // Dependents are greyed out client-side and not submitted; without the
    // cascade the absent number fields would fail coercion and be reported
    // as bogus "invalid input" drops.
    const res = await harness.post("/wizard/step/0", {});
    expect(res.headers.get("location")).toBe("/admin/wizard?step=confirm");
    expect(mockAddConfiguration).toHaveBeenCalledTimes(1);
    expect(mockAddConfiguration.mock.calls[0][2]).toBe("quotes.enabled");
    expect(mockAddConfiguration.mock.calls[0][3]).toBe(false);
  });

  it("keeps the operator on the step and names the dropped fields", async () => {
    mockGetSession.mockReturnValue(wizardState(["quotes"]));
    const res = await harness.post("/wizard/step/0", {
      "value_quotes.enabled": "true",
      "value_quotes.channel_id": "channel-9",
      "value_quotes.max_length": "not-a-number",
      "value_quotes.cooldown": "30",
      "value_quotes.header_enabled": "true",
    });
    const location = res.headers.get("location") ?? "";
    expect(location).toContain("step=0");
    const flash = parseFlashRedirect(location);
    expect(flash.type).toBe("warn");
    expect(flash.msg).toContain("quotes.max_length");
    expect(lastAudit()).toMatchObject({
      action: "wizard.step",
      result: "failure",
    });
    // The valid keys in the same submission are still recorded, so the
    // operator only has to correct the offending field.
    const recorded = mockAddConfiguration.mock.calls.map((c) => c[2]);
    expect(recorded).toContain("quotes.channel_id");
    expect(recorded).not.toContain("quotes.max_length");
  });
});

describe("POST /wizard/apply", () => {
  it("sends the operator back to the start when the session expired", async () => {
    const res = await harness.post("/wizard/apply");
    expect(parseFlashRedirect(res.headers.get("location")).type).toBe("warn");
    expect(mockApplyConfiguration).not.toHaveBeenCalled();
  });

  it("explicitly disables every feature the admin did not tick", async () => {
    mockGetSession.mockReturnValue(
      wizardState(["quotes"], { "quotes.enabled": true }),
    );
    mockApplyConfiguration.mockResolvedValue({
      success: true,
      appliedKeys: ["quotes.enabled"],
      rolledBackKeys: [],
      revertFailedKeys: [],
    });
    await harness.post("/wizard/apply");
    const disabled = mockAddConfiguration.mock.calls
      .filter((c) => c[3] === false)
      .map((c) => c[2]);
    for (const feature of WIZARD_FEATURE_ORDER) {
      if (feature === "quotes") continue;
      expect(disabled).toContain(`${feature}.enabled`);
    }
  });

  it("ends the session and lands on Settings after a successful apply", async () => {
    mockGetSession.mockReturnValue(
      wizardState(["quotes"], { "quotes.enabled": true }),
    );
    mockApplyConfiguration.mockResolvedValue({
      success: true,
      appliedKeys: ["quotes.enabled"],
      rolledBackKeys: [],
      revertFailedKeys: [],
    });
    const res = await harness.post("/wizard/apply");
    const flash = parseFlashRedirect(res.headers.get("location"));
    expect(flash.path).toBe("/admin/settings");
    expect(flash.type).toBe("ok");
    expect(flash.msg).toBe("Wizard applied 1 setting.");
    expect(mockEndSession).toHaveBeenCalledWith(
      session.discordUserId,
      session.guildId,
    );
    expect(lastAudit()).toMatchObject({
      action: "wizard.apply",
      result: "success",
    });
  });

  it("keeps the session on a failed apply so the operator can retry (#780)", async () => {
    mockGetSession.mockReturnValue(
      wizardState(["quotes"], { "quotes.enabled": true }),
    );
    mockApplyConfiguration.mockResolvedValue({
      success: false,
      appliedKeys: [],
      failedKey: "quotes.enabled",
      errorMessage: "write failed",
      rolledBackKeys: [],
      revertFailedKeys: [],
    });
    const res = await harness.post("/wizard/apply");
    const location = res.headers.get("location") ?? "";
    expect(location).toContain("step=confirm");
    const flash = parseFlashRedirect(location);
    expect(flash.type).toBe("err");
    expect(flash.msg).toContain("quotes.enabled");
    expect(mockEndSession).not.toHaveBeenCalled();
    expect(lastAudit()).toMatchObject({
      result: "failure",
      errorMessage: "write failed",
    });
  });

  it("ends the session and flashes when applyConfiguration threw", async () => {
    mockGetSession.mockReturnValue(wizardState(["quotes"], {}));
    mockApplyConfiguration.mockRejectedValue(new Error("mongo down"));
    const res = await harness.post("/wizard/apply");
    const flash = parseFlashRedirect(res.headers.get("location"));
    expect(flash.path).toBe("/admin/settings");
    expect(flash.type).toBe("err");
    expect(flash.msg).toContain("mongo down");
    expect(mockEndSession).toHaveBeenCalled();
  });
});

describe("POST /wizard/cancel", () => {
  it("discards an in-progress session and records what was dropped", async () => {
    mockGetSession.mockReturnValue(
      wizardState(["quotes"], { "quotes.enabled": true }),
    );
    const res = await harness.post("/wizard/cancel");
    const flash = parseFlashRedirect(res.headers.get("location"));
    expect(flash.path).toBe("/admin/");
    expect(flash.type).toBe("ok");
    expect(mockEndSession).toHaveBeenCalled();
    expect(lastAudit()).toMatchObject({
      action: "wizard.cancel",
      details: { hadSession: true, discardedKeys: ["quotes.enabled"] },
    });
  });

  it("is a no-op-but-audited cancel when there was no session", async () => {
    const res = await harness.post("/wizard/cancel");
    expect(parseFlashRedirect(res.headers.get("location")).type).toBe("ok");
    expect(lastAudit()).toMatchObject({
      details: { hadSession: false, discardedKeys: [] },
    });
  });
});
