import { describe, it, expect, jest, beforeEach } from "@jest/globals";
import { ChannelType } from "discord.js";

// The event-service module registers a config reload callback and touches a
// Mongoose model at import time. Mock the heavy dependencies so the pure
// helpers can be imported and exercised in isolation (mirrors the birthday
// service test).
jest.unstable_mockModule("../../src/services/config-service.js", () => ({
  ConfigService: {
    getInstance: jest.fn(() => ({
      registerReloadCallback: jest.fn(),
      getBoolean: jest.fn(),
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
const EventMock = Event as unknown as jest.Mock & {
  find: jest.Mock;
  findById: jest.Mock;
  findByIdAndUpdate: jest.Mock;
  findOneAndUpdate: jest.Mock;
};

const {
  EventService,
  computeEndTime,
  parseEventDateTime,
  countRsvps,
  shouldCreateChannel,
  shouldSendReminder,
  shouldEndEvent,
  shouldCleanupChannel,
  effectiveEndTime,
  canonicalEventId,
  formatEventWhen,
  computeOccurrenceStart,
  isRecurring,
  recurrenceLabel,
  RecurrenceDisabledError,
} = await import("../../src/services/event-service.js");

const MIN = 60 * 1000;

function view(overrides: Record<string, unknown> = {}): {
  state: "scheduled" | "active" | "ended" | "cancelled";
  startTime: Date;
  durationMinutes: number;
  channelId: string | null;
  reminderSent: boolean;
} {
  return {
    state: "scheduled",
    startTime: new Date("2026-07-04T20:00:00Z"),
    durationMinutes: 120,
    channelId: null,
    reminderSent: false,
    ...overrides,
  } as never;
}

describe("computeEndTime", () => {
  it("adds the duration in minutes", () => {
    const start = new Date("2026-07-04T20:00:00Z");
    expect(computeEndTime(start, 120).toISOString()).toBe(
      "2026-07-04T22:00:00.000Z",
    );
  });
  it("treats a negative duration as zero", () => {
    const start = new Date("2026-07-04T20:00:00Z");
    expect(computeEndTime(start, -30).getTime()).toBe(start.getTime());
  });
});

describe("parseEventDateTime", () => {
  it("interprets wall-clock time in UTC", () => {
    const d = parseEventDateTime("2026-07-04", "20:00", "UTC");
    expect(d?.toISOString()).toBe("2026-07-04T20:00:00.000Z");
  });
  it("applies a zone offset (America/New_York, EDT = UTC-4)", () => {
    const d = parseEventDateTime("2026-07-04", "20:00", "America/New_York");
    expect(d?.toISOString()).toBe("2026-07-05T00:00:00.000Z");
  });
  it("rejects a malformed date", () => {
    expect(parseEventDateTime("2026-7-4", "20:00", "UTC")).toBeNull();
  });
  it("rejects a malformed time", () => {
    expect(parseEventDateTime("2026-07-04", "8pm", "UTC")).toBeNull();
  });
  it("rejects an impossible calendar date", () => {
    expect(parseEventDateTime("2026-02-30", "12:00", "UTC")).toBeNull();
  });
  it("rejects an out-of-range hour that rolls over", () => {
    expect(parseEventDateTime("2026-07-04", "25:00", "UTC")).toBeNull();
  });
});

describe("countRsvps", () => {
  it("tallies each response type", () => {
    const counts = countRsvps([
      { status: "going" },
      { status: "going" },
      { status: "maybe" },
      { status: "cant" },
    ]);
    expect(counts).toEqual({ going: 2, maybe: 1, cant: 1 });
  });
  it("returns zeros for an empty list", () => {
    expect(countRsvps([])).toEqual({ going: 0, maybe: 0, cant: 0 });
  });
});

describe("shouldCreateChannel", () => {
  const lead = 15 * MIN;
  it("fires once within the lead window before start", () => {
    const now = new Date("2026-07-04T19:50:00Z"); // 10 min before start
    expect(shouldCreateChannel(view(), now, lead)).toBe(true);
  });
  it("does not fire before the lead window opens", () => {
    const now = new Date("2026-07-04T19:00:00Z"); // 60 min before
    expect(shouldCreateChannel(view(), now, lead)).toBe(false);
  });
  it("does not fire once a channel already exists", () => {
    const now = new Date("2026-07-04T19:50:00Z");
    expect(shouldCreateChannel(view({ channelId: "c1" }), now, lead)).toBe(
      false,
    );
  });
  it("does not fire after the event has ended", () => {
    const now = new Date("2026-07-04T23:00:00Z"); // past end (22:00)
    expect(shouldCreateChannel(view(), now, lead)).toBe(false);
  });
  it("does not fire for a cancelled event", () => {
    const now = new Date("2026-07-04T19:50:00Z");
    expect(shouldCreateChannel(view({ state: "cancelled" }), now, lead)).toBe(
      false,
    );
  });

  describe("per-event channel lead time (#1188)", () => {
    const sixtyBefore = new Date("2026-07-04T19:00:00Z");
    const fiveBefore = new Date("2026-07-04T19:55:00Z");

    it("uses the event's own lead instead of the global one", () => {
      const own = view({ channelLeadMinutes: 90 });
      expect(shouldCreateChannel(own, sixtyBefore, lead)).toBe(true);
      expect(shouldCreateChannel(view(), sixtyBefore, lead)).toBe(false);
    });

    it("can open later than the global lead", () => {
      const own = view({ channelLeadMinutes: 5 });
      expect(
        shouldCreateChannel(own, new Date("2026-07-04T19:50:00Z"), lead),
      ).toBe(false);
      expect(shouldCreateChannel(own, fiveBefore, lead)).toBe(true);
    });

    it("0 means at the start, not the global lead", () => {
      const own = view({ channelLeadMinutes: 0 });
      expect(shouldCreateChannel(own, fiveBefore, lead)).toBe(false);
      expect(
        shouldCreateChannel(own, new Date("2026-07-04T20:00:00Z"), lead),
      ).toBe(true);
    });

    it("null and a missing field (an old row) fall back to the global lead", () => {
      const now = new Date("2026-07-04T19:50:00Z");
      expect(
        shouldCreateChannel(view({ channelLeadMinutes: null }), now, lead),
      ).toBe(true);
      expect(shouldCreateChannel(view(), sixtyBefore, lead)).toBe(false);
    });

    it("still sends the reminder when the channel opens before the reminder window", () => {
      // The channel makes the event "active" earlier; the reminder does not
      // depend on the state staying "scheduled".
      const reminder = 30 * MIN;
      const twentyBefore = new Date("2026-07-04T19:40:00Z");
      expect(
        shouldSendReminder(
          view({ state: "active", channelLeadMinutes: 90 }),
          twentyBefore,
          reminder,
        ),
      ).toBe(true);
    });
  });
});

describe("shouldSendReminder", () => {
  const reminder = 30 * MIN;
  it("fires inside the reminder window before start", () => {
    const now = new Date("2026-07-04T19:40:00Z"); // 20 min before
    expect(shouldSendReminder(view(), now, reminder)).toBe(true);
  });
  it("does not fire once already sent", () => {
    const now = new Date("2026-07-04T19:40:00Z");
    expect(
      shouldSendReminder(view({ reminderSent: true }), now, reminder),
    ).toBe(false);
  });
  it("does not fire after start", () => {
    const now = new Date("2026-07-04T20:05:00Z");
    expect(shouldSendReminder(view(), now, reminder)).toBe(false);
  });
  it("is disabled when the window is zero", () => {
    const now = new Date("2026-07-04T19:40:00Z");
    expect(shouldSendReminder(view(), now, 0)).toBe(false);
  });
});

describe("shouldEndEvent", () => {
  it("fires at or after the end time", () => {
    const now = new Date("2026-07-04T22:00:00Z");
    expect(shouldEndEvent(view(), now)).toBe(true);
  });
  it("does not fire before the end time", () => {
    const now = new Date("2026-07-04T21:59:00Z");
    expect(shouldEndEvent(view(), now)).toBe(false);
  });
  it("does not re-fire for an ended event", () => {
    const now = new Date("2026-07-04T23:00:00Z");
    expect(shouldEndEvent(view({ state: "ended" }), now)).toBe(false);
  });
});

describe("shouldCleanupChannel", () => {
  const grace = 15 * MIN;
  const ended = view({ state: "ended", channelId: "c1" });
  it("fires once ended, empty and past the grace period", () => {
    const now = new Date("2026-07-04T22:20:00Z"); // 20 min after end
    expect(shouldCleanupChannel(ended, now, grace, true)).toBe(true);
  });
  it("waits while the channel still has members", () => {
    const now = new Date("2026-07-04T22:20:00Z");
    expect(shouldCleanupChannel(ended, now, grace, false)).toBe(false);
  });
  it("waits until the grace period elapses", () => {
    const now = new Date("2026-07-04T22:05:00Z"); // only 5 min after end
    expect(shouldCleanupChannel(ended, now, grace, true)).toBe(false);
  });
  it("does nothing without a channel", () => {
    const now = new Date("2026-07-04T22:20:00Z");
    expect(
      shouldCleanupChannel(view({ state: "ended" }), now, grace, true),
    ).toBe(false);
  });
  it("counts the grace period from endedAt when the event was ended early (#1193)", () => {
    const early = view({
      state: "ended",
      channelId: "c1",
      endedAt: new Date("2026-07-04T20:30:00Z"),
    });
    // 10 minutes after the early end: still inside the grace period.
    expect(
      shouldCleanupChannel(
        early,
        new Date("2026-07-04T20:40:00Z"),
        grace,
        true,
      ),
    ).toBe(false);
    // 20 minutes after it: due, although the scheduled end is 1h40 away.
    expect(
      shouldCleanupChannel(
        early,
        new Date("2026-07-04T20:50:00Z"),
        grace,
        true,
      ),
    ).toBe(true);
  });
});

describe("canonicalEventId", () => {
  it("lower-cases a 24-digit hex id and refuses anything else", () => {
    expect(canonicalEventId("65A00000000000000000000A")).toBe(
      "65a00000000000000000000a",
    );
    expect(canonicalEventId("65a00000000000000000000a")).toBe(
      "65a00000000000000000000a",
    );
    for (const bad of [
      "",
      "abc",
      "g".repeat(24),
      "a".repeat(25),
      "abcdefghijkl",
    ]) {
      expect(canonicalEventId(bad)).toBeNull();
    }
  });
});

describe("effectiveEndTime", () => {
  it("is endedAt when recorded, else start plus duration", () => {
    const endedAt = new Date("2026-07-04T20:30:00Z");
    expect(effectiveEndTime(view({ endedAt })).toISOString()).toBe(
      endedAt.toISOString(),
    );
    expect(effectiveEndTime(view({ endedAt: null })).toISOString()).toBe(
      "2026-07-04T22:00:00.000Z",
    );
    expect(effectiveEndTime(view()).toISOString()).toBe(
      "2026-07-04T22:00:00.000Z",
    );
  });
});

describe("formatEventWhen", () => {
  it("renders the local wall-clock time and zone", () => {
    const event = {
      startTime: new Date("2026-07-05T00:00:00Z"),
      timezone: "America/New_York",
    };
    expect(formatEventWhen(event)).toBe("2026-07-04 20:00 (America/New_York)");
  });
});

// Regression tests for #768: an RSVP must be recorded as one atomic
// server-side update, not a fetch/modify/save of the whole document —
// two members clicking buttons in the same tick would otherwise clobber
// each other's RSVP (lost update).
describe("setRsvp", () => {
  const EVENT_ID = "0123456789abcdef01234567"; // valid ObjectId shape

  beforeEach(() => {
    EventService.reset();
  });

  function buildService(): InstanceType<typeof EventService> {
    return EventService.getInstance({} as never);
  }

  it("upserts via a single atomic findOneAndUpdate and returns the updated event", async () => {
    const updated = {
      _id: EVENT_ID,
      rsvps: [{ userId: "user-1", status: "going" }],
    };
    EventMock.findOneAndUpdate = jest.fn(async () => updated);

    const result = await buildService().setRsvp(
      EVENT_ID,
      "user-1",
      "going",
      "msg-1",
    );

    expect(result).toBe(updated);
    expect(EventMock.findOneAndUpdate).toHaveBeenCalledTimes(1);
    expect(EventMock.findOneAndUpdate).toHaveBeenCalledWith(
      // The state filter doubles as the finished-event guard, and the click
      // must come from the event's current announcement message (#1175).
      {
        _id: EVENT_ID,
        state: { $nin: ["cancelled", "ended"] },
        announcementMessageId: "msg-1",
      },
      // Pipeline update: drop any previous entry for the user, append the
      // new one — both inside one atomic document update.
      [
        {
          $set: {
            rsvps: {
              $concatArrays: [
                {
                  $filter: {
                    input: "$rsvps",
                    as: "rsvp",
                    cond: { $ne: ["$$rsvp.userId", "user-1"] },
                  },
                },
                [
                  {
                    userId: "user-1",
                    status: "going",
                    respondedAt: expect.any(Date),
                  },
                ],
              ],
            },
          },
        },
      ],
      { returnDocument: "after", updatePipeline: true },
    );
  });

  it("returns null when the event is missing, ended or cancelled", async () => {
    EventMock.findOneAndUpdate = jest.fn(async () => null);

    const result = await buildService().setRsvp(
      EVENT_ID,
      "user-1",
      "maybe",
      "msg-1",
    );

    expect(result).toBeNull();
  });

  it("returns null for a malformed event id without touching the database", async () => {
    EventMock.findOneAndUpdate = jest.fn(async () => null);

    const result = await buildService().setRsvp(
      "not-an-id",
      "user-1",
      "cant",
      "msg-1",
    );

    expect(result).toBeNull();
    expect(EventMock.findOneAndUpdate).not.toHaveBeenCalled();
  });
});

// #914. A purge has to clear RSVPs from ended and cancelled events too, so
// `setRsvp` cannot be reused — its `state: { $nin: ["cancelled", "ended"] }`
// filter excludes most of a member's RSVP history.
describe("removeRsvp", () => {
  beforeEach(() => {
    EventService.reset();
  });

  function buildService(): InstanceType<typeof EventService> {
    return EventService.getInstance({} as never);
  }

  function stubEvents(rows: Array<{ _id: string; state: string }>): jest.Mock {
    // Every matched row carries the RSVP being removed: the announcement is
    // now rendered from the row with it dropped in memory, before the pull.
    EventMock.find = jest.fn(async () =>
      rows.map((row) => ({ ...row, rsvps: [{ userId: "user-1" }] })),
    );
    const updated = jest.fn(async (id: unknown) => {
      const row = rows.find((r) => r._id === id);
      return row ? { ...row, rsvps: [], guildId: "guild-1" } : null;
    });
    EventMock.findByIdAndUpdate = updated;
    return updated;
  }

  it("pulls the RSVP server-side, matching on the nested user id", async () => {
    stubEvents([{ _id: "e1", state: "scheduled" }]);
    const svc = buildService();
    const render = jest
      .spyOn(
        svc as unknown as { updateAnnouncement: () => Promise<boolean> },
        "updateAnnouncement",
      )
      .mockResolvedValue(true);

    const removed = await svc.removeRsvp("guild-1", "user-1");

    expect(removed).toEqual({ matched: 1, removed: 1, rendersFailed: 0 });
    expect(EventMock.find).toHaveBeenCalledWith({
      guildId: "guild-1",
      "rsvps.userId": "user-1",
    });
    // Server-side `$pull` — the same lost-update defence `setRsvp`'s
    // aggregation pipeline exists for.
    expect(EventMock.findByIdAndUpdate).toHaveBeenCalledWith(
      "e1",
      { $pull: { rsvps: { userId: "user-1" } } },
      { returnDocument: "after" },
    );
    expect(render).toHaveBeenCalledTimes(1);
  });

  it("does not filter on state, so ended and cancelled events are cleared too", async () => {
    stubEvents([
      { _id: "e1", state: "ended" },
      { _id: "e2", state: "cancelled" },
      { _id: "e3", state: "active" },
    ]);
    const svc = buildService();
    jest
      .spyOn(
        svc as unknown as { updateAnnouncement: () => Promise<boolean> },
        "updateAnnouncement",
      )
      .mockResolvedValue(true);

    const removed = await svc.removeRsvp("guild-1", "user-1");

    expect(removed).toEqual({ matched: 3, removed: 3, rendersFailed: 0 });
    const [filter] = EventMock.find.mock.calls[0] as [Record<string, unknown>];
    expect(filter).not.toHaveProperty("state");
  });

  it("re-renders a scheduled event but not an ended one", async () => {
    stubEvents([
      { _id: "e-ended", state: "ended" },
      { _id: "e-live", state: "scheduled" },
    ]);
    const svc = buildService();
    const render = jest
      .spyOn(
        svc as unknown as {
          updateAnnouncement: (event: { _id: string }) => Promise<void>;
        },
        "updateAnnouncement",
      )
      .mockResolvedValue(true);

    await svc.removeRsvp("guild-1", "user-1");

    // Editing a finished event's post is churn nobody reads.
    expect(render).toHaveBeenCalledTimes(1);
    expect((render.mock.calls[0] as [{ _id: string }])[0]._id).toBe("e-live");
  });

  it("re-renders without the member, before the pull that removes them", async () => {
    // The announcement goes first: `rsvps.userId` is the only way back to
    // this event, so pulling and then failing to render would leave the
    // member listed on a post nothing can select again (#916). The embed is
    // built from the row with the RSVP dropped in memory, never saved.
    EventMock.find = jest.fn(async () => [
      {
        _id: "e1",
        state: "scheduled",
        rsvps: [{ userId: "user-1" }, { userId: "user-2" }],
      },
    ]);
    EventMock.findByIdAndUpdate = jest.fn(async () => ({
      _id: "e1",
      state: "scheduled",
      rsvps: [{ userId: "user-2" }],
    }));
    const svc = buildService();
    const render = jest
      .spyOn(
        svc as unknown as { updateAnnouncement: (e: unknown) => Promise<void> },
        "updateAnnouncement",
      )
      .mockResolvedValue(true);

    await svc.removeRsvp("guild-1", "user-1");

    const rendered = (render.mock.calls[0] as [{ rsvps: unknown[] }])[0];
    expect(rendered.rsvps).toEqual([{ userId: "user-2" }]);
    expect(render.mock.invocationCallOrder[0]).toBeLessThan(
      (EventMock.findByIdAndUpdate as jest.Mock).mock.invocationCallOrder[0],
    );
  });

  it("keeps the RSVP when the announcement could not be refreshed", async () => {
    // Leaving it in place is what keeps the event findable by
    // `rsvps.userId`, so a retry can still take the member off the post.
    stubEvents([{ _id: "e1", state: "scheduled" }]);
    const svc = buildService();
    jest
      .spyOn(
        svc as unknown as { updateAnnouncement: () => Promise<boolean> },
        "updateAnnouncement",
      )
      .mockResolvedValue(false);

    expect(await svc.removeRsvp("guild-1", "user-1")).toEqual({
      matched: 1,
      removed: 0,
      rendersFailed: 1,
    });
    expect(EventMock.findByIdAndUpdate).not.toHaveBeenCalled();
  });

  it("returns 0 without writing when the member has no RSVPs", async () => {
    stubEvents([]);
    const svc = buildService();

    expect(await svc.removeRsvp("guild-1", "user-1")).toEqual({
      matched: 0,
      removed: 0,
      rendersFailed: 0,
    });
    expect(EventMock.findByIdAndUpdate).not.toHaveBeenCalled();
  });

  it("skips an event that vanished between the scan and the pull", async () => {
    EventMock.find = jest.fn(async () => [
      { _id: "gone", state: "scheduled", rsvps: [{ userId: "user-1" }] },
    ]);
    EventMock.findByIdAndUpdate = jest.fn(async () => null);
    const svc = buildService();
    const render = jest
      .spyOn(
        svc as unknown as { updateAnnouncement: () => Promise<boolean> },
        "updateAnnouncement",
      )
      .mockResolvedValue(true);

    // Matched but not removed: the scan found it, the pull did not. A
    // shortfall like this is what makes a partial removal visible in the
    // purge report instead of passing as a smaller success (#916).
    expect(await svc.removeRsvp("guild-1", "user-1")).toEqual({
      matched: 1,
      removed: 0,
      rendersFailed: 0,
    });
    // The render happens before the pull now, so it did run.
    expect(render).toHaveBeenCalledTimes(1);
  });

  it("keeps clearing the other events when one pull throws", async () => {
    // A throw used to reject the whole call, so the purge report said
    // nothing had happened even though RSVPs really had been cleared (#916).
    EventMock.find = jest.fn(async () => [
      { _id: "e1", state: "scheduled", rsvps: [{ userId: "user-1" }] },
      { _id: "e2", state: "scheduled", rsvps: [{ userId: "user-1" }] },
      { _id: "e3", state: "scheduled", rsvps: [{ userId: "user-1" }] },
    ]);
    EventMock.findByIdAndUpdate = jest.fn(async (id: unknown) => {
      if (id === "e2") throw new Error("write conflict");
      return { _id: id, state: "ended", rsvps: [] };
    });
    // The failed pull is re-read: the RSVP is still there, so the write
    // really did not apply and the announcement is not stale.
    EventMock.findById = jest.fn(async (id: unknown) => ({
      _id: id,
      state: "scheduled",
      rsvps: [{ userId: "user-1" }],
    }));
    const svc = buildService();
    jest
      .spyOn(
        svc as unknown as { updateAnnouncement: () => Promise<boolean> },
        "updateAnnouncement",
      )
      .mockResolvedValue(true);

    expect(await svc.removeRsvp("guild-1", "user-1")).toEqual({
      matched: 3,
      removed: 2,
      rendersFailed: 0,
    });
  });

  it("refreshes the announcement when a failed pull actually applied", async () => {
    // A write can apply and still reject — a lost acknowledgement is enough.
    // The row is then clean, so no retry ever matches this event on
    // `rsvps.userId` again, and the announcement would list the member for
    // good unless this path redraws it (#916).
    EventMock.find = jest.fn(async () => [
      { _id: "e1", state: "scheduled", rsvps: [{ userId: "user-1" }] },
    ]);
    EventMock.findByIdAndUpdate = jest.fn(async () => {
      throw new Error("connection reset");
    });
    EventMock.findById = jest.fn(async (id: unknown) => ({
      _id: id,
      state: "scheduled",
      rsvps: [], // the pull did land
    }));
    const svc = buildService();
    const render = jest
      .spyOn(
        svc as unknown as { updateAnnouncement: () => Promise<boolean> },
        "updateAnnouncement",
      )
      .mockResolvedValue(true);

    const result = await svc.removeRsvp("guild-1", "user-1");

    expect(render).toHaveBeenCalled();
    // The write is still reported as failed — `removed` stays 0 — but the
    // public post no longer lists them, so nothing is owed on that side.
    expect(result).toEqual({ matched: 1, removed: 0, rendersFailed: 0 });
  });

  it("counts an unverifiable failed pull as an announcement still owed", async () => {
    EventMock.find = jest.fn(async () => [
      { _id: "e1", state: "scheduled", rsvps: [{ userId: "user-1" }] },
    ]);
    EventMock.findByIdAndUpdate = jest.fn(async () => {
      throw new Error("connection reset");
    });
    EventMock.findById = jest.fn(async () => {
      throw new Error("still down");
    });
    const svc = buildService();

    expect(await svc.removeRsvp("guild-1", "user-1")).toEqual({
      matched: 1,
      removed: 0,
      rendersFailed: 1,
    });
  });
});

// Regression tests for #730: cron and "start now" must not both create a
// channel for the same event. Channel creation is guarded by an atomic
// `findOneAndUpdate({ channelId: null })` claim, exercised here through
// `startEventNow`.
describe("claimEventChannel (start-now path)", () => {
  const CATEGORY_ID = "cat-1";

  function buildService(opts: {
    findOneAndUpdate?: unknown;
    claimError?: Error;
    createdChannelId: string;
    deletableChannel?: { delete: jest.Mock };
    refreshedEvent?: unknown;
  }): {
    service: InstanceType<typeof EventService>;
    event: {
      _id: string;
      guildId: string;
      state: string;
      channelId: string | null;
      categoryId: string;
      save: jest.Mock;
      announcementChannelId: null;
      announcementMessageId: null;
      title: string;
    };
    createChannel: jest.Mock;
  } {
    const event = {
      _id: "evt-1",
      guildId: "guild-1",
      state: "scheduled",
      channelId: null as string | null,
      categoryId: CATEGORY_ID,
      title: "Game Night",
      announcementChannelId: null,
      announcementMessageId: null,
      save: jest.fn(async () => undefined),
    };

    EventMock.findById = jest
      .fn()
      .mockReturnValueOnce(Promise.resolve(event))
      .mockReturnValue(Promise.resolve(opts.refreshedEvent ?? null));
    EventMock.findOneAndUpdate = jest.fn(async () => {
      if (opts.claimError) throw opts.claimError;
      return opts.findOneAndUpdate;
    });

    const createdChannel = { id: opts.createdChannelId };
    const createChannel = jest.fn(async () => createdChannel);
    const cache = new Map<string, unknown>();
    cache.set(CATEGORY_ID, { type: ChannelType.GuildCategory });
    if (opts.deletableChannel) {
      cache.set(opts.createdChannelId, opts.deletableChannel);
    }
    const guild = { channels: { create: createChannel, cache } };
    const client = {
      guilds: { fetch: jest.fn(async () => guild) },
    } as never;

    const service = EventService.getInstance(client);
    return { service, event, createChannel };
  }

  beforeEach(() => {
    EventService.reset();
  });

  it("wins the claim, sets the channel and marks the event active", async () => {
    const { service, event, createChannel } = buildService({
      // Non-null pre-update doc => our compare-and-set matched.
      findOneAndUpdate: { _id: "evt-1", channelId: null },
      createdChannelId: "chan-win",
    });

    const result = await service.startEventNow("evt-1");

    expect(createChannel).toHaveBeenCalledTimes(1);
    expect(result?.channelId).toBe("chan-win");
    expect(result?.state).toBe("active");
    expect(event.save).toHaveBeenCalledTimes(1);
    expect(EventMock.findOneAndUpdate).toHaveBeenCalledWith(
      expect.objectContaining({
        _id: "evt-1",
        channelId: null,
        state: { $in: ["scheduled", "active"] },
        seriesCancelled: { $ne: true },
      }),
      { $set: { channelId: "chan-win" } },
    );
  });

  it("loses the claim, deletes the redundant channel and adopts the winner's id", async () => {
    const deletableChannel = { delete: jest.fn(async () => undefined) };
    const { service, event, createChannel } = buildService({
      // Null => no document matched; another path already claimed a channel.
      findOneAndUpdate: null,
      createdChannelId: "chan-loser",
      deletableChannel,
      refreshedEvent: { channelId: "chan-winner" },
    });

    const result = await service.startEventNow("evt-1");

    expect(createChannel).toHaveBeenCalledTimes(1);
    // The redundant channel is torn down, not left orphaned.
    expect(deletableChannel.delete).toHaveBeenCalledTimes(1);
    // The in-memory event adopts the winner's id and is not re-saved.
    expect(result?.channelId).toBe("chan-winner");
    expect(event.state).toBe("scheduled");
    expect(event.save).not.toHaveBeenCalled();
  });

  it("tears down the channel when the claim write throws, leaking nothing", async () => {
    const deletableChannel = { delete: jest.fn(async () => undefined) };
    const { service, event, createChannel } = buildService({
      // Transient DB error while claiming, after the channel already exists.
      claimError: new Error("connection reset"),
      createdChannelId: "chan-orphan",
      deletableChannel,
    });

    const result = await service.startEventNow("evt-1");

    expect(createChannel).toHaveBeenCalledTimes(1);
    // The just-created channel is removed rather than left unreferenced...
    expect(deletableChannel.delete).toHaveBeenCalledTimes(1);
    // ...and the failure surfaces as a no-op (channelId still null) instead
    // of crashing the caller, so the next scan can retry cleanly.
    expect(result).toBeNull();
    expect(event.channelId).toBeNull();
    expect(event.save).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------
// Recurring events (#744)
// ---------------------------------------------------------------

describe("computeOccurrenceStart", () => {
  const iso = (d: Date): string => d.toISOString();

  it("returns the anchor for occurrence 0", () => {
    const anchor = new Date("2026-07-03T20:00:00Z");
    expect(iso(computeOccurrenceStart(anchor, "weekly", 0, "UTC"))).toBe(
      "2026-07-03T20:00:00.000Z",
    );
  });

  it("steps weekly by 7 days and biweekly by 14", () => {
    const anchor = new Date("2026-07-03T20:00:00Z");
    expect(iso(computeOccurrenceStart(anchor, "weekly", 3, "UTC"))).toBe(
      "2026-07-24T20:00:00.000Z",
    );
    expect(iso(computeOccurrenceStart(anchor, "biweekly", 2, "UTC"))).toBe(
      "2026-07-31T20:00:00.000Z",
    );
  });

  it("keeps the wall-clock time across a DST change", () => {
    // Fri 2026-03-20 20:00 London (GMT) → the clocks go forward on 03-29,
    // so 20:00 BST is 19:00 UTC.
    const anchor = new Date("2026-03-20T20:00:00Z");
    expect(
      iso(computeOccurrenceStart(anchor, "weekly", 2, "Europe/London")),
    ).toBe("2026-04-03T19:00:00.000Z");
  });

  it("clamps monthly steps to short months and returns to the anchor day", () => {
    const anchor = new Date("2026-01-31T18:00:00Z");
    expect(iso(computeOccurrenceStart(anchor, "monthly", 1, "UTC"))).toBe(
      "2026-02-28T18:00:00.000Z",
    );
    expect(iso(computeOccurrenceStart(anchor, "monthly", 2, "UTC"))).toBe(
      "2026-03-31T18:00:00.000Z",
    );
  });

  it("rolls over the year boundary", () => {
    const anchor = new Date("2026-11-15T18:00:00Z");
    expect(iso(computeOccurrenceStart(anchor, "monthly", 3, "UTC"))).toBe(
      "2027-02-15T18:00:00.000Z",
    );
  });

  it("rolls a wall-clock time inside a DST gap forward instead of failing", () => {
    // London skips 01:00–01:59 on 2026-03-29, so 01:30 does not exist.
    // It rolls forward to 02:30 BST (01:30 UTC), not back to 00:30.
    const anchor = new Date("2026-03-22T01:30:00Z");
    const result = computeOccurrenceStart(anchor, "weekly", 1, "Europe/London");
    expect(result.toISOString()).toBe("2026-03-29T01:30:00.000Z");
  });
});

describe("isRecurring / recurrenceLabel", () => {
  it("is true only for a non-none cadence with a series id", () => {
    expect(isRecurring({ recurrence: "weekly", seriesId: "s1" })).toBe(true);
    expect(isRecurring({ recurrence: "none", seriesId: null })).toBe(false);
    expect(isRecurring({ recurrence: "weekly", seriesId: null })).toBe(false);
    expect(isRecurring({})).toBe(false);
  });

  it("labels each cadence", () => {
    expect(recurrenceLabel("weekly")).toBe("weekly");
    expect(recurrenceLabel("biweekly")).toBe("every 2 weeks");
    expect(recurrenceLabel("monthly")).toBe("monthly");
    expect(recurrenceLabel("none")).toBe("one-off");
  });
});

describe("recurring event lifecycle", () => {
  type Doc = Record<string, unknown> & { save: jest.Mock };
  let created: Doc[];

  function buildService(recurrenceEnabled = true): {
    service: InstanceType<typeof EventService>;
    postAnnouncement: jest.Mock;
  } {
    EventService.reset();
    created = [];
    EventMock.mockImplementation(function (this: Doc, doc: unknown) {
      Object.assign(this, doc, {
        _id: `new-${created.length + 1}`,
        save: jest.fn(async () => undefined),
      });
      created.push(this);
    } as never);
    const service = EventService.getInstance({} as never);
    jest
      .spyOn(service, "isRecurrenceEnabled")
      .mockResolvedValue(recurrenceEnabled);
    const postAnnouncement = jest.fn(async () => undefined);
    (service as unknown as { postAnnouncement: jest.Mock }).postAnnouncement =
      postAnnouncement;
    return { service, postAnnouncement };
  }

  function ended(overrides: Record<string, unknown> = {}): Doc {
    return {
      _id: "occ-0",
      guildId: "guild-1",
      title: "Game Night",
      description: "Bring snacks",
      startTime: new Date("2026-07-03T20:00:00Z"),
      seriesStart: new Date("2026-07-03T20:00:00Z"),
      timezone: "UTC",
      durationMinutes: 120,
      categoryId: "cat-1",
      state: "ended",
      recurrence: "weekly",
      seriesId: "occ-0",
      occurrenceIndex: 0,
      nextSpawned: false,
      seriesCancelled: false,
      createdBy: "admin-1",
      rsvps: [{ userId: "u1", status: "going" }],
      save: jest.fn(async () => undefined),
      ...overrides,
    } as Doc;
  }

  const NOW = new Date("2026-07-03T23:00:00Z");

  type Spawner = {
    spawnNextOccurrence: (e: unknown, now: Date) => Promise<Doc | null>;
  };

  beforeEach(() => {
    EventMock.findById = jest.fn(async () => ({
      nextSpawned: false,
      seriesCancelled: false,
    }));
    EventMock.exists = jest.fn(async () => null);
    EventMock.find = jest.fn(async () => []);
    EventMock.deleteOne = jest.fn(async () => ({}));
    EventMock.findOneAndUpdate = jest.fn(async () => ({}));
    EventMock.findOne = jest.fn(async () => null);
    EventMock.updateOne = jest.fn(async () => ({}));
    EventMock.updateMany = jest.fn(async () => ({}));
  });

  it("createEvent seeds a series with its own id as the series id", async () => {
    const { service } = buildService();
    const start = new Date("2026-07-10T20:00:00Z");
    await service.createEvent({
      guildId: "guild-1",
      title: "Game Night",
      description: "",
      startTime: start,
      timezone: "UTC",
      durationMinutes: 120,
      recurrence: "weekly",
      createdBy: "admin-1",
    });
    expect(created[0].recurrence).toBe("weekly");
    expect(created[0].seriesId).toBe("new-1");
    expect(created[0].occurrenceIndex).toBe(0);
    expect(created[0].seriesStart).toEqual(start);
  });

  it("createEvent leaves a one-off event outside any series", async () => {
    const { service } = buildService();
    await service.createEvent({
      guildId: "guild-1",
      title: "One-off",
      description: "",
      startTime: new Date("2026-07-10T20:00:00Z"),
      timezone: "UTC",
      durationMinutes: 60,
      createdBy: "admin-1",
    });
    expect(created[0].recurrence).toBe("none");
    expect(created[0].seriesId ?? null).toBeNull();
  });

  it("createEvent refuses a recurring event while recurrence is disabled", async () => {
    const { service } = buildService(false);
    await expect(
      service.createEvent({
        guildId: "guild-1",
        title: "Game Night",
        description: "",
        startTime: new Date("2026-07-10T20:00:00Z"),
        timezone: "UTC",
        durationMinutes: 60,
        recurrence: "weekly",
        createdBy: "admin-1",
      }),
    ).rejects.toBeInstanceOf(RecurrenceDisabledError);
    expect(created).toHaveLength(0);
  });

  it("spawns the next occurrence with the series identity", async () => {
    const { service, postAnnouncement } = buildService();
    const next = await (service as unknown as Spawner).spawnNextOccurrence(
      ended(),
      NOW,
    );
    expect(next).toBe(created[0]);
    expect(created[0]).toMatchObject({
      title: "Game Night",
      description: "Bring snacks",
      state: "scheduled",
      reminderSent: false,
      recurrence: "weekly",
      seriesId: "occ-0",
      occurrenceIndex: 1,
      createdBy: "admin-1",
      nextSpawned: false,
    });
    expect((created[0].startTime as Date).toISOString()).toBe(
      "2026-07-10T20:00:00.000Z",
    );
    expect(postAnnouncement).toHaveBeenCalledWith(created[0]);
    // Marked done only once the successor exists.
    expect(EventMock.updateOne).toHaveBeenCalledWith(
      { _id: "occ-0" },
      { $set: { nextSpawned: true } },
    );
  });

  it("gives the next occurrence the series' cover hash (#1181), null when none", async () => {
    EventMock.findById = jest.fn(async () => ({
      nextSpawned: false,
      seriesCancelled: false,
      coverHash: "h-series",
    }));
    const { service } = buildService();
    await (service as unknown as Spawner).spawnNextOccurrence(ended(), NOW);
    expect(created[0].coverHash).toBe("h-series");

    created.length = 0;
    EventMock.findById = jest.fn(async () => ({
      nextSpawned: false,
      seriesCancelled: false,
    }));
    await (service as unknown as Spawner).spawnNextOccurrence(ended(), NOW);
    expect(created[0].coverHash).toBeNull();
  });

  it("copies the group setup to the next occurrence without members (#1188)", async () => {
    // Read from the freshest row (a later edit of the running event carries
    // forward), keys kept, memberships / captains / channels reset.
    const group = (
      key: string,
      name: string,
      extra: Record<string, unknown> = {},
    ): Record<string, unknown> => ({
      key,
      name,
      kind: "team",
      size: null,
      tag: "",
      marker: "",
      channelId: "chan-live",
      captainId: "u-cap",
      memberIds: ["u1", "u2"],
      ...extra,
    });
    EventMock.findById = jest.fn(async () => ({
      nextSpawned: false,
      seriesCancelled: false,
      groupsEnabled: true,
      // The host's lock belongs to one occurrence (#1191).
      groupsLocked: true,
      presetId: "builtin:wardogs",
      groupLabel: "Squad",
      leaderLabel: "Captain",
      channelLeadMinutes: 30,
      captainsEnabled: true,
      captainCustomisationEnabled: true,
      tagsEnabled: true,
      groups: [
        group("g_a", "Manticore", { marker: "🟢", size: 8, tag: "MAN" }),
        group("g_b", "Spectators", { kind: "open" }),
      ],
    }));
    const { service } = buildService();
    await (service as unknown as Spawner).spawnNextOccurrence(ended(), NOW);
    expect(created[0]).toMatchObject({
      groupsEnabled: true,
      presetId: "builtin:wardogs",
      groupLabel: "Squad",
      leaderLabel: "Captain",
      channelLeadMinutes: 30,
      captainsEnabled: true,
      captainCustomisationEnabled: true,
      tagsEnabled: true,
    });
    // The successor starts unlocked: the field is not carried at all.
    expect(created[0].groupsLocked).toBeUndefined();
    expect(created[0].groups).toEqual([
      {
        key: "g_a",
        name: "Manticore",
        kind: "team",
        size: 8,
        tag: "MAN",
        marker: "🟢",
        channelId: null,
        captainId: null,
        memberIds: [],
      },
      {
        key: "g_b",
        name: "Spectators",
        kind: "open",
        size: null,
        tag: "",
        marker: "",
        channelId: null,
        captainId: null,
        memberIds: [],
      },
    ]);
  });

  it("gives a series without groups the exact successor it always had (#1188)", async () => {
    const { service } = buildService();
    await (service as unknown as Spawner).spawnNextOccurrence(ended(), NOW);
    expect(created[0].groupsEnabled).toBeUndefined();
    expect(created[0].groups).toBeUndefined();
    expect(created[0].channelLeadMinutes).toBeUndefined();
  });

  it("createEvent stores the group setup only when the form switched groups on (#1188)", async () => {
    const { service } = buildService();
    const base = {
      guildId: "guild-1",
      title: "Quiz",
      description: "",
      startTime: new Date("2026-07-10T20:00:00Z"),
      timezone: "UTC",
      durationMinutes: 60,
      createdBy: "admin-1",
    };
    await service.createEvent(base);
    expect(created[0].groupsEnabled).toBeUndefined();

    const setup = {
      groupsEnabled: true,
      presetId: null,
      groupLabel: "Team",
      leaderLabel: "Leader",
      channelLeadMinutes: 20,
      groups: [],
      captainsEnabled: false,
      captainCustomisationEnabled: false,
      tagsEnabled: false,
    };
    await service.createEvent({ ...base, groups: setup });
    expect(created[1]).toMatchObject({
      groupsEnabled: true,
      channelLeadMinutes: 20,
    });

    await service.createEvent({
      ...base,
      groups: { ...setup, groupsEnabled: false },
    });
    expect(created[2].groupsEnabled).toBeUndefined();
  });

  it("waits for an in-flight cover change of its series and inherits the hash it left (#1181)", async () => {
    const { withCoverLock } = await import("../../src/services/event-cover.js");
    let hash: string | null = null;
    EventMock.findById = jest.fn(async () => ({
      nextSpawned: false,
      seriesCancelled: false,
      coverHash: hash,
    }));
    const { service } = buildService();
    let release: () => void = () => undefined;
    const held = withCoverLock(
      "guild-1",
      "occ-0",
      () => new Promise<void>((resolve) => (release = resolve)),
    );
    const spawning = (service as unknown as Spawner).spawnNextOccurrence(
      ended(),
      NOW,
    );
    await new Promise((r) => setTimeout(r, 20));
    // The cover change is still running: nothing was inserted yet.
    expect(created).toHaveLength(0);
    // It publishes its hash, then lets go.
    hash = "h-new";
    release();
    await held;
    await spawning;
    expect(created[0].coverHash).toBe("h-new");
  });

  it("does not spawn when another caller already created the successor", async () => {
    const { service } = buildService();
    EventMock.findById = jest.fn(async () => ({
      nextSpawned: true,
      seriesCancelled: false,
    }));
    const next = await (service as unknown as Spawner).spawnNextOccurrence(
      ended(),
      NOW,
    );
    expect(next).toBeNull();
    expect(created).toHaveLength(0);
  });

  it("skips cadence steps already in the past instead of back-filling", async () => {
    const { service } = buildService();
    const later = new Date("2026-07-25T12:00:00Z"); // bot was offline for weeks
    await (service as unknown as Spawner).spawnNextOccurrence(ended(), later);
    expect(created).toHaveLength(1);
    expect(created[0].occurrenceIndex).toBe(4);
    expect((created[0].startTime as Date).toISOString()).toBe(
      "2026-07-31T20:00:00.000Z",
    );
  });

  it("does not spawn into a series that was cancelled", async () => {
    const { service } = buildService();
    EventMock.findById = jest.fn(async () => ({
      nextSpawned: false,
      seriesCancelled: true,
    }));
    const next = await (service as unknown as Spawner).spawnNextOccurrence(
      ended(),
      NOW,
    );
    expect(next).toBeNull();
    expect(created).toHaveLength(0);
  });

  it("takes its successor down again when the series is cancelled mid-spawn", async () => {
    const { service } = buildService();
    EventMock.findById = jest
      .fn()
      .mockResolvedValueOnce({ nextSpawned: false, seriesCancelled: false })
      .mockResolvedValue({ nextSpawned: false, seriesCancelled: true });
    const cancelOne = jest.fn(async () => undefined);
    (service as unknown as { cancelOne: jest.Mock }).cancelOne = cancelOne;
    const next = await (service as unknown as Spawner).spawnNextOccurrence(
      ended(),
      NOW,
    );
    expect(next).toBeNull();
    expect(cancelOne).toHaveBeenCalledWith(created[0]);
    expect(EventMock.updateOne).not.toHaveBeenCalled();
  });

  it("adopts an existing later occurrence instead of skipping past it", async () => {
    const { service } = buildService();
    const later = { _id: "occ-1", occurrenceIndex: 1 };
    EventMock.findOne = jest.fn(async () => later);
    const previous = ended();
    const next = await (service as unknown as Spawner).spawnNextOccurrence(
      previous,
      NOW,
    );
    expect(next).toBe(later);
    expect(created).toHaveLength(0);
    expect(EventMock.findOne).toHaveBeenCalledWith({
      guildId: "guild-1",
      seriesId: "occ-0",
      occurrenceIndex: { $gt: 0 },
    });
    expect(EventMock.updateOne).toHaveBeenCalledWith(
      { _id: "occ-0" },
      { $set: { nextSpawned: true } },
    );
    expect(previous.nextSpawned).toBe(true);
  });

  it("persists seriesCancelled on a successor taken down mid-spawn", async () => {
    const { service } = buildService();
    EventMock.findById = jest
      .fn()
      .mockResolvedValueOnce({ nextSpawned: false, seriesCancelled: false })
      .mockResolvedValue({ nextSpawned: false, seriesCancelled: true });
    (service as unknown as { cancelOne: jest.Mock }).cancelOne = jest.fn(
      async () => undefined,
    );
    await (service as unknown as Spawner).spawnNextOccurrence(ended(), NOW);
    expect(created[0].seriesCancelled).toBe(true);
  });

  it("processEvent cancels an open occurrence when a sibling carries the series cancellation", async () => {
    const { service } = buildService();
    EventMock.exists = jest.fn(async () => ({ _id: "occ-0" }));
    const late = ended({ _id: "occ-3", state: "scheduled" });
    const cancelOne = jest.fn(async () => undefined);
    (service as unknown as { cancelOne: jest.Mock }).cancelOne = cancelOne;
    await (
      service as unknown as {
        processEvent: (...a: unknown[]) => Promise<void>;
      }
    ).processEvent(late, {}, NOW, { reminderMs: 0, leadMs: 0, graceMs: 0 });
    expect(EventMock.exists).toHaveBeenCalledWith({
      guildId: "guild-1",
      seriesId: "occ-0",
      seriesCancelled: true,
    });
    expect(late.seriesCancelled).toBe(true);
    expect(cancelOne).toHaveBeenCalledWith(late, undefined, undefined);
    expect(created).toHaveLength(0);
  });

  describe("postAnnouncement", () => {
    function realPost(
      service: InstanceType<typeof EventService>,
      event: unknown,
    ): Promise<void> {
      const proto = Object.getPrototypeOf(service) as {
        postAnnouncement: (e: unknown) => Promise<void>;
      };
      return proto.postAnnouncement.call(service, event);
    }

    function setup(): {
      service: InstanceType<typeof EventService>;
      message: { id: string; delete: jest.Mock };
      event: Doc;
    } {
      const { service } = buildService();
      (service as unknown as { configService: unknown }).configService = {
        getString: jest.fn(async () => "chan-1"),
      };
      const message = {
        id: "msg-mine",
        delete: jest.fn(async () => undefined),
      };
      (service as unknown as { fetchTextChannel: jest.Mock }).fetchTextChannel =
        jest.fn(async () => ({ send: jest.fn(async () => message) }));
      const event = ended({
        state: "scheduled",
        announcementChannelId: null,
        announcementMessageId: null,
      });
      return { service, message, event };
    }

    it("claims the message id atomically and tracks the post", async () => {
      const { service, message, event } = setup();
      await realPost(service, event);
      expect(EventMock.findOneAndUpdate).toHaveBeenCalledWith(
        expect.objectContaining({ _id: "occ-0", announcementMessageId: null }),
        {
          $set: {
            announcementChannelId: "chan-1",
            announcementMessageId: "msg-mine",
          },
        },
      );
      expect(event.announcementMessageId).toBe("msg-mine");
      expect(message.delete).not.toHaveBeenCalled();
    });

    it("only lets an open, non-cancelled row take the post", async () => {
      const { service, event } = setup();
      await realPost(service, event);
      expect(EventMock.findOneAndUpdate).toHaveBeenCalledWith(
        expect.objectContaining({
          state: { $in: ["scheduled", "active"] },
          seriesCancelled: { $ne: true },
        }),
        expect.anything(),
      );
    });

    it("deletes the post when the claim write rejects and the row has no id", async () => {
      const { service, message, event } = setup();
      EventMock.findOneAndUpdate = jest.fn(async () => {
        throw new Error("db down");
      });
      EventMock.findById = jest.fn(async () => ({
        announcementMessageId: null,
      }));
      await realPost(service, event);
      expect(message.delete).toHaveBeenCalled();
    });

    it("keeps the post when a rejected claim had in fact applied", async () => {
      const { service, message, event } = setup();
      EventMock.findOneAndUpdate = jest.fn(async () => {
        throw new Error("ack lost");
      });
      EventMock.findById = jest.fn(async () => ({
        announcementChannelId: "chan-1",
        announcementMessageId: "msg-mine",
      }));
      await realPost(service, event);
      expect(message.delete).not.toHaveBeenCalled();
      expect(event.announcementMessageId).toBe("msg-mine");
    });

    it("deletes its post and adopts the winner's ids when a rejected claim finds another message stored", async () => {
      const { service, message, event } = setup();
      EventMock.findOneAndUpdate = jest.fn(async () => {
        throw new Error("db blip");
      });
      EventMock.findById = jest.fn(async () => ({
        announcementChannelId: "chan-1",
        announcementMessageId: "msg-winner",
      }));
      await realPost(service, event);
      expect(message.delete).toHaveBeenCalled();
      expect(event.announcementMessageId).toBe("msg-winner");
    });

    it("leaves the post alone when the outcome of a rejected claim can't be read", async () => {
      const { service, message, event } = setup();
      EventMock.findOneAndUpdate = jest.fn(async () => {
        throw new Error("db down");
      });
      EventMock.findById = jest.fn(async () => {
        throw new Error("db down");
      });
      await realPost(service, event);
      expect(message.delete).not.toHaveBeenCalled();
    });

    it("deletes its own post and adopts the winner's ids when it loses the race", async () => {
      const { service, message, event } = setup();
      EventMock.findOneAndUpdate = jest.fn(async () => null);
      EventMock.findById = jest.fn(async () => ({
        announcementChannelId: "chan-1",
        announcementMessageId: "msg-winner",
      }));
      await realPost(service, event);
      expect(message.delete).toHaveBeenCalled();
      expect(event.announcementMessageId).toBe("msg-winner");
    });
  });

  it("processEvent finishes an interrupted series cancel instead of running the lifecycle", async () => {
    const { service } = buildService();
    const open = ended({ state: "scheduled", seriesCancelled: true });
    const cancelOne = jest.fn(async () => undefined);
    (service as unknown as { cancelOne: jest.Mock }).cancelOne = cancelOne;
    await (
      service as unknown as {
        processEvent: (...a: unknown[]) => Promise<void>;
      }
    ).processEvent(open, {}, NOW, { reminderMs: 0, leadMs: 0, graceMs: 0 });
    expect(cancelOne).toHaveBeenCalledWith(open, undefined, undefined);
    expect(created).toHaveLength(0);
  });

  it("skips native sync for the tick when the shared native listing failed", async () => {
    const { service } = buildService();
    const syncEvent = jest.fn(async () => undefined);
    (
      service as unknown as { nativeSync: { syncEvent: jest.Mock } }
    ).nativeSync = { syncEvent };
    const run = (skipNative: boolean) =>
      (
        service as unknown as {
          processEvent: (...a: unknown[]) => Promise<void>;
        }
      ).processEvent(
        ended({ state: "ended", recurrence: "none", channelId: null }),
        {},
        NOW,
        { reminderMs: 0, leadMs: 0, graceMs: 0, skipNative },
      );
    await run(true);
    expect(syncEvent).not.toHaveBeenCalled();
    await run(false);
    expect(syncEvent).toHaveBeenCalledTimes(1);
  });

  it("removes a higher-indexed duplicate that inserted before this lower row existed", async () => {
    const { service, postAnnouncement } = buildService();
    const duplicate = { _id: "occ-2", occurrenceIndex: 2 };
    // This caller picked index 1 (it started before occurrence 1's start); a
    // concurrent caller picked index 2 and already inserted and finished its
    // own (empty) lower-sibling check.
    EventMock.find = jest.fn(async () => [duplicate]);
    EventMock.findById = jest
      .fn()
      .mockResolvedValueOnce({ nextSpawned: false, seriesCancelled: false })
      .mockResolvedValue({ announcementMessageId: null });
    const next = await (service as unknown as Spawner).spawnNextOccurrence(
      ended(),
      NOW,
    );
    expect(next).toBe(created[0]);
    expect(created[0].occurrenceIndex).toBe(1);
    // Only competing successors of the SAME predecessor are swept, so a
    // legitimate descendant (spawned from another occurrence) is never hit.
    expect(EventMock.find).toHaveBeenCalledWith(
      expect.objectContaining({
        occurrenceIndex: { $gt: 1 },
        spawnedFrom: "occ-0",
        state: "scheduled",
      }),
    );
    expect(created[0].spawnedFrom).toBe("occ-0");
    expect(EventMock.deleteOne).toHaveBeenCalledWith({ _id: "occ-2" });
    expect(postAnnouncement).toHaveBeenCalledWith(created[0]);
  });

  describe("native mirror of discarded duplicates and skipped cancels (#1034)", () => {
    type Priv = {
      discardDuplicate: (e: unknown) => Promise<void>;
      cancelOne: (e: unknown, c?: unknown, skip?: boolean) => Promise<void>;
      processEvent: (...a: unknown[]) => Promise<void>;
      nativeSync: { syncEvent: jest.Mock };
    };
    function withSync() {
      const { service } = buildService();
      const order: string[] = [];
      const syncEvent = jest.fn(async () => {
        order.push("sync");
      });
      (service as unknown as Priv).nativeSync = { syncEvent };
      EventMock.deleteOne = jest.fn(async () => {
        order.push("delete");
        return {};
      });
      return { priv: service as unknown as Priv, syncEvent, order };
    }

    function dup(overrides: Record<string, unknown> = {}) {
      return {
        _id: "dup",
        state: "scheduled",
        nativeEventId: null,
        nativeCreateStartedAt: null,
        ...overrides,
      };
    }
    /** A sync that "confirms" by releasing the link, as the real close does. */
    function confirming(syncEvent: jest.Mock, order: string[]) {
      syncEvent.mockImplementation(async (...args: unknown[]) => {
        const row = args[0] as Record<string, unknown>;
        row.nativeEventId = null;
        row.nativeCreateStartedAt = null;
        order.push("sync");
      });
    }

    it("closes a duplicate's native event before deleting the row", async () => {
      const { priv, syncEvent, order } = withSync();
      confirming(syncEvent, order);
      EventMock.findById = jest.fn(async () => dup({ nativeEventId: "n1" }));
      await priv.discardDuplicate({ _id: "dup" });
      expect(syncEvent).toHaveBeenCalledWith(
        expect.objectContaining({ state: "cancelled" }),
        null,
      );
      expect(order).toEqual(["sync", "delete"]);
    });

    it("keeps a duplicate as a cleanup record when the close is not confirmed", async () => {
      const { priv } = withSync(); // sync stub leaves the link in place
      EventMock.findById = jest.fn(async () => dup({ nativeEventId: "n1" }));
      EventMock.updateOne = jest.fn(async () => ({}));
      await priv.discardDuplicate({ _id: "dup" });
      expect(EventMock.deleteOne).not.toHaveBeenCalled();
      expect(EventMock.updateOne).toHaveBeenCalledWith(
        { _id: "dup" },
        {
          $set: {
            state: "cancelled",
            nativeCleanupOnly: true,
            seriesId: null,
            recurrence: "none",
            nextSpawned: true,
          },
        },
      );
    });

    it("keeps a duplicate whose pending create is not reconciled yet, deletes it once it is", async () => {
      const first = withSync();
      EventMock.findById = jest.fn(async () =>
        dup({ nativeCreateStartedAt: new Date() }),
      );
      EventMock.updateOne = jest.fn(async () => ({}));
      await first.priv.discardDuplicate({ _id: "dup" });
      expect(EventMock.deleteOne).not.toHaveBeenCalled();
      expect(EventMock.updateOne).toHaveBeenCalled();

      const second = withSync();
      confirming(second.syncEvent, second.order);
      await second.priv.discardDuplicate({ _id: "dup" });
      expect(second.order).toEqual(["sync", "delete"]);
    });

    it("deletes a cleanup record on the scan once its native event is closed", async () => {
      const { priv, syncEvent } = withSync();
      syncEvent.mockImplementation(async (...args: unknown[]) => {
        (args[0] as Record<string, unknown>).nativeEventId = null;
      });
      await priv.processEvent(
        ended({
          _id: "dup",
          state: "cancelled",
          recurrence: "none",
          nativeCleanupOnly: true,
          nativeEventId: "n1",
          nativeCreateStartedAt: null,
          channelId: null,
        }),
        {},
        NOW,
        { reminderMs: 0, leadMs: 0, graceMs: 0 },
      );
      expect(EventMock.deleteOne).toHaveBeenCalledWith({ _id: "dup" });
    });

    it("keeps a cleanup record on the scan while its native event is still open", async () => {
      const { priv } = withSync(); // sync stub leaves the link in place
      await priv.processEvent(
        ended({
          _id: "dup",
          state: "cancelled",
          recurrence: "none",
          nativeCleanupOnly: true,
          nativeEventId: "n1",
          channelId: null,
        }),
        {},
        NOW,
        { reminderMs: 0, leadMs: 0, graceMs: 0 },
      );
      expect(EventMock.deleteOne).not.toHaveBeenCalled();
    });

    it("deletes a duplicate with no native mirror as before", async () => {
      const { priv, syncEvent } = withSync();
      EventMock.findById = jest.fn(async () => ({
        _id: "dup",
        state: "scheduled",
        nativeEventId: null,
        nativeCreateStartedAt: null,
      }));
      await priv.discardDuplicate({ _id: "dup" });
      expect(syncEvent).not.toHaveBeenCalled();
      expect(EventMock.deleteOne).toHaveBeenCalledWith({ _id: "dup" });
    });

    it("makes no native call for interrupted series cancels while the listing failed", async () => {
      const { priv, syncEvent } = withSync();
      EventMock.findById = jest.fn(async () => null);
      for (let i = 0; i < 3; i++) {
        await priv.processEvent(
          ended({
            _id: `occ-${i}`,
            state: "scheduled",
            seriesCancelled: true,
            channelId: null,
          }),
          {},
          NOW,
          { reminderMs: 0, leadMs: 0, graceMs: 0, skipNative: true },
        );
      }
      expect(syncEvent).not.toHaveBeenCalled();
      // The cancelled rows keep their native link / create marker, so the
      // scan's terminal-row query retries them once the listing works again.
      await priv.cancelOne(
        ended({ state: "scheduled", channelId: null }),
        null,
        false,
      );
      expect(syncEvent).toHaveBeenCalledTimes(1);
    });
  });

  it("removes its own successor when a lower-indexed sibling already exists", async () => {
    const { service, postAnnouncement } = buildService();
    const sibling = { _id: "occ-1", occurrenceIndex: 1 };
    EventMock.findOne = jest
      .fn()
      .mockResolvedValueOnce(null) // no later occurrence yet
      .mockResolvedValueOnce(null) // index slot free
      .mockResolvedValueOnce(sibling); // sibling found after our insert
    EventMock.deleteOne = jest.fn(async () => ({}));
    const later = new Date("2026-07-12T12:00:00Z"); // past occurrence 1's start
    const result = await (service as unknown as Spawner).spawnNextOccurrence(
      ended(),
      later,
    );
    expect(result).toBe(sibling);
    expect(created[0].occurrenceIndex).toBe(2);
    expect(EventMock.findOne).toHaveBeenLastCalledWith(
      expect.objectContaining({ spawnedFrom: "occ-0" }),
    );
    expect(EventMock.deleteOne).toHaveBeenCalledWith({ _id: created[0]._id });
    expect(postAnnouncement).not.toHaveBeenCalled();
    expect(EventMock.updateOne).toHaveBeenCalledWith(
      { _id: "occ-0" },
      { $set: { nextSpawned: true } },
    );
  });

  it("removes an already-posted announcement when the sibling check deletes the row", async () => {
    const { service } = buildService();
    const sibling = { _id: "occ-1", occurrenceIndex: 1 };
    EventMock.findOne = jest
      .fn()
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce(sibling);
    EventMock.deleteOne = jest.fn(async () => ({}));
    EventMock.findById = jest
      .fn()
      .mockResolvedValueOnce({ nextSpawned: false, seriesCancelled: false })
      .mockResolvedValue({
        guildId: "guild-1",
        announcementChannelId: "chan-1",
        announcementMessageId: "msg-orphan",
      });
    const del = jest.fn(async () => undefined);
    (service as unknown as { fetchTextChannel: jest.Mock }).fetchTextChannel =
      jest.fn(async () => ({
        messages: { fetch: jest.fn(async () => ({ delete: del })) },
      }));
    await (service as unknown as Spawner).spawnNextOccurrence(
      ended(),
      new Date("2026-07-12T12:00:00Z"),
    );
    expect(del).toHaveBeenCalled();
    expect(EventMock.deleteOne).toHaveBeenCalled();
  });

  it("retries a missing RSVP announcement on a recurring occurrence", async () => {
    const { service, postAnnouncement } = buildService();
    (service as unknown as { configService: unknown }).configService = {
      getString: jest.fn(async () => "chan-1"),
      getNumber: jest.fn(async () => 0),
      getBoolean: jest.fn(async () => true),
    };
    const soon = new Date(Date.now() + 24 * 60 * 60 * 1000);
    const occurrence = ended({
      state: "scheduled",
      announcementMessageId: null,
      channelId: null,
      startTime: soon,
      seriesStart: soon,
    });
    const run = (): Promise<void> =>
      (
        service as unknown as {
          processEvent: (...a: unknown[]) => Promise<void>;
        }
      ).processEvent(occurrence, {}, new Date(), {
        reminderMs: 0,
        leadMs: 0,
        graceMs: 0,
      });
    await run();
    expect(postAnnouncement).toHaveBeenCalledWith(occurrence);

    postAnnouncement.mockClear();
    occurrence.announcementMessageId = "msg-1";
    await run();
    expect(postAnnouncement).not.toHaveBeenCalled();
  });

  it("does not retry an announcement when no channel is configured", async () => {
    const { service, postAnnouncement } = buildService();
    (service as unknown as { configService: unknown }).configService = {
      getString: jest.fn(async () => ""),
      getNumber: jest.fn(async () => 0),
      getBoolean: jest.fn(async () => true),
    };
    const soon = new Date(Date.now() + 24 * 60 * 60 * 1000);
    await (
      service as unknown as {
        processEvent: (...a: unknown[]) => Promise<void>;
      }
    ).processEvent(
      ended({
        state: "scheduled",
        announcementMessageId: null,
        channelId: null,
        startTime: soon,
        seriesStart: soon,
      }),
      {},
      new Date(),
      { reminderMs: 0, leadMs: 0, graceMs: 0 },
    );
    expect(postAnnouncement).not.toHaveBeenCalled();
  });

  it("adopts the winner's row when the unique-key insert loses a race", async () => {
    const { service } = buildService();
    const winner = { _id: "occ-1" };
    // Later-occurrence lookup and pre-insert slot lookup both miss; only the
    // lookup after the insert rejects finds the winner.
    EventMock.findOne = jest
      .fn()
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce(null)
      .mockResolvedValue(winner);
    const save = jest.fn(async () => {
      throw Object.assign(new Error("E11000 duplicate key"), { code: 11000 });
    });
    EventMock.mockImplementation(function (this: Doc) {
      this.save = save;
    } as never);
    const next = await (service as unknown as Spawner).spawnNextOccurrence(
      ended(),
      NOW,
    );
    expect(next).toBe(winner);
    expect(save).toHaveBeenCalledTimes(1); // the insert really was attempted
    expect(EventMock.updateOne).toHaveBeenCalledWith(
      { _id: "occ-0" },
      { $set: { nextSpawned: true } },
    );
  });

  it("does not spawn while recurrence is disabled", async () => {
    const { service } = buildService(false);
    const next = await (service as unknown as Spawner).spawnNextOccurrence(
      ended(),
      NOW,
    );
    expect(next).toBeNull();
    expect(EventMock.findById).not.toHaveBeenCalled();
  });

  it("leaves the occurrence retryable when creating the successor fails", async () => {
    const { service } = buildService();
    EventMock.mockImplementation(function (this: Doc) {
      this.save = jest.fn(async () => {
        throw new Error("db down");
      });
    } as never);
    const previous = ended();
    const next = await (service as unknown as Spawner).spawnNextOccurrence(
      previous,
      NOW,
    );
    expect(next).toBeNull();
    expect(EventMock.updateOne).not.toHaveBeenCalled();
    expect(previous.nextSpawned).toBe(false);
  });

  it("adopts an existing occurrence rather than duplicating it", async () => {
    const { service } = buildService();
    const existing = { _id: "occ-1" };
    EventMock.findOne = jest.fn(async () => existing);
    const next = await (service as unknown as Spawner).spawnNextOccurrence(
      ended(),
      NOW,
    );
    expect(next).toBe(existing);
    expect(created).toHaveLength(0);
  });

  it("processEvent spawns the successor once a recurring event has ended", async () => {
    const { service } = buildService();
    const occurrence = ended({
      state: "active",
      channelId: null,
      reminderSent: true,
      startTime: new Date("2026-07-03T20:00:00Z"),
    });
    const guild = {
      channels: { cache: new Map(), fetch: jest.fn(async () => null) },
    };
    (
      service as unknown as { updateAnnouncement: jest.Mock }
    ).updateAnnouncement = jest.fn(async () => true);
    // The scheduled end reads the stored event to check its channels (none).
    const stored = { channelId: null, groupsEnabled: false, groups: [] };
    const previousFindById = EventMock.findById;
    EventMock.findById = jest.fn(() => ({
      lean: async () => stored,
      then: (ok: (v: unknown) => unknown) => Promise.resolve(stored).then(ok),
    }));
    await (
      service as unknown as {
        processEvent: (...a: unknown[]) => Promise<void>;
      }
    ).processEvent(occurrence, guild, NOW, {
      reminderMs: 0,
      leadMs: 0,
      graceMs: 0,
    });
    EventMock.findById = previousFindById;
    expect(occurrence.state).toBe("ended");
    expect(created).toHaveLength(1);
    expect(created[0].occurrenceIndex).toBe(1);
  });

  it("processEvent recovers a cancelled occurrence that never got a successor", async () => {
    const { service } = buildService();
    const soon = new Date(Date.now() + 24 * 60 * 60 * 1000);
    const occurrence = ended({
      state: "cancelled",
      startTime: soon,
      seriesStart: soon,
    });
    await (
      service as unknown as {
        processEvent: (...a: unknown[]) => Promise<void>;
      }
    ).processEvent(occurrence, {}, new Date(), {
      reminderMs: 0,
      leadMs: 0,
      graceMs: 0,
    });
    expect(created).toHaveLength(1);
    expect(created[0].occurrenceIndex).toBe(1);
  });

  it("processEvent does not respawn from a whole-series cancellation", async () => {
    const { service } = buildService();
    const occurrence = ended({ state: "cancelled", seriesCancelled: true });
    await (
      service as unknown as {
        processEvent: (...a: unknown[]) => Promise<void>;
      }
    ).processEvent(occurrence, {}, NOW, {
      reminderMs: 0,
      leadMs: 0,
      graceMs: 0,
    });
    expect(created).toHaveLength(0);
  });

  it("cancelEvent on one occurrence skips it and spawns the next", async () => {
    const { service } = buildService();
    const soon = new Date(Date.now() + 24 * 60 * 60 * 1000);
    const occurrence = ended({
      state: "scheduled",
      channelId: null,
      startTime: soon,
      seriesStart: soon,
    });
    EventMock.findById = jest.fn(async () => occurrence);
    (
      service as unknown as { updateAnnouncement: jest.Mock }
    ).updateAnnouncement = jest.fn(async () => true);
    const result = await service.cancelEvent("occ-0", "guild-1");
    expect(result?.state).toBe("cancelled");
    expect(created).toHaveLength(1);
    expect(created[0].occurrenceIndex).toBe(1);
  });

  it("cancelling refreshes the post from the re-read ids when a claim landed meanwhile", async () => {
    const { service } = buildService();
    const soon = new Date(Date.now() + 24 * 60 * 60 * 1000);
    const occurrence = ended({
      state: "scheduled",
      channelId: null,
      announcementChannelId: null,
      announcementMessageId: null,
      startTime: soon,
      seriesStart: soon,
    });
    EventMock.findById = jest
      .fn()
      .mockResolvedValueOnce(occurrence) // getEvent
      .mockResolvedValue({
        announcementChannelId: "chan-1",
        announcementMessageId: "msg-1",
      });
    let idsSeenByEdit: unknown;
    (
      service as unknown as { updateAnnouncement: jest.Mock }
    ).updateAnnouncement = jest.fn(
      async (e: { announcementMessageId: unknown }) => {
        idsSeenByEdit = e.announcementMessageId;
        return true;
      },
    );
    await service.cancelEvent("occ-0", "guild-1");
    expect(idsSeenByEdit).toBe("msg-1");
  });

  it("cancelEvent on a one-off event spawns nothing", async () => {
    const { service } = buildService();
    const oneOff = ended({
      state: "scheduled",
      recurrence: "none",
      seriesId: null,
      channelId: null,
    });
    EventMock.findById = jest.fn(async () => oneOff);
    (
      service as unknown as { updateAnnouncement: jest.Mock }
    ).updateAnnouncement = jest.fn(async () => true);
    await service.cancelEvent("occ-0", "guild-1");
    expect(created).toHaveLength(0);
    // The only write through the claim is the cancel itself.
    expect(EventMock.findOneAndUpdate).toHaveBeenCalledTimes(1);
    expect(EventMock.findOneAndUpdate.mock.calls[0]?.[1]).toEqual({
      $set: { state: "cancelled" },
    });
  });

  it("cancelSeries blocks spawning, then cancels every open occurrence", async () => {
    const { service } = buildService();
    const a = ended({ _id: "occ-1", state: "scheduled", channelId: null });
    const b = ended({ _id: "occ-2", state: "active", channelId: null });
    EventMock.findById = jest.fn(async () => a);
    EventMock.find = jest.fn(async () => [a, b]);
    (
      service as unknown as { updateAnnouncement: jest.Mock }
    ).updateAnnouncement = jest.fn(async () => true);
    const result = await service.cancelSeries("occ-1", "guild-1");
    expect(result?.cancelled).toBe(2);
    expect(a.state).toBe("cancelled");
    expect(b.state).toBe("cancelled");
    expect(a.seriesCancelled).toBe(true);
    expect(b.seriesCancelled).toBe(true);
    expect(EventMock.updateMany).toHaveBeenCalledWith(
      { guildId: "guild-1", seriesId: "occ-0" },
      { $set: { seriesCancelled: true } },
    );
    expect(created).toHaveLength(0);
  });

  it("cancelSeries refuses another guild's event", async () => {
    const { service } = buildService();
    EventMock.findById = jest.fn(async () => ended({ guildId: "other" }));
    expect(await service.cancelSeries("occ-0", "guild-1")).toBeNull();
    expect(EventMock.updateMany).not.toHaveBeenCalled();
  });

  it("cancelSeries on a one-off event just cancels it", async () => {
    const { service } = buildService();
    const oneOff = ended({
      state: "scheduled",
      recurrence: "none",
      seriesId: null,
      channelId: null,
    });
    EventMock.findById = jest.fn(async () => oneOff);
    (
      service as unknown as { updateAnnouncement: jest.Mock }
    ).updateAnnouncement = jest.fn(async () => true);
    const result = await service.cancelSeries("occ-0", "guild-1");
    expect(result?.cancelled).toBe(1);
    expect(oneOff.state).toBe("cancelled");
  });

  it("listSeries returns occurrences oldest first", async () => {
    const { service } = buildService();
    const sort = jest.fn(async () => []);
    EventMock.find = jest.fn(() => ({ sort }));
    await service.listSeries("guild-1", "occ-0");
    expect(EventMock.find).toHaveBeenCalledWith({
      guildId: "guild-1",
      seriesId: "occ-0",
    });
    expect(sort).toHaveBeenCalledWith({ occurrenceIndex: 1 });
  });
});

// Native-only events (#1175): new events are announced with the native event
// link; announcements and RSVPs shipped in 2.0.0 keep working.
describe("link announcement and legacy RSVP compatibility (#1175)", () => {
  type Priv = {
    buildAnnouncementPayload: (e: unknown) => {
      content: string;
      embeds: unknown[];
      components: unknown[];
      allowedMentions: { parse: unknown[] };
    };
    buildLegacyRsvpPayload: (e: unknown) => {
      embeds: unknown[];
      components: unknown[];
    };
    updateAnnouncement: (e: unknown) => Promise<boolean>;
    fetchTextChannelDetailed: jest.Mock;
    fetchTextChannel: jest.Mock;
    postReminder: (e: unknown) => Promise<void>;
    postAnnouncement: jest.Mock;
    nativeSync: { syncEvent: jest.Mock };
    processEvent: (...a: unknown[]) => Promise<void>;
  };

  function svc(): Priv {
    EventService.reset();
    return EventService.getInstance({} as never) as unknown as Priv;
  }

  function row(
    overrides: Record<string, unknown> = {},
  ): Record<string, unknown> {
    return {
      _id: "ev-1",
      guildId: "guild-1",
      title: "Game Night",
      description: "Bring snacks",
      startTime: new Date("2026-07-04T20:00:00Z"),
      timezone: "UTC",
      durationMinutes: 120,
      channelId: null,
      announcementChannelId: "chan-1",
      announcementMessageId: "msg-1",
      state: "scheduled",
      reminderSent: false,
      rsvps: [],
      recurrence: "none",
      seriesId: null,
      nativeEventId: "native-1",
      save: jest.fn(async () => undefined),
      ...overrides,
    };
  }

  it("announces with the native event link, no buttons and no pings", () => {
    const payload = svc().buildAnnouncementPayload(row());
    expect(payload.content).toContain("**Game Night**");
    expect(payload.content).toContain(
      "https://discord.com/events/guild-1/native-1",
    );
    expect(payload.embeds).toEqual([]);
    expect(payload.components).toEqual([]);
    expect(payload.allowedMentions).toEqual({ parse: [] });
  });

  it("omits the link when there is no native event, and for a finished event", () => {
    expect(
      svc().buildAnnouncementPayload(row({ nativeEventId: null })).content,
    ).not.toContain("discord.com/events");
    const cancelled = svc().buildAnnouncementPayload(
      row({ state: "cancelled" }),
    ).content;
    expect(cancelled).toContain("(cancelled)");
    expect(cancelled).not.toContain("discord.com/events");
  });

  function stubMessage(components: unknown[]): {
    edit: jest.Mock;
    service: Priv;
  } {
    const edit = jest.fn(async () => undefined);
    const service = svc();
    service.fetchTextChannelDetailed = jest.fn(async () => ({
      channel: {
        messages: { fetch: jest.fn(async () => ({ components, edit })) },
      },
      gone: false,
    }));
    return { edit, service };
  }

  it("re-renders a legacy announcement (it still has buttons) as the RSVP embed", async () => {
    const { edit, service } = stubMessage([{ type: 1 }]);
    await service.updateAnnouncement(
      row({ rsvps: [{ userId: "u", status: "going" }] }),
    );
    const sent = edit.mock.calls[0][0] as {
      embeds: unknown[];
      components: unknown[];
    };
    expect(sent.embeds).toHaveLength(1);
    expect(sent.components).toHaveLength(1);
  });

  it("re-renders a link announcement as plain content and clears embeds and components", async () => {
    const { edit, service } = stubMessage([]);
    await service.updateAnnouncement(row());
    const sent = edit.mock.calls[0][0] as {
      content: string;
      embeds: unknown[];
      components: unknown[];
    };
    expect(sent.content).toContain("discord.com/events/guild-1/native-1");
    expect(sent.embeds).toEqual([]);
    expect(sent.components).toEqual([]);
  });

  it("disables a legacy announcement's buttons once the event has ended", () => {
    const payload = svc().buildLegacyRsvpPayload(row({ state: "ended" }));
    const buttons = (
      payload.components[0] as {
        components: Array<{ data: { disabled?: boolean } }>;
      }
    ).components;
    expect(buttons.every((b) => b.data.disabled === true)).toBe(true);
  });

  async function remind(event: Record<string, unknown>): Promise<unknown> {
    const service = svc();
    const send = jest.fn(async () => undefined);
    service.fetchTextChannel = jest.fn(async () => ({ send }));
    await service.postReminder(event);
    return send.mock.calls[0][0];
  }

  it("the reminder carries the link and pings nobody for a new event", async () => {
    const sent = (await remind(row())) as {
      content: string;
      allowedMentions: unknown;
    };
    expect(sent.content).toContain("starts at");
    expect(sent.content).toContain("discord.com/events/guild-1/native-1");
    expect(sent.content).not.toContain("<@");
    expect(sent.allowedMentions).toEqual({ users: [] });
  });

  it("the reminder still pings Going/Maybe RSVPs of a legacy event with no native fields", async () => {
    const sent = (await remind(
      row({
        nativeEventId: null,
        rsvps: [
          { userId: "u1", status: "going" },
          { userId: "u2", status: "maybe" },
          { userId: "u3", status: "cant" },
        ],
      }),
    )) as { content: string; allowedMentions: { users: string[] } };
    expect(sent.content).toContain("<@u1> <@u2>");
    expect(sent.content).not.toContain("<@u3>");
    expect(sent.allowedMentions.users).toEqual(["u1", "u2"]);
  });

  it("createEvent creates the native event before posting the announcement", async () => {
    const service = svc();
    const order: string[] = [];
    service.nativeSync = {
      syncEvent: jest.fn(async () => {
        order.push("native");
      }),
    };
    service.postAnnouncement = jest.fn(async () => {
      order.push("announce");
    });
    EventMock.mockImplementation(function (
      this: Record<string, unknown>,
      doc: unknown,
    ) {
      Object.assign(this, doc, { save: async () => undefined });
    } as never);
    await (
      service as unknown as {
        createEvent: (i: unknown) => Promise<unknown>;
      }
    ).createEvent({
      guildId: "guild-1",
      title: "T",
      description: "",
      startTime: new Date(),
      timezone: "UTC",
      durationMinutes: 60,
      createdBy: "admin",
    });
    expect(order).toEqual(["native", "announce"]);
  });

  it("retries a failed link refresh on later scans until it succeeds, then stops", async () => {
    const service = svc();
    const event = row({ nativeEventId: null });
    service.nativeSync = {
      syncEvent: jest.fn(async () => {
        event.nativeEventId = event.nativeEventId ?? "native-9";
      }),
    };
    const update = jest
      .fn<() => Promise<boolean>>()
      .mockResolvedValueOnce(false) // transient edit failure
      .mockResolvedValue(true);
    (
      service as unknown as { updateAnnouncement: jest.Mock }
    ).updateAnnouncement = update;
    const scan = (): Promise<void> =>
      service.processEvent(event, {}, new Date("2026-07-04T10:00:00Z"), {
        reminderMs: 0,
        leadMs: 0,
        graceMs: 0,
      });
    await scan(); // link appears, edit fails
    await scan(); // ids unchanged, but the refresh is retried and succeeds
    await scan(); // verified: no more edits
    expect(update).toHaveBeenCalledTimes(2);
  });

  it("re-renders when the native id or the announcement message changes between scans", async () => {
    const service = svc();
    const event = row();
    service.nativeSync = { syncEvent: jest.fn(async () => undefined) };
    const update = jest.fn(async () => true);
    (
      service as unknown as { updateAnnouncement: jest.Mock }
    ).updateAnnouncement = update;
    const scan = (): Promise<void> =>
      service.processEvent(event, {}, new Date("2026-07-04T10:00:00Z"), {
        reminderMs: 0,
        leadMs: 0,
        graceMs: 0,
      });
    await scan();
    await scan();
    expect(update).toHaveBeenCalledTimes(1);
    // Another writer (replica, or the creator after losing a claim) changed
    // the stored ids; the sync saw no change within this scan.
    event.nativeEventId = "native-2";
    await scan();
    expect(update).toHaveBeenCalledTimes(2);
    event.announcementMessageId = "msg-2";
    await scan();
    expect(update).toHaveBeenCalledTimes(3);
    await scan();
    expect(update).toHaveBeenCalledTimes(3);
  });

  it("refreshes the announcement when the native link appears during a scan", async () => {
    const service = svc();
    const event = row({ nativeEventId: null });
    service.nativeSync = {
      syncEvent: jest.fn(async () => {
        event.nativeEventId = "native-9";
      }),
    };
    const update = jest.fn(async () => true);
    (
      service as unknown as { updateAnnouncement: jest.Mock }
    ).updateAnnouncement = update;
    await service.processEvent(event, {}, new Date("2026-07-04T10:00:00Z"), {
      reminderMs: 0,
      leadMs: 0,
      graceMs: 0,
    });
    expect(update).toHaveBeenCalledWith(event);
  });
});
