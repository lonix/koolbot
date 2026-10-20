/**
 * The leaders and tags fields of the host panel's Live settings, over real HTTP
 * (#1240): real Express, session, CSRF and host gate, the real live-edit
 * executor and rows. Stubbed: the session row, the permission check, the audit
 * write, the config values, the event service (its lookups and the two Discord
 * passes the follow-ups call), the nickname tag service, and the Event model (an
 * in-memory stand-in that throws on any shape the rows do not write).
 *
 * Every POST is checked for exactly ONE audit row.
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
import {
  lstore,
  lwrites,
  lclone,
  LEventMock,
  type Doc,
} from "../services/event-live-leaders-fake-event.js";

jest.unstable_mockModule("../../src/models/event.js", () => ({
  Event: LEventMock,
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
const { EventNicknameTags } =
  await import("../../src/services/event-nickname-tags.js");
const { ConfigService } = await import("../../src/services/config-service.js");
const { WebAuditLog } = await import("../../src/models/web-audit-log.js");
const { resetMoveGuardForTests } =
  await import("../../src/services/event-move-guard.js");

const SECRET = "test-secret-for-host-leaders-tags-routes";
const GUILD = "guild-1";
const CREATOR = "111111111111111111";
const OTHER = "222222222222222222";
const EVENT_ID = "65a000000000000000000001";
const RED = "g_00000001";
const BLUE = "g_00000002";
const panel = (): string => `/me/events/${EVENT_ID}/host`;

function makeEvent(over: Doc = {}): Doc {
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
    channelId: null,
    recurrence: "none",
    seriesId: null,
    groupsEnabled: true,
    groupLabel: "Squad",
    leaderLabel: "Leader",
    captainsEnabled: false,
    captainCustomisationEnabled: false,
    tagsEnabled: false,
    tagsSuffix: false,
    groups: [
      {
        key: RED,
        name: "Red <b>x</b>",
        kind: "team",
        size: null,
        tag: "RED",
        marker: "",
        channelId: null,
        captainId: null,
        memberIds: ["u1"],
      },
      {
        key: BLUE,
        name: "Blue",
        kind: "team",
        size: null,
        tag: "",
        marker: "",
        channelId: null,
        captainId: null,
        memberIds: [],
      },
    ],
    ...over,
  };
}

let auditRows: Array<Record<string, unknown>> = [];
let eventsEnabled = true;
let sessionUser = CREATOR;
let leadsPasses: string[] = [];
let controlPasses: string[] = [];
let tagPasses: string[] = [];
let server: Server;
let base = "";

function fakeClient(): never {
  return {
    guilds: {
      cache: {
        get: () => ({
          channels: { cache: { get: () => undefined } },
          members: { cache: { get: () => undefined } },
        }),
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
  init: { method?: string; user?: string; csrf?: boolean; body?: Doc } = {},
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

const save = (body: Doc, init: Doc = {}) =>
  call(`${panel()}/settings`, { method: "POST", body, ...init });
const stored = (): Doc => lstore.get(EVENT_ID) as Doc;
const groupOf = (key: string): Doc =>
  (stored().groups as Doc[]).find((g) => g.key === key) as Doc;

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
  lstore.clear();
  lstore.set(EVENT_ID, makeEvent());
  lwrites.length = 0;
  auditRows = [];
  eventsEnabled = true;
  sessionUser = CREATOR;
  leadsPasses = [];
  controlPasses = [];
  tagPasses = [];
  resetMoveGuardForTests();

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
    getEvent: async (id: string) => {
      const doc = lstore.get(id);
      return doc ? lclone(doc) : null;
    },
    getGroupChannelReport: () => null,
    isEventBeingEnded: () => false,
    syncLeadsAccess: async (_g: string, id: string) => {
      leadsPasses.push(id);
    },
    syncGroupControls: async (id: string) => {
      controlPasses.push(id);
    },
  } as never);
  jest.spyOn(EventNicknameTags, "getInstance").mockReturnValue({
    syncEvent: async (_g: string, id: string) => {
      tagPasses.push(`sync:${id}`);
    },
    restoreEvent: async (_g: string, id: string) => {
      tagPasses.push(`restore:${id}`);
      return { restored: 0, kept: 0, warnings: [] };
    },
    requestSweep: () => undefined,
    getReport: () => null,
  } as never);
  jest.spyOn(ConfigService, "getInstance").mockReturnValue({
    getBoolean: async (key: string) =>
      key === "events.enabled" && eventsEnabled,
    getNumberStrict: async (_k: string, f: number) => f,
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

describe("the leaders and tags fields in the Live settings section", () => {
  it("shows each switch with its stored value as the base, and one input per team tag", async () => {
    lstore.set(
      EVENT_ID,
      makeEvent({ captainsEnabled: true, tagsEnabled: true, tagsSuffix: true }),
    );
    const r = await call(panel());
    expect(r.status).toBe(200);
    expect(r.text).toContain('name="b_captainsEnabled" value="1"');
    expect(r.text).toContain('name="b_captainCustomisationEnabled" value="0"');
    expect(r.text).toContain('name="b_tagsEnabled" value="1"');
    expect(r.text).toContain('name="b_tagsSuffix" value="1"');
    expect(r.text).toContain('name="b_leaderLabel" value="Leader"');
    expect(r.text).toContain(`name="s_groupTags_${RED}" value="RED"`);
    expect(r.text).toContain(`name="s_groupTags_${BLUE}" value=""`);
    expect(r.text).toContain("Red &lt;b&gt;x&lt;/b&gt;");
  });

  it("has no leaders and tags fields for an event without groups", async () => {
    lstore.set(EVENT_ID, makeEvent({ groupsEnabled: false, groups: [] }));
    const r = await call(panel());
    expect(r.text).not.toContain('name="s_captainsEnabled"');
    expect(r.text).not.toContain("s_groupTags_");
  });

  it("the Leaders section appears with leaders on and is gone with leaders off", async () => {
    expect((await call(panel())).text).not.toContain('id="host-leaders"');
    await save({ s_captainsEnabled: "1", b_captainsEnabled: "0" });
    expect((await call(panel())).text).toContain('id="host-leaders"');
    await save({ s_captainsEnabled: "0", b_captainsEnabled: "1" });
    expect((await call(panel())).text).not.toContain('id="host-leaders"');
  });
});

describe("saving leaders and tags: one result, one audit row", () => {
  it("leaders on: stored, both passes asked once, one audit row", async () => {
    const r = await save({ s_captainsEnabled: "1", b_captainsEnabled: "0" });
    expect(r.status).toBe(303);
    expect(flashOf(r.location)).toEqual({
      type: "ok",
      msg: "Saved: Leaders is now on.",
    });
    expect(stored().captainsEnabled).toBe(true);
    expect(leadsPasses).toEqual([EVENT_ID]);
    expect(controlPasses).toEqual([EVENT_ID]);
    expect(auditRows).toHaveLength(1);
    expect(auditRows[0]).toMatchObject({
      action: "event.host.settings",
      targetId: EVENT_ID,
      result: "success",
      details: {
        outcome: "applied",
        changes: [{ row: "captainsEnabled", from: false, to: true }],
      },
    });
  });

  it("leaders off keeps the stored leader and asks for the passes that remove access", async () => {
    lstore.set(EVENT_ID, makeEvent({ captainsEnabled: true }));
    groupOf(RED).captainId = "u1";
    await save({ s_captainsEnabled: "0", b_captainsEnabled: "1" });
    expect(stored().captainsEnabled).toBe(false);
    expect(groupOf(RED).captainId).toBe("u1");
    expect(leadsPasses).toEqual([EVENT_ID]);
    expect(controlPasses).toEqual([EVENT_ID]);
  });

  it("tagging on and a changed tag in one form: stored, one nickname pass, the text says nicknames follow", async () => {
    const r = await save({
      s_tagsEnabled: "1",
      b_tagsEnabled: "0",
      [`s_groupTags_${RED}`]: "SKY",
      [`b_groupTags_${RED}`]: "RED",
      [`s_groupTags_${BLUE}`]: "",
      [`b_groupTags_${BLUE}`]: "",
    });
    expect(flashOf(r.location).type).toBe("ok");
    expect(flashOf(r.location).msg).toBe(
      'Saved: Clan tags on nicknames is now on (nicknames follow in the background); Team tags is now tags "SKY" (nicknames follow in the background).',
    );
    expect(stored().tagsEnabled).toBe(true);
    expect(groupOf(RED).tag).toBe("SKY");
    expect(tagPasses).toEqual([`sync:${EVENT_ID}`]);
    expect(auditRows).toHaveLength(1);
    expect(auditRows[0].details).toMatchObject({ outcome: "applied" });
  });

  it("tagging off asks for a restore", async () => {
    lstore.set(EVENT_ID, makeEvent({ tagsEnabled: true }));
    await save({ s_tagsEnabled: "0", b_tagsEnabled: "1" });
    expect(tagPasses).toEqual([`restore:${EVENT_ID}`]);
  });

  it("saving the same form again is 'nothing to change': no write, no pass, still one audit row", async () => {
    const form = { s_captainsEnabled: "1", b_captainsEnabled: "0" };
    await save(form);
    auditRows = [];
    leadsPasses = [];
    controlPasses = [];
    lwrites.length = 0;
    const r = await save(form);
    expect(flashOf(r.location).msg).toBe(
      "Nothing to change: the event already has these settings.",
    );
    expect(lwrites).toEqual([]);
    expect(leadsPasses).toEqual([]);
    expect(auditRows).toHaveLength(1);
    expect(auditRows[0].details).toMatchObject({ outcome: "nothing-to-do" });
  });

  it("an unchanged form (every value equals its base) writes and runs nothing", async () => {
    await save({
      s_captainsEnabled: "0",
      b_captainsEnabled: "0",
      s_leaderLabel: "Leader",
      b_leaderLabel: "Leader",
      [`s_groupTags_${RED}`]: "RED",
      [`b_groupTags_${RED}`]: "RED",
      [`s_groupTags_${BLUE}`]: "",
      [`b_groupTags_${BLUE}`]: "",
    });
    expect(lwrites).toEqual([]);
    expect(leadsPasses).toEqual([]);
    expect(tagPasses).toEqual([]);
    expect(auditRows).toHaveLength(1);
  });

  it("a tag over the limit changes nothing, names the team and is one failed audit row", async () => {
    const r = await save({
      [`s_groupTags_${RED}`]: "WAYTOOLONGTAG",
      [`b_groupTags_${RED}`]: "RED",
      [`s_groupTags_${BLUE}`]: "",
      [`b_groupTags_${BLUE}`]: "",
    });
    expect(flashOf(r.location).type).toBe("err");
    expect(flashOf(r.location).msg).toContain(
      "Red <b>x</b>: at most 8 characters",
    );
    expect(groupOf(RED).tag).toBe("RED");
    expect(auditRows).toHaveLength(1);
    expect(auditRows[0]).toMatchObject({ result: "failure" });
  });

  it("a value posted without its base is refused as an out-of-date form", async () => {
    const r = await save({ s_tagsEnabled: "1" });
    expect(flashOf(r.location).msg).toContain("the form is out of date");
    expect(lwrites).toEqual([]);
  });

  it("a stale form cannot turn leaders back off after somebody else changed them", async () => {
    lstore.set(EVENT_ID, makeEvent({ captainsEnabled: true }));
    // The form showed "off" and asks for "on" (the host did not mean to undo anything).
    const r = await save({ s_captainsEnabled: "0", b_captainsEnabled: "0" });
    expect(flashOf(r.location).msg).toContain("Nothing to change");
    expect(stored().captainsEnabled).toBe(true);
  });

  it("is refused with one failed audit row while events.enabled is off", async () => {
    eventsEnabled = false;
    const r = await save({ s_captainsEnabled: "1", b_captainsEnabled: "0" });
    expect(flashOf(r.location)).toMatchObject({
      type: "err",
      msg: expect.stringContaining("Events are turned off"),
    });
    expect(auditRows).toHaveLength(1);
    expect(lwrites).toEqual([]);
    expect(leadsPasses).toEqual([]);
  });

  it("is refused without a CSRF token and for somebody who is not the host", async () => {
    const noCsrf = await save(
      { s_captainsEnabled: "1", b_captainsEnabled: "0" },
      { csrf: false },
    );
    expect(noCsrf.status).toBe(403);
    sessionUser = OTHER;
    const stranger = await save({
      s_captainsEnabled: "1",
      b_captainsEnabled: "0",
    });
    expect(stranger.status).toBe(403);
    expect(stored().captainsEnabled).toBe(false);
    expect(auditRows.filter((r) => r.action === "event.host.settings")).toEqual(
      [],
    );
    expect(lwrites).toEqual([]);
  });
});
