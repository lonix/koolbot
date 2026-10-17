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
