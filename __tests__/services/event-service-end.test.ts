import { describe, it, expect, jest, beforeEach } from "@jest/globals";
import { ChannelType, TextChannel } from "discord.js";

// How EventService runs the shared teardown (#1193): the scheduled end
// (`processEvent`) and "End event now" (`endEventNow`) both go through the one
// real `EventTeardown`. The database is a small stateful fake, so the atomic
// claim really matches on state; the Discord-facing passes are stubs the way
// event-service-group-channels.test.ts has them.

type Row = Record<string, unknown>;
let store: Map<string, Row>;
let claimDelay: Promise<void> | null = null;
let eventsEnabled = true;

const configMock = {
  registerReloadCallback: jest.fn(),
  addChangeListener: jest.fn(),
  getBoolean: jest.fn(async (k: string, d?: unknown) =>
    k === "events.enabled" ? eventsEnabled : d,
  ),
  getString: jest.fn(async (_k: string, d?: unknown) => d),
  getNumber: jest.fn(async (_k: string, d?: unknown) => d),
};
jest.unstable_mockModule("../../src/services/config-service.js", () => ({
  ConfigService: { getInstance: jest.fn(() => configMock) },
}));
jest.unstable_mockModule("../../src/services/discord-logger.js", () => ({
  DiscordLogger: { getInstance: jest.fn() },
}));
const actualCover = await import("../../src/services/event-cover.js");
jest.unstable_mockModule("../../src/services/event-cover.js", () => ({
  ...actualCover,
  sweepOrphanCovers: jest.fn(async () => undefined),
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
  findOneAndUpdate: jest.Mock;
  findById: jest.Mock;
  updateOne: jest.Mock;
  deleteOne: jest.Mock;
};
const { EventService } = await import("../../src/services/event-service.js");

const MIN = 60_000;
const START = new Date("2026-07-04T20:00:00Z");
const END = new Date("2026-07-04T22:00:00Z");
const AFTER_END = new Date("2026-07-04T22:05:00Z");
const HOST = "222222222222222222";
const ID = "65a000000000000000000001";
const WINDOWS = { reminderMs: 0, leadMs: 15 * MIN, graceMs: 15 * MIN };

interface Priv {
  processEvent: (...a: unknown[]) => Promise<void>;
  endEventNow: (
    id: string,
    guildId: string,
    o: { pullBack: boolean },
  ) => Promise<{ status: string } & Record<string, unknown>>;
  nativeSync: Record<string, jest.Mock>;
  updateAnnouncement: jest.Mock;
  postReminder: jest.Mock;
  deleteEventChannel: jest.Mock;
  groupChannels: { reconcile: jest.Mock; cleanup: jest.Mock };
  teardown: { run: (i: Record<string, unknown>) => Promise<unknown> };
  linkVerified: Map<string, string>;
}

function emptyReport(): never {
  return {
    created: 0,
    removed: 0,
    occupied: 0,
    failures: [],
    warnings: [],
  } as never;
}

function setup(): {
  service: Priv;
  guild: {
    id: string;
    channels: {
      cache: Map<string, unknown>;
      fetch: (id: string) => Promise<unknown>;
    };
  };
} {
  EventService.reset();
  const guild = {
    id: "guild-1",
    channels: { cache: new Map(), fetch: jest.fn(async () => null) },
  };
  const client = { guilds: { fetch: jest.fn(async () => guild) } };
  const service = EventService.getInstance(client as never) as unknown as Priv;
  service.nativeSync = {
    syncEvent: jest.fn(async () => undefined),
    loadCache: jest.fn(async () => null),
    pullAdopted: jest.fn(),
    adoptedHasChannel: jest.fn(),
  };
  service.updateAnnouncement = jest.fn(async () => true);
  service.postReminder = jest.fn(async () => undefined);
  service.deleteEventChannel = jest.fn(async () => undefined);
  service.groupChannels.reconcile = jest.fn(async () => emptyReport());
  service.groupChannels.cleanup = jest.fn(async () => emptyReport());
  return { service, guild };
}

function row(over: Row = {}): Row {
  return {
    _id: ID,
    guildId: "guild-1",
    title: "Game Night",
    startTime: START,
    durationMinutes: 120,
    categoryId: "cat-1",
    channelId: "main-1",
    state: "active",
    endedAt: null,
    reminderSent: true,
    recurrence: "none",
    seriesId: null,
    groupsEnabled: false,
    groups: [],
    nativeEventId: "native-1",
    announcementMessageId: null,
    createdBy: HOST,
    save: jest.fn(async () => undefined),
    ...over,
  };
}

function stored(over: Row = {}): Row {
  const r = row(over);
  delete r.save;
  return r;
}

beforeEach(() => {
  store = new Map([[ID, stored()]]);
  claimDelay = null;
  eventsEnabled = true;
  EventMock.find = jest.fn(async () => []);
  EventMock.updateOne = jest.fn(async () => ({ modifiedCount: 0 }));
  EventMock.deleteOne = jest.fn(async () => ({}));
  EventMock.findOneAndUpdate = jest.fn(
    async (
      filter: Record<string, unknown>,
      update: { $set: Row },
    ): Promise<Row | null> => {
      if (claimDelay) await claimDelay;
      const r = store.get(filter._id as string);
      if (!r || r.guildId !== filter.guildId) return null;
      const states = (filter.state as { $in: string[] }).$in;
      if (!states.includes(r.state as string)) return null;
      if (
        filter.startTime &&
        +(r.startTime as Date) !== +(filter.startTime as Date)
      )
        return null;
      if (
        filter.durationMinutes !== undefined &&
        r.durationMinutes !== filter.durationMinutes
      ) {
        return null;
      }
      Object.assign(r, update.$set);
      return { ...r };
    },
  );
  EventMock.findById = jest.fn((id: string) => {
    const r = store.get(id);
    const value = r ? { ...r } : null;
    return {
      lean: async () => value,
      catch: () => Promise.resolve(value),
      then: (ok: (v: unknown) => unknown) => Promise.resolve(value).then(ok),
    };
  });
});

describe("the scheduled end runs the shared teardown", () => {
  it("through the one teardown, with an atomic claim on the times the scan read", async () => {
    const { service, guild } = setup();
    const run = jest.spyOn(service.teardown, "run");
    const event = row();
    await service.processEvent(event, guild, AFTER_END, WINDOWS);

    expect(run).toHaveBeenCalledTimes(1);
    const input = run.mock.calls[0]?.[0] as Record<string, unknown>;
    expect(input).toMatchObject({
      eventId: ID,
      guildId: "guild-1",
      trigger: "scheduled",
      pullBack: false,
      fromStates: ["scheduled", "active"],
      expectTimes: { startTime: START, durationMinutes: 120 },
      syncNative: false,
    });
    // The recorded end is the scheduled one, so the grace period is what it was.
    expect(input.endedAt).toEqual(END);
    expect(store.get(ID)?.state).toBe("ended");
    expect(store.get(ID)?.endedAt).toEqual(END);
    // The scan's own copy follows and is saved once.
    expect(event.state).toBe("ended");
    expect(event.endedAt).toEqual(END);
    expect((event.save as jest.Mock).mock.calls).toHaveLength(1);
  });

  it("closes the native event once, with its own sync, from the ended row", async () => {
    const { service, guild } = setup();
    const states: unknown[] = [];
    service.nativeSync.syncEvent = jest.fn(async (e: unknown) => {
      states.push((e as Row).state);
    });
    await service.processEvent(row(), guild, AFTER_END, WINDOWS);
    expect(states).toEqual(["ended"]);
  });

  it("refreshes the announcement once", async () => {
    const { service, guild } = setup();
    await service.processEvent(row(), guild, AFTER_END, WINDOWS);
    expect(service.updateAnnouncement).toHaveBeenCalledTimes(1);
  });

  it("a plain event: no group pass, no leader clearing, no extra read", async () => {
    const { service, guild } = setup();
    await service.processEvent(row(), guild, AFTER_END, WINDOWS);
    expect(service.groupChannels.cleanup).not.toHaveBeenCalled();
    expect(service.groupChannels.reconcile).not.toHaveBeenCalled();
    expect(EventMock.updateOne).not.toHaveBeenCalled();
    expect(EventMock.findOneAndUpdate).toHaveBeenCalledTimes(1);
    expect(EventMock.findById).not.toHaveBeenCalled();
  });

  it("a group event: the group channels go in the teardown, and the scan does not run its own pass again", async () => {
    const { service, guild } = setup();
    const groups = [
      { key: "g_a", name: "A", kind: "team", channelId: "c1", memberIds: [] },
    ];
    store.set(ID, stored({ groupsEnabled: true, groups }));
    await service.processEvent(
      row({ groupsEnabled: true, groups }),
      guild,
      AFTER_END,
      WINDOWS,
    );
    expect(service.groupChannels.cleanup).toHaveBeenCalledTimes(1);
  });

  it("an end that was cancelled meanwhile is left alone: nothing saved, no native sync", async () => {
    const { service, guild } = setup();
    store.set(ID, stored({ state: "cancelled" }));
    const event = row();
    await service.processEvent(event, guild, AFTER_END, WINDOWS);
    expect(store.get(ID)?.state).toBe("cancelled");
    expect(event.save).not.toHaveBeenCalled();
    expect(service.nativeSync.syncEvent).not.toHaveBeenCalled();
    expect(service.updateAnnouncement).not.toHaveBeenCalled();
  });

  it("a schedule edited since the scan read it is not ended on the old times", async () => {
    const { service, guild } = setup();
    store.set(ID, stored({ durationMinutes: 600 }));
    const event = row();
    await service.processEvent(event, guild, AFTER_END, WINDOWS);
    expect(store.get(ID)?.state).toBe("active");
    expect(event.save).not.toHaveBeenCalled();
    expect(service.nativeSync.syncEvent).not.toHaveBeenCalled();
  });

  it("an event a manual end got to first is followed, not ended twice", async () => {
    const { service, guild } = setup();
    store.set(ID, stored({ state: "ended", endedAt: AFTER_END }));
    const event = row();
    const run = jest.spyOn(service.teardown, "run");
    await service.processEvent(event, guild, AFTER_END, WINDOWS);
    expect(run).toHaveBeenCalledTimes(1);
    expect(event.state).toBe("ended");
    expect(event.endedAt).toEqual(AFTER_END);
    // Nothing of the teardown ran a second time.
    expect(service.updateAnnouncement).not.toHaveBeenCalled();
    expect(service.groupChannels.cleanup).not.toHaveBeenCalled();
  });
});

describe("End event now", () => {
  it("runs the same teardown, as a manual end, claiming only an active event", async () => {
    const { service } = setup();
    const run = jest.spyOn(service.teardown, "run");
    const outcome = await service.endEventNow(ID, "guild-1", {
      pullBack: true,
    });
    expect(outcome.status).toBe("ended");
    expect(run).toHaveBeenCalledTimes(1);
    expect(run.mock.calls[0]?.[0]).toMatchObject({
      eventId: ID,
      guildId: "guild-1",
      trigger: "manual",
      pullBack: true,
      fromStates: ["active"],
      syncNative: true,
    });
    expect(store.get(ID)?.state).toBe("ended");
    expect(store.get(ID)?.endedAt).toBeInstanceOf(Date);
  });

  it("closes the native event from the ended row, with the server", async () => {
    const { service, guild } = setup();
    const seen: Array<[unknown, unknown]> = [];
    service.nativeSync.syncEvent = jest.fn(async (e: unknown, g: unknown) => {
      seen.push([(e as Row).state, g]);
    });
    await service.endEventNow(ID, "guild-1", { pullBack: false });
    expect(seen).toEqual([["ended", guild]]);
  });

  it("is refused while events are off, and changes nothing", async () => {
    const { service } = setup();
    eventsEnabled = false;
    const outcome = await service.endEventNow(ID, "guild-1", {
      pullBack: false,
    });
    expect(outcome.status).toBe("refused");
    expect(EventMock.findOneAndUpdate).not.toHaveBeenCalled();
    expect(store.get(ID)?.state).toBe("active");
  });

  it("an unreadable switch counts as off", async () => {
    const { service } = setup();
    configMock.getBoolean.mockRejectedValueOnce(new Error("db"));
    const outcome = await service.endEventNow(ID, "guild-1", {
      pullBack: false,
    });
    expect(outcome.status).toBe("refused");
    expect(store.get(ID)?.state).toBe("active");
  });

  it("a malformed id is not found, without touching the database", async () => {
    const { service } = setup();
    const outcome = await service.endEventNow("not-an-id", "guild-1", {
      pullBack: false,
    });
    expect(outcome.status).toBe("not-found");
    expect(EventMock.findOneAndUpdate).not.toHaveBeenCalled();
  });

  it("another server's event is not found and not ended", async () => {
    const { service } = setup();
    const outcome = await service.endEventNow(ID, "guild-2", {
      pullBack: false,
    });
    expect(outcome.status).toBe("not-found");
    expect(store.get(ID)?.state).toBe("active");
  });

  it("pressed twice, it is a no-op the second time", async () => {
    const { service } = setup();
    const first = await service.endEventNow(ID, "guild-1", { pullBack: false });
    const second = await service.endEventNow(ID, "guild-1", {
      pullBack: false,
    });
    expect([first.status, second.status]).toEqual(["ended", "already-ended"]);
    expect(service.updateAnnouncement).toHaveBeenCalledTimes(1);
    expect(service.nativeSync.syncEvent).toHaveBeenCalledTimes(1);
  });

  it("does not delete the main channel: it stays for the grace period", async () => {
    const { service } = setup();
    await service.endEventNow(ID, "guild-1", { pullBack: false });
    expect(service.deleteEventChannel).not.toHaveBeenCalled();
    expect(store.get(ID)?.channelId).toBe("main-1");
  });
});

describe("a scan that loaded the event before a manual end", () => {
  it("does not act on its older copy while the end runs, or afterwards", async () => {
    const { service, guild } = setup();
    // The scan read an open event inside its reminder window, and stalls on
    // the reminder post.
    let release!: () => void;
    service.postReminder = jest.fn(
      () =>
        new Promise<void>((resolve) => {
          release = resolve;
        }),
    );
    const stale = row({ reminderSent: false });
    const scan = service.processEvent(
      stale,
      guild,
      new Date("2026-07-04T19:50:00Z"),
      { ...WINDOWS, reminderMs: 30 * MIN },
    );
    await new Promise((r) => setTimeout(r, 10));
    expect(service.postReminder).toHaveBeenCalledTimes(1);

    // The manual end lands while the scan is stalled.
    const outcome = await service.endEventNow(ID, "guild-1", {
      pullBack: false,
    });
    expect(outcome.status).toBe("ended");
    expect(service.nativeSync.syncEvent).toHaveBeenCalledTimes(1);
    expect(service.updateAnnouncement).toHaveBeenCalledTimes(1);

    release();
    await scan;

    // The scan's copy still says active, yet it did nothing more: no second
    // announcement render (that would show a finished event as running), no
    // native update of the closed Discord event.
    expect(service.nativeSync.syncEvent).toHaveBeenCalledTimes(1);
    expect(service.updateAnnouncement).toHaveBeenCalledTimes(1);
    expect(store.get(ID)?.state).toBe("ended");
  });

  it("is skipped from the start while an end is in progress", async () => {
    const { service, guild } = setup();
    let release!: () => void;
    claimDelay = new Promise((resolve) => {
      release = resolve;
    });
    const ending = service.endEventNow(ID, "guild-1", { pullBack: false });
    // The end has begun (its claim is pending); a scan now leaves the event be.
    await new Promise((r) => setTimeout(r, 10));
    await service.processEvent(
      row({ reminderSent: false }),
      guild,
      new Date("2026-07-04T19:50:00Z"),
      { ...WINDOWS, reminderMs: 30 * MIN },
    );
    expect(service.postReminder).not.toHaveBeenCalled();
    expect(service.nativeSync.syncEvent).not.toHaveBeenCalled();
    release();
    await ending;
  });

  it("a second press that loses the claim does not lift the hold of the press that won it", async () => {
    const { service, guild } = setup();
    // A scan read an open copy inside its reminder window and stalls.
    let releaseScan!: () => void;
    service.postReminder = jest.fn(
      () =>
        new Promise<void>((resolve) => {
          releaseScan = resolve;
        }),
    );
    const scan = service.processEvent(
      row({ reminderSent: false }),
      guild,
      new Date("2026-07-04T19:50:00Z"),
      { ...WINDOWS, reminderMs: 30 * MIN },
    );
    await new Promise((r) => setTimeout(r, 10));

    // Press 1 wins the claim and stalls in its group channel cleanup (a slow
    // pull-back or Discord call).
    store.set(
      ID,
      stored({
        groupsEnabled: true,
        groups: [
          {
            key: "g_a",
            name: "A",
            kind: "team",
            channelId: "c1",
            memberIds: [],
          },
        ],
      }),
    );
    let releaseCleanup!: () => void;
    service.groupChannels.cleanup = jest.fn(
      () =>
        new Promise((resolve) => {
          releaseCleanup = () => resolve(emptyReport());
        }),
    );
    const first = service.endEventNow(ID, "guild-1", { pullBack: false });
    await new Promise((r) => setTimeout(r, 10));
    expect(service.groupChannels.cleanup).toHaveBeenCalledTimes(1);

    // Press 2 (a double click, or an admin at the same moment) loses.
    const second = await service.endEventNow(ID, "guild-1", {
      pullBack: false,
    });
    expect(second.status).toBe("already-ended");

    // The scan wakes up with its older, still-open copy while press 1 works.
    releaseScan();
    await scan;
    expect(service.nativeSync.syncEvent).not.toHaveBeenCalled();
    expect(service.updateAnnouncement).toHaveBeenCalledTimes(1);

    releaseCleanup();
    expect((await first).status).toBe("ended");
    expect(service.nativeSync.syncEvent).toHaveBeenCalledTimes(1);
  });

  it("the scheduled attempt that loses to a manual end leaves the work to the manual one", async () => {
    const { service, guild } = setup();
    const groups = [
      { key: "g_a", name: "A", kind: "team", channelId: "c1", memberIds: [] },
    ];
    store.set(ID, stored({ groupsEnabled: true, groups }));
    // The scan's copy is open and past its end. It starts before any end is
    // under way (so the scan's first look finds no hold) and stalls on the
    // read of its adopted Discord event.
    let releaseScan!: () => void;
    service.nativeSync.pullAdopted = jest.fn(
      () =>
        new Promise((resolve) => {
          releaseScan = () => resolve("ok");
        }),
    );
    const event = row({
      nativeAdopted: true,
      announcementMessageId: "m1",
      groupsEnabled: true,
      groups,
    });
    const scan = service.processEvent(event, guild, AFTER_END, WINDOWS);
    await new Promise((r) => setTimeout(r, 10));
    expect(service.nativeSync.pullAdopted).toHaveBeenCalledTimes(1);

    // A manual end now wins the claim and stalls in its group channel cleanup.
    let releaseCleanup!: () => void;
    service.groupChannels.cleanup = jest.fn(
      () =>
        new Promise((resolve) => {
          releaseCleanup = () => resolve(emptyReport());
        }),
    );
    const manual = service.endEventNow(ID, "guild-1", { pullBack: false });
    await new Promise((r) => setTimeout(r, 10));
    expect(service.groupChannels.cleanup).toHaveBeenCalledTimes(1);

    // The scan wakes up, tries to end the event on its schedule, loses the
    // claim, sees the manual end still working and does nothing more.
    releaseScan();
    await scan;
    expect(event.save).not.toHaveBeenCalled();
    expect(service.nativeSync.syncEvent).not.toHaveBeenCalled();
    expect(service.groupChannels.cleanup).toHaveBeenCalledTimes(1);
    releaseCleanup();
    expect((await manual).status).toBe("ended");
  });

  it("a copy that follows an end made long ago does not write the end again", async () => {
    const { service, guild } = setup();
    store.set(ID, stored({ state: "ended", endedAt: AFTER_END }));
    const ignored: string[] = [];
    const event = row({
      $ignore: (path: string) => ignored.push(path),
    });
    await service.processEvent(event, guild, AFTER_END, WINDOWS);
    expect(event.state).toBe("ended");
    expect(ignored.sort()).toEqual(["endedAt", "state"]);
  });

  it("is not skipped for good: an end that was refused lets the scan carry on", async () => {
    const { service, guild } = setup();
    store.set(ID, stored({ state: "scheduled" }));
    const outcome = await service.endEventNow(ID, "guild-1", {
      pullBack: false,
    });
    expect(outcome.status).toBe("not-running");
    // The hold was undone: the scan still handles the (scheduled) event.
    await service.processEvent(
      row({ state: "scheduled", reminderSent: false, channelId: null }),
      guild,
      new Date("2026-07-04T19:50:00Z"),
      { ...WINDOWS, reminderMs: 30 * MIN },
    );
    expect(service.postReminder).toHaveBeenCalledTimes(1);
  });
});

describe("the main channel's grace period counts from the actual end", () => {
  function channel(): { delete: jest.Mock; type: number; members: unknown } {
    return {
      delete: jest.fn(async () => undefined),
      type: ChannelType.GuildVoice,
      members: { size: 0 },
    };
  }

  it("an event ended early keeps its channel until the grace period after endedAt, not after the scheduled end", async () => {
    // Scheduled end 22:00; ended manually at 20:30. At 20:40 it is 10 minutes
    // after the end: still inside the 15-minute grace.
    const early = new Date("2026-07-04T20:30:00Z");
    const a = setup();
    const ch = channel();
    a.guild.channels.cache.set("main-1", ch);
    await a.service.processEvent(
      row({ state: "ended", endedAt: early }),
      a.guild,
      new Date("2026-07-04T20:40:00Z"),
      WINDOWS,
    );
    expect(a.service.deleteEventChannel).not.toHaveBeenCalled();

    // At 20:50 the grace is over, long before the scheduled end plus grace.
    await a.service.processEvent(
      row({ state: "ended", endedAt: early }),
      a.guild,
      new Date("2026-07-04T20:50:00Z"),
      WINDOWS,
    );
    expect(a.service.deleteEventChannel).toHaveBeenCalledTimes(1);
  });

  it("an event ended before endedAt existed keeps the old rule", async () => {
    const a = setup();
    const ch = channel();
    a.guild.channels.cache.set("main-1", ch);
    await a.service.processEvent(
      row({ state: "ended", endedAt: null }),
      a.guild,
      new Date("2026-07-04T22:10:00Z"),
      WINDOWS,
    );
    expect(a.service.deleteEventChannel).not.toHaveBeenCalled();
    await a.service.processEvent(
      row({ state: "ended", endedAt: null }),
      a.guild,
      new Date("2026-07-04T22:16:00Z"),
      WINDOWS,
    );
    expect(a.service.deleteEventChannel).toHaveBeenCalledTimes(1);
  });
});

describe("a scan that overlaps an end in progress", () => {
  const nap = (): Promise<void> => new Promise((r) => setTimeout(r, 10));

  it("does not delete the main channel while the teardown still needs it, even with no grace period", async () => {
    const { service, guild } = setup();
    // The manual end has claimed the event and stalls on the announcement
    // refresh, before its pull-back has used the main channel.
    let releaseAnnouncement!: () => void;
    service.updateAnnouncement = jest.fn(
      () =>
        new Promise<boolean>((resolve) => {
          releaseAnnouncement = () => resolve(true);
        }),
    );
    const ending = service.endEventNow(ID, "guild-1", { pullBack: false });
    await nap();
    expect(store.get(ID)?.state).toBe("ended");

    // A scan that reads the row now sees an ended event whose grace (0) has
    // passed and an empty main channel.
    const channel = {
      delete: jest.fn(async () => undefined),
      type: ChannelType.GuildVoice,
      members: { size: 0 },
    };
    guild.channels.cache.set("main-1", channel);
    const ended = (): Row =>
      row({ state: "ended", endedAt: new Date(Date.now() - MIN) });
    const scanNow = new Date();
    await service.processEvent(ended(), guild, scanNow, {
      ...WINDOWS,
      graceMs: 0,
    });
    expect(service.deleteEventChannel).not.toHaveBeenCalled();

    // Once the teardown is over the same scan may remove it.
    releaseAnnouncement();
    await ending;
    await service.processEvent(ended(), guild, scanNow, {
      ...WINDOWS,
      graceMs: 0,
    });
    expect(service.deleteEventChannel).toHaveBeenCalledTimes(1);
  });

  it("an open copy does not refresh the announcement after the native sync it was waiting on", async () => {
    const { service, guild } = setup();
    // The scan's copy is open and needs its link refreshed; it stalls in the
    // native sync (the first call; the manual end's own sync does not stall).
    let releaseSync!: () => void;
    let first = true;
    service.nativeSync.syncEvent = jest.fn(() => {
      if (!first) return Promise.resolve();
      first = false;
      return new Promise<void>((resolve) => {
        releaseSync = resolve;
      });
    });
    const scan = service.processEvent(
      row({ announcementMessageId: "m1", announcementChannelId: "a1" }),
      guild,
      new Date("2026-07-04T20:10:00Z"),
      WINDOWS,
    );
    await nap();
    expect(service.nativeSync.syncEvent).toHaveBeenCalledTimes(1);

    const outcome = await service.endEventNow(ID, "guild-1", {
      pullBack: false,
    });
    expect(outcome.status).toBe("ended");
    expect(service.updateAnnouncement).toHaveBeenCalledTimes(1);

    releaseSync();
    await scan;
    // No second render: the post still shows the ended event.
    expect(service.updateAnnouncement).toHaveBeenCalledTimes(1);
  });

  it("an open copy does not edit the post after the fetches inside the announcement update", async () => {
    const { service, guild } = setup();
    // The real announcement update, on a fake text channel whose first message
    // fetch (the scan's) stalls.
    delete (service as unknown as { updateAnnouncement?: unknown })
      .updateAnnouncement;
    const edit = jest.fn(async () => undefined);
    let releaseFetch!: () => void;
    let first = true;
    const channel = Object.assign(Object.create(TextChannel.prototype), {
      messages: {
        fetch: jest.fn(() => {
          if (!first) return Promise.resolve({ components: [], edit });
          first = false;
          return new Promise((resolve) => {
            releaseFetch = () => resolve({ components: [], edit });
          });
        }),
      },
    });
    guild.channels.fetch = jest.fn(async (id: string) =>
      id === "a1" ? channel : null,
    );
    store.set(
      ID,
      stored({ announcementMessageId: "m1", announcementChannelId: "a1" }),
    );
    const scan = service.processEvent(
      row({ announcementMessageId: "m1", announcementChannelId: "a1" }),
      guild,
      new Date("2026-07-04T20:10:00Z"),
      WINDOWS,
    );
    await nap();
    expect(channel.messages.fetch).toHaveBeenCalledTimes(1);

    // The manual end edits the post (as ended) while the scan waits.
    const outcome = await service.endEventNow(ID, "guild-1", {
      pullBack: false,
    });
    expect(outcome.status).toBe("ended");
    expect(edit).toHaveBeenCalledTimes(1);

    releaseFetch();
    await scan;
    // The scan's copy is still open, but it must not write the post now.
    expect(edit).toHaveBeenCalledTimes(1);
  });
});
