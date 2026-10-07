import { describe, it, expect, jest, beforeEach } from "@jest/globals";

const getBooleanMock =
  jest.fn<(key: string, def: boolean) => Promise<boolean>>();
const getNumberMock = jest.fn<(key: string, def: number) => Promise<number>>();

jest.unstable_mockModule("../../src/services/config-service.js", () => ({
  ConfigService: {
    getInstance: jest.fn(() => ({
      getBoolean: getBooleanMock,
      getNumber: getNumberMock,
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

const ENTRY_ID = "a".repeat(24);
const CASE_ID = "b".repeat(24);

/** A chainable query whose `exec`/`lean` resolve to `result`. */
function query<T>(result: T): Record<string, unknown> {
  const q: Record<string, unknown> = {};
  for (const m of ["sort", "limit", "lean", "select"]) q[m] = jest.fn(() => q);
  q.exec = jest.fn(async () => result);
  return q;
}

const caseFindOne = jest.fn();
const caseFindOneAndUpdate = jest.fn();
const caseExists = jest.fn();
const caseCreate = jest.fn();
const caseFind = jest.fn();
const counterFindOneAndUpdate = jest.fn();
const logFindOne = jest.fn();
const logFind = jest.fn();

jest.unstable_mockModule("../../src/models/moderation-case.js", () => ({
  ModerationCase: {
    findOne: caseFindOne,
    findOneAndUpdate: caseFindOneAndUpdate,
    exists: caseExists,
    create: caseCreate,
    find: caseFind,
  },
  ModerationCaseCounter: { findOneAndUpdate: counterFindOneAndUpdate },
  LIVE_CASE_STATUSES: ["open", "under_review"],
  TERMINAL_CASE_STATUSES: ["upheld", "lifted", "expired"],
  SYSTEM_ACTOR: "system",
}));
jest.unstable_mockModule("../../src/models/moderation-log.js", () => ({
  ModerationLog: { findOne: logFindOne, find: logFind },
}));

const { ModerationCaseService, ModerationCaseError } =
  await import("../../src/services/moderation-case-service.js");

const DAY = 24 * 60 * 60 * 1000;
const REVISION = 4;
const future = (days = 30): Date => new Date(Date.now() + days * DAY);

function service(): InstanceType<typeof ModerationCaseService> {
  ModerationCaseService.reset();
  return ModerationCaseService.getInstance({ tag: "client" } as never);
}

function liveCase(status: string, extra: Record<string, unknown> = {}) {
  return {
    _id: CASE_ID,
    guildId: "g1",
    caseNumber: 14,
    status,
    revision: REVISION,
    ...extra,
  };
}

/** Assert the promise rejects with a ModerationCaseError of this code. */
async function expectCode(p: Promise<unknown>, code: string): Promise<void> {
  const err = await p.then(
    () => null,
    (e: unknown) => e,
  );
  expect(err).toBeInstanceOf(ModerationCaseError);
  expect((err as InstanceType<typeof ModerationCaseError>).code).toBe(code);
}

beforeEach(() => {
  jest.clearAllMocks();
  getBooleanMock.mockImplementation(async (_k, def) => def);
  getNumberMock.mockImplementation(async (_k, def) => def);
  counterFindOneAndUpdate.mockImplementation(() => query({ seq: 14 }));
  caseExists.mockImplementation(async () => null);
  caseCreate.mockImplementation(async (doc: unknown) => ({
    _id: CASE_ID,
    ...(doc as object),
  }));
});

describe("isEnabled", () => {
  it("needs both moderation.enabled and moderation.cases.enabled", async () => {
    const cases: Array<[boolean, boolean, boolean]> = [
      [false, false, false],
      [true, false, false],
      [false, true, false],
      [true, true, true],
    ];
    for (const [moderation, caseGate, expected] of cases) {
      getBooleanMock.mockImplementation(async (key) =>
        key === "moderation.enabled" ? moderation : caseGate,
      );
      expect(await service().isEnabled()).toBe(expected);
    }
  });
});

describe("openCase", () => {
  const input = {
    guildId: "g1",
    entryId: ENTRY_ID,
    openedByUserId: "staff-1",
    reviewAt: future(),
    note: "first look in a month",
  };

  it("opens a case against a kick, copying the origin and numbering it", async () => {
    logFindOne.mockImplementation(() =>
      query({
        _id: ENTRY_ID,
        userId: "u1",
        moderatorId: "mod-1",
        action: "kick",
      }),
    );
    const created = (await service().openCase(input)) as unknown as Record<
      string,
      unknown
    >;

    expect(counterFindOneAndUpdate).toHaveBeenCalledWith(
      { guildId: "g1" },
      { $inc: { seq: 1 } },
      { upsert: true, new: true },
    );
    expect(created).toMatchObject({
      guildId: "g1",
      caseNumber: 14,
      userId: "u1",
      originEntryId: ENTRY_ID,
      action: "kick",
      status: "open",
      originModeratorId: "mod-1",
      openedByUserId: "staff-1",
      resolutionEntryId: null,
    });
    const events = created.events as Array<Record<string, unknown>>;
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      byUserId: "staff-1",
      from: "open",
      to: "open",
      outcome: null,
      note: "first look in a month",
    });
  });

  it("allows a case with no review date", async () => {
    logFindOne.mockImplementation(() =>
      query({ _id: ENTRY_ID, userId: "u1", action: "ban" }),
    );
    const created = (await service().openCase({
      ...input,
      reviewAt: null,
    })) as unknown as {
      reviewAt: Date | null;
    };
    expect(created.reviewAt).toBeNull();
  });

  it("refuses an entry that does not exist, or one from another guild", async () => {
    logFindOne.mockImplementation(() => query(null));
    await expectCode(service().openCase(input), "entry-not-found");
    expect(logFindOne).toHaveBeenCalledWith({ _id: ENTRY_ID, guildId: "g1" });
    await expectCode(
      service().openCase({ ...input, entryId: "nope" }),
      "entry-not-found",
    );
  });

  it.each(["warn", "timeout", "unban", "untimeout"])(
    "refuses a %s",
    async (action) => {
      logFindOne.mockImplementation(() =>
        query({ _id: ENTRY_ID, userId: "u1", action }),
      );
      await expectCode(service().openCase(input), "not-removal");
      expect(caseCreate).not.toHaveBeenCalled();
    },
  );

  it("refuses a review date in the past", async () => {
    logFindOne.mockImplementation(() =>
      query({ _id: ENTRY_ID, userId: "u1", action: "kick" }),
    );
    await expectCode(
      service().openCase({ ...input, reviewAt: new Date(Date.now() - 1000) }),
      "review-date-past",
    );
  });

  it("turns a duplicate-key loss against the unique entry index into the same refusal", async () => {
    logFindOne.mockImplementation(() =>
      query({ _id: ENTRY_ID, userId: "u1", action: "kick" }),
    );
    caseCreate.mockRejectedValue(
      Object.assign(new Error("E11000 duplicate key"), { code: 11000 }),
    );
    await expectCode(service().openCase(input), "already-has-case");
    caseCreate.mockRejectedValue(new Error("mongo down"));
    await expect(service().openCase(input)).rejects.toThrow("mongo down");
  });

  it("refuses a second case against the same entry without taking a number", async () => {
    logFindOne.mockImplementation(() =>
      query({ _id: ENTRY_ID, userId: "u1", action: "kick" }),
    );
    caseExists.mockImplementation(async () => ({ _id: "x" }));
    await expectCode(service().openCase(input), "already-has-case");
    expect(counterFindOneAndUpdate).not.toHaveBeenCalled();
  });
});

describe("decide", () => {
  const base = {
    guildId: "g1",
    caseId: CASE_ID,
    byUserId: "staff-2",
    note: null,
  };

  function mockCurrent(status: string): void {
    caseFindOne.mockImplementation(() => query(liveCase(status)));
    caseFindOneAndUpdate.mockImplementation(() =>
      query({ ...liveCase(status), caseNumber: 14 }),
    );
  }

  function lastUpdate(): {
    filter: Record<string, unknown>;
    update: Record<string, any>;
  } {
    const [filter, update] = caseFindOneAndUpdate.mock.calls.at(-1) as [
      Record<string, unknown>,
      Record<string, any>,
    ];
    return { filter, update };
  }

  const legal: Array<{
    decision: "uphold" | "extend" | "permanent" | "readmit";
    from: string;
    to: string;
    outcome: string;
    keepsDate: boolean;
  }> = [
    {
      decision: "uphold",
      from: "under_review",
      to: "open",
      outcome: "upheld",
      keepsDate: true,
    },
    {
      decision: "uphold",
      from: "open",
      to: "open",
      outcome: "upheld",
      keepsDate: true,
    },
    {
      decision: "extend",
      from: "under_review",
      to: "open",
      outcome: "extended",
      keepsDate: true,
    },
    {
      decision: "extend",
      from: "open",
      to: "open",
      outcome: "extended",
      keepsDate: true,
    },
    {
      decision: "permanent",
      from: "under_review",
      to: "upheld",
      outcome: "permanent",
      keepsDate: false,
    },
    {
      decision: "permanent",
      from: "open",
      to: "upheld",
      outcome: "permanent",
      keepsDate: false,
    },
    {
      decision: "readmit",
      from: "under_review",
      to: "lifted",
      outcome: "readmitted",
      keepsDate: false,
    },
    {
      decision: "readmit",
      from: "open",
      to: "lifted",
      outcome: "readmitted",
      keepsDate: false,
    },
  ];

  it.each(legal)("$decision from $from lands in $to", async (t) => {
    mockCurrent(t.from);
    const next = future(60);
    await service().decide({
      ...base,
      decision: t.decision,
      nextReviewAt: next,
      note: "n",
    });

    const { filter, update } = lastUpdate();
    // The conditional update is keyed on the status the case was read in.
    expect(filter).toMatchObject({
      _id: CASE_ID,
      guildId: "g1",
      status: t.from,
      // The version read, so an open → open decision cannot be applied twice.
      revision: REVISION,
    });
    expect(update.$inc).toEqual({ revision: 1 });
    expect(update.$set.status).toBe(t.to);
    expect(update.$set.reviewAt).toEqual(t.keepsDate ? next : null);
    expect(update.$push.events).toMatchObject({
      byUserId: "staff-2",
      from: t.from,
      to: t.to,
      outcome: t.outcome,
      note: "n",
    });
  });

  it("lets uphold schedule no further review", async () => {
    mockCurrent("under_review");
    await service().decide({ ...base, decision: "uphold", nextReviewAt: null });
    expect(lastUpdate().update.$set.reviewAt).toBeNull();
    expect(lastUpdate().update.$set.status).toBe("open");
  });

  it("requires a date to extend", async () => {
    mockCurrent("under_review");
    await expectCode(
      service().decide({ ...base, decision: "extend", nextReviewAt: null }),
      "review-date-required",
    );
    expect(caseFindOneAndUpdate).not.toHaveBeenCalled();
  });

  it.each(["uphold", "extend"] as const)(
    "refuses a past date on %s",
    async (decision) => {
      mockCurrent("under_review");
      await expectCode(
        service().decide({
          ...base,
          decision,
          nextReviewAt: new Date(Date.now() - 1000),
        }),
        "review-date-past",
      );
    },
  );

  it.each(["upheld", "lifted", "expired"])(
    "rejects every decision on a %s case",
    async (status) => {
      mockCurrent(status);
      for (const decision of [
        "uphold",
        "extend",
        "permanent",
        "readmit",
      ] as const) {
        await expectCode(
          service().decide({ ...base, decision, nextReviewAt: future() }),
          "terminal",
        );
      }
      expect(caseFindOneAndUpdate).not.toHaveBeenCalled();
    },
  );

  it("reports a missing case", async () => {
    caseFindOne.mockImplementation(() => query(null));
    await expectCode(
      service().decide({ ...base, decision: "permanent", nextReviewAt: null }),
      "case-not-found",
    );
    await expectCode(
      service().decide({
        ...base,
        caseId: "nope",
        decision: "permanent",
        nextReviewAt: null,
      }),
      "case-not-found",
    );
  });

  it("lets exactly one of two racing decisions win, and names the status the loser found", async () => {
    // Both staff read the case as under_review. The first conditional update
    // matches; by the time the second runs the case is already `lifted`, so
    // the status filter matches nothing.
    let claimed = false;
    caseFindOne.mockImplementation(() =>
      query(liveCase(claimed ? "lifted" : "under_review")),
    );
    caseFindOneAndUpdate.mockImplementation(() => {
      if (claimed) return query(null);
      claimed = true;
      return query(liveCase("lifted"));
    });

    const svc = service();
    // Pin the read to the pre-race status for both callers.
    caseFindOne.mockImplementationOnce(() => query(liveCase("under_review")));
    caseFindOne.mockImplementationOnce(() => query(liveCase("under_review")));

    const results = await Promise.allSettled([
      svc.decide({ ...base, decision: "readmit", nextReviewAt: null }),
      svc.decide({
        ...base,
        byUserId: "staff-3",
        decision: "permanent",
        nextReviewAt: null,
      }),
    ]);

    expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
    const loser = results.find(
      (r) => r.status === "rejected",
    ) as PromiseRejectedResult;
    expect(loser.reason).toBeInstanceOf(ModerationCaseError);
    expect(loser.reason.code).toBe("status-changed");
    expect(loser.reason.foundStatus).toBe("lifted");
    expect(loser.reason.message).toContain("lifted");
  });
});

describe("decide: open → open races", () => {
  it("lets exactly one of two concurrent decisions win, though the status never changes", async () => {
    // Both staff read the case as `open` at the same revision. The first
    // conditional update matches and bumps the revision; the second filter
    // still carries the old one, so it matches nothing even though the
    // status is still `open` — and even if both land in the same millisecond.
    let revision = REVISION;
    caseFindOne.mockImplementation(() => query(liveCase("open", { revision })));
    caseFindOneAndUpdate.mockImplementation((filter: Record<string, any>) => {
      if (filter.revision !== revision) return query(null);
      revision += 1;
      return query(liveCase("open", { revision }));
    });

    const svc = service();
    caseFindOne.mockImplementationOnce(() => query(liveCase("open")));
    caseFindOne.mockImplementationOnce(() => query(liveCase("open")));
    const results = await Promise.allSettled([
      svc.decide({
        guildId: "g1",
        caseId: CASE_ID,
        decision: "uphold",
        byUserId: "s1",
        nextReviewAt: future(),
        note: "a",
      }),
      svc.decide({
        guildId: "g1",
        caseId: CASE_ID,
        decision: "extend",
        byUserId: "s2",
        nextReviewAt: future(),
        note: "b",
      }),
    ]);

    expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
    const loser = results.find(
      (r) => r.status === "rejected",
    ) as PromiseRejectedResult;
    expect(loser.reason.code).toBe("status-changed");
    expect(loser.reason.foundStatus).toBe("open");
    expect(loser.reason.message).toContain("just decided by someone else");
  });
});

describe("markUnderReview", () => {
  it("only flips an open case whose review has come due", async () => {
    caseFindOneAndUpdate.mockImplementation(() =>
      query(liveCase("under_review")),
    );
    const flipped = await service().markUnderReview(
      { _id: CASE_ID as never, guildId: "g1" },
      "system",
    );
    expect(flipped).not.toBeNull();
    const [filter, update] = caseFindOneAndUpdate.mock.calls[0] as [
      Record<string, any>,
      Record<string, any>,
    ];
    expect(filter.status).toBe("open");
    expect(filter.reviewAt.$lte).toBeInstanceOf(Date);
    expect(update.$set.status).toBe("under_review");
    expect(update.$inc).toEqual({ revision: 1 });
    expect(update.$push.events).toMatchObject({
      byUserId: "system",
      from: "open",
      to: "under_review",
      outcome: null,
    });
  });

  it("returns null when someone got there first", async () => {
    caseFindOneAndUpdate.mockImplementation(() => query(null));
    expect(
      await service().markUnderReview(
        { _id: CASE_ID as never, guildId: "g1" },
        "system",
      ),
    ).toBeNull();
  });
});

describe("getQueue", () => {
  it("builds the four groups from the right filters, scoped to the guild", async () => {
    caseFind.mockImplementation(() => query([]));
    const now = new Date("2026-06-01T00:00:00Z");
    await service().getQueue("g1", now);

    const filters = caseFind.mock.calls.map((c) => c[0] as Record<string, any>);
    expect(filters).toHaveLength(5);
    for (const f of filters) expect(f.guildId).toBe("g1");

    const [overdue, soon, scheduled, indefinite, resolved] = filters;
    expect(overdue.status).toEqual({ $in: ["open", "under_review"] });
    expect(overdue.reviewAt).toEqual({ $lte: now });
    expect(soon.status).toBe("open");
    expect(soon.reviewAt.$gt).toEqual(now);
    expect(soon.reviewAt.$lte).toEqual(new Date(now.getTime() + 7 * DAY));
    // Beyond the look-ahead window: still open and decidable, so it needs a group.
    expect(scheduled).toMatchObject({
      status: "open",
      reviewAt: { $gt: new Date(now.getTime() + 7 * DAY) },
    });
    expect(indefinite).toMatchObject({ status: "open", reviewAt: null });
    expect(resolved.status).toEqual({ $in: ["upheld", "lifted", "expired"] });
    expect(resolved.updatedAt.$gte).toEqual(new Date(now.getTime() - 30 * DAY));
  });
});

describe("lookups", () => {
  it("keys cases by the entry that opened them", async () => {
    caseFind.mockImplementation(() =>
      query([{ originEntryId: ENTRY_ID, caseNumber: 3 }]),
    );
    const map = await service().getCasesForEntries("g1", [ENTRY_ID as never]);
    expect(map.get(ENTRY_ID)).toMatchObject({ caseNumber: 3 });
    expect(await service().getCasesForEntries("g1", [])).toEqual(new Map());
  });

  it("falls back to 90 days when the default window is unusable", async () => {
    getNumberMock.mockResolvedValue(-5);
    expect(await service().getDefaultReviewDays()).toBe(90);
    getNumberMock.mockResolvedValue(0.5);
    expect(await service().getDefaultReviewDays()).toBe(90);
    getNumberMock.mockResolvedValue(30);
    expect(await service().getDefaultReviewDays()).toBe(30);
  });

  it("normalises a stored default to the whole days the forms accept", async () => {
    getNumberMock.mockResolvedValue(1.5);
    expect(await service().getDefaultReviewDays()).toBe(1);
    getNumberMock.mockResolvedValue(5000);
    expect(await service().getDefaultReviewDays()).toBe(3650);
  });
});
