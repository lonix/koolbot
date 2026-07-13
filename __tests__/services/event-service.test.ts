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
  findById: jest.Mock;
  findOneAndUpdate: jest.Mock;
};

const {
  EventService,
  computeEndTime,
  parseEventDateTime,
  countRsvps,
  upsertRsvp,
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

describe("upsertRsvp", () => {
  const now = new Date("2026-07-01T00:00:00Z");
  it("adds a new RSVP without mutating the input", () => {
    const original = [
      { userId: "a", status: "going" as const, respondedAt: now },
    ];
    const next = upsertRsvp(original, "b", "maybe", now);
    expect(next).toHaveLength(2);
    expect(original).toHaveLength(1);
  });
  it("replaces an existing member's response", () => {
    const original = [
      { userId: "a", status: "going" as const, respondedAt: now },
    ];
    const next = upsertRsvp(original, "a", "cant", now);
    expect(next).toHaveLength(1);
    expect(next[0]).toMatchObject({ userId: "a", status: "cant" });
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

// Regression tests for #730: cron and "start now" must not both create a
// channel for the same event. Channel creation is guarded by an atomic
// `findOneAndUpdate({ channelId: null })` claim, exercised here through
// `startEventNow`.
describe("claimEventChannel (start-now path)", () => {
  const CATEGORY_ID = "cat-1";

  function buildService(opts: {
    findOneAndUpdate: unknown;
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
    EventMock.findOneAndUpdate = jest.fn(async () => opts.findOneAndUpdate);

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
});
