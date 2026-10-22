/**
 * The "Bot permissions" admin page (#1217): the real route over HTTP with a
 * fake Discord server behind it, the view's escaping, and the navigation badge.
 */

import {
  describe,
  it,
  expect,
  jest,
  beforeEach,
  afterEach,
} from "@jest/globals";
import {
  ChannelType,
  PermissionFlagsBits,
  PermissionsBitField,
  type Client,
} from "discord.js";
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

let settings: Record<string, string | boolean> = {};
jest.unstable_mockModule("../../src/services/config-service.js", () => ({
  ConfigService: {
    getInstance: (): unknown => ({
      getBoolean: jest.fn(async (key: string, d: boolean) =>
        key in settings ? settings[key] === true : d,
      ),
      getString: jest.fn(async (key: string, d: string) =>
        key in settings ? String(settings[key]) : d,
      ),
      getBooleanStrict: jest.fn(async (key: string, d: boolean) => {
        if (settings.__unreadable === true) throw new Error("db down");
        return key in settings ? settings[key] === true : d;
      }),
      getStringStrict: jest.fn(async (key: string, d: string) => {
        if (settings.__unreadable === true) throw new Error("db down");
        return key in settings ? String(settings[key]) : d;
      }),
      getNumber: jest.fn(async () => 0),
      getAll: jest.fn(async () => []),
      get: jest.fn(async () => null),
      registerReloadCallback: jest.fn(),
    }),
  },
}));

const { RoleGroupService } =
  await import("../../src/services/role-group-service.js");
const { createReadOnlyRouter } =
  await import("../../src/web/read-only-routes.js");
const { renderBotPermissionsPage } =
  await import("../../src/web/bot-permissions-view.js");
const { renderAdminPage } = await import("../../src/web/admin-layout.js");
const check = await import("../../src/services/bot-permission-check.js");
const status = await import("../../src/services/bot-permission-status.js");

const P = PermissionFlagsBits;
const ALL =
  P.ManageChannels |
  P.MoveMembers |
  P.Connect |
  P.ManageRoles |
  P.ManageNicknames |
  P.ManageEvents |
  P.ViewChannel |
  P.Speak;

function clientWith(opts: {
  serverBits: bigint;
  categoryName?: string;
  categoryBits?: bigint;
  roles?: Array<{ id: string; name: string; position: number }>;
}): Client {
  const me = {
    permissions: new PermissionsBitField(opts.serverBits),
    permissionsIn: (c: { bits: bigint }) => new PermissionsBitField(c.bits),
    roles: { highest: { position: 10 } },
  };
  const channels = new Map([
    [
      "cat",
      {
        id: "cat",
        type: ChannelType.GuildCategory,
        name: opts.categoryName ?? "Events",
        bits: opts.categoryBits ?? opts.serverBits,
      },
    ],
  ]);
  const roles = new Map((opts.roles ?? []).map((r) => [r.id, r] as const));
  const guild = {
    id: "guild-1",
    members: { me, fetchMe: async () => me },
    roles: { cache: roles, fetch: async () => roles },
    channels: { cache: channels, fetch: async () => channels },
  };
  return {
    user: { id: "bot" },
    guilds: {
      cache: new Map([["guild-1", guild]]),
      fetch: async () => guild,
    },
    commands: new Map(),
  } as unknown as Client;
}

let harness: AdminHarness;

async function start(client: Client): Promise<void> {
  harness = await startAdminHarness([
    createReadOnlyRouter(client, stubRequireSession(createTestSession())),
  ]);
}

beforeEach(() => {
  jest
    .spyOn(RoleGroupService, "getInstance")
    .mockReturnValue({ list: jest.fn(async () => []) } as never);
  settings = {};
  check.resetBotPermissionCache();
  status.resetPermissionIssueCount();
});

afterEach(async () => {
  jest.restoreAllMocks();
  await harness?.close();
});

describe("GET /bot-permissions", () => {
  it("names the missing permission, where, the enabled feature it affects and the fix", async () => {
    settings = { "events.enabled": true, "events.category_id": "cat" };
    await start(
      clientWith({
        serverBits: ALL,
        categoryName: "Event nights",
        categoryBits: ALL & ~P.ManageChannels,
      }),
    );
    const res = await harness.get("/bot-permissions");
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).toContain("How to fix");
    expect(html).toContain(
      "Give the bot’s role <strong>Manage Channels</strong>, and make sure the category “Event nights” does not deny it.",
    );
    expect(html).toMatch(
      /<tr class="is-missing"><th scope="row">Manage Channels<\/th><td><span class="kb-perm kb-perm--missing">.*?Missing<\/span><\/td><td>.*?Event nights.*?<\/td><td>.*?Events: Event and group channels/,
    );
    // The other permissions the events feature needs are listed as held.
    expect(html).toMatch(
      /Manage Nicknames<\/th><td><span class="kb-perm kb-perm--has">/,
    );
  });

  it("says everything is in place when nothing is missing", async () => {
    settings = { "events.enabled": true, "events.category_id": "cat" };
    await start(
      clientWith({
        serverBits: ALL,
      }),
    );
    const html = await (await harness.get("/bot-permissions")).text();
    expect(html).toContain(
      "All permissions your switched-on features need are in place.",
    );
    expect(html).not.toContain("How to fix");
    expect(html).not.toContain("kb-perm--missing");
  });

  it("does not report a feature that is switched off, only a Not needed row with a greyed chip", async () => {
    settings = { "reactionroles.enabled": false };
    await start(clientWith({ serverBits: ALL & ~P.ManageRoles }));
    const html = await (await harness.get("/bot-permissions")).text();
    expect(html).not.toContain("How to fix");
    expect(html).not.toContain("kb-perm--missing");
    expect(html).toContain("Not needed");
    expect(html).toMatch(
      /<tr class="is-quiet"><th scope="row">Manage Roles<\/th>.*?kb-perm--quiet.*?Reaction roles: Handing out roles \(off\)/,
    );
  });

  it("says the check is unavailable when the server cannot be read", async () => {
    await start({
      user: { id: "bot" },
      guilds: {
        cache: new Map(),
        fetch: jest.fn(async () => {
          throw new Error("down");
        }),
      },
      commands: new Map(),
    } as unknown as Client);
    const html = await (await harness.get("/bot-permissions")).text();
    expect(html).toContain("could not read this server from Discord");
  });
});

describe("a role the bot cannot hand out is not shown as in place", () => {
  const rulesChip = "Rules: Granting the acceptance role";

  it("puts the role in a Role position row and a fix step, not as in place, when the role is above the bot", async () => {
    settings = { "rules.enabled": true, "rules.role_id": "55" };
    await start(
      clientWith({
        serverBits: ALL,
        roles: [{ id: "55", name: "Staff", position: 20 }],
      }),
    );
    const html = await (await harness.get("/bot-permissions")).text();
    expect(html).toMatch(
      /<tr class="is-missing"><th scope="row">Role position<\/th>.*?Too low.*?Staff.*?Rules: Granting the acceptance role/,
    );
    expect(html).toContain(
      "Move the bot’s role <strong>above</strong> the role “Staff” in Server Settings → Roles.",
    );
    // Manage Roles itself is held: that row is not turned red by the role.
    expect(html).toMatch(
      /Manage Roles<\/th><td><span class="kb-perm kb-perm--has">/,
    );
  });

  it("marks the role position Not checked, not in place, when the role is not found", async () => {
    settings = { "rules.enabled": true, "rules.role_id": "55" };
    await start(clientWith({ serverBits: ALL, roles: [] }));
    const html = await (await harness.get("/bot-permissions")).text();
    expect(html).toMatch(
      /Role position<\/th><td><span class="kb-perm kb-perm--unknown">.*?Not checked.*?The configured role could not be found\./,
    );
    expect(html).not.toContain("All permissions your switched-on");
    expect(html).not.toContain("How to fix");
  });

  it("shows the role position as Above when the role is below the bot", async () => {
    settings = { "rules.enabled": true, "rules.role_id": "55" };
    await start(
      clientWith({
        serverBits: ALL,
        roles: [{ id: "55", name: "Fans", position: 2 }],
      }),
    );
    const html = await (await harness.get("/bot-permissions")).text();
    expect(html).toMatch(
      /Role position<\/th><td><span class="kb-perm kb-perm--has">.*?Above.*?Fans/,
    );
    expect(html).toContain(rulesChip);
  });
});

describe("the view escapes what Discord and settings supply", () => {
  it("escapes channel names", () => {
    const html = renderBotPermissionsPage({
      csrfToken: "t",
      remainingMs: 1000,
      report: {
        available: true,
        reason: null,
        fresh: true,
        problems: [
          {
            permission: "Manage Channels",
            target: { kind: "category", id: "c", name: "<b>x</b>" },
            features: [
              {
                id: "f",
                area: "A<",
                feature: "F&",
                effect: "E",
                fix: "X",
              },
            ],
          },
        ],
        unknown: [],
        quiet: [],
        okFeatures: [],
        notes: ["<i>note</i>"],
        checks: [
          {
            feature: {
              id: "event-channels",
              area: "A<",
              feature: "F&",
              effect: "E",
              fix: "X",
            },
            kind: "permission",
            enabled: true,
            outcome: "missing",
            target: { kind: "category", id: "c", name: "<b>x</b>" },
            missing: ["Manage Channels"],
          },
        ],
      },
    });
    expect(html).toContain("&lt;b&gt;x&lt;/b&gt;");
    expect(html).not.toContain("<b>x</b>");
    expect(html).toContain("A&lt;");
    expect(html).toContain("F&amp;");
    expect(html).not.toContain("<i>note</i>");
  });
});

describe("the navigation badge", () => {
  it("shows the count of missing permissions on the Bot Permissions entry, and only then", () => {
    const render = (): string =>
      renderAdminPage({
        title: "T",
        active: "/admin/",
        body: "",
        csrfToken: "t",
        remainingMs: 1000,
      });
    const none = render();
    expect(none).toContain("Bot permissions");
    expect(none).not.toContain("Missing permissions affect enabled features");
    status.setPermissionIssueCount("guild-1", 3);
    const some = render();
    expect(some).toContain(
      '<span class="kb-badge kb-badge--warn kb-badge--count kb-sidenav__end" title="Missing permissions affect enabled features">3</span>',
    );
  });

  it("is updated by a check, from the enabled features only", async () => {
    settings = { "reactionroles.enabled": true };
    await start(clientWith({ serverBits: ALL & ~P.ManageRoles }));
    await harness.get("/bot-permissions");
    expect(status.getPermissionIssueCount()).toBe(1);
  });
});
