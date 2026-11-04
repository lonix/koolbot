/**
 * GET /admin/voice-channels (#1664): the page builds its own picker lists, so
 * its Managed category picker must get the category-create answer itself. The
 * real route, the real page; the permission check and the config are faked.
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

let storedRows: Array<{ key: string; value: unknown }> | null = [];
jest.unstable_mockModule("../../src/services/config-service.js", () => ({
  ConfigService: {
    getInstance: (): unknown => ({
      getBoolean: jest.fn(async () => false),
      getString: jest.fn(async () => ""),
      getNumber: jest.fn(async () => 0),
      getAll: jest.fn(async () => {
        if (storedRows === null) throw new Error("db down");
        return storedRows;
      }),
      get: jest.fn(async () => null),
      registerReloadCallback: jest.fn(),
    }),
  },
}));

type Can = { ok: true } | { ok: false; reason: string } | { ok: "unknown" };
let can: Can = { ok: true };
const mockCanBotCreate = jest.fn<(...a: any[]) => Promise<Can>>(
  async () => can,
);
jest.unstable_mockModule("../../src/services/bot-create-check.js", () => ({
  canBotCreate: mockCanBotCreate,
  toPickerCreate: (kind: string, answer: Can): unknown =>
    answer.ok === "unknown"
      ? undefined
      : {
          kind,
          ok: answer.ok,
          ...(answer.ok === false ? { reason: answer.reason } : {}),
        },
}));

const { VoiceChannelManager } =
  await import("../../src/services/voice-channel-manager.js");
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

let harness: AdminHarness;
const KEY = "voicechannels.category_id";

beforeEach(async () => {
  can = { ok: true };
  storedRows = [];
  mockCanBotCreate.mockClear();
  jest.spyOn(VoiceChannelManager, "getInstance").mockReturnValue({
    getMisplacedLobbies: async () => [],
    isLive: () => false,
    getCustomChannelName: () => null,
  } as never);
  harness = await startAdminHarness([
    createReadOnlyRouter(client, stubRequireSession(createTestSession())),
  ]);
});
afterEach(async () => {
  jest.restoreAllMocks();
  await harness.close();
});

/** The `create` flag of the Managed category picker, or undefined. */
function createOf(html: string): unknown {
  const at = html.indexOf(`name="value_${KEY}"`);
  expect(at).toBeGreaterThan(-1);
  const start = html.lastIndexOf("data-picker-meta=", at);
  const raw = (
    html.slice(start).match(/data-picker-meta="([^"]*)"/) as RegExpMatchArray
  )[1]
    .replace(/&quot;/g, '"')
    .replace(/&amp;/g, "&");
  const meta = JSON.parse(raw);
  return Array.isArray(meta) ? undefined : meta.create;
}
const page = async (): Promise<string> =>
  (await harness.get("/voice-channels")).text();

describe("GET /voice-channels: the Managed category picker (#1664)", () => {
  it("offers the create row when the bot can create a category", async () => {
    expect(createOf(await page())).toEqual({ kind: "category", ok: true });
    expect(mockCanBotCreate.mock.calls[0][2]).toEqual({ kind: "category" });
    expect(mockCanBotCreate).toHaveBeenCalledTimes(1);
  });

  it("carries the help line when the bot cannot", async () => {
    can = { ok: false, reason: "The bot needs Manage Channels." };
    expect(createOf(await page())).toEqual({
      kind: "category",
      ok: false,
      reason: "The bot needs Manage Channels.",
    });
  });

  it("shows neither row nor help line when the permissions cannot be read", async () => {
    can = { ok: "unknown" };
    expect(createOf(await page())).toBeUndefined();
  });

  it("draws a waiting name as pending when the permissions cannot be read", async () => {
    can = { ok: "unknown" };
    storedRows = [{ key: KEY, value: "create:Gaming" }];
    const html = await page();
    expect(html).toContain("Gaming (will be created)");
    expect(createOf(html)).toEqual({ kind: "category", ok: false });
  });

  it("asks no permission question while the stored config cannot be read", async () => {
    storedRows = null;
    await page();
    expect(mockCanBotCreate).not.toHaveBeenCalled();
  });
});

describe("the pages that use the shared loader get the category answer (#1664)", () => {
  it.each([
    ["Events", "events.category_id"],
    ["Tickets", "tickets.category_id"],
  ])("%s: loadFeatureSettings carries createCategory", async (_n, key) => {
    const { loadFeatureSettings } =
      await import("../../src/web/read-only-routes.js");
    const data = await loadFeatureSettings(client, "guild-1", [key], []);
    expect(data.pickers.createCategory).toEqual({ kind: "category", ok: true });
    can = { ok: false, reason: "no" };
    const refused = await loadFeatureSettings(client, "guild-1", [key], []);
    expect(refused.pickers.createCategory).toEqual({
      kind: "category",
      ok: false,
      reason: "no",
    });
  });
});
