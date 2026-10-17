import { describe, it, expect, jest, beforeEach } from "@jest/globals";
import { DiscordAPIError, PermissionFlagsBits } from "discord.js";

const config = {
  getBoolean: jest.fn<(k: string, d?: boolean) => Promise<boolean>>(),
  getString: jest.fn<(k: string, d?: string) => Promise<string>>(),
};
jest.unstable_mockModule("../../src/services/config-service.js", () => ({
  ConfigService: { getInstance: jest.fn(() => config) },
}));

jest.unstable_mockModule("../../src/models/event.js", () => ({
  Event: {
    distinct: jest.fn(),
    find: jest.fn(),
    findOne: jest.fn(),
    exists: jest.fn(),
    create: jest.fn(),
  },
}));

const removeAdoptedEvent = jest.fn<(ref: string) => Promise<boolean>>();
jest.unstable_mockModule("../../src/services/event-service.js", () => ({
  EventService: { getInstance: jest.fn(() => ({ removeAdoptedEvent })) },
}));

const scanGuild = jest.fn<(...a: unknown[]) => Promise<unknown>>();
jest.unstable_mockModule("../../src/services/server-scan-service.js", () => ({
  ServerScanService: { getInstance: jest.fn(() => ({ scanGuild })) },
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
const EventMock = Event as unknown as Record<string, jest.Mock>;
const {
  classifyScheduledEvent,
  buildEventAdoptionPlan,
  planEventAdoption,
  eventPlanIsApplicable,
  DiscordEventAdoptionPort,
  DEFAULT_ADOPTED_DURATION_MINUTES,
} = await import("../../src/services/event-adoption.js");
const { computePlanId } =
  await import("../../src/services/server-adoption-planner.js");
type Info =
  import("../../src/services/server-scan-service.js").ScheduledEventInfo;
type Ctx = import("../../src/services/event-adoption.js").EventAdoptionContext;

const NOW = new Date("2026-10-17T12:00:00Z");

function info(over: Partial<Info> = {}): Info {
  return {
    id: "100",
    name: "Movie night",
    startsAt: "2026-10-20T19:00:00.000Z",
    endsAt: "2026-10-20T21:30:00.000Z",
    status: "1",
    channelId: null,
    description: "Popcorn",
    creatorId: "member1",
    creatorIsBot: false,
    entityType: "external",
    recurring: false,
    ...over,
  };
}

function ctx(over: Partial<Ctx> = {}): Ctx {
  return {
    eventsEnabled: true,
    botUserId: "bot1",
    canManageEvents: true,
    linkedNativeIds: new Set(),
    openUnlinked: [],
    now: NOW,
    ...over,
  };
}

describe("classifyScheduledEvent", () => {
  it("accepts a member's upcoming one-off event", () => {
    const c = classifyScheduledEvent(info(), ctx());
    expect(c.adoptable).toBe(true);
    expect(c.reason).toBeNull();
    expect(c.notes).toEqual([]);
  });

  it.each([
    [
      "already linked",
      info(),
      ctx({ linkedNativeIds: new Set(["100"]) }),
      /Already a KoolBot event/,
    ],
    ["running", info({ status: "2" }), ctx(), /Not waiting to start/],
    ["finished", info({ status: "3" }), ctx(), /Not waiting to start/],
    ["cancelled", info({ status: "4" }), ctx(), /Not waiting to start/],
    [
      "start passed",
      info({ startsAt: "2026-10-01T10:00:00.000Z" }),
      ctx(),
      /start time has passed/,
    ],
    ["no start", info({ startsAt: null }), ctx(), /start time has passed/],
    ["repeats in Discord", info({ recurring: true }), ctx(), /recurrence rule/],
    [
      "made by KoolBot",
      info({ creatorId: "bot1" }),
      ctx(),
      /Created by KoolBot itself/,
    ],
    ["made by another bot", info({ creatorIsBot: true }), ctx(), /another bot/],
    [
      "same name and start as an open KoolBot event",
      info(),
      ctx({
        openUnlinked: [
          { title: "Movie night", startTime: new Date("2026-10-20T19:00:00Z") },
        ],
      }),
      /announce the event twice/,
    ],
    [
      "no Manage Events",
      info(),
      ctx({ canManageEvents: false }),
      /Manage Events/,
    ],
  ])("skips %s and says why", (_name, i, c, reason) => {
    const out = classifyScheduledEvent(i, c);
    expect(out.adoptable).toBe(false);
    expect(out.reason).toMatch(reason);
  });

  it("notes a native channel and a missing end time", () => {
    const c = classifyScheduledEvent(
      info({ channelId: "voice1", endsAt: null, entityType: "voice" }),
      ctx(),
    );
    expect(c.adoptable).toBe(true);
    expect(c.notes.join(" ")).toMatch(/no temporary voice channel/);
    expect(c.notes.join(" ")).toMatch(/no end time/);
  });
});

describe("buildEventAdoptionPlan", () => {
  const base = {
    guildId: "g1",
    adminUserId: "admin",
    eventsEnabled: true,
    announcementConfigured: true,
  };
  const cand = (i: Info, c: Ctx = ctx()) => classifyScheduledEvent(i, c);

  it("plans one additive event.adopt step per chosen, adoptable event", () => {
    const a = cand(info({ id: "100" }));
    const b = cand(
      info({
        id: "200",
        name: "Later",
        startsAt: "2026-10-25T10:00:00.000Z",
        endsAt: null,
        channelId: "v1",
      }),
    );
    const plan = buildEventAdoptionPlan({
      ...base,
      candidates: [b, a],
      selectedIds: ["200", "100"],
    });
    expect(plan.errors).toEqual([]);
    expect(plan.operations.map((o) => [o.id, o.type, o.class])).toEqual([
      ["op-1", "event.adopt", "additive"],
      ["op-2", "event.adopt", "additive"],
    ]);
    const [first, second] = plan.operations as unknown as Array<{
      nativeEventId: string;
      durationMinutes: number;
      hasChannel: boolean;
    }>;
    // Ordered by start time, not by selection order.
    expect(first.nativeEventId).toBe("100");
    expect(first.durationMinutes).toBe(150);
    expect(second.durationMinutes).toBe(DEFAULT_ADOPTED_DURATION_MINUTES);
    expect(second.hasChannel).toBe(true);
    expect(plan.baseline.events?.map((e) => e.id)).toEqual(["100", "200"]);
    expect(plan.id).toBe(computePlanId(plan));
  });

  it("is deterministic: same choice, same id; another choice, another id", () => {
    const a = cand(info());
    const one = buildEventAdoptionPlan({
      ...base,
      candidates: [a],
      selectedIds: ["100"],
    });
    const two = buildEventAdoptionPlan({
      ...base,
      candidates: [a],
      selectedIds: ["100", "100"],
    });
    expect(one.id).toBe(two.id);
    const other = buildEventAdoptionPlan({
      ...base,
      candidates: [cand(info({ name: "Renamed" }))],
      selectedIds: ["100"],
    });
    expect(other.id).not.toBe(one.id);
  });

  it("leaves baseline.events out when nothing is adopted", () => {
    const plan = buildEventAdoptionPlan({
      ...base,
      candidates: [cand(info())],
      selectedIds: [],
    });
    expect(plan.operations).toEqual([]);
    expect("events" in plan.baseline).toBe(false);
    expect(plan.errors).toEqual([]);
  });

  it("warns about chosen events that are skipped or missing, and plans only the rest", () => {
    const linked = cand(
      info({ id: "300" }),
      ctx({ linkedNativeIds: new Set(["300"]) }),
    );
    const ok = cand(info());
    const plan = buildEventAdoptionPlan({
      ...base,
      candidates: [ok, linked],
      selectedIds: ["100", "300", "999"],
    });
    expect(plan.operations).toHaveLength(1);
    expect(plan.warnings.map((w) => w.code).sort()).toEqual([
      "event-missing",
      "event-skipped",
    ]);
    expect(
      plan.warnings.find((w) => w.code === "event-skipped")?.message,
    ).toMatch(/Already a KoolBot event/);
  });

  it("blocks the plan while the Events feature is off, and warns without an announcement channel", () => {
    const plan = buildEventAdoptionPlan({
      ...base,
      eventsEnabled: false,
      announcementConfigured: false,
      candidates: [cand(info())],
      selectedIds: ["100"],
    });
    expect(plan.errors.map((e) => e.code)).toEqual(["events-disabled"]);
    expect(plan.warnings.map((w) => w.code)).toContain(
      "no-announcement-channel",
    );
    expect(eventPlanIsApplicable({ plan } as never)).toBe(false);
  });
});

describe("planEventAdoption", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    config.getBoolean.mockResolvedValue(true);
    config.getString.mockResolvedValue("chan-1");
    EventMock.distinct.mockResolvedValue(["linked1"]);
    EventMock.find.mockReturnValue({
      select: () => ({
        lean: async () => [
          { title: "Pending", startTime: new Date("2026-10-22T10:00:00Z") },
        ],
      }),
    });
  });

  it("scans, classifies against live KoolBot rows and permissions, and plans the chosen events", async () => {
    scanGuild.mockResolvedValue({
      scanned: { botUserId: "bot1" },
      scheduledEvents: [
        info({ id: "100" }),
        info({ id: "linked1", name: "Linked" }),
        info({
          id: "300",
          name: "Pending",
          startsAt: "2026-10-22T10:00:00.000Z",
        }),
      ],
    });
    const guild = {
      id: "g1",
      members: {
        me: {
          permissions: {
            has: (p: bigint) => p === PermissionFlagsBits.ManageEvents,
          },
        },
      },
    } as never;
    const out = await planEventAdoption(guild, "admin", ["100", "linked1"]);
    expect(out.plan.operations).toHaveLength(1);
    expect(out.eventsEnabled).toBe(true);
    expect(out.announcementConfigured).toBe(true);
    expect(out.canManageEvents).toBe(true);
    const reasons = Object.fromEntries(
      out.candidates.map((c) => [c.info.id, c.reason]),
    );
    expect(reasons["100"]).toBeNull();
    expect(reasons["linked1"]).toMatch(/Already a KoolBot event/);
    expect(reasons["300"]).toMatch(/announce the event twice/);
  });

  it("reports a missing Manage Events permission on every member-made event", async () => {
    scanGuild.mockResolvedValue({
      scanned: { botUserId: "bot1" },
      scheduledEvents: [info()],
    });
    const guild = {
      id: "g1",
      members: { me: { permissions: { has: () => false } } },
    } as never;
    const out = await planEventAdoption(guild, "admin", ["100"]);
    expect(out.canManageEvents).toBe(false);
    expect(out.candidates[0].reason).toMatch(/Manage Events/);
    expect(out.plan.operations).toEqual([]);
  });
});

describe("DiscordEventAdoptionPort", () => {
  const input = {
    ref: "snap-1:op-1",
    guildId: "g1",
    adminId: "admin",
    nativeEventId: "100",
    name: "Movie night",
    description: "Popcorn",
    startsAt: "2026-10-20T19:00:00.000Z",
    durationMinutes: 150,
  };
  const lean = (value: unknown) => ({
    select: () => ({ lean: async () => value }),
  });

  beforeEach(() => {
    jest.clearAllMocks();
    EventMock.findOne.mockReturnValue(lean(null));
    EventMock.exists.mockResolvedValue(null);
    EventMock.create.mockResolvedValue({ _id: "row1" });
  });

  const port = () => new DiscordEventAdoptionPort({} as never, {} as never);

  it("creates a one-off, scheduled row linked to the native event and marked adopted", async () => {
    expect(await port().adopt(input)).toBe("row1");
    expect(EventMock.create).toHaveBeenCalledWith(
      expect.objectContaining({
        guildId: "g1",
        title: "Movie night",
        startTime: new Date("2026-10-20T19:00:00.000Z"),
        durationMinutes: 150,
        state: "scheduled",
        recurrence: "none",
        nativeEventId: "100",
        nativeAdopted: true,
        adoptionRef: "snap-1:op-1",
        createdBy: "admin",
      }),
    );
  });

  it("is idempotent: a retry returns the row this step already wrote", async () => {
    EventMock.findOne.mockReturnValue(lean({ _id: "row0" }));
    expect(await port().adopt(input)).toBe("row0");
    expect(EventMock.create).not.toHaveBeenCalled();
  });

  it("refuses an event that is already linked, including losing the race on the unique index", async () => {
    EventMock.exists.mockResolvedValue({ _id: "other" });
    await expect(port().adopt(input)).rejects.toThrow(
      /already a KoolBot event/,
    );
    EventMock.exists.mockResolvedValue(null);
    EventMock.create.mockRejectedValue(
      Object.assign(new Error("dup"), { code: 11000 }),
    );
    await expect(port().adopt(input)).rejects.toThrow(
      /already a KoolBot event/,
    );
    EventMock.create.mockRejectedValue(new Error("db down"));
    await expect(port().adopt(input)).rejects.toThrow(/db down/);
  });

  it("finds a step's row by reference, and removes through the event service", async () => {
    EventMock.findOne.mockReturnValue(lean({ _id: "row9" }));
    expect(await port().findByRef("snap-1:op-1")).toBe("row9");
    EventMock.findOne.mockReturnValue(lean(null));
    expect(await port().findByRef("snap-1:op-2")).toBeNull();
    removeAdoptedEvent.mockResolvedValue(true);
    await port().remove("snap-1:op-1");
    expect(removeAdoptedEvent).toHaveBeenCalledWith("snap-1:op-1");
  });

  it("reads a native event, null when Discord says it is gone, and rethrows other failures", async () => {
    const fetch = jest.fn<(id: string) => Promise<unknown>>();
    const p = new DiscordEventAdoptionPort(
      {} as never,
      { scheduledEvents: { fetch } } as never,
    );
    fetch.mockResolvedValueOnce({
      id: "100",
      name: "Movie night",
      description: null,
      scheduledStartAt: new Date("2026-10-20T19:00:00Z"),
      scheduledEndAt: null,
      status: 1,
    });
    expect(await p.readNative("100")).toEqual({
      id: "100",
      name: "Movie night",
      description: "",
      startsAt: "2026-10-20T19:00:00.000Z",
      endsAt: null,
      status: "1",
    });
    fetch.mockRejectedValueOnce(
      Object.assign(Object.create(DiscordAPIError.prototype), { code: 10070 }),
    );
    expect(await p.readNative("100")).toBeNull();
    fetch.mockRejectedValueOnce(new Error("503"));
    await expect(p.readNative("100")).rejects.toThrow("503");
  });
});
