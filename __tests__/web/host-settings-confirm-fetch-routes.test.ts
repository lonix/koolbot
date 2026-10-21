/**
 * The fetch-and-upgrade of the host panel's two always-confirmed routes
 * (#1344) over real HTTP, with the harness of `host-settings-groups-switch-routes.test.ts`:
 * real Express, session, CSRF, host gate, live-edit core and rows; stubbed
 * session row, permissions, audit, config, event service and the Event model.
 *
 * What it proves: a POST that carries the panel's `X-Kb-Confirm-Only` header
 * either answers with the confirmation page (marker header and DOM markers,
 * nothing applied) or changes nothing at all (refusal before the revision is
 * claimed); that the confirm token is the unchanged signed single-use one; and
 * that a stale token or an event that changed meanwhile applies nothing.
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
/** Personal presets by owner (#1216); the stand-in honours the asking owner like the service. */
const personalByOwner: Record<string, Catalog["entries"]> = {};
const presetActual =
  await import("../../src/services/event-group-preset-service.js");
jest.unstable_mockModule(
  "../../src/services/event-group-preset-service.js",
  () => ({
    ...presetActual,
    loadPresetCatalog: async (_guild: string, opts?: { ownerId?: string }) => ({
      ...catalog,
      entries: [
        ...catalog.entries,
        ...(personalByOwner[opts?.ownerId ?? ""] ?? []),
      ],
    }),
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
const { EventNicknameTags } =
  await import("../../src/services/event-nickname-tags.js");
const { ConfigService } = await import("../../src/services/config-service.js");
const { WebAuditLog } = await import("../../src/models/web-audit-log.js");
const { resetMoveGuardForTests } =
  await import("../../src/services/event-move-guard.js");

const SECRET = "test-secret-for-host-settings-groups-switch";
const GUILD = "guild-1";
const CREATOR = "111111111111111111";
const EVENT_ID = "65a000000000000000000001";
const A = "g_00000001";
const B = "g_00000002";
const panel = (id = EVENT_ID): string => `/me/events/${id}/host`;

const RED_BLUE = {
  id: "lib:red-blue",
  label: "Red <i>vs</i> Blue",
  description: "",
  groupLabel: "Team",
  tagsEnabled: false,
  groups: [
    { name: "Red", kind: "team", size: null, tag: "R", marker: "🔴" },
    { name: "Blue", kind: "team", size: null, tag: "B", marker: "🔵" },
  ],
  source: "library",
  enabled: true,
};

function plainEvent(over: Json = {}): Json {
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
    groupsEnabled: false,
    captainsEnabled: false,
    presetId: null,
    groupLabel: "Team",
    leaderLabel: "Leader",
    channelLeadMinutes: 30,
    groupsLocked: false,
    tagsEnabled: false,
    groups: [],
    ...over,
  };
}

const groupRows = (channel: string | null): Json[] => [
  {
    key: A,
    name: "Heli <b>x</b>",
    kind: "team",
    size: 2,
    tag: "",
    marker: "",
    channelId: channel,
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
    channelId: null,
    captainId: null,
    memberIds: ["u3"],
  },
];

const withGroups = (channel: string | null = null, over: Json = {}): Json =>
  plainEvent({ groupsEnabled: true, groups: groupRows(channel), ...over });
const kept = (over: Json = {}): Json =>
  plainEvent({ groupsEnabled: false, groups: groupRows(null), ...over });

const doc = (): Json => store.get(EVENT_ID) as Json;
const groups = (): Json[] => doc().groups as Json[];

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
  init: {
    method?: string;
    csrf?: boolean;
    body?: Json;
    headers?: Record<string, string>;
  } = {},
): Promise<{
  status: number;
  text: string;
  location: string | null;
  headers: Headers;
}> {
  const method = init.method ?? "GET";
  const form = new globalThis.URLSearchParams();
  if (method !== "GET" && init.csrf !== false) form.set("_csrf", csrf());
  for (const [k, v] of Object.entries(init.body ?? {})) form.set(k, String(v));
  const res = await fetch(`${base}${path}`, {
    method,
    headers: {
      cookie: cookie(CREATOR),
      "content-type": "application/x-www-form-urlencoded",
      ...(init.headers ?? {}),
    },
    body: method === "GET" ? undefined : form.toString(),
    redirect: "manual",
  });
  return {
    status: res.status,
    text: await res.text(),
    location: res.headers.get("location"),
    headers: res.headers,
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

const offForm = (): Json => ({
  s_groupsEnabled: '{"on":false}',
  b_groupsEnabled: '{"on":true}',
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
  store.set(EVENT_ID, plainEvent());
  writes.length = 0;
  fake.beforeWrite = null;
  fake.extraGroupFields = new Set();
  fake.extraSettable = new Set([
    "groupsEnabled",
    "groupsLocked",
    "groupLabel",
    "leaderLabel",
    "tagsEnabled",
    "groups",
  ]);
  fake.failReads = false;
  catalog.entries = [RED_BLUE as never];
  catalog.state = "ok";
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
    resolveWebScopes: async () => ["member", "host"],
  } as never);
  jest.spyOn(EventService, "getInstance").mockReturnValue({
    getEvent: async (id: string) => {
      const d = store.get(id);
      return d ? clone(d) : null;
    },
    getGroupChannelReport: () => null,
    isEventBeingEnded: () => false,
    // The group pass that makes the channels.
    reconcileGroupChannels: async () => {
      passes.push("create");
      for (const g of groups()) {
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
    removeAllGroupChannels: async () => {
      passes.push("removeAll");
      for (const g of groups()) g.channelId = null;
      doc().groupsEnabled = false;
      return { status: "off", deleted: 1 };
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

const {
  CONFIRM_ONLY_HEADER,
  CONFIRM_ONLY_VALUE,
  CONFIRM_PAGE_HEADER,
  CONFIRM_PAGE_VALUE,
} = await import("../../src/web/confirm-fetch.js");

const ONLY = { headers: { [CONFIRM_ONLY_HEADER]: CONFIRM_ONLY_VALUE } };
const removeForm = (...keys: string[]): Json => ({
  b_groupRemove: "[]",
  ...Object.fromEntries(keys.map((k) => [`s_groupRemove_${k}`, "1"])),
});
/** An edit that needs no confirmation (the lock), for the guard and the stale-token cases. */
const lockForm = (): Json => ({
  s_groupsLocked: "1",
  b_groupsLocked: "0",
});
const revisionOf = (): unknown => doc().liveEditRevision ?? 0;

/** Nothing of the event moved: no write, no channel pass, same revision and groups. */
function expectUntouched(before: { revision: unknown; groups: string }): void {
  expect(writes).toEqual([]);
  expect(passes).toEqual([]);
  expect(revisionOf()).toBe(before.revision);
  expect(JSON.stringify(groups())).toBe(before.groups);
}
const snapshot = (): { revision: unknown; groups: string } => ({
  revision: revisionOf(),
  groups: JSON.stringify(groups()),
});

describe("which forms are upgraded", () => {
  it("marks the switch-off and the remove forms, and no other form of the panel", async () => {
    store.set(EVENT_ID, withGroups());
    const r = await call(panel());
    expect(r.status).toBe(200);
    const forms = r.text.split("<form ").slice(1);
    const marked = forms
      .filter((f) => f.split(">")[0].includes("data-confirm-fetch"))
      .map((f) => /<button type="submit"[^>]*>([^<]*)</.exec(f)?.[1]);
    expect(marked).toEqual(["Remove selected", "Switch groups off"]);
    // Both carry the empty live region the script reports a problem in.
    expect(r.text.match(/data-confirm-fetch-error/g)).toHaveLength(
      marked.length + 1 /* the script text names it once */,
    );
    expect(r.text).toContain("<script nonce=");
  });

  it("leaves 'Create the missing channels' and the switch-on forms alone", async () => {
    store.set(EVENT_ID, withGroups("c1", { channelId: "c-main" }));
    (store.get(EVENT_ID) as Json & { groups: Json[] }).groups[1].channelId =
      null;
    const owed = await call(panel());
    expect(owed.text).toContain("Create the missing channels");
    const form = owed.text
      .split("<form ")
      .find((f) => f.includes("Create the missing channels"));
    expect(form).toBeDefined();
    expect(form!.split(">")[0]).not.toContain("data-confirm-fetch");
    store.set(EVENT_ID, kept());
    const off = await call(panel());
    expect(off.text).toContain("Switch groups on");
    for (const f of off.text.split("<form ").slice(1)) {
      if (f.includes("Switch groups on")) {
        expect(f.split(">")[0]).not.toContain("data-confirm-fetch");
      }
    }
  });
});

describe("the fetch gets the confirmation page, and nothing is applied", () => {
  it("switch-off: the page carries the server-only header, the markers and the signed token", async () => {
    store.set(EVENT_ID, withGroups());
    const before = snapshot();
    const r = await post("settings", offForm(), ONLY);
    expect(r.status).toBe(200);
    expect(r.headers.get(CONFIRM_PAGE_HEADER)).toBe(CONFIRM_PAGE_VALUE);
    expect(r.headers.get("content-type")).toMatch(/^text\/html/);
    expect(r.headers.get("cache-control")).toBe("no-store");
    expect(r.text).toContain('data-confirm-page="live-settings"');
    expect(r.text).toContain("<ul data-confirm-reasons>");
    expect(r.text).toContain("<ul data-confirm-changes>");
    expect(r.text).toContain(`action="${panel()}/settings-confirm"`);
    expect(r.text).toMatch(/<form [^>]*data-confirm-form/);
    expect(tokenOf(r.text).length).toBeGreaterThan(20);
    expectUntouched(before);
    expect(auditRows).toHaveLength(1);
    expect(auditRows[0]).toMatchObject({
      result: "success",
      details: { outcome: "needs-confirmation" },
    });
  });

  it("remove: the same page for a removal", async () => {
    store.set(EVENT_ID, withGroups());
    const before = snapshot();
    const r = await post("settings", removeForm(B), ONLY);
    expect(r.headers.get(CONFIRM_PAGE_HEADER)).toBe(CONFIRM_PAGE_VALUE);
    expect(r.text).toContain("Removing this group: Logi");
    expectUntouched(before);
  });

  it("the no-JavaScript route is unchanged: the same page, and the same token flow, without the header", async () => {
    store.set(EVENT_ID, withGroups());
    const r = await post("settings", offForm());
    expect(r.status).toBe(200);
    expect(r.text).toContain("Confirm these changes");
    const done = await post("settings-confirm", { token: tokenOf(r.text) });
    expect(flashOf(done.location).type).toBe("ok");
    expect(doc().groupsEnabled).toBe(false);
  });

  it("confirming with the token from the fetch applies it once; a replay applies nothing", async () => {
    store.set(EVENT_ID, withGroups());
    const page = await post("settings", offForm(), ONLY);
    const token = tokenOf(page.text);
    const done = await post("settings-confirm", { token });
    expect(flashOf(done.location).type).toBe("ok");
    expect(doc().groupsEnabled).toBe(false);
    passes.length = 0;
    const replay = await post("settings-confirm", { token });
    expect(flashOf(replay.location).type).toBe("err");
    expect(passes).toEqual([]);
  });

  it("only the CSRF-protected POST gets that far", async () => {
    store.set(EVENT_ID, withGroups());
    const before = snapshot();
    const r = await post("settings", offForm(), { ...ONLY, csrf: false });
    expect(r.status).toBe(403);
    expect(r.headers.get(CONFIRM_PAGE_HEADER)).toBeNull();
    expectUntouched(before);
  });

  it("the token is bound to the signed-in host, this event and its changes", async () => {
    store.set(EVENT_ID, withGroups());
    const page = await post("settings", offForm(), ONLY);
    const token = tokenOf(page.text);
    const forged = `${token.slice(0, -2)}${token.endsWith("AA") ? "BB" : "AA"}`;
    const before = snapshot();
    const bad = await post("settings-confirm", { token: forged });
    expect(flashOf(bad.location).type).toBe("err");
    expect(flashOf(bad.location).msg).toContain("Nothing was changed");
    expectUntouched(before);
  });
});

describe("a non-confirm outcome of the fetch changes nothing (server guard)", () => {
  it("an edit that needs no confirmation is refused, not applied", async () => {
    store.set(EVENT_ID, withGroups());
    const before = snapshot();
    const r = await post("settings", lockForm(), ONLY);
    expect(r.status).toBe(303);
    expect(r.headers.get(CONFIRM_PAGE_HEADER)).toBeNull();
    const flash = flashOf(r.location);
    expect(flash.type).toBe("err");
    expect(flash.msg).toContain("nothing to confirm");
    expect(doc().groupsLocked).toBe(false);
    expectUntouched(before);
    expect(auditRows).toHaveLength(1);
    expect(auditRows[0]).toMatchObject({
      result: "failure",
      errorMessage: "not-confirmable",
    });
  });

  it("the same edit without the header is applied as before (the guard is the header's)", async () => {
    store.set(EVENT_ID, withGroups());
    const r = await post("settings", lockForm());
    expect(flashOf(r.location).type).toBe("ok");
    expect(doc().groupsLocked).toBe(true);
  });

  it("event changed before the fetch: a switch-off of groups that are already off applies nothing", async () => {
    store.set(EVENT_ID, kept());
    const before = snapshot();
    const r = await post("settings", offForm(), ONLY);
    expect(r.status).toBe(303);
    expect(r.headers.get(CONFIRM_PAGE_HEADER)).toBeNull();
    expect(flashOf(r.location).type).toBe("err");
    expect(doc().groupsEnabled).toBe(false);
    expectUntouched(before);
  });

  it("removing a group somebody else already removed applies nothing", async () => {
    store.set(EVENT_ID, withGroups());
    (doc().groups as Json[]).splice(1, 1);
    const before = snapshot();
    const r = await post("settings", removeForm(B), ONLY);
    expect(r.headers.get(CONFIRM_PAGE_HEADER)).toBeNull();
    expect(flashOf(r.location).type).toBe("err");
    expectUntouched(before);
  });

  it("nothing ticked is refused, not answered with an empty confirmation", async () => {
    store.set(EVENT_ID, withGroups());
    const before = snapshot();
    const r = await post("settings", removeForm(), ONLY);
    expect(r.headers.get(CONFIRM_PAGE_HEADER)).toBeNull();
    expect(flashOf(r.location).msg).toContain("nothing to confirm");
    expectUntouched(before);
  });

  it("a confirmation plus an edit that needs none is shown together and applied only on confirm", async () => {
    store.set(EVENT_ID, withGroups());
    const before = snapshot();
    const r = await post("settings", { ...offForm(), ...lockForm() }, ONLY);
    expect(r.headers.get(CONFIRM_PAGE_HEADER)).toBe(CONFIRM_PAGE_VALUE);
    expect(r.text).toContain(
      "<strong>Lock groups</strong>: unlocked to locked",
    );
    expect(doc().groupsLocked).toBe(false);
    expectUntouched(before);
  });

  it("invalid input is refused with nothing changed", async () => {
    store.set(EVENT_ID, withGroups());
    const before = snapshot();
    const r = await post(
      "settings",
      { s_groupsEnabled: "nonsense", b_groupsEnabled: '{"on":true}' },
      ONLY,
    );
    expect(r.headers.get(CONFIRM_PAGE_HEADER)).toBeNull();
    expect(flashOf(r.location).type).toBe("err");
    expectUntouched(before);
  });

  it("events off: refused, nothing changed, no confirmation page", async () => {
    store.set(EVENT_ID, withGroups());
    eventsEnabled = false;
    const before = snapshot();
    const r = await post("settings", offForm(), ONLY);
    expect(r.headers.get(CONFIRM_PAGE_HEADER)).toBeNull();
    expect(flashOf(r.location).msg).toContain("Events are turned off");
    expectUntouched(before);
  });
});

describe("stale token and an event that changed while the dialog was open", () => {
  it("the event was saved through the live edit meanwhile: the token is stale, nothing is applied", async () => {
    store.set(EVENT_ID, withGroups());
    const page = await post("settings", offForm(), ONLY);
    const token = tokenOf(page.text);
    // Somebody else saves a setting: the revision moves on.
    const other = await post("settings", lockForm());
    expect(flashOf(other.location).type).toBe("ok");
    passes.length = 0;
    writes.length = 0;
    const done = await post("settings-confirm", { token });
    expect(flashOf(done.location).type).toBe("err");
    expect(doc().groupsEnabled).toBe(true);
    expect(passes).toEqual([]);
  });

  it("the groups were switched off by someone else meanwhile: the token applies nothing", async () => {
    store.set(EVENT_ID, withGroups());
    const page = await post("settings", offForm(), ONLY);
    const token = tokenOf(page.text);
    doc().groupsEnabled = false;
    doc().liveEditRevision = 3;
    const done = await post("settings-confirm", { token });
    expect(flashOf(done.location).type).toBe("err");
    expect(passes).toEqual([]);
    expect(writes).toEqual([]);
  });

  it("the group to remove was removed meanwhile: the token applies nothing", async () => {
    store.set(EVENT_ID, withGroups());
    const page = await post("settings", removeForm(B), ONLY);
    const token = tokenOf(page.text);
    (doc().groups as Json[]).splice(1, 1);
    doc().liveEditRevision = 3;
    const keys = (): string[] => groups().map((g) => String(g.key));
    const done = await post("settings-confirm", { token });
    expect(flashOf(done.location).type).toBe("err");
    expect(keys()).toEqual([A]);
    expect(passes).toEqual([]);
  });

  it("a token for another event is refused", async () => {
    store.set(EVENT_ID, withGroups());
    const other = "65a000000000000000000002";
    store.set(other, { ...(withGroups() as Json), _id: other });
    const page = await post("settings", offForm(), ONLY);
    const token = tokenOf(page.text);
    const done = await call(`${panel(other)}/settings-confirm`, {
      method: "POST",
      body: { token },
    });
    expect(flashOf(done.location).type).toBe("err");
    expect((store.get(other) as Json).groupsEnabled).toBe(true);
    expect(doc().groupsEnabled).toBe(true);
  });
});
