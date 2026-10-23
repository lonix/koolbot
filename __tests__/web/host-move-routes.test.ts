/**
 * The host panel's "Move people" section and its three actions (#1192), over
 * real HTTP: real Express, the real session middleware, the real CSRF check,
 * the real host gate (#1189) and the real mover with the real planners.
 * Stubbed: the session row, the permission check, the event lookups, the audit
 * write, and Discord (a fake guild with voice channels, voice states and a
 * REST `patch`).
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
// The mover reads the event fresh through the model.
jest.unstable_mockModule("../../src/models/event.js", () => ({
  EVENT_RECURRENCES: ["none", "weekly", "biweekly", "monthly"],
  EVENT_GROUP_KINDS: ["team", "open", "leads"],
  Event: {
    findById: (id: string) => ({
      lean: async () => {
        const row = events[id];
        return row ? JSON.parse(JSON.stringify(row)) : null;
      },
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
const { withEventMoveLock, resetMoveGuardForTests } =
  await import("../../src/services/event-move-guard.js");

const SECRET = "test-secret-for-host-move-routes";
const GUILD = "guild-1";
const CREATOR = "111111111111111111";
const OTHER = "other-1";
const EVENT_ID = "65a000000000000000000001";
const PANEL = `/me/events/${EVENT_ID}/host`;

const ANA = "211111111111111111";
const BEN = "222222222222222222";
const CAL = "233333333333333333";
const AWAY = "244444444444444444";

const MAIN = "c-main";
const CH_HELI = "c-heli";
const CH_LOGI = "c-logi";
const CH_OPEN = "c-open";
const CH_OTHER = "c-unrelated";

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
    startTime: new Date("2030-01-01T19:00:00Z"),
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
    groups: [
      team("g_heli", "Heli", {
        size: 2,
        channelId: CH_HELI,
        memberIds: [ANA, BEN],
      }),
      team("g_logi", "Logi <i>", { channelId: CH_LOGI, memberIds: [CAL] }),
      team("g_open", "Spectators", { kind: "open", channelId: CH_OPEN }),
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
    [CH_HELI, channelObj(CH_HELI, 2)],
    [CH_LOGI, channelObj(CH_LOGI)],
    [CH_OPEN, channelObj(CH_OPEN)],
    [CH_OTHER, channelObj(CH_OTHER)],
  ]);
  const guild = {
    id: GUILD,
    channels: {
      cache,
      fetch: async (id: string) => cache.get(id),
    },
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
      fetch: async (id: string) => {
        const c = voice.get(id);
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
        return { channelId: c };
      },
    },
  };
  return {
    guilds: {
      cache: { get: (id: string) => (id === GUILD ? guild : undefined) },
    },
    // The raw voice-state read the mover makes.
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

const post = (action: string, body: Json = {}, init: Json = {}) =>
  call(`${PANEL}/${action}`, { method: "POST", body, ...init });

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
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

beforeEach(() => {
  process.env.WEBUI_SESSION_SECRET = SECRET;
  process.env.GUILD_ID = GUILD;
  (WebSessionService as unknown as { instance: unknown }).instance = null;
  events = { [EVENT_ID]: makeEvent() };
  auditRows = [];
  eventsEnabled = true;
  botMayMove = true;
  sessionUser = CREATOR;
  voice = new Map([
    [ANA, MAIN],
    [BEN, MAIN],
    [CAL, CH_OPEN],
    [CREATOR, MAIN],
  ]);
  resetMoveGuardForTests();
  patch.mockReset().mockImplementation(async (route, o) => {
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
    resolveWebScopes: async () => ["member", "host"],
  } as never);
  jest.spyOn(EventService, "getInstance").mockReturnValue({
    getEvent: async (id: string) => events[id] ?? null,
    getGroupChannelReport: () => null,
    isEventBeingEnded: () => false,
  } as never);
  jest.spyOn(ConfigService, "getInstance").mockReturnValue({
    getBoolean: async (key: string) =>
      key === "events.enabled" ? eventsEnabled : false,
    getNumber: async (_k: string, f: number) => f,
    getString: async (_k: string, f: string) => f,
  } as never);
  jest.spyOn(WebAuditLog, "create").mockImplementation(async (row: unknown) => {
    auditRows.push(row as Record<string, unknown>);
    return {} as never;
  });
});

afterEach(() => {
  jest.restoreAllMocks();
});

describe("the toolbar's moves (Send to teams, Move people)", () => {
  it("shows the three forms with CSRF, escapes names, and posts keys, never channel ids", async () => {
    const r = await call(PANEL);
    expect(r.status).toBe(200);
    expect(r.text).toContain('id="host-board"');
    expect(r.text).not.toContain("Not available yet");
    for (const action of ["send-to-groups", "return-to-main", "move-one"]) {
      expect(r.text).toContain(`action="${PANEL}/${action}"`);
    }
    const forms = r.text.match(/<form[\s\S]*?<\/form>/g) ?? [];
    const moveForms = forms.filter((f) =>
      /send-to-groups|return-to-main|move-one/.test(f),
    );
    expect(moveForms).toHaveLength(3);
    for (const f of moveForms) expect(f).toContain('name="_csrf"');
    // Send to teams sits in the toolbar; the other two in the Move people set.
    const toolbar = r.text.slice(r.text.indexOf('role="group"'));
    expect(toolbar.indexOf("Move people…")).toBeLessThan(
      toolbar.indexOf(`${PANEL}/send-to-groups`),
    );
    // Destinations are the main channel and keys; no channel id appears in an option.
    expect(r.text).toContain('<option value="main">');
    expect(r.text).toContain('<option value="g_heli">');
    expect(r.text).not.toMatch(/<option value="c-(main|heli|logi|open)"/);
    // Escaped group name and the open channel is a destination for one move.
    expect(r.text).toContain("Logi &lt;i&gt;");
    expect(r.text).not.toContain("Logi <i>");
    expect(r.text).toContain('<option value="g_open">');
    // The checkbox is unchecked by default (open and leads are included).
    expect(r.text).toMatch(
      /<input type="checkbox" name="skipSpecial" value="1">/,
    );
    expect(r.text).not.toMatch(/name="skipSpecial"[^>]*checked/);
  });

  it("switches Send to teams and Move people off, with an explanation, when the bot cannot move members", async () => {
    botMayMove = false;
    const r = await call(PANEL);
    expect(r.text).toContain("Move Members");
    const toolbar = r.text.slice(r.text.indexOf('role="group"'));
    const bar = toolbar.slice(0, toolbar.indexOf("</div>\n<p"));
    // Move people… and Send to teams are disabled and point at the reason.
    expect(bar.match(/ disabled aria-disabled="true"/g)?.length).toBe(2);
    expect(bar).toContain('aria-describedby="host-board-notes"');
    expect(r.text).toContain('id="host-board-notes"');
    for (const action of ["return-to-main", "move-one"]) {
      expect(r.text).not.toContain(`action="${PANEL}/${action}"`);
    }
  });

  it("with only an open group and no team, still lists the connected people and offers Move people; Randomise and Send are off", async () => {
    events[EVENT_ID] = makeEvent({
      groups: [
        {
          key: "g_open",
          name: "Spectators",
          kind: "open",
          size: null,
          tag: "",
          marker: "",
          channelId: CH_OPEN,
          captainId: null,
          memberIds: [],
        },
      ],
    });
    const r = await call(PANEL);
    expect(r.status).toBe(200);
    expect(r.text).toContain('id="host-board-loose"');
    expect(r.text).toContain(`action="${PANEL}/return-to-main"`);
    expect(r.text).toContain(`action="${PANEL}/move-one"`);
    expect(r.text).toContain('<option value="g_open">');
    expect(r.text).not.toContain(`action="${PANEL}/randomise"`);
    expect(r.text).toMatch(/disabled aria-disabled="true"[^>]*>Send to teams</);
  });

  it("is not on the page for an event without groups", async () => {
    events[EVENT_ID] = makeEvent({ groupsEnabled: false, groups: [] });
    const r = await call(PANEL);
    expect(r.text).not.toContain('id="host-board"');
    expect(r.text).not.toContain(`${PANEL}/send-to-groups`);
  });

  it("is not on the page for an ended event", async () => {
    events[EVENT_ID] = makeEvent({ state: "ended" });
    const r = await call(PANEL);
    expect(r.text).not.toContain('id="host-board"');
  });
});

describe("send to groups", () => {
  it("moves people to their group's channel, never the host, and audits counts only", async () => {
    voice.set(AWAY, null);
    voice.set(CAL, MAIN);
    events[EVENT_ID] = makeEvent({
      groups: [
        team("g_heli", "Heli", {
          size: 3,
          channelId: CH_HELI,
          memberIds: [ANA, BEN, CREATOR, AWAY],
        }),
        team("g_logi", "Logi", { channelId: CH_LOGI, memberIds: [CAL] }),
      ],
    });
    const r = await post("send-to-groups");
    expect(r.status).toBe(303);
    const flash = flashOf(r.location);
    expect(flash.type).toBe("ok");
    expect(flash.msg).toMatch(/^Moved 3\./);
    expect(flash.msg).toContain("Skipped 2");
    expect(patched().sort((a, b) => a.user.localeCompare(b.user))).toEqual([
      { user: ANA, to: CH_HELI },
      { user: BEN, to: CH_HELI },
      { user: CAL, to: CH_LOGI },
    ]);
    expect(voice.get(CREATOR)).toBe(MAIN);
    const row = auditRows.at(-1) as Json;
    expect(row.action).toBe("event.host.send-to-groups");
    expect(row.result).toBe("success");
    const details = JSON.stringify(row.details);
    expect(details).toContain('"moved":3');
    expect(details).not.toContain(ANA);
    expect(details).not.toContain("Name ");
  });

  it("also leaves the acting admin alone", async () => {
    // An admin session (not the creator) hosting: their own assignment is not moved.
    const ADMIN = "299999999999999999";
    voice.set(ADMIN, MAIN);
    events[EVENT_ID] = makeEvent({
      groups: [
        team("g_heli", "Heli", {
          channelId: CH_HELI,
          memberIds: [ANA, ADMIN],
        }),
      ],
    });
    jest.spyOn(WebSessionService.getInstance(), "findById").mockImplementation(
      async () =>
        ({
          discordUserId: ADMIN,
          guildId: GUILD,
          role: "admin",
          scopes: [],
          revokedAt: null,
          expiresAt: new Date(Date.now() + 3_600_000),
        }) as never,
    );
    sessionUser = ADMIN;
    const r = await call(`${PANEL}/send-to-groups`, {
      method: "POST",
      user: ADMIN,
    });
    expect(r.status).toBe(303);
    expect(patched().map((p) => p.user)).toEqual([ANA]);
  });

  it("mentions people in a group whose channel does not exist yet", async () => {
    events[EVENT_ID] = makeEvent({
      groups: [
        team("g_heli", "Heli", { channelId: CH_HELI, memberIds: [ANA] }),
        team("g_logi", "Logi", { channelId: null, memberIds: [CAL, BEN] }),
      ],
    });
    const flash = flashOf((await post("send-to-groups")).location);
    expect(flash.msg).toContain(
      "2 assigned people are in a group without a channel yet",
    );
    expect(patched().map((p) => p.user)).toEqual([ANA]);
  });

  it("reports a partial failure as one flash", async () => {
    patch.mockImplementation(async (route, o) => {
      const user = route.split("/").pop() as string;
      if (user === BEN) {
        throw new DiscordAPIError(
          { code: 50013, message: "x" },
          50013,
          403,
          "PATCH",
          "/",
          {},
        );
      }
      voice.set(user, (o.body as Json).channel_id as string);
      return {};
    });
    const r = await post("send-to-groups");
    const flash = flashOf(r.location);
    expect(flash.type).toBe("ok");
    expect(flash.msg).toContain("Moved 2.");
    expect(flash.msg).toContain("1 missing permission");
    expect((auditRows.at(-1) as Json).result).toBe("success");
  });

  it("is an error flash and a failure audit row when nobody could be moved", async () => {
    voice.clear();
    const r = await post("send-to-groups");
    const flash = flashOf(r.location);
    expect(flash.type).toBe("err");
    expect(flash.msg).toContain("not connected to voice");
    expect((auditRows.at(-1) as Json).result).toBe("failure");
  });

  it("answers 'already in progress' to a second click and moves nobody", async () => {
    let release: () => void = () => undefined;
    const held = withEventMoveLock(
      EVENT_ID,
      () => new Promise<void>((resolve) => (release = resolve)),
    );
    const r = await post("send-to-groups");
    const flash = flashOf(r.location);
    expect(flash.type).toBe("err");
    expect(flash.msg).toContain("already in progress");
    expect(patch).not.toHaveBeenCalled();
    release();
    await held;
    expect(flashOf((await post("send-to-groups")).location).type).toBe("ok");
  });

  it("refuses while events are off", async () => {
    eventsEnabled = false;
    const flash = flashOf((await post("send-to-groups")).location);
    expect(flash.type).toBe("err");
    expect(flash.msg).toContain("events.enabled");
    expect(patch).not.toHaveBeenCalled();
  });

  it("refuses without Move Members, whatever the form said", async () => {
    botMayMove = false;
    const flash = flashOf((await post("send-to-groups")).location);
    expect(flash.type).toBe("err");
    expect(flash.msg).toContain("Move Members");
    expect(patch).not.toHaveBeenCalled();
  });

  it("is refused without CSRF, for a non-host, and for an ended event", async () => {
    expect((await post("send-to-groups", {}, { csrf: false })).status).toBe(
      403,
    );
    sessionUser = OTHER;
    expect((await post("send-to-groups")).status).toBe(403);
    sessionUser = CREATOR;
    events[EVENT_ID] = makeEvent({ state: "ended" });
    const flash = flashOf((await post("send-to-groups")).location);
    expect(flash.type).toBe("err");
    expect(patch).not.toHaveBeenCalled();
  });
});

describe("return to main", () => {
  beforeEach(() => {
    voice = new Map([
      [ANA, CH_HELI],
      [CAL, CH_OPEN],
      [BEN, MAIN],
      [CREATOR, CH_HELI],
    ]);
  });

  it("brings everyone in a group channel back, open channels included, never the host", async () => {
    const flash = flashOf((await post("return-to-main")).location);
    expect(flash.msg).toMatch(/^Moved 2\./);
    expect(patched().sort((a, b) => a.user.localeCompare(b.user))).toEqual([
      { user: ANA, to: MAIN },
      { user: CAL, to: MAIN },
    ]);
    expect(voice.get(CREATOR)).toBe(CH_HELI);
  });

  it("leaves the open channel alone when the box is ticked", async () => {
    await post("return-to-main", { skipSpecial: "1" });
    expect(patched()).toEqual([{ user: ANA, to: MAIN }]);
    expect(voice.get(CAL)).toBe(CH_OPEN);
  });

  it("says so when nobody needs to move", async () => {
    voice = new Map([[BEN, MAIN]]);
    const flash = flashOf((await post("return-to-main")).location);
    expect(flash.type).toBe("ok");
    expect(flash.msg).toContain("Nobody needed to be moved");
  });
});

describe("move one person", () => {
  it("moves to a group by key", async () => {
    const r = await post("move-one", { userId: BEN, to: "g_logi" });
    expect(flashOf(r.location).msg).toMatch(/^Moved 1\./);
    expect(patched()).toEqual([{ user: BEN, to: CH_LOGI }]);
    const row = auditRows.at(-1) as Json;
    expect(JSON.stringify(row.details)).toContain(BEN);
  });

  it("moves to main", async () => {
    voice.set(CAL, CH_OPEN);
    await post("move-one", { userId: CAL, to: "main" });
    expect(patched()).toEqual([{ user: CAL, to: MAIN }]);
  });

  it("refuses a full group", async () => {
    voice.set(ANA, CH_HELI);
    voice.set(AWAY, CH_HELI);
    const flash = flashOf(
      (await post("move-one", { userId: BEN, to: "g_heli" })).location,
    );
    expect(flash.type).toBe("err");
    expect(flash.msg).toContain("group full");
    expect(patch).not.toHaveBeenCalled();
  });

  it("refuses a raw channel id, an unknown key and a bad user id", async () => {
    for (const body of [
      { userId: BEN, to: CH_LOGI },
      { userId: BEN, to: "nope" },
      { userId: BEN, to: "" },
      { userId: "not-an-id", to: "main" },
      { userId: "", to: "main" },
    ]) {
      const flash = flashOf((await post("move-one", body)).location);
      expect(flash.type).toBe("err");
    }
    expect(patch).not.toHaveBeenCalled();
  });

  it("does not compare a padded group key with the stored one", async () => {
    const flash = flashOf(
      (await post("move-one", { userId: BEN, to: " g_logi " })).location,
    );
    expect(flash.type).toBe("err");
    expect(patch).not.toHaveBeenCalled();
  });

  it("will not move someone who is in an unrelated channel", async () => {
    voice.set(BEN, CH_OTHER);
    const flash = flashOf(
      (await post("move-one", { userId: BEN, to: "main" })).location,
    );
    expect(flash.type).toBe("err");
    expect(flash.msg).toContain("not part of the event");
    expect(patch).not.toHaveBeenCalled();
    expect(voice.get(BEN)).toBe(CH_OTHER);
  });
});

describe("an event host with no other rights moves people from the toolbar (#1424)", () => {
  it("posts the forms the page carries (send, return, move one) and each is one audited run; another host gets 403", async () => {
    // No other rights: not an administrator, only the Event host scope.
    jest.spyOn(PermissionsService, "getInstance").mockReturnValue({
      isAdministrator: async () => false,
      checkCommandPermission: async () => true,
      resolveWebScopes: async () => ["member", "host"],
    } as never);
    const page = await call(PANEL);
    const forms = (page.text.match(/<form[\s\S]*?<\/form>/g) ?? []).map(
      (f) => ({
        action: /action="([^"]*)"/.exec(f)?.[1] ?? "",
        fields: Object.fromEntries(
          [
            ...f.matchAll(
              /<input type="hidden" name="([^"]+)" value="([^"]*)">/g,
            ),
          ].map((m) => [m[1], m[2]]),
        ) as Record<string, string>,
      }),
    );
    const formFor = (a: string) =>
      forms.find((f) => f.action === `${PANEL}/${a}`);
    for (const a of ["send-to-groups", "return-to-main", "move-one"]) {
      expect(formFor(a)).toBeDefined();
    }
    // The page's own token, with the person and destination chosen as the dialog would.
    const send = await post("send-to-groups", {
      ...formFor("send-to-groups")?.fields,
    });
    expect(send.status).toBe(303);
    const back = await post("return-to-main", {
      ...formFor("return-to-main")?.fields,
    });
    expect(back.status).toBe(303);
    const one = await post("move-one", {
      ...formFor("move-one")?.fields,
      userId: ANA,
      to: "main",
    });
    expect(one.status).toBe(303);
    for (const action of ["send-to-groups", "return-to-main", "move-one"]) {
      expect(
        auditRows.filter((a) => a.action === `event.host.${action}`),
      ).toHaveLength(1);
    }
    // Somebody else's event: refused at the gate, nothing moved.
    const before = auditRows.length;
    sessionUser = OTHER;
    for (const action of ["send-to-groups", "return-to-main", "move-one"]) {
      expect(
        (await post(action, { ...formFor(action)?.fields }, { user: OTHER }))
          .status,
      ).toBe(403);
    }
    expect(
      auditRows.slice(before).every((a) => a.action === "event.host.denied"),
    ).toBe(true);
  });
});
