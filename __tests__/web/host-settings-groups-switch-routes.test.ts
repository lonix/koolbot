/**
 * Switching groups on and off from the host panel's Live settings section
 * (#1243) over real HTTP, like `host-settings-group-set-routes.test.ts`: real
 * Express, the real session middleware, the real CSRF check, the real host
 * gate, the real live-edit core and the groups switch row. Stubbed: the session
 * row, the permission check, the audit write, the config values, the event
 * service's lookups and channel passes, the nickname service, the preset
 * catalog and the Event model (the in-memory stand-in of
 * `event-live-edit-groups-fake-event.ts`).
 *
 * It proves the field naming (the forms' fields reach the row), that the CONTENT
 * of the groups a switch-on creates is only ever the server's own preset (a
 * posted one is dropped), that switching off always goes through the signed
 * confirmation page, that a switch-off the mover cannot start keeps everything,
 * and that every POST is exactly ONE audit row.
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
  EVENT_RECURRENCES: ["none", "weekly", "biweekly", "monthly"],
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

const onForm = (extra: Json = {}): Json => ({
  s_groupsEnabled: '{"on":true}',
  b_groupsEnabled: '{"on":false}',
  ...extra,
});
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

describe("the switch on the page", () => {
  it("an event with no groups offers the server's presets, escaped, and posts only an id", async () => {
    const r = await call(panel());
    expect(r.status).toBe(200);
    expect(r.text).toContain("This event has no groups yet.");
    expect(r.text).toContain('name="groups_pick"');
    expect(r.text).toContain(
      '<option value="lib:red-blue">Red &lt;i&gt;vs&lt;/i&gt; Blue (2 groups)</option>',
    );
    expect(r.text).not.toContain("Red <i>vs</i> Blue");
    expect(r.text).toContain(
      'name="b_groupsEnabled" value="{&quot;on&quot;:false}"',
    );
    // The content of the groups is never in the page: only the id.
    expect(r.text).not.toContain("s_groupsEnabled");
  });

  it("with no preset available (or an unreadable library) the host can still set up groups of their own", async () => {
    catalog.entries = [];
    catalog.state = "all-unreadable";
    const r = await call(panel());
    expect(r.text).toContain("No preset is available on this server right now");
    expect(r.text).toContain("The preset library could not be read");
    expect(r.text).not.toContain('name="groups_pick"');
    expect(r.text).toContain('name="custom_name_1"');
    expect(r.text).toContain('name="custom_name_6"');
    expect(r.text).not.toContain('name="custom_name_7"');
  });

  it("offers the own-groups rows next to the preset select", async () => {
    const r = await call(panel());
    // Unused rows must not block the submit in the browser (the server checks
    // the rows it uses): only this form skips the browser's field checks.
    expect(r.text).toContain(
      '<button type="submit" formnovalidate>Switch groups on</button>',
    );
    expect(r.text).toContain('name="groups_pick"');
    expect(r.text).toContain('name="custom_kind_1"');
    expect(r.text).toContain('name="custom_size_1"');
    expect(r.text).toContain('name="custom_tag_1"');
  });

  it("an event with kept groups lists them and offers to bring them back", async () => {
    store.set(EVENT_ID, kept());
    const r = await call(panel());
    expect(r.text).toContain("These team");
    expect(r.text).toContain("Heli &lt;b&gt;x&lt;/b&gt;");
    expect(r.text).toContain("2 assigned");
    expect(r.text).toContain("brings them back as they were");
    expect(r.text).toContain(
      'name="s_groupsEnabled" value="{&quot;on&quot;:true}"',
    );
    expect(r.text).not.toContain('name="groups_pick"');
  });

  it("an event with groups on offers the switch-off, and the retry of a missing channel", async () => {
    store.set(EVENT_ID, withGroups("c1"));
    const r = await call(panel());
    expect(r.text).not.toContain("formnovalidate");
    expect(r.text).toContain("Groups are on");
    expect(r.text).toContain("2 team");
    expect(r.text).toContain("1 with a voice channel");
    expect(r.text).toContain(
      'name="s_groupsEnabled" value="{&quot;on&quot;:false}"',
    );
    expect(r.text).toContain("Switch groups off");
    // Group B has no channel and the main channel exists.
    expect(r.text).toContain("Create the missing channels");
    store.set(EVENT_ID, withGroups("c1", { channelId: null }));
    expect((await call(panel())).text).not.toContain(
      "Create the missing channels",
    );
  });

  it("an adopted Discord event is told it cannot have groups", async () => {
    store.set(EVENT_ID, plainEvent({ nativeAdopted: true }));
    const r = await call(panel());
    expect(r.text).toContain("cannot have groups");
    expect(r.text).not.toContain('name="groups_pick"');
  });

  it("is not offered while events.enabled is off", async () => {
    eventsEnabled = false;
    const r = await call(panel());
    expect(r.text).toContain("Events are turned off");
    expect(r.text).not.toContain("groups_pick");
    expect(r.text).not.toContain("Switch groups");
  });
});

describe("a non-admin host's own presets turn groups on (#1216)", () => {
  const MINE = "my:" + "a".repeat(24);
  const THEIRS = "my:" + "b".repeat(24);
  const personal = (id: string, label: string, names: string[]): never =>
    ({
      ...RED_BLUE,
      id,
      label,
      source: "personal",
      groups: names.map((name) => ({
        name,
        kind: "team",
        size: null,
        tag: "",
        marker: "",
      })),
    }) as never;

  beforeEach(() => {
    for (const k of Object.keys(personalByOwner)) delete personalByOwner[k];
    personalByOwner[CREATOR] = [
      personal(MINE, "My plan", ["Mine A", "Mine B"]),
    ];
    personalByOwner["999999999999999999"] = [
      personal(THEIRS, "Their secret", ["S1", "S2"]),
    ];
  });

  it("offers the host's own preset, marked, and never another host's", async () => {
    const r = await call(panel());
    expect(r.text).toContain(`value="${MINE}"`);
    expect(r.text).toContain("My plan (yours)");
    expect(r.text).not.toContain(THEIRS);
    expect(r.text).not.toContain("Their secret");
  });

  it("builds the groups from the host's own preset", async () => {
    const r = await post("settings", {
      groups_pick: MINE,
      b_groupsEnabled: '{"on":false}',
    });
    expect(flashOf(r.location).type).toBe("ok");
    expect(doc().groupsEnabled).toBe(true);
    expect(doc().presetId).toBe(MINE);
    expect(groups().map((g) => g.name)).toEqual(["Mine A", "Mine B"]);
  });

  it("refuses another host's preset id, and turns nothing on", async () => {
    const r = await post("settings", {
      groups_pick: THEIRS,
      b_groupsEnabled: '{"on":false}',
    });
    expect(flashOf(r.location).type).toBe("err");
    expect(doc().groupsEnabled).not.toBe(true);
  });
});

describe("switching on", () => {
  it("builds the groups from the chosen preset, makes the channels, and audits once", async () => {
    const r = await post("settings", {
      groups_pick: "lib:red-blue",
      b_groupsEnabled: '{"on":false}',
    });
    expect(r.status).toBe(303);
    expect(flashOf(r.location).type).toBe("ok");
    expect(flashOf(r.location).msg).toBe(
      'Saved: Groups is now on, with "Red", "Blue".',
    );
    expect(doc().groupsEnabled).toBe(true);
    expect(doc().presetId).toBe("lib:red-blue");
    expect(groups().map((g) => [g.name, g.tag, g.marker, g.memberIds])).toEqual(
      [
        ["Red", "R", "🔴", []],
        ["Blue", "B", "🔵", []],
      ],
    );
    expect(groups().every((g) => !!g.channelId)).toBe(true);
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
            row: "groupsEnabled",
            from: { on: false },
            to: {
              on: true,
              preset: "lib:red-blue",
              g1: "Red | team | no limit | tag R",
              g2: "Blue | team | no limit | tag B",
            },
          },
        ],
      },
    });
  });

  it("switches on with the host's own groups: names, kinds, sizes and tags, blank rows skipped, no preset", async () => {
    const r = await post("settings", {
      b_groupsEnabled: '{"on":false}',
      groups_pick: "",
      custom_name_1: "  Alpha  ",
      custom_kind_1: "team",
      custom_size_1: "4",
      custom_tag_1: "AL",
      custom_name_2: "",
      custom_size_2: "7",
      custom_name_3: "Command",
      custom_kind_3: "leads",
    });
    expect(flashOf(r.location).type).toBe("ok");
    expect(doc().groupsEnabled).toBe(true);
    expect(doc().presetId).toBeNull();
    expect(doc().groupLabel).toBe("Team");
    expect(doc().tagsEnabled).toBe(false);
    expect(
      groups().map((g) => [g.name, g.kind, g.size, g.tag, g.memberIds]),
    ).toEqual([
      ["Alpha", "team", 4, "AL", []],
      ["Command", "leads", null, "", []],
    ]);
    expect(groups().every((g) => !!g.channelId)).toBe(true);
    expect(passes).toEqual(["create", "leads", "controls"]);
    expect(auditRows).toHaveLength(1);
  });

  it("own groups are checked with the event form's rules, naming the row and field, and nothing is saved", async () => {
    const bad = async (extra: Json): Promise<string> => {
      const r = await post("settings", {
        b_groupsEnabled: '{"on":false}',
        custom_name_1: "Alpha",
        ...extra,
      });
      expect(doc().groupsEnabled).toBe(false);
      return flashOf(r.location).msg;
    };
    expect(await bad({ custom_size_1: "100" })).toContain("Group 1 size:");
    expect(await bad({ custom_tag_1: "WAYTOOLONGTAG" })).toContain(
      "Group 1 tag:",
    );
    expect(await bad({ custom_name_2: "x", custom_kind_2: "boss" })).toContain(
      "Group 2 kind: must be team, open or leads.",
    );
    expect(await bad({ custom_name_2: "alpha" })).toContain("already used by");
    expect(
      await bad({
        custom_name_2: "L1",
        custom_kind_2: "leads",
        custom_name_3: "L2",
        custom_kind_3: "leads",
      }),
    ).toContain("only one leads group");
    expect(writes).toEqual([]);
  });

  it("a chosen preset wins over the own-groups rows", async () => {
    const r = await post("settings", {
      b_groupsEnabled: '{"on":false}',
      groups_pick: "lib:red-blue",
      custom_name_1: "Mine",
    });
    expect(flashOf(r.location).type).toBe("ok");
    expect(groups().map((g) => g.name)).toEqual(["Red", "Blue"]);
  });

  it("the own-groups rows are refused for an event that has kept groups (the page was out of date)", async () => {
    store.set(EVENT_ID, kept());
    const r = await post("settings", onForm({ custom_name_1: "Mine" }));
    expect(flashOf(r.location).type).toBe("err");
    expect(flashOf(r.location).msg).toContain("kept from before");
    expect(doc().groupsEnabled).toBe(false);
  });

  it("a posted group setup is never believed: only the server's preset or none", async () => {
    const forged = JSON.stringify({
      on: true,
      setup: {
        id: "lib:red-blue",
        groupLabel: "Team",
        leaderLabel: "Leader",
        tagsEnabled: true,
        groups: [
          { name: "Evil", kind: "team", size: null, tag: "", marker: "" },
        ],
      },
    });
    const r = await post("settings", onForm({ s_groupsEnabled: forged }));
    expect(flashOf(r.location).type).toBe("err");
    expect(flashOf(r.location).msg).toBe(
      "Nothing was changed. Groups: this event has no groups yet. Choose a preset to switch groups on with.",
    );
    expect(doc().groupsEnabled).toBe(false);
    expect(groups()).toEqual([]);
    // And with a chosen preset, the posted content is replaced by the server's.
    const both = await post(
      "settings",
      onForm({ s_groupsEnabled: forged, groups_pick: "lib:red-blue" }),
    );
    expect(flashOf(both.location).type).toBe("ok");
    expect(groups().map((g) => g.name)).toEqual(["Red", "Blue"]);
  });

  it("a preset that is gone, switched off or unreadable fails closed with its reason, and audits once", async () => {
    const unknown = await post("settings", {
      groups_pick: "lib:nope",
      b_groupsEnabled: '{"on":false}',
    });
    expect(flashOf(unknown.location).msg).toBe(
      "Nothing was changed. That preset does not exist (any more). Reload the page.",
    );
    expect(auditRows).toHaveLength(1);
    expect(auditRows[0]).toMatchObject({ result: "failure" });
    catalog.entries = [{ ...RED_BLUE, enabled: false } as never];
    const off = await post("settings", {
      groups_pick: "lib:red-blue",
      b_groupsEnabled: '{"on":false}',
    });
    expect(flashOf(off.location).msg).toBe(
      "Nothing was changed. That preset is switched off on this server.",
    );
    catalog.state = "all-unreadable";
    const unreadable = await post("settings", {
      groups_pick: "lib:red-blue",
      b_groupsEnabled: '{"on":false}',
    });
    expect(flashOf(unreadable.location).msg).toContain(
      "The preset library could not be read",
    );
    expect(doc().groupsEnabled).toBe(false);
    expect(writes).toEqual([]);
  });

  it("kept groups come back with their people, and the nicknames follow when tagging is on", async () => {
    store.set(EVENT_ID, kept({ tagsEnabled: true }));
    const r = await post("settings", onForm());
    expect(flashOf(r.location).type).toBe("ok");
    expect(doc().groupsEnabled).toBe(true);
    expect(groups()[0].memberIds).toEqual(["u1", "u2"]);
    expect(passes).toEqual(["create", "leads", "controls", "tags:sync"]);
    expect(auditRows).toHaveLength(1);
  });

  it("posting the same switch-on twice is one switch, with an audit row each", async () => {
    store.set(EVENT_ID, kept());
    await post("settings", onForm());
    const again = await post("settings", onForm());
    expect(flashOf(again.location).msg).toBe(
      "Nothing to change: the event already has these settings.",
    );
    expect(auditRows).toHaveLength(2);
    expect(auditRows[1].details).toMatchObject({ outcome: "nothing-to-do" });
  });

  it("a switch-on needs the CSRF token", async () => {
    store.set(EVENT_ID, kept());
    const r = await post("settings", onForm(), { csrf: false });
    expect(r.status).toBe(403);
    expect(doc().groupsEnabled).toBe(false);
  });

  it("is refused while events.enabled is off, with one failed audit row", async () => {
    store.set(EVENT_ID, kept());
    eventsEnabled = false;
    const r = await post("settings", onForm());
    expect(flashOf(r.location).msg).toContain("Events are turned off");
    expect(doc().groupsEnabled).toBe(false);
    expect(auditRows).toHaveLength(1);
    expect(auditRows[0]).toMatchObject({ result: "failure" });
  });
});

describe("switching off: always confirmed", () => {
  it("shows a confirmation page that names the groups and what happens, applies nothing, and audits once", async () => {
    store.set(EVENT_ID, withGroups());
    const r = await post("settings", offForm());
    expect(r.status).toBe(200);
    expect(r.text).toContain("Confirm these changes");
    expect(r.text).toContain(
      "Switching groups off: Heli &lt;b&gt;x&lt;/b&gt; (2 assigned)",
    );
    expect(r.text).toContain("If somebody cannot be moved, nothing is deleted");
    expect(doc().groupsEnabled).toBe(true);
    expect(writes).toEqual([]);
    expect(passes).toEqual([]);
    expect(auditRows).toHaveLength(1);
    expect(auditRows[0]).toMatchObject({
      result: "success",
      details: { outcome: "needs-confirmation" },
    });
  });

  it("confirming switches off, keeps the assignments and puts the nicknames back; a replay applies nothing", async () => {
    store.set(EVENT_ID, withGroups());
    const page = await post("settings", offForm());
    const token = tokenOf(page.text);
    auditRows.length = 0;
    const done = await post("settings-confirm", { token });
    expect(flashOf(done.location)).toEqual({
      type: "ok",
      msg: "Saved: Groups is now off.",
    });
    expect(doc().groupsEnabled).toBe(false);
    expect(groups()[0].memberIds).toEqual(["u1", "u2"]);
    expect(passes).toEqual(["removeAll", "tags:restore"]);
    expect(auditRows).toHaveLength(1);
    expect(auditRows[0]).toMatchObject({
      result: "success",
      details: {
        outcome: "applied",
        changes: [
          { row: "groupsEnabled", from: { on: true }, to: { on: false } },
        ],
      },
    });
    const replay = await post("settings-confirm", { token });
    expect(flashOf(replay.location).type).toBe("err");
    expect(doc().groupsEnabled).toBe(false);
  });

  it("needs the CSRF token on both steps", async () => {
    store.set(EVENT_ID, withGroups());
    expect((await post("settings", offForm(), { csrf: false })).status).toBe(
      403,
    );
    const page = await post("settings", offForm());
    expect(
      (
        await post(
          "settings-confirm",
          { token: tokenOf(page.text) },
          { csrf: false },
        )
      ).status,
    ).toBe(403);
    expect(doc().groupsEnabled).toBe(true);
  });

  it("people the mover cannot start moving keep everything: nothing is deleted and the result says so", async () => {
    // Group A has a channel, and this server's bot cannot be checked: the
    // mover refuses, so nothing is moved, deleted or switched off.
    store.set(EVENT_ID, withGroups("c1"));
    const page = await post("settings", offForm());
    const done = await post("settings-confirm", { token: tokenOf(page.text) });
    const flash = flashOf(done.location);
    expect(flash.type).toBe("err");
    expect(flash.msg).toContain(
      "Nothing was deleted and the groups are still on",
    );
    expect(doc().groupsEnabled).toBe(true);
    expect(groups()[0].channelId).toBe("c1");
    expect(passes).not.toContain("removeAll");
    expect(passes).not.toContain("tags:restore");
  });
});

describe("a preset with a Captains lobby switches groups on (#1263)", () => {
  const WITH_LOBBY = {
    ...RED_BLUE,
    id: "lib:red-blue-lobby",
    label: "Red vs Blue with lobby",
    groups: [
      ...RED_BLUE.groups,
      { name: "Command", kind: "leads", size: null, tag: "", marker: "" },
    ],
  };

  it("lists it with the visible groups counted, and says the lobby comes later with the leaders", async () => {
    catalog.entries = [WITH_LOBBY as never];
    const r = await call(panel());
    expect(r.text).toContain(
      '<option value="lib:red-blue-lobby">Red vs Blue with lobby (2 groups)</option>',
    );
    expect(r.text).toContain(
      "so does a preset's Captains lobby (switch it on with the leaders)",
    );
  });

  it("creates the visible groups only: leaders are off after a switch-on, so no lobby channel is made", async () => {
    catalog.entries = [WITH_LOBBY as never];
    const r = await post("settings", {
      groups_pick: "lib:red-blue-lobby",
      b_groupsEnabled: '{"on":false}',
    });
    expect(r.status).toBe(303);
    expect(flashOf(r.location).type).toBe("ok");
    expect(doc().groupsEnabled).toBe(true);
    expect(groups().map((g) => [g.name, g.kind])).toEqual([
      ["Red", "team"],
      ["Blue", "team"],
    ]);
  });
});
