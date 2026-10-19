/**
 * The host panel's "Live settings" section, its save action and its
 * confirmation round trip (#1239), over real HTTP: real Express, the real
 * session middleware, the real CSRF check, the real host gate (#1189), the
 * real live-edit module with the real group lock and move lock. Stubbed: the
 * session row, the permission check, the audit write, the config values, the
 * event service's lookups, and the Event model (an in-memory stand-in that
 * throws on any filter or update shape the live edit does not use).
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
  store,
  writes,
  fake,
  clone,
  SETTABLE,
  EventMock,
  type Json,
} from "../services/event-live-edit-fake-event.js";

jest.unstable_mockModule("../../src/models/event.js", () => ({
  Event: EventMock,
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
const { LIVE_EDIT_ROWS, defineRow } =
  await import("../../src/services/event-live-edit.js");
const { withEventMoveLock, resetMoveGuardForTests } =
  await import("../../src/services/event-move-guard.js");
type LiveEditRow = import("../../src/services/event-live-edit.js").LiveEditRow;

const SECRET = "test-secret-for-host-settings-routes";
const GUILD = "guild-1";
const CREATOR = "111111111111111111";
const OTHER = "222222222222222222";
const EVENT_ID = "65a000000000000000000001";
const EVENT_2 = "65a000000000000000000002";
const panel = (id = EVENT_ID): string => `/me/events/${id}/host`;

function makeEvent(over: Json = {}, id = EVENT_ID): Json {
  return {
    _id: id,
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
    channelLeadMinutes: 30,
    groupsLocked: false,
    testName: "a",
    groups: [
      {
        key: "g_00000001",
        name: "Heli <b>x</b>",
        kind: "team",
        size: 2,
        tag: "",
        marker: "",
        channelId: null,
        captainId: null,
        memberIds: ["u1", "u2", "u3"],
      },
    ],
    ...over,
  };
}

/** A row that needs confirmation: proves the round trip and the extension contract. */
const dangerRow = defineRow<string>({
  id: "testName",
  label: "Test name",
  read: (e) => String((e as unknown as Json).testName ?? "a"),
  parse: (raw) => ({ ok: true, value: raw }),
  applicable: () => null,
  needsConfirmation: (_f, to) =>
    to.startsWith("danger") ? "This <i>is</i> risky." : null,
  describe: (v) => `"${v}"`,
  async apply({ eventId, guildId, from, to }) {
    const { Event } = await import("../../src/models/event.js");
    const r = await Event.updateOne(
      {
        _id: eventId,
        guildId,
        state: { $in: ["scheduled", "active"] },
        testName: from,
      } as never,
      { $set: { testName: to } } as never,
    );
    return (r?.matchedCount ?? 0) === 1
      ? { status: "applied" }
      : { status: "lost" };
  },
});

let auditRows: Array<Record<string, unknown>> = [];
let eventsEnabled: boolean | "throw" = true;
let ending = false;
let groupCapUnreadable = false;
let sessionUser = CREATOR;
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
  init: { method?: string; user?: string; csrf?: boolean; body?: Json } = {},
): Promise<{
  status: number;
  text: string;
  location: string | null;
  cache: string | null;
}> {
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
    cache: res.headers.get("cache-control"),
  };
}

function flashOf(location: string | null): { type: string; msg: string } {
  const q = new globalThis.URL(location ?? "", "http://x").searchParams;
  return { type: q.get("flash") ?? "", msg: q.get("msg") ?? "" };
}

const post = (action: string, body: Json, id = EVENT_ID, init: Json = {}) =>
  call(`${panel(id)}/${action}`, { method: "POST", body, ...init });

const auditFor = (action: string): Array<Record<string, unknown>> =>
  auditRows.filter((r) => r.action === action);

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
  SETTABLE.add("seriesGroupSetup");
  store.clear();
  store.set(EVENT_ID, makeEvent());
  writes.length = 0;
  fake.beforeWrite = null;
  fake.failReads = false;
  auditRows = [];
  eventsEnabled = true;
  ending = false;
  groupCapUnreadable = false;
  sessionUser = CREATOR;
  resetMoveGuardForTests();
  (LIVE_EDIT_ROWS as LiveEditRow[]).push(dangerRow);

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
    getEvent: async (id: string) => {
      const doc = store.get(id);
      return doc ? clone(doc) : null;
    },
    getGroupChannelReport: () => null,
    isEventBeingEnded: () => ending,
  } as never);
  jest.spyOn(ConfigService, "getInstance").mockReturnValue({
    getBoolean: async (key: string) => {
      if (key !== "events.enabled") return false;
      if (eventsEnabled === "throw") throw new Error("config unreadable");
      return eventsEnabled;
    },
    getNumberStrict: async (_k: string, f: number) => {
      if (groupCapUnreadable) throw new Error("db down");
      return f;
    },
    getNumber: async (_k: string, f: number) => f,
    getString: async (_k: string, f: string) => f,
  } as never);
  jest.spyOn(WebAuditLog, "create").mockImplementation(async (row: unknown) => {
    auditRows.push(row as Record<string, unknown>);
    return {} as never;
  });
});

afterEach(() => {
  const rows = LIVE_EDIT_ROWS as LiveEditRow[];
  const i = rows.indexOf(dangerRow);
  if (i >= 0) rows.splice(i, 1);
  jest.restoreAllMocks();
});

describe("the Live settings section", () => {
  it("shows the form with the fresh values and what was shown as the base, escaping names", async () => {
    const r = await call(panel());
    expect(r.status).toBe(200);
    expect(r.text).toContain('id="host-settings"');
    expect(r.text).not.toContain(
      "Change the settings of the event while it runs. Not available yet",
    );
    expect(r.text).toContain('name="s_channelLeadMinutes" value="30"');
    expect(r.text).toContain('name="b_channelLeadMinutes" value="30"');
    expect(r.text).toContain('name="b_groupsLocked" value="0"');
    expect(r.text).toContain(`action="${panel()}/settings"`);
    expect(r.text).toContain(`name="_csrf" value="${csrf()}"`);
    // Over size is derived (3 people in a group of 2), names are escaped.
    expect(r.text).toContain("over size");
    expect(r.text).toContain("Heli &lt;b&gt;x&lt;/b&gt;");
    expect(r.text).not.toContain("Heli <b>x</b>");
  });

  it("reads the event fresh, not from the gate's copy", async () => {
    // The gate and the section both read through getEvent; a changed store is seen.
    (store.get(EVENT_ID) as Json).groupsLocked = true;
    const r = await call(panel());
    expect(r.text).toContain('name="b_groupsLocked" value="1"');
  });

  it("shows the lead time read-only, with the reason, once a channel exists", async () => {
    (store.get(EVENT_ID) as Json).channelId = "c-main";
    const r = await call(panel());
    expect(r.text).toContain("The channels already exist");
    expect(r.text).not.toContain('name="s_channelLeadMinutes"');
    expect(r.text).toContain('name="s_groupsLocked"');
  });

  it("offers only the lead time for an event without groups", async () => {
    store.set(
      EVENT_ID,
      makeEvent({ groupsEnabled: false, groups: [], channelLeadMinutes: null }),
    );
    const r = await call(panel());
    expect(r.text).toContain('name="s_channelLeadMinutes" value=""');
    expect(r.text).not.toContain('name="s_groupsLocked"');
  });

  it("shows a notice and no form while events.enabled is off or unreadable", async () => {
    for (const state of [false, "throw"] as const) {
      eventsEnabled = state;
      const r = await call(panel());
      expect(r.text).toContain("Events are turned off");
      expect(r.text).not.toContain('name="s_channelLeadMinutes"');
    }
  });

  it("shows the refusal and no form while an end or cancel holds the event (every save would be refused)", async () => {
    ending = true;
    const r = await call(panel());
    expect(r.status).toBe(200);
    expect(r.text).toContain(
      "This event is being ended, so nothing was changed.",
    );
    expect(r.text).not.toContain('name="s_channelLeadMinutes"');
    expect(r.text).not.toContain('name="s_groupsLocked"');
    // The same page with no hold offers the form again.
    ending = false;
    expect((await call(panel())).text).toContain('name="s_channelLeadMinutes"');
  });

  it("is a read-only summary for an ended event (no settings section)", async () => {
    (store.get(EVENT_ID) as Json).state = "ended";
    const r = await call(panel());
    expect(r.text).toContain("read-only summary");
    expect(r.text).not.toContain('id="host-settings"');
  });
});

describe("saving the form: one result, one audit row", () => {
  const form = (over: Json = {}): Json => ({
    s_channelLeadMinutes: "45",
    b_channelLeadMinutes: "30",
    s_groupsLocked: "1",
    b_groupsLocked: "0",
    ...over,
  });

  it("applies both rows, answers with one signed flash and writes one audit row", async () => {
    const r = await post("settings", form());
    expect(r.status).toBe(303);
    expect(flashOf(r.location)).toEqual({
      type: "ok",
      msg: "Saved: Channel creation time is now 45 minutes before the start; Lock groups is now locked.",
    });
    expect(store.get(EVENT_ID)).toMatchObject({
      channelLeadMinutes: 45,
      groupsLocked: true,
    });
    expect(auditRows).toHaveLength(1);
    expect(auditRows[0]).toMatchObject({
      action: "event.host.settings",
      targetId: EVENT_ID,
      result: "success",
      details: {
        outcome: "applied",
        changes: [
          { row: "channelLeadMinutes", from: 30, to: 45 },
          { row: "groupsLocked", from: false, to: true },
        ],
      },
    });
  });

  it("saving the same form again is 'nothing to change', still one audit row", async () => {
    await post("settings", form());
    auditRows = [];
    const r = await post("settings", form());
    expect(flashOf(r.location)).toEqual({
      type: "ok",
      msg: "Nothing to change: the event already has these settings.",
    });
    expect(auditRows).toHaveLength(1);
    expect(auditRows[0].details).toMatchObject({ outcome: "nothing-to-do" });
  });

  it("an empty save changes nothing and says so", async () => {
    const r = await post("settings", {});
    expect(flashOf(r.location).msg).toBe(
      "Nothing to change: the event already has these settings.",
    );
    expect(writes).toEqual([]);
    expect(auditRows).toHaveLength(1);
  });

  it("an invalid value changes nothing, names the field, and is one failed audit row", async () => {
    const r = await post("settings", form({ s_channelLeadMinutes: "5000" }));
    expect(flashOf(r.location).type).toBe("err");
    expect(flashOf(r.location).msg).toContain(
      "Nothing was changed. Channel creation time must be a whole number",
    );
    expect(writes).toEqual([]);
    expect(auditRows).toHaveLength(1);
    expect(auditRows[0]).toMatchObject({ result: "failure" });
  });

  it("a value posted without its base is refused as an out-of-date form", async () => {
    const r = await post("settings", { s_groupsLocked: "1" });
    expect(flashOf(r.location).msg).toContain("the form is out of date");
    expect(writes).toEqual([]);
    expect(auditRows).toHaveLength(1);
  });

  it("a stale form cannot overwrite a lead time somebody else changed", async () => {
    (store.get(EVENT_ID) as Json).channelLeadMinutes = 60;
    const r = await post("settings", form({ s_groupsLocked: "0" }));
    const flash = flashOf(r.location);
    expect(flash.type).toBe("err");
    expect(flash.msg).toContain("was changed by someone else");
    expect(store.get(EVENT_ID)?.channelLeadMinutes).toBe(60);
    expect(auditRows).toHaveLength(1);
    expect(auditRows[0].details).toMatchObject({
      outcome: "not-applied",
      notApplied: [{ row: "channelLeadMinutes" }],
    });
  });

  it("a stale form posting a lead time after the channels were created is refused", async () => {
    (store.get(EVENT_ID) as Json).channelId = "c-main";
    const r = await post("settings", form({ s_groupsLocked: "0" }));
    expect(flashOf(r.location).msg).toContain(
      "The channels already exist, so the creation time can no longer change.",
    );
    expect(store.get(EVENT_ID)?.channelLeadMinutes).toBe(30);
  });

  it("partial success lists what was not saved and one audit row says partial", async () => {
    fake.beforeWrite = (): void => {
      // The first write loses its condition: a channel appears.
      (store.get(EVENT_ID) as Json).channelId = "c-main";
      fake.beforeWrite = null;
    };
    const r = await post("settings", form());
    const flash = flashOf(r.location);
    expect(flash.type).toBe("err");
    expect(flash.msg).toContain("Saved: Lock groups is now locked.");
    expect(flash.msg).toContain("Not saved: Channel creation time");
    expect(flash.msg).toContain("Save again to retry.");
    expect(auditRows).toHaveLength(1);
    expect(auditRows[0].details).toMatchObject({ outcome: "partial" });
  });

  it("is refused, with one failed audit row, while events.enabled is off or unreadable", async () => {
    for (const state of [false, "throw"] as const) {
      auditRows = [];
      eventsEnabled = state;
      const r = await post("settings", form());
      expect(flashOf(r.location)).toMatchObject({
        type: "err",
        msg: expect.stringContaining("Events are turned off"),
      });
      expect(auditRows).toHaveLength(1);
      expect(auditRows[0]).toMatchObject({ result: "failure" });
    }
    expect(writes).toEqual([]);
  });

  it("is refused for an ended event (by the host action gate) with one audit row", async () => {
    (store.get(EVENT_ID) as Json).state = "ended";
    const r = await post("settings", form());
    expect(flashOf(r.location).msg).toBe(
      "This event is ended, so it can no longer be changed.",
    );
    expect(auditRows).toHaveLength(1);
    expect(writes).toEqual([]);
  });

  it("is refused for an event being ended", async () => {
    ending = true;
    const r = await post("settings", form());
    expect(flashOf(r.location).msg).toBe(
      "This event is being ended, so nothing was changed.",
    );
    expect(writes).toEqual([]);
    expect(auditRows).toHaveLength(1);
  });

  it("answers busy, changing nothing, while a bulk move holds the event", async () => {
    let release!: () => void;
    const held = withEventMoveLock(
      EVENT_ID,
      () => new Promise<void>((r) => (release = r)),
    );
    const r = await post("settings", form());
    expect(flashOf(r.location).msg).toContain("already in progress");
    expect(writes).toEqual([]);
    expect(auditRows).toHaveLength(1);
    release();
    await held;
  });

  it("needs the CSRF token: nothing is written and nothing is audited as a save", async () => {
    const r = await post("settings", form(), EVENT_ID, { csrf: false });
    expect(r.status).toBe(403);
    expect(writes).toEqual([]);
    expect(auditFor("event.host.settings")).toEqual([]);
  });

  it("is refused for somebody who is not the host, and the refusal is audited", async () => {
    sessionUser = OTHER;
    const r = await post("settings", form());
    expect(r.status).toBe(403);
    expect(writes).toEqual([]);
    expect(auditFor("event.host.denied")).toHaveLength(1);
  });
});

describe("a row that validates the group list reads the cap strictly (fails closed)", () => {
  const setupRow = defineRow<string>({
    id: "testSetup",
    label: "Test setup",
    read: () => "a",
    parse: (raw) => ({ ok: true, value: raw }),
    applicable: () => null,
    validate: (_to, ctx) => ctx.validateSetup(() => undefined)[0] ?? null,
    describe: (v) => v,
    apply: async () => ({ status: "applied" }),
  });
  const withRow = async (work: () => Promise<void>): Promise<void> => {
    const rows = LIVE_EDIT_ROWS as LiveEditRow[];
    rows.push(setupRow);
    try {
      await work();
    } finally {
      rows.splice(rows.indexOf(setupRow), 1);
    }
  };

  it("refuses with the unreadable-limit message, changing nothing, when the cap lookup fails", async () => {
    await withRow(async () => {
      groupCapUnreadable = true;
      const r = await post("settings", { s_testSetup: "b", b_testSetup: "a" });
      expect(flashOf(r.location).msg).toContain(
        "The group limit could not be read, so nothing was changed.",
      );
      expect(writes).toEqual([]);
      expect(auditRows).toHaveLength(1);
    });
  });

  it("accepts the same change while the cap is readable", async () => {
    await withRow(async () => {
      const r = await post("settings", { s_testSetup: "b", b_testSetup: "a" });
      expect(flashOf(r.location).type).toBe("ok");
    });
  });
});

describe("the confirmation round trip", () => {
  const dangerous = (over: Json = {}): Json => ({
    s_testName: "danger zone",
    b_testName: "a",
    ...over,
  });
  const tokenOf = (html: string): string => {
    const m = /name="token" value="([^"]+)"/.exec(html);
    if (!m) throw new Error("no token on the page");
    return m[1];
  };

  it("answers a change that needs confirmation with a page, applies nothing, and audits once", async () => {
    const r = await post("settings", dangerous());
    expect(r.status).toBe(200);
    expect(r.cache).toBe("no-store");
    expect(r.text).toContain("Confirm these changes");
    expect(r.text).toContain("This &lt;i&gt;is&lt;/i&gt; risky.");
    expect(r.text).not.toContain("<i>is</i>");
    expect(r.text).toContain(`action="${panel()}/settings-confirm"`);
    expect(r.text).toContain(`name="_csrf" value="${csrf()}"`);
    expect(store.get(EVENT_ID)?.testName).toBe("a");
    expect(writes).toEqual([]);
    expect(auditRows).toHaveLength(1);
    expect(auditRows[0]).toMatchObject({
      action: "event.host.settings",
      result: "success",
      details: { outcome: "needs-confirmation" },
    });
  });

  it("confirming applies exactly the confirmed change set, once, with one audit row", async () => {
    const page = await post("settings", dangerous());
    auditRows = [];
    const r = await post("settings-confirm", { token: tokenOf(page.text) });
    expect(r.status).toBe(303);
    expect(flashOf(r.location)).toEqual({
      type: "ok",
      msg: 'Saved: Test name is now "danger zone".',
    });
    expect(store.get(EVENT_ID)?.testName).toBe("danger zone");
    expect(auditRows).toHaveLength(1);
    expect(auditRows[0]).toMatchObject({
      action: "event.host.settings-confirm",
      result: "success",
    });
  });

  it("a replay of the token after it was used changes nothing and says to review again", async () => {
    const page = await post("settings", dangerous());
    const token = tokenOf(page.text);
    await post("settings-confirm", { token });
    writes.length = 0;
    auditRows = [];
    const r = await post("settings-confirm", { token });
    expect(flashOf(r.location)).toMatchObject({
      type: "err",
      msg: expect.stringContaining("Review the form again"),
    });
    expect(writes).toEqual([]);
    expect(auditRows).toHaveLength(1);
    expect(auditRows[0]).toMatchObject({ result: "failure" });
  });

  it("a token used on another event of the same host is refused", async () => {
    store.set(EVENT_2, makeEvent({}, EVENT_2));
    const page = await post("settings", dangerous());
    const r = await post(
      "settings-confirm",
      { token: tokenOf(page.text) },
      EVENT_2,
    );
    expect(flashOf(r.location).msg).toBe(
      "That confirmation was issued for something else. Nothing was changed.",
    );
    expect(store.get(EVENT_2)?.testName).toBe("a");
    expect(writes).toEqual([]);
  });

  it("a stale token (the event changed after the page) changes nothing", async () => {
    const page = await post("settings", dangerous());
    (store.get(EVENT_ID) as Json).testName = "b";
    const r = await post("settings-confirm", { token: tokenOf(page.text) });
    expect(flashOf(r.location).msg).toContain("Review the form again");
    expect(store.get(EVENT_ID)?.testName).toBe("b");
  });

  it("a missing, forged or tampered token changes nothing", async () => {
    const page = await post("settings", dangerous());
    const token = tokenOf(page.text);
    // The last character is flipped to one that is certainly different.
    const flipped = `${token.slice(0, -1)}${token.endsWith("A") ? "B" : "A"}`;
    expect(flipped).not.toBe(token);
    for (const bad of ["", "abc", `${token}x`, flipped]) {
      auditRows = [];
      const r = await post("settings-confirm", { token: bad });
      expect(flashOf(r.location).msg).toBe(
        "That confirmation is not valid. Nothing was changed.",
      );
      expect(auditRows).toHaveLength(1);
    }
    expect(writes).toEqual([]);
  });

  it("confirmation needs the CSRF token like every host write", async () => {
    const page = await post("settings", dangerous());
    const r = await post(
      "settings-confirm",
      { token: tokenOf(page.text) },
      EVENT_ID,
      { csrf: false },
    );
    expect(r.status).toBe(403);
    expect(store.get(EVENT_ID)?.testName).toBe("a");
  });

  it("an event that ended after the page was shown refuses the confirmation", async () => {
    const page = await post("settings", dangerous());
    (store.get(EVENT_ID) as Json).state = "ended";
    const r = await post("settings-confirm", { token: tokenOf(page.text) });
    expect(flashOf(r.location).msg).toBe(
      "This event is ended, so it can no longer be changed.",
    );
    expect(store.get(EVENT_ID)?.testName).toBe("a");
  });
});

describe("the tick 'also for the next occurrences' (#1266)", () => {
  const recurring = (over: Json = {}): void => {
    store.set(
      EVENT_ID,
      makeEvent({ recurrence: "weekly", seriesId: "series-1", ...over }),
    );
  };
  const TICK = 'name="s_seriesSetup" value="1"';

  it("is offered, unticked, in every group form of an event that repeats, with the base 'off'", async () => {
    recurring();
    const r = await call(panel());
    expect(r.text).toContain(TICK);
    expect(r.text).not.toMatch(/name="s_seriesSetup" value="1" checked/);
    expect(r.text).toContain('name="b_seriesSetup" value="0"');
    // The settings form, the preset, remove and add forms and the switch form each carry it.
    const forms = r.text
      .split("<form ")
      .slice(1)
      .map((f) => f.split("</form>")[0])
      .filter((f) => f.includes(`action="${panel()}/settings"`));
    // Every form that changes the group setup (the save form, add a group, switch
    // groups off) carries the tick; nothing else on the page posts it.
    expect(forms.length).toBeGreaterThanOrEqual(3);
    expect(forms.filter((f) => f.includes(TICK))).toHaveLength(forms.length);
  });

  it("is not offered for a one-off event", async () => {
    const r = await call(panel());
    expect(r.text).not.toContain("s_seriesSetup");
    expect(r.text).not.toContain("Also for the next occurrences");
  });

  it("without the tick a save changes this occurrence only and stores no series setup", async () => {
    recurring();
    const r = await post("settings", {
      s_groupsLocked: "1",
      b_groupsLocked: "0",
      b_seriesSetup: "0",
    });
    expect(flashOf(r.location).type).toBe("ok");
    expect(store.get(EVENT_ID)?.groupsLocked).toBe(true);
    expect(store.get(EVENT_ID)?.seriesGroupSetup).toBeUndefined();
  });

  it("with the tick the same save also stores the setup for the next occurrences, in one audit row", async () => {
    recurring();
    const r = await post("settings", {
      s_groupsLocked: "1",
      b_groupsLocked: "0",
      s_seriesSetup: "1",
      b_seriesSetup: "0",
    });
    expect(flashOf(r.location).type).toBe("ok");
    expect(store.get(EVENT_ID)?.seriesGroupSetup).toMatchObject({
      groupsEnabled: true,
      groupsLocked: true,
      groupLabel: "Squad",
      groups: [{ key: "g_00000001", name: "Heli <b>x</b>", size: 2 }],
    });
    expect(auditRows).toHaveLength(1);
  });

  it("a one-off event refuses the tick and changes nothing", async () => {
    const r = await post("settings", {
      s_seriesSetup: "1",
      b_seriesSetup: "0",
    });
    expect(flashOf(r.location).type).not.toBe("ok");
    expect(store.get(EVENT_ID)?.seriesGroupSetup).toBeUndefined();
  });
});
