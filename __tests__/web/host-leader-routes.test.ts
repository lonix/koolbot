/**
 * The host panel's "Leaders" section and its three actions (#1195), over real
 * HTTP: real Express, the real session middleware, the real CSRF check, the
 * real host gate (#1189), the REAL leader, assignment and move services with
 * their real locks, the real mover and the real `installLeaderCleanup`
 * subscription. Stubbed: the session row, the permission check, the Event model
 * (the in-memory stand-in shared with the service tests), the tracking-opt-out
 * barrier, the audit write, and Discord (a fake guild with voice channels and a
 * REST `patch` that also replays the gateway's voice join into the real
 * `handleGroupSelfJoin`, as `src/index.ts` does).
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
import {
  store,
  fake,
  EventMock,
  type Doc,
} from "../services/event-group-fake-event.js";

type Json = Record<string, unknown>;

jest.unstable_mockModule("../../src/models/event.js", () => ({
  EVENT_RECURRENCES: ["none", "weekly", "biweekly", "monthly"],
  EVENT_GROUP_KINDS: ["team", "open", "leads"],
  Event: EventMock,
}));

/** Tickets handed out by `admission()`, and the ticket each reset-aware write was given. */
const tickets: number[] = [];
const writeTickets: Array<number | undefined> = [];

jest.unstable_mockModule(
  "../../src/services/tracking-opt-out-service.js",
  () => ({
    TrackingOptOutService: {
      getInstance: () => ({
        trackWrite: async (
          _userId: string,
          _guildId: string,
          write: () => Promise<void>,
        ) => {
          await write();
          return true;
        },
        admission: () => {
          tickets.push(tickets.length + 1);
          return tickets.length;
        },
        resetAwareWrite: async (
          userIds: string[],
          _guildId: string,
          write: (ids: string[]) => Promise<unknown>,
          since?: number,
        ) => {
          writeTickets.push(since);
          const ids = [...new Set(userIds)];
          return { admitted: ids, value: await write(ids) };
        },
      }),
    },
  }),
);

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
const { installLeaderCleanup } =
  await import("../../src/services/event-group-leaders.js");
const { handleGroupSelfJoin } =
  await import("../../src/services/event-group-assignment.js");

const SECRET = "test-secret-for-host-leader-routes";
const GUILD = "guild-1";
const CREATOR = "111111111111111111";
const OTHER = "other-1";
const EVENT_ID = "65a000000000000000000001";
const PANEL = `/me/events/${EVENT_ID}/host`;

const ANA = "211111111111111111";
const BEN = "222222222222222222";
const CAL = "233333333333333333";
const DAN = "244444444444444444";

const MAIN = "c-main";
const CH_HELI = "c-heli";
const CH_LOGI = "c-logi";
const CH_OPEN = "c-open";
const CH_LEADS = "c-leads";

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

function makeEvent(over: Json = {}): Doc {
  return {
    _id: EVENT_ID,
    guildId: GUILD,
    createdBy: CREATOR,
    title: "Clan match",
    description: "",
    state: "active",
    startTime: new Date("2030-01-01T19:00:00Z"),
    timezone: "UTC",
    durationMinutes: 90,
    channelId: MAIN,
    recurrence: "none",
    seriesId: null,
    groupsEnabled: true,
    groupLabel: "Squad",
    leaderLabel: "Captain",
    captainsEnabled: true,
    channelLeadMinutes: null,
    groupsLocked: false,
    groups: [
      team("g_heli", "Heli <i>", {
        channelId: CH_HELI,
        memberIds: [ANA, BEN],
        captainId: ANA,
      }),
      team("g_logi", "Logi", {
        channelId: CH_LOGI,
        memberIds: [CAL, DAN],
        captainId: CAL,
      }),
      team("g_open", "Spectators", { kind: "open", channelId: CH_OPEN }),
      team("g_leads", "Command", { kind: "leads", channelId: CH_LEADS }),
    ],
    ...over,
  } as unknown as Doc;
}

const doc = (): Doc => store.get(EVENT_ID) as Doc;
const groupOf = (key: string) => doc().groups.find((g) => g.key === key)!;

let auditRows: Array<Record<string, unknown>> = [];
let eventsEnabled = true;
let botMayMove = true;
let sessionUser = CREATOR;
let voice = new Map<string, string | null>();
let server: Server;
let base = "";
let patchGate: Promise<void> | null = null;
let patchReached: () => void = () => undefined;
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
  const cache = new Map<string, unknown>(
    [MAIN, CH_HELI, CH_LOGI, CH_OPEN, CH_LEADS].map((id) => [
      id,
      channelObj(id),
    ]),
  );
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

const post = (action: string, body: Json = {}, init: Json = {}) =>
  call(`${PANEL}/${action}`, { method: "POST", body, ...init });

const patched = (): Array<{ user: string; to: unknown }> =>
  patch.mock.calls.map(([route, o]) => ({
    user: route.split("/").pop() as string,
    to: (o.body as Json).channel_id,
  }));

const settle = async (): Promise<void> => {
  for (let i = 0; i < 30; i++)
    await new Promise((r) => globalThis.setTimeout(r, 0));
};

let uninstall: () => void = () => undefined;

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
  store.clear();
  tickets.length = 0;
  writeTickets.length = 0;
  store.set(EVENT_ID, makeEvent());
  fake.gateFindById = null;
  fake.failUpdatesFor = null;
  auditRows = [];
  eventsEnabled = true;
  botMayMove = true;
  sessionUser = CREATOR;
  patchGate = null;
  patchReached = () => undefined;
  voice = new Map<string, string | null>([
    [ANA, MAIN],
    [BEN, MAIN],
    [CAL, CH_LOGI],
    [DAN, null],
    [CREATOR, MAIN],
  ]);
  resetMoveGuardForTests();
  uninstall();
  uninstall = installLeaderCleanup();
  patch.mockReset().mockImplementation(async (route, o) => {
    patchReached();
    if (patchGate) await patchGate;
    const user = route.split("/").pop() as string;
    const channelId = (o.body as Json).channel_id as string;
    voice.set(user, channelId);
    // The gateway's voice join, as `src/index.ts` forwards it.
    void handleGroupSelfJoin({
      guildId: GUILD,
      userId: user,
      channelId,
      admission: 1,
    });
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
    getEvent: async (id: string) => (store.get(id) as unknown) ?? null,
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

describe("leaders on the board", () => {
  it("shows the leader's badge, a Make leader button, the pull form and the label rename, with CSRF, the event's label, escaped names and keys, never channel ids", async () => {
    const r = await call(PANEL);
    expect(r.status).toBe(200);
    expect(r.text).toContain('id="host-board"');
    for (const action of ["set-leader", "leader-label", "pull-leaders"]) {
      expect(r.text).toContain(`action="${PANEL}/${action}"`);
    }
    const forms = r.text.match(/<form[\s\S]*?<\/form>/g) ?? [];
    const leaderForms = forms.filter((f) =>
      /\/(set-leader|leader-label|pull-leaders)"/.test(f),
    );
    expect(leaderForms.length).toBeGreaterThanOrEqual(3);
    for (const f of leaderForms) expect(f).toContain('name="_csrf"');
    // The event's own label is used; names are escaped.
    expect(r.text).toContain("Pull captains only");
    expect(r.text).toContain("Heli &lt;i&gt;");
    expect(r.text).not.toContain("Heli <i>");
    // The leader carries a badge; a member who is not the leader can be made one.
    expect(r.text).toMatch(
      /<span class="kb-badge kb-badge--info">[\s\S]*?Captain<\/span>/,
    );
    expect(r.text).toMatch(/Make captain/);
    expect(r.text).toMatch(/Remove as captain/);
    // Destinations are default, main, here and keys; a leads group exists.
    expect(r.text).toContain('<option value="default">');
    expect(r.text).toContain('<option value="g_leads">');
    expect(r.text).toContain("the Command channel");
    expect(r.text).not.toMatch(/<option value="c-(main|heli|logi|leads)"/);
    // The Groups card has a leader column.
    expect(r.text).toContain('<th scope="col">Captain</th>');
    // The open and leads groups are no column and take no leader.
    expect(r.text).not.toContain('aria-label="People in Command"');
  });

  it("falls back to the main channel in the default text when there is no leads group", async () => {
    const d = doc();
    d.groups = d.groups.filter((g) => g.kind !== "leads");
    const r = await call(PANEL);
    expect(r.text).toContain("the main channel");
  });

  it("shows no leader badge, button, pull or column while leaders are off", async () => {
    doc().captainsEnabled = false;
    const r = await call(PANEL);
    expect(r.status).toBe(200);
    expect(r.text).not.toContain("Pull captains");
    expect(r.text).not.toContain(`${PANEL}/pull-leaders`);
    expect(r.text).not.toContain(`${PANEL}/set-leader`);
    expect(r.text).not.toContain("Make captain");
    expect(r.text).not.toContain('<th scope="col">Captain</th>');
    expect(r.text).not.toContain("kb-crown");
  });

  it("is not on the page for an event without groups or an ended one", async () => {
    store.set(EVENT_ID, makeEvent({ groupsEnabled: false, groups: [] }));
    expect((await call(PANEL)).text).not.toContain(`${PANEL}/set-leader`);
    store.set(EVENT_ID, makeEvent({ state: "ended" }));
    expect((await call(PANEL)).text).not.toContain(`${PANEL}/set-leader`);
  });

  it("switches the pull off with an explanation when the bot cannot move members", async () => {
    botMayMove = false;
    const r = await call(PANEL);
    expect(r.text).toContain("Move Members");
    // Move people… is replaced by a disabled button, so the pull form is not reachable either.
    expect(r.text).not.toContain(`action="${PANEL}/pull-leaders"`);
    expect(r.text).toContain('id="host-board-notes"');
  });

  it("does not show a stored captain who is no longer a member as a leader", async () => {
    groupOf("g_heli").memberIds = [BEN];
    const r = await call(PANEL);
    // Heli's stored captain is not in its member list now: nobody in Heli's column leads.
    const col = r.text.slice(r.text.indexOf('data-group="g_heli"'));
    const heli = col.slice(0, col.indexOf("</section>"));
    expect(heli).not.toContain("kb-crown");
    expect(heli).not.toContain("Remove as captain");
    expect(heli).toContain("Make captain");
  });
});

describe("set-leader", () => {
  it("makes a member the leader, audits it, and shows it", async () => {
    groupOf("g_heli").captainId = null;
    const r = await post("set-leader", { group: "g_heli", userId: BEN });
    expect(r.status).toBe(303);
    const flash = flashOf(r.location);
    expect(flash.type).toBe("ok");
    expect(flash.msg).toContain("is now the captain of Heli <i>");
    expect(groupOf("g_heli").captainId).toBe(BEN);
    const row = auditRows.at(-1) as Json;
    expect(row.action).toBe("event.host.set-leader");
    expect(row.result).toBe("success");
    expect(JSON.stringify(row.details)).toContain(BEN);
  });

  it("passes the member-reset ticket the gate took before its first await, not a new one", async () => {
    groupOf("g_heli").captainId = null;
    await post("set-leader", { group: "g_heli", userId: BEN });
    expect(tickets).toEqual([1]);
    expect(writeTickets).toEqual([1]);
  });

  it("clears the leader with an empty person", async () => {
    const r = await post("set-leader", { group: "g_heli", userId: "" });
    const flash = flashOf(r.location);
    expect(flash.type).toBe("ok");
    expect(flash.msg).toContain("no longer has a captain");
    expect(groupOf("g_heli").captainId).toBeNull();
  });

  it("refuses a person who is not in the group, an open group and bad input, each audited as a failure", async () => {
    groupOf("g_heli").captainId = null;
    for (const body of [
      { group: "g_heli", userId: CAL },
      { group: "g_open", userId: BEN },
      { group: "g_leads", userId: BEN },
      { group: "nope", userId: BEN },
      { group: "", userId: BEN },
      { group: "g_heli", userId: "not-an-id" },
    ]) {
      const flash = flashOf((await post("set-leader", body)).location);
      expect(flash.type).toBe("err");
    }
    expect(groupOf("g_heli").captainId).toBeNull();
    expect((auditRows.at(-2) as Json).result).toBe("failure");
  });

  it("refuses while leaders are off or events are off", async () => {
    groupOf("g_heli").captainId = null;
    doc().captainsEnabled = false;
    expect(
      flashOf(
        (await post("set-leader", { group: "g_heli", userId: BEN })).location,
      ).msg,
    ).toContain("not switched on");
    doc().captainsEnabled = true;
    eventsEnabled = false;
    expect(
      flashOf(
        (await post("set-leader", { group: "g_heli", userId: BEN })).location,
      ).msg,
    ).toContain("events.enabled");
    expect(groupOf("g_heli").captainId).toBeNull();
  });

  it("is refused without CSRF, for a non-host, and for an ended event", async () => {
    const body = { group: "g_heli", userId: BEN };
    expect((await post("set-leader", body, { csrf: false })).status).toBe(403);
    sessionUser = OTHER;
    expect((await post("set-leader", body)).status).toBe(403);
    sessionUser = CREATOR;
    doc().state = "ended";
    expect(flashOf((await post("set-leader", body)).location).type).toBe("err");
    expect(groupOf("g_heli").captainId).toBe(ANA);
  });

  it("takes the unassign through the real hook: unassigning the leader on the panel ends the role", async () => {
    const r = await post("unassign", { userId: ANA });
    expect(flashOf(r.location).type).toBe("ok");
    await settle();
    expect(groupOf("g_heli").memberIds).toEqual([BEN]);
    expect(groupOf("g_heli").captainId).toBeNull();
    expect(groupOf("g_logi").captainId).toBe(CAL);
  });
});

describe("leader-label", () => {
  it("renames what leaders are called and audits it", async () => {
    const r = await post("leader-label", { label: "  Squad   Lead " });
    expect(flashOf(r.location).msg).toContain('"Squad Lead"');
    expect(doc().leaderLabel).toBe("Squad Lead");
    expect((auditRows.at(-1) as Json).action).toBe("event.host.leader-label");
    expect((await call(PANEL)).text).toContain("Pull squad leads only");
  });

  it("escapes the label wherever it is shown", async () => {
    await post("leader-label", { label: "A<b>" });
    expect(doc().leaderLabel).toBe("A<b>");
    const page = (await call(PANEL)).text;
    expect(page).toContain("A&lt;b&gt;");
    expect(page).not.toContain("A<b>");
    expect(page).toContain('value="A&lt;b&gt;"');
  });

  it("an empty name goes back to the default; a too long one is refused", async () => {
    await post("leader-label", { label: "" });
    expect(doc().leaderLabel).toBe("Leader");
    const flash = flashOf(
      (await post("leader-label", { label: "x".repeat(21) })).location,
    );
    expect(flash.type).toBe("err");
    expect(doc().leaderLabel).toBe("Leader");
  });

  it("is refused while leaders are off", async () => {
    doc().captainsEnabled = false;
    const flash = flashOf(
      (await post("leader-label", { label: "Boss" })).location,
    );
    expect(flash.type).toBe("err");
    expect(doc().leaderLabel).toBe("Captain");
  });
});

describe("pull-leaders", () => {
  it("moves every connected leader to the leads channel by default, nobody else, never the host, and audits counts only", async () => {
    const r = await post("pull-leaders", { to: "default" });
    const flash = flashOf(r.location);
    expect(flash.type).toBe("ok");
    expect(flash.msg).toMatch(/^Moved 2\./);
    expect(patched().sort((a, b) => a.user.localeCompare(b.user))).toEqual([
      { user: ANA, to: CH_LEADS },
      { user: CAL, to: CH_LEADS },
    ]);
    // Everyone else stays put.
    expect(voice.get(BEN)).toBe(MAIN);
    expect(voice.get(CREATOR)).toBe(MAIN);
    const row = auditRows.at(-1) as Json;
    expect(row.action).toBe("event.host.pull-leaders");
    expect(row.result).toBe("success");
    const details = JSON.stringify(row.details);
    expect(details).toContain('"moved":2');
    expect(details).toContain('"destination":"default"');
    expect(details).not.toContain(ANA);
  });

  it("falls back to the main channel when the event has no leads channel", async () => {
    const d = doc();
    d.groups = d.groups.filter((g) => g.kind !== "leads");
    voice.set(ANA, CH_HELI);
    await post("pull-leaders", { to: "default" });
    expect(patched().sort((a, b) => a.user.localeCompare(b.user))).toEqual([
      { user: ANA, to: MAIN },
      { user: CAL, to: MAIN },
    ]);
  });

  it("can aim at the main channel, a group's channel or the channel the host is in", async () => {
    await post("pull-leaders", { to: "main" });
    expect(patched().every((p) => p.to === MAIN)).toBe(true);
    patch.mockClear();
    voice.set(CREATOR, CH_OPEN);
    voice.set(ANA, MAIN);
    voice.set(CAL, CH_LOGI);
    await post("pull-leaders", { to: "here" });
    expect(patched().every((p) => p.to === CH_OPEN)).toBe(true);
    patch.mockClear();
    voice.set(ANA, MAIN);
    voice.set(CAL, CH_LOGI);
    await post("pull-leaders", { to: "g_heli" });
    expect(patched().every((p) => p.to === CH_HELI)).toBe(true);
  });

  it("skips and reports a leader who is not connected, in one flash", async () => {
    voice.set(CAL, null);
    voice.set(ANA, CH_HELI);
    const flash = flashOf(
      (await post("pull-leaders", { to: "main" })).location,
    );
    expect(flash.type).toBe("ok");
    expect(flash.msg).toMatch(/^Moved 1\./);
    expect(flash.msg).toContain("1 not connected to voice");
    expect(patched()).toEqual([{ user: ANA, to: MAIN }]);
  });

  it("never force-moves the host, even a host who is a leader", async () => {
    const d = doc();
    d.groups[0].memberIds = [ANA, BEN, CREATOR];
    d.groups[0].captainId = CREATOR;
    voice.set(CREATOR, CH_HELI);
    const flash = flashOf(
      (await post("pull-leaders", { to: "main" })).location,
    );
    expect(flash.msg).toContain("the host (never moved by a group action)");
    expect(patched().map((p) => p.user)).toEqual([CAL]);
    expect(voice.get(CREATOR)).toBe(CH_HELI);
  });

  it("refuses with leaders off on the fresh row, with no leader, and while events are off", async () => {
    doc().captainsEnabled = false;
    expect(
      flashOf((await post("pull-leaders", { to: "main" })).location).msg,
    ).toContain("not switched on");
    doc().captainsEnabled = true;
    doc().groups.forEach((g) => (g.captainId = null));
    expect(
      flashOf((await post("pull-leaders", { to: "main" })).location).msg,
    ).toContain("no captains yet");
    store.set(EVENT_ID, makeEvent());
    eventsEnabled = false;
    expect(
      flashOf((await post("pull-leaders", { to: "main" })).location).msg,
    ).toContain("events.enabled");
    expect(patch).not.toHaveBeenCalled();
  });

  it("refuses without Move Members, a raw channel id, an unknown key and an empty choice", async () => {
    botMayMove = false;
    expect(
      flashOf((await post("pull-leaders", { to: "main" })).location).msg,
    ).toContain("Move Members");
    botMayMove = true;
    for (const to of [CH_LEADS, "nope", "", " g_leads "]) {
      expect(flashOf((await post("pull-leaders", { to })).location).type).toBe(
        "err",
      );
    }
    expect(patch).not.toHaveBeenCalled();
  });

  it("answers 'already in progress' to a second pull while a run is going", async () => {
    let release: () => void = () => undefined;
    patchGate = new Promise<void>((resolve) => (release = resolve));
    const reached = new Promise<void>((resolve) => (patchReached = resolve));
    const first = post("pull-leaders", { to: "main" });
    await reached;
    const second = flashOf(
      (await post("pull-leaders", { to: "main" })).location,
    );
    expect(second.type).toBe("err");
    expect(second.msg).toContain("already in progress");
    release();
    expect(flashOf((await first).location).type).toBe("ok");
  });

  it("is refused without CSRF, for a non-host and for an ended event", async () => {
    expect(
      (await post("pull-leaders", { to: "main" }, { csrf: false })).status,
    ).toBe(403);
    sessionUser = OTHER;
    expect((await post("pull-leaders", { to: "main" })).status).toBe(403);
    sessionUser = CREATOR;
    doc().state = "ended";
    expect(
      flashOf((await post("pull-leaders", { to: "main" })).location).type,
    ).toBe("err");
    expect(patch).not.toHaveBeenCalled();
  });

  it("a pull never changes anyone's group or leadership: a leader pulled into another team's channel stays assigned and stays leader", async () => {
    const before = JSON.stringify(doc().groups);
    // The real self-join sees each voice join (the PATCH mock replays it); the
    // host-move mark makes it ignore the join.
    await post("pull-leaders", { to: "g_logi" });
    await settle();
    expect(patched().map((p) => p.user)).toEqual([ANA]);
    expect(voice.get(ANA)).toBe(CH_LOGI);
    expect(JSON.stringify(doc().groups)).toBe(before);
    expect(groupOf("g_heli").memberIds).toContain(ANA);
    expect(groupOf("g_heli").captainId).toBe(ANA);
  });

  describe("interleaved with an unassign (delayed reads)", () => {
    it("a leader unassigned before the pull's fresh read is not moved", async () => {
      let release: () => void = () => undefined;
      fake.gateFindById = new Promise<void>((resolve) => (release = resolve));
      const realFindById = EventMock.findById;
      let reached: () => void = () => undefined;
      const atRead = new Promise<void>((resolve) => (reached = resolve));
      EventMock.findById = ((id: string) => ({
        lean: async () => {
          reached();
          return realFindById(id).lean();
        },
      })) as typeof EventMock.findById;
      try {
        // Only ANA is a leader, so the pull has exactly one wish to lose.
        groupOf("g_logi").captainId = null;
        const pull = post("pull-leaders", { to: "main" });
        await atRead;
        // The host unassigns the leader while the pull waits for its read.
        const un = await post("unassign", { userId: ANA });
        expect(flashOf(un.location).type).toBe("ok");
        await settle();
        release();
        const flash = flashOf((await pull).location);
        expect(patch).not.toHaveBeenCalled();
        expect(flash.type).toBe("err");
        expect(flash.msg).toContain("no captains yet");
        expect(voice.get(ANA)).toBe(MAIN);
      } finally {
        EventMock.findById = realFindById;
        fake.gateFindById = null;
      }
    });

    it("a leader unassigned after the pull planned is still moved once, the unassign and the clear both land, and the move does not put them back", async () => {
      let release: () => void = () => undefined;
      patchGate = new Promise<void>((resolve) => (release = resolve));
      const reached = new Promise<void>((resolve) => (patchReached = resolve));
      groupOf("g_logi").captainId = null;
      const pull = post("pull-leaders", { to: "g_logi" });
      await reached;
      // The pull holds the move lock and is waiting on Discord: assignment and
      // the leader hook must not wait for it.
      const un = await post("unassign", { userId: ANA });
      expect(flashOf(un.location).type).toBe("ok");
      await settle();
      expect(groupOf("g_heli").memberIds).toEqual([BEN]);
      expect(groupOf("g_heli").captainId).toBeNull();
      release();
      const flash = flashOf((await pull).location);
      await settle();
      expect(flash.msg).toMatch(/^Moved 1\./);
      expect(voice.get(ANA)).toBe(CH_LOGI);
      // Being moved into Logi's channel recorded nothing: still unassigned.
      expect(groupOf("g_logi").memberIds).not.toContain(ANA);
      expect(groupOf("g_heli").memberIds).not.toContain(ANA);
    });
  });
});
