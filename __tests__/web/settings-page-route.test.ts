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

/** Reaction-role mapping rows as stored, across two guilds (#1433). */
const ROLE_ROWS = [
  {
    guildId: "guild-1",
    messageId: "100000000000000001",
    messageChannelId: "222222222222222222",
    emoji: "🎮",
    roleName: "Gamer",
    isArchived: false,
  },
  {
    guildId: "guild-1",
    messageId: "100000000000000001",
    messageChannelId: "222222222222222222",
    emoji: "🎨",
    roleName: "Artist",
    isArchived: false,
  },
  {
    guildId: "guild-1",
    messageId: "100000000000000002",
    emoji: "📚",
    roleName: "Reader",
    isArchived: false,
  },
  {
    guildId: "guild-2",
    messageId: "300000000000000003",
    messageChannelId: "222222222222222222",
    emoji: "🎲",
    roleName: "Elsewhere",
    isArchived: false,
  },
];
const SEED_ROWS = [...ROLE_ROWS];
let mappingReadFails = false;
const mockAggregate = jest.fn(async (pipeline: Array<Record<string, any>>) => {
  if (mappingReadFails) throw new Error("mongo down");
  const match = pipeline[0].$match as { guildId: string; isArchived: boolean };
  const groups = new Map<
    string,
    {
      _id: string;
      messageChannelId?: string;
      roles: Array<{ emoji: string; roleName: string }>;
    }
  >();
  for (const r of ROLE_ROWS.filter(
    (x) => x.guildId === match.guildId && x.isArchived === match.isArchived,
  )) {
    const g = groups.get(r.messageId) ?? {
      _id: r.messageId,
      messageChannelId: r.messageChannelId,
      roles: [],
    };
    g.roles.push({ emoji: r.emoji, roleName: r.roleName });
    groups.set(r.messageId, g);
  }
  return [...groups.values()];
});
jest.unstable_mockModule("../../src/models/reaction-role-config.js", () => ({
  REACTION_ROLE_STYLES: ["reaction", "button", "select"],
  REACTION_ROLE_MODES: ["toggle", "sticky", "unique"],
  ReactionRoleConfig: {
    aggregate: mockAggregate,
    distinct: jest.fn(async () => []),
    find: jest.fn(),
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

describe("GET /settings: welcome roles message picker (#1433)", () => {
  /** The picker's markup: the select and the help line under it. */
  async function pickerHtml(): Promise<string> {
    const html = await (await harness.get("/settings")).text();
    const start = html.indexOf('<span class="kb-msgpick">');
    expect(start).toBeGreaterThan(-1);
    const end = html.indexOf("</select>", start);
    const help = html.indexOf("</span></span>", end);
    return html.slice(start, help === -1 ? end : help + 14);
  }

  beforeEach(() => {
    mappingReadFails = false;
    mockAggregate.mockClear();
  });

  it("renders a select, never a text box, with the empty choice first", async () => {
    const html = await (await harness.get("/settings")).text();
    expect(html).not.toMatch(
      /<input[^>]*name="value_welcome\.roles_message_id"/,
    );
    const picker = await pickerHtml();
    expect(picker).toMatch(
      /<select class="kb-select"[^>]*name="value_welcome\.roles_message_id">\s*<option value="" selected>Link the channel instead<\/option>/,
    );
  });

  it("lists only this guild's reaction-role messages by what they hand out", async () => {
    const picker = await pickerHtml();
    expect(picker).toContain('<option value="100000000000000001">');
    expect(picker).toContain("🎮 Gamer, 🎨 Artist");
    expect(picker).toContain('<option value="100000000000000002">');
    expect(picker).not.toContain("300000000000000003");
    expect(picker).not.toContain("Elsewhere");
    expect(mockAggregate).toHaveBeenCalledTimes(1);
    const pipeline = mockAggregate.mock.calls[0][0] as Array<
      Record<string, unknown>
    >;
    expect(pipeline[0]).toEqual({
      $match: { guildId: "guild-1", isArchived: false },
    });
  });

  it("never disables an option", async () => {
    const picker = await pickerHtml();
    expect(picker).not.toMatch(/<option[^>]*disabled/);
  });

  it("selects the stored message", async () => {
    stored.push({
      key: "welcome.roles_message_id",
      value: "100000000000000002",
    });
    const picker = await pickerHtml();
    expect(picker).toContain('<option value="100000000000000002" selected>');
    expect(picker).not.toContain("(not found)");
  });

  it("keeps a stored id that is not in the list as a selected (not found) option", async () => {
    stored.push({
      key: "welcome.roles_message_id",
      value: "999999999999999999",
    });
    const picker = await pickerHtml();
    expect(picker).toContain(
      '<option value="999999999999999999" selected>999999999999999999 (not found)</option>',
    );
  });

  it("points at the Reaction Roles page when there are no messages, keeping the stored value", async () => {
    ROLE_ROWS.splice(0, ROLE_ROWS.length);
    stored.push({
      key: "welcome.roles_message_id",
      value: "999999999999999999",
    });
    try {
      const picker = await pickerHtml();
      expect(picker).toContain('href="/admin/reaction-roles"');
      expect(picker).toContain("999999999999999999 (not found)");
      expect(picker).toContain("Link the channel instead");
    } finally {
      ROLE_ROWS.push(...SEED_ROWS);
    }
  });

  it("does not claim there are none when the list cannot be read", async () => {
    mappingReadFails = true;
    stored.push({
      key: "welcome.roles_message_id",
      value: "100000000000000001",
    });
    const picker = await pickerHtml();
    expect(picker).not.toContain("no reaction-role messages yet");
    expect(picker).toContain("could not be read");
    expect(picker).toContain(
      '<option value="100000000000000001" selected>100000000000000001 (could not check)</option>',
    );
  });
});
