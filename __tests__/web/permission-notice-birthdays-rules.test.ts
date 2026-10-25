/**
 * GET /admin/birthdays and GET /admin/rules (#1491): each page shows only its
 * own registry area's findings (from the shared check, no call of its own),
 * only while the feature is on, and says so when the check cannot run. The
 * notice logic is in `permission-notice.test.ts`; this covers the wiring.
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

const { BirthdayService } =
  await import("../../src/services/birthday-service.js");
const { RulesAcceptance } =
  await import("../../src/models/rules-acceptance.js");
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

type Ref = FeatureCheck["feature"];

function ref(id: string): Ref {
  const r =
    registry.FEATURE_REQUIREMENTS.find((x) => x.id === id) ??
    registry.ROLE_HIERARCHY_REQUIREMENTS.find((x) => x.id === id);
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
    target: { kind: "channel", id: "c1", name: "somewhere" },
    missing: ["Send Messages"],
    ...over,
  } as FeatureCheck;
}

const missing = report({
  checks: [
    check("birthdays-post", {
      target: { kind: "channel", id: "b1", name: "birthday-wall" },
    }),
    check("rules-message", {
      target: { kind: "channel", id: "r1", name: "the-rules" },
      missing: ["Read Message History"],
    }),
    check("rules-role", {
      target: { kind: "server", id: null, name: "this server" },
      missing: ["Manage Roles"],
    }),
    check("quotes-post", {
      target: { kind: "channel", id: "q1", name: "quote-wall" },
    }),
  ],
});

const session = createTestSession();
let harness: AdminHarness;

beforeEach(async () => {
  jest.clearAllMocks();
  featuresOn = true;
  jest.spyOn(BirthdayService, "getInstance").mockReturnValue({
    listBirthdays: jest.fn(async () => []),
  } as never);
  jest.spyOn(RulesAcceptance, "countDocuments").mockResolvedValue(0 as never);
  harness = await startAdminHarness([
    createReadOnlyRouter(client, stubRequireSession(session)),
  ]);
});

afterEach(async () => {
  jest.restoreAllMocks();
  await harness.close();
});

describe.each([
  ["/birthdays", "Birthdays", "birthday-wall", ["the-rules", "quote-wall"]],
  ["/rules", "Rules", "the-rules", ["birthday-wall", "quote-wall"]],
])("GET %s", (path, area, ownChannel, others) => {
  it(`shows only the ${area} findings, naming the permission and where`, async () => {
    mockCheck.mockResolvedValue(missing);
    const html = await (await harness.get(path)).text();
    expect(html).toContain("data-permission-notice");
    expect(html).toContain(`in the channel “${ownChannel}”`);
    for (const other of others) {
      if (area === "Rules" && other === "the-rules") continue;
      expect(html).not.toContain(`“${other}”`);
    }
    expect(html).toContain('href="/admin/bot-permissions"');
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
          check(area === "Rules" ? "rules-message" : "birthdays-post", {
            outcome: "unknown",
            target: null,
            missing: [],
          }),
        ],
      }),
    );
    const html = await (await harness.get(path)).text();
    expect(html).not.toContain("data-permission-notice");
  });
});

describe("GET /rules: the acceptance role", () => {
  it("names the role-position finding and the server-wide Manage Roles", async () => {
    mockCheck.mockResolvedValue(
      report({
        checks: [
          check("rules-role", {
            target: { kind: "server", id: null, name: "this server" },
            missing: ["Manage Roles"],
          }),
          check("rules-role-hierarchy", {
            kind: "role-position",
            target: { kind: "role", id: "r9", name: "Accepted" },
            missing: ["a role below the bot's own"],
          }),
        ],
      }),
    );
    const html = await (await harness.get("/rules")).text();
    expect(html).toContain("server-wide");
    expect(html).toContain("for the role “Accepted”");
  });

  it("lists an unreadable hierarchy as could not be checked, with its note", async () => {
    mockCheck.mockResolvedValue(
      report({
        checks: [
          check("rules-role-hierarchy", {
            kind: "role-position",
            outcome: "unknown",
            target: { kind: "role", id: "r9", name: "r9" },
            missing: [],
          }),
        ],
        unknown: [
          {
            feature: ref("rules-role-hierarchy"),
            target: { kind: "role", id: "r9", name: "r9" },
            note: "The configured role could not be found.",
          },
        ],
      }),
    );
    const html = await (await harness.get("/rules")).text();
    expect(html).toContain("Some bot permissions could not be checked");
    expect(html).toContain("The configured role could not be found.");
  });

  it("leaves the markup as it was when there is no notice (no stray blank line)", async () => {
    mockCheck.mockResolvedValue(report({}));
    const html = await (await harness.get("/rules")).text();
    expect(html).not.toMatch(/<\/div>\n\n<div class="card">\n {2}<h2>Re-post/);
  });
});

describe("registry ids the pages rely on", () => {
  it("are in the areas the pages filter by", () => {
    expect(ref("birthdays-post").area).toBe("Birthdays");
    for (const id of ["rules-message", "rules-role", "rules-role-hierarchy"]) {
      expect(ref(id).area).toBe("Rules");
    }
  });
  it("birthdays and rules channels are required, not optional", () => {
    for (const id of ["birthdays-post", "rules-message"]) {
      const r = registry.FEATURE_REQUIREMENTS.find((x) => x.id === id);
      expect(r?.targetOptional).toBeUndefined();
    }
  });
});
