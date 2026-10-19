import { describe, it, expect, jest, beforeEach } from "@jest/globals";
import { ChannelType, DiscordAPIError, RateLimitError } from "discord.js";

/**
 * The outward effects of the group set rows (#1242), `createLiveEditEffects`:
 * emptying a group's channel through the REAL mover's lock-free entry (inside
 * the move lock the live edit holds, where `moveEventMembers` would answer
 * busy), creating the channels of a new group, and deleting a removed group's
 * channel. Discord is a fake server; `EventService` is a stub.
 */

jest.unstable_mockModule("../../src/utils/logger.js", () => ({
  default: {
    info: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
    debug: jest.fn(),
  },
  isDebugMode: () => false,
}));

type Row = Record<string, unknown>;
const store = new Map<string, Row>();
jest.unstable_mockModule("../../src/models/event.js", () => ({
  Event: {
    findById: (id: string) => ({
      lean: async () => {
        const row = store.get(id);
        return row ? JSON.parse(JSON.stringify(row)) : null;
      },
    }),
  },
}));
let eventsEnabled = true;
jest.unstable_mockModule("../../src/services/config-service.js", () => ({
  ConfigService: {
    getInstance: () => ({ getBoolean: async () => eventsEnabled }),
  },
}));
type ServiceStub = {
  reconcileGroupChannels: (e: string, g: string) => Promise<unknown>;
  removeGroupChannel: (e: string, g: string, o: unknown) => Promise<unknown>;
  removeAllGroupChannels?: (
    e: string,
    g: string,
    o: unknown,
  ) => Promise<unknown>;
};
let service: ServiceStub;
jest.unstable_mockModule("../../src/services/event-service.js", () => ({
  EventService: { getInstance: () => service },
}));

const { createLiveEditEffects } =
  await import("../../src/services/event-live-edit-effects.js");
const { setMoverDepsForTests, moveEventMembers, moveEventMembersHoldingLock } =
  await import("../../src/services/event-member-moves.js");
const { withEventMoveLock, resetMoveGuardForTests } =
  await import("../../src/services/event-move-guard.js");

const GUILD = "guild-1";
const EV = "evt1";
const MAIN = "ch-main";
const CH_A = "ch-a";
const CH_B = "ch-b";
const A = "g_00000001";

function apiError(code: number): DiscordAPIError {
  return new DiscordAPIError(
    { code, message: "x" },
    code,
    400,
    "PATCH",
    "/",
    {},
  );
}

function seed(over: Row = {}): void {
  store.set(EV, {
    _id: EV,
    guildId: GUILD,
    state: "active",
    groupsEnabled: true,
    channelId: MAIN,
    createdBy: "host-1",
    groups: [
      {
        key: A,
        name: "Alpha",
        kind: "team",
        size: null,
        channelId: CH_A,
        memberIds: ["u1", "u2"],
      },
      {
        key: "g_00000002",
        name: "Bravo",
        kind: "team",
        size: null,
        channelId: CH_B,
        memberIds: ["u3"],
      },
    ],
    ...over,
  });
}

function makeWorld() {
  const inChannel = new Map<string, string>();
  const bots = new Set<string>();
  const patchBehaviour = new Map<string, unknown>();
  /** People whose move succeeds but whom the gateway cache keeps showing. */
  const lagging = new Set<string>();
  /** Runs before the mover reads a person's voice state from Discord (an interleaving). */
  const hooks: {
    beforeRead: ((user: string) => void) | null;
    afterPatch: ((user: string) => void) | null;
  } = {
    beforeRead: null,
    afterPatch: null,
  };
  const membersOf = (channelId: string) =>
    new Map(
      [...inChannel.entries()]
        .filter(([, c]) => c === channelId)
        .map(([id]) => [
          id,
          { id, displayName: `Name ${id}`, user: { bot: bots.has(id) } },
        ]),
    );
  const channelObj = (id: string) => ({
    id,
    type: ChannelType.GuildVoice,
    guildId: GUILD,
    userLimit: 0,
    isVoiceBased: () => true,
    get members() {
      return membersOf(id);
    },
  });
  const cache = new Map(
    [MAIN, CH_A, CH_B].map((id) => [id, channelObj(id)] as const),
  );
  const guild = {
    id: GUILD,
    members: {
      me: {
        permissions: { has: () => true },
        permissionsIn: () => ({ has: () => true }),
      },
    },
    channels: {
      cache,
      fetch: jest.fn(async (id: string) => {
        const c = cache.get(id);
        if (!c) throw apiError(10003);
        return c;
      }),
    },
    voiceStates: {
      cache: {
        get: (id: string) => {
          const c = inChannel.get(id);
          return c ? { channelId: c } : undefined;
        },
      },
    },
  };
  const client = {
    guilds: {
      cache: { get: (id: string) => (id === GUILD ? guild : undefined) },
    },
    token: "t",
    rest: {
      get: async (route: string) => {
        const user = route.split("/").pop() as string;
        hooks.beforeRead?.(user);
        return { channel_id: inChannel.get(user) ?? null };
      },
    },
    on: () => undefined,
    off: () => undefined,
  };
  const patch = jest.fn(
    async (
      route: string,
      o: { body: { channel_id: string } },
    ): Promise<unknown> => {
      const user = route.split("/").pop() as string;
      if (patchBehaviour.has(user)) throw patchBehaviour.get(user);
      if (!lagging.has(user)) inChannel.set(user, o.body.channel_id);
      hooks.afterPatch?.(user);
      return {};
    },
  );
  setMoverDepsForTests({
    rest: { patch } as never,
    call: (async (fn: (s: AbortSignal) => Promise<unknown>) =>
      fn(new AbortController().signal)) as never,
    paceMs: 0,
  });
  return {
    client: client as never,
    patch,
    place: (u: string, c: string) => inChannel.set(u, c),
    where: (u: string) => inChannel.get(u) ?? null,
    bots,
    patchBehaviour,
    lagging,
    hooks,
  };
}

beforeEach(() => {
  store.clear();
  seed();
  eventsEnabled = true;
  resetMoveGuardForTests();
  setMoverDepsForTests(undefined);
});

describe("emptyGroupChannel", () => {
  it("moves everyone in that channel to the main channel, the host included, and nobody else", async () => {
    const w = makeWorld();
    w.place("u1", CH_A);
    w.place("host-1", CH_A);
    w.place("u3", CH_B);
    w.place("u9", MAIN);
    const out = await createLiveEditEffects(w.client).emptyGroupChannel(
      GUILD,
      EV,
      A,
      CH_A,
      () => false,
    );
    expect(out.status).toBe("empty");
    expect(out.status === "empty" && out.moved.sort()).toEqual([
      "host-1",
      "u1",
    ]);
    expect(w.where("u1")).toBe(MAIN);
    expect(w.where("host-1")).toBe(MAIN);
    // Another group's channel and the main channel are not touched.
    expect(w.where("u3")).toBe(CH_B);
    expect(w.where("u9")).toBe(MAIN);
    expect(w.patch).toHaveBeenCalledTimes(2);
  });

  it("waits a moment for the cache to show a confirmed move, and then counts nobody who is not shown", async () => {
    const w = makeWorld();
    w.place("u1", CH_A);
    w.lagging.add("u1");
    // The gateway shows the move 300 ms late.
    setTimeout(() => w.place("u1", MAIN), 300);
    const out = await createLiveEditEffects(w.client).emptyGroupChannel(
      GUILD,
      EV,
      A,
      CH_A,
      () => false,
    );
    expect(out).toEqual({ status: "empty", moved: ["u1"] });
  });

  it("somebody who moved back in after being moved keeps the channel occupied: nobody is exempted for having been moved", async () => {
    const w = makeWorld();
    w.place("u1", CH_A);
    w.hooks.afterPatch = (user): void => {
      // Moved, and straight back (the gateway shows the arrival back).
      w.place(user, CH_A);
    };
    const out = await createLiveEditEffects(w.client).emptyGroupChannel(
      GUILD,
      EV,
      A,
      CH_A,
      () => false,
    );
    expect(out.status).toBe("occupied");
    expect(out.status === "occupied" && out.remaining).toBe(1);
  });

  it("an end holding the event withdraws every move still to be sent", async () => {
    const w = makeWorld();
    w.place("u1", CH_A);
    w.place("u2", CH_A);
    const out = await createLiveEditEffects(w.client).emptyGroupChannel(
      GUILD,
      EV,
      A,
      CH_A,
      () => true,
    );
    expect(w.patch).not.toHaveBeenCalled();
    expect(w.where("u1")).toBe(CH_A);
    expect(out.status).toBe("occupied");
    expect(out.status === "occupied" && out.detail).toBe(
      "2 no longer to be moved",
    );
  });

  it("somebody who walked into another event channel since the plan is left where they went", async () => {
    const w = makeWorld();
    w.place("u1", CH_A);
    w.place("u2", CH_A);
    // Between the plan (the cache) and the move (Discord's own answer) u1
    // joined Bravo's channel: they are not in the channel that is going.
    w.hooks.beforeRead = (user): void => {
      if (user === "u1") w.place("u1", CH_B);
    };
    const out = await createLiveEditEffects(w.client).emptyGroupChannel(
      GUILD,
      EV,
      A,
      CH_A,
      () => false,
    );
    expect(out).toEqual({ status: "empty", moved: ["u2"] });
    expect(w.where("u1")).toBe(CH_B);
    expect(w.where("u2")).toBe(MAIN);
    expect(w.patch).toHaveBeenCalledTimes(1);
  });

  it("nobody connected: empty at once, with no main channel needed and no request", async () => {
    const w = makeWorld();
    seed({ channelId: null });
    const out = await createLiveEditEffects(w.client).emptyGroupChannel(
      GUILD,
      EV,
      A,
      CH_A,
      () => false,
    );
    expect(out).toEqual({ status: "empty", moved: [] });
    expect(w.patch).not.toHaveBeenCalled();
  });

  it("people to move but no main channel: refused, nobody moved", async () => {
    const w = makeWorld();
    seed({ channelId: null });
    w.place("u1", CH_A);
    const out = await createLiveEditEffects(w.client).emptyGroupChannel(
      GUILD,
      EV,
      A,
      CH_A,
      () => false,
    );
    expect(out).toEqual({
      status: "failed",
      reason: "The event's main channel does not exist, so nobody was moved.",
    });
    expect(w.where("u1")).toBe(CH_A);
  });

  it("a person who cannot be moved keeps the channel occupied, and the reason is named", async () => {
    const w = makeWorld();
    w.place("u1", CH_A);
    w.place("u2", CH_A);
    w.patchBehaviour.set("u2", apiError(50013));
    const out = await createLiveEditEffects(w.client).emptyGroupChannel(
      GUILD,
      EV,
      A,
      CH_A,
      () => false,
    );
    expect(out).toEqual({
      status: "occupied",
      moved: ["u1"],
      remaining: 1,
      detail: "1 missing permission",
    });
    expect(w.where("u1")).toBe(MAIN);
    expect(w.where("u2")).toBe(CH_A);
  });

  it("Discord rate limiting stops the run and says how many were not attempted", async () => {
    const w = makeWorld();
    w.place("u1", CH_A);
    w.place("u2", CH_A);
    w.place("u4", CH_A);
    w.patchBehaviour.set(
      "u1",
      new RateLimitError({
        timeToReset: 60_000,
        limit: 1,
        method: "PATCH",
        hash: "h",
        url: "/",
        route: "/",
        majorParameter: "",
        global: false,
        retryAfter: 60_000,
        sublimitTimeout: 0,
      } as never),
    );
    const out = await createLiveEditEffects(w.client).emptyGroupChannel(
      GUILD,
      EV,
      A,
      CH_A,
      () => false,
    );
    expect(out.status).toBe("occupied");
    expect(out.status === "occupied" && out.remaining).toBe(3);
    expect(out.status === "occupied" && out.detail).toBe(
      "3 not attempted (Discord is rate limiting)",
    );
  });

  it("a run moves at most 60 people: the rest are counted and a second run finishes", async () => {
    const w = makeWorld();
    for (let i = 0; i < 65; i++) w.place(`p${i}`, CH_A);
    const fx = createLiveEditEffects(w.client);
    const first = await fx.emptyGroupChannel(GUILD, EV, A, CH_A, () => false);
    expect(first.status).toBe("occupied");
    expect(first.status === "occupied" && first.remaining).toBe(5);
    expect(first.status === "occupied" && first.detail).toBe(
      "5 not attempted (over the limit of 60 per run)",
    );
    const second = await fx.emptyGroupChannel(GUILD, EV, A, CH_A, () => false);
    expect(second.status).toBe("empty");
  });

  it("a bot sitting in the channel keeps it occupied", async () => {
    const w = makeWorld();
    w.place("music-bot", CH_A);
    w.bots.add("music-bot");
    const out = await createLiveEditEffects(w.client).emptyGroupChannel(
      GUILD,
      EV,
      A,
      CH_A,
      () => false,
    );
    expect(out).toEqual({
      status: "occupied",
      moved: [],
      remaining: 1,
      detail: "somebody is still connected, perhaps a bot",
    });
  });

  it("refuses when events are off, the event is over or the group changed", async () => {
    const w = makeWorld();
    w.place("u1", CH_A);
    eventsEnabled = false;
    const fx = createLiveEditEffects(w.client);
    expect(
      (await fx.emptyGroupChannel(GUILD, EV, A, CH_A, () => false)).status,
    ).toBe("failed");
    eventsEnabled = true;
    seed({ state: "ended" });
    expect(
      (await fx.emptyGroupChannel(GUILD, EV, A, CH_A, () => false)).status,
    ).toBe("failed");
    seed();
    expect(
      await fx.emptyGroupChannel(GUILD, EV, A, "another-channel", () => false),
    ).toEqual({
      status: "failed",
      reason: "The group changed, so nobody was moved.",
    });
    expect(w.patch).not.toHaveBeenCalled();
  });

  it("runs inside the move lock the live edit holds: the locked entry is not busy, the public one is", async () => {
    const w = makeWorld();
    w.place("u1", CH_A);
    const seen = await withEventMoveLock(EV, async () => {
      const busy = await moveEventMembers({
        client: w.client,
        guildId: GUILD,
        eventId: EV,
        plan: () => [],
      });
      const held = await moveEventMembersHoldingLock({
        client: w.client,
        guildId: GUILD,
        eventId: EV,
        plan: () => [],
      });
      const viaEffect = await createLiveEditEffects(w.client).emptyGroupChannel(
        GUILD,
        EV,
        A,
        CH_A,
        () => false,
      );
      return { busy, held, viaEffect };
    });
    expect(seen.busy).toBe(false);
    if (seen.busy) return;
    expect(seen.value.busy).toEqual({ status: "busy" });
    expect(seen.value.held.status).toBe("done");
    expect(seen.value.viaEffect.status).toBe("empty");
    expect(w.where("u1")).toBe(MAIN);
  });

  it("the locked entry does not release a lock it does not own", async () => {
    const w = makeWorld();
    const seen = await withEventMoveLock(EV, async () => {
      await moveEventMembersHoldingLock({
        client: w.client,
        guildId: GUILD,
        eventId: EV,
        plan: () => [],
      });
      // Still held by the caller after the run.
      return moveEventMembers({
        client: w.client,
        guildId: GUILD,
        eventId: EV,
        plan: () => [],
      });
    });
    if (seen.busy) throw new Error("lock not taken");
    expect(seen.value).toEqual({ status: "busy" });
  });
});

describe("createGroupChannels", () => {
  it("runs the group pass and returns only the groups it could not make a channel for", async () => {
    service = {
      reconcileGroupChannels: async (eventId, guildId) => {
        expect([eventId, guildId]).toEqual([EV, GUILD]);
        return {
          created: 1,
          removed: 0,
          occupied: 0,
          warnings: ["x"],
          failures: [{ key: A, name: "Alpha", reason: "category full" }],
        };
      },
      removeGroupChannel: async () => null,
    };
    expect(
      await createLiveEditEffects({} as never).createGroupChannels(GUILD, EV),
    ).toEqual({ failures: [{ key: A, reason: "category full" }] });
  });

  it("null when the server is not found, and when the pass throws", async () => {
    service = {
      reconcileGroupChannels: async () => null,
      removeGroupChannel: async () => null,
    };
    expect(
      await createLiveEditEffects({} as never).createGroupChannels(GUILD, EV),
    ).toBeNull();
    service = {
      reconcileGroupChannels: async () => {
        throw new Error("boom");
      },
      removeGroupChannel: async () => null,
    };
    expect(
      await createLiveEditEffects({} as never).createGroupChannels(GUILD, EV),
    ).toBeNull();
  });
});

describe("removeGroupChannel", () => {
  it("hands the group, the channel, the people just moved and the hold check to the channel pass", async () => {
    let seen: unknown;
    service = {
      reconcileGroupChannels: async () => null,
      removeGroupChannel: async (eventId, guildId, opts) => {
        seen = { eventId, guildId, opts };
        return { status: "removed" };
      },
    };
    const ignore = new Set(["u1"]);
    const ending = (): boolean => false;
    const out = await createLiveEditEffects({} as never).removeGroupChannel(
      GUILD,
      EV,
      A,
      CH_A,
      { ignore, ending },
    );
    expect(out).toEqual({ status: "removed" });
    expect(seen).toEqual({
      eventId: EV,
      guildId: GUILD,
      opts: { groupKey: A, channelId: CH_A, ignore, ending },
    });
  });

  it("a throw is a failure to try again, never an exception", async () => {
    service = {
      reconcileGroupChannels: async () => null,
      removeGroupChannel: async () => {
        throw new Error("boom");
      },
    };
    expect(
      await createLiveEditEffects({} as never).removeGroupChannel(
        GUILD,
        EV,
        A,
        CH_A,
        { ignore: new Set(), ending: () => false },
      ),
    ).toEqual({ status: "failed", reason: "see the log" });
  });
});

describe("removeAllGroupChannels (#1243)", () => {
  it("hands the event, the people just moved and the hold check to the channel pass", async () => {
    let seen: unknown;
    service = {
      reconcileGroupChannels: async () => null,
      removeGroupChannel: async () => null,
      removeAllGroupChannels: async (eventId, guildId, opts) => {
        seen = { eventId, guildId, opts };
        return { status: "off", deleted: 2 };
      },
    };
    const ignore = new Set(["u1"]);
    const ending = (): boolean => false;
    const out = await createLiveEditEffects({} as never).removeAllGroupChannels(
      GUILD,
      EV,
      { ignore, ending },
    );
    expect(out).toEqual({ status: "off", deleted: 2 });
    expect(seen).toEqual({
      eventId: EV,
      guildId: GUILD,
      opts: { ignore, ending },
    });
  });

  it("null when the server is not found, and a throw is a failure to try again", async () => {
    service = {
      reconcileGroupChannels: async () => null,
      removeGroupChannel: async () => null,
      removeAllGroupChannels: async () => null,
    };
    const opts = { ignore: new Set<string>(), ending: () => false };
    expect(
      await createLiveEditEffects({} as never).removeAllGroupChannels(
        GUILD,
        EV,
        opts,
      ),
    ).toBeNull();
    service = {
      reconcileGroupChannels: async () => null,
      removeGroupChannel: async () => null,
      removeAllGroupChannels: async () => {
        throw new Error("boom");
      },
    };
    expect(
      await createLiveEditEffects({} as never).removeAllGroupChannels(
        GUILD,
        EV,
        opts,
      ),
    ).toEqual({ status: "failed", reason: "see the log", deleted: 0 });
  });
});
