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
        name: opts.categoryName ?? "Events",
        bits: opts.categoryBits ?? opts.serverBits,
      },
    ],
  ]);
  const guild = {
    id: "guild-1",
    members: { me, fetchMe: async () => me },
    roles: { cache: new Map(), fetch: async () => new Map() },
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
    expect(html).toContain("Manage Channels");
    expect(html).toContain("in the category “Event nights”");
    expect(html).toContain("Event and group channels");
    expect(html).toContain("make sure the events category does not deny it");
    expect(html).toContain("1 missing permission affects");
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
      "Every permission the enabled features need is in place",
    );
    expect(html).not.toContain("Missing permissions</h2>");
  });

  it("does not report a feature that is switched off, only a quiet note", async () => {
    settings = { "reactionroles.enabled": false };
    await start(clientWith({ serverBits: ALL & ~P.ManageRoles }));
    const html = await (await harness.get("/bot-permissions")).text();
    expect(html).not.toContain("Missing permissions</h2>");
    expect(html).toContain("Not needed right now");
    expect(html).toContain("Handing out roles");
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
    expect(none).toContain("Bot Permissions");
    expect(none).not.toContain("Missing permissions affect enabled features");
    status.setPermissionIssueCount("guild-1", 3);
    const some = render();
    expect(some).toContain(
      '<span class="nav-badge" title="Missing permissions affect enabled features">3</span>',
    );
  });

  it("is updated by a check, from the enabled features only", async () => {
    settings = { "reactionroles.enabled": true };
    await start(clientWith({ serverBits: ALL & ~P.ManageRoles }));
    await harness.get("/bot-permissions");
    expect(status.getPermissionIssueCount()).toBe(1);
  });
});
