/**
 * The permission notice on the Moderation page (#1488): raid alerts and the
 * moderation log channels only. The notice logic is in
 * `permission-notice.test.ts`; this covers the page wiring (route and view).
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
import type {
  BotPermissionReport,
  FeatureCheck,
} from "../../src/services/bot-permission-check.js";

jest.unstable_mockModule("../../src/utils/logger.js", () => ({
  default: {
    info: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
    debug: jest.fn(),
  },
  isDebugMode: jest.fn(() => false),
}));

let moderationOn = true;
jest.unstable_mockModule("../../src/services/config-service.js", () => ({
  ConfigService: {
    getInstance: (): unknown => ({
      getBoolean: jest.fn(async () => moderationOn),
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

const { ModerationService } =
  await import("../../src/services/moderation-service.js");
const { ModerationCaseService } =
  await import("../../src/services/moderation-case-service.js");
const { createReadOnlyRouter } =
  await import("../../src/web/read-only-routes.js");
const { renderModerationPage } = await import("../../src/web/admin-views.js");
const { buildPermissionNotice, inFeatures } =
  await import("../../src/web/permission-notice.js");

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

function ref(id: string): FeatureCheck["feature"] {
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

function check(id: string, over: Partial<FeatureCheck> = {}): FeatureCheck {
  return {
    feature: ref(id),
    kind: "permission",
    enabled: true,
    outcome: "missing",
    target: { kind: "channel", id: "c1", name: "mod-alerts" },
    missing: ["Send Messages"],
    ...over,
  } as FeatureCheck;
}

const session = createTestSession();
let harness: AdminHarness;

beforeEach(async () => {
  jest.clearAllMocks();
  moderationOn = true;
  jest.spyOn(ModerationService, "getInstance").mockReturnValue({
    countRecent: jest.fn(async () => 0),
    getRecent: jest.fn(async () => []),
    getHistory: jest.fn(async () => []),
  } as never);
  jest.spyOn(ModerationCaseService, "getInstance").mockReturnValue({
    isEnabled: jest.fn(async () => false),
  } as never);
  harness = await startAdminHarness([
    createReadOnlyRouter(client, stubRequireSession(session)),
  ]);
});

afterEach(async () => {
  jest.restoreAllMocks();
  await harness.close();
});

describe("GET /moderation", () => {
  it("names the permission and channel for raid alerts and the moderation log channels", async () => {
    mockCheck.mockResolvedValue(
      report({
        checks: [
          check("raid-alerts"),
          check("log-moderation", {
            target: { kind: "channel", id: "c2", name: "mod-log" },
            missing: ["Embed Links"],
          }),
          check("log-moderation-review", {
            target: { kind: "channel", id: "c3", name: "mod-review" },
            missing: ["View Channel"],
          }),
        ],
      }),
    );
    const html = await (await harness.get("/moderation")).text();
    expect(html).toContain("data-permission-notice");
    expect(html).toContain("Anti-raid alerts");
    expect(html).toContain("in the channel “mod-alerts”");
    expect(html).toContain("<strong>Embed Links</strong>");
    expect(html).toContain("in the channel “mod-log”");
    expect(html).toContain("in the channel “mod-review”");
    expect(html).toContain('href="/admin/bot-permissions"');
  });

  it("leaves out the other log channels and other areas", async () => {
    mockCheck.mockResolvedValue(
      report({
        checks: [
          check("log-config"),
          check("log-errors"),
          check("event-channels"),
        ],
      }),
    );
    const html = await (await harness.get("/moderation")).text();
    expect(html).not.toContain("data-permission-notice");
  });

  it("shows nothing when the permissions are in place", async () => {
    mockCheck.mockResolvedValue(
      report({
        checks: [check("raid-alerts", { outcome: "ok", missing: [] })],
      }),
    );
    const html = await (await harness.get("/moderation")).text();
    expect(html).not.toContain("data-permission-notice");
  });

  it("shows nothing for a feature that is off or has no channel set", async () => {
    mockCheck.mockResolvedValue(
      report({
        checks: [
          check("raid-alerts", { enabled: false }),
          check("log-moderation", { target: null }),
        ],
      }),
    );
    const html = await (await harness.get("/moderation")).text();
    expect(html).not.toContain("data-permission-notice");
  });

  it("says the check could not run, with the reason", async () => {
    mockCheck.mockResolvedValue(
      report({ available: false, reason: "The bot is not connected." }),
    );
    const html = await (await harness.get("/moderation")).text();
    expect(html).toContain("Bot permissions could not be checked");
    expect(html).toContain("The bot is not connected.");
  });

  it("reports a channel that could not be checked", async () => {
    mockCheck.mockResolvedValue(
      report({
        checks: [check("raid-alerts", { outcome: "unknown", missing: [] })],
        unknown: [
          {
            feature: ref("raid-alerts"),
            target: { kind: "channel", id: "c1", name: "mod-alerts" },
            note: "The configured channel could not be found.",
          },
        ],
      }),
    );
    const html = await (await harness.get("/moderation")).text();
    expect(html).toContain("Some bot permissions could not be checked");
    expect(html).toContain("The configured channel could not be found.");
  });

  it("labels a read from the bot's cache as possibly out of date", async () => {
    mockCheck.mockResolvedValue(
      report({ fresh: false, checks: [check("raid-alerts")] }),
    );
    const html = await (await harness.get("/moderation")).text();
    expect(html).toContain("may be out of date");
  });

  it("does not run the check while moderation is off", async () => {
    moderationOn = false;
    mockCheck.mockResolvedValue(report({ checks: [check("raid-alerts")] }));
    const html = await (await harness.get("/moderation")).text();
    expect(html).not.toContain("data-permission-notice");
    // The navigation badge's own warm-up may call it; the page's must not.
    expect(mockCheck.mock.calls.length).toBeLessThanOrEqual(1);
  });
});

describe("renderModerationPage permission notice", () => {
  const props = {
    csrfToken: "t",
    remainingMs: 60_000,
    enabled: true,
    actionOptions: ["kick" as const],
    userOptions: [],
    filters: { action: "", userId: "" },
    rows: [],
    total: 0,
    page: 1,
    pageSize: 50,
  };
  const notice = buildPermissionNotice(
    report({ checks: [check("raid-alerts")] }),
    {
      enabled: true,
      filter: inFeatures("raid-alerts"),
    },
  );

  it("places the notice under the status line", () => {
    const html = renderModerationPage({ ...props, permissionNotice: notice });
    const status = html.indexOf("kb-statusline");
    const at = html.indexOf("data-permission-notice");
    expect(status).toBeGreaterThan(-1);
    expect(at).toBeGreaterThan(status);
    expect(at).toBeLessThan(html.indexOf("View Audit Log"));
  });

  it("renders nothing without a notice", () => {
    const html = renderModerationPage({ ...props, permissionNotice: null });
    expect(html).not.toContain("data-permission-notice");
    expect(renderModerationPage(props)).not.toContain("data-permission-notice");
  });

  it("escapes channel names", () => {
    const n = buildPermissionNotice(
      report({
        checks: [
          check("raid-alerts", {
            target: { kind: "channel", id: "c", name: "<script>x</script>" },
          }),
        ],
      }),
      { enabled: true, filter: inFeatures("raid-alerts") },
    );
    const html = renderModerationPage({ ...props, permissionNotice: n });
    expect(html).not.toContain("<script>x</script>");
    expect(html).toContain("&lt;script&gt;");
  });
});
