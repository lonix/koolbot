/**
 * The group editor of the host panel's Live settings section (#1241) over real
 * HTTP, like `host-settings-routes.test.ts`: real Express, the real session
 * middleware, the real CSRF check, the real host gate, the real live-edit core
 * and the rows of names, sizes and preset. Stubbed: the session row, the
 * permission check, the audit write, the config values, the event service's
 * lookups, the preset catalog, the channel and nickname effects, and the Event
 * model (the in-memory stand-in of `event-live-edit-groups-fake-event.ts`).
 *
 * It proves the field naming (the form's `s_groupNameA` and friends reach the
 * rows), that a preset's content comes from the catalog and never from the
 * form, and that every POST is exactly ONE audit row.
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
  clone,
  EventMock,
  type Json,
} from "../services/event-live-edit-groups-fake-event.js";

jest.unstable_mockModule("../../src/models/event.js", () => ({
  Event: EventMock,
}));

type Catalog =
  import("../../src/services/event-group-preset-service.js").PresetCatalog;
let catalog: Catalog = { entries: [], state: "ok" };
const presetActual = await import(
  "../../src/services/event-group-preset-service.js"
);
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
const { ConfigService } = await import("../../src/services/config-service.js");
const { WebAuditLog } = await import("../../src/models/web-audit-log.js");
const { resetMoveGuardForTests } =
  await import("../../src/services/event-move-guard.js");
const groupEdit = await import("../../src/services/event-live-edit-groups.js");

const SECRET = "test-secret-for-host-settings-groups";
const GUILD = "guild-1";
const CREATOR = "111111111111111111";
const EVENT_ID = "65a000000000000000000001";
const A = "g_00000001";
const B = "g_00000002";
const panel = (id = EVENT_ID): string => `/me/events/${id}/host`;

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
    presetId: null,
    groupLabel: "Squad",
    leaderLabel: "Leader",
    channelLeadMinutes: 30,
    groupsLocked: false,
    tagsEnabled: false,
    groups: [
      {
        key: A,
        name: "Heli <b>x</b>",
        kind: "team",
        size: 2,
        tag: "",
        marker: "",
        channelId: "c1",
        captainId: null,
        memberIds: ["u1", "u2", "u3"],
      },
      {
        key: B,
        name: "Logi",
        kind: "team",
        size: null,
        tag: "",
        marker: "",
        channelId: "c2",
        captainId: null,
        memberIds: [],
      },
    ],
    ...over,
  };
}

const group = (key: string): Json =>
  (store.get(EVENT_ID)?.groups as Json[]).find((g) => g.key === key) as Json;

let auditRows: Array<Record<string, unknown>> = [];
let eventsEnabled = true;
let server: Server;
let base = "";
const effectCalls: string[] = [];
let nameStatus: "applied" | "limited" = "applied";

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

/** What the page shows as the base of the preset form for the stored setup. */
const STORED_BASE = JSON.stringify({
  id: "",
  groups: [
    { name: "Heli <b>x</b>", kind: "team", size: 2, tag: "" },
    { name: "Logi", kind: "team", size: null, tag: "" },
  ],
});

const preset = (
  id: string,
  names: string[],
  over: Record<string, unknown> = {},
) => ({
  id,
  source: "builtin" as const,
  label: `Preset ${id}`,
  description: "",
  groupLabel: "Team",
  enabled: true,
  groups: names.map((name) => ({
    name,
    kind: "team" as const,
    size: 6,
    tag: "T",
    marker: "",
  })),
  ...over,
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
  fake.beforeWrite = null;
  fake.failReads = false;
  auditRows = [];
  eventsEnabled = true;
  effectCalls.length = 0;
  nameStatus = "applied";
  catalog = {
    state: "ok",
    entries: [preset("builtin:pair", ["Pair One", "Pair Two"])],
  };
  resetMoveGuardForTests();
  groupEdit.configureGroupEditEffects({
    async syncName(_g, _e, key) {
      effectCalls.push(`name:${key}`);
      if (nameStatus === "limited") {
        return { groupKey: key, status: "limited", retryAfterMs: 420_000 };
      }
      delete group(key).nameSyncPending;
      return { groupKey: key, status: "applied" };
    },
    async syncUserLimit(_g, _e, key) {
      effectCalls.push(`limit:${key}`);
      delete group(key).sizeSyncPending;
      return { groupKey: key, status: "applied" };
    },
    retag: () => {},
  });

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
  } as never);
  jest.spyOn(EventService, "getInstance").mockReturnValue({
    getEvent: async (id: string) => {
      const doc = store.get(id);
      return doc ? clone(doc) : null;
    },
    getGroupChannelReport: () => null,
    isEventBeingEnded: () => false,
  } as never);
  jest.spyOn(ConfigService, "getInstance").mockReturnValue({
    getBoolean: async (key: string) => key === "events.enabled" && eventsEnabled,
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
  groupEdit.configureGroupEditEffects(null);
});

describe("the group editor on the page", () => {
  it("shows a name and size field per group with the stored values as the base, escaped, and the preset form", async () => {
    const r = await call(panel());
    expect(r.status).toBe(200);
    expect(r.text).toContain('name="s_groupNameA" value="Heli &lt;b&gt;x&lt;/b&gt;"');
    expect(r.text).toContain('name="b_groupNameA" value="Heli &lt;b&gt;x&lt;/b&gt;"');
    expect(r.text).not.toContain("Heli <b>x</b>");
    expect(r.text).toContain('name="s_groupSizeA" value="2"');
    expect(r.text).toContain('name="s_groupSizeB" value=""');
    expect(r.text).toContain("over size");
    expect(r.text).toContain('name="preset_pick"');
    expect(r.text).toContain('<option value="builtin:pair">Preset builtin:pair</option>');
    expect(r.text).toContain('name="b_groupPreset"');
    expect(r.text).not.toContain('name="s_groupPreset"');
  });

  it("is not offered while events.enabled is off", async () => {
    eventsEnabled = false;
    const r = await call(panel());
    expect(r.text).toContain("Events are turned off");
    expect(r.text).not.toContain("s_groupNameA");
  });
});

describe("saving names and sizes: one result, one audit row", () => {
  const form = (over: Json = {}): Json => ({
    s_groupNameA: "Apex",
    b_groupNameA: "Heli <b>x</b>",
    s_groupSizeA: "4",
    b_groupSizeA: "2",
    ...over,
  });

  it("renames the group and the channel, changes the size, with one flash and one audit row", async () => {
    const r = await post("settings", form());
    expect(r.status).toBe(303);
    expect(flashOf(r.location)).toEqual({
      type: "ok",
      msg: 'Saved: Name of group 1 is now "Apex"; Size of group 1 is now 4.',
    });
    expect(group(A)).toMatchObject({ name: "Apex", size: 4 });
    expect(group(A).memberIds).toEqual(["u1", "u2", "u3"]);
    expect(effectCalls).toEqual([`name:${A}`, `limit:${A}`]);
    expect(auditRows).toHaveLength(1);
    expect(auditRows[0]).toMatchObject({
      action: "event.host.settings",
      targetId: EVENT_ID,
      result: "success",
      details: {
        outcome: "applied",
        changes: [
          { row: "groupNameA", from: "Heli <b>x</b>", to: "Apex" },
          { row: "groupSizeA", from: 2, to: 4 },
        ],
      },
    });
  });

  it("a refused (reserved) name changes nothing and is one failed audit row", async () => {
    const r = await post("settings", form({ s_groupNameA: "LOGI", s_groupSizeA: "2" }));
    expect(flashOf(r.location).type).toBe("err");
    expect(flashOf(r.location).msg).toContain(
      '"LOGI" is already used by another group',
    );
    expect(group(A).name).toBe("Heli <b>x</b>");
    expect(writes).toEqual([]);
    expect(effectCalls).toEqual([]);
    expect(auditRows).toHaveLength(1);
    expect(auditRows[0]).toMatchObject({ result: "failure" });
  });

  it("an invalid size is refused naming the group, nothing is saved", async () => {
    const r = await post("settings", form({ s_groupSizeA: "100" }));
    expect(flashOf(r.location).msg).toContain(
      "Nothing was changed. Group 1 size: a whole number from 1 to 99",
    );
    expect(writes).toEqual([]);
    expect(auditRows).toHaveLength(1);
  });

  it("lowering a size below the people keeps them and the page then shows the group over size", async () => {
    const r = await post("settings", {
      s_groupSizeA: "1",
      b_groupSizeA: "2",
    });
    expect(flashOf(r.location).type).toBe("ok");
    expect(group(A).memberIds).toEqual(["u1", "u2", "u3"]);
    const page = await call(panel());
    expect(page.text).toContain('name="s_groupSizeA" value="1"');
    expect(page.text).toContain("over size");
  });

  it("a rename budget wait is saved, reported as not finished, and one audit row says partial", async () => {
    nameStatus = "limited";
    const r = await post("settings", {
      s_groupNameB: "Logistics",
      b_groupNameB: "Logi",
    });
    const flash = flashOf(r.location);
    expect(flash.type).toBe("err");
    expect(flash.msg).toContain(
      'Saved but not finished: Name of group 2 is now "Logistics"',
    );
    expect(flash.msg).toContain("about 7 minutes");
    expect(group(B)).toMatchObject({ name: "Logistics", nameSyncPending: true });
    expect(auditRows).toHaveLength(1);
    expect(auditRows[0].details).toMatchObject({
      outcome: "partial",
      stored: [{ row: "groupNameB", from: "Logi", to: "Logistics" }],
    });
    // The page shows the pending rename; saving again finishes it.
    expect((await call(panel())).text).toContain("channel rename pending");
    nameStatus = "applied";
    auditRows = [];
    const again = await post("settings", {
      s_groupNameB: "Logistics",
      b_groupNameB: "Logistics",
    });
    expect(flashOf(again.location)).toEqual({
      type: "ok",
      msg: "Saved: Name of group 2 is finished.",
    });
    expect(auditRows).toHaveLength(1);
  });

  it("a stale form cannot overwrite a name somebody else changed", async () => {
    group(A).name = "Changed meanwhile";
    const r = await post("settings", form({ s_groupSizeA: "2" }));
    expect(flashOf(r.location).type).toBe("err");
    expect(flashOf(r.location).msg).toContain("was changed by someone else");
    expect(group(A).name).toBe("Changed meanwhile");
  });

  it("needs the CSRF token", async () => {
    const r = await post("settings", form(), { csrf: false });
    expect(r.status).toBe(403);
    expect(writes).toEqual([]);
  });

  it("is refused while events.enabled is off, with one failed audit row", async () => {
    eventsEnabled = false;
    const r = await post("settings", form());
    expect(flashOf(r.location).msg).toContain("Events are turned off");
    expect(writes).toEqual([]);
    expect(effectCalls).toEqual([]);
    expect(auditRows).toHaveLength(1);
    expect(auditRows[0]).toMatchObject({ result: "failure" });
  });
});

describe("switching the preset", () => {
  it("shows a confirmation page built from the CATALOG, applies nothing, and audits once", async () => {
    const r = await post("settings", {
      preset_pick: "builtin:pair",
      b_groupPreset: STORED_BASE,
    });
    expect(r.status).toBe(200);
    expect(r.text).toContain("Confirm these changes");
    expect(r.text).toContain("Switching the preset replaces the names of 2 groups");
    expect(r.text).toContain("Pair One [T] (size 6), Pair Two [T] (size 6)");
    expect(group(A).name).toBe("Heli <b>x</b>");
    expect(writes).toEqual([]);
    expect(auditRows).toHaveLength(1);
    expect(auditRows[0]).toMatchObject({
      result: "success",
      details: { outcome: "needs-confirmation" },
    });
  });

  it("a base that is not what the page produced is refused as an out-of-date form", async () => {
    const r = await post("settings", {
      preset_pick: "builtin:pair",
      b_groupPreset: JSON.stringify({ forged: true }),
    });
    expect(r.status).toBe(303);
    expect(flashOf(r.location).msg).toContain("the form is out of date");
    expect(writes).toEqual([]);
    expect(auditRows).toHaveLength(1);
  });

  it("the page escapes what it lists (a name with markup)", async () => {
    const r = await post("settings", {
      preset_pick: "builtin:pair",
      b_groupPreset: JSON.stringify({
        id: "",
        groups: [
          { name: "Heli <b>x</b>", kind: "team", size: 2, tag: "" },
          { name: "Logi", kind: "team", size: null, tag: "" },
        ],
      }),
    });
    expect(r.text).toContain("Heli &lt;b&gt;x&lt;/b&gt;");
    expect(r.text).not.toContain("Heli <b>x</b>");
  });

  it("a content posted by the client is ignored: only the catalog's content is confirmed and applied", async () => {
    const page = await post("settings", {
      preset_pick: "builtin:pair",
      s_groupPreset: JSON.stringify({
        id: "builtin:pair",
        groups: [
          { name: "Evil", kind: "team", size: 99, tag: "" },
          { name: "Evil2", kind: "team", size: 99, tag: "" },
        ],
      }),
      b_groupPreset: JSON.stringify({
        id: "",
        groups: [
          { name: "Heli <b>x</b>", kind: "team", size: 2, tag: "" },
          { name: "Logi", kind: "team", size: null, tag: "" },
        ],
      }),
    });
    expect(page.text).not.toContain("Evil");
    const r = await post("settings-confirm", { token: tokenOf(page.text) });
    expect(flashOf(r.location).type).toBe("ok");
    expect(store.get(EVENT_ID)?.groups).toMatchObject([
      { name: "Pair One", size: 6, tag: "T" },
      { name: "Pair Two", size: 6, tag: "T" },
    ]);
    expect(JSON.stringify(store.get(EVENT_ID))).not.toContain("Evil");
  });

  it("confirming applies the switch, renames the channels, with one audit row; a replay applies nothing", async () => {
    const base = JSON.stringify({
      id: "",
      groups: [
        { name: "Heli <b>x</b>", kind: "team", size: 2, tag: "" },
        { name: "Logi", kind: "team", size: null, tag: "" },
      ],
    });
    const page = await post("settings", {
      preset_pick: "builtin:pair",
      b_groupPreset: base,
    });
    const token = tokenOf(page.text);
    auditRows = [];
    const r = await post("settings-confirm", { token });
    expect(r.status).toBe(303);
    expect(flashOf(r.location).type).toBe("ok");
    expect(store.get(EVENT_ID)?.presetId).toBe("builtin:pair");
    expect(effectCalls.sort()).toEqual(
      [`name:${A}`, `name:${B}`, `limit:${A}`, `limit:${B}`].sort(),
    );
    expect(auditRows).toHaveLength(1);
    expect(auditRows[0]).toMatchObject({
      action: "event.host.settings-confirm",
      result: "success",
    });
    writes.length = 0;
    auditRows = [];
    const replay = await post("settings-confirm", { token });
    expect(flashOf(replay.location).msg).toContain("Review the form again");
    expect(writes).toEqual([]);
    expect(auditRows).toHaveLength(1);
  });

  it("an unknown or switched-off preset is refused, nothing is saved, one failed audit row", async () => {
    for (const pick of ["builtin:nope"]) {
      auditRows = [];
      const r = await post("settings", {
        preset_pick: pick,
        b_groupPreset: "{}",
      });
      expect(flashOf(r.location).msg).toContain(
        "That preset does not exist (any more).",
      );
      expect(auditRows).toHaveLength(1);
      expect(auditRows[0]).toMatchObject({ result: "failure" });
    }
    catalog = {
      state: "ok",
      entries: [preset("builtin:pair", ["A", "B"], { enabled: false })],
    };
    const off = await post("settings", {
      preset_pick: "builtin:pair",
      b_groupPreset: "{}",
    });
    expect(flashOf(off.location).msg).toContain("switched off");
    expect(writes).toEqual([]);
  });

  it("a preset that does not fit the event's groups is refused at save time too", async () => {
    catalog = {
      state: "ok",
      entries: [preset("builtin:three", ["A", "B", "C"])],
    };
    const r = await post("settings", {
      preset_pick: "builtin:three",
      b_groupPreset: JSON.stringify({
        id: "",
        groups: [
          { name: "Heli <b>x</b>", kind: "team", size: 2, tag: "" },
          { name: "Logi", kind: "team", size: null, tag: "" },
        ],
      }),
    });
    expect(flashOf(r.location).msg).toContain(
      "has 3 groups and this event has 2",
    );
    expect(writes).toEqual([]);
  });
});
