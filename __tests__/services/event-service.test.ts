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

  function stubEvents(
    rows: Array<{ _id: string; state: string }>,
  ): jest.Mock {
    EventMock.find = jest.fn(async () => rows);
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
        svc as unknown as { updateAnnouncement: () => Promise<void> },
        "updateAnnouncement",
      )
      .mockResolvedValue(undefined);

    const removed = await svc.removeRsvp("guild-1", "user-1");

    expect(removed).toBe(1);
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
        svc as unknown as { updateAnnouncement: () => Promise<void> },
        "updateAnnouncement",
      )
      .mockResolvedValue(undefined);

    const removed = await svc.removeRsvp("guild-1", "user-1");

    expect(removed).toBe(3);
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
      .mockResolvedValue(undefined);

    await svc.removeRsvp("guild-1", "user-1");

    // Editing a finished event's post is churn nobody reads.
    expect(render).toHaveBeenCalledTimes(1);
    expect(
      (render.mock.calls[0] as [{ _id: string }])[0]._id,
    ).toBe("e-live");
  });

  it("re-renders from the post-pull document so the counts are right", async () => {
    EventMock.find = jest.fn(async () => [{ _id: "e1", state: "scheduled" }]);
    const afterPull = { _id: "e1", state: "scheduled", rsvps: [] };
    EventMock.findByIdAndUpdate = jest.fn(async () => afterPull);
    const svc = buildService();
    const render = jest
      .spyOn(
        svc as unknown as { updateAnnouncement: (e: unknown) => Promise<void> },
        "updateAnnouncement",
      )
      .mockResolvedValue(undefined);

    await svc.removeRsvp("guild-1", "user-1");

    expect(render).toHaveBeenCalledWith(afterPull);
  });

  it("returns 0 without writing when the member has no RSVPs", async () => {
    stubEvents([]);
    const svc = buildService();

    expect(await svc.removeRsvp("guild-1", "user-1")).toBe(0);
    expect(EventMock.findByIdAndUpdate).not.toHaveBeenCalled();
  });

  it("skips an event that vanished between the scan and the pull", async () => {
    EventMock.find = jest.fn(async () => [{ _id: "gone", state: "scheduled" }]);
    EventMock.findByIdAndUpdate = jest.fn(async () => null);
    const svc = buildService();
    const render = jest
      .spyOn(
        svc as unknown as { updateAnnouncement: () => Promise<void> },
        "updateAnnouncement",
      )
      .mockResolvedValue(undefined);

    expect(await svc.removeRsvp("guild-1", "user-1")).toBe(0);
    expect(render).not.toHaveBeenCalled();
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
