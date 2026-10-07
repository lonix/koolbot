import { describe, it, expect, jest, beforeEach } from "@jest/globals";

const getBooleanMock =
  jest.fn<(key: string, def: boolean) => Promise<boolean>>();
const getStringMock = jest.fn<(key: string, def: string) => Promise<string>>();

jest.unstable_mockModule("../../src/services/config-service.js", () => ({
  ConfigService: {
    getInstance: jest.fn(() => ({
      getBoolean: getBooleanMock,
      getString: getStringMock,
      getNumber: jest.fn(),
      registerReloadCallback: jest.fn(),
    })),
  },
}));

jest.unstable_mockModule("../../src/utils/logger.js", () => ({
  default: {
    info: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
    debug: jest.fn(),
  },
}));

// Keep the real `CronTime` so the schedule is validated for real, but stub
// `CronJob` so no test arms a live timer.
const { CronTime } = await import("cron");
jest.unstable_mockModule("cron", () => ({
  CronTime,
  CronJob: class {
    start(): void {}
    stop(): void {}
    nextDate(): Date {
      return new Date();
    }
  },
}));

const dueQuery: Record<string, unknown> = {};
const caseFind = jest.fn();
jest.unstable_mockModule("../../src/models/moderation-case.js", () => ({
  ModerationCase: { find: caseFind },
  SYSTEM_ACTOR: "system",
  LIVE_CASE_STATUSES: ["open", "under_review"],
  TERMINAL_CASE_STATUSES: ["upheld", "lifted", "expired"],
}));

const markUnderReview = jest.fn<(c: unknown, by: string) => Promise<unknown>>();
jest.unstable_mockModule(
  "../../src/services/moderation-case-service.js",
  () => ({
    ModerationCaseService: {
      getInstance: jest.fn(() => ({
        isEnabled: async () =>
          (await getBooleanMock("moderation.enabled", false)) &&
          (await getBooleanMock("moderation.cases.enabled", false)),
        markUnderReview,
      })),
    },
  }),
);

const isReady = jest.fn<() => boolean>();
const isCategoryEnabled = jest.fn<(t: string) => Promise<boolean>>();
const logToChannel =
  jest.fn<(t: string, m: Record<string, unknown>) => Promise<boolean>>();
jest.unstable_mockModule("../../src/services/discord-logger.js", () => ({
  DiscordLogger: {
    getInstance: jest.fn(() => ({ isReady, isCategoryEnabled, logToChannel })),
  },
}));

const { ModerationCaseReviewService } =
  await import("../../src/services/moderation-case-review-service.js");

function dueRows(rows: unknown[]): void {
  for (const m of ["sort", "limit", "lean"])
    dueQuery[m] = jest.fn(() => dueQuery);
  dueQuery.exec = jest.fn(async () => rows);
  caseFind.mockImplementation(() => dueQuery);
}

const row = (n: number, extra: Record<string, unknown> = {}) => ({
  _id: `id-${n}`,
  guildId: "g1",
  caseNumber: n,
  userId: `user-${n}`,
  action: "ban",
  reviewAt: new Date("2026-03-01T00:00:00Z"),
  updatedAt: new Date("2026-03-01T00:00:00Z"),
  ...extra,
});

function service(): InstanceType<typeof ModerationCaseReviewService> {
  ModerationCaseReviewService.reset();
  return ModerationCaseReviewService.getInstance({ tag: "client" } as never);
}

function enable(moderation: boolean, cases: boolean): void {
  getBooleanMock.mockImplementation(async (key) =>
    key === "moderation.enabled" ? moderation : cases,
  );
}

beforeEach(() => {
  jest.clearAllMocks();
  enable(true, true);
  getStringMock.mockImplementation(async (k, def) =>
    k === "GUILD_ID" ? "g1" : def,
  );
  isReady.mockReturnValue(true);
  isCategoryEnabled.mockResolvedValue(true);
  logToChannel.mockResolvedValue(true);
  markUnderReview.mockImplementation(async (c) => c);
});

describe("ModerationCaseReviewService", () => {
  it.each([
    [false, false],
    [true, false],
    [false, true],
  ])(
    "does nothing unless both gates are on (moderation=%s, cases=%s)",
    async (m, c) => {
      enable(m, c);
      dueRows([row(1)]);
      expect(await service().runNow()).toBeNull();
      expect(caseFind).not.toHaveBeenCalled();
      expect(markUnderReview).not.toHaveBeenCalled();
    },
  );

  it("selects only open cases whose review date has passed, oldest first", async () => {
    dueRows([]);
    await service().runNow();
    const filter = caseFind.mock.calls[0]?.[0] as Record<string, any>;
    expect(filter.status).toBe("open");
    expect(filter.reviewAt.$lte).toBeInstanceOf(Date);
    // Scoped to the configured guild, like the other scheduled services.
    expect(filter.guildId).toBe("g1");
    expect(dueQuery.sort).toHaveBeenCalledWith({ reviewAt: 1 });
  });

  it("flips each due case as the system and posts one digest naming them", async () => {
    dueRows([row(1), row(2)]);
    const summary = await service().runNow();

    expect(summary).toEqual({ due: 2, flipped: 2, notified: true });
    expect(markUnderReview).toHaveBeenCalledTimes(2);
    expect(markUnderReview.mock.calls[0]?.[1]).toBe("system");
    expect(logToChannel).toHaveBeenCalledTimes(1);
    const [type, message] = logToChannel.mock.calls[0] as [
      string,
      Record<string, string>,
    ];
    expect(type).toBe("moderation_review");
    expect(message.title).toContain("2 moderation cases");
    expect(message.description).toContain("Case #1");
    expect(message.description).toContain("<@user-2>");
  });

  it("does not post when nothing is due", async () => {
    dueRows([]);
    expect(await service().runNow()).toEqual({
      due: 0,
      flipped: 0,
      notified: false,
    });
    expect(logToChannel).not.toHaveBeenCalled();
  });

  it("notifies once: a case a racing decision already took is not announced", async () => {
    dueRows([row(1), row(2)]);
    markUnderReview.mockImplementation(async (c) =>
      (c as { caseNumber: number }).caseNumber === 1 ? null : c,
    );
    const summary = await service().runNow();
    expect(summary).toEqual({ due: 2, flipped: 1, notified: true });
    const message = logToChannel.mock.calls[0]?.[1] as Record<string, string>;
    expect(message.description).not.toContain("Case #1");
    expect(message.description).toContain("Case #2");
  });

  it("does not repeat the notice on the next tick", async () => {
    const svc = service();
    dueRows([row(1)]);
    await svc.runNow();
    // The case is now `under_review`, so the next query finds nothing.
    dueRows([]);
    await svc.runNow();
    expect(logToChannel).toHaveBeenCalledTimes(1);
  });

  it("still flips cases when the notice channel is off", async () => {
    isCategoryEnabled.mockResolvedValue(false);
    dueRows([row(1)]);
    expect(await service().runNow()).toEqual({
      due: 1,
      flipped: 1,
      notified: false,
    });
    expect(markUnderReview).toHaveBeenCalledTimes(1);
    expect(logToChannel).not.toHaveBeenCalled();
  });

  it("does not fail the run when the notice throws", async () => {
    logToChannel.mockRejectedValue(new Error("discord down"));
    dueRows([row(1)]);
    expect(await service().runNow()).toEqual({
      due: 1,
      flipped: 1,
      notified: false,
    });
  });

  it("aborts without querying when GUILD_ID is not configured", async () => {
    getStringMock.mockImplementation(async (_k, def) => def);
    dueRows([row(1)]);
    expect(await service().runNow()).toEqual({
      due: 0,
      flipped: 0,
      notified: false,
    });
    expect(caseFind).not.toHaveBeenCalled();
    expect(markUnderReview).not.toHaveBeenCalled();
    expect(logToChannel).not.toHaveBeenCalled();
  });

  it("reads its schedule from moderation.cases.review_cron", async () => {
    getStringMock.mockResolvedValue("0 6 * * *");
    await service().start();
    expect(getStringMock).toHaveBeenCalledWith(
      "moderation.cases.review_cron",
      "0 9 * * *",
    );
  });
});
