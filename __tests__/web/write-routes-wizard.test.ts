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
const mockRemoveConfiguration = jest.fn();
const mockApplyConfiguration = jest.fn<() => Promise<unknown>>();
const mockEndSession = jest.fn();
const mockConfigGetAll = jest.fn<() => Promise<unknown>>(async () => []);
const mockConfigGet = jest.fn(async () => null);
const mockConfigGetBoolean = jest.fn<(key: string) => Promise<boolean>>(
  async () => false,
);
// The strict read the dependency check gates writes on; by default it answers
// like the forgiving one, so a test makes it reject to simulate a failed read.
const mockConfigGetBooleanStrict = jest.fn<
  (key: string, defaultValue?: boolean) => Promise<boolean>
>(async (key) => mockConfigGetBoolean(key));
const mockConfigGetStringStrict = jest.fn(
  async (_key: string, defaultValue: string = ""): Promise<string> =>
    defaultValue,
);

jest.unstable_mockModule("../../src/web/audit.js", () => ({
  recordAudit: mockRecordAudit,
  recordAuditOrThrow: mockRecordAudit,
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

// The REST wrapper the Administrator check reads through: no backoff in tests.
jest.unstable_mockModule("../../src/services/command-manager.js", () => ({
  CommandManager: {
    getInstance: (): unknown => ({
      makeDiscordApiCall: async (
        fn: () => Promise<unknown>,
      ): Promise<unknown> => fn(),
    }),
  },
}));

jest.unstable_mockModule("../../src/services/wizard-service.js", () => ({
  WizardService: {
    getInstance: (): unknown => ({
      getSession: mockGetSession,
      createSession: mockCreateSession,
      addConfiguration: mockAddConfiguration,
      removeConfiguration: mockRemoveConfiguration,
      applyConfiguration: mockApplyConfiguration,
      endSession: mockEndSession,
      getConfiguration: (): undefined => undefined,
    }),
  },
}));

jest.unstable_mockModule("../../src/services/config-service.js", () => ({
  ConfigService: {
    getInstance: (): unknown => ({
      get: mockConfigGet,
      getStringStrict: mockConfigGetStringStrict,
      getString: jest.fn(async () => ""),
      getNumber: jest.fn(async () => 0),
      getBoolean: mockConfigGetBoolean,
      getBooleanStrict: mockConfigGetBooleanStrict,
      getAll: mockConfigGetAll,
      registerReloadCallback: jest.fn(),
    }),
  },
}));

const { RoleGroupService } =
  await import("../../src/services/role-group-service.js");
const { createWizardRouter } =
  await import("../../src/web/routes/write/wizard.js");
const { requireCsrf } = await import("../../src/web/csrf.js");
const { requireAdminRoleMiddleware } = await import("../../src/web/session.js");
const { WIZARD_FEATURE_ORDER, WIZARD_FEATURE_SETTINGS } =
  await import("../../src/web/routes/write/helpers.js");
const { ReactionRoleConfig } =
  await import("../../src/models/reaction-role-config.js");

/** The guild's roles by id, for the powerful-role check (#1145). */
const roleCache = new Map<
  string,
  { id: string; name: string; permissions: { bitfield: bigint } }
>();
/**
 * The bot's own membership for the Administrator check (#1617). Null (the
 * default) is a server whose members cannot be read, so the check is "unknown",
 * which is what every older test here relies on.
 */
let botMember: {
  permissionBits: bigint;
  /** Roles in view; an empty list is a bot whose roles could not be read. */
  roleCount: number;
} | null = null;
const mockFetchMe = jest.fn<() => Promise<unknown>>();
function memberOf(m: NonNullable<typeof botMember>): unknown {
  return {
    permissions: {
      has: (bit: bigint): boolean => (m.permissionBits & bit) === bit,
    },
    roles: { cache: { size: m.roleCount } },
  };
}
const client = {
  user: { id: "123456789012345678" },
  guilds: {
    cache: {
      get: (): unknown =>
        botMember
          ? {
              roles: { fetch: async (): Promise<unknown> => [] },
              members: {
                get me(): unknown {
                  return memberOf(botMember as NonNullable<typeof botMember>);
                },
                fetchMe: mockFetchMe,
              },
            }
          : undefined,
    },
    fetch: async (): Promise<unknown> => ({
      roles: { fetch: async () => undefined, cache: roleCache },
    }),
  },
} as unknown as Client;
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
  roleCache.clear();
  roleCache.set("999999999999999999", {
    id: "999999999999999999",
    name: "Admins",
    permissions: { bitfield: 0x8n },
  });
  mockGetSession.mockReturnValue(null);
  botMember = null;
  mockFetchMe.mockReset();
  jest
    .spyOn(RoleGroupService.getInstance(), "groupBackedRoles")
    .mockImplementation(async (_g, ids) =>
      ids.includes("777777777777777777")
        ? [{ roleId: "777777777777777777", groupName: "Moderators" }]
        : [],
    );
  mockConfigGetAll.mockImplementation(async () => []);
  mockConfigGetBoolean.mockImplementation(async () => false);
  mockConfigGetBooleanStrict.mockImplementation(async (key) =>
    mockConfigGetBoolean(key),
  );
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

/** The derived writes the last apply passed to the engine for that attempt only. */
function lastDerived(): Record<string, unknown> {
  const calls = mockApplyConfiguration.mock.calls as unknown as unknown[][];
  expect(calls.length).toBeGreaterThan(0);
  return calls[calls.length - 1][2] as Record<string, unknown>;
}

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
    expect(res.headers.get("location")).toBe("/admin/wizard?step=access");
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

describe("GET /wizard?step=n", () => {
  it("renders the step form when the stored config can be read", async () => {
    mockGetSession.mockReturnValue(wizardState(["quotes"]));
    const res = await harness.get("/wizard?step=0");
    const html = await res.text();
    expect(res.status).toBe(200);
    expect(html).toContain('<form method="POST" action="/admin/wizard/step/0"');
    expect(html).not.toContain("Settings could not be loaded");
  });

  it("pre-fills from the snapshot rather than per-key reads", async () => {
    // A per-key `config.get` failure would come back as null (blank
    // controls), so values must come from the one snapshot read.
    mockConfigGetAll.mockResolvedValue([
      { key: "quotes.max_length", value: 777 },
    ]);
    mockGetSession.mockReturnValue(wizardState(["quotes"]));
    const res = await harness.get("/wizard?step=0");
    const html = await res.text();
    expect(res.status).toBe(200);
    expect(html).toMatch(/name="value_quotes\.max_length"[^>]*value="777"/);
    expect(mockConfigGet).not.toHaveBeenCalled();
  });

  it("fails closed with a notice when the stored config can't be read", async () => {
    // `config.get` would return null for every key, pre-filling blank
    // controls that an apply would then persist.
    mockConfigGetAll.mockRejectedValue(new Error("mongo down"));
    mockGetSession.mockReturnValue(wizardState(["quotes"]));
    const res = await harness.get("/wizard?step=0");
    const html = await res.text();
    expect(res.status).toBe(200);
    expect(html).toContain("Settings could not be loaded");
    expect(html).not.toContain('action="/admin/wizard/step/0"');
    expect(html).toContain('href="/admin/wizard"');
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

  it("refuses a timezone and an over-cap prefix (#1426, #1435)", async () => {
    mockGetSession.mockReturnValue(wizardState(["events"]));
    const res = await harness.post("/wizard/step/0", {
      "value_events.enabled": "true",
      "value_events.timezone": "Mars/Olympus",
      "value_events.channel_prefix": "x".repeat(33),
    });
    const recorded = mockAddConfiguration.mock.calls.map((c) => c[2]);
    expect(recorded).toContain("events.enabled");
    expect(recorded).not.toContain("events.timezone");
    expect(recorded).not.toContain("events.channel_prefix");
    expect(parseFlashRedirect(res.headers.get("location") ?? "").type).not.toBe(
      "ok",
    );
  });

  it("keeps an unchanged stored prefix with a shortcode in a wizard step (#1438)", async () => {
    mockGetSession.mockReturnValue(wizardState(["events"]));
    mockConfigGet.mockImplementation((async (key: string) =>
      key === "events.channel_prefix" ? "[VC] :sparkles:" : null) as never);
    await harness.post("/wizard/step/0", {
      "value_events.enabled": "true",
      "value_events.channel_prefix": "[VC] :sparkles:",
    });
    const recorded = Object.fromEntries(
      mockAddConfiguration.mock.calls.map((c) => [c[2], c[3]]),
    );
    expect(recorded["events.channel_prefix"]).toBe("[VC] :sparkles:");
  });

  it("accepts a long text prefix in a wizard step (#1435)", async () => {
    mockGetSession.mockReturnValue(wizardState(["events"]));
    await harness.post("/wizard/step/0", {
      "value_events.enabled": "true",
      "value_events.channel_prefix": "Looking for group: ",
    });
    const recorded = Object.fromEntries(
      mockAddConfiguration.mock.calls.map((c) => [c[2], c[3]]),
    );
    expect(recorded["events.channel_prefix"]).toBe("Looking for group: ");
  });

  it("keeps a stored value a picker could not produce, and turns Use default into empty (#1426)", async () => {
    mockGetSession.mockReturnValue(wizardState(["events", "reactionroles"]));
    mockConfigGet.mockImplementation((async (key: string) =>
      key === "events.timezone" ? "Mars/Olympus" : null) as never);
    await harness.post("/wizard/step/0", {
      "value_events.enabled": "true",
      "value_events.timezone": "Mars/Olympus",
    });
    expect(
      Object.fromEntries(
        mockAddConfiguration.mock.calls.map((c) => [c[2], c[3]]),
      ),
    ).toMatchObject({ "events.timezone": "Mars/Olympus" });
    mockAddConfiguration.mockClear();
    mockGetSession.mockReturnValue(wizardState(["reactionroles"]));
    await harness.post("/wizard/step/0", {
      "value_reactionroles.enabled": "true",
      "value_reactionroles.group_role_colour": "#99aab5",
      "use_default_reactionroles.group_role_colour": "true",
    });
    expect(
      Object.fromEntries(
        mockAddConfiguration.mock.calls.map((c) => [c[2], c[3]]),
      ),
    ).toMatchObject({ "reactionroles.group_role_colour": "" });
    mockConfigGet.mockImplementation((async () => null) as never);
  });

  it("stages nothing for a Keep colour when the stored value cannot be read, and keeps the user on the step", async () => {
    mockGetSession.mockReturnValue(wizardState(["reactionroles"]));
    mockConfigGetStringStrict.mockRejectedValueOnce(new Error("db down"));
    const res = await harness.post("/wizard/step/0", {
      "value_reactionroles.enabled": "true",
      "value_reactionroles.group_role_colour": "#99aab5",
      "keep_reactionroles.group_role_colour": "true",
    });
    const recorded = mockAddConfiguration.mock.calls.map((c) => c[2]);
    expect(recorded).not.toContain("reactionroles.group_role_colour");
    const loc = res.headers.get("location") ?? "";
    expect(loc).toContain("step=0");
    expect(parseFlashRedirect(loc).type).not.toBe("ok");
    expect(decodeURIComponent(loc.replace(/\+/g, " "))).toContain(
      "could not be read",
    );
  });

  it("stages the recovered legacy colour for Keep when get() failed but the strict read succeeds", async () => {
    mockGetSession.mockReturnValue(wizardState(["reactionroles"]));
    // `get()` failed (null) but the strict read recovered the legacy colour:
    // the recovered value is also the coercion baseline, so `red` is accepted.
    mockConfigGetStringStrict.mockResolvedValueOnce("red");
    await harness.post("/wizard/step/0", {
      "value_reactionroles.enabled": "true",
      "value_reactionroles.group_role_colour": "#99aab5",
      "keep_reactionroles.group_role_colour": "true",
    });
    expect(
      Object.fromEntries(
        mockAddConfiguration.mock.calls.map((c) => [c[2], c[3]]),
      ),
    ).toMatchObject({ "reactionroles.group_role_colour": "red" });
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

  it("drops a birthday role that backs a role group and says why (#1023)", async () => {
    mockGetSession.mockReturnValue(wizardState(["birthdays"]));
    const res = await harness.post("/wizard/step/0", {
      "value_birthdays.enabled": "true",
      "value_birthdays.role_id": "777777777777777777",
    });
    const location = res.headers.get("location") ?? "";
    expect(location).toContain("step=0");
    expect(parseFlashRedirect(location).msg).toContain("Moderators");
    const recorded = mockAddConfiguration.mock.calls.map((c) => c[2]);
    expect(recorded).not.toContain("birthdays.role_id");
    expect(recorded).toContain("birthdays.enabled");
  });

  it("records a birthday role no group backs (#1023)", async () => {
    mockGetSession.mockReturnValue(wizardState(["birthdays"]));
    await harness.post("/wizard/step/0", {
      "value_birthdays.enabled": "true",
      "value_birthdays.role_id": "888888888888888888",
    });
    const recorded = Object.fromEntries(
      mockAddConfiguration.mock.calls.map((c) => [c[2], c[3]]),
    );
    expect(recorded["birthdays.role_id"]).toBe("888888888888888888");
  });

  it("drops a birthday role with Administrator and names the permission (#1145)", async () => {
    mockGetSession.mockReturnValue(wizardState(["birthdays"]));
    const res = await harness.post("/wizard/step/0", {
      "value_birthdays.enabled": "true",
      "value_birthdays.role_id": "999999999999999999",
    });
    expect(parseFlashRedirect(res.headers.get("location")).msg).toContain(
      "Administrator",
    );
    const recorded = mockAddConfiguration.mock.calls.map((c) => c[2]);
    expect(recorded).not.toContain("birthdays.role_id");
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

describe("welcome step: the roles message is picked, never typed (#1433)", () => {
  const KEY = "welcome.roles_message_id";
  const FIELD = `value_${KEY}`;
  const MINE = "100000000000000001";
  const STRAY = "200000000000000002";
  // Mongoose is stubbed for the whole suite (`__tests__/setup.ts`) and the
  // stub has no `distinct`, so the test supplies it.
  const model = ReactionRoleConfig as unknown as {
    distinct?: jest.Mock<(f: string, q: unknown) => Promise<unknown[]>>;
    aggregate: jest.Mock<(p: unknown[]) => Promise<unknown[]>>;
  };

  beforeEach(() => {
    model.distinct = jest.fn<(f: string, q: unknown) => Promise<unknown[]>>();
    model.distinct.mockResolvedValue([MINE]);
    model.aggregate.mockReset();
    model.aggregate.mockResolvedValue([
      {
        _id: MINE,
        messageChannelId: "222222222222222222",
        roles: [{ emoji: "🎮", roleName: "Gamer" }],
      },
    ]);
  });

  afterEach(() => {
    delete model.distinct;
    model.aggregate.mockReset();
    model.aggregate.mockResolvedValue([]);
  });

  function staged(): Record<string, unknown> {
    return Object.fromEntries(
      mockAddConfiguration.mock.calls.map((c) => [
        (c as unknown[])[2],
        (c as unknown[])[3],
      ]),
    );
  }

  it("renders a select of the guild's reaction-role messages in place of a text box", async () => {
    mockGetSession.mockReturnValue(wizardState(["welcome"]));
    const html = await (await harness.get("/wizard?step=0")).text();
    expect(html).not.toMatch(
      /<input[^>]*name="value_welcome\.roles_message_id"/,
    );
    expect(html).toMatch(
      /<select class="kb-select"[^>]*name="value_welcome\.roles_message_id"/,
    );
    expect(html).toContain(`<option value="${MINE}">`);
    expect(html).toContain("Link the channel instead");
    expect(model.aggregate.mock.calls[0][0][0]).toEqual({
      $match: { guildId: "guild-1", isArchived: false },
    });
  });

  it("stages a chosen message", async () => {
    mockGetSession.mockReturnValue(wizardState(["welcome"]));
    await harness.post("/wizard/step/0", {
      "value_welcome.enabled": "true",
      [FIELD]: MINE,
    });
    expect(staged()[KEY]).toBe(MINE);
  });

  it("stages nothing for an id outside the set and keeps the operator on the step", async () => {
    mockGetSession.mockReturnValue(wizardState(["welcome"]));
    const res = await harness.post("/wizard/step/0", {
      "value_welcome.enabled": "true",
      [FIELD]: STRAY,
    });
    expect(Object.keys(staged())).not.toContain(KEY);
    const loc = res.headers.get("location") ?? "";
    expect(loc).toContain("step=0");
    expect(decodeURIComponent(loc.replace(/\+/g, " "))).toContain(
      "reaction-role messages",
    );
  });

  it("stages an unchanged stored value that is no longer one of them", async () => {
    mockGetSession.mockReturnValue(wizardState(["welcome"]));
    mockConfigGetStringStrict.mockResolvedValueOnce(STRAY);
    await harness.post("/wizard/step/0", {
      "value_welcome.enabled": "true",
      [FIELD]: STRAY,
    });
    expect(staged()[KEY]).toBe(STRAY);
  });

  it("stages nothing when the stored value cannot be read", async () => {
    mockGetSession.mockReturnValue(wizardState(["welcome"]));
    mockConfigGetStringStrict.mockRejectedValueOnce(new Error("db down"));
    const res = await harness.post("/wizard/step/0", {
      "value_welcome.enabled": "true",
      [FIELD]: STRAY,
    });
    expect(Object.keys(staged())).not.toContain(KEY);
    expect(res.headers.get("location") ?? "").toContain("step=0");
  });

  it("clears the choice with the empty option", async () => {
    mockGetSession.mockReturnValue(wizardState(["welcome"]));
    await harness.post("/wizard/step/0", {
      "value_welcome.enabled": "true",
      [FIELD]: "",
    });
    expect(staged()[KEY]).toBe("");
  });

  describe("apply rechecks the staged choice", () => {
    const applied = {
      success: true,
      appliedKeys: [],
      rolledBackKeys: [],
      revertFailedKeys: [],
    };

    function stage(id: string): void {
      mockGetSession.mockReturnValue(
        wizardState(["welcome"], { "welcome.enabled": true, [KEY]: id }),
      );
      mockApplyConfiguration.mockResolvedValue(applied);
    }

    it("applies a staged message that is still active", async () => {
      stage(MINE);
      await harness.post("/wizard/apply");
      expect(mockApplyConfiguration).toHaveBeenCalled();
    });

    it("applies nothing when the message was archived after the step was saved", async () => {
      stage(MINE);
      model.distinct?.mockResolvedValue([]);
      const res = await harness.post("/wizard/apply");
      const flash = parseFlashRedirect(res.headers.get("location"));
      expect(flash.type).toBe("err");
      expect(flash.msg).toContain("Nothing was applied");
      expect(flash.msg).toContain(KEY);
      expect(mockApplyConfiguration).not.toHaveBeenCalled();
      expect(mockAddConfiguration).not.toHaveBeenCalled();
      expect(mockEndSession).not.toHaveBeenCalled();
      expect(lastAudit()).toMatchObject({
        action: "wizard.apply",
        result: "failure",
      });
    });

    it("still applies an unchanged stored value that is no longer active", async () => {
      stage(STRAY);
      mockConfigGetStringStrict.mockResolvedValueOnce(STRAY);
      model.distinct?.mockResolvedValue([]);
      await harness.post("/wizard/apply");
      expect(mockApplyConfiguration).toHaveBeenCalled();
    });

    it("applies nothing when the stored value cannot be read", async () => {
      stage(MINE);
      mockConfigGetStringStrict.mockRejectedValueOnce(new Error("db down"));
      const res = await harness.post("/wizard/apply");
      expect(parseFlashRedirect(res.headers.get("location")).type).toBe("err");
      expect(mockApplyConfiguration).not.toHaveBeenCalled();
    });

    it("applies nothing when the list of messages cannot be read", async () => {
      stage(MINE);
      model.distinct?.mockRejectedValue(new Error("db down"));
      const res = await harness.post("/wizard/apply");
      expect(parseFlashRedirect(res.headers.get("location")).type).toBe("err");
      expect(mockApplyConfiguration).not.toHaveBeenCalled();
    });

    it("applies an empty choice without asking for the list", async () => {
      stage("");
      await harness.post("/wizard/apply");
      expect(mockApplyConfiguration).toHaveBeenCalled();
      expect(model.distinct).not.toHaveBeenCalled();
    });
  });

  it("no longer asks for the leaderboard tier string, and points at the tier editor", async () => {
    expect(WIZARD_FEATURE_SETTINGS.leaderboard_roles).not.toContain(
      "leaderboard_roles.tiers",
    );
    mockGetSession.mockReturnValue(wizardState(["leaderboard_roles"]));
    const html = await (await harness.get("/wizard?step=0")).text();
    expect(html).not.toContain("value_leaderboard_roles.tiers");
    expect(html).toContain('href="/admin/leaderboard-roles"');
  });
});

describe("POST /wizard/apply", () => {
  it("sends the operator back to the start when the session expired", async () => {
    const res = await harness.post("/wizard/apply");
    expect(parseFlashRedirect(res.headers.get("location")).type).toBe("warn");
    expect(mockApplyConfiguration).not.toHaveBeenCalled();
  });

  it("applies nothing when a saved role has since become group-backed (#1023)", async () => {
    mockGetSession.mockReturnValue(
      wizardState(["birthdays"], {
        "birthdays.enabled": true,
        "birthdays.role_id": "777777777777777777",
      }),
    );
    const res = await harness.post("/wizard/apply");
    const flash = parseFlashRedirect(res.headers.get("location"));
    expect(flash.type).toBe("err");
    expect(flash.path).toBe("/admin/wizard");
    expect(flash.msg).toContain("Nothing was applied");
    expect(flash.msg).toContain("Moderators");
    expect(mockApplyConfiguration).not.toHaveBeenCalled();
    expect(mockAddConfiguration).not.toHaveBeenCalled();
    expect(mockEndSession).not.toHaveBeenCalled();
    expect(lastAudit()).toMatchObject({
      action: "wizard.apply",
      result: "failure",
    });
  });

  it("applies nothing when a saved role carries Administrator (#1145)", async () => {
    mockGetSession.mockReturnValue(
      wizardState(["birthdays"], {
        "birthdays.enabled": true,
        "birthdays.role_id": "999999999999999999",
      }),
    );
    const res = await harness.post("/wizard/apply");
    const flash = parseFlashRedirect(res.headers.get("location"));
    expect(flash.type).toBe("err");
    expect(flash.msg).toContain("Administrator");
    expect(mockApplyConfiguration).not.toHaveBeenCalled();
  });

  it("applies a saved role no group backs (#1023)", async () => {
    mockGetSession.mockReturnValue(
      wizardState(["birthdays"], {
        "birthdays.enabled": true,
        "birthdays.role_id": "888888888888888888",
      }),
    );
    mockApplyConfiguration.mockResolvedValue({
      success: true,
      appliedKeys: [],
      rolledBackKeys: [],
      revertFailedKeys: [],
    });
    await harness.post("/wizard/apply");
    expect(mockApplyConfiguration).toHaveBeenCalled();
  });

  it("explicitly disables every feature the admin did not tick, for this apply only", async () => {
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
    // Derived values go into this attempt's batch, never into the saved choices.
    expect(
      mockAddConfiguration.mock.calls.filter((c) => c[3] === false),
    ).toEqual([]);
    const derived = lastDerived();
    for (const feature of WIZARD_FEATURE_ORDER) {
      if (feature === "quotes") continue;
      expect(derived[`${feature}.enabled`]).toBe(false);
    }
    // Independent command gates go off with their feature.
    expect(derived["aka.enabled"]).toBe(false);
  });

  it("ends the session and lands on the narrow-permissions step after a successful apply", async () => {
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
    expect(flash.path).toBe("/admin/wizard/done");
    expect(flash.type).toBe("ok");
    // The chosen setting plus the off switch of every unticked feature, as
    // when those were saved into the session before the apply.
    expect(flash.msg).toBe(
      `Wizard applied ${1 + Object.keys(lastDerived()).length} settings.`,
    );
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

  it("keeps the session and returns to Review when applyConfiguration threw (#1622)", async () => {
    mockGetSession.mockReturnValue(wizardState(["quotes"], {}));
    mockApplyConfiguration.mockRejectedValue(new Error("mongo down"));
    const res = await harness.post("/wizard/apply");
    const location = res.headers.get("location") ?? "";
    expect(location).toContain("/admin/wizard?");
    expect(location).toContain("step=confirm");
    const flash = parseFlashRedirect(location);
    expect(flash.type).toBe("err");
    expect(flash.msg).toContain("mongo down");
    expect(flash.msg).not.toContain("Wizard failed");
    expect(mockEndSession).not.toHaveBeenCalled();
    expect(lastAudit()).toMatchObject({
      result: "failure",
      errorMessage: "mongo down",
    });
  });
});

/**
 * #1622: Voice Tracking is not ticked (so Apply writes it off) while the
 * weekly recap that needs it stays on. Before the fix Review showed nothing
 * and Apply threw after the session had been ended.
 */
/**
 * Revisiting a step and switching its master off must not leave the earlier
 * staged children behind: the planner would take a stale `true` for the admin's
 * choice and block Apply instead of offering the cascade (#1622).
 */
describe("switching a feature's master off on a revisited step (#1622)", () => {
  type Choices = Record<string, unknown>;
  let state: { selectedFeatures: string[]; configuration: Choices };

  beforeEach(() => {
    mockConfigGetBoolean.mockImplementation(
      async (key) =>
        key === "voicetracking.announcements.enabled" ||
        key === "voicetracking.enabled",
    );
    mockApplyConfiguration.mockResolvedValue({
      success: true,
      appliedKeys: [],
      rolledBackKeys: [],
      revertFailedKeys: [],
    });
    state = {
      selectedFeatures: ["voicetracking", "quotes"],
      configuration: {
        "voicetracking.enabled": true,
        "voicetracking.announcements.enabled": true,
        "voicetracking.stats.top.enabled": true,
        "voicetracking.seen.enabled": true,
        "quotes.enabled": true,
      },
    };
    mockGetSession.mockImplementation(() => state);
    mockAddConfiguration.mockImplementation((...a: unknown[]) => {
      state.configuration[a[2] as string] = a[3];
    });
    mockRemoveConfiguration.mockImplementation((...a: unknown[]) => {
      delete state.configuration[a[2] as string];
    });
  });

  it("clears that feature's staged children and nothing else, so Review offers the cascade", async () => {
    await harness.post("/wizard/step/0", {});
    expect(state.configuration).toEqual({
      "voicetracking.enabled": false,
      "quotes.enabled": true,
    });
    const html = await (await harness.get("/wizard?step=confirm")).text();
    expect(html).toContain('name="cascadeOff"');
    expect(html).not.toContain("These settings can't be applied together");
    expect(html).not.toMatch(/<button[^>]*kb-btn--primary[^>]*disabled/);

    const res = await harness.post("/wizard/apply", {
      cascadeOff: "voicetracking.announcements.enabled",
    });
    expect(res.headers.get("location")).toContain("/admin/wizard/done");
    expect(lastDerived()["voicetracking.announcements.enabled"]).toBe(false);
    expect(lastAudit()).toMatchObject({
      result: "success",
      details: { cascadeOff: ["voicetracking.announcements.enabled"] },
    });
  });

  it("keeps a staged false and clears only the staged true children", async () => {
    state.configuration["voicetracking.stats.top.enabled"] = false;
    state.configuration["voicetracking.seen.enabled"] = false;
    await harness.post("/wizard/step/0", {});
    expect(state.configuration).toEqual({
      "voicetracking.enabled": false,
      "voicetracking.stats.top.enabled": false,
      "voicetracking.seen.enabled": false,
      "quotes.enabled": true,
    });
  });

  it("keeps an explicit command disable (aka.enabled=false) when Name history's master is switched off", async () => {
    state.selectedFeatures = ["namehistory"];
    state.configuration = {
      "namehistory.enabled": true,
      "aka.enabled": false,
    };
    await harness.post("/wizard/step/0", {});
    expect(state.configuration).toEqual({
      "namehistory.enabled": false,
      "aka.enabled": false,
    });
  });

  it("needs no cascade when the cleared child has no live value", async () => {
    mockConfigGetBoolean.mockImplementation(
      async (key) => key === "voicetracking.enabled",
    );
    await harness.post("/wizard/step/0", {});
    expect(state.configuration["voicetracking.announcements.enabled"]).toBe(
      undefined,
    );
    const html = await (await harness.get("/wizard?step=confirm")).text();
    expect(html).not.toContain('name="cascadeOff"');
    expect(html).not.toContain("These settings can't be applied together");
  });

  it("keeps the children staged while the master stays on", async () => {
    await harness.post("/wizard/step/0", {
      "value_voicetracking.enabled": "true",
    });
    expect(mockRemoveConfiguration).not.toHaveBeenCalled();
    expect(state.configuration["voicetracking.enabled"]).toBe(true);
  });
});

describe("a feature turned off while a part that needs it stays on (#1622)", () => {
  const recapOn = (key: string): boolean =>
    key === "voicetracking.announcements.enabled" ||
    key === "voicetracking.enabled";

  beforeEach(() => {
    mockConfigGetBoolean.mockImplementation(async (key) => recapOn(key));
    mockGetSession.mockReturnValue(
      wizardState(["quotes"], { "quotes.enabled": true }),
    );
    mockApplyConfiguration.mockResolvedValue({
      success: true,
      appliedKeys: [],
      rolledBackKeys: [],
      revertFailedKeys: [],
    });
  });

  it("Review names the parts, links each one and offers to turn them off", async () => {
    const html = await (await harness.get("/wizard?step=confirm")).text();
    expect(html).toContain("Some parts need a feature you are turning off");
    expect(html).toContain("Voice Tracking enabled");
    expect(html).toContain(
      '<span class="kb-mono">voicetracking.enabled</span>',
    );
    expect(html).toContain(
      '<a href="/admin/settings#section-voicetracking">Scheduled weekly recap enabled</a>',
    );
    expect(html).not.toContain("`");
    expect(html).toContain(
      'name="cascadeOff" value="voicetracking.announcements.enabled"',
    );
    expect(html).toContain('form="wizard-apply-form"');
    expect(html).not.toMatch(/<button[^>]*kb-btn--primary[^>]*disabled/);
  });

  it("Review shows nothing about it when nothing depends on what is turned off", async () => {
    mockConfigGetBoolean.mockImplementation(async () => false);
    const html = await (await harness.get("/wizard?step=confirm")).text();
    expect(html).not.toContain("need a feature you are turning off");
  });

  it("refuses an unconfirmed apply back to Review, keeping the session and writing nothing", async () => {
    const res = await harness.post("/wizard/apply");
    const location = res.headers.get("location") ?? "";
    expect(location).toContain("step=confirm");
    const flash = parseFlashRedirect(location);
    expect(flash.type).toBe("err");
    expect(flash.msg).toContain("Nothing was applied");
    expect(flash.msg).not.toContain("`");
    expect(mockApplyConfiguration).not.toHaveBeenCalled();
    expect(mockEndSession).not.toHaveBeenCalled();
    expect(lastAudit()).toMatchObject({
      result: "failure",
      details: {
        stage: "dependencies",
        cascadeKeys: ["voicetracking.announcements.enabled"],
        reason: "not-confirmed",
      },
    });
    const cascaded = mockAddConfiguration.mock.calls
      .filter((c) => c[2] === "voicetracking.announcements.enabled")
      .map((c) => c[3]);
    expect(cascaded).toEqual([]);
  });

  it("turns the parts off in the same apply once the admin confirmed them", async () => {
    const res = await harness.post("/wizard/apply", {
      cascadeOff: "voicetracking.announcements.enabled",
    });
    expect(mockApplyConfiguration).toHaveBeenCalledTimes(1);
    expect(lastDerived()["voicetracking.announcements.enabled"]).toBe(false);
    expect(res.headers.get("location")).toContain("/admin/wizard/done");
    expect(lastAudit()).toMatchObject({
      result: "success",
      details: { cascadeOff: ["voicetracking.announcements.enabled"] },
    });
  });

  it("refuses the apply when a dependent cannot be read, writing nothing and keeping the session", async () => {
    // The forgiving read would count the unreadable recap as off and let the
    // apply through; the strict read refuses.
    mockConfigGetBooleanStrict.mockRejectedValue(new Error("mongo down"));
    const res = await harness.post("/wizard/apply", {
      cascadeOff: "voicetracking.announcements.enabled",
    });
    expect(res.headers.get("location")).toContain("step=confirm");
    expect(mockApplyConfiguration).not.toHaveBeenCalled();
    expect(mockEndSession).not.toHaveBeenCalled();
    expect(lastAudit()).toMatchObject({
      result: "failure",
      details: { stage: "dependencies" },
    });
  });

  it("keeps a failed attempt's turn-offs out of the session and plans again on retry", async () => {
    // Attempt 1: confirmed, then the engine throws.
    mockApplyConfiguration.mockRejectedValueOnce(new Error("mongo down"));
    const failed = await harness.post("/wizard/apply", {
      cascadeOff: "voicetracking.announcements.enabled",
    });
    expect(failed.headers.get("location")).toContain("step=confirm");
    expect(mockEndSession).not.toHaveBeenCalled();
    expect(
      mockAddConfiguration.mock.calls.filter((c) => c[3] === false),
    ).toEqual([]);
    expect(lastDerived()["voicetracking.announcements.enabled"]).toBe(false);

    // Back on Review the dependents and the switch are offered again.
    const html = await (await harness.get("/wizard?step=confirm")).text();
    expect(html).toContain('name="cascadeOff"');

    // The admin turned the recap off themselves in the meantime: the retry
    // needs no cascade and must not turn off anything more.
    mockConfigGetBoolean.mockImplementation(
      async (key) => key === "voicetracking.enabled",
    );
    mockApplyConfiguration.mockClear();
    mockRecordAudit.mockClear();
    const retried = await harness.post("/wizard/apply");
    expect(retried.headers.get("location")).toContain("/admin/wizard/done");
    expect(
      lastDerived()["voicetracking.announcements.enabled"],
    ).toBeUndefined();
    expect(lastAudit()).toMatchObject({
      result: "success",
      details: { cascadeOff: [] },
    });
    expect(
      mockAddConfiguration.mock.calls.filter((c) => c[3] === false),
    ).toEqual([]);
  });

  it("refuses a confirmation that no longer matches what is on", async () => {
    await harness.post("/wizard/apply", { cascadeOff: "something.else" });
    expect(mockApplyConfiguration).not.toHaveBeenCalled();
    expect(lastAudit()).toMatchObject({
      details: { reason: "out-of-date" },
    });
  });

  it("follows the chain: turning off Voice Tracking also needs what needs Achievements", async () => {
    mockConfigGetBoolean.mockImplementation(
      async (key) =>
        key === "voicetracking.enabled" ||
        key === "achievements.enabled" ||
        key === "celebrations.enabled",
    );
    const html = await (await harness.get("/wizard?step=confirm")).text();
    expect(html).toContain('<span class="kb-mono">achievements.enabled</span>');
    expect(html).toContain('<span class="kb-mono">celebrations.enabled</span>');
  });

  it("blocks Apply on Review when a chosen enable needs something that stays off", async () => {
    mockGetSession.mockReturnValue(
      wizardState(["achievements"], { "achievements.enabled": true }),
    );
    mockConfigGetBoolean.mockImplementation(async () => false);
    const html = await (await harness.get("/wizard?step=confirm")).text();
    expect(html).toContain("These settings can't be applied together");
    expect(html).toMatch(/<button[^>]*kb-btn--primary[^>]*disabled/);
    const res = await harness.post("/wizard/apply");
    expect(res.headers.get("location")).toContain("step=confirm");
    expect(mockApplyConfiguration).not.toHaveBeenCalled();
    expect(mockEndSession).not.toHaveBeenCalled();
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

// ---------------------------------------------------------------------------
// The Administrator check (#1617)
// ---------------------------------------------------------------------------

const ADMIN = 0x8n;
const SOME_PERMISSION = 0x400n;
const quotesState = (): Record<string, unknown> =>
  wizardState(["quotes"], { "quotes.enabled": true });
const applied = {
  success: true,
  appliedKeys: ["quotes.enabled"],
  rolledBackKeys: [],
  revertFailedKeys: [],
};

describe("the Administrator check on the first page and on Review (#1617)", () => {
  it("says the bot has Administrator, with no warning", async () => {
    botMember = { permissionBits: ADMIN, roleCount: 2 };
    const html = await (await harness.get("/wizard")).text();
    expect(html).toContain('data-wizard-admin="has"');
    expect(html).toContain("The bot has Administrator");
    expect(html).not.toContain("does not have Administrator");
    // No Check again button, so no hidden default button either.
    expect(html).not.toContain('hidden tabindex="-1">Next');
  });

  it("names the fix and offers Check again when Administrator is missing, with the invite link", async () => {
    botMember = { permissionBits: SOME_PERMISSION, roleCount: 2 };
    const html = await (await harness.get("/wizard")).text();
    expect(html).toContain('data-wizard-admin="missing"');
    expect(html).toContain("The bot does not have Administrator");
    expect(html).toContain(
      "https://discord.com/oauth2/authorize?client_id=123456789012345678&amp;permissions=8&amp;scope=bot%20applications.commands",
    );
    expect(html).toContain("Server Settings, then Roles");
    expect(html).toContain('formaction="/admin/wizard/check"');
    expect(html).toContain("Creating roles, channels and categories may fail");
    // Enter in the form must still mean Next: a hidden Next comes before Check again.
    const next = html.indexOf('hidden tabindex="-1">Next</button>');
    expect(next).toBeGreaterThan(-1);
    expect(next).toBeLessThan(html.indexOf('formaction="/admin/wizard/check"'));
  });

  it("says it could not check, and claims neither way, when the bot's membership cannot be read", async () => {
    const html = await (await harness.get("/wizard")).text();
    expect(html).toContain('data-wizard-admin="unknown"');
    expect(html).toContain("Administrator could not be checked");
    expect(html).not.toContain("The bot has Administrator");
    expect(html).not.toContain("The bot does not have Administrator");
  });

  it("does not claim an answer when the bot's roles are not in view", async () => {
    botMember = { permissionBits: 0n, roleCount: 0 };
    const html = await (await harness.get("/wizard")).text();
    expect(html).toContain('data-wizard-admin="unknown"');
  });

  it("reads the bot's membership from Discord on Check again, and uses the cache before", async () => {
    botMember = { permissionBits: ADMIN, roleCount: 2 };
    mockFetchMe.mockResolvedValue(
      memberOf({ permissionBits: 0n, roleCount: 2 }),
    );
    await harness.get("/wizard");
    expect(mockFetchMe).not.toHaveBeenCalled();
    const html = await (await harness.get("/wizard?recheck=1")).text();
    expect(mockFetchMe).toHaveBeenCalledTimes(1);
    // The fresh read wins over the cache.
    expect(html).toContain('data-wizard-admin="missing"');
  });

  it("says unknown, not has or lacks, when the read on Check again fails", async () => {
    botMember = { permissionBits: ADMIN, roleCount: 2 };
    mockFetchMe.mockRejectedValue(new Error("down"));
    const html = await (await harness.get("/wizard?recheck=1")).text();
    expect(html).toContain('data-wizard-admin="unknown"');
    expect(html).toContain("Discord could not be reached.");
  });

  it("shows the same check on Review, with the Apply form joined to the continue switch", async () => {
    botMember = { permissionBits: SOME_PERMISSION, roleCount: 2 };
    mockGetSession.mockReturnValue(quotesState());
    const html = await (await harness.get("/wizard?step=confirm")).text();
    expect(html).toContain('data-wizard-admin="missing"');
    expect(html).toContain('href="/admin/wizard?step=confirm&amp;recheck=1"');
    expect(html).toContain('name="continueWithoutAdmin"');
    expect(html).toContain('form="wizard-apply-form"');
    expect(html).toContain('id="wizard-apply-form"');
    // Apply is never greyed out for this: that would be a hard block.
    expect(html).not.toMatch(/kb-btn--primary"[^>]* disabled[^>]*>Apply/);
  });

  it("shows no continue switch on Review when the bot has Administrator or the check is unknown", async () => {
    mockGetSession.mockReturnValue(quotesState());
    const unknown = await (await harness.get("/wizard?step=confirm")).text();
    expect(unknown).toContain('data-wizard-admin="unknown"');
    expect(unknown).not.toContain("continueWithoutAdmin");
    botMember = { permissionBits: ADMIN, roleCount: 2 };
    const has = await (await harness.get("/wizard?step=confirm")).text();
    expect(has).toContain('data-wizard-admin="has"');
    expect(has).not.toContain("continueWithoutAdmin");
  });

  it("keeps the wizard's choices through Check again on Review (a reload that stores nothing)", async () => {
    botMember = { permissionBits: SOME_PERMISSION, roleCount: 2 };
    mockGetSession.mockReturnValue(quotesState());
    mockFetchMe.mockResolvedValue(
      memberOf({ permissionBits: ADMIN, roleCount: 2 }),
    );
    const html = await (
      await harness.get("/wizard?step=confirm&recheck=1")
    ).text();
    expect(html).toContain("quotes.enabled");
    expect(html).toContain('data-wizard-admin="has"');
    expect(mockEndSession).not.toHaveBeenCalled();
    expect(mockCreateSession).not.toHaveBeenCalled();
    expect(mockAddConfiguration).not.toHaveBeenCalled();
    expect(mockRemoveConfiguration).not.toHaveBeenCalled();
  });
});

describe("POST /wizard/check keeps the ticked features (#1617)", () => {
  it("redirects back with the recognised features and saves nothing", async () => {
    const res = await harness.post("/wizard/check", {
      features: ["quotes", "polls", "not-a-feature"],
    });
    expect(res.headers.get("location")).toBe(
      "/admin/wizard?recheck=1&ticked=quotes%2Cpolls",
    );
    expect(mockCreateSession).not.toHaveBeenCalled();
    expect(mockRecordAudit).not.toHaveBeenCalled();
  });

  it("works with nothing ticked", async () => {
    const res = await harness.post("/wizard/check", {});
    expect(res.headers.get("location")).toBe("/admin/wizard?recheck=1");
  });

  it("ticks the features again on the first page and ignores unknown names", async () => {
    const html = await (
      await harness.get("/wizard?recheck=1&ticked=quotes,polls,<b>x</b>")
    ).text();
    expect(html).toMatch(/value="quotes" id="feat-quotes" checked/);
    expect(html).toMatch(/value="polls" id="feat-polls" checked/);
    expect(html).not.toMatch(/value="lfg" id="feat-lfg" checked/);
    expect(html).not.toContain("<b>x</b>");
  });
});

describe("POST /wizard/apply and Administrator (#1617)", () => {
  it("refuses back to Review, with the session and choices kept, when Administrator is missing and not confirmed", async () => {
    botMember = { permissionBits: SOME_PERMISSION, roleCount: 2 };
    mockFetchMe.mockResolvedValue(memberOf(botMember));
    mockGetSession.mockReturnValue(quotesState());
    const res = await harness.post("/wizard/apply");
    const location = res.headers.get("location") ?? "";
    expect(location).toContain("step=confirm");
    const flash = parseFlashRedirect(location);
    expect(flash.type).toBe("err");
    expect(flash.msg).toContain("Nothing was applied");
    expect(flash.msg).toContain("Continue without Administrator");
    expect(flash.msg).not.toMatch(/[`*]/);
    expect(mockApplyConfiguration).not.toHaveBeenCalled();
    expect(mockEndSession).not.toHaveBeenCalled();
    expect(lastAudit()).toMatchObject({
      action: "wizard.apply",
      details: { stage: "administrator" },
      result: "failure",
    });
  });

  it("applies when Administrator is missing and the admin chose Continue without Administrator", async () => {
    botMember = { permissionBits: SOME_PERMISSION, roleCount: 2 };
    mockFetchMe.mockResolvedValue(memberOf(botMember));
    mockGetSession.mockReturnValue(quotesState());
    mockApplyConfiguration.mockResolvedValue(applied);
    const res = await harness.post("/wizard/apply", {
      continueWithoutAdmin: "1",
    });
    expect(parseFlashRedirect(res.headers.get("location")).path).toBe(
      "/admin/wizard/done",
    );
    expect(mockApplyConfiguration).toHaveBeenCalledTimes(1);
  });

  it("does not take a switch posted without 1 as the choice", async () => {
    botMember = { permissionBits: SOME_PERMISSION, roleCount: 2 };
    mockFetchMe.mockResolvedValue(memberOf(botMember));
    mockGetSession.mockReturnValue(quotesState());
    await harness.post("/wizard/apply", { continueWithoutAdmin: "0" });
    expect(mockApplyConfiguration).not.toHaveBeenCalled();
  });

  it("reads the bot again at Apply: an admin who fixed it in Discord is not stopped", async () => {
    botMember = { permissionBits: SOME_PERMISSION, roleCount: 2 };
    mockFetchMe.mockResolvedValue(
      memberOf({ permissionBits: ADMIN, roleCount: 2 }),
    );
    mockGetSession.mockReturnValue(quotesState());
    mockApplyConfiguration.mockResolvedValue(applied);
    await harness.post("/wizard/apply");
    expect(mockApplyConfiguration).toHaveBeenCalledTimes(1);
  });

  it("applies when the bot has Administrator and a stray continue switch is posted", async () => {
    botMember = { permissionBits: ADMIN, roleCount: 2 };
    mockFetchMe.mockResolvedValue(memberOf(botMember));
    mockGetSession.mockReturnValue(quotesState());
    mockApplyConfiguration.mockResolvedValue(applied);
    await harness.post("/wizard/apply", { continueWithoutAdmin: "1" });
    expect(mockApplyConfiguration).toHaveBeenCalledTimes(1);
  });

  it("does not block Apply when the check cannot be made (lookup failing)", async () => {
    botMember = { permissionBits: ADMIN, roleCount: 2 };
    mockFetchMe.mockRejectedValue(new Error("down"));
    mockGetSession.mockReturnValue(quotesState());
    mockApplyConfiguration.mockResolvedValue(applied);
    await harness.post("/wizard/apply");
    expect(mockApplyConfiguration).toHaveBeenCalledTimes(1);
  });
});

describe("GET /wizard/done: the optional narrowing step (#1617)", () => {
  it("renders, says it only reads, and links to Bot permissions", async () => {
    botMember = { permissionBits: ADMIN, roleCount: 2 };
    const res = await harness.get("/wizard/done");
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).toContain("Narrow the bot's permissions");
    expect(html).toContain('href="/admin/bot-permissions"');
    expect(html).toContain("The bot still has Administrator");
    // The check cannot run against the test client, and the page says so.
    expect(html).toContain("could not be checked");
    // A read-only page: no form posts anything.
    expect(html).not.toContain('method="POST" action="/admin/wizard');
  });

  it("no longer links an Event host role job: the role is created by Apply itself (#1618)", async () => {
    for (const job of ["abc-123_DEF", "%22%3E%3Cscript%3E"]) {
      const html = await (await harness.get(`/wizard/done?job=${job}`)).text();
      expect(html).not.toContain("/admin/role-groups?job=");
      expect(html).not.toContain("<script>x");
    }
  });

  it("says there is nothing to swap when the bot does not have Administrator", async () => {
    botMember = { permissionBits: SOME_PERMISSION, roleCount: 2 };
    const html = await (await harness.get("/wizard/done")).text();
    expect(html).toContain("There is nothing to swap");
  });
});
