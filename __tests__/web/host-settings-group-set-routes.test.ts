/**
 * Adding and removing groups from the host panel's Live settings section
 * (#1242) over real HTTP, like `host-settings-groups-routes.test.ts`: real
 * Express, the real session middleware, the real CSRF check, the real host
 * gate, the real live-edit core and the rows of the group set. Stubbed: the
 * session row, the permission check, the audit write, the config values, the
 * event service's lookups and channel passes, the nickname service, and the
 * Event model (the in-memory stand-in of
 * `event-live-edit-groups-fake-event.ts`).
 *
 * It proves the field naming (the two forms' fields reach the rows), that a
 * removal always goes through the signed confirmation page, that posting the
 * add form twice is one group, that a removal the mover cannot start keeps the
 * group, and that every POST is exactly ONE audit row.
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

const SECRET = "test-secret-for-host-settings-group-set";
const GUILD = "guild-1";
const CREATOR = "111111111111111111";
const EVENT_ID = "65a000000000000000000001";
const A = "g_00000001";
const B = "g_00000002";
const NEW = "g_0000abcd";
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
    captainsEnabled: false,
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
        memberIds: ["u1", "u2"],
      },
      {
        key: B,
        name: "Logi",
        kind: "team",
        size: null,
        tag: "",
        marker: "",
        // No channel yet: its removal needs no move.
        channelId: null,
        captainId: null,
        memberIds: ["u3"],
      },
    ],
    ...over,
  };
}

const keysOf = (): string[] =>
  (store.get(EVENT_ID)?.groups as Json[]).map((g) => g.key as string);

let auditRows: Array<Record<string, unknown>> = [];
let eventsEnabled = true;
let server: Server;
let base = "";
const passes: string[] = [];

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

const addForm = (over: Json = {}): Json => ({
  s_groupAdd_name: "Delta",
  s_groupAdd_kind: "team",
  s_groupAdd_size: "4",
  s_groupAdd_tag: "D",
  s_groupAdd_key: NEW,
  b_groupAdd: "[]",
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
  fake.extraGroupFields = new Set(["memberIds"]);
  fake.failReads = false;
  auditRows = [];
  eventsEnabled = true;
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
  } as never);
  jest.spyOn(EventService, "getInstance").mockReturnValue({
    getEvent: async (id: string) => {
      const doc = store.get(id);
      return doc ? clone(doc) : null;
    },
    getGroupChannelReport: () => null,
    isEventBeingEnded: () => false,
    // The group pass that makes a new group's channel.
    reconcileGroupChannels: async () => {
      passes.push("create");
      for (const g of store.get(EVENT_ID)?.groups as Json[]) {
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
      store.get(EVENT_ID)!.groups = (
        store.get(EVENT_ID)!.groups as Json[]
      ).filter((g) => g.key !== o.groupKey);
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
    syncEvent: async () => {
      passes.push("tags:sync");
    },
    restoreEvent: async () => {
      passes.push("tags:restore");
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

describe("the add and remove forms on the page", () => {
  it("shows a checkbox per group, escaped, and the add form with a minted key", async () => {
    const r = await call(panel());
    expect(r.status).toBe(200);
    expect(r.text).toContain(`name="s_groupRemove_${A}" value="1"`);
    expect(r.text).toContain(`name="s_groupRemove_${B}" value="1"`);
    expect(r.text).toContain("Heli &lt;b&gt;x&lt;/b&gt;");
    expect(r.text).not.toContain("Heli <b>x</b>");
    expect(r.text).toContain("2 people assigned, has a voice channel");
    expect(r.text).toContain("1 person assigned, no channel yet");
    expect(r.text).toContain('name="b_groupRemove" value="[]"');
    expect(r.text).toContain('name="s_groupAdd_name"');
    expect(r.text).toContain('name="b_groupAdd" value="[]"');
    expect(r.text).toMatch(/name="s_groupAdd_key" value="g_[0-9a-f]{8}"/);
    // The key a size field was shown for travels with it.
    expect(r.text).toContain(`name="k_groupSizeA" value="${A}"`);
    expect(r.text).toContain(`name="k_groupSizeB" value="${B}"`);
    // The same for the name fields.
    expect(r.text).toContain(`name="k_groupNameA" value="${A}"`);
    expect(r.text).toContain(`name="k_groupNameB" value="${B}"`);
  });

  it("mints a different key for every page, so posting a page twice is the only way to repeat a request", async () => {
    const key = (html: string): string =>
      /name="s_groupAdd_key" value="(g_[0-9a-f]{8})"/.exec(html)?.[1] ?? "";
    const one = key((await call(panel())).text);
    const two = key((await call(panel())).text);
    expect(one).toMatch(/^g_[0-9a-f]{8}$/);
    expect(two).toMatch(/^g_[0-9a-f]{8}$/);
    expect(one).not.toBe(two);
    // Never one a group already has.
    expect([A, B]).not.toContain(one);
  });

  it("offers no removal while only one group is left", async () => {
    store.get(EVENT_ID)!.groups = (store.get(EVENT_ID)!.groups as Json[]).slice(
      0,
      1,
    );
    const r = await call(panel());
    expect(r.text).toContain("An event keeps at least one squad");
    expect(r.text).not.toContain("s_groupRemove_");
    expect(r.text).toContain('name="s_groupAdd_name"');
  });

  it("is not offered while events.enabled is off", async () => {
    eventsEnabled = false;
    const r = await call(panel());
    expect(r.text).toContain("Events are turned off");
    expect(r.text).not.toContain("s_groupAdd_name");
    expect(r.text).not.toContain("s_groupRemove_");
  });
});

describe("adding a group: one result, one audit row", () => {
  it("adds it, makes its channel, follows up, with one flash and one audit row", async () => {
    const r = await post("settings", addForm());
    expect(r.status).toBe(303);
    expect(flashOf(r.location)).toEqual({
      type: "ok",
      msg: 'Saved: New group is now "Delta" (team, size 4).',
    });
    expect(keysOf()).toEqual([A, B, NEW]);
    expect(passes).toEqual(["create", "leads", "controls"]);
    expect(auditRows).toHaveLength(1);
    expect(auditRows[0]).toMatchObject({
      action: "event.host.settings",
      targetId: EVENT_ID,
      result: "success",
      details: {
        outcome: "applied",
        changes: [
          {
            row: "groupAdd",
            to: { g1: `${NEW} | Delta | team | size 4 | tag D` },
          },
        ],
      },
    });
  });

  it("posting the same form twice is one group and says so, with an audit row each", async () => {
    await post("settings", addForm());
    const again = await post("settings", addForm());
    expect(flashOf(again.location).type).toBe("ok");
    expect(keysOf()).toEqual([A, B, NEW]);
    expect(auditRows).toHaveLength(2);
    expect(auditRows[1].details).toMatchObject({ outcome: "nothing-to-do" });
    expect(flashOf(again.location).msg).toBe(
      "Nothing to change: the event already has these settings.",
    );
  });

  it("an empty name is no change: nothing is written and the result says so", async () => {
    const r = await post("settings", addForm({ s_groupAdd_name: "  " }));
    expect(flashOf(r.location).msg).toBe(
      "Nothing to change: the event already has these settings.",
    );
    expect(writes).toEqual([]);
    expect(keysOf()).toEqual([A, B]);
  });

  it("a name another group has is refused, naming the reason, with one failed audit row", async () => {
    const r = await post("settings", addForm({ s_groupAdd_name: "logi" }));
    expect(flashOf(r.location).type).toBe("err");
    expect(flashOf(r.location).msg).toContain(
      '"logi" is already used by another group',
    );
    expect(keysOf()).toEqual([A, B]);
    expect(auditRows).toHaveLength(1);
    expect(auditRows[0]).toMatchObject({ result: "failure" });
  });

  it("a bad field names it, and a forged key is a form out of date", async () => {
    const size = await post("settings", addForm({ s_groupAdd_size: "100" }));
    expect(flashOf(size.location).msg).toContain("New group size:");
    const key = await post("settings", addForm({ s_groupAdd_key: "x" }));
    expect(flashOf(key.location).msg).toContain("the form is out of date");
    expect(keysOf()).toEqual([A, B]);
    expect(writes).toEqual([]);
  });

  it("needs the CSRF token", async () => {
    const r = await post("settings", addForm(), { csrf: false });
    expect(r.status).toBe(403);
    expect(keysOf()).toEqual([A, B]);
    expect(writes).toEqual([]);
  });

  it("is refused while events.enabled is off, with one failed audit row", async () => {
    eventsEnabled = false;
    const r = await post("settings", addForm());
    expect(flashOf(r.location).msg).toContain("Events are turned off");
    expect(keysOf()).toEqual([A, B]);
    expect(auditRows).toHaveLength(1);
    expect(auditRows[0]).toMatchObject({ result: "failure" });
  });
});

describe("removing a group: always confirmed", () => {
  const removeForm = (...keys: string[]): Json => ({
    b_groupRemove: "[]",
    ...Object.fromEntries(keys.map((k) => [`s_groupRemove_${k}`, "1"])),
  });

  it("shows a confirmation page that names the group and what happens, applies nothing, and audits once", async () => {
    const r = await post("settings", removeForm(B));
    expect(r.status).toBe(200);
    expect(r.text).toContain("Confirm these changes");
    expect(r.text).toContain("Removing this group: Logi (1 person assigned)");
    expect(r.text).toContain("This cannot be undone.");
    expect(keysOf()).toEqual([A, B]);
    expect(writes).toEqual([]);
    expect(auditRows).toHaveLength(1);
    expect(auditRows[0]).toMatchObject({
      result: "success",
      details: { outcome: "needs-confirmation" },
    });
  });

  it("confirming removes it and unassigns its members; a replay applies nothing", async () => {
    const page = await post("settings", removeForm(B));
    const token = tokenOf(page.text);
    auditRows.length = 0;
    const done = await post("settings-confirm", { token });
    expect(flashOf(done.location)).toEqual({
      type: "ok",
      msg: "Saved: Group removal is now done for 1 group.",
    });
    expect(keysOf()).toEqual([A]);
    expect(auditRows).toHaveLength(1);
    expect(auditRows[0]).toMatchObject({
      result: "success",
      details: {
        outcome: "applied",
        changes: [{ row: "groupRemove", from: [], to: [B] }],
      },
    });
    expect(passes).toContain("tags:restore");
    const replay = await post("settings-confirm", { token });
    expect(flashOf(replay.location).type).toBe("err");
    expect(keysOf()).toEqual([A]);
  });

  it("a removal needs the CSRF token on both steps", async () => {
    expect(
      (await post("settings", removeForm(B), { csrf: false })).status,
    ).toBe(403);
    const page = await post("settings", removeForm(B));
    expect(
      (
        await post(
          "settings-confirm",
          { token: tokenOf(page.text) },
          { csrf: false },
        )
      ).status,
    ).toBe(403);
    expect(keysOf()).toEqual([A, B]);
  });

  it("a group whose people cannot be moved is kept, and the result says nothing was removed", async () => {
    // Its channel exists, and this server's bot cannot be checked: the mover
    // refuses, so nothing is unassigned, deleted or removed.
    const page = await post("settings", removeForm(A));
    const done = await post("settings-confirm", { token: tokenOf(page.text) });
    const flash = flashOf(done.location);
    expect(flash.type).toBe("err");
    expect(flash.msg).toContain("nothing was removed");
    expect(keysOf()).toEqual([A, B]);
    expect((store.get(EVENT_ID)!.groups as Json[])[0].memberIds).toEqual([
      "u1",
      "u2",
    ]);
    expect(passes).not.toContain(`remove:${A}`);
  });

  it("removing every group is refused", async () => {
    const r = await post("settings", removeForm(A, B));
    expect(flashOf(r.location).msg).toContain(
      "an event keeps at least one group",
    );
    expect(keysOf()).toEqual([A, B]);
  });
});

describe("the size fields are guarded by the key of the group they were shown for", () => {
  it("a form for another group at that position is a conflict, not a resize", async () => {
    // Position 2 now holds Logi (no size); the form says it was shown for A.
    const r = await post("settings", {
      s_groupSizeB: "5",
      b_groupSizeB: "",
      k_groupSizeB: A,
    });
    expect(flashOf(r.location).type).toBe("err");
    expect(flashOf(r.location).msg).toContain("was changed by someone else");
    expect((store.get(EVENT_ID)!.groups as Json[])[1].size).toBeNull();
    expect(writes.filter((w) => !("$inc" in w.update))).toEqual([]);
  });

  it("the same form with the right key resizes it", async () => {
    const r = await post("settings", {
      s_groupSizeB: "5",
      b_groupSizeB: "",
      k_groupSizeB: B,
    });
    expect(flashOf(r.location).type).toBe("ok");
    expect((store.get(EVENT_ID)!.groups as Json[])[1].size).toBe(5);
  });
});
