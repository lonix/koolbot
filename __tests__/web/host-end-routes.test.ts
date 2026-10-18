/**
 * The host panel's "End the event" section and its action (#1193), over real
 * HTTP: real Express, the real session middleware, the real CSRF check, the
 * real host gate (#1189), the real `EventService` with the real shared
 * teardown, and the real mover with the real return-to-main planner. Stubbed:
 * the session row, the permission check, the audit write, the event model (a
 * small stateful fake, so the atomic claim really matches on state), and
 * Discord (a fake guild with voice channels and a REST `patch`). The group
 * channel pass and the native sync are stubs on the service instance.
 */

import {
  describe,
  it,
  expect,
  jest,
  beforeAll,
  beforeEach,
  afterAll,
  afterEach,
} from "@jest/globals";
import { Buffer } from "buffer";
import express from "express";
import type { AddressInfo } from "node:net";
import type { Server } from "node:http";
import { ChannelType, DiscordAPIError } from "discord.js";

type Json = Record<string, unknown>;

let events: Record<string, Json> = {};
const order: string[] = [];
jest.unstable_mockModule("../../src/models/event.js", () => ({
  EVENT_RECURRENCES: ["none", "weekly", "biweekly", "monthly"],
  EVENT_GROUP_KINDS: ["team", "open", "leads"],
  Event: {
    findById: (id: string) => {
      const value = events[id] ? JSON.parse(JSON.stringify(events[id])) : null;
      if (value?.startTime) value.startTime = new Date(value.startTime);
      return {
        lean: async () => value,
        catch: () => Promise.resolve(value),
        then: (ok: (v: unknown) => unknown) => Promise.resolve(value).then(ok),
      };
    },
    findOneAndUpdate: async (
      filter: Json,
      update: { $set: Json },
    ): Promise<Json | null> => {
      const row = events[filter._id as string];
      const states = (filter.state as { $in: string[] }).$in;
      if (!row || row.guildId !== filter.guildId) return null;
      if (!states.includes(row.state as string)) return null;
      Object.assign(row, update.$set);
      order.push("claim");
      return JSON.parse(JSON.stringify(row));
    },
    updateOne: async (filter: Json) => {
      order.push("captains");
      const row = events[filter._id as string];
      for (const g of (row?.groups as Json[]) ?? []) g.captainId = null;
      return { modifiedCount: 1 };
    },
    findOne: (filter: Json) => ({
      select: () => ({
        lean: async () => {
          const row = events[filter._id as string];
          return row ? JSON.parse(JSON.stringify(row)) : null;
        },
      }),
    }),
  },
}));

const { signValue } = await import("../../src/web/cookies.js");
const { deriveCsrfToken, ensureCsrfCookie } =
  await import("../../src/web/csrf.js");
const { createSessionMiddleware } = await import("../../src/web/session.js");
const { createUserRouter } = await import("../../src/web/user-routes.js");
const { WebSessionService } =
  await import("../../src/services/web-session-service.js");
const { PermissionsService } =
  await import("../../src/services/permissions-service.js");
const { EventService } = await import("../../src/services/event-service.js");
const { ConfigService } = await import("../../src/services/config-service.js");
const { WebAuditLog } = await import("../../src/models/web-audit-log.js");
const { setMoverDepsForTests } =
  await import("../../src/services/event-member-moves.js");
const { resetMoveGuardForTests } =
  await import("../../src/services/event-move-guard.js");

const SECRET = "test-secret-for-host-end-routes";
const GUILD = "guild-1";
const CREATOR = "111111111111111111";
const OTHER = "other-1";
const EVENT_ID = "65a000000000000000000001";
const PANEL = `/me/events/${EVENT_ID}/host`;

const ANA = "211111111111111111";
const BEN = "222222222222222222";
const CAL = "233333333333333333";

const MAIN = "c-main";
const CH_HELI = "c-heli";
const CH_LOGI = "c-logi";

function team(key: string, name: string, over: Json = {}): Json {
  return {
    key,
    name,
    kind: "team",
    size: null,
    tag: "",
    marker: "",
    channelId: null,
    captainId: null,
    memberIds: [],
    ...over,
  };
}

function makeEvent(over: Json = {}): Json {
  return {
    _id: EVENT_ID,
    guildId: GUILD,
    createdBy: CREATOR,
    title: "Quiz night",
    description: "",
    state: "active",
    endedAt: null,
    startTime: "2030-01-01T19:00:00.000Z",
    timezone: "UTC",
    durationMinutes: 90,
    channelId: MAIN,
    recurrence: "none",
    seriesId: null,
    groupsEnabled: true,
    groupLabel: "Team",
    leaderLabel: "Leader",
    channelLeadMinutes: null,
    groupsLocked: false,
    nativeEventId: "native-1",
    announcementMessageId: null,
    groups: [
      team("g_heli", "Heli", {
        channelId: CH_HELI,
        memberIds: [ANA],
        captainId: ANA,
      }),
      team("g_logi", "Logi", { channelId: CH_LOGI, memberIds: [CAL] }),
    ],
    ...over,
  };
}

let auditRows: Array<Record<string, unknown>> = [];
let eventsEnabled = true;
let botMayMove = true;
let sessionUser = CREATOR;
let voice = new Map<string, string | null>();
let server: Server;
let base = "";
const patch = jest.fn<(route: string, o: Json) => Promise<unknown>>();
const cleanup = jest.fn(async () => {
  order.push("cleanup");
  return { created: 0, removed: 2, occupied: 0, failures: [], warnings: [] };
});
const syncEvent = jest.fn(async (e: unknown) => {
  order.push("native");
  // The real sync releases the link once the Discord event is closed.
  (e as { nativeEventId: string | null }).nativeEventId = null;
});

function channelObj(id: string, limit = 0): unknown {
  return {
    id,
    type: ChannelType.GuildVoice,
    guildId: GUILD,
    userLimit: limit,
    isVoiceBased: () => true,
    get members() {
      return new Map(
        [...voice.entries()]
          .filter(([, c]) => c === id)
          .map(([u]) => [
            u,
            { id: u, displayName: `Name ${u}`, user: { bot: false } },
          ]),
      );
    },
  };
}

function fakeClient(): never {
  const cache = new Map<string, unknown>([
    [MAIN, channelObj(MAIN)],
    [CH_HELI, channelObj(CH_HELI)],
    [CH_LOGI, channelObj(CH_LOGI)],
  ]);
  const guild = {
    id: GUILD,
    channels: { cache, fetch: async (id: string) => cache.get(id) },
    members: {
      cache: { get: () => undefined },
      get me() {
        return {
          permissions: { has: () => botMayMove },
          permissionsIn: () => ({ has: () => botMayMove }),
        };
      },
    },
    voiceStates: {
      cache: {
        get: (id: string) => {
          const c = voice.get(id);
          return c ? { channelId: c } : undefined;
        },
      },
    },
  };
  return {
    guilds: {
      cache: { get: (id: string) => (id === GUILD ? guild : undefined) },
      fetch: async () => guild,
    },
    rest: {
      get: async (route: string) => {
        const c = voice.get(route.split("/").pop() as string);
        if (!c) {
          throw new DiscordAPIError(
            { code: 10065, message: "x" },
            10065,
            404,
            "GET",
            "/",
            {},
          );
        }
        return { channel_id: c };
      },
    },
  } as never;
}

function cookie(user: string): string {
  const now = Date.now();
  const encoded = Buffer.from(
    JSON.stringify({
      sid: "sid-1",
      uid: user,
      gid: GUILD,
      rol: "user",
      iat: now - 1000,
      act: now - 1000,
    }),
  ).toString("base64url");
  return `koolbot_session=${signValue(encoded, SECRET)}`;
}

const csrf = (): string => deriveCsrfToken("sid-1") ?? "";

async function call(
  path: string,
  init: { method?: string; user?: string; csrf?: boolean; body?: Json } = {},
): Promise<{ status: number; text: string; location: string | null }> {
  const method = init.method ?? "GET";
  const form = new globalThis.URLSearchParams();
  if (method !== "GET" && init.csrf !== false) form.set("_csrf", csrf());
  for (const [k, v] of Object.entries(init.body ?? {})) form.set(k, String(v));
  const res = await fetch(`${base}${path}`, {
    method,
    headers: {
      cookie: cookie(init.user ?? sessionUser),
      "content-type": "application/x-www-form-urlencoded",
    },
    body: method === "GET" ? undefined : form.toString(),
    redirect: "manual",
  });
  return {
    status: res.status,
    text: await res.text(),
    location: res.headers.get("location"),
  };
}

function flashOf(location: string | null): { type: string; msg: string } {
  const q = new globalThis.URL(location ?? "", "http://x").searchParams;
  return { type: q.get("flash") ?? "", msg: q.get("msg") ?? "" };
}

const end = (body: Json = {}, init: Json = {}) =>
  call(`${PANEL}/end`, { method: "POST", body, ...init });

const patched = (): Array<{ user: string; to: unknown }> =>
  patch.mock.calls.map(([route, o]) => ({
    user: route.split("/").pop() as string,
    to: (o.body as Json).channel_id,
  }));

beforeAll(async () => {
  process.env.WEBUI_SESSION_SECRET = SECRET;
  process.env.WEBUI_INACTIVITY_TIMEOUT_MINUTES = "30";
  process.env.GUILD_ID = GUILD;
  const app = express();
  app.use(express.urlencoded({ extended: false }));
  app.use(ensureCsrfCookie);
  app.use(
    "/me",
    createUserRouter(fakeClient(), createSessionMiddleware({} as never)),
  );
  await new Promise<void>((resolve) => {
    server = app.listen(0, "127.0.0.1", resolve);
  });
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterAll(async () => {
  setMoverDepsForTests(undefined);
  EventService.reset();
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

beforeEach(() => {
  process.env.WEBUI_SESSION_SECRET = SECRET;
  process.env.GUILD_ID = GUILD;
  (WebSessionService as unknown as { instance: unknown }).instance = null;
  events = { [EVENT_ID]: makeEvent() };
  auditRows = [];
  order.length = 0;
  eventsEnabled = true;
  botMayMove = true;
  sessionUser = CREATOR;
  voice = new Map([
    [ANA, CH_HELI],
    [CAL, CH_LOGI],
    [BEN, MAIN],
    [CREATOR, CH_HELI],
  ]);
  resetMoveGuardForTests();
  cleanup.mockClear();
  syncEvent.mockClear();
  patch.mockReset().mockImplementation(async (route, o) => {
    order.push("move");
    voice.set(
      route.split("/").pop() as string,
      (o.body as Json).channel_id as string,
    );
    return {};
  });
  setMoverDepsForTests({
    rest: { patch } as never,
    call: (async (fn: (s: AbortSignal) => Promise<unknown>) =>
      fn(new AbortController().signal)) as never,
    paceMs: 0,
  });

  jest.spyOn(WebSessionService.getInstance(), "findById").mockImplementation(
    async () =>
      ({
        discordUserId: sessionUser,
        guildId: GUILD,
        role: "user",
        scopes: [],
        revokedAt: null,
        expiresAt: new Date(Date.now() + 3_600_000),
      }) as never,
  );
  jest.spyOn(PermissionsService, "getInstance").mockReturnValue({
    isAdministrator: async () => true,
    checkCommandPermission: async () => true,
  } as never);
  jest.spyOn(ConfigService, "getInstance").mockReturnValue({
    registerReloadCallback: () => undefined,
    addChangeListener: () => undefined,
    getBoolean: async (key: string) =>
      key === "events.enabled" ? eventsEnabled : false,
    getNumber: async (_k: string, f: number) => f,
    getString: async (_k: string, f: string) => f,
  } as never);
  jest.spyOn(WebAuditLog, "create").mockImplementation(async (row: unknown) => {
    auditRows.push(row as Record<string, unknown>);
    return {} as never;
  });

  // The real service, built on the fake client; only its Discord-facing passes
  // are replaced. The route's `EventService.getInstance(client)` finds it.
  EventService.reset();
  const service = EventService.getInstance(fakeClient()) as unknown as {
    groupChannels: { cleanup: unknown };
    nativeSync: { syncEvent: unknown };
    teardown: unknown;
  };
  service.groupChannels.cleanup = cleanup;
  service.nativeSync.syncEvent = syncEvent;
  // No pause after the pull-back in tests.
  (service.teardown as { deps: { settleMs: number } }).deps.settleMs = 0;
  jest
    .spyOn(EventService, "getInstance")
    .mockReturnValue(service as unknown as never);
});

afterEach(() => {
  jest.restoreAllMocks();
});

describe("the end section", () => {
  it("is a form with CSRF, a required confirmation and the pull-back box ticked, for a running group event", async () => {
    const r = await call(PANEL);
    expect(r.status).toBe(200);
    expect(r.text).toContain('id="host-end"');
    expect(r.text).not.toContain(
      "End the event and tidy up its channels. Not available yet",
    );
    const form = (r.text.match(/<form[\s\S]*?<\/form>/g) ?? []).find((f) =>
      f.includes(`action="${PANEL}/end"`),
    ) as string;
    expect(form).toBeDefined();
    expect(form).toContain('name="_csrf"');
    expect(form).toMatch(
      /<input type="checkbox" name="confirm" value="1" required>/,
    );
    expect(form).toMatch(
      /<input type="checkbox" name="pullBack" value="1" checked>/,
    );
    expect(form).toContain("This cannot be undone");
  });

  it("offers no pull-back for an event without group channels", async () => {
    events[EVENT_ID] = makeEvent({ groupsEnabled: false, groups: [] });
    const r = await call(PANEL);
    expect(r.text).toContain('id="host-end"');
    expect(r.text).not.toContain('name="pullBack"');
    expect(r.text).toContain('name="confirm"');

    events[EVENT_ID] = makeEvent({
      groups: [team("g", "G", { channelId: null })],
    });
    const again = await call(PANEL);
    expect(again.text).not.toContain('name="pullBack"');
  });

  it("explains that a scheduled event cannot be ended yet, with no form", async () => {
    events[EVENT_ID] = makeEvent({ state: "scheduled" });
    const r = await call(PANEL);
    expect(r.text).toContain('id="host-end"');
    expect(r.text).toContain("Only a running event can be ended");
    expect(r.text).not.toContain(`action="${PANEL}/end"`);
  });

  it("is not on the page for an ended event", async () => {
    events[EVENT_ID] = makeEvent({ state: "ended" });
    const r = await call(PANEL);
    expect(r.text).not.toContain('id="host-end"');
    expect(r.text).not.toContain(`action="${PANEL}/end"`);
  });
});

describe("End event now", () => {
  it("without the confirmation nothing happens and the host is told", async () => {
    const r = await end({});
    expect(r.status).toBe(303);
    expect(flashOf(r.location).type).toBe("err");
    expect(flashOf(r.location).msg).toContain("Tick the box");
    expect(events[EVENT_ID]?.state).toBe("active");
    expect(patch).not.toHaveBeenCalled();
    expect(cleanup).not.toHaveBeenCalled();
    const row = auditRows.at(-1) as Json;
    expect(row.action).toBe("event.host.end");
    expect(row.result).toBe("failure");
    expect(JSON.stringify(row.details)).toContain("not-confirmed");
  });

  it("ends the event in the order of the teardown: claim, pull-back, group channels, leaders, native", async () => {
    const r = await end({ confirm: "1", pullBack: "1" });
    expect(r.status).toBe(303);
    const flash = flashOf(r.location);
    expect(flash.type).toBe("ok");
    expect(flash.msg).toMatch(/^The event has ended\./);
    expect(flash.msg).toContain("Moved 3 back to the main channel");
    expect(events[EVENT_ID]?.state).toBe("ended");
    expect(events[EVENT_ID]?.endedAt).toBeTruthy();
    expect(order).toEqual([
      "claim",
      "move",
      "move",
      "move",
      "cleanup",
      "captains",
      "native",
    ]);
    // Everyone in a group channel is back in the main channel, the host too:
    // the real mover ran against the already-ended row (allowFinished).
    expect(patched().sort((a, b) => a.user.localeCompare(b.user))).toEqual(
      [
        { user: ANA, to: MAIN },
        { user: CREATOR, to: MAIN },
        { user: CAL, to: MAIN },
      ].sort((a, b) => a.user.localeCompare(b.user)),
    );
    expect(voice.get(BEN)).toBe(MAIN);
  });

  it("without the pull-back box nobody is moved, and occupied channels are left to the scan", async () => {
    const r = await end({ confirm: "1" });
    expect(flashOf(r.location).type).toBe("ok");
    expect(patch).not.toHaveBeenCalled();
    expect(order).toEqual(["claim", "cleanup", "captains", "native"]);
    expect(events[EVENT_ID]?.state).toBe("ended");
  });

  it("audits one row with counts, never names", async () => {
    await end({ confirm: "1", pullBack: "1" });
    const row = auditRows.at(-1) as Json;
    expect(row.action).toBe("event.host.end");
    expect(row.result).toBe("success");
    expect(row.targetId).toBe(EVENT_ID);
    const details = JSON.stringify(row.details);
    expect(details).toContain('"outcome":"ended"');
    expect(details).toContain('"pullBack":true');
    expect(details).toContain('"moved":3');
    expect(details).not.toContain(ANA);
    expect(details).not.toContain("Name ");
    expect(auditRows.filter((a) => a.action === "event.host.end")).toHaveLength(
      1,
    );
  });

  it("a pull-back the bot may not do is reported, and the rest of the teardown still runs", async () => {
    botMayMove = false;
    const r = await end({ confirm: "1", pullBack: "1" });
    const flash = flashOf(r.location);
    // The event is ended (the claim came first); the move step needs attention.
    expect(events[EVENT_ID]?.state).toBe("ended");
    expect(flash.type).toBe("ok");
    expect(flash.msg).toContain("needs attention");
    expect(flash.msg).toContain("Move Members");
    expect(patch).not.toHaveBeenCalled();
    expect(order).toEqual(["claim", "cleanup", "captains", "native"]);
  });

  it("pressed again it is a no-op with a clear message, and runs nothing twice", async () => {
    await end({ confirm: "1", pullBack: "1" });
    order.length = 0;
    patch.mockClear();
    const r = await end({ confirm: "1", pullBack: "1" });
    expect(r.status).toBe(303);
    const flash = flashOf(r.location);
    expect(flash.type).toBe("ok");
    expect(flash.msg).toContain("already ended");
    expect(order).toEqual([]);
    expect(patch).not.toHaveBeenCalled();
    expect(cleanup).toHaveBeenCalledTimes(1);
    expect((auditRows.at(-1) as Json).result).toBe("success");
    expect(JSON.stringify((auditRows.at(-1) as Json).details)).toContain(
      "already-ended",
    );
  });

  it("a scheduled event cannot be ended, with a clear message and no change", async () => {
    events[EVENT_ID] = makeEvent({ state: "scheduled" });
    const flash = flashOf((await end({ confirm: "1" })).location);
    expect(flash.type).toBe("err");
    expect(flash.msg).toContain("has not started");
    expect(events[EVENT_ID]?.state).toBe("scheduled");
    expect(order).toEqual([]);
  });

  it("a cancelled event cannot be ended", async () => {
    events[EVENT_ID] = makeEvent({ state: "cancelled" });
    const flash = flashOf((await end({ confirm: "1" })).location);
    expect(flash.type).toBe("err");
    expect(flash.msg).toContain("cancelled");
    expect(events[EVENT_ID]?.state).toBe("cancelled");
  });

  it("is refused while events are off, and changes nothing", async () => {
    eventsEnabled = false;
    const flash = flashOf((await end({ confirm: "1" })).location);
    expect(flash.type).toBe("err");
    expect(flash.msg).toContain("events.enabled");
    expect(events[EVENT_ID]?.state).toBe("active");
    expect(order).toEqual([]);
  });

  it("decides from the claim, not from the page: an event ended after the gate loaded it is a no-op", async () => {
    // The gate loads the row as active; by the time the teardown claims it, a
    // host elsewhere has ended it.
    const service = EventService.getInstance({} as never) as unknown as {
      endEventNow: (...a: unknown[]) => Promise<unknown>;
    };
    const original = service.endEventNow.bind(service);
    service.endEventNow = async (...a: unknown[]): Promise<unknown> => {
      events[EVENT_ID] = makeEvent({ state: "ended" });
      return original(...a);
    };
    const flash = flashOf((await end({ confirm: "1" })).location);
    expect(flash.type).toBe("ok");
    expect(flash.msg).toContain("already ended");
    expect(order).toEqual([]);
  });

  it("is refused without CSRF and for someone who is not the host", async () => {
    expect((await end({ confirm: "1" }, { csrf: false })).status).toBe(403);
    sessionUser = OTHER;
    const r = await end({ confirm: "1" });
    expect(r.status).toBe(403);
    expect(events[EVENT_ID]?.state).toBe("active");
    expect(order).toEqual([]);
    expect((auditRows.at(-1) as Json).action).toBe("event.host.denied");
  });
});
