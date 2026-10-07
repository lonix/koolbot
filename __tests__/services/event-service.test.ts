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

    const result = await buildService().setRsvp(EVENT_ID, "user-1", "going");

    expect(result).toBe(updated);
    expect(EventMock.findOneAndUpdate).toHaveBeenCalledTimes(1);
    expect(EventMock.findOneAndUpdate).toHaveBeenCalledWith(
      // The state filter doubles as the finished-event guard.
      { _id: EVENT_ID, state: { $nin: ["cancelled", "ended"] } },
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
      { new: true },
    );
  });

  it("returns null when the event is missing, ended or cancelled", async () => {
    EventMock.findOneAndUpdate = jest.fn(async () => null);

    const result = await buildService().setRsvp(EVENT_ID, "user-1", "maybe");

    expect(result).toBeNull();
  });

  it("returns null for a malformed event id without touching the database", async () => {
    EventMock.findOneAndUpdate = jest.fn(async () => null);

    const result = await buildService().setRsvp("not-an-id", "user-1", "cant");

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
      { new: true },
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
      { _id: "evt-1", channelId: null },
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
    // 02:30 does not exist in London on 2026-03-29.
    const anchor = new Date("2026-03-22T02:30:00Z");
    const result = computeOccurrenceStart(anchor, "weekly", 1, "Europe/London");
    expect(Number.isNaN(result.getTime())).toBe(false);
    expect(result.getTime()).toBeGreaterThan(anchor.getTime());
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

  it("spawns the next occurrence with fresh RSVPs and the series identity", async () => {
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
      rsvps: [],
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

  it("adopts the winner's row when the unique-key insert loses a race", async () => {
    const { service } = buildService();
    const winner = { _id: "occ-1" };
    EventMock.findOne = jest
      .fn()
      .mockResolvedValueOnce(null)
      .mockResolvedValue(winner);
    EventMock.mockImplementation(function (this: Doc) {
      this.save = jest.fn(async () => {
        throw Object.assign(new Error("E11000 duplicate key"), { code: 11000 });
      });
    } as never);
    const next = await (service as unknown as Spawner).spawnNextOccurrence(
      ended(),
      NOW,
    );
    expect(next).toBe(winner);
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
    await (
      service as unknown as {
        processEvent: (...a: unknown[]) => Promise<void>;
      }
    ).processEvent(occurrence, guild, NOW, {
      reminderMs: 0,
      leadMs: 0,
      graceMs: 0,
    });
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
    expect(EventMock.findOneAndUpdate).not.toHaveBeenCalled();
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
