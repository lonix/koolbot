/**
 * GET /admin/ (#1322): the Dashboard route over HTTP with a fake Discord
 * behind it. Each source can fail or hang without taking the page with it, a
 * scan is only ever read from the cache, and the voice aggregate is read for
 * the last 7 days and only when voice tracking is on.
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
  Collection,
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
import { busyScan } from "./server-scan-fixtures.js";

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
      getBooleanStrict: jest.fn(async (key: string, d: boolean) =>
        key in settings ? settings[key] === true : d,
      ),
      getStringStrict: jest.fn(async (key: string, d: string) =>
        key in settings ? String(settings[key]) : d,
      ),
      getNumber: jest.fn(async () => 0),
      getAll: jest.fn(async () => []),
      get: jest.fn(async () => null),
      registerReloadCallback: jest.fn(),
      addChangeListener: jest.fn(),
    }),
  },
}));

const heatmap = jest.fn<
  (start: Date, end: Date, zone?: string | null) => Promise<unknown>
>(async () => ({
  matrix: [],
  byHour: [],
  byDay: [0, 0, 0, 0, 0, 120, 30],
  totalMinutes: 150,
  peak: { day: 5, hour: 21, minutes: 120 },
  timeZone: "UTC",
}));
jest.unstable_mockModule(
  "../../src/services/voice-activity-analytics.js",
  () => ({
    // The Dashboard reads the strict query, so a failed aggregation rejects.
    queryGuildVoiceHeatmap: heatmap,
    // The lenient read the Voice analytics page uses: an empty week on failure.
    getGuildVoiceHeatmap: async () => ({
      matrix: [],
      byHour: [],
      byDay: [0, 0, 0, 0, 0, 0, 0],
      totalMinutes: 0,
      peak: null,
      timeZone: "UTC",
    }),
  }),
);

const { RoleGroupService } =
  await import("../../src/services/role-group-service.js");
const { ServerScanService } =
  await import("../../src/services/server-scan-service.js");
const { createReadOnlyRouter } =
  await import("../../src/web/read-only-routes.js");
const { cachedScan, scanCacheKey, resetScanCache } =
  await import("../../src/web/server-scan-cache.js");
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

function clientWith(serverBits: bigint, categoryBits = serverBits): Client {
  const me = {
    permissions: new PermissionsBitField(serverBits),
    permissionsIn: (c: { bits: bigint }) => new PermissionsBitField(c.bits),
    roles: { highest: { position: 10 } },
  };
  const channels = new Map([
    [
      "cat",
      {
        id: "cat",
        type: ChannelType.GuildCategory,
        name: "Event nights",
        bits: categoryBits,
      },
    ],
  ]);
  const roles = new Map();
  const guild = {
    id: "guild-1",
    name: "Test Guild",
    memberCount: 42,
    voiceStates: { cache: new Collection([["u", { channelId: "v1" }]]) },
    members: { me, fetchMe: async () => me },
    roles: { cache: roles, fetch: async () => roles },
    channels: { cache: channels, fetch: async () => channels },
  };
  return {
    user: { id: "bot", tag: "Koolbot#0001" },
    isReady: () => true,
    guilds: {
      cache: new Map([["guild-1", guild]]),
      fetch: async () => guild,
    },
    commands: new Map(),
  } as unknown as Client;
}

let harness: AdminHarness;
let scan: jest.Mock<(guildId: string, opts: unknown) => Promise<unknown>>;

async function start(client: Client): Promise<void> {
  harness = await startAdminHarness([
    createReadOnlyRouter(client, stubRequireSession(createTestSession())),
  ]);
}

beforeEach(() => {
  settings = {};
  heatmap.mockClear();
  resetScanCache();
  check.resetBotPermissionCache();
  status.resetPermissionIssueCount();
  scan = jest.fn(async () => busyScan());
  jest
    .spyOn(ServerScanService, "getInstance")
    .mockReturnValue({ scan } as never);
  jest
    .spyOn(RoleGroupService, "getInstance")
    .mockReturnValue({ list: jest.fn(async () => []) } as never);
});

afterEach(async () => {
  jest.restoreAllMocks();
  await harness?.close();
});

const dashboard = async (): Promise<string> => {
  const res = await harness.get("/");
  expect(res.status).toBe(200);
  return res.text();
};

describe("GET /admin/", () => {
  it("shows the state, hides Needs you when nothing is wrong, and has no switch", async () => {
    await start(clientWith(ALL));
    const html = await dashboard();
    expect(html).toContain('kb-pagehead__title">Dashboard');
    expect(html).toContain("42 <small>members</small>");
    expect(html).toContain("1 in voice now");
    expect(html).toContain("0 <small>issues</small>");
    expect(html).not.toContain('id="p-needs"');
    expect(html).not.toContain('role="switch"');
    // Voice tracking is off: neither the aggregate nor its panel.
    expect(heatmap).not.toHaveBeenCalled();
    expect(html).not.toContain('id="p-voice"');
  });

  it("lists a missing permission under Needs you and warns on the Permissions tile", async () => {
    settings = { "events.enabled": true, "events.category_id": "cat" };
    await start(clientWith(ALL, ALL & ~P.ManageChannels));
    const html = await dashboard();
    expect(html).toContain('id="p-needs"');
    expect(html).toContain(
      "Bot lacks Manage Channels in the category &quot;Event nights&quot;",
    );
    expect(html).toContain(
      'class="kb-tile kb-tile--warn" href="/admin/bot-permissions"',
    );
    expect(html).toContain("1 <small>issue</small>");
  });

  it("never starts a scan, but lists what a recent one found", async () => {
    await start(clientWith(ALL));
    await dashboard();
    expect(scan).not.toHaveBeenCalled();
    expect(await dashboard()).not.toContain("Found by the last Server scan.");

    await cachedScan(scanCacheKey("guild-1", "admin-1", false), async () =>
      busyScan(),
    );
    scan.mockClear();
    const html = await dashboard();
    expect(scan).not.toHaveBeenCalled();
    expect(html).toContain("The bot is not requesting the GuildMembers intent");
    expect(html).toContain('href="/admin/adopt">Open Server scan');
  });

  it("lists the newest finished scan, whether it was the plain or the hints one", async () => {
    await start(clientWith(ALL));
    const scanSaying = (message: string): ReturnType<typeof busyScan> => {
      const s = busyScan();
      s.readiness.issues = [
        { code: "x", severity: "warning", message, help: "h" },
      ];
      return s;
    };
    const plain = scanCacheKey("guild-1", "admin-1", false);
    const hints = scanCacheKey("guild-1", "admin-1", true);
    const pause = (): Promise<void> => new Promise((r) => setTimeout(r, 15));

    await cachedScan(plain, async () => scanSaying("OLD plain finding"));
    await pause();
    await cachedScan(hints, async () => scanSaying("NEW hints finding"));
    let html = await dashboard();
    expect(html).toContain("NEW hints finding");
    expect(html).not.toContain("OLD plain finding");

    resetScanCache();
    await cachedScan(hints, async () => scanSaying("OLD hints finding"));
    await pause();
    await cachedScan(plain, async () => scanSaying("NEW plain finding"));
    html = await dashboard();
    expect(html).toContain("NEW plain finding");
    expect(html).not.toContain("OLD hints finding");
  });

  it("still renders when Discord cannot be read, saying so instead of showing zeros", async () => {
    await start({
      user: null,
      isReady: () => false,
      guilds: {
        cache: new Map(),
        fetch: jest.fn(async () => {
          throw new Error("down");
        }),
      },
      commands: new Map(),
    } as unknown as Client);
    const html = await dashboard();
    expect(html).toContain("The server could not be read from Discord.");
    expect(html).toContain("Not checked");
    expect(html).not.toContain("0 <small>issues</small>");
    expect(html).not.toContain("0 <small>members</small>");
  });

  it("answers within the source limit when Discord hangs", async () => {
    await start({
      user: null,
      isReady: () => false,
      guilds: {
        cache: new Map(),
        fetch: () => new Promise(() => undefined),
      },
      commands: new Map(),
    } as unknown as Client);
    const started = Date.now();
    const html = await dashboard();
    expect(Date.now() - started).toBeLessThan(5_000);
    expect(html).toContain("The server could not be read from Discord.");
  }, 15_000);

  it("reads the last 7 days of voice, and only when voice tracking is on", async () => {
    settings = { "voicetracking.enabled": true };
    await start(clientWith(ALL));
    const html = await dashboard();
    expect(heatmap).toHaveBeenCalledTimes(1);
    const [from, to] = heatmap.mock.calls[0];
    expect(Math.round((to.getTime() - from.getTime()) / 86_400_000)).toBe(7);
    expect(html).toContain("Busiest day: Friday, 2 hr.");
  });

  it("shows the voice panel as unavailable when the aggregate fails", async () => {
    settings = { "voicetracking.enabled": true };
    heatmap.mockRejectedValueOnce(new Error("mongo down"));
    await start(clientWith(ALL));
    const html = await dashboard();
    expect(html).toContain("Voice activity could not be read just now.");
    expect(html).toContain('id="p-features"');
  });
});
