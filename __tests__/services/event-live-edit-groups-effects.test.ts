import {
  describe,
  it,
  expect,
  jest,
  beforeEach,
  afterEach,
} from "@jest/globals";
import { DiscordAPIError, RateLimitError } from "discord.js";

/**
 * The rows of names and sizes (#1241) driven through the REAL channel passes
 * (`EventGroupChannels.syncNames` / `syncUserLimits`), the REAL shared rename
 * queue and the REAL `createLiveEditEffects`, with a fake Discord REST client
 * and the in-memory Event stand-in. This is the evidence for the acceptance
 * criteria that a rename waits on Discord's budget without sleeping, is
 * reported, and is finished later, and that a lower size moves nobody.
 */

import {
  store,
  writes,
  fake,
  EventMock,
  type Json,
} from "./event-live-edit-groups-fake-event.js";

jest.unstable_mockModule("../../src/models/event.js", () => ({
  Event: EventMock,
}));
jest.unstable_mockModule("../../src/services/config-service.js", () => ({
  ConfigService: { getInstance: () => ({ getBoolean: async () => true }) },
}));
jest.unstable_mockModule(
  "../../src/services/tracking-opt-out-service.js",
  () => ({
    TrackingOptOutService: { getInstance: () => ({ admission: () => 1 }) },
  }),
);
const syncMember = jest.fn(async (...args: unknown[]): Promise<string> => {
  void args;
  return "none";
});
const requestSweep = jest.fn();
jest.unstable_mockModule("../../src/services/event-nickname-tags.js", () => ({
  EventNicknameTags: { getInstance: () => ({ syncMember, requestSweep }) },
}));
jest.unstable_mockModule("../../src/web/audit.js", () => ({
  recordAudit: async () => undefined,
  boundAuditEntry: <T>(e: T): T => e,
}));
type Stub = {
  syncGroupNames: (e: string, g: string, k?: string) => Promise<unknown>;
  syncGroupUserLimits: (e: string, g: string, k?: string) => Promise<unknown>;
};
let eventService: Stub;
jest.unstable_mockModule("../../src/services/event-service.js", () => ({
  EventService: { getInstance: () => eventService },
}));

process.env.WEBUI_SESSION_SECRET = "live-edit-groups-effects-secret";

const { EventGroupChannels } =
  await import("../../src/services/event-group-channels.js");
const { getRenameQueue } =
  await import("../../src/services/event-rename-queue.js");
const { runLiveEdit } = await import("../../src/services/event-live-edit.js");
const {
  groupNameRowId,
  groupSizeRowId,
} = await import("../../src/services/event-live-edit-groups.js");
const { createLiveEditEffects } =
  await import("../../src/services/event-live-edit-effects.js");
const { resetMoveGuardForTests } =
  await import("../../src/services/event-move-guard.js");

const GUILD = "111111111111111111";
const EV = "65a000000000000000000001";
const BOT = "999999999999999999";
const A = "g_00000001";
const B = "g_00000002";
const A_CH = "200000000000000001";
const B_CH = "200000000000000002";

function apiError(code: number, status = 400): DiscordAPIError {
  return new DiscordAPIError(
    { code, message: "Missing Permissions" },
    code,
    status,
    "PATCH",
    "/",
    {},
  );
}
function rateLimited(ms: number): RateLimitError {
  return new RateLimitError({
    timeToReset: ms,
    limit: 2,
    method: "PATCH",
    hash: "h",
    url: "u",
    route: "/channels/:id",
    majorParameter: A_CH,
    global: false,
    retryAfter: ms,
    sublimitTimeout: 0,
    scope: "user",
  } as never);
}

const deps = {
  isEventsEnabled: async (): Promise<boolean | null> => true,
  maxGroups: async (): Promise<number | null> => 15,
  isEnding: (): boolean => false,
  effects: createLiveEditEffects({} as never),
};

let guildFound = true;
const patches: Array<{ route: string; body: Json }> = [];
const names = new Map<string, string>();
const limits = new Map<string, number>();
const fail: { patch?: unknown } = {};

function seed(): void {
  store.set(EV, {
    _id: EV,
    guildId: GUILD,
    state: "active",
    groupsEnabled: true,
    presetId: null,
    channelId: "main",
    tagsEnabled: true,
    groups: [
      {
        key: A,
        name: "Alpha",
        kind: "team",
        size: 3,
        tag: "A",
        channelId: A_CH,
        captainId: null,
        memberIds: ["u1", "u2"],
      },
      {
        key: B,
        name: "Bravo",
        kind: "team",
        size: null,
        tag: "",
        channelId: B_CH,
        captainId: null,
        memberIds: [],
      },
    ],
  });
}
const stored = (key = A): Json =>
  (store.get(EV)?.groups as Json[]).find((g) => g.key === key) as Json;

function wire(): void {
  const rest = {
    patch: jest.fn(async (route: string, o: { body: Json }) => {
      patches.push({ route, body: o.body });
      if (fail.patch) throw fail.patch;
      const ch = /channels\/(\d+)/.exec(route)![1];
      if (typeof o.body.name === "string") names.set(ch, o.body.name);
      if (typeof o.body.user_limit === "number") {
        limits.set(ch, o.body.user_limit);
      }
      return {};
    }),
  };
  const guild = {
    id: GUILD,
    channels: {
      cache: new Map(),
      fetch: async (id: string) => ({
        id,
        name: names.get(id),
        guildId: GUILD,
        type: 2,
        userLimit: limits.get(id) ?? 0,
      }),
    },
  };
  const channels = new EventGroupChannels(
    { user: { id: BOT }, token: "t" } as never,
    {
      getPrefix: async () => "",
      getGraceMs: async () => 0,
      isEnabled: async () => true,
    },
    {
      rest: rest as never,
      call: ((fn: (s: AbortSignal) => Promise<unknown>) =>
        fn(new AbortController().signal)) as never,
      paceMs: 0,
    },
  );
  eventService = {
    syncGroupNames: async (e, _g, k) =>
      guildFound ? channels.syncNames(e, guild as never, k) : null,
    syncGroupUserLimits: async (e, _g, k) =>
      guildFound ? channels.syncUserLimits(e, guild as never, k) : null,
  };
}

const entry = (rowId: string, to: unknown, base: unknown) => ({
  rowId,
  to,
  base,
});
const run = (entries: Array<{ rowId: string; to: unknown; base: unknown }>) =>
  runLiveEdit({
    guildId: GUILD,
    eventId: EV,
    deps,
    submission: entries as never,
  });
type Done = Extract<Awaited<ReturnType<typeof run>>, { status: "done" }>;
const done = (o: Awaited<ReturnType<typeof run>>): Done => {
  expect(o.status).toBe("done");
  return o as Done;
};

beforeEach(() => {
  store.clear();
  writes.length = 0;
  patches.length = 0;
  names.clear();
  limits.clear();
  fail.patch = undefined;
  fake.beforeWrite = null;
  fake.failReads = false;
  guildFound = true;
  syncMember.mockClear();
  requestSweep.mockClear();
  getRenameQueue().forget(A_CH);
  getRenameQueue().forget(B_CH);
  resetMoveGuardForTests();
  names.set(A_CH, "Alpha");
  names.set(B_CH, "Bravo");
  limits.set(A_CH, 3);
  seed();
  wire();
});
afterEach(() => {
  jest.restoreAllMocks();
});

describe("a rename through the real rename queue", () => {
  it("renames the channel in place and clears the pending marker", async () => {
    const out = done(await run([entry(groupNameRowId(0), "Apex", "Alpha")]));
    expect(out.applied).toHaveLength(1);
    expect(patches).toEqual([
      { route: `/channels/${A_CH}`, body: { name: "Apex" } },
    ]);
    expect(names.get(A_CH)).toBe("Apex");
    expect(stored().nameSyncPending).toBe(false);
    expect(stored().memberIds).toEqual(["u1", "u2"]);
  });

  it("a budget wait: reported with the time left, never slept on, nothing sent; a later save finishes it", async () => {
    getRenameQueue().reserve(A_CH);
    getRenameQueue().reserve(A_CH);
    const started = Date.now();
    const out = done(await run([entry(groupNameRowId(0), "Apex", "Alpha")]));
    // It did not wait for the budget (10 minutes), it answered at once.
    expect(Date.now() - started).toBeLessThan(5_000);
    expect(out.applied).toEqual([]);
    expect(out.partial).toHaveLength(1);
    expect(out.partial[0].owed).toMatch(/renamed in about \d+ minutes/);
    expect(patches).toEqual([]);
    expect(stored()).toMatchObject({ name: "Apex", nameSyncPending: true });
    expect(names.get(A_CH)).toBe("Alpha");

    // The budget is back (the window passed): the same form finishes it.
    getRenameQueue().forget(A_CH);
    const again = done(await run([entry(groupNameRowId(0), "Apex", "Apex")]));
    expect(again.applied).toMatchObject([{ reconcile: true }]);
    expect(patches).toEqual([
      { route: `/channels/${A_CH}`, body: { name: "Apex" } },
    ]);
    expect(stored().nameSyncPending).toBe(false);
  });

  it("a 429 from Discord is reported with Discord's time and blocks the channel for the next save", async () => {
    fail.patch = rateLimited(120_000);
    const out = done(await run([entry(groupNameRowId(0), "Apex", "Alpha")]));
    expect(out.partial[0].owed).toContain("about 2 minutes");
    expect(stored()).toMatchObject({ name: "Apex", nameSyncPending: true });
    fail.patch = undefined;
    const again = done(await run([entry(groupNameRowId(0), "Apex", "Apex")]));
    expect(again.partial[0].owed).toContain("about");
    // The second save never reached Discord.
    expect(patches).toHaveLength(1);
  });

  it("a missing permission is reported as not finished, held back, and the name stays saved", async () => {
    fail.patch = apiError(50013, 403);
    const out = done(await run([entry(groupNameRowId(0), "Apex", "Alpha")]));
    expect(out.partial[0].owed).toContain("the channel is not renamed yet");
    expect(stored()).toMatchObject({ name: "Apex", nameSyncPending: true });
    // The standing refusal is not hammered by the next save either.
    await run([entry(groupNameRowId(0), "Apex", "Apex")]);
    expect(patches).toHaveLength(1);
  });

  it("a server that cannot be reached leaves the name saved and the channel owed", async () => {
    guildFound = false;
    const out = done(await run([entry(groupNameRowId(1), "Bold", "Bravo")]));
    expect(out.partial[0].owed).toContain("could not be reached");
    expect(stored(B)).toMatchObject({ name: "Bold", nameSyncPending: true });
    expect(patches).toEqual([]);
  });
});

describe("a size change through the real channel pass", () => {
  it("sets the user limit, and lowering it below the members moves nobody", async () => {
    const out = done(await run([entry(groupSizeRowId(0), 1, 3)]));
    expect(out.applied).toHaveLength(1);
    expect(patches).toEqual([
      { route: `/channels/${A_CH}`, body: { user_limit: 1 } },
    ]);
    expect(limits.get(A_CH)).toBe(1);
    expect(stored()).toMatchObject({ size: 1, memberIds: ["u1", "u2"] });
    expect(stored().sizeSyncPending).toBe(false);
  });

  it("a refused limit is reported as not finished and the size stays saved", async () => {
    fail.patch = apiError(50013, 403);
    const out = done(await run([entry(groupSizeRowId(0), 5, 3)]));
    expect(out.partial[0].owed).toContain("user limit is not changed yet");
    expect(stored()).toMatchObject({ size: 5, sizeSyncPending: true });
  });
});

describe("createLiveEditEffects (names, sizes, tags)", () => {
  const effects = (): ReturnType<typeof createLiveEditEffects> =>
    createLiveEditEffects({} as never);

  it("finds the outcome of the asked group, and answers null when the pass has none or the server is gone", async () => {
    stored().nameSyncPending = true;
    expect(await effects().syncGroupName(GUILD, EV, A)).toEqual({
      groupKey: A,
      status: "applied",
    });
    // Nothing pending for B: the pass answers no outcome for it.
    expect(await effects().syncGroupName(GUILD, EV, B)).toBeNull();
    stored().sizeSyncPending = true;
    limits.set(A_CH, 0);
    expect(await effects().syncGroupUserLimit(GUILD, EV, A)).toEqual({
      groupKey: A,
      status: "applied",
    });
    expect(await effects().syncGroupUserLimit(GUILD, EV, B)).toBeNull();
    guildFound = false;
    expect(await effects().syncGroupName(GUILD, EV, A)).toBeNull();
    expect(await effects().syncGroupUserLimit(GUILD, EV, A)).toBeNull();
  });

  it("retag brings each member in line with the one tag function and asks for a sweep, in the background", async () => {
    effects().retagMembers(GUILD, EV, ["u1", "u2"]);
    await new Promise((r) => setTimeout(r, 20));
    expect(syncMember).toHaveBeenCalledTimes(2);
    expect(syncMember.mock.calls.map((c) => (c[0] as { userId: string }).userId)).toEqual([
      "u1",
      "u2",
    ]);
    expect(requestSweep).toHaveBeenCalledWith(GUILD);
  });
});

describe("the scan finishes the channel between the row's write and its follow-up", () => {
  /** Effects whose follow-up runs only after the scan has already done the work. */
  function scanFirst(): typeof deps {
    const real = createLiveEditEffects({} as never);
    return {
      ...deps,
      effects: {
        ...real,
        syncGroupName: async (g, e, k) => {
          await eventService.syncGroupNames(e, g, k); // the scan
          return real.syncGroupName(g, e, k);
        },
        syncGroupUserLimit: async (g, e, k) => {
          await eventService.syncGroupUserLimits(e, g, k); // the scan
          return real.syncGroupUserLimit(g, e, k);
        },
      },
    };
  }
  const runWith = (
    d: typeof deps,
    entries: Array<{ rowId: string; to: unknown; base: unknown }>,
  ) =>
    runLiveEdit({
      guildId: GUILD,
      eventId: EV,
      deps: d,
      submission: entries as never,
    });

  it("a rename the scan already finished is applied, not reported as Discord being unreachable", async () => {
    const out = done(
      await runWith(scanFirst(), [entry(groupNameRowId(0), "Apex", "Alpha")]),
    );
    expect(out.partial).toEqual([]);
    expect(out.applied).toHaveLength(1);
    // The scan renamed once; the follow-up found nothing left to do.
    expect(patches).toHaveLength(1);
    expect(stored().nameSyncPending).toBe(false);
  });

  it("a user limit the scan already finished is applied, not reported as Discord being unreachable", async () => {
    const out = done(
      await runWith(scanFirst(), [entry(groupSizeRowId(0), 1, 3)]),
    );
    expect(out.partial).toEqual([]);
    expect(out.applied).toHaveLength(1);
    expect(patches).toEqual([
      { route: `/channels/${A_CH}`, body: { user_limit: 1 } },
    ]);
  });

  it("an unavailable pass (events turned off) with the marker still set stays partial", async () => {
    const real = createLiveEditEffects({} as never);
    const off = {
      ...deps,
      effects: { ...real, syncGroupName: async () => null },
    };
    const out = done(
      await runWith(off, [entry(groupNameRowId(0), "Apex", "Alpha")]),
    );
    expect(out.partial[0].owed).toContain("could not be reached");
    expect(stored().nameSyncPending).toBe(true);
  });
});
