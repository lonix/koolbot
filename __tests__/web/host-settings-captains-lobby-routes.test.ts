/**
 * The Captains lobby switch on the host panel's Live settings section (#1251)
 * over real HTTP, like `host-settings-group-set-routes.test.ts`: real Express,
 * the real session middleware, the real CSRF check, the real host gate, the
 * real live-edit core and the lobby row. Stubbed: the session row, the
 * permission check, the audit write, the config values, the event service's
 * lookups and channel passes, the nickname service, and the Event model (the
 * in-memory stand-in of `event-live-edit-groups-fake-event.ts`).
 *
 * It proves the field naming (the switch's fields reach the row), what the page
 * shows and hides (the lobby group is not in any group list; the positional ids
 * of the groups after it do not move), the confirmation round trip of turning
 * it off, and that every POST is exactly ONE audit row.
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
  store,
  writes,
  fake,
  SETTABLE,
  clone,
  EventMock,
  type Json,
} from "../services/event-live-edit-groups-fake-event.js";

jest.unstable_mockModule("../../src/models/event.js", () => ({
  Event: EventMock,
  EVENT_RECURRENCES: ["none", "weekly", "biweekly", "monthly"],
}));

type Catalog =
  import("../../src/services/event-group-preset-service.js").PresetCatalog;
const catalog: Catalog = { entries: [], state: "ok" };
const presetActual =
  await import("../../src/services/event-group-preset-service.js");
jest.unstable_mockModule(
  "../../src/services/event-group-preset-service.js",
  () => ({ ...presetActual, loadPresetCatalog: async () => catalog }),
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
const { EventNicknameTags } =
  await import("../../src/services/event-nickname-tags.js");
const { ConfigService } = await import("../../src/services/config-service.js");
const { WebAuditLog } = await import("../../src/models/web-audit-log.js");
const { resetMoveGuardForTests } =
  await import("../../src/services/event-move-guard.js");

const SECRET = "test-secret-for-host-settings-captains-lobby";
const GUILD = "guild-1";
const CREATOR = "111111111111111111";
const EVENT_ID = "65a000000000000000000001";
const A = "g_00000001";
const B = "g_00000002";
const LOBBY = "g_000000a1";
const panel = (id = EVENT_ID): string => `/me/events/${id}/host`;

const team = (key: string, name: string, over: Json = {}): Json => ({
  key,
  name,
  kind: "team",
  size: 2,
  tag: "",
  marker: "",
  channelId: null,
  captainId: null,
  memberIds: [],
  ...over,
});
const lobbyGroup = (over: Json = {}): Json => ({
  key: LOBBY,
  name: "Leader lobby",
  kind: "leads",
  size: null,
  tag: "",
  marker: "",
  channelId: null,
  captainId: null,
  memberIds: [],
  ...over,
});

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
    channelId: "c-main",
    recurrence: "none",
    seriesId: null,
    groupsEnabled: true,
    captainsEnabled: true,
    presetId: null,
    groupLabel: "Squad",
    leaderLabel: "Leader",
    channelLeadMinutes: 30,
    groupsLocked: false,
    tagsEnabled: false,
    groups: [team(A, "Heli"), team(B, "Logi")],
    ...over,
  };
}

const groupsOf = (): Json[] => store.get(EVENT_ID)?.groups as Json[];
const leadsRows = (): Json[] => groupsOf().filter((g) => g.kind === "leads");

let auditRows: Array<Record<string, unknown>> = [];
let eventsEnabled = true;
let server: Server;
let base = "";
const passes: string[] = [];
let failChannel = false;
/** Channel ids somebody is connected to in the fake gateway cache. */
let connected = new Set<string>();

function fakeClient(): never {
  return {
    guilds: {
      cache: {
        get: () => ({
          // The gateway voice-state cache: a channel somebody is connected to.
          channels: {
            cache: {
              get: (id: string) =>
                connected.has(id)
                  ? { isVoiceBased: () => true, members: { size: 1 } }
                  : undefined,
            },
          },
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
  init: { method?: string; csrf?: boolean; body?: Json } = {},
): Promise<{ status: number; text: string; location: string | null }> {
  const method = init.method ?? "GET";
  const form = new globalThis.URLSearchParams();
  if (method !== "GET" && init.csrf !== false) form.set("_csrf", csrf());
  for (const [k, v] of Object.entries(init.body ?? {})) form.set(k, String(v));
  const res = await fetch(`${base}${path}`, {
    method,
    headers: {
      cookie: cookie(CREATOR),
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
  call(`${panel()}/${action}`, { method: "POST", body, ...init });

const tokenOf = (html: string): string => {
  const m = /name="token" value="([^"]+)"/.exec(html);
  if (!m) throw new Error("no token on the page");
  return m[1];
};

/** The lobby's switch input as rendered, or "" when it is missing. */
const lobbySwitch = (html: string): string =>
  /<input[^>]*name="s_captainsLobby"[^>]*>/.exec(html)?.[0] ?? "";

const lobbyForm = (to: "0" | "1", base: "0" | "1"): Json => ({
  s_captainsLobby: to,
  b_captainsLobby: base,
});

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
  store.clear();
  store.set(EVENT_ID, makeEvent());
  writes.length = 0;
  SETTABLE.add("captainsEnabled");
  fake.beforeWrite = null;
  fake.extraGroupFields = new Set(["memberIds"]);
  fake.failReads = false;
  auditRows = [];
  eventsEnabled = true;
  failChannel = false;
  connected = new Set(["c-lobby"]);
  passes.length = 0;
  resetMoveGuardForTests();

  jest.spyOn(WebSessionService.getInstance(), "findById").mockImplementation(
    async () =>
      ({
        discordUserId: CREATOR,
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
      const doc = store.get(id);
      return doc ? clone(doc) : null;
    },
    getGroupChannelReport: () => null,
    isEventBeingEnded: () => false,
    // The group pass that makes the lobby's channel.
    reconcileGroupChannels: async () => {
      passes.push("create");
      if (failChannel) {
        return {
          created: 0,
          removed: 0,
          occupied: 0,
          warnings: [],
          failures: [{ key: LOBBY, reason: "Missing Permissions" }],
        };
      }
      for (const g of groupsOf()) {
        if (!g.channelId) g.channelId = `made-${String(g.key)}`;
      }
      return {
        created: 1,
        removed: 0,
        occupied: 0,
        warnings: [],
        failures: [],
      };
    },
    removeGroupChannel: async (
      _e: string,
      _g: string,
      o: { groupKey: string },
    ) => {
      passes.push(`remove:${o.groupKey}`);
      store.get(EVENT_ID)!.groups = groupsOf().filter(
        (g) => g.key !== o.groupKey,
      );
      return { status: "removed" };
    },
    syncLeadsAccess: async () => {
      passes.push("leads");
    },
    syncGroupControls: async () => {
      passes.push("controls");
    },
  } as never);
  jest.spyOn(EventNicknameTags, "getInstance").mockReturnValue({
    syncEvent: async () => undefined,
    restoreEvent: async () => ({ restored: 0, kept: 0, warnings: [] }),
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

describe("the switch on the page", () => {
  it("is a switch of its own, default off, posting its value with the value it showed", async () => {
    const r = await call(panel());
    expect(r.status).toBe(200);
    expect(r.text).toContain('name="s_captainsLobby"');
    expect(r.text).toContain('name="b_captainsLobby" value="0"');
    expect(lobbySwitch(r.text)).toContain('role="switch"');
    expect(lobbySwitch(r.text)).toContain('value="1"');
    expect(lobbySwitch(r.text)).not.toContain("checked");
    expect(lobbySwitch(r.text)).not.toContain("disabled");
  });

  it("is usable while leaders are off and there is no lobby: both can be turned on in one save", async () => {
    store.get(EVENT_ID)!.captainsEnabled = false;
    const r = await call(panel());
    expect(lobbySwitch(r.text)).not.toContain("disabled");
    expect(r.text).toContain("switching both on in this save is fine");
    const saved = await post("settings", {
      s_captainsEnabled: "1",
      b_captainsEnabled: "0",
      ...lobbyForm("1", "0"),
    });
    expect(flashOf(saved.location).type).toBe("ok");
    expect(store.get(EVENT_ID)!.captainsEnabled).toBe(true);
    expect(leadsRows()).toHaveLength(1);
    expect(auditRows).toHaveLength(1);
  });

  it("stays usable with leaders off when a lobby exists, so it can be turned off", async () => {
    store.get(EVENT_ID)!.captainsEnabled = false;
    store.get(EVENT_ID)!.groups = [team(A, "Heli"), lobbyGroup()];
    const r = await call(panel());
    expect(lobbySwitch(r.text)).not.toContain("disabled");
    expect(r.text).toContain('name="b_captainsLobby" value="1"');
    expect(r.text).toContain("Leaders are off, so only you can join");
  });

  it("hides the lobby from every group list and keeps the ids of the groups after it", async () => {
    store.get(EVENT_ID)!.groups = [
      team(A, "Heli"),
      lobbyGroup({ name: "Hidden command" }),
      team(B, "Logi"),
    ];
    const r = await call(panel());
    expect(r.status).toBe(200);
    // No name, size or remove field for the lobby, and no listing of it.
    expect(r.text).not.toContain("Hidden command");
    expect(r.text).not.toContain(`s_groupRemove_${LOBBY}`);
    // The positions are the STORED ones: the third group is still `C`.
    expect(r.text).toContain('name="s_groupNameA"');
    expect(r.text).not.toContain('name="s_groupNameB"');
    expect(r.text).toContain('name="s_groupNameC"');
    expect(r.text).toContain(`name="k_groupSizeC" value="${B}"`);
    expect(r.text).toContain(`name="s_groupRemove_${A}"`);
    expect(r.text).toContain(`name="s_groupRemove_${B}"`);
    // A one-line status instead of a row.
    expect(r.text).toContain(
      "Captains lobby:</strong> on, only you and the current leaders can join",
    );
  });

  it("offers no leads kind when adding a group", async () => {
    const r = await call(panel());
    expect(r.text).not.toContain('<option value="leads"');
  });

  it("is not offered while events.enabled is off", async () => {
    eventsEnabled = false;
    const r = await call(panel());
    expect(r.text).toContain("Events are turned off");
    expect(r.text).not.toContain("s_captainsLobby");
  });
});

describe("turning it on: one result, one audit row", () => {
  it("creates the restricted channel and follows up, with one flash and one audit row", async () => {
    const r = await post("settings", lobbyForm("1", "0"));
    expect(r.status).toBe(303);
    expect(flashOf(r.location)).toEqual({
      type: "ok",
      msg: "Saved: Captains lobby is now on (a leaders-only channel that only the host and the current leaders can join).",
    });
    expect(leadsRows()).toHaveLength(1);
    expect(leadsRows()[0]).toMatchObject({
      name: "Leader lobby",
      kind: "leads",
      channelId: expect.stringMatching(/^made-g_/),
    });
    expect(passes).toEqual(["create", "leads"]);
    expect(auditRows).toHaveLength(1);
    expect(auditRows[0]).toMatchObject({
      action: "event.host.settings",
      targetId: EVENT_ID,
      result: "success",
      details: {
        outcome: "applied",
        changes: [{ row: "captainsLobby", from: false, to: true }],
      },
    });
  });

  it("posting it twice is one lobby, and the second says nothing changed", async () => {
    await post("settings", lobbyForm("1", "0"));
    const again = await post("settings", lobbyForm("1", "0"));
    expect(flashOf(again.location).msg).toBe(
      "Nothing to change: the event already has these settings.",
    );
    expect(leadsRows()).toHaveLength(1);
    expect(auditRows).toHaveLength(2);
  });

  it("a channel that could not be made is saved and reported as owed, and the same form again finishes it", async () => {
    failChannel = true;
    const first = await post("settings", lobbyForm("1", "0"));
    expect(flashOf(first.location).type).toBe("err");
    expect(flashOf(first.location).msg).toContain(
      "Saved but not finished: Captains lobby is now on",
    );
    expect(flashOf(first.location).msg).toContain(
      "its channel is not created yet",
    );
    expect(flashOf(first.location).msg).toContain("Save again to finish");
    expect(leadsRows()).toHaveLength(1);
    expect(leadsRows()[0].channelId).toBeNull();
    expect(auditRows[0]).toMatchObject({
      details: { outcome: "partial", stored: [{ row: "captainsLobby" }] },
    });

    failChannel = false;
    // The page after the failure shows the stored value as both value and base.
    const again = await post("settings", lobbyForm("1", "1"));
    expect(flashOf(again.location)).toEqual({
      type: "ok",
      msg: "Saved: Captains lobby is finished.",
    });
    expect(leadsRows()).toHaveLength(1);
    expect(leadsRows()[0].channelId).toMatch(/^made-g_/);
  });

  it("needs leaders on", async () => {
    store.get(EVENT_ID)!.captainsEnabled = false;
    const r = await post("settings", lobbyForm("1", "0"));
    expect(flashOf(r.location).type).toBe("err");
    expect(flashOf(r.location).msg).toContain("turn leaders on first");
    expect(leadsRows()).toEqual([]);
    expect(auditRows[0]).toMatchObject({ result: "failure" });
  });

  it("needs the CSRF token", async () => {
    const r = await post("settings", lobbyForm("1", "0"), { csrf: false });
    expect(r.status).toBe(403);
    expect(leadsRows()).toEqual([]);
    expect(writes).toEqual([]);
  });

  it("is refused while events.enabled is off, with one failed audit row", async () => {
    eventsEnabled = false;
    const r = await post("settings", lobbyForm("1", "0"));
    expect(flashOf(r.location).msg).toContain("Events are turned off");
    expect(leadsRows()).toEqual([]);
    expect(auditRows).toHaveLength(1);
    expect(auditRows[0]).toMatchObject({ result: "failure" });
  });

  it("a forged value is a form out of date", async () => {
    const r = await post("settings", {
      s_captainsLobby: "maybe",
      b_captainsLobby: "0",
    });
    expect(flashOf(r.location).msg).toContain("choose on or off");
    expect(leadsRows()).toEqual([]);
  });
});

describe("turning it off", () => {
  it("asks first when the channel exists, applies nothing, and audits once", async () => {
    store.get(EVENT_ID)!.groups = [
      team(A, "Heli"),
      team(B, "Logi"),
      lobbyGroup({ channelId: "c-lobby" }),
    ];
    const r = await post("settings", lobbyForm("0", "1"));
    expect(r.status).toBe(200);
    expect(r.text).toContain("Confirm these changes");
    expect(r.text).toContain("moves everybody in its channel");
    expect(leadsRows()).toHaveLength(1);
    expect(writes).toEqual([]);
    expect(auditRows).toHaveLength(1);
    expect(auditRows[0]).toMatchObject({
      result: "success",
      details: { outcome: "needs-confirmation" },
    });
  });

  it("a lobby whose people cannot be moved is kept, and the result says so", async () => {
    store.get(EVENT_ID)!.groups = [
      team(A, "Heli"),
      team(B, "Logi"),
      lobbyGroup({ channelId: "c-lobby" }),
    ];
    const page = await post("settings", lobbyForm("0", "1"));
    auditRows.length = 0;
    // This harness's server cannot be checked, so the mover refuses: nobody is
    // moved, nothing is deleted, the lobby stays.
    const done = await post("settings-confirm", { token: tokenOf(page.text) });
    const flash = flashOf(done.location);
    expect(flash.type).toBe("err");
    expect(flash.msg).toContain("nothing was removed");
    expect(flash.msg).toContain("Save again");
    expect(leadsRows()).toHaveLength(1);
    expect(passes).not.toContain(`remove:${LOBBY}`);
    expect(auditRows).toHaveLength(1);
    expect(auditRows[0]).toMatchObject({ result: "failure" });
  });

  it("nobody connected to any voice channel of the event: no confirmation page, even though the lobby has a channel", async () => {
    connected = new Set();
    store.get(EVENT_ID)!.groups = [
      team(A, "Heli"),
      team(B, "Logi"),
      lobbyGroup({ channelId: "c-lobby" }),
    ];
    const r = await post("settings", lobbyForm("0", "1"));
    // No page: the save went straight on (this harness's mover then refuses).
    expect(r.status).toBe(303);
    expect(r.text).not.toContain("Confirm these changes");
    expect(auditRows).toHaveLength(1);
    expect(auditRows[0].details).not.toMatchObject({
      outcome: "needs-confirmation",
    });
  });

  it("somebody in the main channel, or in a group's, asks too", async () => {
    store.get(EVENT_ID)!.groups = [
      team(A, "Heli", { channelId: "c-a" }),
      team(B, "Logi"),
      lobbyGroup({ channelId: "c-lobby" }),
    ];
    for (const where of ["c-main", "c-a"]) {
      connected = new Set([where]);
      const r = await post("settings", lobbyForm("0", "1"));
      expect(r.status).toBe(200);
      expect(r.text).toContain("Somebody is connected to a voice channel");
    }
  });

  it("a lobby that has no channel yet is removed at once, without a confirmation page", async () => {
    connected = new Set();
    store.get(EVENT_ID)!.groups = [
      team(A, "Heli"),
      team(B, "Logi"),
      lobbyGroup(),
    ];
    const r = await post("settings", lobbyForm("0", "1"));
    expect(r.status).toBe(303);
    expect(flashOf(r.location)).toEqual({
      type: "ok",
      msg: "Saved: Captains lobby is now off (the channel is removed; leaders talk in the main channel).",
    });
    expect(leadsRows()).toEqual([]);
    expect(auditRows).toHaveLength(1);
    expect(auditRows[0]).toMatchObject({
      details: {
        outcome: "applied",
        changes: [{ row: "captainsLobby", from: true, to: false }],
      },
    });
  });

  it("a confirmation needs the CSRF token", async () => {
    store.get(EVENT_ID)!.groups = [
      team(A, "Heli"),
      team(B, "Logi"),
      lobbyGroup({ channelId: "c-lobby" }),
    ];
    const page = await post("settings", lobbyForm("0", "1"));
    expect(
      (
        await post(
          "settings-confirm",
          { token: tokenOf(page.text) },
          { csrf: false },
        )
      ).status,
    ).toBe(403);
    expect(leadsRows()).toHaveLength(1);
  });
});
