/**
 * `/me/events/new` over real HTTP (#1305): an event host creates an event of
 * their own. The real guard (`requireScopeMiddleware("host")`), router, CSRF
 * check, create pipeline, form validator and view run; the event service, the
 * audit write and the stored config are stubbed.
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

process.env.WEBUI_SESSION_SECRET = "test-secret-for-me-new-event";

const mockRecordAudit = jest.fn<(...args: unknown[]) => Promise<undefined>>(
  async () => undefined,
);
const mockCreateEvent = jest.fn<(input: unknown) => Promise<unknown>>();
const mockCreateImpromptu =
  jest.fn<(input: unknown, now?: Date) => Promise<unknown>>();
let eventsEnabled = true;
let categoryId = "cat-1";

const actualAudit = await import("../../src/web/audit.js");
jest.unstable_mockModule("../../src/web/audit.js", () => ({
  recordAudit: mockRecordAudit,
  boundAuditEntry: actualAudit.boundAuditEntry,
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
      getString: async (key: string, fallback: string) =>
        key === "events.category_id"
          ? categoryId
          : key === "events.timezone"
            ? "UTC"
            : fallback,
      getNumber: async (_key: string, fallback: number) => fallback,
      getNumberStrict: async (_key: string, fallback: number) => fallback,
      getBoolean: async () => false,
      getBooleanStrict: async (key: string) =>
        key === "events.enabled" ? eventsEnabled : false,
      registerReloadCallback: jest.fn(),
    }),
  },
}));
// The bot permission check (#1478): the page only reads its report.
const actualCheck = await import("../../src/services/bot-permission-check.js");
const registry = await import("../../src/services/bot-permission-registry.js");
const mockCheck =
  jest.fn<
    (client: unknown, guildId: string) => Promise<ReportOf<typeof actualCheck>>
  >();
type ReportOf<M extends typeof actualCheck> = Awaited<
  ReturnType<M["checkBotPermissions"]>
>;
jest.unstable_mockModule("../../src/services/bot-permission-check.js", () => ({
  ...actualCheck,
  checkBotPermissions: mockCheck,
}));
const actualEvents = await import("../../src/services/event-service.js");
jest.unstable_mockModule("../../src/services/event-service.js", () => ({
  ...actualEvents,
  EventService: {
    getInstance: (): unknown => ({
      createEvent: mockCreateEvent,
      createImpromptuEvent: mockCreateImpromptu,
    }),
  },
}));
const actualPresets =
  await import("../../src/services/event-group-preset-service.js");
jest.unstable_mockModule(
  "../../src/services/event-group-preset-service.js",
  () => ({
    ...actualPresets,
    loadPresetCatalog: async () => ({
      entries: [],
      state: "ok",
      personalUnreadable: false,
    }),
  }),
);

const mockRemember =
  jest.fn<
    (guildId: string, ownerId: string, setup: unknown) => Promise<void>
  >();
const mockLoadPrefill = jest.fn<(...args: unknown[]) => Promise<unknown>>();
const actualLastSetup =
  await import("../../src/services/event-last-setup-service.js");
jest.unstable_mockModule(
  "../../src/services/event-last-setup-service.js",
  () => ({
    ...actualLastSetup,
    rememberLastSetup: mockRemember,
    loadGroupPrefill: mockLoadPrefill,
  }),
);

const { createMeNewEventRouter } =
  await import("../../src/web/routes/me-new-event.js");
const { requireScopeMiddleware } = await import("../../src/web/session.js");

const GUILD = "guild-1";
const HOST = "111111111111111111";
const EVENT_ID = "0123456789abcdef01234567";

let current = createTestSession({
  discordUserId: HOST,
  guildId: GUILD,
  role: "user",
  scopes: ["member", "host"],
});
let harness: AdminHarness;

beforeAll(async () => {
  harness = await startAdminHarness(
    [
      (req, _res, next): void => {
        Object.assign(req, { webSession: current, csrfToken: TEST_CSRF_TOKEN });
        next();
      },
      // The same guard `createUserRouter` puts ahead of `/events`.
      requireScopeMiddleware("host"),
      createMeNewEventRouter({} as never),
    ],
    "/me/events/new",
  );
});

afterAll(async () => {
  await harness.close();
});

const tomorrow = (): string =>
  new Date(Date.now() + 86_400_000).toISOString().slice(0, 10);

beforeEach(() => {
  jest.clearAllMocks();
  eventsEnabled = true;
  categoryId = "cat-1";
  current = createTestSession({
    discordUserId: HOST,
    guildId: GUILD,
    role: "user",
    scopes: ["member", "host"],
  });
  mockRemember.mockResolvedValue(undefined);
  mockLoadPrefill.mockResolvedValue(null);
  mockCreateEvent.mockImplementation(async (input) => ({
    _id: EVENT_ID,
    startTime: (input as { startTime: Date }).startTime,
  }));
  mockCreateImpromptu.mockImplementation(async (_input, now) => ({
    event: {
      _id: EVENT_ID,
      startTime: new Date((now ?? new Date()).getTime() + 30_000),
    },
    started: true,
  }));
});

const planned = {
  title: "Game night",
  date: tomorrow(),
  time: "12:00",
  timezone: "UTC",
  duration: "90",
};

function permissionReport(
  checks: Array<{
    id: string;
    outcome: "missing" | "ok";
    permissions?: string[];
    target?: { kind: "category" | "server"; id: string; name: string };
  }>,
  over: Partial<ReportOf<typeof actualCheck>> = {},
): ReportOf<typeof actualCheck> {
  return {
    available: true,
    reason: null,
    fresh: true,
    problems: [],
    unknown: [],
    quiet: [],
    okFeatures: [],
    notes: [],
    checks: checks.map((c) => {
      const r = registry.FEATURE_REQUIREMENTS.find((x) => x.id === c.id);
      if (!r) throw new Error(c.id);
      return {
        feature: {
          id: r.id,
          area: r.area,
          feature: r.feature,
          effect: r.effect,
          fix: r.fix,
        },
        kind: "permission",
        enabled: true,
        outcome: c.outcome,
        target: c.target ?? { kind: "category", id: "c1", name: "Events" },
        missing: c.permissions ?? [],
      };
    }),
    ...over,
  } as ReportOf<typeof actualCheck>;
}

describe("GET /me/events/new bot permission notice (#1478)", () => {
  const lacking = permissionReport([
    {
      id: "event-channels",
      outcome: "missing",
      permissions: ["Manage Channels"],
    },
    {
      id: "event-native",
      outcome: "missing",
      permissions: ["Create Events"],
      target: { kind: "server", id: "g1", name: "Server" },
    },
  ]);

  beforeEach(() => {
    mockCheck.mockResolvedValue(permissionReport([]));
  });

  it("shows nothing when the permissions are in place, and leaves the page as it was", async () => {
    const html = await (await harness.get("")).text();
    expect(html).not.toContain("data-permission");
  });

  it("shows a host who is not an admin each missing permission, with 'Ask a server admin' and no link", async () => {
    mockCheck.mockResolvedValue(lacking);
    const html = await (await harness.get("")).text();
    expect(html).toContain('data-permission-inline="event-channels"');
    expect(html).toContain(
      "Bot lacks Manage Channels in the category “Events”",
    );
    expect(html).toContain("Create Events");
    expect(html).toContain("Ask a server admin");
    expect(html).not.toContain("/admin/bot-permissions");
    // Asked for the server's own Events entries, with no event placement.
    expect(mockCheck).toHaveBeenCalledWith({}, GUILD, undefined);
  });

  it("links an admin to Bot permissions", async () => {
    current = createTestSession({
      discordUserId: HOST,
      guildId: GUILD,
      role: "admin",
      scopes: ["member", "host"],
    });
    mockCheck.mockResolvedValue(lacking);
    const html = await (await harness.get("")).text();
    expect(html).toContain('href="/admin/bot-permissions"');
    expect(html).not.toContain("Ask a server admin");
  });

  it("says the check could not run, rather than staying quiet", async () => {
    mockCheck.mockResolvedValue(
      permissionReport([], {
        available: false,
        reason: "The bot is not connected.",
      }),
    );
    const html = await (await harness.get("")).text();
    expect(html).toContain("Bot permissions could not be checked");
    expect(html).toContain("The bot is not connected.");
  });

  it("does not fail the page when the check throws", async () => {
    mockCheck.mockRejectedValue(new Error("boom"));
    const res = await harness.get("");
    expect(res.status).toBe(200);
    expect(await res.text()).toContain("Bot permissions could not be checked");
  });
});

describe("GET /me/events/new", () => {
  it("shows the form with the When choice and no Repeat field", async () => {
    const res = await harness.get("");
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).toContain("New event");
    for (const label of [
      "Now",
      "In 15 min",
      "In 30 min",
      "In 1 hour",
      "Pick date &amp; time",
    ]) {
      expect(html).toContain(label);
    }
    // Pick date & time is the default, so a planned event is unchanged.
    expect(html).toMatch(/name="when" value="pick" checked/);
    expect(html).not.toContain('name="recurrence"');
    expect(html).toContain("data-event-form");
    expect(html).toContain('action="/me/events/new"');
  });

  it("preselects Now for Start now (?when=now) and ignores anything else (#1319)", async () => {
    const now = await (await harness.get("?when=now")).text();
    expect(now).toMatch(/name="when" value="now" checked/);
    expect(now).not.toMatch(/name="when" value="pick" checked/);
    for (const q of [
      "?when=tomorrow",
      "?when[]=now",
      "?when=",
      "?when=15",
      "?when=30",
      "?when=60",
      "?when=now&when=now",
    ]) {
      const html = await (await harness.get(q)).text();
      expect(html).toMatch(/name="when" value="pick" checked/);
    }
  });

  it("answers 404 while Events is switched off", async () => {
    eventsEnabled = false;
    expect((await harness.get("")).status).toBe(404);
  });

  it.each([
    ["a member only", ["member"]],
    ["a moderator only", ["member", "moderator"]],
  ] as const)("refuses %s", async (_n, scopes) => {
    current = createTestSession({
      discordUserId: HOST,
      guildId: GUILD,
      role: "user",
      scopes: [...scopes],
    });
    expect((await harness.get("")).status).toBe(403);
  });
});

describe("POST /me/events/new: authorisation", () => {
  it.each([
    ["a member only", ["member"]],
    ["a moderator only", ["member", "moderator"]],
    ["no scopes", []],
  ] as const)("refuses %s and creates nothing", async (_n, scopes) => {
    current = createTestSession({
      discordUserId: HOST,
      guildId: GUILD,
      role: "user",
      scopes: [...scopes],
    });
    expect((await harness.post("", planned)).status).toBe(403);
    expect((await harness.post("", { ...planned, when: "now" })).status).toBe(
      403,
    );
    expect(mockCreateEvent).not.toHaveBeenCalled();
    expect(mockCreateImpromptu).not.toHaveBeenCalled();
    expect(mockRecordAudit).not.toHaveBeenCalled();
  });

  it("refuses a post without a CSRF token", async () => {
    const res = await harness.post("", planned, {
      csrfField: null,
      csrfCookie: null,
    });
    expect(res.status).toBe(403);
    expect(mockCreateEvent).not.toHaveBeenCalled();
  });

  it("answers 404 and creates nothing while Events is off", async () => {
    eventsEnabled = false;
    expect((await harness.post("", planned)).status).toBe(404);
    expect(mockCreateEvent).not.toHaveBeenCalled();
  });

  it("owns the event by the session, never by a posted createdBy or guildId", async () => {
    const res = await harness.post("", {
      ...planned,
      createdBy: "999999999999999999",
      guildId: "other-guild",
    });
    expect(res.status).toBe(303);
    const input = mockCreateEvent.mock.calls[0][0] as Record<string, unknown>;
    expect(input.createdBy).toBe(HOST);
    expect(input.guildId).toBe(GUILD);
  });

  it("never repeats a host's event, whatever recurrence is posted", async () => {
    await harness.post("", { ...planned, recurrence: "weekly" });
    const input = mockCreateEvent.mock.calls[0][0] as Record<string, unknown>;
    expect(input.recurrence).toBe("none");
  });
});

describe("POST /me/events/new: planned events", () => {
  it("creates the event and opens its host panel", async () => {
    const res = await harness.post("", planned);
    expect(res.status).toBe(303);
    const flash = parseFlashRedirect(res.headers.get("location"));
    expect(flash.path).toBe(`/me/events/${EVENT_ID}/host`);
    expect(flash.type).toBe("ok");
    expect(mockCreateImpromptu).not.toHaveBeenCalled();
    const input = mockCreateEvent.mock.calls[0][0] as Record<string, unknown>;
    expect(input.title).toBe("Game night");
    expect(input.durationMinutes).toBe(90);
    expect((input.startTime as Date).toISOString()).toBe(
      `${planned.date}T12:00:00.000Z`,
    );
    expect(input.impromptu).toBeUndefined();
  });

  it("audits the create as the host's, bounded", async () => {
    await harness.post("", planned);
    const [session, entry] = mockRecordAudit.mock.calls[0] as [
      { discordUserId: string },
      { action: string; result: string; details: Record<string, unknown> },
    ];
    expect(session.discordUserId).toBe(HOST);
    expect(entry.action).toBe("event.create");
    expect(entry.result).toBe("success");
    expect(entry.details).toMatchObject({ via: "host", when: "pick" });
  });

  it("still refuses a start in the past for Pick date & time", async () => {
    const res = await harness.post("", { ...planned, date: "2020-01-01" });
    const flash = parseFlashRedirect(res.headers.get("location"));
    expect(flash.path).toBe("/me/events/new");
    expect(flash.type).toBe("err");
    expect(flash.msg).toContain("must be in the future");
    expect(mockCreateEvent).not.toHaveBeenCalled();
  });

  it("refuses Pick date & time without a date or time", async () => {
    const res = await harness.post("", { title: "No time" });
    const flash = parseFlashRedirect(res.headers.get("location"));
    expect(flash.type).toBe("err");
    expect(flash.msg).toContain("Title, date and time are all required");
    expect(mockCreateEvent).not.toHaveBeenCalled();
  });

  it("refuses an unknown When value", async () => {
    const res = await harness.post("", { ...planned, when: "tomorrow" });
    expect(parseFlashRedirect(res.headers.get("location")).type).toBe("err");
    expect(mockCreateEvent).not.toHaveBeenCalled();
  });

  it.each([
    ["15", 15],
    ["30", 30],
    ["60", 60],
  ])(
    "In %s min starts that long from now, ignoring the date",
    async (when, minutes) => {
      const before = Date.now();
      const res = await harness.post("", {
        title: "Soon",
        when,
        date: "2020-01-01",
        time: "00:00",
      });
      expect(res.status).toBe(303);
      expect(parseFlashRedirect(res.headers.get("location")).type).toBe("ok");
      const start = (
        mockCreateEvent.mock.calls[0][0] as { startTime: Date }
      ).startTime.getTime();
      expect(start).toBeGreaterThanOrEqual(before + minutes * 60_000);
      expect(start).toBeLessThanOrEqual(Date.now() + minutes * 60_000);
      expect(mockCreateImpromptu).not.toHaveBeenCalled();
    },
  );
});

describe("POST /me/events/new: Now", () => {
  it("creates and starts the event at once, with no date or time posted", async () => {
    const res = await harness.post("", { title: "Right now", when: "now" });
    expect(res.status).toBe(303);
    const flash = parseFlashRedirect(res.headers.get("location"));
    expect(flash.path).toBe(`/me/events/${EVENT_ID}/host`);
    expect(flash.type).toBe("ok");
    expect(flash.msg).toContain("is live");
    expect(mockCreateEvent).not.toHaveBeenCalled();
    const input = mockCreateImpromptu.mock.calls[0][0] as Record<
      string,
      unknown
    >;
    expect(input.title).toBe("Right now");
    expect(input.createdBy).toBe(HOST);
    expect(input.guildId).toBe(GUILD);
    // The duration defaults to the server's (120 minutes here).
    expect(input.durationMinutes).toBe(120);
    expect(input).not.toHaveProperty("recurrence");
  });

  it("audits the start as part of the create", async () => {
    await harness.post("", { title: "Right now", when: "now" });
    const entry = mockRecordAudit.mock.calls[0][1] as {
      details: Record<string, unknown>;
    };
    expect(entry.details).toMatchObject({
      via: "host",
      when: "now",
      startedNow: true,
    });
  });

  it("says plainly when the event exists but its channels could not be made", async () => {
    mockCreateImpromptu.mockResolvedValueOnce({
      event: { _id: EVENT_ID, startTime: new Date() },
      started: false,
    });
    const res = await harness.post("", { title: "Right now", when: "now" });
    const flash = parseFlashRedirect(res.headers.get("location"));
    expect(flash.path).toBe(`/me/events/${EVENT_ID}/host`);
    expect(flash.type).toBe("err");
    expect(flash.msg).toContain("channels could not be made");
  });

  it("creates nothing and says why when no channel category is set", async () => {
    mockCreateImpromptu.mockRejectedValueOnce(
      new actualEvents.ImpromptuNotReadyError("No channel category is set."),
    );
    const res = await harness.post("", { title: "Right now", when: "now" });
    const flash = parseFlashRedirect(res.headers.get("location"));
    expect(flash.path).toBe("/me/events/new");
    expect(flash.type).toBe("err");
    expect(flash.msg).toContain("No channel category is set.");
    const entry = mockRecordAudit.mock.calls[0][1] as { result: string };
    expect(entry.result).toBe("failure");
  });

  it("needs a title", async () => {
    const res = await harness.post("", { when: "now" });
    expect(parseFlashRedirect(res.headers.get("location")).type).toBe("err");
    expect(mockCreateImpromptu).not.toHaveBeenCalled();
  });
});

describe("the host's remembered group setup (#1406)", () => {
  const groupForm = {
    ...planned,
    groups_enabled: "1",
    groups_preset: "",
    groups_captains: "1",
    groups_tags: "1",
    group_0_name: "Red",
    group_0_marker: "🔴",
    group_0_size: "5",
    group_1_name: "Blue",
  };

  it("remembers the accepted setup for the signed-in host after a create", async () => {
    const res = await harness.post("", {
      ...groupForm,
      // A posted owner must change nothing: the session decides.
      ownerId: "999999999999999999",
    });
    expect(res.status).toBe(303);
    expect(mockRemember).toHaveBeenCalledTimes(1);
    const [guildId, ownerId, setup] = mockRemember.mock.calls[0] as [
      string,
      string,
      {
        groupsEnabled: boolean;
        captainsEnabled: boolean;
        tagsEnabled: boolean;
        groups: Array<{ name: string; marker: string; size: number | null }>;
      },
    ];
    expect(guildId).toBe(GUILD);
    expect(ownerId).toBe(HOST);
    expect(setup.groupsEnabled).toBe(true);
    expect(setup.captainsEnabled).toBe(true);
    expect(setup.tagsEnabled).toBe(true);
    expect(setup.groups.map((g) => [g.name, g.marker, g.size])).toEqual([
      ["Red", "🔴", 5],
      ["Blue", "", null],
    ]);
  });

  it("remembers nothing for a plain event", async () => {
    await harness.post("", planned);
    expect(mockRemember).not.toHaveBeenCalled();
  });

  it("remembers nothing when the form is refused or the create fails", async () => {
    await harness.post("", { ...groupForm, group_0_name: "" });
    expect(mockCreateEvent).not.toHaveBeenCalled();
    mockCreateEvent.mockRejectedValueOnce(new Error("boom"));
    await harness.post("", groupForm);
    expect(mockRemember).not.toHaveBeenCalled();
  });

  it("prefills the form from the host's own setup, with a way back to the defaults", async () => {
    mockLoadPrefill.mockResolvedValue({
      presetId: "",
      groupLabel: "Squad",
      leaderLabel: "",
      channelLeadMinutes: "10",
      rows: [
        { name: "Red", kind: "team", size: "5", tag: "RED", marker: "🔴" },
        { name: "Blue", kind: "team", size: "", tag: "", marker: "" },
        { name: "Green", kind: "team", size: "", tag: "", marker: "" },
      ],
      captainsEnabled: true,
      captainCustomisationEnabled: false,
      captainsLobby: true,
      tagsEnabled: true,
      tagsSuffix: false,
    });
    const html = await (await harness.get("?when=now")).text();
    expect(mockLoadPrefill).toHaveBeenCalledWith(
      GUILD,
      HOST,
      expect.anything(),
    );
    expect(html).toContain("Prefilled from your last event.");
    expect(html).toContain('href="/me/events/new?when=now&amp;defaults=1"');
    expect(html).toMatch(/name="groups_enabled" value="1" checked/);
    expect(html).toMatch(/name="groups_captains" value="1" checked/);
    expect(html).toMatch(/name="groups_captains_lobby" value="1" checked/);
    expect(html).toMatch(/name="groups_tags" value="1" checked/);
    expect(html).not.toMatch(/name="groups_tags_suffix" value="1" checked/);
    expect(html).toMatch(/name="group_2_name"[^>]*value="Green"/);
    expect(html).toMatch(/name="groups_label"[^>]*value="Squad"/);
    expect(html).toMatch(/name="groups_lead_minutes"[^>]*value="10"/);
    // Custom stays the checked card, as no preset was remembered.
    expect(html).toMatch(/name="groups_preset" value="" checked/);
  });

  it("shows the normal defaults for ?defaults=1 without reading the store", async () => {
    const html = await (await harness.get("?defaults=1")).text();
    expect(mockLoadPrefill).not.toHaveBeenCalled();
    expect(html).not.toContain("Prefilled from your last event.");
    expect(html).not.toMatch(/name="groups_enabled" value="1" checked/);
  });

  it("shows the normal defaults when there is nothing to prefill", async () => {
    const html = await (await harness.get("")).text();
    expect(html).not.toContain("Prefilled from your last event.");
    expect(html).not.toMatch(/name="groups_enabled" value="1" checked/);
  });
});
