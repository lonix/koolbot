/**
 * Editing an upcoming event (#1298): the rules (pure), the conditional write in
 * `EventService.editEvent`, and what a moved start does to the scan's
 * decisions (reminder, lead-time channel) under fake timers.
 */
import {
  describe,
  it,
  expect,
  jest,
  beforeEach,
  afterEach,
} from "@jest/globals";

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
const EventStatics = Event as unknown as {
  findById: jest.Mock<(id: string) => unknown>;
  findOneAndUpdate: jest.Mock<(...a: unknown[]) => Promise<unknown>>;
};
const {
  EventService,
  shouldCreateChannel,
  shouldSendReminder,
  computeEndTime,
} = await import("../../src/services/event-service.js");
const { editModeOf, eventEditVersion, diffEventEdit, hasEdit } =
  await import("../../src/services/event-edit.js");

const MIN = 60 * 1000;
const NOW = new Date("2030-01-01T12:00:00Z");

type Row = Record<string, unknown> & {
  startTime: Date;
  title: string;
  description: string;
  timezone: string;
  durationMinutes: number;
  state: string;
  channelId: string | null;
};

function row(over: Record<string, unknown> = {}): Row {
  return {
    _id: "65a000000000000000000001",
    guildId: "guild-1",
    title: "Quiz night",
    description: "Bring a friend",
    state: "scheduled",
    startTime: new Date("2030-01-01T20:00:00Z"),
    timezone: "UTC",
    durationMinutes: 90,
    channelId: null,
    recurrence: "none",
    seriesId: null,
    reminderSent: true,
    nativeAdopted: false,
    ...over,
  } as Row;
}

describe("editModeOf", () => {
  it.each([
    ["a scheduled event with no channel", {}, "full"],
    ["an active event", { state: "active", channelId: "c" }, "limited"],
    ["a scheduled event whose channel exists", { channelId: "c" }, "limited"],
    [
      "a scheduled event whose start has passed",
      { startTime: new Date(NOW.getTime() - MIN) },
      "limited",
    ],
    ["an ended event", { state: "ended" }, "refused"],
    ["a cancelled event", { state: "cancelled" }, "refused"],
    ["a weekly event", { recurrence: "weekly" }, "refused"],
    ["a series occurrence", { seriesId: "s1" }, "refused"],
    ["an adopted event", { nativeAdopted: true }, "refused"],
  ])("classifies %s", (_n, over, mode) => {
    expect(editModeOf(row(over), NOW).mode).toBe(mode);
  });

  it("refuses an event that is being ended, whatever else is true", () => {
    expect(editModeOf(row(), NOW, true)).toMatchObject({
      mode: "refused",
      reason: "ending",
    });
  });
});

describe("eventEditVersion and diffEventEdit", () => {
  it("moves with every editable field and with the state, not with anything else", () => {
    const base = eventEditVersion(row());
    expect(eventEditVersion(row({ reminderSent: false }))).toBe(base);
    for (const over of [
      { title: "x" },
      { description: "x" },
      { startTime: new Date(NOW.getTime() + MIN) },
      { timezone: "Europe/Oslo" },
      { durationMinutes: 91 },
      { state: "active" },
      { channelId: "c" },
    ]) {
      expect(eventEditVersion(row(over))).not.toBe(base);
    }
  });

  it("lists only the fields that changed, as plain values", () => {
    const before = row();
    const diff = diffEventEdit(before, {
      ...before,
      title: "New",
      startTime: new Date("2030-01-01T21:00:00Z"),
    });
    expect(diff).toEqual({
      before: { title: "Quiz night", startTime: "2030-01-01T20:00:00.000Z" },
      after: { title: "New", startTime: "2030-01-01T21:00:00.000Z" },
    });
    expect(hasEdit(diffEventEdit(before, before))).toBe(false);
  });
});

describe("EventService.editEvent", () => {
  type Priv = {
    nativeSync: { syncEvent: jest.Mock };
    updateAnnouncement: jest.Mock;
    isBeingEnded: jest.Mock;
    claimEventChannel: (
      e: unknown,
      g: unknown,
      o: { enforceLead?: boolean },
    ) => Promise<unknown>;
    createEventChannel: jest.Mock;
    deleteEventChannel: jest.Mock;
  };
  let stored: Row;
  let service: InstanceType<typeof EventService> & Priv;

  beforeEach(() => {
    EventService.reset();
    service = EventService.getInstance({
      guilds: { fetch: jest.fn(async () => ({ id: "guild-1" })) },
    } as never) as never;
    service.nativeSync = { syncEvent: jest.fn(async () => undefined) };
    service.updateAnnouncement = jest.fn(async () => true);
    stored = row();
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
    jest.useRealTimers();
    EventService.reset();
  });

  const input = (changes: Record<string, unknown>, over = {}) => ({
    eventId: "65a000000000000000000001",
    guildId: "guild-1",
    expectedVersion: eventEditVersion(stored),
    now: NOW,
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

  it("writes only the changed fields, conditioned on the state it judged", async () => {
    const res = await service.editEvent(input({ title: "New" }) as never);
    expect(res.ok).toBe(true);
    const [filter, update] = EventStatics.findOneAndUpdate.mock
      .calls[0] as Array<Record<string, unknown>>;
    expect(update).toEqual({ $set: { title: "New" } });
    expect(filter).toMatchObject({
      guildId: "guild-1",
      state: "scheduled",
      channelId: null,
      title: "Quiz night",
      startTime: stored.startTime,
      durationMinutes: 90,
      nativeAdopted: { $ne: true },
      timezone: "UTC",
    });
  });

  it("matches an empty stored timezone the way the version token reads it", async () => {
    stored = row({ timezone: undefined });
    await service.editEvent(
      input({ title: "New", timezone: "" }, { now: NOW }) as never,
    );
    const filter = EventStatics.findOneAndUpdate.mock.calls[0][0] as Record<
      string,
      unknown
    >;
    expect(filter.timezone).toEqual({ $in: ["", null] });
  });

  it("re-arms the reminder only when the start moves", async () => {
    await service.editEvent(input({ title: "New" }) as never);
    expect(
      (EventStatics.findOneAndUpdate.mock.calls[0][1] as { $set: object }).$set,
    ).not.toHaveProperty("reminderSent");
    await service.editEvent(
      input({ startTime: new Date("2030-01-01T22:00:00Z") }) as never,
    );
    expect(
      (EventStatics.findOneAndUpdate.mock.calls[1][1] as { $set: object }).$set,
    ).toMatchObject({ reminderSent: false });
  });

  it("refuses a moved start or a new title on a started event, writing nothing", async () => {
    stored = row({ state: "active", channelId: "c" });
    for (const changes of [
      { startTime: new Date("2030-01-01T22:00:00Z") },
      { title: "Renamed" },
      { timezone: "Europe/Oslo" },
    ]) {
      const res = await service.editEvent(input(changes) as never);
      expect(res).toMatchObject({ ok: false, code: "locked" });
    }
    expect(EventStatics.findOneAndUpdate).not.toHaveBeenCalled();
  });

  it("refuses a start in the past and a duration that ends a started event", async () => {
    expect(
      await service.editEvent(
        input({ startTime: new Date(NOW.getTime() - MIN) }) as never,
      ),
    ).toMatchObject({ ok: false, code: "past" });
    stored = row({
      state: "active",
      channelId: "c",
      startTime: new Date(NOW.getTime() - 60 * MIN),
    });
    expect(
      await service.editEvent(input({ durationMinutes: 30 }) as never),
    ).toMatchObject({ ok: false, code: "bad-end" });
    expect(EventStatics.findOneAndUpdate).not.toHaveBeenCalled();
  });

  it("refuses finished, recurring, adopted and ending events", async () => {
    for (const over of [
      { state: "ended" },
      { recurrence: "weekly", seriesId: "s" },
      { nativeAdopted: true },
    ]) {
      stored = row(over);
      expect(
        await service.editEvent(input({ title: "New" }) as never),
      ).toMatchObject({ ok: false, code: "refused" });
    }
    stored = row();
    service.isBeingEnded = jest.fn(() => true);
    expect(
      await service.editEvent(input({ title: "New" }) as never),
    ).toMatchObject({ ok: false, code: "refused" });
    expect(EventStatics.findOneAndUpdate).not.toHaveBeenCalled();
  });

  it("reports a conflict for an old form, and when the conditional write matches nothing", async () => {
    expect(
      await service.editEvent(
        input({ title: "New" }, { expectedVersion: "stale" }) as never,
      ),
    ).toMatchObject({ ok: false, code: "conflict" });
    expect(EventStatics.findOneAndUpdate).not.toHaveBeenCalled();

    EventStatics.findOneAndUpdate = jest.fn(async () => null);
    expect(
      await service.editEvent(input({ title: "New" }) as never),
    ).toMatchObject({ ok: false, code: "conflict" });
    expect(service.nativeSync.syncEvent).not.toHaveBeenCalled();
    expect(service.updateAnnouncement).not.toHaveBeenCalled();
  });

  it("refuses a new title or start while a native create is unresolved, but not a new description", async () => {
    stored = row({
      nativeEventId: null,
      nativeCreateStartedAt: new Date(NOW.getTime() - 60_000),
    });
    expect(
      await service.editEvent(input({ title: "Renamed" }) as never),
    ).toMatchObject({ ok: false, code: "native-pending" });
    expect(
      await service.editEvent(
        input({ startTime: new Date("2030-01-01T22:00:00Z") }) as never,
      ),
    ).toMatchObject({ ok: false, code: "native-pending" });
    expect(EventStatics.findOneAndUpdate).not.toHaveBeenCalled();
    expect(
      await service.editEvent(input({ description: "New text" }) as never),
    ).toMatchObject({ ok: true });
  });

  it("conditions an identity edit on the native link, and a plain one does not", async () => {
    stored = row({ nativeEventId: "n1", nativeCreateStartedAt: null });
    await service.editEvent(input({ title: "Renamed" }) as never);
    expect(EventStatics.findOneAndUpdate.mock.calls[0][0]).toMatchObject({
      nativeEventId: "n1",
      nativeCreateStartedAt: null,
    });
    await service.editEvent(input({ description: "Text" }) as never);
    expect(EventStatics.findOneAndUpdate.mock.calls[1][0]).not.toHaveProperty(
      "nativeEventId",
    );
  });

  it("clears the announcement verification once the refresh has settled, even if it failed", async () => {
    const id = "65a000000000000000000001";
    const verified = (
      service as unknown as { linkVerified: Map<string, string> }
    ).linkVerified;
    // A scan certifies the post while this edit's refresh is still running.
    service.updateAnnouncement = jest.fn(async () => {
      verified.set(id, "certified-by-scan");
      throw new Error("discord down");
    });
    await service.editEvent(input({ title: "New" }) as never);
    expect(verified.has(id)).toBe(false);
  });

  it("answers not-found for another guild's event", async () => {
    expect(
      await service.editEvent(input({}, { guildId: "other" }) as never),
    ).toMatchObject({ ok: false, code: "not-found" });
  });

  it("syncs the native event and edits the announcement with the stored row", async () => {
    const res = await service.editEvent(input({ title: "New" }) as never);
    expect(res.ok).toBe(true);
    expect(service.nativeSync.syncEvent).toHaveBeenCalledTimes(1);
    expect(service.updateAnnouncement).toHaveBeenCalledTimes(1);
    expect((service.nativeSync.syncEvent.mock.calls[0][0] as Row).title).toBe(
      "New",
    );
  });

  it("still succeeds when the Discord follow-ups fail (the scan repairs them)", async () => {
    service.nativeSync.syncEvent = jest.fn(async () => {
      throw new Error("discord down");
    });
    service.updateAnnouncement = jest.fn(async () => {
      throw new Error("discord down");
    });
    expect(
      await service.editEvent(input({ title: "New" }) as never),
    ).toMatchObject({ ok: true });
  });

  describe("what the scan decides after a moved start (fake timers)", () => {
    const REMINDER = 30 * MIN;
    const LEAD = 15 * MIN;

    it("fires neither the channel nor the reminder at the old time, and both at the new one", async () => {
      jest.useFakeTimers();
      // Old start 20:00. Reminder already sent, which is why it must be re-armed.
      const oldStart = stored.startTime;
      const newStart = new Date("2030-01-01T22:00:00Z");
      const res = await service.editEvent(
        input({ startTime: newStart }) as never,
      );
      if (!res.ok) throw new Error("edit failed");
      const edited = res.event as unknown as Row;

      // 19:50: inside the OLD lead window and reminder window.
      jest.setSystemTime(new Date(oldStart.getTime() - 10 * MIN));
      const lifecycle = (): Parameters<typeof shouldCreateChannel>[0] =>
        edited as never;
      expect(shouldCreateChannel(lifecycle(), new Date(), LEAD)).toBe(false);
      expect(shouldSendReminder(lifecycle(), new Date(), REMINDER)).toBe(false);

      // 21:50: inside the NEW windows. The reminder, sent for the old time, is
      // owed again because the edit cleared `reminderSent`.
      jest.setSystemTime(new Date(newStart.getTime() - 10 * MIN));
      expect(shouldCreateChannel(lifecycle(), new Date(), LEAD)).toBe(true);
      expect(edited.reminderSent).toBe(false);
      expect(shouldSendReminder(lifecycle(), new Date(), REMINDER)).toBe(true);
    });

    it("the end moves with the start and the duration", async () => {
      const newStart = new Date("2030-01-01T22:00:00Z");
      const res = await service.editEvent(
        input({ startTime: newStart, durationMinutes: 30 }) as never,
      );
      if (!res.ok) throw new Error("edit failed");
      const e = res.event as unknown as Row;
      expect(computeEndTime(e.startTime, e.durationMinutes).toISOString()).toBe(
        "2030-01-01T22:30:00.000Z",
      );
    });
  });

  describe("the channel claim after a moved start", () => {
    it("is conditioned on the start time the scan decided from", async () => {
      service.createEventChannel = jest.fn(async () => ({ id: "c-new" }));
      service.deleteEventChannel = jest.fn(async () => undefined);
      EventStatics.findOneAndUpdate = jest.fn(async () => null);
      const scanCopy = row();
      await service.claimEventChannel(
        scanCopy,
        { id: "guild-1" },
        {
          enforceLead: true,
        },
      );
      const filter = EventStatics.findOneAndUpdate.mock.calls[0][0] as Record<
        string,
        unknown
      >;
      // An edit that moved the start meanwhile makes this claim fail, and the
      // channel the scan just created for the old start is removed again.
      expect(filter.startTime).toEqual(scanCopy.startTime);
      expect(filter.channelId).toBeNull();
      expect(service.deleteEventChannel).toHaveBeenCalled();
    });

    it("is conditioned on the title the channel was named from, so a rename during creation removes the channel", async () => {
      service.createEventChannel = jest.fn(async () => ({ id: "c-new" }));
      service.deleteEventChannel = jest.fn(async () => undefined);
      EventStatics.findOneAndUpdate = jest.fn(async () => null);
      await service.claimEventChannel(row(), { id: "guild-1" }, {});
      const filter = EventStatics.findOneAndUpdate.mock.calls[0][0] as Record<
        string,
        unknown
      >;
      expect(filter.title).toBe("Quiz night");
      expect(service.deleteEventChannel).toHaveBeenCalled();
    });

    it("leaves the title out for an adopted event, whose scan copy carries a pulled title", async () => {
      service.createEventChannel = jest.fn(async () => ({ id: "c-new" }));
      EventStatics.findOneAndUpdate = jest.fn(async () => ({}));
      await service.claimEventChannel(
        row({ nativeAdopted: true }),
        { id: "guild-1" },
        {},
      );
      const filter = EventStatics.findOneAndUpdate.mock.calls[0][0] as Record<
        string,
        unknown
      >;
      expect(filter).not.toHaveProperty("title");
    });

    it("does not condition Start now on the start time", async () => {
      service.createEventChannel = jest.fn(async () => ({ id: "c-new" }));
      EventStatics.findOneAndUpdate = jest.fn(async () => ({}));
      await service.claimEventChannel(row(), { id: "guild-1" }, {});
      const filter = EventStatics.findOneAndUpdate.mock.calls[0][0] as Record<
        string,
        unknown
      >;
      expect(filter).not.toHaveProperty("startTime");
    });
  });
});

describe("the announcement refresh after a scan that held an older row (#1298)", () => {
  type Scan = {
    nativeSync: { syncEvent: jest.Mock };
    updateAnnouncement: jest.Mock;
    logLifecycle: jest.Mock;
    processEvent: (...a: unknown[]) => Promise<void>;
  };

  function scanService(): Scan {
    EventService.reset();
    const service = EventService.getInstance({
      guilds: { fetch: jest.fn(async () => ({ id: "guild-1" })) },
    } as never) as unknown as Scan;
    service.nativeSync = { syncEvent: jest.fn(async () => undefined) };
    service.updateAnnouncement = jest.fn(async () => true);
    service.logLifecycle = jest.fn(async () => undefined);
    return service;
  }

  const windows = { reminderMs: 0, leadMs: 0, graceMs: 0, native: new Map() };
  const copy = (over: Record<string, unknown> = {}) =>
    row({
      announcementMessageId: "m1",
      announcementChannelId: "c1",
      nativeEventId: "n1",
      startTime: new Date("2030-06-01T20:00:00Z"),
      save: jest.fn(async () => undefined),
      ...over,
    });
  const now = new Date("2030-06-01T10:00:00Z");

  it("refreshes again from a fresh row after an older copy certified its own content", async () => {
    const service = scanService();
    // The scan that read the row before the edit finishes its refresh late.
    await service.processEvent(copy(), { id: "guild-1" }, now, windows);
    expect(service.updateAnnouncement).toHaveBeenCalledTimes(1);
    // Same copy again: already verified, nothing to do.
    await service.processEvent(copy(), { id: "guild-1" }, now, windows);
    expect(service.updateAnnouncement).toHaveBeenCalledTimes(1);
    // A zone change that keeps the instant changes the text, so it refreshes too.
    await service.processEvent(
      copy({ timezone: "Etc/UTC" }),
      { id: "guild-1" },
      now,
      windows,
    );
    expect(service.updateAnnouncement).toHaveBeenCalledTimes(2);
    // The next scan reads the edited row: another title, so it must refresh.
    await service.processEvent(
      copy({ title: "Edited" }),
      { id: "guild-1" },
      now,
      windows,
    );
    expect(service.updateAnnouncement).toHaveBeenCalledTimes(3);
  });
});
