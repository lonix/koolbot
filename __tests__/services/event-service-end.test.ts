import { describe, it, expect, jest, beforeEach } from "@jest/globals";
import { ChannelType, DiscordAPIError, TextChannel } from "discord.js";

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
  cancelOne: (e: unknown) => Promise<void>;
  claimEventChannel: jest.Mock;
  removeRsvp: (
    g: string,
    u: string,
  ) => Promise<{ matched: number; removed: number; rendersFailed: number }>;
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
      options?: { new?: boolean },
    ): Promise<Row | null> => {
      if (claimDelay) await claimDelay;
      const r = store.get(filter._id as string);
      if (!r) return null;
      if (filter.guildId !== undefined && r.guildId !== filter.guildId) {
        return null;
      }
      const states = (filter.state as { $in: string[] }).$in;
      if (!states.includes(r.state as string)) return null;
      if (
        filter.startTime &&
        +(r.startTime as Date) !== +(filter.startTime as Date)
      ) {
        return null;
      }
      if (
        filter.durationMinutes !== undefined &&
        r.durationMinutes !== filter.durationMinutes
      ) {
        return null;
      }
      // The scheduled end's channel expectation (the occupancy check's ids).
      if (
        filter.channelId !== undefined &&
        (r.channelId ?? null) !== filter.channelId
      ) {
        return null;
      }
      const groups = r.groups as Array<Row> | undefined;
      for (const clause of (filter.$and as Array<Row>) ?? []) {
        const one = (c: Row): boolean => {
          const g = c.groups as {
            $size?: number;
            $exists?: boolean;
            $elemMatch?: { key: string; channelId: string | null };
          };
          if (g.$exists === false) return groups === undefined;
          if (g.$size !== undefined) {
            return Array.isArray(groups) && groups.length === g.$size;
          }
          if (g.$elemMatch) {
            return (groups ?? []).some(
              (x) =>
                x.key === g.$elemMatch?.key &&
                ((x.channelId as string | null) ?? null) ===
                  g.$elemMatch?.channelId,
            );
          }
          return true;
        };
        const ok = clause.$or ? (clause.$or as Row[]).some(one) : one(clause);
        if (!ok) return null;
      }
      const before = { ...r };
      Object.assign(r, update.$set);
      return options?.new === false ? before : { ...r };
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
    // The one extra read is the occupancy check's fresh look at the channels.
    expect(EventMock.findById).toHaveBeenCalledTimes(1);
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

  it("an open copy posts no reminder after the read of the adopted Discord event it was waiting on", async () => {
    const { service, guild } = setup();
    let releaseRead!: () => void;
    service.nativeSync.pullAdopted = jest.fn(
      () =>
        new Promise((resolve) => {
          releaseRead = () => resolve("ok");
        }),
    );
    const scan = service.processEvent(
      row({
        nativeAdopted: true,
        announcementMessageId: "m1",
        reminderSent: false,
      }),
      guild,
      new Date("2026-07-04T19:50:00Z"),
      { ...WINDOWS, reminderMs: 30 * MIN },
    );
    await nap();
    expect(service.nativeSync.pullAdopted).toHaveBeenCalledTimes(1);
    expect(
      (await service.endEventNow(ID, "guild-1", { pullBack: false })).status,
    ).toBe("ended");
    releaseRead();
    await scan;
    expect(service.postReminder).not.toHaveBeenCalled();
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

describe("a cancel that decided on an older copy (an adopted event gone in Discord)", () => {
  const nap = (): Promise<void> => new Promise((r) => setTimeout(r, 10));

  // The cancel write is conditional on the stored state, like the claim.
  function statefulUpdateOne(): void {
    EventMock.updateOne = jest.fn(
      async (filter: Record<string, unknown>, update: { $set: Row }) => {
        const r = store.get(filter._id as string);
        const wanted = filter.state as string | { $in: string[] } | undefined;
        const states = typeof wanted === "string" ? [wanted] : wanted?.$in;
        if (
          !r ||
          (states !== undefined && !states.includes(r.state as string))
        ) {
          return { matchedCount: 0 };
        }
        Object.assign(r, update.$set);
        return { matchedCount: 1, modifiedCount: 1 };
      },
    );
  }

  const adopted = (): Row =>
    row({ nativeAdopted: true, announcementMessageId: "m1" });

  it("does not cancel or delete the channel when an end landed during the read of the adopted event", async () => {
    const { service, guild } = setup();
    statefulUpdateOne();
    let release!: () => void;
    service.nativeSync.pullAdopted = jest.fn(
      () =>
        new Promise((resolve) => {
          release = () => resolve("gone");
        }),
    );
    const event = adopted();
    const scan = service.processEvent(
      event,
      guild,
      new Date("2026-07-04T19:50:00Z"),
      WINDOWS,
    );
    await nap();
    expect(
      (await service.endEventNow(ID, "guild-1", { pullBack: false })).status,
    ).toBe("ended");
    release();
    await scan;
    expect(store.get(ID)?.state).toBe("ended");
    expect(service.deleteEventChannel).not.toHaveBeenCalled();
    expect(event.save).not.toHaveBeenCalled();
  });

  it("does not cancel when an end landed during the occupancy check", async () => {
    const { service, guild } = setup();
    statefulUpdateOne();
    service.nativeSync.pullAdopted = jest.fn(async () => "gone");
    // The channel is not cached, so the occupancy check reads it from Discord.
    let release!: () => void;
    guild.channels.fetch = jest.fn(
      () =>
        new Promise((resolve) => {
          release = () => resolve(null);
        }),
    );
    const event = adopted();
    const scan = service.processEvent(
      event,
      guild,
      new Date("2026-07-04T19:50:00Z"),
      WINDOWS,
    );
    await nap();
    expect(guild.channels.fetch).toHaveBeenCalledTimes(1);
    guild.channels.fetch = jest.fn(async () => null);
    expect(
      (await service.endEventNow(ID, "guild-1", { pullBack: false })).status,
    ).toBe("ended");
    release();
    await scan;
    expect(store.get(ID)?.state).toBe("ended");
    expect(service.deleteEventChannel).not.toHaveBeenCalled();
    expect(event.save).not.toHaveBeenCalled();
  });

  it("cancelOne itself never turns an ended event into a cancelled one, nor deletes its channel", async () => {
    const { service } = setup();
    statefulUpdateOne();
    store.set(ID, stored({ state: "ended", endedAt: new Date() }));
    const stale = row({ state: "active" });
    await service.cancelOne(stale);
    expect(store.get(ID)?.state).toBe("ended");
    expect(store.get(ID)?.channelId).toBe("main-1");
    expect(service.deleteEventChannel).not.toHaveBeenCalled();
    expect(stale.save).not.toHaveBeenCalled();
    expect(service.nativeSync.syncEvent).not.toHaveBeenCalled();
  });

  it("cancelOne reports whether this call cancelled the event", async () => {
    const { service } = setup();
    statefulUpdateOne();
    const open = await (
      service as unknown as { cancelOne: (e: unknown) => Promise<boolean> }
    ).cancelOne(row({ state: "active" }));
    expect(open).toBe(true);
    store.set(ID, stored({ state: "ended", endedAt: new Date() }));
    const ended = await (
      service as unknown as { cancelOne: (e: unknown) => Promise<boolean> }
    ).cancelOne(row({ state: "active" }));
    expect(ended).toBe(false);
  });

  it("a cancel from an admin page opened earlier cannot cancel an event that is being ended (its main channel survives)", async () => {
    const { service } = setup();
    statefulUpdateOne();
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
    const svc = service as unknown as {
      cancelEvent: (id: string, g: string) => Promise<{ state: string } | null>;
      spawnNextOccurrence: jest.Mock;
    };
    svc.spawnNextOccurrence = jest.fn();
    const result = await svc.cancelEvent(ID, "guild-1");
    // Not cancelled: the row is ended, the caller can see it, the channel and
    // the record are untouched and no successor is made.
    expect(result?.state).toBe("ended");
    expect(store.get(ID)?.channelId).toBe("main-1");
    expect(service.deleteEventChannel).not.toHaveBeenCalled();
    expect(svc.spawnNextOccurrence).not.toHaveBeenCalled();
    releaseAnnouncement();
    await ending;
  });

  it("a cancel still applies when the scan turned the scheduled event active after the read", async () => {
    const { service } = setup();
    statefulUpdateOne();
    // The admin page read `scheduled`; the stored row is now `active`.
    store.set(ID, stored({ state: "active" }));
    const svc = service as unknown as {
      cancelEvent: (id: string, g: string) => Promise<{ state: string } | null>;
      getEvent: (id: string) => Promise<unknown>;
    };
    const stale = row({ state: "scheduled" });
    svc.getEvent = jest
      .fn<() => Promise<unknown>>()
      .mockResolvedValueOnce(stale)
      .mockResolvedValue({ ...stored({ state: "cancelled" }) });
    const result = await svc.cancelEvent(ID, "guild-1");
    expect(store.get(ID)?.state).toBe("cancelled");
    expect(result?.state).toBe("cancelled");
  });

  it("a lost cancel claim is reported, not counted, and spawns no successor (series and one-off)", async () => {
    const { service } = setup();
    statefulUpdateOne();
    store.set(ID, stored({ state: "ended", endedAt: new Date() }));
    const svc = service as unknown as {
      cancelEvent: (id: string, g: string) => Promise<{ state: string } | null>;
      cancelSeries: (
        id: string,
        g: string,
      ) => Promise<{ event: { state: string }; cancelled: number } | null>;
      getEvent: (id: string) => Promise<unknown>;
      spawnNextOccurrence: jest.Mock;
    };
    svc.spawnNextOccurrence = jest.fn();
    // Both calls read the event as open (an older read) and lose the claim.
    svc.getEvent = jest
      .fn<() => Promise<unknown>>()
      .mockResolvedValueOnce(
        row({ state: "active", recurrence: "weekly", seriesId: "s1" }),
      )
      .mockResolvedValueOnce({ ...stored({ state: "ended" }) });
    const one = await svc.cancelEvent(ID, "guild-1");
    expect(one?.state).toBe("ended");
    expect(svc.spawnNextOccurrence).not.toHaveBeenCalled();

    svc.getEvent = jest
      .fn<() => Promise<unknown>>()
      .mockResolvedValueOnce(row({ state: "active" }))
      .mockResolvedValueOnce({ ...stored({ state: "ended" }) });
    const series = await svc.cancelSeries(ID, "guild-1");
    expect(series?.cancelled).toBe(0);
    expect(series?.event.state).toBe("ended");
  });

  it("a series cancel counts only the occurrences it really cancelled", async () => {
    const { service } = setup();
    statefulUpdateOne();
    (EventMock as unknown as { updateMany: jest.Mock }).updateMany = jest.fn(
      async () => ({}),
    );
    const other = "65a000000000000000000002";
    const series = { recurrence: "weekly", seriesId: "s1" };
    // Two open occurrences; the second ended (or is not stored) before its claim.
    store.set(ID, stored({ state: "active", ...series }));
    EventMock.find = jest.fn(async () => [
      row({ state: "active", ...series }),
      row({ _id: other, state: "active", ...series }),
    ]);
    const svc = service as unknown as {
      cancelSeries: (
        id: string,
        g: string,
      ) => Promise<{ event: { state: string }; cancelled: number } | null>;
      getEvent: (id: string) => Promise<unknown>;
    };
    svc.getEvent = jest.fn(async () => row({ state: "active", ...series }));
    const result = await svc.cancelSeries(ID, "guild-1");
    expect(result?.cancelled).toBe(1);
  });

  it("a cancel of an open event still saves, deletes the channel and syncs", async () => {
    const { service, guild } = setup();
    statefulUpdateOne();
    const del = jest.fn(async () => undefined);
    guild.channels.cache.set("main-1", { delete: del });
    const event = row({ state: "active" });
    await service.cancelOne(event);
    expect(store.get(ID)?.state).toBe("cancelled");
    expect(del).toHaveBeenCalledTimes(1);
    // The reference is cleared only after the delete was confirmed.
    expect(store.get(ID)?.channelId).toBeNull();
    expect(event.save).toHaveBeenCalledTimes(1);
    expect(service.nativeSync.syncEvent).toHaveBeenCalledTimes(1);
  });

  it("the channel id stays recorded until Discord confirms the delete (a restart or error in between loses nothing)", async () => {
    const { service, guild } = setup();
    statefulUpdateOne();
    const del = jest
      .fn<() => Promise<void>>()
      .mockRejectedValueOnce(new Error("socket hang up"))
      .mockResolvedValue(undefined);
    guild.channels.cache.set("main-1", { delete: del });
    await service.cancelOne(row({ state: "active" }));
    // Claimed, but the delete failed: the record still points at the channel.
    expect(store.get(ID)?.state).toBe("cancelled");
    expect(store.get(ID)?.channelId).toBe("main-1");
    // The next scan, on the stored cancelled row, finishes the job.
    await service.processEvent(
      row({ state: "cancelled", channelId: "main-1" }),
      guild,
      AFTER_END,
      WINDOWS,
    );
    expect(del).toHaveBeenCalledTimes(2);
    expect(store.get(ID)?.channelId).toBeNull();
  });

  it("the scan's query also loads cancelled events that still record a channel", async () => {
    const { service } = setup();
    (service as unknown as { runOnce: () => Promise<void> }).runOnce;
    configMock.getString.mockImplementation(async (k: string, d?: unknown) =>
      k === "GUILD_ID" ? "guild-1" : d,
    );
    try {
      await (service as unknown as { runOnce: () => Promise<void> }).runOnce();
      const query = EventMock.find.mock.calls[0]?.[0] as {
        $or: Array<Record<string, unknown>>;
      };
      expect(query.$or).toContainEqual({
        state: "cancelled",
        channelId: { $ne: null },
      });
    } finally {
      configMock.getString.mockImplementation(
        async (_k: string, d?: unknown) => d,
      );
    }
  });

  it("a channel that Discord says is gone (10003) counts as deleted", async () => {
    const { service, guild } = setup();
    statefulUpdateOne();
    const gone = new DiscordAPIError(
      { code: 10003, message: "Unknown Channel" },
      10003,
      404,
      "DELETE",
      "/",
      {},
    );
    guild.channels.cache.set("main-1", {
      delete: jest.fn(async () => {
        throw gone;
      }),
    });
    await service.cancelOne(row({ state: "active" }));
    expect(store.get(ID)?.channelId).toBeNull();
  });

  it("deletes the channel recorded at the claim, not the one the caller's older copy knew", async () => {
    const { service, guild } = setup();
    statefulUpdateOne();
    const del = jest.fn(async () => undefined);
    guild.channels.cache.set("main-1", { delete: del });
    // The cancel read the event before Start now recorded its main channel.
    const older = row({ state: "scheduled", channelId: null });
    store.set(ID, stored({ state: "active", channelId: "main-1" }));
    await service.cancelOne(older);
    expect(del).toHaveBeenCalledTimes(1);
    expect(store.get(ID)?.channelId).toBeNull();
    expect(store.get(ID)?.state).toBe("cancelled");
  });

  it("a scan leaves a cancelled event's channel alone while an end or teardown holds it", async () => {
    const { service, guild } = setup();
    statefulUpdateOne();
    const del = jest.fn(async () => undefined);
    guild.channels.cache.set("main-1", { delete: del });
    const svc = service as unknown as {
      beginEnding: (id: string) => number;
    };
    svc.beginEnding(ID);
    store.set(ID, stored({ state: "cancelled", channelId: "main-1" }));
    // An older copy that still reads open is skipped before it gets there.
    await service.processEvent(
      row({ state: "active", channelId: "main-1" }),
      guild,
      AFTER_END,
      WINDOWS,
    );
    expect(del).not.toHaveBeenCalled();
  });
});

describe("the start reminder after an end began", () => {
  const nap = (): Promise<void> => new Promise((r) => setTimeout(r, 10));

  it("an older open copy sends no reminder when the end landed during the channel fetch", async () => {
    const { service, guild } = setup();
    // The real reminder, on a text channel whose fetch (the scan's) stalls.
    delete (service as unknown as { postReminder?: unknown }).postReminder;
    const send = jest.fn(async () => undefined);
    const channel = Object.assign(Object.create(TextChannel.prototype), {
      send,
    });
    let release!: () => void;
    guild.channels.fetch = jest.fn(
      () =>
        new Promise((resolve) => {
          release = () => resolve(channel);
        }),
    );
    const copy = row({
      reminderSent: false,
      announcementChannelId: "a1",
      rsvps: [{ userId: "u1", status: "going" }],
    });
    const scan = service.processEvent(
      copy,
      guild,
      new Date("2026-07-04T19:50:00Z"),
      { ...WINDOWS, reminderMs: 30 * MIN },
    );
    await nap();
    expect(guild.channels.fetch).toHaveBeenCalledTimes(1);
    guild.channels.fetch = jest.fn(async () => null);
    expect(
      (await service.endEventNow(ID, "guild-1", { pullBack: false })).status,
    ).toBe("ended");
    release();
    await scan;
    expect(send).not.toHaveBeenCalled();
    // A skipped reminder is not recorded as a sent one.
    expect(copy.reminderSent).toBe(false);
  });

  it("without an end the reminder is sent as before", async () => {
    const { service, guild } = setup();
    delete (service as unknown as { postReminder?: unknown }).postReminder;
    const send = jest.fn(async () => undefined);
    const channel = Object.assign(Object.create(TextChannel.prototype), {
      send,
    });
    guild.channels.fetch = jest.fn(async () => channel);
    await service.processEvent(
      row({ reminderSent: false, announcementChannelId: "a1", rsvps: [] }),
      guild,
      new Date("2026-07-04T19:50:00Z"),
      { ...WINDOWS, reminderMs: 30 * MIN },
    );
    expect(send).toHaveBeenCalledTimes(1);
  });
});

describe("a scheduled end with people in a voice channel of the event", () => {
  const nap = (): Promise<void> => new Promise((r) => setTimeout(r, 10));
  const groups = [
    { key: "g_a", name: "A", kind: "team", channelId: "c1", memberIds: [] },
    { key: "g_b", name: "B", kind: "team", channelId: "c2", memberIds: [] },
  ];
  const groupRow = (): Row => row({ groupsEnabled: true, groups });

  function voice(size: number, bots = 0): Record<string, unknown> {
    const members = new Map<string, unknown>();
    for (let i = 0; i < size; i++) {
      members.set(`u${i}`, { id: `u${i}`, user: { bot: false } });
    }
    for (let i = 0; i < bots; i++) {
      members.set(`b${i}`, { id: `b${i}`, user: { bot: true } });
    }
    return { type: ChannelType.GuildVoice, members };
  }

  function channels(
    guild: { channels: { fetch: unknown } },
    byId: Record<string, unknown>,
  ): jest.Mock {
    const fetch = jest.fn(async (id: string) => {
      const v = byId[id];
      if (v instanceof Error) throw v;
      return v ?? null;
    });
    guild.channels.fetch = fetch;
    return fetch;
  }

  async function deferredLogs(): Promise<number> {
    const logger = (await import("../../src/utils/logger.js")).default as {
      info: jest.Mock;
    };
    return logger.info.mock.calls.filter((c) =>
      String(c[0]).includes("scheduled end is deferred"),
    ).length;
  }

  it("is deferred: the event stays live, nothing is claimed, deleted or moved", async () => {
    const { service, guild } = setup();
    store.set(ID, stored({ groupsEnabled: true, groups }));
    const fetch = channels(guild, { c1: voice(0), c2: voice(2) });
    const run = jest.spyOn(service.teardown, "run");
    const event = groupRow();
    await service.processEvent(event, guild, AFTER_END, WINDOWS);
    expect(run).not.toHaveBeenCalled();
    expect(EventMock.findOneAndUpdate).not.toHaveBeenCalled();
    expect(store.get(ID)?.state).toBe("active");
    expect(event.state).toBe("active");
    expect(service.groupChannels.cleanup).not.toHaveBeenCalled();
    expect(service.deleteEventChannel).not.toHaveBeenCalled();
    // Read from Discord with force, not believed from the cache.
    expect(fetch).toHaveBeenCalledWith("c1", { force: true });
  });

  it("is checked again next scan and ends once the channels are empty", async () => {
    const { service, guild } = setup();
    store.set(ID, stored({ groupsEnabled: true, groups }));
    const byId: Record<string, unknown> = { c1: voice(1), c2: voice(0) };
    channels(guild, byId);
    await service.processEvent(groupRow(), guild, AFTER_END, WINDOWS);
    expect(store.get(ID)?.state).toBe("active");
    byId.c1 = voice(0);
    await service.processEvent(groupRow(), guild, AFTER_END, WINDOWS);
    expect(store.get(ID)?.state).toBe("ended");
  });

  it("is logged once, not every scan", async () => {
    const { service, guild } = setup();
    store.set(ID, stored({ groupsEnabled: true, groups }));
    channels(guild, { c1: voice(3), c2: voice(0) });
    const before = await deferredLogs();
    for (let i = 0; i < 3; i++) {
      await service.processEvent(groupRow(), guild, AFTER_END, WINDOWS);
    }
    expect((await deferredLogs()) - before).toBe(1);
  });

  it("people in the main channel block it too: the end removes that channel", async () => {
    const { service, guild } = setup();
    store.set(ID, stored({ groupsEnabled: true, groups }));
    channels(guild, { "main-1": voice(2), c1: voice(0), c2: voice(0) });
    await service.processEvent(groupRow(), guild, AFTER_END, WINDOWS);
    expect(store.get(ID)?.state).toBe("active");
    expect(EventMock.findOneAndUpdate).not.toHaveBeenCalled();
  });

  it("an event without groups is deferred while someone is in its channel", async () => {
    const { service, guild } = setup();
    const fetch = channels(guild, { "main-1": voice(1) });
    await service.processEvent(row(), guild, AFTER_END, WINDOWS);
    expect(fetch).toHaveBeenCalledWith("main-1", { force: true });
    expect(store.get(ID)?.state).toBe("active");
  });

  it("bots do not count", async () => {
    const { service, guild } = setup();
    store.set(ID, stored({ groupsEnabled: true, groups }));
    channels(guild, { "main-1": voice(0, 2), c1: voice(0, 1), c2: voice(0) });
    await service.processEvent(groupRow(), guild, AFTER_END, WINDOWS);
    expect(store.get(ID)?.state).toBe("ended");
  });

  it("fails closed: a group channel that cannot be read counts as occupied", async () => {
    const { service, guild } = setup();
    store.set(ID, stored({ groupsEnabled: true, groups }));
    channels(guild, { c1: voice(0), c2: new Error("socket hang up") });
    await service.processEvent(groupRow(), guild, AFTER_END, WINDOWS);
    expect(store.get(ID)?.state).toBe("active");
  });

  it("a group channel that is gone (10003) cannot hold anyone", async () => {
    const { service, guild } = setup();
    store.set(ID, stored({ groupsEnabled: true, groups }));
    const gone = new DiscordAPIError(
      { code: 10003, message: "Unknown Channel" },
      10003,
      404,
      "GET",
      "/",
      {},
    );
    channels(guild, { c1: gone, c2: voice(0) });
    await service.processEvent(groupRow(), guild, AFTER_END, WINDOWS);
    expect(store.get(ID)?.state).toBe("ended");
  });

  it("an event with nobody in its channel ends on schedule as before", async () => {
    const { service, guild } = setup();
    channels(guild, { "main-1": voice(0) });
    await service.processEvent(row(), guild, AFTER_END, WINDOWS);
    expect(store.get(ID)?.state).toBe("ended");
  });

  it("an end that began during the occupancy read wins: the scan does not end it again", async () => {
    const { service, guild } = setup();
    store.set(ID, stored({ groupsEnabled: true, groups }));
    // The scan's first read stalls; every later read finds the channels empty.
    let release!: () => void;
    let first = true;
    guild.channels.fetch = jest.fn(() => {
      if (!first) return Promise.resolve(voice(0));
      first = false;
      return new Promise((resolve) => {
        release = () => resolve(voice(0));
      });
    });
    const run = jest.spyOn(service.teardown, "run");
    const scan = service.processEvent(groupRow(), guild, AFTER_END, WINDOWS);
    await nap();
    // The host ends it by hand meanwhile.
    const manual = await service.endEventNow(ID, "guild-1", {
      pullBack: false,
    });
    expect(manual.status).toBe("ended");
    release();
    await scan;
    // Only the manual end ran the teardown.
    expect(run).toHaveBeenCalledTimes(1);
  });

  it("the host's manual end may end it with people present", async () => {
    const { service, guild } = setup();
    store.set(ID, stored({ groupsEnabled: true, groups }));
    channels(guild, { c1: voice(3), c2: voice(3) });
    const outcome = await service.endEventNow(ID, "guild-1", {
      pullBack: false,
    });
    expect(outcome.status).toBe("ended");
    expect(store.get(ID)?.state).toBe("ended");
  });
});

describe("the occupancy check decides from now, not from the scan's copy", () => {
  const nap = (): Promise<void> => new Promise((r) => setTimeout(r, 10));
  const voice = (humans: string[] = []): Record<string, unknown> => ({
    type: ChannelType.GuildVoice,
    members: new Map(
      humans.map((id) => [id, { id, user: { bot: false } }] as const),
    ),
  });

  it("a group channel recorded after the scan loaded the event, with someone in it, defers the end", async () => {
    const { service, guild } = setup();
    // The scan's copy has no channel for the group; the stored row has one.
    const recorded = [
      { key: "g_a", name: "A", kind: "team", channelId: "c1", memberIds: [] },
    ];
    store.set(ID, stored({ groupsEnabled: true, groups: recorded }));
    guild.channels.fetch = jest.fn(async (id: string) =>
      id === "c1" ? voice(["u1"]) : voice(),
    );
    const copy = row({
      groupsEnabled: true,
      groups: [
        {
          key: "g_a",
          name: "A",
          kind: "team",
          channelId: null,
          memberIds: [],
        },
      ],
    });
    await service.processEvent(copy, guild, AFTER_END, WINDOWS);
    expect(store.get(ID)?.state).toBe("active");
    expect(guild.channels.fetch).toHaveBeenCalledWith("c1", { force: true });
  });

  it("a channel recorded between the occupancy check and the claim stops the claim (the next scan checks it)", async () => {
    const { service, guild } = setup();
    store.set(ID, stored({ groupsEnabled: true, groups: [] }));
    // The check reads the main channel (empty); while that read is pending a
    // group pass records a new group channel.
    let release!: () => void;
    guild.channels.fetch = jest.fn(
      () =>
        new Promise((resolve) => {
          release = () => resolve(voice());
        }),
    );
    const event = row({ groupsEnabled: true, groups: [] });
    const scan = service.processEvent(event, guild, AFTER_END, WINDOWS);
    await nap();
    store.set(
      ID,
      stored({
        groupsEnabled: true,
        groups: [
          {
            key: "g_a",
            name: "A",
            kind: "team",
            channelId: "c9",
            memberIds: [],
          },
        ],
      }),
    );
    release();
    await scan;
    expect(store.get(ID)?.state).toBe("active");
    expect(event.state).toBe("active");
    expect(event.save).not.toHaveBeenCalled();
  });

  it("someone moving into a channel that was already checked is not missed", async () => {
    const { service, guild } = setup();
    const groups = [
      { key: "g_a", name: "A", kind: "team", channelId: "c1", memberIds: [] },
    ];
    store.set(ID, stored({ groupsEnabled: true, groups }));
    const main = voice();
    const group = voice();
    let release!: () => void;
    guild.channels.fetch = jest.fn((id: string) => {
      if (id === "main-1") return Promise.resolve(main);
      // The group channel's read is the later, slow one.
      return new Promise((resolve) => {
        release = () => resolve(group);
      });
    });
    const scan = service.processEvent(
      row({ groupsEnabled: true, groups }),
      guild,
      AFTER_END,
      WINDOWS,
    );
    await nap();
    // The main channel was already read (empty); now someone joins it.
    (main.members as Map<string, unknown>).set("u1", {
      id: "u1",
      user: { bot: false },
    });
    release();
    await scan;
    expect(store.get(ID)?.state).toBe("active");
  });

  it("an unreadable stored event defers (fails closed)", async () => {
    const { service, guild } = setup();
    EventMock.findById = jest.fn(() => ({
      lean: async () => {
        throw new Error("db down");
      },
    }));
    await service.processEvent(row(), guild, AFTER_END, WINDOWS);
    expect(store.get(ID)?.state).toBe("active");
  });
});

describe("the hold does not depend on a timeout while an older scan runs", () => {
  const nap = (): Promise<void> => new Promise((r) => setTimeout(r, 10));

  it("an old scan resumed after the hold would have expired still leaves the ended event alone", async () => {
    const { service } = setup();
    configMock.getString.mockImplementation(async (k: string, d?: unknown) =>
      k === "GUILD_ID" ? "guild-1" : d,
    );
    try {
      // The scan loads an open adopted event (reminder window) and stalls on
      // the read of its Discord event.
      let release!: () => void;
      service.nativeSync.pullAdopted = jest.fn(
        () =>
          new Promise((resolve) => {
            release = () => resolve("ok");
          }),
      );
      const open = row({
        nativeAdopted: true,
        announcementMessageId: "m1",
        reminderSent: false,
        startTime: new Date(Date.now() + 10 * MIN),
      });
      store.set(
        ID,
        stored({
          nativeAdopted: true,
          startTime: new Date(Date.now() + 10 * MIN),
        }),
      );
      EventMock.find = jest.fn(async () => [open]);
      const scan = (
        service as unknown as { runOnce: () => Promise<void> }
      ).runOnce();
      await nap();
      expect(service.nativeSync.pullAdopted).toHaveBeenCalledTimes(1);

      // The host ends it by hand; much later than the hold's time the old scan
      // resumes.
      expect(
        (await service.endEventNow(ID, "guild-1", { pullBack: false })).status,
      ).toBe("ended");
      const realNow = Date.now;
      jest.spyOn(Date, "now").mockImplementation(() => realNow() + 60 * MIN);
      try {
        release();
        await scan;
      } finally {
        jest.restoreAllMocks();
      }
      // The older copy still read as open, and did nothing: no reminder.
      expect(service.postReminder).not.toHaveBeenCalled();
    } finally {
      configMock.getString.mockImplementation(
        async (_k: string, d?: unknown) => d,
      );
    }
  });

  it("once no older scan is running the hold expires by time as before", async () => {
    const { service } = setup();
    const svc = service as unknown as {
      beginEnding: (id: string) => number;
      claimCompleted: (id: string, hold: number) => void;
      isBeingEnded: (id: string) => boolean;
    };
    const hold = svc.beginEnding(ID);
    // Pending until the claim lands: never expires by time.
    const realNow0 = Date.now;
    jest.spyOn(Date, "now").mockImplementation(() => realNow0() + 60 * MIN);
    expect(svc.isBeingEnded(ID)).toBe(true);
    jest.restoreAllMocks();
    svc.claimCompleted(ID, hold);
    expect(svc.isBeingEnded(ID)).toBe(true);
    const realNow = Date.now;
    jest.spyOn(Date, "now").mockImplementation(() => realNow() + 60 * MIN);
    try {
      expect(svc.isBeingEnded(ID)).toBe(false);
    } finally {
      jest.restoreAllMocks();
    }
  });
});

describe("a scan that started while the end's claim was still pending", () => {
  const nap = (): Promise<void> => new Promise((r) => setTimeout(r, 10));

  it("still leaves the ended event alone when it reaches it after the hold's time is up", async () => {
    const { service } = setup();
    configMock.getString.mockImplementation(async (k: string, d?: unknown) =>
      k === "GUILD_ID" ? "guild-1" : d,
    );
    try {
      const start = new Date(Date.now() + 10 * MIN);
      store.set(ID, stored({ startTime: start }));
      // Event B (the one being ended) is read open by the scan; event A, which
      // comes first in the scan, is slow.
      const other = "65a000000000000000000002";
      const slowA = row({
        _id: other,
        nativeAdopted: true,
        announcementMessageId: "m1",
        startTime: start,
      });
      const staleB = row({ reminderSent: false, startTime: start });
      EventMock.find = jest.fn(async () => [slowA, staleB]);
      let releaseA!: () => void;
      service.nativeSync.pullAdopted = jest.fn(
        () =>
          new Promise((resolve) => {
            releaseA = () => resolve("ok");
          }),
      );

      // The end begins, and its claim stays pending.
      let releaseClaim!: () => void;
      claimDelay = new Promise((resolve) => {
        releaseClaim = resolve;
      });
      const ending = service.endEventNow(ID, "guild-1", { pullBack: false });
      await nap();

      // The scan starts NOW, inside the pending-claim window, and reads B open.
      const scan = (
        service as unknown as { runOnce: () => Promise<void> }
      ).runOnce();
      await nap();
      expect(service.nativeSync.pullAdopted).toHaveBeenCalledTimes(1);

      // The claim lands and the end finishes; the scan is still on event A.
      releaseClaim();
      expect((await ending).status).toBe("ended");

      // Much later than the hold's time, the scan reaches B's older copy.
      const realNow = Date.now;
      jest.spyOn(Date, "now").mockImplementation(() => realNow() + 60 * MIN);
      try {
        releaseA();
        await scan;
      } finally {
        jest.restoreAllMocks();
      }
      expect(service.postReminder).not.toHaveBeenCalled();
      expect(store.get(ID)?.state).toBe("ended");
    } finally {
      configMock.getString.mockImplementation(
        async (_k: string, d?: unknown) => d,
      );
    }
  });
});

describe("a valid event id posted in upper case", () => {
  const nap = (): Promise<void> => new Promise((r) => setTimeout(r, 10));
  const UPPER = ID.toUpperCase();

  it("is normalised once: the claim, the holds and the marks all use the canonical id", async () => {
    const { service } = setup();
    expect(UPPER).not.toBe(ID);
    const svc = service as unknown as {
      isBeingEnded: (id: string) => boolean;
      endsInProgress: Map<string, unknown>;
    };
    const run = jest.spyOn(service.teardown, "run");
    let release!: () => void;
    service.updateAnnouncement = jest.fn(
      () =>
        new Promise<boolean>((resolve) => {
          release = () => resolve(true);
        }),
    );
    const ending = service.endEventNow(UPPER, "guild-1", { pullBack: false });
    await nap();
    // The holds a scan looks up (by String(doc._id)) are there.
    expect(svc.isBeingEnded(ID)).toBe(true);
    expect(svc.endsInProgress.has(ID)).toBe(true);
    expect(svc.endsInProgress.has(UPPER)).toBe(false);
    release();
    expect((await ending).status).toBe("ended");
    expect((run.mock.calls[0]?.[0] as { eventId: string }).eventId).toBe(ID);
    expect(store.get(ID)?.state).toBe("ended");
  });

  it("a scan on an open copy is held off by an upper-case end", async () => {
    const { service, guild } = setup();
    let release!: () => void;
    service.updateAnnouncement = jest.fn(
      () =>
        new Promise<boolean>((resolve) => {
          release = () => resolve(true);
        }),
    );
    const ending = service.endEventNow(UPPER, "guild-1", { pullBack: false });
    await nap();
    const del = jest.fn(async () => undefined);
    guild.channels.cache.set("main-1", { delete: del });
    await service.processEvent(
      row({ state: "ended", endedAt: new Date(Date.now() - MIN) }),
      guild,
      new Date(),
      { ...WINDOWS, graceMs: 0 },
    );
    expect(service.deleteEventChannel).not.toHaveBeenCalled();
    release();
    await ending;
  });

  it("anything that is not 24 hex digits is not found", async () => {
    const { service } = setup();
    for (const bad of ["", "12", "zzzzzzzzzzzzzzzzzzzzzzzz", "abcdefghijkl"]) {
      expect(
        (await service.endEventNow(bad, "guild-1", { pullBack: false })).status,
      ).toBe("not-found");
    }
    expect(EventMock.findOneAndUpdate).not.toHaveBeenCalled();
  });
});

describe("a cancel holds the event like an end", () => {
  const nap = (): Promise<void> => new Promise((r) => setTimeout(r, 10));

  it("an older, open copy writes nothing while the cancel works, and afterwards", async () => {
    const { service, guild } = setup();
    // The cancel claims the event and stalls on its announcement refresh.
    (EventMock as unknown as { updateOne: jest.Mock }).updateOne = jest.fn(
      async () => ({ matchedCount: 1 }),
    );
    let release!: () => void;
    service.updateAnnouncement = jest.fn(
      () =>
        new Promise<boolean>((resolve) => {
          release = () => resolve(true);
        }),
    );
    const cancelling = service.cancelOne(row({ state: "active" }));
    await nap();
    expect(store.get(ID)?.state).toBe("cancelled");
    // A scan whose copy still reads open reaches the event now.
    await service.processEvent(
      row({ reminderSent: false, announcementMessageId: "m1" }),
      guild,
      new Date("2026-07-04T19:50:00Z"),
      { ...WINDOWS, reminderMs: 30 * MIN },
    );
    expect(service.postReminder).not.toHaveBeenCalled();
    expect(service.nativeSync.syncEvent).not.toHaveBeenCalled();
    release();
    await cancelling;
    // Still held after the cancel finished (the recently-ended hold).
    await service.processEvent(
      row({ reminderSent: false, announcementMessageId: "m1" }),
      guild,
      new Date("2026-07-04T19:50:00Z"),
      { ...WINDOWS, reminderMs: 30 * MIN },
    );
    expect(service.postReminder).not.toHaveBeenCalled();
  });
});

describe("a claim that fails leaves no hold that never expires", () => {
  type Svc = {
    isBeingEnded: (id: string) => boolean;
    endingEvents: Map<string, Map<number, { clock: number; until: number }>>;
    endsInProgress: Map<string, unknown>;
  };

  /** After a failed claim: nothing pending, nothing in progress, a finite hold
   * that ends with time, and a later scan processes the still-open event. */
  async function expectSettled(
    service: Awaited<ReturnType<typeof setup>>["service"],
    guild: Awaited<ReturnType<typeof setup>>["guild"],
  ): Promise<void> {
    const svc = service as unknown as Svc;
    for (const entry of svc.endingEvents.get(ID)?.values() ?? []) {
      expect(Number.isFinite(entry.clock)).toBe(true);
      expect(Number.isFinite(entry.until)).toBe(true);
    }
    expect(svc.endsInProgress.has(ID)).toBe(false);
    // The write may have landed, so it is held for a while...
    expect(svc.isBeingEnded(ID)).toBe(true);
    // ...but only for a while.
    const realNow = Date.now;
    jest.spyOn(Date, "now").mockImplementation(() => realNow() + 60 * MIN);
    try {
      expect(svc.isBeingEnded(ID)).toBe(false);
      await service.processEvent(
        row({ reminderSent: false, announcementMessageId: "m1" }),
        guild,
        new Date("2026-07-04T19:50:00Z"),
        { ...WINDOWS, reminderMs: 30 * MIN },
      );
    } finally {
      jest.restoreAllMocks();
    }
    expect(service.postReminder).toHaveBeenCalledTimes(1);
  }

  it("End event now", async () => {
    const { service, guild } = setup();
    EventMock.findOneAndUpdate.mockRejectedValueOnce(new Error("db down"));
    expect(
      (await service.endEventNow(ID, "guild-1", { pullBack: false })).status,
    ).toBe("failed");
    expect(store.get(ID)?.state).toBe("active");
    await expectSettled(service, guild);
  });

  it("the scheduled end", async () => {
    const { service, guild } = setup();
    EventMock.findOneAndUpdate.mockRejectedValueOnce(new Error("db down"));
    await service.processEvent(row(), guild, AFTER_END, WINDOWS);
    expect(store.get(ID)?.state).toBe("active");
    await expectSettled(service, guild);
  });

  it("a cancel (cancelOne)", async () => {
    const { service, guild } = setup();
    EventMock.findOneAndUpdate.mockRejectedValueOnce(new Error("db down"));
    await expect(service.cancelOne(row({ state: "active" }))).rejects.toThrow(
      "db down",
    );
    await expectSettled(service, guild);
  });

  it("a cancel through cancelSeries and cancelEvent", async () => {
    const { service, guild } = setup();
    const svc = service as unknown as {
      cancelSeries: (id: string, g: string) => Promise<unknown>;
      cancelEvent: (id: string, g: string) => Promise<unknown>;
    };
    EventMock.findOneAndUpdate.mockRejectedValueOnce(new Error("db down"));
    await expect(svc.cancelSeries(ID, "guild-1")).rejects.toThrow("db down");
    await expectSettled(service, guild);

    const again = setup();
    EventMock.findOneAndUpdate.mockRejectedValueOnce(new Error("db down"));
    await expect(
      (
        again.service as unknown as {
          cancelEvent: (id: string, g: string) => Promise<unknown>;
        }
      ).cancelEvent(ID, "guild-1"),
    ).rejects.toThrow("db down");
    await expectSettled(again.service, again.guild);
    void svc.cancelEvent;
  });

  it("the scheduled end that failed is done by a later scan once the hold is over", async () => {
    const { service, guild } = setup();
    EventMock.findOneAndUpdate.mockRejectedValueOnce(new Error("db down"));
    await service.processEvent(row(), guild, AFTER_END, WINDOWS);
    expect(store.get(ID)?.state).toBe("active");
    const realNow = Date.now;
    jest.spyOn(Date, "now").mockImplementation(() => realNow() + 60 * MIN);
    try {
      await service.processEvent(row(), guild, AFTER_END, WINDOWS);
    } finally {
      jest.restoreAllMocks();
    }
    expect(store.get(ID)?.state).toBe("ended");
  });
});

describe("the scan's scheduled to active step cannot undo a cancel", () => {
  const nap = (): Promise<void> => new Promise((r) => setTimeout(r, 10));
  const LEAD_NOW = new Date("2026-07-04T19:50:00Z");

  function statefulUpdateOne(): void {
    EventMock.updateOne = jest.fn(
      async (filter: Record<string, unknown>, update: { $set: Row }) => {
        const r = store.get(filter._id as string);
        if (!r || (filter.state !== undefined && r.state !== filter.state)) {
          return { matchedCount: 0 };
        }
        Object.assign(r, update.$set);
        return { matchedCount: 1, modifiedCount: 1 };
      },
    );
  }

  function scheduledCopy(ignored: string[]): Row {
    return row({
      state: "scheduled",
      channelId: null,
      reminderSent: true,
      $ignore: (path: string) => ignored.push(path),
    });
  }

  it("a cancel that landed while the channel was being made is not turned back into active", async () => {
    const { service, guild } = setup();
    statefulUpdateOne();
    store.set(ID, stored({ state: "scheduled", channelId: null }));
    let release!: () => void;
    service.claimEventChannel = jest.fn(
      (e: unknown) =>
        new Promise((resolve) => {
          release = () => {
            (e as Row).channelId = "main-1";
            resolve({ id: "main-1" });
          };
        }),
    );
    const ignored: string[] = [];
    const copy = scheduledCopy(ignored);
    const scan = service.processEvent(copy, guild, LEAD_NOW, WINDOWS);
    await nap();
    expect(service.claimEventChannel).toHaveBeenCalledTimes(1);
    // The cancel claims the stored row meanwhile.
    await service.cancelOne(row({ state: "scheduled" }));
    expect(store.get(ID)?.state).toBe("cancelled");
    release();
    await scan;
    expect(store.get(ID)?.state).toBe("cancelled");
    // The copy kept its state: nothing carries `active` into its save.
    expect(copy.state).toBe("scheduled");
    expect(ignored).not.toContain("state");
  });

  it("a cancel that landed during the announcement refresh survives the scan's save", async () => {
    const { service, guild } = setup();
    statefulUpdateOne();
    store.set(ID, stored({ state: "scheduled", channelId: null }));
    service.claimEventChannel = jest.fn(async (e: unknown) => {
      (e as Row).channelId = "main-1";
      return { id: "main-1" };
    });
    let release!: () => void;
    let first = true;
    service.updateAnnouncement = jest.fn(() => {
      if (!first) return Promise.resolve(true);
      first = false;
      return new Promise<boolean>((resolve) => {
        release = () => resolve(true);
      });
    });
    const ignored: string[] = [];
    const copy = scheduledCopy(ignored);
    const scan = service.processEvent(copy, guild, LEAD_NOW, WINDOWS);
    await nap();
    expect(store.get(ID)?.state).toBe("active");
    await service.cancelOne(row({ state: "active" }));
    expect(store.get(ID)?.state).toBe("cancelled");
    release();
    await scan;
    expect(store.get(ID)?.state).toBe("cancelled");
    // The transition was a conditional write; the copy's save does not carry it.
    expect(ignored).toContain("state");
    expect(EventMock.updateOne.mock.calls[0]?.[0]).toEqual({
      _id: ID,
      state: "scheduled",
    });
  });
});

describe("a skipped announcement edit is not a refresh (member reset)", () => {
  function realAnnouncement(
    service: ReturnType<typeof setup>["service"],
    guild: ReturnType<typeof setup>["guild"],
  ): jest.Mock {
    delete (service as unknown as { updateAnnouncement?: unknown })
      .updateAnnouncement;
    const edit = jest.fn(async () => undefined);
    const channel = Object.assign(Object.create(TextChannel.prototype), {
      messages: { fetch: jest.fn(async () => ({ components: [], edit })) },
    });
    guild.channels.fetch = jest.fn(async (id: string) =>
      id === "a1" ? channel : null,
    );
    return edit;
  }

  const match = (): Row =>
    row({
      announcementChannelId: "a1",
      announcementMessageId: "m1",
      rsvps: [{ userId: "u1", status: "going" }],
    });

  it("keeps the RSVP for a retry and reports the failure while a failed claim still holds the event", async () => {
    const { service, guild } = setup();
    const edit = realAnnouncement(service, guild);
    const pull = jest.fn(async () => ({ _id: ID }));
    (
      EventMock as unknown as { findByIdAndUpdate: jest.Mock }
    ).findByIdAndUpdate = pull;
    EventMock.find = jest.fn(async () => [match()]);
    // A failed claim: its hold is settled into a finite one.
    EventMock.findOneAndUpdate.mockRejectedValueOnce(new Error("db down"));
    expect(
      (await service.endEventNow(ID, "guild-1", { pullBack: false })).status,
    ).toBe("failed");

    const first = await service.removeRsvp("guild-1", "u1");
    expect(first).toEqual({ matched: 1, removed: 0, rendersFailed: 1 });
    expect(pull).not.toHaveBeenCalled();
    expect(edit).not.toHaveBeenCalled();

    // Once the hold is over, the same reset goes through.
    EventMock.find = jest.fn(async () => [match()]);
    const realNow = Date.now;
    jest.spyOn(Date, "now").mockImplementation(() => realNow() + 60 * MIN);
    try {
      const second = await service.removeRsvp("guild-1", "u1");
      expect(second).toEqual({ matched: 1, removed: 1, rendersFailed: 0 });
    } finally {
      jest.restoreAllMocks();
    }
    expect(edit).toHaveBeenCalledTimes(1);
    expect(pull).toHaveBeenCalledTimes(1);
  });
});
