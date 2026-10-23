/**
 * The per-host cap on open events (#1408) over real HTTP at `/me/events/new`:
 * the real guard, router, CSRF check and create pipeline run; the event
 * service, the open-event count, the audit write and the config are stubbed.
 * The limit is read from the (stubbed) config on every attempt.
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

process.env.WEBUI_SESSION_SECRET = "test-secret-for-host-event-cap";

const mockRecordAudit = jest.fn<(...args: unknown[]) => Promise<undefined>>(
  async () => undefined,
);
const mockCreateEvent = jest.fn<(input: unknown) => Promise<unknown>>();
const mockCreateImpromptu =
  jest.fn<(input: unknown, now?: Date) => Promise<unknown>>();
const mockCount = jest.fn<(guild: string, user: string) => Promise<number>>();
let cap = 0;

const actualAudit = await import("../../src/web/audit.js");
jest.unstable_mockModule("../../src/web/audit.js", () => ({
  recordAudit: mockRecordAudit,
  boundAuditEntry: actualAudit.boundAuditEntry,
}));
jest.unstable_mockModule("../../src/utils/logger.js", () => ({
  default: { info: jest.fn(), warn: jest.fn(), error: jest.fn() },
}));
jest.unstable_mockModule("../../src/services/config-service.js", () => ({
  ConfigService: {
    getInstance: (): unknown => ({
      getString: async (key: string, fallback: string) =>
        key === "events.category_id"
          ? "cat-1"
          : key === "events.timezone"
            ? "UTC"
            : fallback,
      getNumber: async (key: string, fallback: number) =>
        key === "events.max_active_per_host" ? cap : fallback,
      getBoolean: async () => false,
      getBooleanStrict: async (key: string) => key === "events.enabled",
      registerReloadCallback: jest.fn(),
    }),
  },
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
const actualHost = await import("../../src/web/event-host.js");
jest.unstable_mockModule("../../src/web/event-host.js", () => ({
  ...actualHost,
  countOpenHostEvents: mockCount,
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
      requireScopeMiddleware("host"),
      createMeNewEventRouter({} as never),
    ],
    "/me/events/new",
  );
});

afterAll(async () => {
  await harness.close();
});

const planned = {
  title: "Game night",
  date: new Date(Date.now() + 86_400_000).toISOString().slice(0, 10),
  time: "12:00",
  timezone: "UTC",
  duration: "90",
};
const now = { title: "Right now", when: "now" };

beforeEach(() => {
  jest.clearAllMocks();
  cap = 0;
  mockCount.mockResolvedValue(0);
  current = createTestSession({
    discordUserId: HOST,
    guildId: GUILD,
    role: "user",
    scopes: ["member", "host"],
  });
  mockCreateEvent.mockImplementation(async (input) => ({
    _id: EVENT_ID,
    startTime: (input as { startTime: Date }).startTime,
  }));
  mockCreateImpromptu.mockImplementation(async (_input, at) => ({
    event: {
      _id: EVENT_ID,
      startTime: new Date((at ?? new Date()).getTime() + 30_000),
    },
    started: true,
  }));
});

const flashOf = async (
  body: Record<string, string>,
): Promise<ReturnType<typeof parseFlashRedirect>> =>
  parseFlashRedirect((await harness.post("", body)).headers.get("location"));

describe("events.max_active_per_host", () => {
  it.each([
    ["a scheduled event", planned],
    ["a Now event", now],
  ])("allows %s while under the limit", async (_n, body) => {
    cap = 3;
    mockCount.mockResolvedValue(2);
    const flash = await flashOf(body);
    expect(flash.type).toBe("ok");
    expect(flash.path).toBe(`/me/events/${EVENT_ID}/host`);
  });

  it.each([
    ["a scheduled event", planned],
    ["a Now event", now],
  ])(
    "refuses %s at the limit, names it and creates nothing",
    async (_n, body) => {
      cap = 3;
      mockCount.mockResolvedValue(3);
      const flash = await flashOf(body);
      expect(flash.type).toBe("err");
      expect(flash.path).toBe("/me/events/new");
      expect(flash.msg).toContain("limit is 3");
      expect(flash.msg).toContain("already have 3 open events");
      expect(mockCreateEvent).not.toHaveBeenCalled();
      expect(mockCreateImpromptu).not.toHaveBeenCalled();
      expect(mockCount).toHaveBeenCalledWith(GUILD, HOST);
    },
  );

  it("uses the singular for a limit of one", async () => {
    cap = 1;
    mockCount.mockResolvedValue(1);
    expect((await flashOf(planned)).msg).toContain(
      "already have 1 open event,",
    );
  });

  it("audits the refusal as event.host.limit", async () => {
    cap = 2;
    mockCount.mockResolvedValue(2);
    await harness.post("", now);
    const [session, entry] = mockRecordAudit.mock.calls[0] as [
      { discordUserId: string },
      { action: string; result: string; details: Record<string, unknown> },
    ];
    expect(session.discordUserId).toBe(HOST);
    expect(entry.action).toBe("event.host.limit");
    expect(entry.result).toBe("failure");
    expect(entry.details).toMatchObject({
      via: "host",
      when: "now",
      limit: 2,
      open: 2,
    });
  });

  it("treats 0 as no limit and does not even count", async () => {
    cap = 0;
    mockCount.mockResolvedValue(500);
    expect((await flashOf(planned)).type).toBe("ok");
    expect((await flashOf(now)).type).toBe("ok");
    expect(mockCount).not.toHaveBeenCalled();
  });

  it("never limits an administrator", async () => {
    cap = 1;
    mockCount.mockResolvedValue(9);
    current = createTestSession({
      discordUserId: HOST,
      guildId: GUILD,
      role: "admin",
      scopes: ["member", "host", "moderator", "admin"],
    });
    expect((await flashOf(planned)).type).toBe("ok");
    expect(mockCount).not.toHaveBeenCalled();
  });

  it("applies a changed setting to the next attempt without a restart", async () => {
    mockCount.mockResolvedValue(2);
    cap = 5;
    expect((await flashOf(planned)).type).toBe("ok");
    cap = 2;
    expect((await flashOf(planned)).type).toBe("err");
    cap = 0;
    expect((await flashOf(planned)).type).toBe("ok");
  });

  it("refuses and creates nothing when the open events cannot be counted", async () => {
    cap = 2;
    mockCount.mockRejectedValue(new Error("db down"));
    const flash = await flashOf(planned);
    expect(flash.type).toBe("err");
    expect(flash.msg).toContain("nothing was created");
    expect(mockCreateEvent).not.toHaveBeenCalled();
  });
});
