/**
 * The host panel's "Assign people" section and its actions (#1191), over real
 * HTTP: real Express, the real session middleware, the real CSRF check and the
 * real host gate (#1189). Stubbed: the session row, the permission check, the
 * event lookup, the audit write, the Discord voice cache (a plain object) and
 * the membership service (its rules have their own tests, in
 * `event-group-assignment.test.ts`; here we check what the routes ask of it).
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

type Json = Record<string, unknown>;

const assignMember = jest.fn<(opts: Json) => Promise<Json>>();
const randomiseMembers = jest.fn<(opts: Json) => Promise<Json>>();
const setGroupsLocked = jest.fn<(opts: Json) => Promise<Json>>();

jest.unstable_mockModule(
  "../../src/services/event-group-assignment.js",
  () => ({
    assignMember: (o: Json) => assignMember(o),
    randomiseMembers: (o: Json) => randomiseMembers(o),
    setGroupsLocked: (o: Json) => setGroupsLocked(o),
  // Imported by modules on the same import path; not used by these routes.
  removeMemberFromEvents: async () => ({ matched: 0, removed: 0, failed: 0 }),
  handleGroupSelfJoin: async () => "no-event",
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

const SECRET = "test-secret-for-host-assignment-routes";
const GUILD = "guild-1";
const CREATOR = "creator-1";
const OTHER = "other-1";
const EVENT_ID = "65a000000000000000000001";
const PANEL = `/me/events/${EVENT_ID}/host`;

// Discord-like ids (the forms only accept digits).
const ANA = "111111111111111111";
const BEN = "222222222222222222";
const CAL = "333333333333333333";
const BOT = "999999999999999999";
const AWAY = "444444444444444444";

interface FakeGroup {
  key: string;
  name: string;
  kind: string;
  size: number | null;
  tag: string;
  marker: string;
  channelId: string | null;
  captainId: string | null;
  memberIds: string[];
}

function team(key: string, name: string, over: Partial<FakeGroup> = {}) {
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
  } as FakeGroup;
}

function makeEvent(over: Json = {}): Json {
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
    channelId: "ch-main",
    recurrence: "none",
    seriesId: null,
    groupsEnabled: true,
    groupLabel: "Squad",
    leaderLabel: "Leader",
    channelLeadMinutes: null,
    groupsLocked: false,
    groups: [
      team("g_heli", "Heli", { size: 2, memberIds: [ANA] }),
      team("g_logi", "Logi"),
      team("g_spec", "Spectators", { kind: "open" }),
    ],
    ...over,
  };
}

let events: Record<string, Json> = {};
let auditRows: Array<Record<string, unknown>> = [];
let voice: Map<
  string,
  Array<{ id: string; name: string; bot?: boolean }>
> = new Map();
let guildInCache = true;
let server: Server;
let base = "";

function fakeClient(): never {
  const channel = (id: string): unknown => {
    const people = voice.get(id);
    if (!people) return undefined;
    return {
      isVoiceBased: () => true,
      members: new Map(
        people.map((p) => [
          p.id,
          { id: p.id, displayName: p.name, user: { bot: !!p.bot } },
        ]),
      ),
    };
  };
  return {
    guilds: {
      cache: {
        get: (id: string) =>
          guildInCache && id === GUILD
            ? {
                channels: { cache: { get: channel } },
                members: { cache: { get: () => undefined } },
              }
            : undefined,
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
      cookie: cookie(init.user ?? CREATOR),
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

const post = (action: string, body: Json, init: Json = {}) =>
  call(`${PANEL}/${action}`, { method: "POST", body, ...init });

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
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

beforeEach(() => {
  process.env.WEBUI_SESSION_SECRET = SECRET;
  process.env.GUILD_ID = GUILD;
  (WebSessionService as unknown as { instance: unknown }).instance = null;
  events = { [EVENT_ID]: makeEvent() };
  auditRows = [];
  guildInCache = true;
  voice = new Map([
    [
      "ch-main",
      [
        { id: ANA, name: "Ana" },
        { id: BEN, name: "Ben <b>x</b>" },
        { id: BOT, name: "Bot", bot: true },
      ],
    ],
  ]);
  assignMember.mockReset().mockResolvedValue({
    ok: true,
    changed: true,
    fromKey: null,
    toKey: "g_logi",
  });
  randomiseMembers.mockReset().mockResolvedValue({
    ok: true,
    placed: [
      { userId: ANA, groupKey: "g_heli" },
      { userId: BEN, groupKey: "g_logi" },
    ],
    unplaced: [],
  });
  setGroupsLocked.mockReset().mockResolvedValue({ ok: true });

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
  jest.spyOn(EventService, "getInstance").mockReturnValue({
    getEvent: async (id: string) => events[id] ?? null,
  } as never);
  jest.spyOn(ConfigService, "getInstance").mockReturnValue({
    getBoolean: async () => false,
    getNumber: async (_k: string, f: number) => f,
    getString: async (_k: string, f: string) => f,
  } as never);
  jest.spyOn(WebAuditLog, "create").mockImplementation(async (row: unknown) => {
    auditRows.push(row as Record<string, unknown>);
    return {} as never;
  });
});

let sessionUser = CREATOR;
// `call` picks the cookie user; keep the stubbed session row in step.
const asUser = (u: string): void => {
  sessionUser = u;
};

afterEach(() => {
  asUser(CREATOR);
  jest.restoreAllMocks();
});

describe("the assignment section", () => {
  it("lists connected people (bots left out) with their group and each group's fill", async () => {
    const r = await call(PANEL);
    expect(r.status).toBe(200);
    expect(r.text).toContain('id="host-assignment"');
    expect(r.text).not.toContain("let them pick one, or randomise. Not available yet");
    // Heli has Ana: 1 of 2. Logi has no size: just a count.
    expect(r.text).toContain('Heli</strong> <span class="mono">1/2</span>');
    expect(r.text).toContain('Logi</strong> <span class="mono">0</span>');
    expect(r.text).toContain("Ana");
    expect(r.text).not.toContain(">Bot<");
    // Names are escaped.
    expect(r.text).toContain("Ben &lt;b&gt;x&lt;/b&gt;");
    expect(r.text).not.toContain("Ben <b>x</b>");
    // Open groups take no members: not offered as a target.
    const selects = r.text.match(/<select[\s\S]*?<\/select>/g) ?? [];
    expect(selects.length).toBeGreaterThan(0);
    for (const s of selects) expect(s).not.toContain("Spectators");
  });

  it("offers a full group as disabled, except to its own members", async () => {
    events[EVENT_ID] = makeEvent({
      groups: [
        team("g_heli", "Heli", { size: 1, memberIds: [ANA] }),
        team("g_logi", "Logi"),
      ],
    });
    const r = await call(PANEL);
    const benRow =
      r.text.split("<tr>").find((row) => row.includes("Ben")) ?? "";
    expect(benRow).toMatch(
      /<option value="g_heli" disabled>Heli \(1\/1, full\)/,
    );
    const anaRow =
      r.text.split("<tr>").find((row) => row.includes("Ana")) ?? "";
    expect(anaRow).toMatch(/<option value="g_heli" selected>/);
  });

  it("still lists an assigned member who left voice, so they can be unassigned", async () => {
    events[EVENT_ID] = makeEvent({
      groups: [team("g_heli", "Heli", { memberIds: [AWAY] })],
    });
    const r = await call(PANEL);
    expect(r.text).toContain("Not connected");
    expect(r.text).toContain(`name="userId" value="${AWAY}"`);
    expect(r.text).toContain(">Unassign<");
  });

  it("shows the lock state and the randomise form", async () => {
    const open = await call(PANEL);
    expect(open.text).toContain("Lock groups");
    expect(open.text).toContain('name="locked" value="1"');
    expect(open.text).toContain('name="mode" value="unassigned" checked');
    events[EVENT_ID] = makeEvent({ groupsLocked: true });
    const locked = await call(PANEL);
    expect(locked.text).toContain("Unlock groups");
    expect(locked.text).toContain('name="locked" value="0"');
  });

  it("turns assigning off, with a notice, when the voice state cannot be read", async () => {
    guildInCache = false;
    const r = await call(PANEL);
    expect(r.status).toBe(200);
    expect(r.text).toContain("could not read who is in the voice channels");
    expect(r.text).not.toContain('action="' + PANEL + '/randomise"');
  });

  it("is absent from an event without groups", async () => {
    events[EVENT_ID] = makeEvent({ groupsEnabled: false, groups: [] });
    const r = await call(PANEL);
    expect(r.text).not.toContain('id="host-assignment"');
  });
});

describe("assign", () => {
  it("assigns a connected person and audits it", async () => {
    const r = await post("assign", { userId: BEN, group: "g_logi" });
    expect(r.status).toBe(303);
    expect(assignMember).toHaveBeenCalledWith({
      guildId: GUILD,
      eventId: EVENT_ID,
      userId: BEN,
      groupKey: "g_logi",
    });
    expect(flashOf(r.location)).toMatchObject({ type: "ok" });
    expect(flashOf(r.location).msg).toContain("is now in Logi");
    const audit = auditRows.find((a) => a.action === "event.host.assign");
    expect(audit).toMatchObject({ targetId: EVENT_ID, result: "success" });
    expect(JSON.stringify(audit)).toContain(BEN);
  });

  it("refuses without the CSRF token, and for someone else's event", async () => {
    expect(
      (await post("assign", { userId: BEN, group: "g_logi" }, { csrf: false }))
        .status,
    ).toBe(403);
    asUser(OTHER);
    expect(
      (await post("assign", { userId: BEN, group: "g_logi" }, { user: OTHER }))
        .status,
    ).toBe(403);
    expect(assignMember).not.toHaveBeenCalled();
  });

  it("refuses a person who is not connected, a malformed id and a missing group", async () => {
    const away = await post("assign", { userId: AWAY, group: "g_logi" });
    expect(flashOf(away.location)).toMatchObject({ type: "err" });
    expect(flashOf(away.location).msg).toContain("not connected");
    const bad = await post("assign", { userId: "not-an-id", group: "g_logi" });
    expect(flashOf(bad.location).type).toBe("err");
    const none = await post("assign", { userId: BEN, group: "" });
    expect(flashOf(none.location).type).toBe("err");
    expect(assignMember).not.toHaveBeenCalled();
    // Refusals are audited as failures too.
    expect(auditRows.filter((a) => a.result === "failure")).toHaveLength(3);
  });

  it("fails closed when the voice state cannot be read", async () => {
    guildInCache = false;
    const r = await post("assign", { userId: BEN, group: "g_logi" });
    expect(flashOf(r.location).type).toBe("err");
    expect(assignMember).not.toHaveBeenCalled();
  });

  it("lets a person who already has a group be moved after they left voice", async () => {
    events[EVENT_ID] = makeEvent({
      groups: [
        team("g_heli", "Heli", { memberIds: [AWAY] }),
        team("g_logi", "Logi"),
      ],
    });
    await post("assign", { userId: AWAY, group: "g_logi" });
    expect(assignMember).toHaveBeenCalledTimes(1);
  });

  it("shows the service's refusal, such as a full group, to the host", async () => {
    assignMember.mockResolvedValue({
      ok: false,
      code: "full",
      message: "That group is full.",
    });
    const r = await post("assign", { userId: BEN, group: "g_heli" });
    expect(flashOf(r.location)).toEqual({
      type: "err",
      msg: "That group is full.",
    });
    expect(
      auditRows.find((a) => a.action === "event.host.assign"),
    ).toMatchObject({
      result: "failure",
    });
  });

  it("refuses to change a finished event", async () => {
    events[EVENT_ID] = makeEvent({ state: "ended" });
    const r = await post("assign", { userId: BEN, group: "g_logi" });
    expect(flashOf(r.location).type).toBe("err");
    expect(assignMember).not.toHaveBeenCalled();
  });
});

describe("unassign", () => {
  it("takes a person out of their group, connected or not", async () => {
    assignMember.mockResolvedValue({
      ok: true,
      changed: true,
      fromKey: "g_heli",
      toKey: null,
    });
    const r = await post("unassign", { userId: AWAY });
    expect(assignMember).toHaveBeenCalledWith({
      guildId: GUILD,
      eventId: EVENT_ID,
      userId: AWAY,
      groupKey: null,
    });
    expect(flashOf(r.location).type).toBe("ok");
    expect(auditRows.some((a) => a.action === "event.host.unassign")).toBe(
      true,
    );
  });

  it("works without voice state (the cache being unreadable does not trap anyone)", async () => {
    guildInCache = false;
    await post("unassign", { userId: AWAY });
    expect(assignMember).toHaveBeenCalledTimes(1);
  });
});

describe("randomise", () => {
  it("deals the connected people (not bots) and audits one row with counts and the seed", async () => {
    const r = await post("randomise", { mode: "everyone" });
    expect(randomiseMembers).toHaveBeenCalledTimes(1);
    const arg = randomiseMembers.mock.calls[0][0] as Json;
    expect(arg).toMatchObject({
      guildId: GUILD,
      eventId: EVENT_ID,
      mode: "everyone",
    });
    expect([...(arg.candidateIds as string[])].sort()).toEqual(
      [ANA, BEN].sort(),
    );
    expect(typeof arg.seed).toBe("number");
    expect(flashOf(r.location).msg).toContain("Placed 2 people");
    const rows = auditRows.filter((a) => a.action === "event.host.randomise");
    expect(rows).toHaveLength(1);
    const details = JSON.stringify(rows[0]);
    expect(details).toContain('"placed":2');
    expect(details).toContain('"seed"');
    // Counts, not names.
    expect(details).not.toContain(ANA);
    expect(details).not.toContain("Ben");
  });

  it("lists who did not fit, by display name", async () => {
    randomiseMembers.mockResolvedValue({
      ok: true,
      placed: [{ userId: ANA, groupKey: "g_heli" }],
      unplaced: [BEN],
    });
    const r = await post("randomise", { mode: "unassigned" });
    const { msg } = flashOf(r.location);
    expect(msg).toContain("1 did not fit");
    expect(msg).toContain("Ben <b>x</b>");
  });

  it("refuses an unknown mode, an empty room and an unreadable voice state", async () => {
    expect(
      flashOf((await post("randomise", { mode: "all" })).location).type,
    ).toBe("err");
    expect(flashOf((await post("randomise", {})).location).type).toBe("err");
    voice.set("ch-main", []);
    expect(
      flashOf((await post("randomise", { mode: "everyone" })).location).msg,
    ).toContain("Nobody is connected");
    guildInCache = false;
    expect(
      flashOf((await post("randomise", { mode: "everyone" })).location).type,
    ).toBe("err");
    expect(randomiseMembers).not.toHaveBeenCalled();
  });
});

describe("lock", () => {
  it("locks and unlocks to the posted state", async () => {
    await post("lock", { locked: "1" });
    expect(setGroupsLocked).toHaveBeenLastCalledWith({
      guildId: GUILD,
      eventId: EVENT_ID,
      locked: true,
    });
    await post("lock", { locked: "0" });
    expect(setGroupsLocked).toHaveBeenLastCalledWith({
      guildId: GUILD,
      eventId: EVENT_ID,
      locked: false,
    });
    expect(
      auditRows.filter((a) => a.action === "event.host.lock"),
    ).toHaveLength(2);
  });

  it("refuses anything that is not 1 or 0", async () => {
    const r = await post("lock", { locked: "toggle" });
    expect(flashOf(r.location).type).toBe("err");
    expect(setGroupsLocked).not.toHaveBeenCalled();
  });
});
