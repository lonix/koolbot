/**
 * "Your events" for event hosts (#1319), over real HTTP.
 *
 * The real user router, session middleware, host-scope guard and CSRF check
 * run; the session row, scope resolution, the Event model queries, the event
 * service and the audit write are stubbed. The consequential part is who sees
 * and who can change what: a member in an Event host group with no other
 * rights reaches the page, lists and cancels only events they created, and
 * reaches nothing server-wide.
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
import { signValue } from "../../src/web/cookies.js";
import { deriveCsrfToken, ensureCsrfCookie } from "../../src/web/csrf.js";
import { createSessionMiddleware } from "../../src/web/session.js";
import { createUserRouter } from "../../src/web/user-routes.js";
import { WebSessionService } from "../../src/services/web-session-service.js";
import { PermissionsService } from "../../src/services/permissions-service.js";
import { EventService } from "../../src/services/event-service.js";
import { ConfigService } from "../../src/services/config-service.js";
import { WebAuditLog } from "../../src/models/web-audit-log.js";
import { Event } from "../../src/models/event.js";
import { UserNotificationPrefsService } from "../../src/services/user-notification-prefs-service.js";

const SECRET = "test-secret-for-me-events-routes";
const GUILD = "guild-1";
const HOST = "host-1";
const OTHER = "other-1";

interface FakeEvent {
  _id: string;
  guildId: string;
  createdBy: string;
  title: string;
  state: string;
  startTime: Date;
  timezone: string;
  durationMinutes: number;
  recurrence: string;
  seriesId: string | null;
  channelId: string | null;
  nativeAdopted?: boolean;
  nativeCleanupOnly?: boolean;
}

const ID_LIVE = "65a000000000000000000001";
const ID_PLANNED = "65a000000000000000000002";
const ID_ENDED = "65a000000000000000000003";
const ID_FOREIGN = "65a000000000000000000004";

function makeEvent(id: string, over: Partial<FakeEvent> = {}): FakeEvent {
  return {
    _id: id,
    guildId: GUILD,
    createdBy: HOST,
    title: "Quiz night",
    state: "scheduled",
    startTime: new Date("2030-01-01T19:00:00Z"),
    timezone: "UTC",
    durationMinutes: 90,
    recurrence: "none",
    seriesId: null,
    channelId: null,
    ...over,
  };
}

let events: Record<string, FakeEvent> = {};
let findFilters: Array<Record<string, unknown>> = [];
let auditRows: Array<Record<string, unknown>> = [];
let scopes: string[] = ["member", "host"];
let sessionRole: "admin" | "user" = "user";
let sessionUser = HOST;
let eventsEnabled = true;
let memberZone: string | null = null;
let server: Server;
let base = "";
const cancelEvent =
  jest.fn<(id: string, guildId?: string) => Promise<unknown>>();

function cookie(user: string, role: "admin" | "user"): string {
  const now = Date.now();
  const encoded = Buffer.from(
    JSON.stringify({
      sid: "sid-1",
      uid: user,
      gid: GUILD,
      rol: role,
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
    user?: string;
    role?: "admin" | "user";
    csrf?: boolean;
  } = {},
): Promise<{ status: number; text: string; location: string | null }> {
  sessionRole = init.role ?? "user";
  sessionUser = init.user ?? HOST;
  const method = init.method ?? "GET";
  const res = await fetch(`${base}${path}`, {
    method,
    headers: {
      cookie: cookie(sessionUser, sessionRole),
      "content-type": "application/x-www-form-urlencoded",
    },
    body:
      method === "GET"
        ? undefined
        : init.csrf === false
          ? ""
          : `_csrf=${encodeURIComponent(csrf())}`,
    redirect: "manual",
  });
  return {
    status: res.status,
    text: await res.text(),
    location: res.headers.get("location"),
  };
}

/** Evaluates the handful of filter operators `listHostEvents` uses. */
function matches(e: FakeEvent, filter: Record<string, unknown>): boolean {
  const rec = e as unknown as Record<string, unknown>;
  return Object.entries(filter).every(([k, cond]) => {
    if (cond && typeof cond === "object") {
      const c = cond as { $in?: unknown[]; $ne?: unknown };
      if (c.$in) return c.$in.includes(rec[k]);
      if ("$ne" in c) return rec[k] !== c.$ne;
    }
    return rec[k] === cond;
  });
}

beforeAll(async () => {
  process.env.WEBUI_SESSION_SECRET = SECRET;
  process.env.WEBUI_INACTIVITY_TIMEOUT_MINUTES = "30";
  process.env.GUILD_ID = GUILD;
  const app = express();
  app.use(express.urlencoded({ extended: false }));
  app.use(ensureCsrfCookie);
  app.use(
    "/me",
    createUserRouter({} as never, createSessionMiddleware({} as never)),
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
  events = {
    [ID_LIVE]: makeEvent(ID_LIVE, {
      title: "Live quiz",
      state: "active",
      startTime: new Date(Date.now() - 600_000),
      channelId: "c1",
    }),
    [ID_PLANNED]: makeEvent(ID_PLANNED, { title: "Planned quiz" }),
    [ID_ENDED]: makeEvent(ID_ENDED, { title: "Old quiz", state: "ended" }),
    [ID_FOREIGN]: makeEvent(ID_FOREIGN, {
      title: "Secret rally",
      createdBy: OTHER,
    }),
  };
  findFilters = [];
  auditRows = [];
  scopes = ["member", "host"];
  eventsEnabled = true;
  memberZone = null;
  cancelEvent.mockReset();
  cancelEvent.mockImplementation(async (id) => ({
    ...events[id],
    state: "cancelled",
  }));

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
    resolveWebScopeReasons: async () => ({ host: ["Event hosts"], staff: [] }),
  } as never);
  jest.spyOn(UserNotificationPrefsService, "getInstance").mockReturnValue({
    getTimezone: async () => memberZone,
  } as never);
  jest.spyOn(EventService, "getInstance").mockReturnValue({
    getEvent: async (id: string) => events[id] ?? null,
    cancelEvent,
    isEventBeingEnded: () => false,
  } as never);
  jest.spyOn(ConfigService, "getInstance").mockReturnValue({
    getBoolean: async () => false,
    getBooleanStrict: async (key: string) =>
      key === "events.enabled" ? eventsEnabled : false,
    getNumber: async (_k: string, f: number) => f,
    getString: async (_k: string, f: string) => f,
  } as never);
  jest.spyOn(Event, "find").mockImplementation(((
    filter: Record<string, unknown>,
  ) => {
    findFilters.push(filter);
    let rows = Object.values(events).filter((e) => matches(e, filter));
    const chain = {
      sort: (spec: Record<string, number>) => {
        const dir = spec.startTime ?? 1;
        rows = [...rows].sort(
          (a, b) => (a.startTime.getTime() - b.startTime.getTime()) * dir,
        );
        return chain;
      },
      limit: () => chain,
      lean: async () => rows,
    };
    return chain;
  }) as never);
  jest.spyOn(WebAuditLog, "create").mockImplementation(async (row: unknown) => {
    auditRows.push(row as Record<string, unknown>);
    return {} as never;
  });
});

afterEach(() => {
  jest.restoreAllMocks();
});

describe("Your events (#1319)", () => {
  it("lists the host's live, upcoming and past events and nobody else's", async () => {
    const r = await call("/me/events");
    expect(r.status).toBe(200);
    expect(r.text).toContain("Your events");
    expect(r.text).toContain("Live quiz");
    expect(r.text).toContain("Planned quiz");
    expect(r.text).toContain("Old quiz");
    expect(r.text).not.toContain("Secret rally");
    // The query is scoped to the session's guild and user, nothing else.
    expect(findFilters.length).toBeGreaterThan(0);
    for (const f of findFilters) {
      expect(f.createdBy).toBe(HOST);
      expect(f.guildId).toBe(GUILD);
    }
  });

  it("puts Live now first, Upcoming with Edit and Cancel next, Past events folded", async () => {
    const { text } = await call("/me/events");
    const live = text.indexOf('id="live-events"');
    const upcoming = text.indexOf('id="upcoming-events"');
    const past = text.indexOf('id="past-events"');
    expect(live).toBeGreaterThan(-1);
    expect(upcoming).toBeGreaterThan(live);
    expect(past).toBeGreaterThan(upcoming);
    const upcomingHtml = text.slice(upcoming, past);
    expect(upcomingHtml).toContain(`/me/events/${ID_PLANNED}/host/edit`);
    expect(upcomingHtml).toContain(`/me/events/${ID_PLANNED}/host/cancel`);
    // A live event is run from its panel; it has no Cancel here.
    const liveHtml = text.slice(live, upcoming);
    expect(liveHtml).toContain(`/me/events/${ID_LIVE}/host`);
    expect(liveHtml).not.toContain("/cancel");
    // Past events sit in a closed disclosure with no actions.
    expect(text).toMatch(/<details class="kb-disclosure" id="past-events">/);
    expect(text.slice(past)).not.toContain("/cancel");
  });

  it("offers Start now and New event in the header, and says why the person can host", async () => {
    const { text } = await call("/me/events");
    expect(text).toContain('href="/me/events/new?when=now"');
    expect(text).toContain('href="/me/events/new"');
    expect(text).toContain(
      'You can host because you are in <span class="kb-mention">@Event hosts</span>',
    );
  });

  it("leaves out Start now and New event while Events is switched off", async () => {
    eventsEnabled = false;
    const { status, text } = await call("/me/events");
    expect(status).toBe(200);
    expect(text).not.toContain("/me/events/new?when=now");
    expect(text).toContain("Events are switched off");
    expect(text).toContain("Old quiz");
  });

  it("shows no admin link, server-wide setting or other person's event to a host with no other rights", async () => {
    const { text } = await call("/me/events");
    expect(text).not.toContain("/admin");
    expect(text).not.toContain("events.category_id");
    expect(text).not.toContain("Secret rally");
  });

  it("lists only the admin's own events for an admin session too", async () => {
    events[ID_FOREIGN] = makeEvent(ID_FOREIGN, {
      title: "Secret rally",
      createdBy: "admin-1",
    });
    const { text } = await call("/me/events", {
      user: "admin-1",
      role: "admin",
    });
    expect(text).toContain("Secret rally");
    expect(text).not.toContain("Planned quiz");
  });

  it("refuses a member without the host scope, and a moderator only", async () => {
    for (const s of [["member"], ["member", "moderator"], []]) {
      scopes = s;
      const r = await call("/me/events");
      expect(r.status).toBe(403);
      expect(r.text).not.toContain("Planned quiz");
    }
    expect(findFilters).toHaveLength(0);
  });

  it("answers a failed read with a notice, not an empty list", async () => {
    jest.spyOn(Event, "find").mockImplementation((() => {
      throw new Error("db down");
    }) as never);
    const r = await call("/me/events");
    expect(r.status).toBe(200);
    expect(r.text).toContain("could not be read");
    expect(r.text).not.toContain("No upcoming events");
  });
});

describe("Your events times (#1538)", () => {
  it("shows each start in the member's own zone, not the event's", async () => {
    // 2030-01-01 19:00 UTC is 14:00 in New York (the event's zone) and
    // 2030-01-02 08:00 in Auckland (the member's); the server runs elsewhere.
    events[ID_PLANNED] = makeEvent(ID_PLANNED, {
      title: "Planned quiz",
      timezone: "America/New_York",
    });
    memberZone = "Pacific/Auckland";
    const out = await call("/me/events");
    expect(out.text).toContain("2030-01-02 08:00 (Pacific/Auckland)");
    expect(out.text).not.toContain("America/New_York");
    expect(out.text).not.toContain("2030-01-01 14:00");
  });

  it("falls back to the server zone when the member has none", async () => {
    events[ID_PLANNED] = makeEvent(ID_PLANNED, {
      title: "Planned quiz",
      timezone: "America/New_York",
    });
    memberZone = null;
    const out = await call("/me/events");
    expect(out.text).not.toContain("America/New_York");
    expect(out.text).toMatch(/2030-01-0[12] \d\d:\d\d \(\S+\)/);
  });
});

describe("Cancel from Your events (#1319)", () => {
  const cancelPath = (id: string): string => `/me/events/${id}/host/cancel`;

  it("lets the creator cancel a planned event and returns to the list", async () => {
    const r = await call(cancelPath(ID_PLANNED), { method: "POST" });
    expect(r.status).toBe(303);
    expect(r.location).toMatch(/^\/me\/events\?flash=ok/);
    expect(cancelEvent).toHaveBeenCalledWith(ID_PLANNED, GUILD, {
      refuseRunningAt: expect.any(Date),
    });
    expect(auditRows.map((a) => a.action)).toContain("event.host.cancel");
  });

  it("refuses another member, without cancelling or revealing the event", async () => {
    const r = await call(cancelPath(ID_PLANNED), {
      method: "POST",
      user: OTHER,
    });
    expect(r.status).toBe(403);
    expect(r.text).not.toContain("Planned quiz");
    expect(cancelEvent).not.toHaveBeenCalled();
    expect(auditRows.map((a) => a.action)).toContain("event.host.denied");
  });

  it("refuses without the host scope", async () => {
    scopes = ["member"];
    const r = await call(cancelPath(ID_PLANNED), { method: "POST" });
    expect(r.status).toBe(403);
    expect(cancelEvent).not.toHaveBeenCalled();
  });

  it("refuses a post without the CSRF token", async () => {
    const r = await call(cancelPath(ID_PLANNED), {
      method: "POST",
      csrf: false,
    });
    expect(r.status).toBe(403);
    expect(cancelEvent).not.toHaveBeenCalled();
  });

  it("keeps a future event whose channel was prepared early in Upcoming, with Edit and Cancel", async () => {
    const id = "65a000000000000000000009";
    events[id] = makeEvent(id, {
      title: "Prepared quiz",
      state: "active",
      channelId: "c9",
      startTime: new Date(Date.now() + 600_000),
    });
    const { text } = await call("/me/events");
    const live = text.indexOf('id="live-events"');
    const upcoming = text.indexOf('id="upcoming-events"');
    const past = text.indexOf('id="past-events"');
    expect(text.slice(live, upcoming)).not.toContain("Prepared quiz");
    const rows = text.slice(upcoming, past);
    expect(rows).toContain("Prepared quiz");
    expect(rows).toContain(`/me/events/${id}/host/edit`);
    expect(rows).toContain(`/me/events/${id}/host/cancel`);
    const r = await call(cancelPath(id), { method: "POST" });
    expect(r.location).toMatch(/^\/me\/events\?flash=ok/);
    expect(cancelEvent).toHaveBeenCalledWith(id, GUILD, {
      refuseRunningAt: expect.any(Date),
    });
  });

  it("refuses when the claim finds the event running after the gate read", async () => {
    // The gate saw a planned event; the service's own atomic claim refuses.
    cancelEvent.mockResolvedValue({
      ...events[ID_PLANNED],
      state: "active",
      startTime: new Date(Date.now() - 1000),
    });
    const r = await call(cancelPath(ID_PLANNED), { method: "POST" });
    expect(r.location).toMatch(/^\/me\/events\?flash=err/);
    expect(
      decodeURIComponent((r.location ?? "").replace(/\+/g, " ")),
    ).toContain("is running");
    const entry = auditRows.find((a) => a.action === "event.host.cancel");
    expect(entry?.result).toBe("failure");
  });

  it("does not cancel a running event: it is ended from its panel", async () => {
    const r = await call(cancelPath(ID_LIVE), { method: "POST" });
    expect(r.status).toBe(303);
    expect(r.location).toMatch(/^\/me\/events\?flash=err/);
    expect(cancelEvent).not.toHaveBeenCalled();
  });

  it("reports an error when the service did not cancel it", async () => {
    cancelEvent.mockResolvedValue({ ...events[ID_PLANNED], state: "ended" });
    const r = await call(cancelPath(ID_PLANNED), { method: "POST" });
    expect(r.location).toMatch(/^\/me\/events\?flash=err/);
  });

  it("refuses a finished event with the panel's usual message", async () => {
    const r = await call(cancelPath(ID_ENDED), { method: "POST" });
    expect(r.status).toBe(303);
    expect(r.location).toContain(`/me/events/${ID_ENDED}/host?flash=err`);
    expect(cancelEvent).not.toHaveBeenCalled();
  });
});
