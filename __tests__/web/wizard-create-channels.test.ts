/**
 * The wizard's feature steps create the channels their settings point at
 * (#1662), driven over HTTP with the real wizard routes, WizardService, schema,
 * coercion, planner and channel helper. The Discord reads and writes, the
 * permission check, the config store and the audit log are mocked.
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
  TEST_CSRF_TOKEN,
  startAdminHarness,
  stubRequireSession,
  createTestSession,
  parseFlashRedirect,
  type AdminHarness,
} from "./admin-harness.js";
import type { ManagedChannelView } from "../../src/web/channel-manager.js";

const mockRecordAudit = jest.fn<(...a: any[]) => Promise<void>>(
  async () => undefined,
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
  isDebugMode: () => false,
}));

const mockConfigSet = jest.fn<(...a: any[]) => Promise<void>>();
const mockConfigDelete = jest.fn<(...a: any[]) => Promise<void>>(
  async () => undefined,
);
const mockConfigGetAll = jest.fn<() => Promise<unknown[]>>(async () => []);
const mockConfigGet = jest.fn<(key: string) => Promise<unknown>>(
  async () => null,
);
jest.unstable_mockModule("../../src/services/config-service.js", () => ({
  ConfigService: {
    getInstance: (): unknown => ({
      get: mockConfigGet,
      getBooleanStrict: async (_k: string, d: boolean) => d,
      getStringStrict: async (_k: string, d = "") => d,
      set: mockConfigSet,
      delete: mockConfigDelete,
      findDependencyIssues: async () => [],
      getAll: mockConfigGetAll,
      getString: async () => "",
      getNumber: async () => 0,
      getBoolean: async () => false,
      triggerReload: async () => undefined,
      registerReloadCallback: jest.fn(),
    }),
  },
}));
jest.unstable_mockModule("../../src/services/command-manager.js", () => ({
  CommandManager: {
    getInstance: (): unknown => ({
      makeDiscordApiCall: async (fn: () => Promise<unknown>) => fn(),
    }),
  },
}));
type Can = { ok: true } | { ok: false; reason: string } | { ok: "unknown" };
let can: Can = { ok: true };
const mockCanBotCreate = jest.fn<(...a: any[]) => Promise<Can>>(
  async () => can,
);
// `toPickerCreate` is the pure mapping of the answer to the Picker's flag.
jest.unstable_mockModule("../../src/services/bot-create-check.js", () => ({
  canBotCreate: mockCanBotCreate,
  toPickerCreate: (kind: string, answer: Can, channelKind?: string): unknown =>
    answer.ok === "unknown"
      ? undefined
      : {
          kind,
          ...(kind === "channel" && channelKind ? { channelKind } : {}),
          ok: answer.ok,
          ...(answer.ok === false ? { reason: answer.reason } : {}),
        },
}));

let live: ManagedChannelView[] = [];
const mockFetchViews = jest.fn<(...a: any[]) => Promise<ManagedChannelView[]>>(
  async () => live,
);
jest.unstable_mockModule("../../src/web/channel-manager-data.js", () => ({
  fetchChannelViews: mockFetchViews,
  maxBitrateOf: () => 96000,
  botCanManageChannels: async () => true,
}));

const mockPost = jest.fn<(...a: any[]) => Promise<any>>();
const mockDelete = jest.fn<(...a: any[]) => Promise<any>>(async () => ({}));
jest.unstable_mockModule("../../src/web/channel-write-rest.js", () => ({
  createWriteRest: () => ({ post: mockPost, delete: mockDelete }),
  rateLimitWaitMs: () => 0,
  rateLimitMessage: () => "rate limited",
  createFailFastRest: () => ({ post: mockPost, delete: mockDelete }),
  RATE_LIMIT_FAST_FAIL_MS: 20000,
  WRITE_TIMEOUT_MS: 30000,
  cancellableCall: async (
    _m: unknown,
    fn: (s: AbortSignal) => Promise<unknown>,
  ) => fn(new AbortController().signal),
  describeWriteFailure: (e: unknown) =>
    e instanceof Error ? `Discord refused: ${e.message}` : "Discord refused.",
}));

const { withChannelLock } = await import("../../src/web/channel-write-lock.js");
const { applyWizardCreations, reviewWizardCreations } =
  await import("../../src/web/wizard-create.js");
const { createWizardRouter } =
  await import("../../src/web/routes/write/wizard.js");
const { WizardService } = await import("../../src/services/wizard-service.js");
const { requireCsrf } = await import("../../src/web/csrf.js");
const { requireAdminRoleMiddleware } = await import("../../src/web/session.js");
const { settingsMetadata } =
  await import("../../src/services/config-schema.js");
const { WIZARD_FEATURE_SETTINGS } =
  await import("../../src/web/routes/write/helpers.js");
const { offersCreateChannel } = await import("../../src/web/setting-create.js");

const view = (
  id: string,
  over: Partial<ManagedChannelView>,
): ManagedChannelView => ({
  id,
  name: id,
  kind: "text",
  typeLabel: "text",
  parentId: null,
  position: 0,
  topic: null,
  userLimit: null,
  bitrate: null,
  ...over,
});

const client = {
  token: "bot-token",
  user: { id: "bot" },
  guilds: { fetch: async () => ({ id: "guild-1", name: "G" }) },
} as unknown as Client;
const session = createTestSession();
let harness: AdminHarness;
let nextId = 100000000000000100n;

const QUOTES = "quotes.channel_id";
const NOTICES = "notices.channel_id";
const RULES_CH = "welcome.rules_channel_id";

function wizard(): InstanceType<typeof WizardService> {
  return WizardService.getInstance();
}
function state(): any {
  return wizard().getSession(session.discordUserId, session.guildId);
}
function start(features: string[]): void {
  wizard().createSession(session.discordUserId, session.guildId, features);
}

beforeEach(async () => {
  jest.clearAllMocks();
  can = { ok: true };
  mockFetchViews.mockReset();
  mockFetchViews.mockImplementation(async () => live);
  live = [view("100000000000000001", { name: "general" })];
  nextId = 100000000000000100n;
  mockConfigSet.mockResolvedValue(undefined);
  mockConfigGet.mockResolvedValue(null);
  mockConfigGetAll.mockResolvedValue([]);
  mockDelete.mockResolvedValue({});
  mockPost.mockImplementation(async (_route: string, o: any) => ({
    id: String(nextId++),
    name: o.body.name,
  }));
  wizard().endSession(session.discordUserId, session.guildId);
  harness = await startAdminHarness([
    stubRequireSession(session),
    requireAdminRoleMiddleware(),
    requireCsrf,
    createWizardRouter(client),
  ]);
});
afterEach(async () => {
  await harness.close();
  wizard().endSession(session.discordUserId, session.guildId);
});

const quotesStep = (channel: string): Record<string, string> => ({
  "value_quotes.enabled": "true",
  [`value_${QUOTES}`]: channel,
  "value_quotes.max_length": "800",
  "value_quotes.cooldown": "30",
  "value_quotes.header_enabled": "true",
});
const noticesStep = (channel: string): Record<string, string> => ({
  "value_notices.enabled": "true",
  [`value_${NOTICES}`]: channel,
  "value_notices.header_enabled": "true",
});
const lastAudit = (): Record<string, any> =>
  mockRecordAudit.mock.calls[mockRecordAudit.mock.calls.length - 1][1];
const setWrites = (): Array<[string, unknown]> =>
  mockConfigSet.mock.calls.map((c) => [c[0] as string, c[1]]);

/** Stage creations for the given step bodies, then open Review and return its HTML. */
async function stageAndReview(
  steps: Array<[number, Record<string, string>]>,
): Promise<string> {
  for (const [i, body] of steps) {
    const res = await harness.post(`/wizard/step/${i}`, body);
    expect(parseFlashRedirect(res.headers.get("location") ?? "").type).not.toBe(
      "warn",
    );
  }
  const res = await harness.get("/wizard?step=confirm");
  expect(res.status).toBe(200);
  return res.text();
}
const planIdOf = (html: string): string =>
  /name="channelPlanId" value="([0-9a-f]+)"/.exec(html)?.[1] ?? "";
const apply = (planId: string | undefined): Promise<Response> =>
  harness.post(
    "/wizard/apply",
    planId === undefined ? {} : { channelPlanId: planId },
  );

describe("which keys offer the create row in the wizard (#1662)", () => {
  it("is exactly the ten post channels of the #1619 audit, read from the schema flag", () => {
    const inWizard = new Set(Object.values(WIZARD_FEATURE_SETTINGS).flat());
    const offered = Object.keys(settingsMetadata)
      .filter((k) => offersCreateChannel(k) && inWizard.has(k))
      .sort();
    expect(offered).toEqual(
      [
        "voicetracking.announcements.channel_id",
        "quotes.channel_id",
        "reactionroles.message_channel_id",
        "notices.channel_id",
        "lfg.channel_id",
        "events.announcement_channel_id",
        "birthdays.channel_id",
        "welcome.channel_id",
        "rules.channel_id",
        "leaderboard_roles.announcement_channel_id",
      ].sort(),
    );
  });
});

describe("the step page (#1662)", () => {
  it("offers the create row on a flagged channel setting", async () => {
    start(["quotes"]);
    const html = await (await harness.get("/wizard?step=0")).text();
    expect(html).toContain('data-picker-meta="{');
    expect(html).toContain(
      "&quot;create&quot;:{&quot;kind&quot;:&quot;channel&quot;",
    );
    expect(html).toContain("&quot;ok&quot;:true");
    expect(mockCanBotCreate).toHaveBeenCalledTimes(1);
  });

  it("shows the help line, not the row, when the bot cannot create", async () => {
    can = { ok: false, reason: "The bot needs Manage Channels." };
    start(["quotes"]);
    const html = await (await harness.get("/wizard?step=0")).text();
    expect(html).toContain("&quot;ok&quot;:false");
    expect(html).toContain("The bot needs Manage Channels.");
  });

  it("shows nothing when the permissions cannot be read", async () => {
    can = { ok: "unknown" };
    start(["quotes"]);
    const html = await (await harness.get("/wizard?step=0")).text();
    expect(html).not.toContain("&quot;create&quot;");
  });

  it("is not offered on a step with no flagged key, and asks no permission question", async () => {
    start(["polls"]);
    const html = await (await harness.get("/wizard?step=0")).text();
    expect(html).not.toContain("&quot;create&quot;");
    expect(mockCanBotCreate).not.toHaveBeenCalled();
  });

  it("is not offered for an unflagged channel key on the same page (the rules channel mention)", async () => {
    start(["welcome"]);
    const html = await (await harness.get("/wizard?step=0")).text();
    const rulesPicker = html.slice(
      html.indexOf(`name="value_${RULES_CH}"`) - 400,
      html.indexOf(`name="value_${RULES_CH}"`),
    );
    expect(rulesPicker).not.toContain("&quot;create&quot;");
    const welcomePicker = html.slice(
      html.indexOf(`name="value_welcome.channel_id"`) - 400,
      html.indexOf(`name="value_welcome.channel_id"`),
    );
    expect(welcomePicker).toContain("&quot;create&quot;");
  });

  it("draws a planned creation again as a pending option when the step is revisited", async () => {
    start(["quotes"]);
    await harness.post("/wizard/step/0", quotesStep("create:Quote Wall"));
    const html = await (await harness.get("/wizard?step=0")).text();
    expect(html).toContain(
      '<option value="create:Quote Wall" data-create data-name="Quote Wall" selected>Quote Wall (will be created)</option>',
    );
  });
});

describe("planning a creation on a step (#1662)", () => {
  it("records the name with the step's other answers and creates nothing", async () => {
    start(["quotes"]);
    const res = await harness.post(
      "/wizard/step/0",
      quotesStep("create:Quote Wall"),
    );
    expect(res.headers.get("location")).toBe("/admin/wizard?step=confirm");
    expect(state().creations).toEqual({
      [QUOTES]: { name: "Quote Wall", kind: "text" },
    });
    // The create value is never staged as a setting.
    expect(state().configuration[QUOTES]).toBeUndefined();
    expect(state().configuration["quotes.max_length"]).toBe(800);
    expect(mockPost).not.toHaveBeenCalled();
    expect(lastAudit()).toMatchObject({
      action: "wizard.step",
      result: "success",
    });
  });

  it("refuses a blank or over-long name and stays on the step", async () => {
    start(["quotes"]);
    for (const bad of ["create:   ", `create:${"x".repeat(101)}`]) {
      const res = await harness.post("/wizard/step/0", quotesStep(bad));
      const flash = parseFlashRedirect(res.headers.get("location") ?? "");
      expect(flash.type).toBe("warn");
      expect(flash.msg).toContain(QUOTES);
    }
    expect(state().creations).toBeUndefined();
    expect(state().configuration[QUOTES]).toBeUndefined();
  });

  it("refuses a create value for a key that is not flagged and stores nothing", async () => {
    start(["welcome"]);
    const res = await harness.post("/wizard/step/0", {
      "value_welcome.enabled": "true",
      [`value_${RULES_CH}`]: "create:rules",
    });
    const flash = parseFlashRedirect(res.headers.get("location") ?? "");
    expect(flash.type).toBe("warn");
    expect(flash.msg).toContain(RULES_CH);
    expect(state().configuration[RULES_CH]).toBeUndefined();
    expect(state().creations).toBeUndefined();
  });

  it("refuses a create value inside a comma-joined or repeated field", async () => {
    start(["quotes"]);
    const res = await harness.post("/wizard/step/0", {
      ...quotesStep("123456789012345678,create:wall"),
    });
    expect(parseFlashRedirect(res.headers.get("location") ?? "").type).toBe(
      "warn",
    );
    expect(state().configuration[QUOTES]).toBeUndefined();
    expect(state().creations).toBeUndefined();
  });

  it("refuses to plan when the bot cannot create, and when that cannot be checked", async () => {
    start(["quotes"]);
    can = { ok: false, reason: "The bot needs Manage Channels." };
    let res = await harness.post("/wizard/step/0", quotesStep("create:wall"));
    let flash = parseFlashRedirect(res.headers.get("location") ?? "");
    expect(flash.type).toBe("warn");
    expect(flash.msg).toContain("The bot needs Manage Channels.");
    can = { ok: "unknown" };
    res = await harness.post("/wizard/step/0", quotesStep("create:wall"));
    flash = parseFlashRedirect(res.headers.get("location") ?? "");
    expect(flash.msg).toContain("could not check");
    expect(state().creations).toBeUndefined();
    expect(mockPost).not.toHaveBeenCalled();
  });

  it("clears a planned creation when a real channel is chosen later", async () => {
    start(["quotes"]);
    await harness.post("/wizard/step/0", quotesStep("create:wall"));
    await harness.post("/wizard/step/0", quotesStep("123456789012345678"));
    expect(state().creations).toEqual({});
    expect(state().configuration[QUOTES]).toBe("123456789012345678");
  });

  it("clears a planned creation when the feature is switched off", async () => {
    start(["quotes"]);
    await harness.post("/wizard/step/0", quotesStep("create:wall"));
    await harness.post("/wizard/step/0", { "value_quotes.enabled": "false" });
    expect(state().creations).toEqual({});
  });

  it("clears a planned creation when the picker's none row is chosen", async () => {
    start(["quotes"]);
    await harness.post("/wizard/step/0", quotesStep("create:wall"));
    await harness.post("/wizard/step/0", quotesStep(""));
    expect(state().creations).toEqual({});
    expect(state().configuration[QUOTES]).toBe("");
  });
});

describe("Review of planned creations (#1662)", () => {
  it("lists each creation, the setting that gets it, and a plan id; Apply stays enabled", async () => {
    start(["quotes"]);
    const html = await stageAndReview([[0, quotesStep("create:Quote Wall")]]);
    expect(html).toContain("Channels and categories to create");
    expect(html).toContain("Create the text channel");
    expect(html).toContain("quote-wall");
    expect(html).toContain("Quote channel");
    expect(planIdOf(html)).toMatch(/^[0-9a-f]{16}$/);
    // The settings table shows the setting with what it will point at.
    expect(html).toContain("(will be created)");
    expect(html).not.toMatch(
      /<button type="submit" class="btn btn-primary" disabled>Apply/,
    );
    expect(mockPost).not.toHaveBeenCalled();
  });

  it("lists ONE channel when two settings type the same new name", async () => {
    start(["quotes", "notices"]);
    const html = await stageAndReview([
      [0, quotesStep("create:Community")],
      [1, noticesStep("create:  community ")],
    ]);
    expect((html.match(/Create the text channel/g) ?? []).length).toBe(1);
    expect(html).toContain("Quote channel");
    expect(html).toContain("Notices channel");
  });

  it("does not list a channel that already exists; the setting is shown as selecting it", async () => {
    live = [view("100000000000000050", { name: "quotes" })];
    start(["quotes"]);
    const html = await stageAndReview([[0, quotesStep("create:Quotes")]]);
    expect(html).not.toContain("Channels and categories to create");
    expect(html).toContain("(existing channel)");
    expect(planIdOf(html)).not.toBe("");
  });

  it("blocks Apply when two text channels already have the name", async () => {
    live = [
      view("100000000000000050", { name: "quotes" }),
      view("100000000000000051", {
        name: "Quotes",
        parentId: "100000000000000002",
      }),
      view("100000000000000002", {
        name: "Community",
        kind: "category",
        typeLabel: "category",
      }),
    ];
    start(["quotes"]);
    const html = await stageAndReview([[0, quotesStep("create:quotes")]]);
    expect(html).toContain(
      "More than one text channel on this server has that name.",
    );
    expect(html).toMatch(
      /<button type="submit" class="btn btn-primary" disabled>Apply/,
    );
  });

  it("blocks Apply, with the reason, when the bot cannot create", async () => {
    start(["quotes"]);
    await harness.post("/wizard/step/0", quotesStep("create:wall"));
    can = { ok: false, reason: "The bot needs Manage Channels." };
    const html = await (await harness.get("/wizard?step=confirm")).text();
    expect(html).toContain("The bot needs Manage Channels.");
    expect(html).toMatch(
      /<button type="submit" class="btn btn-primary" disabled>Apply/,
    );
  });

  it("a Review with no creation has no create panel and no plan id", async () => {
    start(["quotes"]);
    const html = await stageAndReview([[0, quotesStep("123456789012345678")]]);
    expect(html).not.toContain("wizard-create-review");
    expect(html).not.toContain("channelPlanId");
    expect(mockCanBotCreate).not.toHaveBeenCalled();
  });
});

describe("applying planned creations (#1662)", () => {
  it("creates the channel through the helper, stores its id and ends the session", async () => {
    start(["quotes"]);
    const planId = planIdOf(
      await stageAndReview([[0, quotesStep("create:Quote Wall")]]),
    );
    const res = await apply(planId);
    expect(res.headers.get("location")).toContain("/admin/wizard/done");
    expect(mockPost).toHaveBeenCalledTimes(1);
    expect(mockPost.mock.calls[0][1].body).toEqual({
      name: "quote-wall",
      type: 0,
    });
    expect(setWrites()).toEqual(
      expect.arrayContaining([[QUOTES, "100000000000000100"]]),
    );
    expect(lastAudit()).toMatchObject({
      action: "wizard.apply",
      result: "success",
      details: {
        channels: [
          {
            key: QUOTES,
            id: "100000000000000100",
            name: "quote-wall",
            created: true,
          },
        ],
      },
    });
    expect(state()).toBeNull();
  });

  it("creates ONE channel for two settings that typed the same name and points both at it", async () => {
    start(["quotes", "notices"]);
    const planId = planIdOf(
      await stageAndReview([
        [0, quotesStep("create:Community")],
        [1, noticesStep("create:community")],
      ]),
    );
    await apply(planId);
    expect(mockPost).toHaveBeenCalledTimes(1);
    expect(setWrites()).toEqual(
      expect.arrayContaining([
        [QUOTES, "100000000000000100"],
        [NOTICES, "100000000000000100"],
      ]),
    );
  });

  it("selects an existing channel of that name, in any category, without creating", async () => {
    live = [
      view("100000000000000050", {
        name: "quotes",
        parentId: "100000000000000002",
      }),
      view("100000000000000002", {
        name: "Community",
        kind: "category",
        typeLabel: "category",
      }),
    ];
    start(["quotes"]);
    const planId = planIdOf(
      await stageAndReview([[0, quotesStep("create:quotes")]]),
    );
    await apply(planId);
    expect(mockPost).not.toHaveBeenCalled();
    expect(setWrites()).toEqual(
      expect.arrayContaining([[QUOTES, "100000000000000050"]]),
    );
  });

  it("refuses, creates nothing and stores nothing when the name appeared since Review", async () => {
    start(["quotes"]);
    const planId = planIdOf(
      await stageAndReview([[0, quotesStep("create:wall")]]),
    );
    live = [...live, view("100000000000000077", { name: "wall" })];
    const res = await apply(planId);
    const flash = parseFlashRedirect(res.headers.get("location") ?? "");
    expect(flash.path).toBe("/admin/wizard");
    expect(flash.type).toBe("err");
    expect(flash.msg).toContain("changed since");
    expect(mockPost).not.toHaveBeenCalled();
    expect(mockConfigSet).not.toHaveBeenCalled();
    // The session and the plan are kept so the admin can review again.
    expect(state().creations).toEqual({
      [QUOTES]: { name: "wall", kind: "text" },
    });
  });

  it("refuses a missing or wrong plan id", async () => {
    start(["quotes"]);
    await stageAndReview([[0, quotesStep("create:wall")]]);
    for (const posted of [undefined, "0000000000000000"]) {
      const res = await apply(posted);
      expect(
        parseFlashRedirect(res.headers.get("location") ?? "").msg,
      ).toContain("changed since");
    }
    expect(mockPost).not.toHaveBeenCalled();
    expect(mockConfigSet).not.toHaveBeenCalled();
  });

  it("refuses when the bot lost the permission after Review", async () => {
    start(["quotes"]);
    const planId = planIdOf(
      await stageAndReview([[0, quotesStep("create:wall")]]),
    );
    can = { ok: false, reason: "The bot needs Manage Channels." };
    const res = await apply(planId);
    expect(parseFlashRedirect(res.headers.get("location") ?? "").msg).toContain(
      "The bot needs Manage Channels.",
    );
    expect(mockPost).not.toHaveBeenCalled();
    expect(mockConfigSet).not.toHaveBeenCalled();
  });

  it("a failed create removes the channels made earlier and stores nothing", async () => {
    start(["quotes", "notices"]);
    const planId = planIdOf(
      await stageAndReview([
        [0, quotesStep("create:first")],
        [1, noticesStep("create:second")],
      ]),
    );
    let calls = 0;
    mockPost.mockImplementation(async (_r: string, o: any) => {
      calls += 1;
      if (calls === 2) throw new Error("Missing Permissions");
      return { id: "100000000000000200", name: o.body.name };
    });
    const res = await apply(planId);
    const flash = parseFlashRedirect(res.headers.get("location") ?? "");
    expect(flash.type).toBe("err");
    expect(flash.msg).toContain("The settings were not applied");
    expect(flash.msg).not.toContain("Nothing was applied");
    expect(flash.msg).toContain("Missing Permissions");
    expect(mockDelete).toHaveBeenCalledTimes(1);
    expect(mockConfigSet).not.toHaveBeenCalled();
    expect(lastAudit()).toMatchObject({
      action: "wizard.apply",
      result: "failure",
    });
    expect(state()).not.toBeNull();
  });

  it("removes the created channel again when writing the settings fails", async () => {
    start(["quotes"]);
    const planId = planIdOf(
      await stageAndReview([[0, quotesStep("create:wall")]]),
    );
    mockConfigSet.mockRejectedValue(new Error("mongo down"));
    const res = await apply(planId);
    const flash = parseFlashRedirect(res.headers.get("location") ?? "");
    expect(flash.type).toBe("err");
    expect(mockPost).toHaveBeenCalledTimes(1);
    expect(mockDelete).toHaveBeenCalledTimes(1);
    expect(String(mockDelete.mock.calls[0][0])).toContain("100000000000000100");
    expect(flash.msg).toContain("removed again");
    // The plan is kept for a retry.
    expect(state().creations).toEqual({
      [QUOTES]: { name: "wall", kind: "text" },
    });
  });

  it("removes the created channel again when the settings engine throws before writing", async () => {
    start(["quotes"]);
    const planId = planIdOf(
      await stageAndReview([[0, quotesStep("create:wall")]]),
    );
    mockConfigGetAll.mockRejectedValueOnce(new Error("snapshot failed"));
    const res = await apply(planId);
    const flash = parseFlashRedirect(res.headers.get("location") ?? "");
    expect(flash.type).toBe("err");
    expect(flash.msg).toContain("removed again");
    expect(mockDelete).toHaveBeenCalledTimes(1);
    expect(mockConfigSet).not.toHaveBeenCalled();
    mockConfigGetAll.mockResolvedValue([]);
  });

  it("names a channel it could not remove, and does not call it removed", async () => {
    start(["quotes"]);
    const planId = planIdOf(
      await stageAndReview([[0, quotesStep("create:wall")]]),
    );
    mockConfigSet.mockRejectedValue(new Error("mongo down"));
    mockDelete.mockRejectedValue(new Error("Discord is down"));
    const res = await apply(planId);
    const flash = parseFlashRedirect(res.headers.get("location") ?? "");
    expect(flash.msg).toContain("100000000000000100");
    expect(flash.msg).toContain("still exist");
    expect(flash.msg).not.toMatch(/(was|were) removed again/);
    expect(flash.msg).not.toContain("You can retry");
  });

  it("a step without a creation never touches Discord when applied", async () => {
    start(["quotes"]);
    await stageAndReview([[0, quotesStep("123456789012345678")]]);
    const res = await apply(undefined);
    expect(res.headers.get("location")).toContain("/admin/wizard/done");
    expect(mockPost).not.toHaveBeenCalled();
    expect(mockDelete).not.toHaveBeenCalled();
    expect(mockCanBotCreate).not.toHaveBeenCalled();
    expect(setWrites()).toEqual(
      expect.arrayContaining([[QUOTES, "123456789012345678"]]),
    );
  });

  it("keeps, and reports, a created channel that a saved setting now points at, and removes the rest (per channel)", async () => {
    start(["quotes", "notices"]);
    const planId = planIdOf(
      await stageAndReview([
        [0, quotesStep("create:first")],
        [1, noticesStep("create:second")],
      ]),
    );
    mockConfigSet.mockRejectedValue(new Error("mongo down"));
    // Another save adopted the first channel (id ...100) while this apply waited.
    mockConfigGetAll.mockResolvedValue([
      { key: "welcome.channel_id", value: "100000000000000100" },
    ]);
    const res = await apply(planId);
    const flash = parseFlashRedirect(res.headers.get("location") ?? "");
    expect(mockPost).toHaveBeenCalledTimes(2);
    expect(mockDelete).toHaveBeenCalledTimes(1);
    expect(String(mockDelete.mock.calls[0][0])).toContain("100000000000000101");
    expect(flash.msg).toContain(
      "Kept, because a saved setting points at it: 100000000000000100",
    );
    expect(flash.msg).toMatch(/was removed again/);
    // Not "no changes", not "you can retry", while a created channel stays.
    expect(flash.msg).not.toContain("You can retry");
  });

  it("removes a channel whose setting was never saved even when another setting could not be rolled back", async () => {
    start(["quotes", "notices"]);
    const planId = planIdOf(
      await stageAndReview([
        [0, quotesStep("create:first")],
        [1, noticesStep("create:second")],
      ]),
    );
    mockConfigSet.mockRejectedValue(new Error("mongo down"));
    // Only the second channel is still stored; the first was reverted.
    mockConfigGetAll.mockResolvedValue([
      { key: NOTICES, value: "100000000000000101" },
    ]);
    await apply(planId);
    expect(mockDelete).toHaveBeenCalledTimes(1);
    expect(String(mockDelete.mock.calls[0][0])).toContain("100000000000000100");
  });

  it("also finds a channel inside a comma list of a stored setting", async () => {
    start(["quotes"]);
    const planId = planIdOf(
      await stageAndReview([[0, quotesStep("create:wall")]]),
    );
    mockConfigSet.mockRejectedValue(new Error("mongo down"));
    mockConfigGetAll.mockResolvedValue([
      { key: "voicetracking.excluded_channels", value: "1,100000000000000100" },
    ]);
    await apply(planId);
    expect(mockDelete).not.toHaveBeenCalled();
  });

  it("deletes nothing and says so when the stored settings cannot be read for the cleanup", async () => {
    start(["quotes"]);
    const planId = planIdOf(
      await stageAndReview([[0, quotesStep("create:wall")]]),
    );
    mockConfigSet.mockRejectedValue(new Error("mongo down"));
    // The engine's own snapshot read (first call) works; the cleanup's fails.
    mockConfigGetAll
      .mockResolvedValueOnce([])
      .mockRejectedValue(new Error("mongo down"));
    const res = await apply(planId);
    const flash = parseFlashRedirect(res.headers.get("location") ?? "");
    expect(mockDelete).not.toHaveBeenCalled();
    expect(flash.msg).toContain("100000000000000100");
    expect(flash.msg).toContain("may still exist");
  });

  it("says the settings were not applied, and keeps the helper's account of the channels, when a create fails and one cannot be removed", async () => {
    start(["quotes", "notices"]);
    const planId = planIdOf(
      await stageAndReview([
        [0, quotesStep("create:first")],
        [1, noticesStep("create:second")],
      ]),
    );
    let calls = 0;
    mockPost.mockImplementation(async (_r: string, o: any) => {
      calls += 1;
      if (calls === 2) throw new Error("Missing Permissions");
      return { id: "100000000000000200", name: o.body.name };
    });
    mockDelete.mockRejectedValue(new Error("Discord is down"));
    const res = await apply(planId);
    const flash = parseFlashRedirect(res.headers.get("location") ?? "");
    expect(flash.msg).toContain("The settings were not applied");
    expect(flash.msg).toContain("100000000000000200");
    expect(flash.msg).toContain("still exist");
    expect(flash.msg).not.toContain("Nothing was applied");
    expect(flash.msg).not.toContain("nothing was changed");
  });

  it("does nothing when the browser leaves while the apply waits for the channel lock", async () => {
    start(["quotes"]);
    const planId = planIdOf(
      await stageAndReview([[0, quotesStep("create:wall")]]),
    );
    // Another channel write holds the server's lock.
    let release: () => void = () => undefined;
    const holding = withChannelLock(
      session.guildId,
      () => new Promise<void>((resolve) => (release = resolve)),
    );
    const gone = new AbortController();
    const params = new globalThis.URLSearchParams({
      _csrf: TEST_CSRF_TOKEN,
      channelPlanId: planId,
    });
    const sent = fetch(`${harness.baseUrl}/admin/wizard/apply`, {
      method: "POST",
      redirect: "manual",
      signal: gone.signal,
      headers: {
        "content-type": "application/x-www-form-urlencoded",
        cookie: `koolbot_csrf=${encodeURIComponent(TEST_CSRF_TOKEN)}`,
      },
      body: params.toString(),
    }).catch(() => null);
    // Let the request reach the lock wait, then close it.
    await new Promise((r) => setTimeout(r, 400));
    gone.abort();
    await sent;
    await new Promise((r) => setTimeout(r, 100));
    release();
    await holding;
    await new Promise((r) => setTimeout(r, 200));
    expect(mockPost).not.toHaveBeenCalled();
    expect(mockConfigSet).not.toHaveBeenCalled();
    expect(state().creations).toEqual({
      [QUOTES]: { name: "wall", kind: "text" },
    });
  });

  it("a settings read that never answers is cut off, the channel is reported as possibly there, and the lock is free", async () => {
    const creations = { [QUOTES]: { name: "wall", kind: "text" as const } };
    const review = await reviewWizardCreations(
      client,
      session.guildId,
      creations,
    );
    const made = await applyWizardCreations(
      client,
      session.guildId,
      session.discordUserId,
      creations,
      review.planId as string,
    );
    expect(made.ok).toBe(true);
    if (!made.ok) return;
    mockConfigGetAll.mockImplementation(() => new Promise(() => undefined));
    jest.useFakeTimers();
    try {
      const pending = made.cleanup();
      await jest.advanceTimersByTimeAsync(20_001);
      const result = await pending;
      expect(result.stuck).toEqual(["100000000000000100"]);
      expect(result.removed).toEqual([]);
      expect(mockDelete).not.toHaveBeenCalled();
      // Nothing holds the server's lock any more.
      const next = await withChannelLock(session.guildId, async () => "free");
      expect(next).toEqual({ ok: true, value: "free" });
    } finally {
      jest.useRealTimers();
      mockConfigGetAll.mockResolvedValue([]);
    }
  });
});
