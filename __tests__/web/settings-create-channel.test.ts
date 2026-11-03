/**
 * Saving a Settings section that holds a pending channel creation (#1663),
 * driven over HTTP with the real routes, schema, coercion, planner and helper.
 * The Discord reads and writes, the permission check, the config store and the
 * audit log are mocked.
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
import type { ManagedChannelView } from "../../src/web/channel-manager.js";

const mockRecordAudit = jest.fn<(...a: any[]) => Promise<void>>(
  async () => undefined,
);
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
  isDebugMode: () => false,
}));

const mockConfigGet = jest.fn<(key: string) => Promise<unknown>>();
const mockConfigSet = jest.fn<(...a: any[]) => Promise<void>>();
jest.unstable_mockModule("../../src/services/config-service.js", () => ({
  ConfigService: {
    getInstance: (): unknown => ({
      get: mockConfigGet,
      getBooleanStrict: async (_k: string, d: boolean) => d,
      getStringStrict: async (_k: string, d = "") => d,
      set: mockConfigSet,
      findDependencyIssues: async () => [],
      getAll: async () => [],
      getString: async () => "",
      getNumber: async () => 0,
      getBoolean: async () => false,
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
jest.unstable_mockModule("../../src/services/role-group-service.js", () => ({
  RoleGroupService: {
    getInstance: (): unknown => ({ groupBackedRoles: async () => [] }),
  },
}));
// Scheduled services the save may re-arm.
for (const [file, name] of [
  ["birthday-service", "BirthdayService"],
  ["event-service", "EventService"],
  ["lfg-service", "LfgService"],
] as const) {
  jest.unstable_mockModule(`../../src/services/${file}.js`, () => ({
    [name]: { getInstance: (): unknown => ({ reload: async () => undefined }) },
  }));
}

type Can = { ok: true } | { ok: false; reason: string } | { ok: "unknown" };
let can: Can = { ok: true };
const mockCanBotCreate = jest.fn<(...a: any[]) => Promise<Can>>(
  async () => can,
);
jest.unstable_mockModule("../../src/services/bot-create-check.js", () => ({
  canBotCreate: mockCanBotCreate,
  toPickerCreate: jest.fn(),
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
  cancellableCall: async (
    _m: unknown,
    fn: (s: AbortSignal) => Promise<unknown>,
  ) => fn(new AbortController().signal),
  describeWriteFailure: (e: unknown) =>
    e instanceof Error ? `Discord refused: ${e.message}` : "Discord refused.",
}));

const { createSettingsRouter } =
  await import("../../src/web/routes/write/settings.js");
const { requireCsrf } = await import("../../src/web/csrf.js");
const { requireAdminRoleMiddleware } = await import("../../src/web/session.js");
const { settingsMetadata } =
  await import("../../src/services/config-schema.js");

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

beforeEach(async () => {
  jest.clearAllMocks();
  can = { ok: true };
  mockFetchViews.mockReset();
  mockFetchViews.mockImplementation(async () => live);
  live = [view("100000000000000001", { name: "general" })];
  nextId = 100000000000000100n;
  mockConfigGet.mockResolvedValue(null);
  mockConfigSet.mockResolvedValue(undefined);
  mockDelete.mockResolvedValue({});
  mockPost.mockImplementation(async (_route: string, o: any) => ({
    id: String(nextId++),
    name: o.body.name,
  }));
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

const QUOTES = "quotes.channel_id";
const WELCOME = "welcome.channel_id";
const lastAudit = (): Record<string, any> =>
  mockRecordAudit.mock.calls[mockRecordAudit.mock.calls.length - 1][1];
const save = (
  body: Record<string, string | string[]>,
  json = true,
): Promise<Response> => harness.post("/settings/save-section", body, { json });
const setWrites = (): Array<[string, unknown]> =>
  mockConfigSet.mock.calls.map((c) => [c[0] as string, c[1]]);

describe("a pending creation saved from a section (#1663)", () => {
  it("creates the channel, stores its id, reloads and audits", async () => {
    const res = await save({
      category: "quotes",
      keys: [QUOTES],
      [`value_${QUOTES}`]: "create:Quote Wall",
    });
    const body = (await res.json()) as Record<string, any>;
    expect(body.type).toBe("ok");
    expect(body.text).toBe(
      "Saved 1 setting in quotes. Created # quote-wall for Quote channel.",
    );
    expect(body.reload).toContain("flash=ok");
    expect(mockPost).toHaveBeenCalledTimes(1);
    const sent = mockPost.mock.calls[0][1].body;
    expect(sent).toEqual({ name: "quote-wall", type: 0 });
    expect(setWrites()).toEqual([[QUOTES, "100000000000000100"]]);
    expect(lastAudit()).toMatchObject({
      action: "settings.save-section",
      result: "success",
      details: {
        applied: [{ key: QUOTES, after: "100000000000000100" }],
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
  });

  it("saves two creating settings in one request, one flash, one apply", async () => {
    const res = await save({
      category: "x",
      keys: [QUOTES, WELCOME, "quotes.max_length"],
      [`value_${QUOTES}`]: "create:quotes",
      [`value_${WELCOME}`]: "create:hello",
      "value_quotes.max_length": "500",
    });
    const body = (await res.json()) as Record<string, any>;
    expect(body.text).toBe(
      "Saved 3 settings in x. Created # quotes for Quote channel; created # hello for Welcome channel.",
    );
    expect(mockPost).toHaveBeenCalledTimes(2);
    expect(setWrites()).toEqual(
      expect.arrayContaining([
        ["quotes.max_length", 500],
        [QUOTES, "100000000000000100"],
        [WELCOME, "100000000000000101"],
      ]),
    );
  });

  it("stores an existing id unchanged next to a creation", async () => {
    const res = await save({
      category: "x",
      keys: [QUOTES, WELCOME],
      [`value_${QUOTES}`]: "123456789012345678",
      [`value_${WELCOME}`]: "create:hello",
    });
    expect(((await res.json()) as any).type).toBe("ok");
    expect(setWrites()).toEqual(
      expect.arrayContaining([
        [QUOTES, "123456789012345678"],
        [WELCOME, "100000000000000100"],
      ]),
    );
  });

  it("selects an existing channel of that name and says so", async () => {
    const res = await save({
      category: "quotes",
      keys: [QUOTES],
      [`value_${QUOTES}`]: "create:General",
    });
    const body = (await res.json()) as Record<string, any>;
    expect(body.text).toContain(
      "Used the existing # general for Quote channel.",
    );
    expect(mockPost).not.toHaveBeenCalled();
    expect(setWrites()).toEqual([[QUOTES, "100000000000000001"]]);
  });

  it("refuses the apply when the name appeared after the plan (no select)", async () => {
    // The plan sees no such channel; the re-read inside the apply does.
    mockFetchViews
      .mockResolvedValueOnce([view("1", { name: "general" })])
      .mockResolvedValue([
        view("1", { name: "general" }),
        view("2", { name: "quote-wall" }),
      ]);
    const res = await save({
      category: "quotes",
      keys: [QUOTES],
      [`value_${QUOTES}`]: "create:quote-wall",
    });
    const body = (await res.json()) as Record<string, any>;
    expect(body.type).toBe("err");
    expect(body.invalidKeys).toEqual([QUOTES]);
    expect(body.invalidReasons[QUOTES]).toContain("changed since Review");
    expect(mockPost).not.toHaveBeenCalled();
    expect(mockConfigSet).not.toHaveBeenCalled();
    expect(body.reload).toBeUndefined();
  });
});

describe("a name that exists inside a category (#1663)", () => {
  const CAT = "100000000000000050";
  it("selects it with its own parent instead of creating a duplicate at the top", async () => {
    live = [
      view(CAT, { name: "Community", kind: "category" }),
      view("100000000000000060", { name: "quote-wall", parentId: CAT }),
    ];
    const res = await save({
      category: "quotes",
      keys: [QUOTES],
      [`value_${QUOTES}`]: "create:Quote Wall",
    });
    const body = (await res.json()) as Record<string, any>;
    expect(body.text).toContain(
      "Used the existing # quote-wall for Quote channel.",
    );
    expect(mockPost).not.toHaveBeenCalled();
    expect(setWrites()).toEqual([[QUOTES, "100000000000000060"]]);
  });

  it("refuses when two channels in different categories match", async () => {
    live = [
      view(CAT, { name: "A", kind: "category" }),
      view("100000000000000051", { name: "B", kind: "category" }),
      view("100000000000000060", { name: "quote-wall", parentId: CAT }),
      view("100000000000000061", {
        name: "quote-wall",
        parentId: "100000000000000051",
      }),
    ];
    const res = await save({
      category: "quotes",
      keys: [QUOTES],
      [`value_${QUOTES}`]: "create:Quote Wall",
    });
    const body = (await res.json()) as Record<string, any>;
    expect(body.type).toBe("err");
    expect(body.invalidReasons[QUOTES]).toContain("Pick the one you want");
    expect(mockPost).not.toHaveBeenCalled();
    expect(mockConfigSet).not.toHaveBeenCalled();
  });

  it("refuses, creating nothing, when a match appears in a category after the first read", async () => {
    live = [view(CAT, { name: "Community", kind: "category" })];
    const later = [
      ...live,
      view("100000000000000060", { name: "quote-wall", parentId: CAT }),
    ];
    mockFetchViews
      .mockResolvedValueOnce(live) // the read before the lock
      .mockResolvedValue(later); // the read inside the lock
    const res = await save({
      category: "quotes",
      keys: [QUOTES],
      [`value_${QUOTES}`]: "create:Quote Wall",
    });
    const body = (await res.json()) as Record<string, any>;
    expect(body.type).toBe("err");
    expect(body.invalidReasons[QUOTES]).toContain("changed since Review");
    expect(mockPost).not.toHaveBeenCalled();
    expect(mockConfigSet).not.toHaveBeenCalled();
  });

  it("refuses when a second match appears in another category after the first read", async () => {
    const A = view(CAT, { name: "A", kind: "category" });
    const first = [
      A,
      view("100000000000000060", { name: "quote-wall", parentId: CAT }),
    ];
    const later = [
      ...first,
      view("100000000000000051", { name: "B", kind: "category" }),
      view("100000000000000061", {
        name: "Quote Wall",
        parentId: "100000000000000051",
      }),
    ];
    mockFetchViews.mockResolvedValueOnce(first).mockResolvedValue(later);
    const res = await save({
      category: "quotes",
      keys: [QUOTES],
      [`value_${QUOTES}`]: "create:Quote Wall",
    });
    const body = (await res.json()) as Record<string, any>;
    expect(body.type).toBe("err");
    expect(body.invalidReasons[QUOTES]).toContain("changed since Review");
    expect(mockConfigSet).not.toHaveBeenCalled();
  });

  it("goes ahead when nothing moved between the two reads", async () => {
    live = [view(CAT, { name: "Community", kind: "category" })];
    const res = await save({
      category: "quotes",
      keys: [QUOTES],
      [`value_${QUOTES}`]: "create:Quote Wall",
    });
    expect(((await res.json()) as any).type).toBe("ok");
    expect(mockPost).toHaveBeenCalledTimes(1);
  });

  it("still creates a name that exists only as another kind", async () => {
    live = [view("100000000000000070", { name: "quote-wall", kind: "voice" })];
    await save({
      category: "quotes",
      keys: [QUOTES],
      [`value_${QUOTES}`]: "create:quote-wall",
    });
    expect(mockPost).toHaveBeenCalledTimes(1);
  });
});

describe("a failed creation stores nothing (#1663)", () => {
  it("names the error under the setting and writes no setting", async () => {
    mockPost.mockRejectedValueOnce(new Error("Missing Permissions"));
    const res = await save({
      category: "quotes",
      keys: [QUOTES, "quotes.max_length"],
      [`value_${QUOTES}`]: "create:wall",
      "value_quotes.max_length": "500",
    });
    const body = (await res.json()) as Record<string, any>;
    expect(body.type).toBe("err");
    expect(body.text).toContain("No changes saved");
    expect(body.invalidKeys).toEqual([QUOTES]);
    expect(body.invalidReasons[QUOTES]).toContain("Missing Permissions");
    expect(body.reload).toBeUndefined();
    expect(mockConfigSet).not.toHaveBeenCalled();
    expect(lastAudit()).toMatchObject({ result: "failure" });
  });

  it("removes the first channel when the second create fails, and stores nothing", async () => {
    mockPost
      .mockResolvedValueOnce({ id: "100000000000000200", name: "a" })
      .mockRejectedValueOnce(new Error("boom"));
    const res = await save({
      category: "x",
      keys: [QUOTES, WELCOME],
      [`value_${QUOTES}`]: "create:a",
      [`value_${WELCOME}`]: "create:b",
    });
    const body = (await res.json()) as Record<string, any>;
    expect(body.type).toBe("err");
    expect(body.invalidKeys.sort()).toEqual([QUOTES, WELCOME].sort());
    expect(mockDelete).toHaveBeenCalledTimes(1);
    expect(mockConfigSet).not.toHaveBeenCalled();
  });

  it("refuses two settings that type the same new name", async () => {
    const res = await save({
      category: "x",
      keys: [QUOTES, WELCOME],
      [`value_${QUOTES}`]: "create:same",
      [`value_${WELCOME}`]: "create:Same",
    });
    const body = (await res.json()) as Record<string, any>;
    expect(body.type).toBe("err");
    expect(body.invalidReasons[QUOTES]).toContain("more than once");
    expect(mockPost).not.toHaveBeenCalled();
    expect(mockConfigSet).not.toHaveBeenCalled();
  });

  it("refuses a blank or over-long name without creating", async () => {
    const res = await save({
      category: "quotes",
      keys: [QUOTES],
      [`value_${QUOTES}`]: "create:   ",
    });
    const body = (await res.json()) as Record<string, any>;
    expect(body.invalidReasons[QUOTES]).toBe("The name cannot be blank.");
    const long = await save({
      category: "quotes",
      keys: [QUOTES],
      [`value_${QUOTES}`]: `create:${"x".repeat(101)}`,
    });
    expect(((await long.json()) as any).invalidReasons[QUOTES]).toContain(
      "at most 100",
    );
    expect(mockPost).not.toHaveBeenCalled();
  });

  it("creates nothing when another value of the section is refused", async () => {
    const res = await save({
      category: "quotes",
      keys: [QUOTES, "quotes.max_length"],
      [`value_${QUOTES}`]: "create:wall",
      "value_quotes.max_length": "not a number",
    });
    const body = (await res.json()) as Record<string, any>;
    expect(body.type).toBe("err");
    expect(body.invalidKeys).toEqual(["quotes.max_length"]);
    expect(mockPost).not.toHaveBeenCalled();
    expect(mockConfigSet).not.toHaveBeenCalled();
  });

  it("creates nothing when the section's master is off (dependents are skipped)", async () => {
    const res = await save({
      category: "quotes",
      keys: ["quotes.enabled", QUOTES],
      [`value_${QUOTES}`]: "create:wall",
    });
    expect(((await res.json()) as any).type).toBe("ok");
    expect(mockPost).not.toHaveBeenCalled();
    expect(setWrites()).toEqual([["quotes.enabled", false]]);
  });
});

describe("no permission, and the server never trusts the page (#1663)", () => {
  it("refuses with the permission help line when the bot cannot create", async () => {
    can = { ok: false, reason: "The bot needs Manage Channels." };
    const res = await save({
      category: "quotes",
      keys: [QUOTES],
      [`value_${QUOTES}`]: "create:wall",
    });
    const body = (await res.json()) as Record<string, any>;
    expect(body.type).toBe("err");
    expect(body.invalidReasons[QUOTES]).toBe("The bot needs Manage Channels.");
    expect(mockPost).not.toHaveBeenCalled();
    expect(mockConfigSet).not.toHaveBeenCalled();
  });

  it("refuses when the permission cannot be read", async () => {
    can = { ok: "unknown" };
    const res = await save({
      category: "quotes",
      keys: [QUOTES],
      [`value_${QUOTES}`]: "create:wall",
    });
    expect(((await res.json()) as any).type).toBe("err");
    expect(mockPost).not.toHaveBeenCalled();
  });

  it("refuses a create value for a key without the flag", async () => {
    const res = await save({
      category: "x",
      keys: ["welcome.rules_channel_id"],
      "value_welcome.rules_channel_id": "create:wall",
    });
    const body = (await res.json()) as Record<string, any>;
    expect(body.type).toBe("err");
    expect(body.invalidKeys).toEqual(["welcome.rules_channel_id"]);
    expect(mockPost).not.toHaveBeenCalled();
    expect(mockConfigSet).not.toHaveBeenCalled();
  });

  it("refuses a create value on /settings/set", async () => {
    const res = await harness.post("/settings/set", {
      key: QUOTES,
      value: "create:wall",
    });
    expect(parseFlashRedirect(res.headers.get("location")).type).toBe("err");
    expect(mockPost).not.toHaveBeenCalled();
    expect(mockConfigSet).not.toHaveBeenCalled();
  });

  it("refuses a create value for a log channel, which has no flag", async () => {
    const res = await save({
      category: "core",
      keys: ["core.errors.channel_id"],
      "value_core.errors.channel_id": "create:errors",
    });
    expect(((await res.json()) as any).type).toBe("err");
    expect(mockPost).not.toHaveBeenCalled();
  });
});

describe("the schema flag (#1663)", () => {
  const flagged = Object.entries(settingsMetadata)
    .filter(([, m]) => (m as { createChannel?: boolean }).createChannel)
    .map(([k]) => k)
    .sort();

  it("is set on exactly the text channel settings of the audit", () => {
    expect(flagged).toEqual(
      [
        "voicetracking.announcements.channel_id",
        "quotes.channel_id",
        "celebrations.channel_id",
        "birthdays.channel_id",
        "welcome.channel_id",
        "rules.channel_id",
        "events.announcement_channel_id",
        "lfg.channel_id",
        "reactionroles.message_channel_id",
        "notices.channel_id",
        "leaderboard_roles.announcement_channel_id",
      ].sort(),
    );
  });

  it("is only on text channel settings", () => {
    for (const k of flagged) {
      const m = settingsMetadata[k as keyof typeof settingsMetadata];
      expect(m.type).toBe("channel");
      expect(m.channelKind).not.toBe("voice");
    }
  });

  it("is never on a log channel: a created channel has no overwrites", () => {
    for (const k of [
      "core.startup.channel_id",
      "core.errors.channel_id",
      "core.cleanup.channel_id",
      "core.config.channel_id",
      "core.cron.channel_id",
      "core.moderation.channel_id",
      "core.moderation_review.channel_id",
      "core.updates.channel_id",
      "core.role_groups.channel_id",
      "moderation.raid.alert_channel_id",
    ]) {
      expect(flagged).not.toContain(k);
    }
  });
});

describe("a create value is never stored as a setting value (defect on main)", () => {
  it("coerceConfigValue, the one check the wizard, Settings and the import share, refuses it for every picker type", async () => {
    const { coerceConfigValue, coerceConfigValueForGuild } =
      await import("../../src/web/routes/write/helpers.js");
    const refused = {
      ok: false,
      reason: "this setting cannot create a new one from here",
    };
    // channel, category, role, channel_list (scalar and array), role_list
    for (const [key, raw] of [
      ["quotes.channel_id", "create:x"],
      ["voicechannels.category_id", "create:x"],
      ["birthdays.role_id", "create:x"],
      ["voicetracking.excluded_channels", "create:x"],
      ["voicetracking.excluded_channels", ["123456789012345678", "create:x"]],
      ["quotes.delete_roles", ["create:x"]],
      // list settings are comma-separated text: every entry is checked
      ["voicetracking.excluded_channels", "123456789012345678,create:wall"],
      ["voicetracking.excluded_channels", "123456789012345678 , create:wall"],
      ["voicetracking.excluded_channels", "create:wall,123456789012345678"],
      ["voicetracking.excluded_channels", ["123456789012345678,create:wall"]],
      ["quotes.delete_roles", ["1", " create:x,2"]],
      ["quotes.channel_id", "123456789012345678,create:wall"],
    ] as const) {
      expect(coerceConfigValue(key, raw)).toEqual(refused);
      // The wizard's apply path calls the guild-aware wrapper.
      expect(await coerceConfigValueForGuild(key, raw, "", "g")).toEqual(
        refused,
      );
    }
  });

  it("still stores an id, and free text on a key that is not a picker", async () => {
    const { coerceConfigValue } =
      await import("../../src/web/routes/write/helpers.js");
    expect(
      coerceConfigValue("quotes.channel_id", "123456789012345678"),
    ).toEqual({ ok: true, value: "123456789012345678" });
  });
});
