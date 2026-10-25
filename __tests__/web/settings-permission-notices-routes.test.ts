/**
 * GET /admin/settings (#1487): the permission notice at the top of each mapped
 * section, from one check per page view, and none while the stored config
 * cannot be read.
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

let stored: Array<{ key: string; value: unknown }> = [];
let storedReadFails = false;
jest.unstable_mockModule("../../src/services/config-service.js", () => ({
  ConfigService: {
    getInstance: (): unknown => ({
      getBoolean: jest.fn(async (_k: string, d: boolean) => d),
      getString: jest.fn(async (_k: string, d: string) => d),
      getBooleanStrict: jest.fn(async (_k: string, d: boolean) => d),
      getStringStrict: jest.fn(async (_k: string, d: string) => d),
      getNumber: jest.fn(async () => 0),
      getAll: jest.fn(async () => {
        if (storedReadFails) throw new Error("mongo down");
        return stored;
      }),
      get: jest.fn(async () => null),
      registerReloadCallback: jest.fn(),
      addChangeListener: jest.fn(),
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
      feature: ref("welcome-post"),
      kind: "permission",
      enabled: true,
      outcome: "missing",
      target: { kind: "channel", id: "c1", name: "welcome-room" },
      missing: ["Send Messages"],
    },
    {
      feature: ref("log-errors"),
      kind: "permission",
      enabled: true,
      outcome: "missing",
      target: { kind: "channel", id: "c2", name: "bot-errors" },
      missing: ["Embed Links"],
    },
  ],
});

let harness: AdminHarness;

beforeEach(async () => {
  jest.clearAllMocks();
  storedReadFails = false;
  stored = [
    { key: "welcome.enabled", value: true },
    { key: "welcome.channel_id", value: "222222222222222222" },
    { key: "core.errors.enabled", value: true },
    { key: "core.errors.channel_id", value: "555555555555555555" },
  ];
  harness = await startAdminHarness([
    createReadOnlyRouter(client, stubRequireSession(createTestSession())),
  ]);
});

afterEach(async () => {
  await harness.close();
});

/** The card of one section, from its id to the next card. */
function section(html: string, category: string): string {
  const start = html.indexOf(`id="section-${category}"`);
  expect(start).toBeGreaterThan(-1);
  const next = html.indexOf('class="card', start + 10);
  return html.slice(start, next === -1 ? undefined : next);
}

describe("GET /settings: permission notices (#1487)", () => {
  it("shows each section its own notice, before the form", async () => {
    mockCheck.mockResolvedValue(missing);
    const html = await (await harness.get("/settings")).text();
    const welcome = section(html, "welcome");
    expect(welcome).toContain("data-permission-notice");
    expect(welcome).toContain("Send Messages");
    expect(welcome).toContain("in the channel “welcome-room”");
    expect(welcome).not.toContain("Embed Links");
    expect(welcome.indexOf("data-permission-notice")).toBeLessThan(
      welcome.indexOf("<form"),
    );
    const core = section(html, "core");
    expect(core).toContain("Embed Links");
    expect(core).toContain("in the channel “bot-errors”");
    // A section that is not mapped shows none.
    expect(section(html, "quotes")).not.toContain("data-permission-notice");
  });

  it("runs the check once for the page, not once per section", async () => {
    mockCheck.mockResolvedValue(missing);
    await harness.get("/settings");
    // The navigation badge's background warm-up is one more call; the two
    // mapped sections add none (the shared snapshot serves both).
    expect(mockCheck.mock.calls.length).toBeLessThanOrEqual(2);
    const before = mockCheck.mock.calls.length;
    stored = [];
    await harness.get("/settings");
    // Nothing in use: only the warm-up.
    expect(mockCheck.mock.calls.length - before).toBe(1);
  });

  it("shows nothing when the permissions are in place", async () => {
    mockCheck.mockResolvedValue(report({}));
    const html = await (await harness.get("/settings")).text();
    expect(html).not.toContain("data-permission-notice");
  });

  it("says the check could not run, with the reason", async () => {
    mockCheck.mockResolvedValue(
      report({ available: false, reason: "The bot is not connected." }),
    );
    const html = await (await harness.get("/settings")).text();
    expect(section(html, "welcome")).toContain(
      "Bot permissions could not be checked",
    );
    expect(section(html, "core")).toContain("The bot is not connected.");
    expect(section(html, "lfg")).not.toContain("data-permission-notice");
  });

  it("labels a cached read as possibly out of date", async () => {
    mockCheck.mockResolvedValue({ ...missing, fresh: false });
    const html = await (await harness.get("/settings")).text();
    expect(section(html, "welcome")).toContain("may be out of date");
  });

  it("adds nothing while the stored config cannot be read", async () => {
    storedReadFails = true;
    mockCheck.mockResolvedValue(missing);
    const res = await harness.get("/settings");
    expect(res.status).toBe(200);
    expect(await res.text()).not.toContain("data-permission-notice");
  });
});
