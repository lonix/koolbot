/**
 * GET /admin/events and GET /admin/voice-channels (#1253): the page shows the
 * missing permission from the registry's check, only while the feature is on,
 * and says so when the check cannot run.
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
      feature: ref("event-channels"),
      kind: "permission",
      enabled: true,
      outcome: "missing",
      target: { kind: "category", id: "c1", name: "Events" },
      missing: ["Manage Channels"],
    },
    {
      feature: ref("voice-rooms"),
      kind: "permission",
      enabled: true,
      outcome: "missing",
      target: { kind: "category", id: "v1", name: "Voice" },
      missing: ["Move Members"],
    },
  ],
});

const session = createTestSession();
let harness: AdminHarness;

beforeEach(async () => {
  jest.clearAllMocks();
  featuresOn = true;
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

describe.each([
  [
    "/events",
    "event features",
    // The inline form names the permission, not the feature: the field says which.
    "Bot lacks Manage Channels",
    "Events",
    // Group channels belong to the Groups switch (#1478), so the finding sits there.
    'data-permission-inline="event-channels"',
  ],
  [
    "/voice-channels",
    "voice features",
    "Temporary voice rooms",
    "Voice",
    "data-permission-notice",
  ],
])("GET %s", (path, _name, featureName, category, marker) => {
  it("shows the missing permission with the channel category named", async () => {
    mockCheck.mockResolvedValue(missing);
    const html = await (await harness.get(path)).text();
    expect(html).toContain(marker);
    expect(html).toContain(featureName);
    expect(html).toContain(`in the category “${category}”`);
    expect(html).toContain('href="/admin/bot-permissions"');
  });

  it("shows nothing when the permissions are in place", async () => {
    mockCheck.mockResolvedValue(report({}));
    const html = await (await harness.get(path)).text();
    expect(html).not.toContain("data-permission-notice");
    expect(html).not.toContain("data-permission-inline");
  });

  it("says the check could not run, rather than staying quiet", async () => {
    mockCheck.mockResolvedValue(
      report({ available: false, reason: "The bot is not connected." }),
    );
    const html = await (await harness.get(path)).text();
    expect(html).toContain("Bot permissions could not be checked");
    expect(html).toContain("The bot is not connected.");
  });

  it("does not run the check while the feature is off", async () => {
    featuresOn = false;
    mockCheck.mockResolvedValue(missing);
    const html = await (await harness.get(path)).text();
    expect(html).not.toContain("data-permission-notice");
    expect(html).not.toContain("data-permission-inline");
    // The navigation badge's own warm-up may call it; the page's must not.
    const pageCalls = mockCheck.mock.calls.length;
    expect(pageCalls).toBeLessThanOrEqual(1);
  });
});
