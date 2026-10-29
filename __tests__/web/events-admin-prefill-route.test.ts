/**
 * GET /admin/events/new (#1406, #1527): the create form is prefilled from the signed-in
 * admin's own remembered group setup, validated against today's limits, and
 * `?defaults=1` brings back the normal defaults without reading it. A failed
 * read never blocks the page.
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
  type AdminHarness,
} from "./admin-harness.js";

jest.unstable_mockModule("../../src/utils/logger.js", () => ({
  default: {
    info: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
    debug: jest.fn(),
  },
  isDebugMode: jest.fn(() => false),
}));

jest.unstable_mockModule("../../src/services/config-service.js", () => ({
  ConfigService: {
    getInstance: (): unknown => ({
      getBoolean: jest.fn(async () => false),
      getString: jest.fn(async () => ""),
      getNumber: jest.fn(async (key: string, fallback: number) =>
        key === "events.groups.max_count"
          ? 6
          : key === "events.groups.default_count"
            ? 2
            : fallback,
      ),
      getAll: jest.fn(async () => []),
      get: jest.fn(async () => null),
      registerReloadCallback: jest.fn(),
    }),
  },
}));

const mockLoadPrefill = jest.fn<(...args: unknown[]) => Promise<unknown>>();
const actualLastSetup =
  await import("../../src/services/event-last-setup-service.js");
jest.unstable_mockModule(
  "../../src/services/event-last-setup-service.js",
  () => ({ ...actualLastSetup, loadGroupPrefill: mockLoadPrefill }),
);

const { EventService } = await import("../../src/services/event-service.js");
const { createReadOnlyRouter } =
  await import("../../src/web/read-only-routes.js");

const client = {
  user: { id: "bot" },
  guilds: {
    cache: new Map(),
    fetch: jest.fn(async () => {
      throw new Error("discord down");
    }),
  },
  commands: new Map(),
} as unknown as Client;

const session = createTestSession();
let harness: AdminHarness;

beforeEach(async () => {
  jest.clearAllMocks();
  mockLoadPrefill.mockResolvedValue(null);
  jest.spyOn(EventService, "getInstance").mockReturnValue({
    listEvents: jest.fn(async () => []),
  } as never);
  harness = await startAdminHarness([
    createReadOnlyRouter(client, stubRequireSession(session)),
  ]);
});

afterEach(async () => {
  jest.restoreAllMocks();
  await harness.close();
});

const remembered = {
  presetId: "",
  groupLabel: "",
  leaderLabel: "",
  channelLeadMinutes: "",
  rows: [
    { name: "Red", kind: "team", size: "5", tag: "", marker: "" },
    { name: "Blue", kind: "team", size: "5", tag: "", marker: "" },
  ],
  captainsEnabled: false,
  captainCustomisationEnabled: false,
  captainsLobby: false,
  tagsEnabled: false,
  tagsSuffix: false,
};

describe("GET /events/new: remembered group setup", () => {
  it("prefills from the signed-in admin's own setup and offers the way back", async () => {
    mockLoadPrefill.mockResolvedValue(remembered);
    const html = await (await harness.get("/events/new")).text();
    const [guildId, ownerId, ctx] = mockLoadPrefill.mock.calls[0] as [
      string,
      string,
      { maxCount: number },
    ];
    expect(guildId).toBe(session.guildId);
    expect(ownerId).toBe(session.discordUserId);
    // Validated against the cap the form itself uses.
    expect(ctx.maxCount).toBe(6);
    expect(html).toContain("Prefilled from your last event.");
    expect(html).toContain('href="/admin/events/new?defaults=1"');
    expect(html).toMatch(/name="groups_enabled" value="1" checked/);
    expect(html).toMatch(/name="group_0_name"[^>]*value="Red"/);
  });

  it("keeps the deep link: ?when=now offers the way back with it and selects Now", async () => {
    mockLoadPrefill.mockResolvedValue(remembered);
    const html = await (await harness.get("/events/new?when=now")).text();
    expect(html).toContain('href="/admin/events/new?when=now&amp;defaults=1"');
    expect(html).toMatch(/name="when" value="now"[^>]*checked/);
  });

  it("shows the defaults for ?defaults=1 and does not read the store", async () => {
    mockLoadPrefill.mockResolvedValue(remembered);
    const html = await (await harness.get("/events/new?defaults=1")).text();
    expect(mockLoadPrefill).not.toHaveBeenCalled();
    expect(html).not.toContain("Prefilled from your last event.");
    expect(html).not.toMatch(/name="groups_enabled" value="1" checked/);
  });

  it("shows the defaults when there is nothing to prefill", async () => {
    const res = await harness.get("/events/new");
    expect(res.status).toBe(200);
    expect(await res.text()).not.toContain("Prefilled from your last event.");
  });
});
