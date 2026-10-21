/**
 * The moderator's pages over real HTTP (#1320): `/me/moderation`,
 * `/me/moderation/cases/:id` and `/me/moderation/audit`.
 *
 * The real router, the real `requireScopeMiddleware("moderator")` guard, CSRF,
 * `decideCase` and the page renderers run; the services, models and audit
 * write are stubbed. `me-scope-guards.test.ts` covers the mount in
 * `createUserRouter`, and `admin-scope-refusal.test.ts` the refusal of every
 * `/admin` route for a session that holds the moderator scope.
 */
import {
  describe,
  it,
  expect,
  jest,
  beforeAll,
  beforeEach,
  afterAll,
} from "@jest/globals";
import {
  startAdminHarness,
  createTestSession,
  parseFlashRedirect,
  TEST_CSRF_TOKEN,
  type AdminHarness,
} from "./admin-harness.js";
import type { WebSessionContext } from "../../src/web/session.js";

process.env.WEBUI_SESSION_SECRET = "test-secret-for-me-moderation";

type Fn = (...args: unknown[]) => unknown;
const fn = <T extends Fn>(impl?: T): jest.Mock<T> =>
  jest.fn<T>(impl as never) as jest.Mock<T>;

const mockRecordAudit = jest.fn<(...args: unknown[]) => Promise<undefined>>(
  async () => undefined,
);
const config: Record<string, boolean> = {};
const moderation = {
  countRecent: fn(),
  getRecent: fn(),
  getHistory: fn(),
};
const cases = {
  isEnabledStrict: fn(),
  countLiveCases: fn(),
  countOverdueCases: fn(),
  getQueue: fn(),
  getCasesForEntries: fn(),
  getDefaultReviewDays: fn(),
  findCase: fn(),
  getOriginEntries: fn(),
  decide: fn(),
};
const roleGroups = { list: fn() };
const auditFind = fn();
const auditCount = fn();

jest.unstable_mockModule("../../src/web/audit.js", () => ({
  recordAudit: mockRecordAudit,
  boundAuditEntry: (e: unknown) => e,
}));
jest.unstable_mockModule("../../src/utils/logger.js", () => ({
  default: {
    info: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
    debug: jest.fn(),
  },
}));
jest.unstable_mockModule("../../src/services/config-service.js", () => ({
  ConfigService: {
    getInstance: (): unknown => ({
      getBoolean: async (key: string, fallback: boolean) =>
        key in config ? config[key] : fallback,
      getBooleanStrict: async (key: string, fallback: boolean) =>
        key in config ? config[key] : fallback,
      getNumber: async (_key: string, fallback: number) => fallback,
      getString: async () => "",
    }),
  },
}));
jest.unstable_mockModule("../../src/services/moderation-service.js", () => ({
  ModerationService: { getInstance: (): unknown => moderation },
}));
const actualCases =
  await import("../../src/services/moderation-case-service.js");
jest.unstable_mockModule(
  "../../src/services/moderation-case-service.js",
  () => ({
    ...actualCases,
    ModerationCaseService: { getInstance: (): unknown => cases },
  }),
);
jest.unstable_mockModule("../../src/services/role-group-service.js", () => ({
  RoleGroupService: { getInstance: (): unknown => roleGroups },
}));
jest.unstable_mockModule(
  "../../src/models/discord-command-audit-log.js",
  () => ({
    DiscordCommandAuditLog: {
      countDocuments: auditCount,
      find: auditFind,
    },
  }),
);
// The admin read-only router is heavy and not what is under test; only the
// channel-name lookup the audit page shares is needed.
jest.unstable_mockModule("../../src/web/read-only-routes.js", () => ({
  fetchChannelData: async () => ({
    names: new Map([["c-1", "general"]]),
  }),
}));

const { createMeModerationRouter } =
  await import("../../src/web/routes/me-moderation.js");
const { requireScopeMiddleware } = await import("../../src/web/session.js");

const GUILD = "guild-1";
const MOD = "111111111111111111";

interface FakeMember {
  displayName: string;
  user: { username: string };
  roles: { cache: Set<string> };
  communicationDisabledUntilTimestamp: number | null;
}

const member = (
  name: string,
  roles: string[] = [],
  until: number | null = null,
): FakeMember => ({
  displayName: name,
  user: { username: name },
  roles: { cache: new Set(roles) },
  communicationDisabledUntilTimestamp: until,
});

let members = new Map<string, FakeMember>();
let memberCount: number | null = null;
const client = {
  commands: new Map([["warn", {}]]),
  guilds: {
    fetch: async () => ({
      get memberCount(): number {
        return memberCount ?? members.size;
      },
      members: {
        cache: {
          get size(): number {
            return members.size;
          },
          get: (id: string) => members.get(id),
          values: () => members.values(),
        },
        fetch: async () => new Map(),
      },
    }),
  },
};

let current: WebSessionContext;
let harness: AdminHarness;

beforeAll(async () => {
  harness = await startAdminHarness(
    [
      (req, _res, next): void => {
        Object.assign(req, { webSession: current, csrfToken: TEST_CSRF_TOKEN });
        next();
      },
      requireScopeMiddleware("moderator"),
      createMeModerationRouter(client as never),
    ],
    "/me/moderation",
  );
});

afterAll(async () => {
  await harness.close();
});

const as = (
  role: "user" | "admin",
  scopes: WebSessionContext["scopes"],
  userId = MOD,
): void => {
  current = createTestSession({
    discordUserId: userId,
    guildId: GUILD,
    role,
    scopes,
  });
};

const asModerator = (): void => as("user", ["member", "moderator"]);

const liveCase = (
  over: Record<string, unknown> = {},
): Record<string, unknown> => ({
  _id: "case-1",
  caseNumber: 7,
  userId: "u-bad",
  action: "ban",
  status: "open",
  reviewAt: new Date(Date.now() + 30 * 86_400_000),
  openedAt: new Date("2026-01-02T10:00:00Z"),
  originEntryId: "entry-1",
  originModeratorId: MOD,
  openedByUserId: MOD,
  events: [],
  ...over,
});

const logRow = (
  over: Record<string, unknown> = {},
): Record<string, unknown> => ({
  _id: "entry-1",
  guildId: GUILD,
  userId: "u-bad",
  moderatorId: MOD,
  action: "ban",
  reason: "spam",
  source: "audit",
  createdAt: new Date("2026-01-01T10:00:00Z"),
  ...over,
});

beforeEach(() => {
  jest.clearAllMocks();
  for (const key of Object.keys(config)) delete config[key];
  config["moderation.enabled"] = true;
  members = new Map([
    [MOD, member("Mod Mia")],
    ["u-bad", member("Bad Ben")],
  ]);
  delete process.env.GUILD_MEMBERS_INTENT;
  memberCount = null;
  asModerator();
  moderation.countRecent.mockImplementation(async (...args: unknown[]) => {
    const q = args[1] as { since?: Date };
    return q.since ? 4 : 12;
  });
  moderation.getRecent.mockResolvedValue([logRow()]);
  moderation.getHistory.mockResolvedValue([]);
  cases.isEnabledStrict.mockResolvedValue(true);
  cases.countLiveCases.mockResolvedValue(3);
  cases.countOverdueCases.mockResolvedValue(1);
  cases.getQueue.mockResolvedValue({
    overdue: [
      liveCase({
        _id: "case-2",
        caseNumber: 8,
        reviewAt: new Date(Date.now() - 86_400_000),
      }),
    ],
    dueSoon: [],
    scheduled: [liveCase()],
    indefinite: [],
    recentlyResolved: [],
  });
  cases.getCasesForEntries.mockResolvedValue(
    new Map([["entry-1", liveCase()]]),
  );
  cases.getDefaultReviewDays.mockResolvedValue(90);
  cases.getOriginEntries.mockResolvedValue(new Map());
  cases.findCase.mockResolvedValue(liveCase());
  cases.decide.mockResolvedValue({
    caseNumber: 7,
    status: "open",
    reviewAt: null,
  });
  roleGroups.list.mockResolvedValue([
    { id: "g1", name: "Mods", roleId: "r-mod", capabilities: ["staff"] },
    { id: "g2", name: "Hosts", roleId: "r-host", capabilities: ["host"] },
  ]);
  members.set(MOD, member("Mod Mia", ["r-mod"]));
  auditCount.mockReturnValue(Promise.resolve(1));
  auditFind.mockReturnValue({
    sort: () => ({
      skip: () => ({
        limit: () => ({
          lean: () =>
            Promise.resolve([
              {
                createdAt: new Date("2026-01-03T09:30:00Z"),
                discordUserId: MOD,
                commandName: "warn",
                subcommand: null,
                channelId: "c-1",
                result: "success",
                errorMessage: null,
                durationMs: 12,
              },
            ]),
        }),
      }),
    }),
  });
});

async function html(path: string): Promise<string> {
  const res = await harness.get(path);
  expect(res.status).toBe(200);
  return res.text();
}

describe("access", () => {
  it.each([
    ["a member only", "user", ["member"]],
    ["a host only", "user", ["member", "host"]],
  ] as const)(
    "refuses %s on every path and writes nothing",
    async (_n, role, scopes) => {
      as(role, [...scopes]);
      for (const path of ["/", "/audit", "/cases/case-1"]) {
        expect((await harness.get(path)).status).toBe(403);
      }
      for (const decision of ["uphold", "extend", "permanent", "readmit"]) {
        expect(
          (await harness.post(`/cases/case-1/${decision}`, {})).status,
        ).toBe(403);
      }
      expect((await harness.post("/audit", {})).status).toBe(403);
      expect(cases.decide).not.toHaveBeenCalled();
      expect(mockRecordAudit).not.toHaveBeenCalled();
      expect(moderation.getRecent).not.toHaveBeenCalled();
    },
  );

  it.each([
    ["a moderator", "user", ["member", "moderator"]],
    ["an admin session", "admin", ["member"]],
  ] as const)("lets %s read all three pages", async (_n, role, scopes) => {
    as(role, [...scopes]);
    for (const path of ["/", "/audit", "/cases/case-1"]) {
      expect((await harness.get(path)).status).toBe(200);
    }
  });

  it("links nowhere under /admin for a moderator, on every page", async () => {
    for (const path of ["/", "/audit", "/cases/case-1"]) {
      expect((await html(path)).includes("/admin")).toBe(false);
    }
  });

  it("renders no settings form and no open-case or run-review control", async () => {
    for (const path of ["/", "/audit", "/cases/case-1"]) {
      const page = await html(path);
      expect(page.includes("run-review")).toBe(false);
      expect(page.includes("cases/open")).toBe(false);
      expect(page.includes("settings")).toBe(false);
    }
  });
});

describe("header", () => {
  it("names the role group that gives the moderator the page", async () => {
    const page = await html("/");
    expect(page.includes("You see it because you are in")).toBe(true);
    expect(page.includes('<span class="kb-mention">@Mods</span>')).toBe(true);
    expect(page.includes("@Hosts")).toBe(false);
  });

  it("falls back to the capability label when no group can be named", async () => {
    roleGroups.list.mockRejectedValue(new Error("db down"));
    const page = await html("/");
    expect(page.includes('<span class="kb-mention">@Moderator</span>')).toBe(
      true,
    );
  });

  it("does not claim group membership for an admin session", async () => {
    as("admin", ["member"]);
    const page = await html("/");
    expect(page.includes("you are a server administrator")).toBe(true);
    expect(page.includes("@Moderator")).toBe(false);
  });
});

describe("tiles", () => {
  it("counts open cases, the last seven days and running timeouts", async () => {
    process.env.GUILD_MEMBERS_INTENT = "true";
    members.set("u-t1", member("T1", [], Date.now() + 60_000));
    members.set("u-t2", member("T2", [], Date.now() - 60_000));
    members.set("u-t3", member("T3", [], Date.now() + 3_600_000));
    const page = await html("/");
    const tile = (label: string, value: string): string =>
      `<span class="kb-overline">${label}</span></div>\n  <div class="kb-tile__value">${value}</div>`;
    expect(page.includes(tile("Open cases", "3"))).toBe(true);
    expect(page.includes(tile("Actions, last 7 days", "4"))).toBe(true);
    expect(page.includes(tile("Timeouts running now", "2"))).toBe(true);
    expect(page.includes("1 due for review")).toBe(true);
    // The seven-day count is bounded by `since`, the open count is uncapped.
    const sinceCall = moderation.countRecent.mock.calls.find(
      (c) => (c[1] as { since?: Date }).since,
    );
    expect(sinceCall).toBeDefined();
    expect(cases.countLiveCases).toHaveBeenCalledWith(GUILD);
  });

  it("shows a dash while the member cache is incomplete, even with the intent", async () => {
    process.env.GUILD_MEMBERS_INTENT = "true";
    members.set("u-t1", member("T1", [], Date.now() + 60_000));
    memberCount = members.size + 40;
    const page = await html("/");
    expect(
      page.includes(
        '<span class="kb-overline">Timeouts running now</span></div>\n  <div class="kb-tile__value">—</div>',
      ),
    ).toBe(true);
  });

  it("says the timeout count is unknown without the Server Members intent", async () => {
    const page = await html("/");
    expect(
      page.includes(
        "Needs the Server Members intent and a fully loaded member list to count.",
      ),
    ).toBe(true);
    expect(
      page.includes(
        '<span class="kb-overline">Timeouts running now</span></div>\n  <div class="kb-tile__value">—</div>',
      ),
    ).toBe(true);
  });

  it("reports the real overdue count, not the length of the capped queue", async () => {
    cases.countOverdueCases.mockResolvedValue(125);
    cases.getQueue.mockResolvedValue({
      overdue: Array.from({ length: 100 }, (_, i) =>
        liveCase({
          _id: `case-o${i}`,
          caseNumber: 100 + i,
          reviewAt: new Date(Date.now() - 86_400_000),
        }),
      ),
      dueSoon: [],
      scheduled: [],
      indefinite: [],
      recentlyResolved: [],
    });
    const page = await html("/");
    expect(page.includes("125 due for review")).toBe(true);
    expect(page.includes("100 due for review")).toBe(false);
    expect(cases.countOverdueCases).toHaveBeenCalledWith(GUILD);
  });

  it("says the 7-day action count could not be read instead of a bare dash", async () => {
    moderation.countRecent.mockImplementation((_g: unknown, o: unknown) =>
      (o as { since?: Date }).since
        ? Promise.reject(new Error("db down"))
        : Promise.resolve(3),
    );
    const page = await html("/");
    expect(page.includes("Could not be read.")).toBe(true);
    expect(page.includes("Every logged action")).toBe(false);
  });

  it("says the overdue count could not be read, never none, when its read fails", async () => {
    cases.countOverdueCases.mockRejectedValue(new Error("db down"));
    const page = await html("/");
    expect(page.includes("Due for review could not be read.")).toBe(true);
    expect(page.includes("None due for review")).toBe(false);
    expect(page.includes("due for review</div>")).toBe(false);
    // The open count itself still shows.
    expect(
      page.includes(
        '<span class="kb-overline">Open cases</span></div>\n  <div class="kb-tile__value">3</div>',
      ),
    ).toBe(true);
  });

  it("says none due only when the count really is zero", async () => {
    cases.countOverdueCases.mockResolvedValue(0);
    expect((await html("/")).includes("None due for review")).toBe(true);
  });

  it("marks the open cases tile as a warning only when there are some", async () => {
    expect((await html("/")).includes("kb-tile kb-tile--warn")).toBe(true);
    cases.countLiveCases.mockResolvedValue(0);
    cases.countOverdueCases.mockResolvedValue(0);
    cases.getQueue.mockResolvedValue({
      overdue: [],
      dueSoon: [],
      scheduled: [],
      indefinite: [],
      recentlyResolved: [],
    });
    const page = await html("/");
    expect(page.includes("kb-tile--warn")).toBe(false);
    expect(page.includes("No open cases.")).toBe(true);
  });
});

describe("row headers", () => {
  it("names the member as the row header in the actions table", async () => {
    const page = await html("/");
    expect(page.includes('<th scope="row" title="u-bad">Bad Ben</th>')).toBe(
      true,
    );
  });

  it("names the member as the row header in the command audit table", async () => {
    const page = await html("/audit");
    expect(page.includes(`<th scope="row" title="${MOD}">${MOD}</th>`)).toBe(
      true,
    );
  });
});

describe("hostile query values stay inert", () => {
  const hostile = [
    "kind=%22%3E%3Cscript%3Ealert(1)%3C%2Fscript%3E",
    "kind[]=bans",
    "kind[]=bans&kind[]=%3Cscript%3E",
    "kind[x]=%3Cscript%3Ealert(1)%3C%2Fscript%3E",
    "page=%22%3E%3Cscript%3Ealert(1)%3C%2Fscript%3E",
  ];
  it.each(hostile)("the mod log ignores %s", async (query) => {
    const page = await html(`/?${query}`);
    expect(page.includes("<script>alert(1)")).toBe(false);
    expect(page.includes("%3Cscript")).toBe(false);
    const list = moderation.getRecent.mock.calls[0][1] as {
      actions?: string[];
      skip: number;
    };
    expect(list.actions).toBeUndefined();
    expect(list.skip).toBe(0);
  });

  it("parseModLogKind only ever returns one of its own constants", async () => {
    const { parseModLogKind } =
      await import("../../src/web/me-moderation-page.js");
    // An array whose string form is a valid kind used to pass through as the
    // submitted value itself.
    const arr = ["bans"];
    expect(parseModLogKind(arr)).toBe("all");
    expect(parseModLogKind({ toString: () => "bans" })).toBe("all");
    expect(parseModLogKind('"><script>')).toBe("all");
    expect(parseModLogKind(undefined)).toBe("all");
    expect(parseModLogKind("bans")).toBe("bans");
  });

  it("escapes hostile audit filters and a hostile case id", async () => {
    const evil = "%22%3E%3Cscript%3Ealert(1)%3C%2Fscript%3E";
    const audit = await html(
      `/audit?command=${evil}&user=${evil}&result=${evil}&from=${evil}&to=${evil}&page=${evil}`,
    );
    expect(audit.includes("<script>alert(1)")).toBe(false);
    cases.findCase.mockResolvedValue(null);
    const res = await harness.get(`/cases/${evil}`);
    expect(res.status).toBe(404);
    expect((await res.text()).includes("<script>alert(1)")).toBe(false);
    const post = await harness.post(`/cases/${evil}/uphold`, {});
    expect(post.headers.get("location")?.includes("<script>")).toBe(false);
  });
});

describe("actions", () => {
  it.each([
    ["", undefined],
    ["?kind=all", undefined],
    ["?kind=warnings", ["warn"]],
    ["?kind=timeouts", ["timeout", "untimeout"]],
    ["?kind=bans", ["ban", "unban"]],
    ["?kind=kicks", undefined],
    ["?kind=%24ne", undefined],
  ])("filters %s", async (query, expected) => {
    await html(`/${query}`);
    const listCall = moderation.getRecent.mock.calls[0];
    expect((listCall[1] as { actions?: string[] }).actions).toEqual(expected);
    const countCall = moderation.countRecent.mock.calls.find(
      (c) => !(c[1] as { since?: Date }).since,
    );
    expect((countCall?.[1] as { actions?: string[] }).actions).toEqual(
      expected,
    );
  });

  it("marks the current kind and links each row to its case", async () => {
    const page = await html("/?kind=bans");
    expect(
      page.includes(
        '<a href="/me/moderation?kind=bans#actions" aria-current="page">Bans</a>',
      ),
    ).toBe(true);
    expect(
      page.includes('<a href="/me/moderation/cases/case-1">Case #7</a>'),
    ).toBe(true);
    expect(page.includes("Bad Ben")).toBe(true);
  });

  it("offers Review on each open case, linking to the case page", async () => {
    const page = await html("/");
    expect(page.includes('href="/me/moderation/cases/case-2#review"')).toBe(
      true,
    );
    expect(page.includes('aria-label="Review case 8"')).toBe(true);
  });

  it("shows an empty state, and none of the case column without cases", async () => {
    moderation.getRecent.mockResolvedValue([]);
    moderation.countRecent.mockResolvedValue(0);
    cases.isEnabledStrict.mockResolvedValue(false);
    const page = await html("/?kind=warnings");
    expect(page.includes("No warnings logged.")).toBe(true);
    expect(page.includes('id="open-cases"')).toBe(false);
    expect(cases.getQueue).not.toHaveBeenCalled();
  });

  it("answers with an off state and queries nothing while moderation is off", async () => {
    config["moderation.enabled"] = false;
    const page = await html("/");
    expect(page.includes("Moderation is switched off on this server.")).toBe(
      true,
    );
    expect(moderation.getRecent).not.toHaveBeenCalled();
    expect(moderation.countRecent).not.toHaveBeenCalled();
  });

  it("escapes member-controlled text", async () => {
    const evil = '<img src=x onerror="alert(1)">';
    members.set("u-bad", member(evil));
    moderation.getRecent.mockResolvedValue([logRow({ reason: evil })]);
    const page = await html("/");
    expect(page.includes(evil)).toBe(false);
    expect(
      page.includes("&lt;img src=x onerror=&quot;alert(1)&quot;&gt;"),
    ).toBe(true);
  });

  it("does not render message content or attachment fields", async () => {
    moderation.getRecent.mockResolvedValue([
      logRow({ content: "secret message", attachments: ["a.png"] }),
    ]);
    const page = await html("/");
    expect(page.includes("secret message")).toBe(false);
    expect(page.includes("a.png")).toBe(false);
  });
});

describe("a failed read is never shown as empty or zero", () => {
  const rejected = (): Promise<never> => Promise.reject(new Error("db down"));

  it("says the log is unavailable when the rows cannot be read", async () => {
    moderation.getRecent.mockImplementation(rejected);
    const page = await html("/");
    expect(page.includes("The log could not be read.")).toBe(true);
    expect(page.includes("No actions logged yet.")).toBe(false);
    expect(page.includes("No warnings logged.")).toBe(false);
  });

  it("says the log is unavailable when the count cannot be read, and not zero entries", async () => {
    moderation.countRecent.mockImplementation(async (...args: unknown[]) => {
      const q = args[1] as { since?: Date };
      if (q.since) return 4;
      throw new Error("db down");
    });
    const page = await html("/?kind=warnings");
    expect(page.includes("The log could not be read.")).toBe(true);
    expect(page.includes("0 entries")).toBe(false);
    expect(page.includes("No warnings logged.")).toBe(false);
  });

  it("keeps the empty state for a read that succeeded and found nothing", async () => {
    moderation.getRecent.mockResolvedValue([]);
    moderation.countRecent.mockResolvedValue(0);
    const page = await html("/");
    expect(page.includes("No actions logged yet.")).toBe(true);
    expect(page.includes("The log could not be read.")).toBe(false);
  });

  it("marks the case column unavailable when the case lookup fails", async () => {
    cases.getCasesForEntries.mockImplementation(rejected);
    const page = await html("/");
    expect(page.includes('<span class="kb-muted">Unavailable</span>')).toBe(
      true,
    );
  });

  it("does not turn a failed case-switch read into 'cases are off'", async () => {
    cases.isEnabledStrict.mockImplementation(rejected);
    expect((await harness.get("/")).status).toBe(500);
    expect((await harness.get("/cases/case-1")).status).toBe(500);
  });

  it("does not turn a failed case lookup into 'no such case'", async () => {
    cases.findCase.mockImplementation(rejected);
    expect((await harness.get("/cases/case-1")).status).toBe(500);
  });

  it("does not show a missing origin entry as 'No reason recorded'", async () => {
    cases.getOriginEntries.mockImplementation(rejected);
    expect((await harness.get("/cases/case-1")).status).toBe(500);
  });

  it("says the prior history could not be read instead of 'No other history'", async () => {
    moderation.getHistory.mockImplementation(rejected);
    const page = await html("/cases/case-1");
    expect(page.includes("The prior history could not be read.")).toBe(true);
    expect(page.includes("No other history on file.")).toBe(false);
  });

  it("says the command audit is unavailable instead of empty", async () => {
    auditCount.mockReturnValue(Promise.reject(new Error("db down")));
    const page = await html("/audit");
    expect(page.includes("The command audit could not be read.")).toBe(true);
    expect(page.includes("No command invocations match.")).toBe(false);
  });

  it("shows 'unavailable' in the audit header, never '0 rows', when the count fails", async () => {
    auditCount.mockReturnValue(Promise.reject(new Error("db down")));
    const page = await html("/audit");
    expect(page.includes(">unavailable</span>")).toBe(true);
    expect(page.includes("0 rows")).toBe(false);
  });

  it("says the command audit is unavailable when its rows cannot be read", async () => {
    auditFind.mockReturnValue({
      sort: () => ({
        skip: () => ({
          limit: () => ({ lean: () => Promise.reject(new Error("db down")) }),
        }),
      }),
    });
    const page = await html("/audit");
    expect(page.includes("The command audit could not be read.")).toBe(true);
  });
});

describe("pages out of range", () => {
  it("shows and fetches the last page of the actions list", async () => {
    moderation.countRecent.mockImplementation(async (...args: unknown[]) => {
      const q = args[1] as { since?: Date };
      return q.since ? 4 : 100;
    });
    const page = await html("/?page=3");
    const listCall = moderation.getRecent.mock.calls[0][1] as { skip: number };
    expect(listCall.skip).toBe(50);
    expect(page.includes("Page 2 of 2")).toBe(true);
    expect(page.includes("No actions logged yet.")).toBe(false);
  });

  it("shows and fetches the last page of the command audit", async () => {
    const skip = jest.fn(() => ({
      limit: () => ({
        lean: () =>
          Promise.resolve([
            {
              createdAt: new Date("2026-01-03T09:30:00Z"),
              discordUserId: MOD,
              commandName: "warn",
              channelId: "c-1",
              result: "success",
              durationMs: 1,
            },
          ]),
      }),
    }));
    auditCount.mockReturnValue(Promise.resolve(80));
    auditFind.mockReturnValue({ sort: () => ({ skip }) });
    const page = await html("/audit?page=9");
    expect(skip).toHaveBeenCalledWith(50);
    expect(page.includes("Page 2 of 2")).toBe(true);
  });
});

describe("case page and Review", () => {
  it("shows the four decisions on a live case, each CSRF-protected", async () => {
    const page = await html("/cases/case-1");
    for (const d of ["uphold", "extend", "permanent", "readmit"]) {
      expect(
        page.includes(`formaction="/me/moderation/cases/case-1/${d}"`),
      ).toBe(true);
    }
    expect(page.includes(`name="_csrf" value="${TEST_CSRF_TOKEN}"`)).toBe(true);
  });

  it("asks before the two decisions that close the case, with the admin wording", async () => {
    const page = await html("/cases/case-1");
    expect(
      page.includes(
        'formaction="/me/moderation/cases/case-1/permanent" data-confirm="Make this removal permanent? The case closes with no further review."',
      ),
    ).toBe(true);
    expect(
      page.includes(
        'formaction="/me/moderation/cases/case-1/readmit" data-confirm="Let this member back in? KoolBot does not unban in Discord; do that there."',
      ),
    ).toBe(true);
    expect(page.split(' data-confirm="').length - 1).toBe(2);
  });

  it("offers no decisions on a resolved case", async () => {
    cases.findCase.mockResolvedValue(liveCase({ status: "lifted" }));
    const page = await html("/cases/case-1");
    expect(page.includes("formaction")).toBe(false);
    expect(page.includes("nothing left to review")).toBe(true);
  });

  it('says "Let back in", never "Readmit", on the live and resolved case pages', async () => {
    const shown = /(?<!\/)readmit/i; // the route value `/readmit` stays internal
    const live = await html("/cases/case-1");
    expect(live).toContain(">Let back in</button>");
    expect(live).toContain("Let this member back in?");
    expect(live).not.toMatch(shown);
    // A case closed before this wording stores `readmitted`; it shows the new words.
    cases.findCase.mockResolvedValue(
      liveCase({
        status: "lifted",
        events: [
          {
            at: new Date("2026-02-01T10:00:00Z"),
            byUserId: MOD,
            to: "lifted",
            outcome: "readmitted",
            note: null,
          },
        ],
      }),
    );
    const done = await html("/cases/case-1");
    expect(done).toContain("let back in by Mod Mia");
    expect(done).not.toMatch(shown);
  });

  it("answers 404 for an unknown case and while cases are off", async () => {
    cases.findCase.mockResolvedValue(null);
    expect((await harness.get("/cases/nope")).status).toBe(404);
    cases.isEnabledStrict.mockResolvedValue(false);
    expect((await harness.get("/cases/case-1")).status).toBe(404);
    expect(cases.findCase).toHaveBeenCalledTimes(1);
  });

  it("records the decision as the moderator and writes an audit row", async () => {
    const res = await harness.post("/cases/case-1/uphold", {
      next_review_in_days: "30",
      note: "still a risk",
    });
    expect(res.status).toBe(303);
    const flash = parseFlashRedirect(res.headers.get("location"));
    expect(flash.path).toBe("/me/moderation/cases/case-1");
    expect(flash.type).toBe("ok");
    expect(cases.decide).toHaveBeenCalledTimes(1);
    const input = cases.decide.mock.calls[0][0] as Record<string, unknown>;
    expect(input).toMatchObject({
      guildId: GUILD,
      caseId: "case-1",
      decision: "uphold",
      byUserId: MOD,
      note: "still a risk",
    });
    expect(input.nextReviewAt).toBeInstanceOf(Date);
    expect(mockRecordAudit).toHaveBeenCalledTimes(1);
    expect(mockRecordAudit.mock.calls[0][1]).toMatchObject({
      action: "moderation.case.uphold",
      targetId: "case-1",
      result: "success",
    });
    expect(mockRecordAudit.mock.calls[0][0]).toMatchObject({
      discordUserId: MOD,
    });
  });

  it("audits a refused decision as a failure", async () => {
    const { ModerationCaseError } = actualCases;
    cases.decide.mockRejectedValue(
      new ModerationCaseError("terminal", "Case #7 is already lifted."),
    );
    const res = await harness.post("/cases/case-1/readmit", {});
    const flash = parseFlashRedirect(res.headers.get("location"));
    expect(flash.type).toBe("err");
    expect(flash.msg).toBe("Case #7 is already lifted.");
    expect(mockRecordAudit.mock.calls[0][1]).toMatchObject({
      action: "moderation.case.readmit",
      result: "failure",
    });
  });

  describe("refusals are audited too", () => {
    const secret = "SECRET-NOTE-TEXT";
    const only = (): Record<string, unknown> => {
      expect(mockRecordAudit).toHaveBeenCalledTimes(1);
      expect(cases.decide).not.toHaveBeenCalled();
      const [session, entry] = mockRecordAudit.mock.calls[0] as [
        Record<string, unknown>,
        Record<string, unknown>,
      ];
      expect(session).toMatchObject({ discordUserId: MOD, guildId: GUILD });
      return entry;
    };

    it("an oversized note", async () => {
      const res = await harness.post("/cases/case-1/uphold", {
        note: secret + "x".repeat(600),
      });
      expect(parseFlashRedirect(res.headers.get("location")).type).toBe("err");
      const entry = only();
      expect(entry).toMatchObject({
        action: "moderation.case.uphold",
        targetId: "case-1",
        result: "failure",
        errorMessage: "Note must be 500 characters or fewer.",
      });
      expect(JSON.stringify(entry).includes(secret)).toBe(false);
    });

    it("an invalid review date", async () => {
      const res = await harness.post("/cases/case-1/extend", {
        next_review_in_days: "30days",
        note: secret,
      });
      expect(parseFlashRedirect(res.headers.get("location")).type).toBe("err");
      const entry = only();
      expect(entry).toMatchObject({
        action: "moderation.case.extend",
        targetId: "case-1",
        result: "failure",
      });
      expect(JSON.stringify(entry).includes(secret)).toBe(false);
      expect(JSON.stringify(entry).includes("30days")).toBe(false);
    });

    it("cases switched off", async () => {
      cases.isEnabledStrict.mockResolvedValue(false);
      await harness.post("/cases/case-1/readmit", { note: secret });
      const entry = only();
      expect(entry).toMatchObject({
        action: "moderation.case.readmit",
        targetId: "case-1",
        result: "failure",
        errorMessage: "Moderation cases are turned off.",
      });
      expect(JSON.stringify(entry).includes(secret)).toBe(false);
    });
  });

  it("refuses a decision without a CSRF token and changes nothing", async () => {
    const res = await harness.post(
      "/cases/case-1/permanent",
      {},
      { csrfField: null, csrfCookie: null },
    );
    expect(res.status).toBe(403);
    expect(cases.decide).not.toHaveBeenCalled();
    expect(mockRecordAudit).not.toHaveBeenCalled();
  });

  it("refuses a decision with a mismatched CSRF token", async () => {
    const res = await harness.post(
      "/cases/case-1/permanent",
      {},
      { csrfField: "forged" },
    );
    expect(res.status).toBe(403);
    expect(cases.decide).not.toHaveBeenCalled();
  });

  it("has no route for an unknown decision", async () => {
    const res = await harness.post("/cases/case-1/delete", {});
    expect(res.status).toBe(404);
    expect(cases.decide).not.toHaveBeenCalled();
  });

  it("refuses to decide while cases are off", async () => {
    cases.isEnabledStrict.mockResolvedValue(false);
    const res = await harness.post("/cases/case-1/uphold", {});
    const flash = parseFlashRedirect(res.headers.get("location"));
    expect(flash.msg).toBe("Moderation cases are turned off.");
    expect(cases.decide).not.toHaveBeenCalled();
  });
});

describe("command audit (read only)", () => {
  it("lists invocations with the channel as a mention-style label", async () => {
    const page = await html("/audit");
    expect(page.includes("/warn")).toBe(true);
    expect(page.includes('<span class="kb-mention">#general</span>')).toBe(
      true,
    );
    expect(page.includes("Read only.")).toBe(true);
  });

  it("is a view only: nothing under it writes", async () => {
    for (const method of ["POST", "PUT", "PATCH", "DELETE"] as const) {
      const res = await fetch(`${harness.baseUrl}/me/moderation/audit`, {
        method,
        redirect: "manual",
        headers: {
          "content-type": "application/x-www-form-urlencoded",
          cookie: `koolbot_csrf=${TEST_CSRF_TOKEN}`,
        },
        body: `_csrf=${TEST_CSRF_TOKEN}`,
      });
      expect(res.status).toBe(404);
    }
    const noCsrf = await harness.post("/audit", {}, { csrfField: null });
    expect(noCsrf.status).toBe(403);
    expect(mockRecordAudit).not.toHaveBeenCalled();
  });

  it("shows an empty state, and says when auditing is off", async () => {
    config["core.command_audit.enabled"] = false;
    auditCount.mockReturnValue(Promise.resolve(0));
    auditFind.mockReturnValue({
      sort: () => ({
        skip: () => ({
          limit: () => ({ lean: () => Promise.resolve([]) }),
        }),
      }),
    });
    const page = await html("/audit");
    expect(page.includes("No command invocations match.")).toBe(true);
    expect(page.includes("Command auditing is switched off")).toBe(true);
  });

  it("passes the filters to the same query the admin page uses", async () => {
    await html("/audit?command=warn&result=denied&user=u-1");
    expect(auditCount).toHaveBeenCalledWith({
      guildId: GUILD,
      commandName: "warn",
      discordUserId: "u-1",
      result: "denied",
    });
  });
});
