/**
 * Editing an occurrence of a recurring event (#1298): the scope it needs, the
 * series template and anchor it writes, and the refusals that keep the series
 * from losing or duplicating an occurrence.
 */
import {
  describe,
  it,
  expect,
  jest,
  beforeEach,
  afterEach,
} from "@jest/globals";

const configBoolean = jest.fn<(k: string, d?: boolean) => Promise<boolean>>();
jest.unstable_mockModule("../../src/services/config-service.js", () => ({
  ConfigService: {
    getInstance: jest.fn(() => ({
      registerReloadCallback: jest.fn(),
      getBoolean: configBoolean,
      getString: jest.fn(),
      getNumber: jest.fn(),
    })),
  },
}));
jest.unstable_mockModule("../../src/services/discord-logger.js", () => ({
  DiscordLogger: { getInstance: jest.fn() },
}));
jest.unstable_mockModule("../../src/models/event.js", () => ({
  Event: jest.fn(),
}));
jest.unstable_mockModule("../../src/utils/logger.js", () => ({
  default: {
    info: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
    debug: jest.fn(),
  },
}));

const { Event } = await import("../../src/models/event.js");
const EventStatics = Event as unknown as {
  findById: jest.Mock<(id: string) => unknown>;
  findOneAndUpdate: jest.Mock<(...a: unknown[]) => Promise<unknown>>;
};
const { EventService, anchorForOccurrence, computeOccurrenceStart } =
  await import("../../src/services/event-service.js");
const {
  eventEditVersion,
  parseEditScope,
  nextSeriesTemplate,
  isSeriesRow,
  seriesWriteFilter,
  EDIT_MESSAGES,
} = await import("../../src/services/event-edit.js");

const NOW = new Date("2030-01-01T12:00:00Z");

type Row = Record<string, unknown> & {
  startTime: Date;
  title: string;
  description: string;
  timezone: string;
  durationMinutes: number;
};

function series(over: Record<string, unknown> = {}): Row {
  return {
    _id: "65a000000000000000000001",
    guildId: "guild-1",
    title: "Game night",
    description: "Bring snacks",
    state: "scheduled",
    startTime: new Date("2030-01-04T20:00:00Z"),
    seriesStart: new Date("2030-01-04T20:00:00Z"),
    timezone: "UTC",
    durationMinutes: 120,
    channelId: null,
    recurrence: "weekly",
    seriesId: "s1",
    occurrenceIndex: 0,
    nextSpawned: false,
    reminderSent: true,
    nativeAdopted: false,
    ...over,
  } as Row;
}

describe("series edit rules (pure)", () => {
  it("reads a scope, and nothing else", () => {
    expect(parseEditScope("occurrence")).toBe("occurrence");
    expect(parseEditScope("following")).toBe("following");
    for (const bad of ["", "series", "Occurrence", "all", " following"]) {
      expect(parseEditScope(bad)).toBeNull();
    }
  });

  it("knows a series row by its cadence or its series id", () => {
    expect(isSeriesRow({ recurrence: "weekly" })).toBe(true);
    expect(isSeriesRow({ recurrence: "none", seriesId: "s" })).toBe(true);
    expect(isSeriesRow({ recurrence: "none", seriesId: null })).toBe(false);
  });

  it("moves the version with the series fields", () => {
    const base = eventEditVersion(series(), "full");
    for (const over of [
      { seriesStart: new Date("2030-01-04T21:00:00Z") },
      { nextSpawned: true },
      {
        seriesTemplate: {
          title: "x",
          description: "",
          durationMinutes: 1,
          timezone: "",
        },
      },
    ]) {
      expect(eventEditVersion(series(over), "full")).not.toBe(base);
    }
  });

  it("covers every series field of the version token in the write filter", () => {
    // The token and the conditional write must not drift: whatever moves the
    // token for a series row must change what the write matches. `nextSpawned`
    // is the one exception, by design: a row that has it is refused before the
    // write, and the filter always requires it not to be set.
    const tpl = {
      title: "x",
      description: "d",
      durationMinutes: 1,
      timezone: "UTC",
    };
    const base = series();
    const cases: Array<Record<string, unknown>> = [
      { seriesStart: new Date("2030-01-04T21:00:00Z") },
      { seriesTemplate: tpl },
    ];
    for (const over of cases) {
      expect(eventEditVersion(series(over), "full")).not.toBe(
        eventEditVersion(base, "full"),
      );
      expect(seriesWriteFilter(series(over))).not.toEqual(
        seriesWriteFilter(base),
      );
    }
    // Each template field counts.
    const withTpl = series({ seriesTemplate: tpl });
    for (const field of [
      "title",
      "description",
      "durationMinutes",
      "timezone",
    ]) {
      const changed = series({
        seriesTemplate: {
          ...tpl,
          [field]: field === "durationMinutes" ? 2 : "y",
        },
      });
      expect(eventEditVersion(changed, "full")).not.toBe(
        eventEditVersion(withTpl, "full"),
      );
      expect(seriesWriteFilter(changed)).not.toEqual(
        seriesWriteFilter(withTpl),
      );
    }
    expect(seriesWriteFilter(base)).toMatchObject({ seriesTemplate: null });
  });

  it("keeps an earlier one-off rename out of a 'following' template", () => {
    const row = series({
      title: "Renamed once",
      seriesTemplate: {
        title: "Game night",
        description: "Bring snacks",
        durationMinutes: 120,
        timezone: "UTC",
      },
    });
    const want = { ...row, description: "New text" } as never;
    expect(nextSeriesTemplate("following", row as never, want)).toEqual({
      title: "Game night",
      description: "New text",
      durationMinutes: 120,
      timezone: "UTC",
    });
  });
});

describe("anchorForOccurrence", () => {
  it("is the inverse of computeOccurrenceStart", () => {
    const start = new Date("2030-02-15T20:00:00Z");
    for (const recurrence of ["weekly", "biweekly", "monthly"] as const) {
      const anchor = anchorForOccurrence(start, recurrence, 3, "Europe/Oslo");
      expect(anchor).not.toBeNull();
      expect(
        computeOccurrenceStart(anchor!, recurrence, 3, "Europe/Oslo"),
      ).toEqual(start);
    }
  });

  it("keeps the existing anchor's day when it still reproduces the start (a monthly 31st)", () => {
    // 28 Feb is occurrence 1 of a series anchored on 31 Jan. Several anchors
    // reproduce it; the one on the 31st is the series, and 31 Mar must follow.
    const start = new Date("2030-02-28T21:00:00Z");
    const prefer = new Date("2030-01-31T20:00:00Z");
    const anchor = anchorForOccurrence(start, "monthly", 1, "UTC", prefer);
    expect(anchor).toEqual(new Date("2030-01-31T21:00:00Z"));
    expect(computeOccurrenceStart(anchor!, "monthly", 2, "UTC")).toEqual(
      new Date("2030-03-31T21:00:00Z"),
    );
    // Without it, the first anchor that works is the 28th.
    expect(anchorForOccurrence(start, "monthly", 1, "UTC")).toEqual(
      new Date("2030-01-28T21:00:00Z"),
    );
  });

  it("falls back to the inverse when the preferred day no longer reproduces the start", () => {
    const anchor = anchorForOccurrence(
      new Date("2030-03-15T20:00:00Z"),
      "monthly",
      2,
      "UTC",
      new Date("2030-01-31T20:00:00Z"),
    );
    expect(anchor).toEqual(new Date("2030-01-15T20:00:00Z"));
  });

  it("is null when no anchor reproduces the start", () => {
    // Occurrence 1 of a monthly series on 28 Feb: the anchor would be 28 Jan,
    // which does reproduce it. Occurrence 1 on 31 Mar needs an anchor day of
    // 31 in February: it does not exist, and the clamped 28th gives 28 Mar.
    expect(
      anchorForOccurrence(
        new Date("2030-03-31T20:00:00Z"),
        "monthly",
        1,
        "UTC",
      ),
    ).toBeNull();
  });
});

describe("EventService.editEvent on a recurring event", () => {
  type Priv = {
    nativeSync: { syncEvent: jest.Mock; linkedStatus: jest.Mock };
    updateAnnouncement: jest.Mock;
  };
  let stored: Row;
  let service: InstanceType<typeof EventService> & Priv;

  beforeEach(() => {
    EventService.reset();
    service = EventService.getInstance({
      guilds: { fetch: jest.fn(async () => ({ id: "guild-1" })) },
    } as never) as never;
    configBoolean.mockReset().mockResolvedValue(true);
    service.nativeSync = {
      syncEvent: jest.fn(async () => undefined),
      linkedStatus: jest.fn(async () => "scheduled"),
    };
    service.updateAnnouncement = jest.fn(async () => true);
    stored = series();
    EventStatics.findById = jest.fn(() => ({
      catch: () => Promise.resolve({ ...stored }),
    }));
    EventStatics.findOneAndUpdate = jest.fn(
      async (_f: unknown, u: unknown) => ({
        ...stored,
        ...(u as { $set: Record<string, unknown> }).$set,
      }),
    );
  });
  afterEach(() => {
    EventService.reset();
  });

  const input = (
    changes: Record<string, unknown>,
    scope: unknown,
    over: Record<string, unknown> = {},
  ) => ({
    eventId: "65a000000000000000000001",
    guildId: "guild-1",
    expectedVersion: eventEditVersion(stored, "full"),
    renderedMode: "full",
    now: NOW,
    scope,
    changes: {
      title: stored.title,
      description: stored.description,
      startTime: stored.startTime,
      timezone: stored.timezone,
      durationMinutes: stored.durationMinutes,
      ...changes,
    },
    ...over,
  });
  const written = (): { filter: Record<string, unknown>; set: Row } => {
    const [filter, update] = EventStatics.findOneAndUpdate.mock
      .calls[0] as Array<Record<string, unknown>>;
    return {
      filter,
      set: (update as { $set: Row }).$set,
    };
  };

  it("refuses a missing or unknown scope and writes nothing", async () => {
    for (const scope of [
      undefined,
      null,
      "",
      "series",
      "all",
      "OCCURRENCE",
      " following",
    ]) {
      expect(
        await service.editEvent(input({ title: "New" }, scope) as never),
      ).toMatchObject({
        ok: false,
        code: "scope",
        message: EDIT_MESSAGES.scope,
      });
    }
    expect(EventStatics.findOneAndUpdate).not.toHaveBeenCalled();
  });

  it("ignores a scope on a one-off event", async () => {
    stored = series({ recurrence: "none", seriesId: null });
    const res = await service.editEvent(
      input({ title: "New" }, undefined) as never,
    );
    expect(res.ok).toBe(true);
    expect(written().set).not.toHaveProperty("seriesTemplate");
    expect(written().filter).not.toHaveProperty("nextSpawned");
  });

  it("'occurrence' snapshots the series' values so the next occurrence keeps them", async () => {
    const res = await service.editEvent(
      input(
        { title: "Special night", durationMinutes: 30 },
        "occurrence",
      ) as never,
    );
    expect(res).toMatchObject({ ok: true, scope: "occurrence" });
    const { set, filter } = written();
    expect(set.title).toBe("Special night");
    expect(set.seriesTemplate).toEqual({
      title: "Game night",
      description: "Bring snacks",
      durationMinutes: 120,
      timezone: "UTC",
    });
    expect(set).not.toHaveProperty("seriesStart");
    expect(filter).toMatchObject({
      seriesStart: stored.seriesStart,
      nextSpawned: { $ne: true },
    });
  });

  it("'occurrence' keeps a template that is already stored", async () => {
    const tpl = {
      title: "Old series name",
      description: "",
      durationMinutes: 60,
      timezone: "UTC",
    };
    stored = series({ seriesTemplate: tpl });
    await service.editEvent(
      input({ description: "Only now" }, "occurrence") as never,
    );
    expect(written().set.seriesTemplate).toEqual(tpl);
  });

  it("'occurrence' pins an anchor-less row so a move cannot drag the series", async () => {
    stored = series({ seriesStart: null });
    await service.editEvent(
      input(
        { startTime: new Date("2030-01-05T20:00:00Z") },
        "occurrence",
      ) as never,
    );
    expect(written().set.seriesStart).toEqual(new Date("2030-01-04T20:00:00Z"));
  });

  it("'occurrence' refuses a start at or after the next slot", async () => {
    for (const startTime of [
      new Date("2030-01-11T20:00:00Z"),
      new Date("2030-01-20T20:00:00Z"),
    ]) {
      expect(
        await service.editEvent(input({ startTime }, "occurrence") as never),
      ).toMatchObject({ ok: false, code: "past-next-slot" });
    }
    expect(EventStatics.findOneAndUpdate).not.toHaveBeenCalled();
    const ok = await service.editEvent(
      input(
        { startTime: new Date("2030-01-10T20:00:00Z") },
        "occurrence",
      ) as never,
    );
    expect(ok.ok).toBe(true);
  });

  it("'following' writes only the changed fields into the template", async () => {
    stored = series({
      title: "Renamed once",
      seriesTemplate: {
        title: "Game night",
        description: "Bring snacks",
        durationMinutes: 120,
        timezone: "UTC",
      },
    });
    await service.editEvent(
      input({ durationMinutes: 45 }, "following") as never,
    );
    expect(written().set.seriesTemplate).toEqual({
      title: "Game night",
      description: "Bring snacks",
      durationMinutes: 45,
      timezone: "UTC",
    });
  });

  it("'following' moves the anchor so occurrence N lands on the new start", async () => {
    stored = series({
      occurrenceIndex: 2,
      startTime: new Date("2030-01-18T20:00:00Z"),
      seriesStart: new Date("2030-01-04T20:00:00Z"),
    });
    const startTime = new Date("2030-01-18T21:30:00Z");
    await service.editEvent(input({ startTime }, "following") as never);
    const anchor = written().set.seriesStart as unknown as Date;
    expect(anchor).toEqual(new Date("2030-01-04T21:30:00Z"));
    expect(computeOccurrenceStart(anchor, "weekly", 2, "UTC")).toEqual(
      startTime,
    );
  });

  it("'following' with a time-only change keeps a monthly series on its 31st", async () => {
    stored = series({
      recurrence: "monthly",
      occurrenceIndex: 1,
      startTime: new Date("2030-02-28T20:00:00Z"),
      seriesStart: new Date("2030-01-31T20:00:00Z"),
    });
    await service.editEvent(
      input(
        { startTime: new Date("2030-02-28T21:00:00Z") },
        "following",
      ) as never,
    );
    const anchor = written().set.seriesStart as unknown as Date;
    expect(anchor).toEqual(new Date("2030-01-31T21:00:00Z"));
    expect(computeOccurrenceStart(anchor, "monthly", 2, "UTC")).toEqual(
      new Date("2030-03-31T21:00:00Z"),
    );
  });

  it("'occurrence' refuses a start or duration that would run into the next slot", async () => {
    // The next weekly slot is 11 Jan 20:00. 19:30 is before it, but a two-hour
    // event from 19:30 ends at 21:30, and the 20:00 slot would be skipped.
    expect(
      await service.editEvent(
        input(
          { startTime: new Date("2030-01-11T19:30:00Z") },
          "occurrence",
        ) as never,
      ),
    ).toMatchObject({ ok: false, code: "past-next-slot" });
    // A duration-only edit of an occurrence moved earlier is checked too.
    stored = series({ startTime: new Date("2030-01-11T18:00:00Z") });
    expect(
      await service.editEvent(
        input({ durationMinutes: 180 }, "occurrence") as never,
      ),
    ).toMatchObject({ ok: false, code: "past-next-slot" });
    expect(EventStatics.findOneAndUpdate).not.toHaveBeenCalled();
    expect(
      (
        await service.editEvent(
          input({ durationMinutes: 90 }, "occurrence") as never,
        )
      ).ok,
    ).toBe(true);
  });

  it("'following' refuses a duration that would run into the next slot, and leaves a description-only edit alone", async () => {
    expect(
      await service.editEvent(
        input({ durationMinutes: 1440 * 8 }, "following") as never,
      ),
    ).toMatchObject({ ok: false, code: "past-next-slot" });
    // An occurrence that already overlaps its next slot can still get a new
    // description: the end did not change.
    stored = series({ durationMinutes: 1440 * 8 });
    expect(
      (
        await service.editEvent(
          input({ description: "New" }, "following") as never,
        )
      ).ok,
    ).toBe(true);
  });

  it("'following' refuses a start no anchor can reproduce, writing nothing", async () => {
    stored = series({
      recurrence: "monthly",
      occurrenceIndex: 1,
      startTime: new Date("2030-03-28T20:00:00Z"),
      seriesStart: new Date("2030-02-28T20:00:00Z"),
    });
    expect(
      await service.editEvent(
        input(
          { startTime: new Date("2030-03-31T20:00:00Z") },
          "following",
        ) as never,
      ),
    ).toMatchObject({ ok: false, code: "anchor" });
    expect(EventStatics.findOneAndUpdate).not.toHaveBeenCalled();
  });

  it("refuses an occurrence whose successor already exists", async () => {
    stored = series({ nextSpawned: true });
    expect(
      await service.editEvent(input({ title: "New" }, "following") as never),
    ).toMatchObject({ ok: false, code: "series-advanced" });
    expect(EventStatics.findOneAndUpdate).not.toHaveBeenCalled();
  });

  it("reports a conflict when the conditional write matches nothing", async () => {
    EventStatics.findOneAndUpdate = jest.fn(async () => null);
    expect(
      await service.editEvent(input({ title: "New" }, "following") as never),
    ).toMatchObject({ ok: false, code: "conflict" });
  });
});
