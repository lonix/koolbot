/**
 * GET /admin/reaction-roles, /admin/role-groups and /admin/leaderboard-roles
 * (#1490): each page shows only its own registry area's findings (from the
 * shared check, no call of its own), only while the feature is in use, names a
 * role rather than a channel for a role-position finding, and says so when the
 * check cannot run or cannot read the roles.
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

// The role groups page loads its data in one call; only the group count matters here.
let groupCount = 1;
const actualRoleGroupsPage = await import("../../src/web/role-groups-page.js");
jest.unstable_mockModule("../../src/web/role-groups-page.js", () => ({
  ...actualRoleGroupsPage,
  loadRoleGroupsPage: jest.fn(async () => ({
    groups: Array.from({ length: groupCount }, (_, i) => ({
      id: `g${i}`,
      name: `Group ${i}`,
      roleId: null,
      rank: i,
      permissions: "0",
      capabilities: [],
      colour: null,
      hoist: false,
      createdByKoolbot: false,
      gateOnly: false,
      createdAt: new Date("2026-01-01T00:00:00Z"),
      roleName: null,
      unlinked: false,
      lostRoleId: null,
      recreateRequestedAt: null,
      syncPolicy: null,
      driftSignature: null,
      roleMissing: false,
      memberCount: null,
      roleLock: null,
      drift: [],
    })),
    roleOptions: [],
    plan: null,
    extraErrors: [],
    planUnavailable: null,
    botScanUnavailable: false,
    botsMissing: 0,
    adminReport: null,
    adminGroupLacksAdministrator: false,
    membersUnavailable: false,
    roleNames: {},
    globalPolicy: "flag",
  })),
}));

const registry = await import("../../src/services/bot-permission-registry.js");
const actualCheck = await import("../../src/services/bot-permission-check.js");
const mockCheck =
  jest.fn<(client: unknown, guildId: string) => Promise<BotPermissionReport>>();
jest.unstable_mockModule("../../src/services/bot-permission-check.js", () => ({
  ...actualCheck,
  checkBotPermissions: mockCheck,
}));

const { ReactionRoleService } =
  await import("../../src/services/reaction-role-service.js");
const { ReactionRoleConfig } =
  await import("../../src/models/reaction-role-config.js");
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
  const effect = "effect" in r ? r.effect : "";
  return { id: r.id, area: r.area, feature: r.feature, effect, fix: r.fix };
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

const server = { kind: "server" as const, id: null, name: "the server" };
const roleTarget = (id: string, name: string) => ({
  kind: "role" as const,
  id,
  name,
});

interface PageCase {
  path: string;
  area: string;
  /** The page's findings: [check, text the notice must show]. */
  own: [FeatureCheck, string[]][];
  /** Findings of other areas, which must stay off this page. */
  others: FeatureCheck[];
  /** A check of this page with no target (the page says "not set" itself). */
  untargeted: FeatureCheck;
}

const pages: PageCase[] = [
  {
    path: "/reaction-roles",
    area: "Reaction roles",
    own: [
      [
        check("reaction-picker-post", {
          target: { kind: "channel", id: "c1", name: "pick-a-role" },
          missing: ["Embed Links"],
        }),
        ["in the channel “pick-a-role”", "<strong>Embed Links</strong>"],
      ],
      [
        check("reaction-roles", { target: server, missing: ["Manage Roles"] }),
        ["<strong>Manage Roles</strong> server-wide"],
      ],
    ],
    others: [
      check("leaderboard-roles", { target: server, missing: ["Manage Roles"] }),
      check("rules-message", {
        target: { kind: "channel", id: "c9", name: "rules-elsewhere" },
      }),
    ],
    untargeted: check("reaction-picker-post", {
      outcome: "unknown",
      target: null,
      missing: [],
    }),
  },
  {
    path: "/leaderboard-roles",
    area: "Leaderboard roles",
    own: [
      [
        check("leaderboard-announce", {
          target: { kind: "channel", id: "c1", name: "ranking" },
          missing: ["Embed Links"],
        }),
        ["in the channel “ranking”"],
      ],
      [
        check("leaderboard-roles", {
          target: server,
          missing: ["Manage Roles"],
        }),
        ["<strong>Manage Roles</strong> server-wide"],
      ],
      [
        check("leaderboard-roles-hierarchy", {
          kind: "role-position",
          target: roleTarget("r1", "Top Voice"),
          missing: ["Bot role below this role"],
        }),
        [
          "for the role “Top Voice”",
          "<strong>Bot role below this role</strong>",
        ],
      ],
    ],
    others: [
      check("reaction-roles", { target: server, missing: ["Manage Roles"] }),
      check("rules-role", { target: server, missing: ["Manage Roles"] }),
    ],
    untargeted: check("leaderboard-announce", {
      outcome: "unknown",
      target: null,
      missing: [],
    }),
  },
  {
    path: "/role-groups",
    area: "Role groups",
    own: [
      [
        check("role-groups", { target: server, missing: ["Manage Roles"] }),
        ["<strong>Manage Roles</strong> server-wide"],
      ],
      [
        check("log-role-groups", {
          target: { kind: "channel", id: "c2", name: "role-log" },
          missing: ["View Channel"],
        }),
        ["in the channel “role-log”"],
      ],
    ],
    others: [
      check("log-errors", {
        target: { kind: "channel", id: "c3", name: "error-log" },
      }),
      check("reaction-roles", { target: server, missing: ["Manage Roles"] }),
    ],
    untargeted: check("log-role-groups", {
      outcome: "unknown",
      target: null,
      missing: [],
    }),
  },
];

const session = createTestSession();
let harness: AdminHarness;

beforeEach(async () => {
  jest.clearAllMocks();
  featuresOn = true;
  groupCount = 1;
  jest.spyOn(ReactionRoleService, "getInstance").mockReturnValue({
    listReactionRoles: jest.fn(async () => []),
  } as never);
  // Both models inherit `find` from mongoose's Model, so one spy serves both
  // pages: the reaction-role archive chain and the leaderboard roster read.
  const rows = { lean: async () => [] };
  jest.spyOn(ReactionRoleConfig, "find").mockReturnValue({
    sort: () => ({ limit: () => rows }),
    ...rows,
  } as never);
  harness = await startAdminHarness([
    createReadOnlyRouter(client, stubRequireSession(session)),
  ]);
});

afterEach(async () => {
  jest.restoreAllMocks();
  await harness.close();
});

describe.each(pages)("GET $path", (page) => {
  it("names the permission and the channel or role for each of its own findings", async () => {
    mockCheck.mockResolvedValue(report({ checks: page.own.map(([c]) => c) }));
    const html = await (await harness.get(page.path)).text();
    expect(html).toContain("data-permission-notice");
    for (const [, texts] of page.own) {
      for (const t of texts) expect(html).toContain(t);
    }
    expect(html).toContain('href="/admin/bot-permissions"');
  });

  it("leaves out the findings of other areas", async () => {
    mockCheck.mockResolvedValue(report({ checks: page.others }));
    const html = await (await harness.get(page.path)).text();
    expect(html).not.toContain("data-permission-notice");
    mockCheck.mockResolvedValue(
      report({ checks: [...page.others, page.own[0][0]] }),
    );
    const mixed = await (await harness.get(page.path)).text();
    for (const o of page.others) {
      if (o.target) expect(mixed).not.toContain(`“${o.target.name}”`);
    }
  });

  it("shows nothing when the permissions are in place", async () => {
    mockCheck.mockResolvedValue(
      report({
        checks: page.own.map(([c]) => ({
          ...c,
          outcome: "ok",
          missing: [],
        })),
      }),
    );
    const html = await (await harness.get(page.path)).text();
    expect(html).not.toContain("data-permission-notice");
  });

  it("says the check could not run, with the reason", async () => {
    mockCheck.mockResolvedValue(
      report({ available: false, reason: "The bot is not connected." }),
    );
    const html = await (await harness.get(page.path)).text();
    expect(html).toContain("Bot permissions could not be checked");
    expect(html).toContain("The bot is not connected.");
  });

  it("labels a read from the bot's cache as possibly out of date", async () => {
    mockCheck.mockResolvedValue(
      report({ fresh: false, checks: page.own.map(([c]) => c) }),
    );
    const html = await (await harness.get(page.path)).text();
    expect(html).toContain("may be out of date");
  });

  it("shows nothing for a target that is not set (the check reports no target)", async () => {
    mockCheck.mockResolvedValue(report({ checks: [page.untargeted] }));
    const html = await (await harness.get(page.path)).text();
    expect(html).not.toContain("data-permission-notice");
  });

  it("does not show a finding of a feature that is off", async () => {
    mockCheck.mockResolvedValue(
      report({ checks: page.own.map(([c]) => ({ ...c, enabled: false })) }),
    );
    const html = await (await harness.get(page.path)).text();
    expect(html).not.toContain("data-permission-notice");
  });
});

describe.each(pages.filter((p) => p.path !== "/role-groups"))(
  "GET $path while the feature is off",
  (page) => {
    it("does not run the check or show a notice", async () => {
      featuresOn = false;
      mockCheck.mockResolvedValue(report({ checks: page.own.map(([c]) => c) }));
      const html = await (await harness.get(page.path)).text();
      expect(html).not.toContain("data-permission-notice");
      // The navigation badge's own warm-up may call it; the page's must not.
      expect(mockCheck.mock.calls.length).toBeLessThanOrEqual(1);
    });
  },
);

describe("GET /role-groups without groups", () => {
  it("shows nothing, not even when the check is unavailable (role groups are optional)", async () => {
    groupCount = 0;
    mockCheck.mockResolvedValue(
      report({ available: false, reason: "The bot is not connected." }),
    );
    const html = await (await harness.get("/role-groups")).text();
    expect(html).not.toContain("data-permission-notice");
  });
});

describe("GET /leaderboard-roles hierarchy", () => {
  it("lists a role the bot's position could not be read for as could not be checked, with its note", async () => {
    mockCheck.mockResolvedValue(
      report({
        checks: [
          check("leaderboard-roles-hierarchy", {
            kind: "role-position",
            outcome: "unknown",
            target: roleTarget("r1", "Top Voice"),
            missing: [],
          }),
        ],
        unknown: [
          {
            feature: ref("leaderboard-roles-hierarchy"),
            target: roleTarget("r1", "Top Voice"),
            note: "The bot's own roles could not be read.",
          },
        ],
      }),
    );
    const html = await (await harness.get("/leaderboard-roles")).text();
    expect(html).toContain("Some bot permissions could not be checked");
    expect(html).toContain("The bot&#39;s own roles could not be read.");
    expect(html).not.toContain("is missing a Discord permission");
  });
});
