/**
 * Editing an upcoming event (#1298), over real HTTP: real Express, the real
 * session middleware, the real CSRF check, the real scope guard and host gate,
 * and the real `EventService.editEvent`. Stubbed: the session row, the
 * permission lookup, the audit write, the event model (a small stateful fake
 * whose `findOneAndUpdate` really matches on the filter, so a lost race is
 * a lost race), and the Discord-facing passes (native sync, announcement edit).
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

let events: Record<string, Json> = {};
/** Runs right before the next conditional write; a hook to lose a race. */
let beforeWrite: (() => void) | null = null;

const clone = (row: Json | undefined): Json | null => {
  if (!row) return null;
  const out: Json = { ...row };
  for (const [k, v] of Object.entries(row)) {
    if (v instanceof Date) out[k] = new Date(v.getTime());
  }
  return out;
};

function same(actual: unknown, want: unknown): boolean {
  if (want instanceof Date) {
    return actual instanceof Date && actual.getTime() === want.getTime();
  }
  if (want && typeof want === "object") {
    const w = want as { $in?: unknown[]; $ne?: unknown };
    if (w.$in) {
      return w.$in.some((x) => (x ?? null) === (actual ?? null));
    }
    if ("$ne" in w) return actual !== w.$ne;
  }
  return (actual ?? null) === (want ?? null);
}

jest.unstable_mockModule("../../src/models/event.js", () => ({
  EVENT_RECURRENCES: ["none", "weekly", "biweekly", "monthly"],
  EVENT_GROUP_KINDS: ["team", "open", "leads"],
  Event: {
    findById: (id: string) => {
      const value = clone(events[id]);
      return {
        lean: async () => value,
        catch: () => Promise.resolve(value),
        then: (ok: (v: unknown) => unknown) => Promise.resolve(value).then(ok),
      };
    },
    findOneAndUpdate: async (
      filter: Json,
      update: { $set: Json },
    ): Promise<Json | null> => {
      beforeWrite?.();
      beforeWrite = null;
      const row = events[filter._id as string];
      if (!row) return null;
      for (const [k, want] of Object.entries(filter)) {
        if (k === "_id") continue;
        const actual = k.includes(".")
          ? k
              .split(".")
              .reduce<unknown>(
                (o, p) => (o as Json | null | undefined)?.[p],
                row,
              )
          : row[k];
        if (!same(actual, want)) return null;
      }
      Object.assign(row, update.$set);
      return clone(row);
    },
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

const SECRET = "test-secret-for-host-edit-routes";
const GUILD = "guild-1";
const CREATOR = "111111111111111111";
const OTHER = "222222222222222222";
const EVENT_ID = "65a000000000000000000001";
const PANEL = `/me/events/${EVENT_ID}/host`;
const EDIT = `${PANEL}/edit`;

/** Far enough ahead that "in the future" never flips during the run. */
const START = new Date("2099-06-01T18:00:00.000Z");

function makeEvent(over: Json = {}): Json {
  return {
    _id: EVENT_ID,
    guildId: GUILD,
    createdBy: CREATOR,
    title: "Quiz night",
    description: "Bring a friend",
    state: "scheduled",
    startTime: new Date(START.getTime()),
    timezone: "UTC",
    durationMinutes: 90,
    channelId: null,
    recurrence: "none",
    seriesId: null,
    reminderSent: true,
    nativeAdopted: false,
    seriesCancelled: false,
    nativeEventId: "native-1",
    announcementChannelId: "ann-ch",
    announcementMessageId: "ann-msg",
    rsvps: [{ userId: "u9", status: "going" }],
    groupsEnabled: false,
    groups: [],
    ...over,
  };
}

let auditRows: Array<Record<string, unknown>> = [];
let sessionUser = CREATOR;
let sessionRole: "user" | "admin" = "user";
let scopes: string[] = ["member", "host"];
let server: Server;
let base = "";
const syncEvent = jest.fn<(e: unknown) => Promise<void>>(async () => undefined);
const linkedStatus = jest.fn<(e: unknown) => Promise<string>>(
  async () => "scheduled",
);
let eventsOn = true;
const updateAnnouncement = jest.fn<(e: unknown) => Promise<boolean>>(
  async () => true,
);
const postAnnouncement = jest.fn<(e: unknown) => Promise<void>>(
  async () => undefined,
);

function fakeClient(): never {
  const guild = { id: GUILD, channels: { cache: new Map() } };
  return {
    guilds: {
      cache: { get: (id: string) => (id === GUILD ? guild : undefined) },
      fetch: async () => guild,
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
      cookie: cookie(sessionUser),
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

/** What the edit form of the stored event carries: its version token, the mode it was rendered in and whether it offered the start. */
async function formState(): Promise<{
  version: string;
  startEditable: string;
  mode: string;
}> {
  const r = await call(EDIT);
  const version = /name="version" value="([^"]+)"/.exec(r.text);
  const start = /name="startEditable" value="([01])"/.exec(r.text);
  const mode = /name="mode" value="(full|limited)"/.exec(r.text);
  if (!version || !start || !mode) {
    throw new Error(`no form state (status ${r.status})`);
  }
  return { version: version[1], startEditable: start[1], mode: mode[1] };
}

async function versionOf(): Promise<string> {
  return (await formState()).version;
}

async function save(
  body: Json,
  init: { version?: string; startEditable?: string; mode?: string } = {},
): Promise<{ status: number; text: string; location: string | null }> {
  const state =
    init.version !== undefined &&
    init.startEditable !== undefined &&
    init.mode !== undefined
      ? {
          version: init.version,
          startEditable: init.startEditable,
          mode: init.mode,
        }
      : await formState();
  return call(EDIT, {
    method: "POST",
    body: {
      title: "Quiz night",
      description: "Bring a friend",
      date: "2099-06-01",
      time: "18:00",
      timezone: "UTC",
      duration: "90",
      version: init.version ?? state.version,
      startEditable: init.startEditable ?? state.startEditable,
      mode: init.mode ?? state.mode,
      ...body,
    },
  });
}

const row = (): Json => events[EVENT_ID];

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
  EventService.reset();
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

beforeEach(() => {
  process.env.WEBUI_SESSION_SECRET = SECRET;
  process.env.GUILD_ID = GUILD;
  (WebSessionService as unknown as { instance: unknown }).instance = null;
  events = { [EVENT_ID]: makeEvent() };
  beforeWrite = null;
  auditRows = [];
  sessionUser = CREATOR;
  sessionRole = "user";
  scopes = ["member", "host"];
  syncEvent.mockClear();
  linkedStatus.mockClear().mockResolvedValue("scheduled");
  eventsOn = true;
  updateAnnouncement.mockClear();
  postAnnouncement.mockClear();

  jest.spyOn(WebSessionService.getInstance(), "findById").mockImplementation(
    async () =>
      ({
        discordUserId: sessionUser,
        guildId: GUILD,
        role: sessionRole,
        scopes: [],
        revokedAt: null,
        expiresAt: new Date(Date.now() + 3_600_000),
      }) as never,
  );
  jest.spyOn(PermissionsService, "getInstance").mockReturnValue({
    isAdministrator: async () => sessionRole === "admin",
    checkCommandPermission: async () => true,
    resolveWebScopes: async () => scopes,
  } as never);
  jest.spyOn(ConfigService, "getInstance").mockReturnValue({
    registerReloadCallback: () => undefined,
    addChangeListener: () => undefined,
    getBoolean: async (key: string) =>
      key === "events.enabled" ? eventsOn : false,
    getNumber: async (_k: string, f: number) => f,
    getString: async (_k: string, f: string) => f,
  } as never);
  jest.spyOn(WebAuditLog, "create").mockImplementation(async (r: unknown) => {
    auditRows.push(r as Record<string, unknown>);
    return {} as never;
  });

  EventService.reset();
  const service = EventService.getInstance(fakeClient()) as unknown as {
    nativeSync: { syncEvent: unknown; linkedStatus: unknown };
    updateAnnouncement: unknown;
    postAnnouncement: unknown;
  };
  service.nativeSync.syncEvent = syncEvent;
  service.nativeSync.linkedStatus = linkedStatus;
  service.updateAnnouncement = updateAnnouncement;
  service.postAnnouncement = postAnnouncement;
  jest
    .spyOn(EventService, "getInstance")
    .mockReturnValue(service as unknown as never);
});

afterEach(() => {
  jest.restoreAllMocks();
});

describe("who may edit", () => {
  it("lets the host edit their own event", async () => {
    const r = await save({ title: "Quiz night 2" });
    expect(r.status).toBe(303);
    expect(flashOf(r.location).type).toBe("ok");
    expect(row().title).toBe("Quiz night 2");
  });

  it("lets an admin session edit an event somebody else created", async () => {
    sessionRole = "admin";
    sessionUser = OTHER;
    scopes = ["member"];
    const r = await save({ title: "By an admin" });
    expect(r.status).toBe(303);
    expect(row().title).toBe("By an admin");
    expect(row().createdBy).toBe(CREATOR);
  });

  it("answers 403 to a host editing somebody else's event, and changes nothing", async () => {
    sessionUser = OTHER;
    const direct = await call(EDIT, {
      method: "POST",
      body: { title: "Hijacked", date: "2099-06-01", time: "18:00" },
    });
    expect(direct.status).toBe(403);
    expect((await call(EDIT)).status).toBe(403);
    expect(row().title).toBe("Quiz night");
    expect(
      auditRows.some(
        (a) => (a as { action?: string }).action === "event.host.denied",
      ),
    ).toBe(true);
    expect(syncEvent).not.toHaveBeenCalled();
  });

  it("answers 403 to a member without the host scope", async () => {
    scopes = ["member"];
    expect((await call(EDIT)).status).toBe(403);
    const post = await call(EDIT, {
      method: "POST",
      body: { title: "Nope", date: "2099-06-01", time: "18:00" },
    });
    expect(post.status).toBe(403);
    expect(row().title).toBe("Quiz night");
  });

  it("refuses a save without a CSRF token", async () => {
    const version = await versionOf();
    const r = await call(EDIT, {
      method: "POST",
      csrf: false,
      body: { title: "No token", date: "2099-06-01", time: "18:00", version },
    });
    expect(r.status).toBe(403);
    expect(row().title).toBe("Quiz night");
  });
});

describe("validation is the create form's", () => {
  const cases: Array<[string, Json, string]> = [
    [
      "a missing title",
      { title: "" },
      "Title, date and time are all required.",
    ],
    ["a missing date", { date: "" }, "Title, date and time are all required."],
    [
      "a title over 100 characters",
      { title: "x".repeat(101) },
      "Title must be 100 characters or fewer.",
    ],
    [
      "a description over 1000 characters",
      { description: "x".repeat(1001) },
      "Description must be 1000 characters or fewer.",
    ],
    [
      "an impossible date",
      { date: "2099-02-30" },
      "Invalid date/time. Use YYYY-MM-DD and 24-hour HH:MM.",
    ],
    [
      "a start in the past",
      { date: "2000-01-01" },
      "The event start time must be in the future.",
    ],
    [
      "a duration of 0",
      { duration: "0" },
      "Duration must be between 1 and 1440 minutes.",
    ],
    [
      "a duration over 1440",
      { duration: "1441" },
      "Duration must be between 1 and 1440 minutes.",
    ],
    [
      "an unknown timezone",
      { timezone: "Mars/Base" },
      "Invalid timezone: Mars/Base",
    ],
  ];

  it.each(cases)(
    "refuses %s with the create form's message",
    async (_n, body, msg) => {
      const r = await save(body);
      expect(r.status).toBe(303);
      expect(flashOf(r.location)).toEqual({ type: "err", msg });
      expect(r.location).toContain(EDIT);
      expect(row().title).toBe("Quiz night");
      expect(row().durationMinutes).toBe(90);
      expect(syncEvent).not.toHaveBeenCalled();
    },
  );
});

describe("a moved start", () => {
  it("stores the new instant in the form's timezone, re-arms the reminder and keeps RSVPs and announcement ids", async () => {
    const r = await save({
      date: "2099-06-02",
      time: "20:30",
      timezone: "Europe/Oslo",
    });
    expect(flashOf(r.location).type).toBe("ok");
    // 20:30 CEST in June is 18:30 UTC.
    expect((row().startTime as Date).toISOString()).toBe(
      "2099-06-02T18:30:00.000Z",
    );
    expect(row().timezone).toBe("Europe/Oslo");
    expect(row().reminderSent).toBe(false);
    expect(row().rsvps).toEqual([{ userId: "u9", status: "going" }]);
    expect(row().announcementMessageId).toBe("ann-msg");
    expect(row().nativeEventId).toBe("native-1");
  });

  it("patches the native event and edits the announcement in place, never reposting", async () => {
    await save({ time: "19:00", title: "Renamed" });
    expect(syncEvent).toHaveBeenCalledTimes(1);
    const synced = syncEvent.mock.calls[0][0] as Json;
    expect(synced.title).toBe("Renamed");
    expect((synced.startTime as Date).toISOString()).toBe(
      "2099-06-01T19:00:00.000Z",
    );
    expect(updateAnnouncement).toHaveBeenCalledTimes(1);
    expect(postAnnouncement).not.toHaveBeenCalled();
  });

  it("keeps the reminder as it was when only the title changes", async () => {
    await save({ title: "Only the title" });
    expect(row().reminderSent).toBe(true);
  });

  it("writes an event.edit audit row with before and after for the changed fields only", async () => {
    await save({ title: "Quiz night 2", duration: "60" });
    const entry = auditRows.find(
      (a) => (a as { action?: string }).action === "event.edit",
    ) as { targetId: string; result: string; details: Json };
    expect(entry.targetId).toBe(EVENT_ID);
    expect(entry.result).toBe("success");
    expect(entry.details).toEqual({
      before: { title: "Quiz night", durationMinutes: 90 },
      after: { title: "Quiz night 2", durationMinutes: 60 },
    });
  });

  it("says nothing was changed, and writes nothing, for an identical form", async () => {
    const r = await save({});
    expect(flashOf(r.location)).toEqual({
      type: "err",
      msg: "Nothing was changed.",
    });
    expect(syncEvent).not.toHaveBeenCalled();
    expect(updateAnnouncement).not.toHaveBeenCalled();
  });
});

describe("the form's markup", () => {
  it("is built from the shared kb- components, with labels tied to their controls", async () => {
    const r = await call(EDIT);
    expect(r.text).toContain('class="kb-pagehead"');
    expect(r.text).toContain('class="kb-panel"');
    expect(r.text).toContain('class="kb-btn kb-btn--primary"');
    for (const name of ["title", "date", "time", "timezone", "duration"]) {
      expect(r.text).toContain(`for="edit-${name}"`);
      expect(r.text).toContain(`id="edit-${name}"`);
    }
    // `form.stack` is an admin-layout class that the /me layout does not load.
    expect(r.text).not.toContain('class="stack"');
  });
});

describe("events switched off", () => {
  it("sends the form and the save back to the panel with the reason, changing nothing", async () => {
    eventsOn = false;
    const get = await call(EDIT);
    expect(get.status).toBe(303);
    expect(flashOf(get.location).msg).toContain("Events are turned off");
    const post = await call(EDIT, {
      method: "POST",
      body: {
        title: "Nope",
        description: "x",
        date: "2099-06-01",
        time: "18:00",
        timezone: "UTC",
        duration: "90",
        version: "x",
      },
    });
    expect(flashOf(post.location).msg).toContain("Events are turned off");
    expect(row().title).toBe("Quiz night");
    expect(syncEvent).not.toHaveBeenCalled();
  });
});

describe("a start held by a running Discord event", () => {
  it.each(["locked", "unknown"])(
    "shows the start as text, keeps the title editable and ignores posted start fields (%s)",
    async (status) => {
      events[EVENT_ID] = makeEvent({ nativeEventId: "n1" });
      linkedStatus.mockResolvedValue(status);
      const page = await call(EDIT);
      expect(page.text).not.toContain('name="date"');
      expect(page.text).not.toContain('name="time"');
      expect(page.text).toContain('name="title"');
      expect(page.text).toContain("cannot move");
      const r = await save({
        title: "Renamed",
        date: "2099-07-09",
        time: "01:00",
      });
      expect(flashOf(r.location).type).toBe("ok");
      expect(row().title).toBe("Renamed");
      expect((row().startTime as Date).toISOString()).toBe(START.toISOString());
    },
  );

  it("keeps the date and time fields while the Discord event is still scheduled", async () => {
    events[EVENT_ID] = makeEvent({ nativeEventId: "n1" });
    const page = await call(EDIT);
    expect(page.text).toContain('name="date"');
  });
});

describe("a form that went stale because the Discord event started", () => {
  it.each(["locked", "unknown"])(
    "refuses the whole save, changing nothing, when the status became %s after the form offered the start",
    async (status) => {
      events[EVENT_ID] = makeEvent({ nativeEventId: "n1" });
      const form = await formState();
      expect(form.startEditable).toBe("1");
      linkedStatus.mockResolvedValue(status);
      const r = await save(
        { title: "Renamed", date: "2099-06-09", description: "New text" },
        form,
      );
      expect(flashOf(r.location).type).toBe("err");
      expect(flashOf(r.location).msg).toContain("cannot move");
      expect(row().title).toBe("Quiz night");
      expect(row().description).toBe("Bring a friend");
      expect(syncEvent).not.toHaveBeenCalled();
      const entry = auditRows.find(
        (a) => (a as { action?: string }).action === "event.edit",
      ) as { result: string };
      expect(entry.result).toBe("failure");
    },
  );

  it("still ignores start fields posted by a form that never offered them", async () => {
    events[EVENT_ID] = makeEvent({ nativeEventId: "n1" });
    linkedStatus.mockResolvedValue("locked");
    const form = await formState();
    expect(form.startEditable).toBe("0");
    const r = await save({ title: "Renamed", date: "2099-06-09" }, form);
    expect(flashOf(r.location).type).toBe("ok");
    expect(row().title).toBe("Renamed");
    expect((row().startTime as Date).toISOString()).toBe(START.toISOString());
  });
});

describe("start fields on a form that did not offer them", () => {
  it("are ignored even when the Discord event has become movable since", async () => {
    events[EVENT_ID] = makeEvent({ nativeEventId: "n1" });
    linkedStatus.mockResolvedValue("locked");
    const form = await formState();
    linkedStatus.mockResolvedValue("scheduled");
    const r = await save({ title: "Renamed", date: "2099-06-09" }, form);
    expect(flashOf(r.location).type).toBe("ok");
    expect(row().title).toBe("Renamed");
    expect((row().startTime as Date).toISOString()).toBe(START.toISOString());
  });
});

describe("an event that has started", () => {
  it("offers only description and duration, and shows title and start as text", async () => {
    events[EVENT_ID] = makeEvent({ state: "active", channelId: "c-main" });
    const r = await call(EDIT);
    expect(r.status).toBe(200);
    expect(r.text).toContain('name="description"');
    expect(r.text).toContain('name="duration"');
    expect(r.text).not.toContain('name="date"');
    expect(r.text).not.toContain('name="title"');
    expect(r.text).toContain("already started");
  });

  it("refuses to move the start or rename it, even when the form is forged", async () => {
    events[EVENT_ID] = makeEvent({ state: "active", channelId: "c-main" });
    const r = await save({
      title: "Renamed",
      date: "2099-07-01",
      time: "10:00",
      description: "New text",
    });
    expect(flashOf(r.location).type).toBe("ok");
    // Title, start and timezone posted for a started event are ignored.
    expect(row().title).toBe("Quiz night");
    expect((row().startTime as Date).toISOString()).toBe(START.toISOString());
    expect(row().description).toBe("New text");
  });

  it("treats a scheduled event whose channel already exists as started", async () => {
    events[EVENT_ID] = makeEvent({ channelId: "c-early" });
    const r = await call(EDIT);
    expect(r.text).not.toContain('name="date"');
  });

  it("treats an event whose start has passed as started", async () => {
    events[EVENT_ID] = makeEvent({
      startTime: new Date(Date.now() - 10 * 60_000),
    });
    const r = await call(EDIT);
    expect(r.text).not.toContain('name="date"');
  });

  it("changes the duration of a running event but not into the past", async () => {
    events[EVENT_ID] = makeEvent({
      state: "active",
      channelId: "c-main",
      startTime: new Date(Date.now() - 30 * 60_000),
    });
    const ok = await save({ duration: "240" });
    expect(flashOf(ok.location).type).toBe("ok");
    expect(row().durationMinutes).toBe(240);
    const bad = await save({ duration: "10" });
    expect(flashOf(bad.location).type).toBe("err");
    expect(flashOf(bad.location).msg).toContain("end the event in the past");
    expect(row().durationMinutes).toBe(240);
  });

  it("can still fix a typo in the description when the start is minutes away", async () => {
    events[EVENT_ID] = makeEvent({
      startTime: new Date(Date.now() + 2 * 60_000),
    });
    const r = await save({ description: "Fixed" });
    expect(flashOf(r.location).type).toBe("ok");
    expect(row().description).toBe("Fixed");
  });
});

/**
 * Only `Date` is faked, so the real HTTP round trips keep working while the
 * clock steps across an event's start.
 */
function fakeClock(at: Date): void {
  jest.useFakeTimers({
    now: at,
    doNotFake: [
      "hrtime",
      "nextTick",
      "performance",
      "queueMicrotask",
      "requestAnimationFrame",
      "cancelAnimationFrame",
      "requestIdleCallback",
      "cancelIdleCallback",
      "setImmediate",
      "clearImmediate",
      "setInterval",
      "clearInterval",
      "setTimeout",
      "clearTimeout",
    ],
  });
}

function clockTo(ms: number): void {
  jest.setSystemTime(ms);
}

function auditOf(): { result: string; errorMessage?: string } | undefined {
  return auditRows.find(
    (a) => (a as { action?: string }).action === "event.edit",
  ) as { result: string; errorMessage?: string } | undefined;
}

const STARTED_MESSAGE =
  "This event has started since you opened the form. Reload to edit what is still open.";

describe("a form saved under a different state than it was rendered in (#1352)", () => {
  const T0 = new Date("2030-03-01T12:00:00.000Z");
  const MINUTE = 60_000;

  beforeEach(() => {
    fakeClock(T0);
  });
  afterEach(() => {
    jest.useRealTimers();
  });

  /** An event five minutes from starting, no channel yet, stored state still `scheduled`. */
  function startsInFiveMinutes(over: Json = {}): void {
    events[EVENT_ID] = makeEvent({
      startTime: new Date(T0.getTime() + 5 * MINUTE),
      ...over,
    });
  }
  const startedBody = (over: Json = {}): Json => ({
    date: "2030-03-01",
    time: "12:05",
    ...over,
  });
  /** `save`, with the form's own start as the default date and time. */
  const saveHere = (
    body: Json,
    form: { version: string; startEditable: string; mode: string },
  ): ReturnType<typeof save> => save(startedBody(body), form);

  it("carries the rendered mode in the form, and the version token covers it", async () => {
    startsInFiveMinutes();
    const full = await formState();
    expect(full.mode).toBe("full");
    clockTo(T0.getTime() + 6 * MINUTE);
    const limited = await formState();
    expect(limited.mode).toBe("limited");
    expect(limited.version).not.toBe(full.version);
  });

  it("refuses a full form submitted after the start, before anything is saved, and audits it", async () => {
    startsInFiveMinutes();
    const form = await formState();
    // The scan has not run: the stored row still says scheduled, no channel.
    clockTo(T0.getTime() + 6 * MINUTE);
    const r = await saveHere(
      startedBody({
        title: "Renamed",
        description: "New text",
        duration: "120",
      }),
      form,
    );
    expect(flashOf(r.location)).toEqual({ type: "err", msg: STARTED_MESSAGE });
    expect(r.location).toContain(EDIT);
    expect(row().title).toBe("Quiz night");
    expect(row().description).toBe("Bring a friend");
    expect(row().durationMinutes).toBe(90);
    expect(syncEvent).not.toHaveBeenCalled();
    expect(updateAnnouncement).not.toHaveBeenCalled();
    expect(auditOf()).toEqual(
      expect.objectContaining({
        result: "failure",
        errorMessage: STARTED_MESSAGE,
      }),
    );
  });

  it("refuses it even when only the description and duration were changed", async () => {
    startsInFiveMinutes();
    const form = await formState();
    clockTo(T0.getTime() + 6 * MINUTE);
    const r = await saveHere(
      startedBody({ description: "New text", duration: "120" }),
      form,
    );
    expect(flashOf(r.location).msg).toBe(STARTED_MESSAGE);
    expect(row().description).toBe("Bring a friend");
    expect(row().durationMinutes).toBe(90);
  });

  it("refuses a full form whose native start was already locked, with a posted title, after the start", async () => {
    startsInFiveMinutes({ nativeEventId: "n1" });
    linkedStatus.mockResolvedValue("locked");
    const form = await formState();
    expect(form).toMatchObject({ mode: "full", startEditable: "0" });
    clockTo(T0.getTime() + 6 * MINUTE);
    const r = await saveHere(
      { title: "Renamed", description: "New text" },
      form,
    );
    expect(flashOf(r.location)).toEqual({ type: "err", msg: STARTED_MESSAGE });
    expect(row().title).toBe("Quiz night");
    expect(row().description).toBe("Bring a friend");
    expect(auditOf()?.result).toBe("failure");
  });

  it("refuses a full form after the channel was created at the lead time", async () => {
    startsInFiveMinutes();
    const form = await formState();
    // The scan has now created the channel and moved the row on.
    row().channelId = "c-lead";
    row().state = "active";
    const r = await saveHere({ title: "Renamed" }, form);
    expect(flashOf(r.location).type).toBe("err");
    expect(row().title).toBe("Quiz night");
  });

  it("still saves a description and a duration from a form that was limited when opened", async () => {
    startsInFiveMinutes();
    clockTo(T0.getTime() + 6 * MINUTE);
    const form = await formState();
    expect(form.mode).toBe("limited");
    // Same clock, later: nothing about a limited form goes stale.
    clockTo(T0.getTime() + 20 * MINUTE);
    const r = await saveHere(
      { description: "New text", duration: "120" },
      form,
    );
    expect(flashOf(r.location).type).toBe("ok");
    expect(row().description).toBe("New text");
    expect(row().durationMinutes).toBe(120);
    expect(auditOf()?.result).toBe("success");
  });

  it("ignores a forged title, start and startEditable on a form that was limited when opened", async () => {
    startsInFiveMinutes();
    clockTo(T0.getTime() + 6 * MINUTE);
    const form = await formState();
    const r = await saveHere(
      {
        title: "Forged",
        date: "2031-01-01",
        time: "01:00",
        timezone: "Europe/Oslo",
        description: "New text",
      },
      { ...form, startEditable: "1" },
    );
    expect(flashOf(r.location).type).toBe("ok");
    expect(row().title).toBe("Quiz night");
    expect((row().startTime as Date).toISOString()).toBe(
      new Date(T0.getTime() + 5 * MINUTE).toISOString(),
    );
    expect(row().timezone).toBe("UTC");
    expect(row().description).toBe("New text");
  });

  it("does not let a full form pass as limited: a changed title is never dropped silently", async () => {
    startsInFiveMinutes();
    const form = await formState();
    const r = await saveHere(
      { title: "Renamed", description: "New text" },
      { ...form, mode: "limited" },
    );
    expect(flashOf(r.location).type).toBe("err");
    expect(flashOf(r.location).msg).toContain("changed since you opened");
    expect(row().title).toBe("Quiz night");
    expect(row().description).toBe("Bring a friend");
  });

  it("does not let a limited form pass as full", async () => {
    startsInFiveMinutes();
    clockTo(T0.getTime() + 6 * MINUTE);
    const form = await formState();
    const r = await saveHere({ title: "Renamed" }, { ...form, mode: "full" });
    expect(flashOf(r.location).type).toBe("err");
    expect(row().title).toBe("Quiz night");
  });

  it.each([
    ["missing", undefined],
    ["unknown", "refused"],
  ])(
    "refuses a form whose mode is %s and tells the host to reload",
    async (_n, mode) => {
      startsInFiveMinutes();
      const form = await formState();
      const r = await call(EDIT, {
        method: "POST",
        body: {
          title: "Renamed",
          description: "New text",
          date: "2030-03-01",
          time: "12:05",
          timezone: "UTC",
          duration: "90",
          version: form.version,
          startEditable: "1",
          ...(mode === undefined ? {} : { mode }),
        },
      });
      expect(flashOf(r.location).type).toBe("err");
      expect(flashOf(r.location).msg).toContain("changed since you opened");
      expect(row().title).toBe("Quiz night");
      expect(auditOf()?.result).toBe("failure");
    },
  );

  it.each([
    ["missing", undefined],
    ["unknown", "refused"],
  ])(
    "refuses a form whose mode is %s before validating its fields",
    async (_n, mode) => {
      startsInFiveMinutes();
      const form = await formState();
      const r = await call(EDIT, {
        method: "POST",
        body: {
          title: "Quiz night",
          description: "Bring a friend",
          date: "2030-03-01",
          time: "12:05",
          timezone: "UTC",
          // Invalid: validation would answer with the duration message.
          duration: "0",
          version: form.version,
          startEditable: "1",
          ...(mode === undefined ? {} : { mode }),
        },
      });
      expect(flashOf(r.location).msg).toContain("changed since you opened");
      expect(flashOf(r.location).msg).not.toContain("Duration");
      expect(auditOf()?.result).toBe("failure");
      expect(row().durationMinutes).toBe(90);
    },
  );

  it("refuses with the reason, before validating the form, when events are off", async () => {
    startsInFiveMinutes();
    const form = await formState();
    eventsOn = false;
    // A blank title would otherwise be reported instead of the real reason.
    const r = await saveHere({ title: "" }, form);
    expect(flashOf(r.location).msg).toContain("Events are turned off");
    expect(r.location).toContain(PANEL);
    expect(r.location).not.toContain(EDIT);
    expect(auditOf()?.result).toBe("failure");
    expect(row().title).toBe("Quiz night");
  });

  it("refuses the whole save, not just the title, while the native create is unresolved", async () => {
    startsInFiveMinutes({
      nativeEventId: null,
      nativeCreateStartedAt: new Date(T0.getTime() - MINUTE),
    });
    const form = await formState();
    const both = await saveHere(
      { title: "Renamed", description: "New text" },
      form,
    );
    expect(flashOf(both.location).type).toBe("err");
    expect(flashOf(both.location).msg).toContain("still being created");
    expect(row().title).toBe("Quiz night");
    expect(row().description).toBe("Bring a friend");
    expect(auditOf()?.result).toBe("failure");
    // The same form with the title as it was saves what changed.
    const rest = await saveHere({ description: "New text" }, form);
    expect(flashOf(rest.location).type).toBe("ok");
    expect(row().description).toBe("New text");
  });

  it("refuses the whole save when the form offered a start that moved and the native create is unresolved", async () => {
    startsInFiveMinutes({
      nativeEventId: null,
      nativeCreateStartedAt: new Date(T0.getTime() - MINUTE),
    });
    const form = await formState();
    const r = await saveHere({ time: "12:30", description: "New text" }, form);
    expect(flashOf(r.location).msg).toContain("still being created");
    expect(row().description).toBe("Bring a friend");
    expect((row().startTime as Date).toISOString()).toBe(
      new Date(T0.getTime() + 5 * MINUTE).toISOString(),
    );
  });

  it("refuses the whole save when the linked Discord event started after the form offered the start, even with the start unchanged", async () => {
    startsInFiveMinutes({ nativeEventId: "n1" });
    const form = await formState();
    expect(form.startEditable).toBe("1");
    linkedStatus.mockResolvedValue("locked");
    const r = await saveHere(
      { description: "New text", duration: "120" },
      form,
    );
    expect(flashOf(r.location).msg).toContain("cannot move");
    expect(row().description).toBe("Bring a friend");
    expect(row().durationMinutes).toBe(90);
    expect(auditOf()?.result).toBe("failure");
  });
});

describe("what is refused", () => {
  it.each([
    ["an ended event", { state: "ended" }, "finished or was cancelled"],
    ["a cancelled event", { state: "cancelled" }, "finished or was cancelled"],
    ["an adopted event", { nativeAdopted: true }, "adopted"],
  ])(
    "refuses %s, with a message, on both GET and POST",
    async (_n, over, text) => {
      events[EVENT_ID] = makeEvent(over);
      const get = await call(EDIT);
      expect(get.status).toBe(303);
      expect(flashOf(get.location).msg).toContain(text);
      const post = await call(EDIT, {
        method: "POST",
        body: {
          title: "Changed",
          date: "2099-06-01",
          time: "18:00",
          version: "x",
        },
      });
      expect(post.status).toBe(303);
      expect(flashOf(post.location).type).toBe("err");
      expect(flashOf(post.location).msg).toContain(text);
      expect(row().title).toBe("Quiz night");
      expect(syncEvent).not.toHaveBeenCalled();
    },
  );
});

describe("a race", () => {
  it("reports a changed event, and writes nothing, when the form is older than the event", async () => {
    const version = await versionOf();
    // Somebody else edited the title since the form was opened.
    row().title = "Edited elsewhere";
    const r = await save({ title: "Mine" }, { version });
    expect(flashOf(r.location).type).toBe("err");
    expect(flashOf(r.location).msg).toContain("changed since you opened");
    expect(row().title).toBe("Edited elsewhere");
    expect(syncEvent).not.toHaveBeenCalled();
  });

  it("loses to a cancel that lands between the check and the write", async () => {
    const version = await versionOf();
    beforeWrite = (): void => {
      row().state = "cancelled";
    };
    const r = await save({ title: "Too late" }, { version });
    expect(flashOf(r.location).msg).toContain("changed since you opened");
    expect(row().title).toBe("Quiz night");
    expect(row().state).toBe("cancelled");
    expect(syncEvent).not.toHaveBeenCalled();
    expect(updateAnnouncement).not.toHaveBeenCalled();
  });

  it("loses to a start (the scan creating the channel) between the check and the write", async () => {
    const version = await versionOf();
    beforeWrite = (): void => {
      row().channelId = "c-lead";
      row().state = "active";
    };
    const r = await save({ date: "2099-06-05" }, { version });
    expect(flashOf(r.location).msg).toContain("changed since you opened");
    expect((row().startTime as Date).toISOString()).toBe(START.toISOString());
  });

  it("audits a rejected write as a failure before the error goes on", async () => {
    const version = await versionOf();
    beforeWrite = (): void => {
      throw new Error("mongo down");
    };
    const r = await save({ title: "Never saved" }, { version });
    expect(r.status).toBe(500);
    const entry = auditRows.find(
      (a) => (a as { action?: string }).action === "event.edit",
    ) as { result: string; errorMessage: string };
    expect(entry.result).toBe("failure");
    expect(entry.errorMessage).toContain("mongo down");
    expect(row().title).toBe("Quiz night");
  });

  it("refuses while an end is in progress", async () => {
    const service = EventService.getInstance(fakeClient()) as unknown as {
      isEventBeingEnded: (id: string) => boolean;
    };
    jest.spyOn(service, "isEventBeingEnded").mockReturnValue(true);
    const r = await call(EDIT);
    expect(r.status).toBe(303);
    expect(flashOf(r.location).msg).toContain("being ended");
  });
});

describe("escaping", () => {
  it("escapes the title and description in the form", async () => {
    events[EVENT_ID] = makeEvent({
      title: `<script>alert("t")</script>`,
      description: `</textarea><img src=x onerror=alert(1)>`,
    });
    const r = await call(EDIT);
    expect(r.status).toBe(200);
    expect(r.text).not.toContain(`<script>alert("t")</script>`);
    expect(r.text).not.toContain("<img src=x");
    expect(r.text).toContain("&lt;script&gt;alert(&quot;t&quot;)");
  });
});

describe("the links", () => {
  it("shows Edit on the host panel of an editable event, a series occurrence included, and not on an adopted one", async () => {
    const own = await call(PANEL);
    expect(own.text).toContain(`href="${EDIT}"`);
    events[EVENT_ID] = makeEvent({ recurrence: "weekly", seriesId: EVENT_ID });
    const series = await call(PANEL);
    expect(series.text).toContain(`href="${EDIT}"`);
    events[EVENT_ID] = makeEvent({ nativeAdopted: true });
    const adopted = await call(PANEL);
    expect(adopted.text).not.toContain(`href="${EDIT}"`);
  });
});

describe("a recurring event", () => {
  beforeEach(() => {
    events[EVENT_ID] = makeEvent({
      recurrence: "weekly",
      seriesId: EVENT_ID,
      occurrenceIndex: 0,
      seriesStart: new Date(START.getTime()),
      nextSpawned: false,
    });
  });

  it("asks how far the change reaches, with neither option pre-chosen", async () => {
    const r = await call(EDIT);
    expect(r.status).toBe(200);
    expect(r.text).toContain('name="scope" value="occurrence"');
    expect(r.text).toContain('name="scope" value="following"');
    expect(r.text).not.toMatch(/name="scope"[^>]*checked/);
    expect(r.text).toContain("This event repeats weekly");
  });

  it("refuses a save without a scope or with an unknown one, changing nothing", async () => {
    for (const body of [{}, { scope: "" }, { scope: "series" }]) {
      const r = await save({ title: "Changed", ...body });
      expect(flashOf(r.location).type).toBe("err");
      expect(flashOf(r.location).msg).toContain("this occurrence only");
    }
    expect(row().title).toBe("Quiz night");
    expect(syncEvent).not.toHaveBeenCalled();
    const failures = auditRows.filter(
      (a) => (a as { action?: string }).action === "event.edit",
    );
    expect(failures).toHaveLength(3);
    expect(failures.every((a) => (a as Json).result === "failure")).toBe(true);
  });

  it("'This occurrence' saves the row, keeps the series' values for the next one and audits the scope", async () => {
    const r = await save({ title: "Special night", scope: "occurrence" });
    expect(flashOf(r.location).type).toBe("ok");
    expect(row().title).toBe("Special night");
    expect(row().seriesTemplate).toEqual({
      title: "Quiz night",
      description: "Bring a friend",
      durationMinutes: 90,
      timezone: "UTC",
    });
    const entry = auditRows.find(
      (a) => (a as { action?: string }).action === "event.edit",
    ) as { details: Json };
    expect(entry.details).toMatchObject({ scope: "occurrence" });
  });

  it("'This and following' writes the changed field to the series and moves the anchor with the start", async () => {
    const r = await save({
      time: "19:30",
      description: "New text",
      scope: "following",
    });
    expect(flashOf(r.location).type).toBe("ok");
    expect(row().seriesTemplate).toEqual({
      title: "Quiz night",
      description: "New text",
      durationMinutes: 90,
      timezone: "UTC",
    });
    expect(row().seriesStart).toEqual(new Date("2099-06-01T19:30:00.000Z"));
    expect(row().startTime).toEqual(new Date("2099-06-01T19:30:00.000Z"));
  });

  it("refuses a stale save when only the stored template changed meanwhile (a series rename, then the row restored)", async () => {
    // Another host renames the series ("This and following"), then restores
    // this row's title ("This occurrence"): every row field is back to what
    // the stale form saw, but the template now holds the series-wide rename.
    const renamed = {
      title: "Series renamed",
      description: "Bring a friend",
      durationMinutes: 90,
      timezone: "UTC",
    };
    const form = await formState();
    beforeWrite = () => {
      row().seriesTemplate = renamed;
    };
    const r = await save(
      { time: "19:30", scope: "occurrence" },
      { ...form, mode: form.mode },
    );
    expect(flashOf(r.location).type).toBe("err");
    expect(flashOf(r.location).msg).toContain("changed since you opened");
    expect(row().seriesTemplate).toEqual(renamed);
    expect(row().startTime).toEqual(START);
  });

  it("refuses an occurrence whose successor already exists", async () => {
    events[EVENT_ID] = makeEvent({
      recurrence: "weekly",
      seriesId: EVENT_ID,
      nextSpawned: true,
    });
    const r = await save({ title: "Changed", scope: "following" });
    expect(flashOf(r.location).msg).toContain("already been created");
    expect(row().title).toBe("Quiz night");
  });
});
