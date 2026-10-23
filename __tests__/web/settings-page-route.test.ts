/**
 * GET /admin/settings (#1428): the All settings table over HTTP. The leaderboard
 * tier string is left out (it has its own editor), and each bot-managed message
 * id links to the page where it is re-posted.
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

let stored: Array<{ key: string; value: unknown }> = [];
jest.unstable_mockModule("../../src/services/config-service.js", () => ({
  ConfigService: {
    getInstance: (): unknown => ({
      getBoolean: jest.fn(async (_k: string, d: boolean) => d),
      getString: jest.fn(async (_k: string, d: string) => d),
      getBooleanStrict: jest.fn(async (_k: string, d: boolean) => d),
      getStringStrict: jest.fn(async (_k: string, d: string) => d),
      getNumber: jest.fn(async () => 0),
      getAll: jest.fn(async () => stored),
      get: jest.fn(async () => null),
      registerReloadCallback: jest.fn(),
      addChangeListener: jest.fn(),
    }),
  },
}));

const { createReadOnlyRouter } =
  await import("../../src/web/read-only-routes.js");

const client = {
  user: { id: "bot" },
  isReady: () => true,
  guilds: {
    fetch: async () => {
      throw new Error("no guild in this test");
    },
  },
} as unknown as Client;

let harness: AdminHarness;

beforeEach(async () => {
  stored = [
    { key: "leaderboard_roles.tiers", value: "1:888888888888888888" },
    { key: "quotes.header_message_id", value: "333333333333333333" },
    { key: "quotes.channel_id", value: "222222222222222222" },
    { key: "notices.header_message_id", value: "444444444444444444" },
    { key: "rules.message_id", value: "555555555555555555" },
  ];
  harness = await startAdminHarness([
    createReadOnlyRouter(client, stubRequireSession(createTestSession())),
  ]);
});

afterEach(async () => {
  await harness.close();
});

describe("GET /settings", () => {
  it("leaves the leaderboard tier string out of the table", async () => {
    const res = await harness.get("/settings");
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).not.toContain("leaderboard_roles.tiers");
    expect(html).not.toContain("888888888888888888");
    // The rest of that section is still there.
    expect(html).toContain("leaderboard_roles.update_cron");
  });

  it("links each managed message id to the page where it is re-posted", async () => {
    const html = await (await harness.get("/settings")).text();
    expect(html).toContain('href="/admin/quotes#repost-header"');
    expect(html).toContain('href="/admin/notices#repost-header"');
    expect(html).toContain('href="/admin/rules#repost-message"');
    // The id stays read-only: no field is rendered for it.
    expect(html).not.toContain('name="value_quotes.header_message_id"');
  });

  it("offers no Re-post link for a message that was never posted", async () => {
    stored = [];
    const html = await (await harness.get("/settings")).text();
    expect(html).not.toContain("#repost-header");
    expect(html).not.toContain("#repost-message");
  });
});
