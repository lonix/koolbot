/**
 * Route tests for the optional Groups section of the event create form
 * (#1188). Only `EventService` is mocked; the real form parser and validator
 * run, so what reaches `createEvent` is what would be stored.
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
const mockCreateEvent = jest.fn<(input: unknown) => Promise<unknown>>();
const mockConfigGetString = jest.fn<() => Promise<string>>();
const mockConfigGetNumber =
  jest.fn<(key: string, fallback: number) => Promise<number>>();

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
      getString: mockConfigGetString,
      getNumber: mockConfigGetNumber,
      getBoolean: jest.fn(async () => true),
      registerReloadCallback: jest.fn(),
    }),
  },
}));

const actualEventService = await import("../../src/services/event-service.js");
jest.unstable_mockModule("../../src/services/event-service.js", () => ({
  ...actualEventService,
  EventService: {
    getInstance: (): unknown => ({
      createEvent: mockCreateEvent,
    }),
  },
}));

// The preset library is read through `loadPresetResolver`; the real resolver
// and validator run, only the Mongo read is replaced (#1200).
const mockLoadPresetResolver =
  jest.fn<
    (guildId: string) => Promise<{ resolve: unknown; catalog: unknown }>
  >();
const actualPresetService =
  await import("../../src/services/event-group-preset-service.js");
jest.unstable_mockModule(
  "../../src/services/event-group-preset-service.js",
  () => ({
    ...actualPresetService,
    loadPresetResolver: mockLoadPresetResolver,
  }),
);
const { EVENT_GROUP_PRESETS } =
  await import("../../src/content/event-group-presets.js");

type Catalog =
  import("../../src/services/event-group-preset-service.js").PresetCatalog;

function useCatalog(catalog: Catalog): void {
  mockLoadPresetResolver.mockResolvedValue({
    catalog,
    resolve: actualPresetService.presetResolver(catalog),
  });
}

function builtinEntries(off: string[] = []): Catalog["entries"] {
  return EVENT_GROUP_PRESETS.map((p) => ({
    ...p,
    source: "builtin" as const,
    enabled: !off.includes(p.id),
  }));
}

const LIB_ID = "lib:0123456789abcdef01234567";

const { createEventsRouter } =
  await import("../../src/web/routes/write/events.js");
const { requireCsrf } = await import("../../src/web/csrf.js");
const { requireAdminRoleMiddleware } = await import("../../src/web/session.js");

const client = { user: { id: "bot" } } as unknown as Client;
const session = createTestSession();

function futureDateTime(): { date: string; time: string } {
  const when = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000);
  return { date: when.toISOString().slice(0, 10), time: "18:30" };
}

let harness: AdminHarness;

beforeEach(async () => {
  jest.clearAllMocks();
  mockConfigGetString.mockResolvedValue("UTC");
  mockConfigGetNumber.mockImplementation(async (key, fallback) => {
    if (key === "events.groups.max_count") return 4;
    if (key === "events.groups.default_count") return 2;
    return fallback;
  });
  mockCreateEvent.mockResolvedValue({ _id: "event-1" });
  useCatalog({ entries: builtinEntries(), state: "ok" });
  harness = await startAdminHarness([
    stubRequireSession(session),
    requireAdminRoleMiddleware(),
    requireCsrf,
    createEventsRouter(client),
  ]);
});

afterEach(async () => {
  await harness.close();
});

async function create(
  body: Record<string, string>,
): Promise<ReturnType<typeof parseFlashRedirect>> {
  const { date, time } = futureDateTime();
  const res = await harness.post("/events/create", {
    title: "Clan match",
    date,
    time,
    ...body,
  });
  expect(res.status).toBe(303);
  return parseFlashRedirect(res.headers.get("location"));
}

type CreateInput = {
  groups?: {
    groupsEnabled: boolean;
    presetId: string | null;
    groupLabel: string;
    channelLeadMinutes: number | null;
    tagsEnabled?: boolean;
    tagsSuffix?: boolean;
    groups: Array<{ name: string; size: number | null; kind: string }>;
  };
};

describe("POST /events/create with groups (#1188)", () => {
  it("passes no group setup for a plain event, as before", async () => {
    const flash = await create({});
    expect(flash.type).toBe("ok");
    const arg = mockCreateEvent.mock.calls[0][0] as CreateInput;
    expect(arg).not.toHaveProperty("groups");
    expect(mockConfigGetNumber).not.toHaveBeenCalledWith(
      "events.groups.max_count",
      expect.anything(),
    );
  });

  it("ignores group rows when 'use groups' is not ticked", async () => {
    const flash = await create({
      group_0_name: "x".repeat(500),
      groups_lead_minutes: "banana",
    });
    expect(flash.type).toBe("ok");
    expect(mockCreateEvent.mock.calls[0][0]).not.toHaveProperty("groups");
  });

  it("stores a clan-match setup with sizes and a per-event lead time", async () => {
    const flash = await create({
      groups_enabled: "1",
      groups_label: "Squad",
      groups_lead_minutes: "30",
      group_0_name: "Assault Squad",
      group_0_kind: "team",
      group_0_size: "8",
      group_1_name: "Logi",
      group_1_kind: "team",
      group_1_size: "4",
      group_2_name: "Command",
      group_2_kind: "leads",
    });
    expect(flash.type).toBe("ok");
    const arg = mockCreateEvent.mock.calls[0][0] as CreateInput;
    expect(arg.groups).toMatchObject({
      groupsEnabled: true,
      presetId: null,
      groupLabel: "Squad",
      channelLeadMinutes: 30,
    });
    expect(arg.groups?.groups.map((g) => [g.name, g.kind, g.size])).toEqual([
      ["Assault Squad", "team", 8],
      ["Logi", "team", 4],
      ["Command", "leads", null],
    ]);
    expect(mockRecordAudit.mock.calls[0][1]).toMatchObject({
      action: "event.create",
      result: "success",
      details: { groups: 3, channelLeadMinutes: 30 },
    });
  });

  it("uses a preset's groups when no rows were filled in", async () => {
    const flash = await create({
      groups_enabled: "1",
      groups_preset: "builtin:wardogs",
    });
    expect(flash.type).toBe("ok");
    const arg = mockCreateEvent.mock.calls[0][0] as CreateInput;
    expect(arg.groups?.presetId).toBe("builtin:wardogs");
    expect(arg.groups?.groups.map((g) => g.name)).toEqual([
      "Manticore",
      "Valkyra",
      "Lonestar",
    ]);
  });

  it("refuses a bad size with a message naming the group and field, creating nothing", async () => {
    const flash = await create({
      groups_enabled: "1",
      group_0_name: "Alpha",
      group_1_name: "Bravo",
      group_1_size: "100",
    });
    expect(flash.type).toBe("err");
    expect(flash.msg).toContain("Group 2 size");
    expect(mockCreateEvent).not.toHaveBeenCalled();
  });

  it("refuses duplicate names and a second leads group", async () => {
    const dup = await create({
      groups_enabled: "1",
      group_0_name: "Alpha",
      group_1_name: "alpha",
    });
    expect(dup.msg).toContain("already used");
    const leads = await create({
      groups_enabled: "1",
      group_0_name: "A",
      group_0_kind: "leads",
      group_1_name: "B",
      group_1_kind: "leads",
    });
    expect(leads.msg).toContain("only one leads group");
    expect(mockCreateEvent).not.toHaveBeenCalled();
  });

  it("refuses more groups than events.groups.max_count", async () => {
    const body: Record<string, string> = { groups_enabled: "1" };
    for (let i = 0; i < 5; i++) body[`group_${i}_name`] = `G${i}`;
    const flash = await create(body);
    expect(flash.type).toBe("err");
    expect(flash.msg).toContain("at most 4 groups");
    expect(mockCreateEvent).not.toHaveBeenCalled();
  });

  it("stores the leaders switch only when its box was ticked, and audits it (#1195)", async () => {
    await create({ groups_enabled: "1", group_0_name: "A" });
    expect(
      (mockCreateEvent.mock.calls[0][0] as CreateInput).groups?.captainsEnabled,
    ).toBe(false);
    mockCreateEvent.mockClear();
    const flash = await create({
      groups_enabled: "1",
      groups_captains: "1",
      group_0_name: "A",
    });
    expect(flash.type).toBe("ok");
    expect(
      (mockCreateEvent.mock.calls[0][0] as CreateInput).groups?.captainsEnabled,
    ).toBe(true);
  });

  it("stores the clan tags switch and the suffix only when their boxes were ticked (#1194)", async () => {
    await create({ groups_enabled: "1", group_0_name: "A" });
    const plain = mockCreateEvent.mock.calls[0][0] as CreateInput;
    expect([plain.groups?.tagsEnabled, plain.groups?.tagsSuffix]).toEqual([
      false,
      false,
    ]);
    mockCreateEvent.mockClear();
    await create({
      groups_enabled: "1",
      groups_tags: "1",
      group_0_name: "A",
    });
    const on = mockCreateEvent.mock.calls[0][0] as CreateInput;
    expect([on.groups?.tagsEnabled, on.groups?.tagsSuffix]).toEqual([
      true,
      false,
    ]);
    mockCreateEvent.mockClear();
    await create({
      groups_enabled: "1",
      groups_tags: "1",
      groups_tags_suffix: "1",
      group_0_name: "A",
    });
    const suffix = mockCreateEvent.mock.calls[0][0] as CreateInput;
    expect([suffix.groups?.tagsEnabled, suffix.groups?.tagsSuffix]).toEqual([
      true,
      true,
    ]);
  });

  it("refuses an out-of-range channel creation time", async () => {
    const flash = await create({
      groups_enabled: "1",
      groups_lead_minutes: "5000",
      group_0_name: "A",
    });
    expect(flash.msg).toContain("Channel creation time");
    expect(mockCreateEvent).not.toHaveBeenCalled();
  });

  it("refuses when groups are on but nothing was set up", async () => {
    const flash = await create({ groups_enabled: "1" });
    expect(flash.type).toBe("err");
    expect(flash.msg).toContain("at least one group");
  });
});

describe("POST /events/create with the preset library (#1200)", () => {
  const libraryPreset = {
    id: LIB_ID,
    source: "library" as const,
    enabled: true,
    label: "Clan match",
    description: "",
    groupLabel: "Squad",
    leaderLabel: "Lead",
    channelLeadMinutes: 30,
    groups: [
      { name: "Assault", kind: "team" as const, size: 8, tag: "", marker: "" },
      { name: "Logi", kind: "team" as const, size: 4, tag: "", marker: "" },
    ],
  };

  it("accepts an enabled library preset and stores its id with the groups copied", async () => {
    useCatalog({
      entries: [...builtinEntries(), libraryPreset],
      state: "ok",
    });
    const flash = await create({
      groups_enabled: "1",
      groups_preset: LIB_ID,
    });
    expect(flash.type).toBe("ok");
    const arg = mockCreateEvent.mock.calls[0][0] as CreateInput;
    expect(arg.groups?.presetId).toBe(LIB_ID);
    expect(arg.groups?.groupLabel).toBe("Squad");
    expect(arg.groups?.groups.map((g) => [g.name, g.size])).toEqual([
      ["Assault", 8],
      ["Logi", 4],
    ]);
  });

  it("refuses a switched-off built-in preset clearly, creating nothing", async () => {
    useCatalog({
      entries: builtinEntries(["builtin:wardogs"]),
      state: "ok",
    });
    const flash = await create({
      groups_enabled: "1",
      groups_preset: "builtin:wardogs",
    });
    expect(flash.type).toBe("err");
    expect(flash.msg).toContain("switched off");
    expect(mockCreateEvent).not.toHaveBeenCalled();
  });

  it("refuses a switched-off library preset even when rows were typed", async () => {
    useCatalog({
      entries: [...builtinEntries(), { ...libraryPreset, enabled: false }],
      state: "ok",
    });
    const flash = await create({
      groups_enabled: "1",
      groups_preset: LIB_ID,
      group_0_name: "Alpha",
    });
    expect(flash.type).toBe("err");
    expect(flash.msg).toContain("switched off");
    expect(mockCreateEvent).not.toHaveBeenCalled();
  });

  it("refuses the id of a deleted preset", async () => {
    const flash = await create({
      groups_enabled: "1",
      groups_preset: "lib:ffffffffffffffffffffffff",
    });
    expect(flash.type).toBe("err");
    expect(flash.msg).toContain("does not exist or was deleted");
    expect(mockCreateEvent).not.toHaveBeenCalled();
  });

  it("refuses a library preset bigger than events.groups.max_count", async () => {
    useCatalog({
      entries: [
        ...builtinEntries(),
        {
          ...libraryPreset,
          groups: Array.from({ length: 5 }, (_, i) => ({
            name: `G${i}`,
            kind: "team" as const,
            size: null,
            tag: "",
            marker: "",
          })),
        },
      ],
      state: "ok",
    });
    const flash = await create({ groups_enabled: "1", groups_preset: LIB_ID });
    expect(flash.type).toBe("err");
    expect(flash.msg).toContain("limit is 4");
    expect(mockCreateEvent).not.toHaveBeenCalled();
  });

  it("fails closed when the library cannot be read: a named preset is refused, Custom still works without a read", async () => {
    useCatalog({ entries: [], state: "all-unreadable" });
    const refused = await create({
      groups_enabled: "1",
      groups_preset: "builtin:wardogs",
    });
    expect(refused.type).toBe("err");
    expect(refused.msg).toContain("could not be read");
    expect(mockCreateEvent).not.toHaveBeenCalled();

    mockLoadPresetResolver.mockClear();
    const custom = await create({
      groups_enabled: "1",
      group_0_name: "Alpha",
      group_1_name: "Bravo",
    });
    expect(custom.type).toBe("ok");
    expect(mockLoadPresetResolver).not.toHaveBeenCalled();
  });

  it("offers only the built-ins when just the library part is unreadable", async () => {
    useCatalog({ entries: builtinEntries(), state: "library-unreadable" });
    const ok = await create({
      groups_enabled: "1",
      groups_preset: "builtin:red-vs-blue",
    });
    expect(ok.type).toBe("ok");
    const refused = await create({
      groups_enabled: "1",
      groups_preset: LIB_ID,
    });
    expect(refused.type).toBe("err");
  });

  it("does not read the library for a plain event", async () => {
    await create({});
    expect(mockLoadPresetResolver).not.toHaveBeenCalled();
  });
});
