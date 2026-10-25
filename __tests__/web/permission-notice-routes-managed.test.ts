/**
 * GET /admin/quotes and GET /admin/notices (#1489): each page shows only its
 * own registry area's findings (from the shared check, no call of its own),
 * only while the feature is on, and says so when the check cannot run.
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
import type { BotPermissionReport } from "../../src/services/bot-permission-check.js";

jest.unstable_mockModule("../../src/utils/logger.js", () => ({
  default: {
    info: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
    debug: jest.fn(),
  },
  isDebugMode: jest.fn(() => false),
}));

let featuresOn = true;
jest.unstable_mockModule("../../src/services/config-service.js", () => ({
  ConfigService: {
    getInstance: (): unknown => ({
      getBoolean: jest.fn(async () => featuresOn),
      getString: jest.fn(async () => ""),
      getNumber: jest.fn(async (_k: string, fallback: number) => fallback),
      getAll: jest.fn(async () => []),
      get: jest.fn(async () => null),
      registerReloadCallback: jest.fn(),
    }),
  },
}));

const registry = await import("../../src/services/bot-permission-registry.js");
const actualCheck = await import("../../src/services/bot-permission-check.js");
const mockCheck =
  jest.fn<(client: unknown, guildId: string) => Promise<BotPermissionReport>>();
jest.unstable_mockModule("../../src/services/bot-permission-check.js", () => ({
  ...actualCheck,
  checkBotPermissions: mockCheck,
}));

const { quoteService } = await import("../../src/services/quote-service.js");
const { default: Notice } = await import("../../src/models/notice.js");
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

function ref(id: string) {
  const r = registry.FEATURE_REQUIREMENTS.find((x) => x.id === id);
  if (!r) throw new Error(id);
  return {
    id: r.id,
    area: r.area,
    feature: r.feature,
    effect: r.effect,
    fix: r.fix,
  };
}

function report(over: Partial<BotPermissionReport>): BotPermissionReport {
  return {
    available: true,
    reason: null,
    fresh: true,
    problems: [],
    unknown: [],
    quiet: [],
    okFeatures: [],
    notes: [],
    checks: [],
    ...over,
  };
}

const missing = report({
  checks: [
    {
      feature: ref("quotes-post"),
      kind: "permission",
      enabled: true,
      outcome: "missing",
      target: { kind: "channel", id: "q1", name: "quote-wall" },
      missing: ["Send Messages"],
    },
    {
      feature: ref("quotes-pin"),
      kind: "permission",
      enabled: false,
      outcome: "missing",
      target: { kind: "channel", id: "q1", name: "quote-wall" },
      missing: ["Pin Messages"],
    },
    {
      feature: ref("notices-cleanup"),
      kind: "permission",
      enabled: true,
      outcome: "missing",
      target: { kind: "channel", id: "n1", name: "house-rules" },
      missing: ["Manage Messages"],
    },
  ],
});

const session = createTestSession();
let harness: AdminHarness;

beforeEach(async () => {
  jest.clearAllMocks();
  featuresOn = true;
  jest.spyOn(quoteService, "listQuotes").mockResolvedValue({
    quotes: [],
    total: 0,
    page: 1,
    totalPages: 1,
  } as never);
  jest.spyOn(Notice, "find").mockReturnValue({
    sort: () => ({ lean: async () => [] }),
  } as never);
  harness = await startAdminHarness([
    createReadOnlyRouter(client, stubRequireSession(session)),
  ]);
});

afterEach(async () => {
  jest.restoreAllMocks();
  await harness.close();
});

describe.each([
  ["/quotes", "Quotes", "quote-wall", "house-rules"],
  ["/notices", "Notices", "house-rules", "quote-wall"],
])("GET %s", (path, area, ownChannel, otherChannel) => {
  it(`shows only the ${area} finding, naming the permission and channel`, async () => {
    mockCheck.mockResolvedValue(missing);
    const html = await (await harness.get(path)).text();
    expect(html).toContain("data-permission-notice");
    expect(html).toContain(`in the channel “${ownChannel}”`);
    expect(html).not.toContain(`“${otherChannel}”`);
    expect(html).toContain('href="/admin/bot-permissions"');
  });

  it("does not report a sub-feature that is off (the pin check)", async () => {
    mockCheck.mockResolvedValue(missing);
    const html = await (await harness.get(path)).text();
    expect(html).not.toContain("Pin Messages");
  });

  it("shows nothing when the permissions are in place", async () => {
    mockCheck.mockResolvedValue(report({}));
    const html = await (await harness.get(path)).text();
    expect(html).not.toContain("data-permission-notice");
  });

  it("says the check could not run, with the reason", async () => {
    mockCheck.mockResolvedValue(
      report({ available: false, reason: "The bot is not connected." }),
    );
    const html = await (await harness.get(path)).text();
    expect(html).toContain("Bot permissions could not be checked");
    expect(html).toContain("The bot is not connected.");
  });

  it("labels a read from the bot's cache as possibly out of date", async () => {
    mockCheck.mockResolvedValue({ ...missing, fresh: false });
    const html = await (await harness.get(path)).text();
    expect(html).toContain("may be out of date");
  });

  it("does not run the check while the feature is off", async () => {
    featuresOn = false;
    mockCheck.mockResolvedValue(missing);
    const html = await (await harness.get(path)).text();
    expect(html).not.toContain("data-permission-notice");
    // The navigation badge's own warm-up may call it; the page's must not.
    expect(mockCheck.mock.calls.length).toBeLessThanOrEqual(1);
  });

  it("shows nothing for a channel that is not set (the check reports no target)", async () => {
    mockCheck.mockResolvedValue(
      report({
        checks: [
          {
            feature: ref(area === "Quotes" ? "quotes-post" : "notices-post"),
            kind: "permission",
            enabled: true,
            outcome: "unknown",
            target: null,
            missing: [],
          },
        ],
      } as never),
    );
    const html = await (await harness.get(path)).text();
    expect(html).not.toContain("data-permission-notice");
  });
});
