/**
 * Route tests for the event host panel (#1189), over real HTTP.
 *
 * The user router is mounted on a real Express app with the REAL session
 * middleware and the real CSRF check, so path matching (case, trailing and
 * repeated slashes), the session cookie, the role claim and the CSRF token are
 * the production ones. Only the data behind them is stubbed: the session row,
 * the Discord permission check, the event lookup and the audit write.
 *
 * Host versus admin is the consequential part of this surface and one person
 * cannot easily play both roles by hand, so it is covered here.
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
import {
  createHostEventsRouter,
  hostAction,
  HOST_SECTION_RENDERERS,
} from "../../src/web/routes/host-events.js";
import { signFlash } from "../../src/web/http-flash.js";
import { WebSessionService } from "../../src/services/web-session-service.js";
import { PermissionsService } from "../../src/services/permissions-service.js";
import { EventService } from "../../src/services/event-service.js";
import { ConfigService } from "../../src/services/config-service.js";
import { WebAuditLog } from "../../src/models/web-audit-log.js";
import { Event } from "../../src/models/event.js";

const SECRET = "test-secret-for-host-panel-routes";
const GUILD = "guild-1";
const CREATOR = "creator-1";
const OTHER = "other-1";
const ADMIN = "admin-1";

type Role = "admin" | "user";

interface FakeEvent {
  _id: string;
  guildId: string;
  createdBy: string;
  title: string;
  description?: string;
  state: string;
  startTime: Date;
  timezone: string;
  durationMinutes: number;
  channelId: string | null;
  recurrence: string;
  seriesId: string | null;
  groupsEnabled?: boolean;
  groupLabel?: string;
  leaderLabel?: string;
  channelLeadMinutes?: number | null;
  groups?: unknown[];
  nativeAdopted?: boolean;
  nativeCleanupOnly?: boolean;
}

const EVENT_ID = "65a000000000000000000001";

function makeEvent(over: Partial<FakeEvent> = {}): FakeEvent {
  return {
    _id: EVENT_ID,
    guildId: GUILD,
    createdBy: CREATOR,
    title: "Quiz night",
    description: "Bring a pen",
    state: "scheduled",
    startTime: new Date("2030-01-01T19:00:00Z"),
    timezone: "UTC",
    durationMinutes: 90,
    channelId: null,
    recurrence: "none",
    seriesId: null,
    ...over,
  };
}

// The Discord client the router gets; a test gives it a guild cache.
const fakeClient: Record<string, unknown> = {};
let events: Record<string, FakeEvent> = {};
let auditRows: Array<Record<string, unknown>> = [];
let sessionRole: Role = "user";
let sessionUser = CREATOR;
let server: Server;
let base = "";

function cookie(user: string, role: Role): string {
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
    role?: Role;
    csrf?: boolean;
    body?: string;
  } = {},
): Promise<{ status: number; text: string; location: string | null }> {
  sessionRole = init.role ?? "user";
  sessionUser = init.user ?? CREATOR;
  const headers: Record<string, string> = {
    cookie: cookie(sessionUser, sessionRole),
    "content-type": "application/x-www-form-urlencoded",
  };
  const method = init.method ?? "GET";
  const body =
    method === "GET"
      ? undefined
      : `${init.csrf === false ? "" : `_csrf=${encodeURIComponent(csrf())}&`}${init.body ?? ""}`;
  const res = await fetch(`${base}${path}`, {
    method,
    headers,
    body,
    redirect: "manual",
  });
  return {
    status: res.status,
    text: await res.text(),
    location: res.headers.get("location"),
  };
}

beforeAll(async () => {
  process.env.WEBUI_SESSION_SECRET = SECRET;
  process.env.WEBUI_INACTIVITY_TIMEOUT_MINUTES = "30";
  process.env.GUILD_ID = GUILD;
  const client = fakeClient as never;
  const app = express();
  app.use(express.urlencoded({ extended: false }));
  // As in production (createUserWebRouter): exposes the session-bound token.
  app.use(ensureCsrfCookie);
  const router = createUserRouter(client, createSessionMiddleware(client));
  app.use("/me", router);
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
  delete fakeClient.guilds;
  events = { [EVENT_ID]: makeEvent() };
  auditRows = [];

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
    isAdministrator: async () => true,
    checkCommandPermission: async () => true,
    resolveWebScopes: async () => ["member", "host"],
  } as never);
  groupReport = null;
  jest.spyOn(EventService, "getInstance").mockReturnValue({
    getEvent: async (id: string) => events[id] ?? null,
    getGroupChannelReport: () => groupReport,
    isEventBeingEnded: () => false,
  } as never);
  jest.spyOn(ConfigService, "getInstance").mockReturnValue({
    getBoolean: async () => false,
    getBooleanStrict: async () => false,
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

const PANEL = `/me/events/${EVENT_ID}/host`;
// The app mounts the router at /me, so requests go to the full path.
const url = (path: string): string => path;

describe("host panel access", () => {
  it("lets the creator, a non-admin member, open the panel", async () => {
    const r = await call(url(PANEL));
    expect(r.status).toBe(200);
    expect(r.text).toContain("Host panel");
    expect(r.text).toContain("Quiz night");
  });

  it("lets an admin session open another member's event", async () => {
    const r = await call(url(PANEL), { user: ADMIN, role: "admin" });
    expect(r.status).toBe(200);
    expect(r.text).toContain("Quiz night");
  });

  it("refuses another member with 403 and shows nothing of the event", async () => {
    const r = await call(url(PANEL), { user: OTHER, role: "user" });
    expect(r.status).toBe(403);
    expect(r.text).not.toContain("Quiz night");
    expect(r.text).not.toContain("Bring a pen");
  });

  it("answers an unknown event exactly like a foreign one", async () => {
    const unknown = await call(`/me/events/65a0000000000000000000ff/host`);
    const foreign = await call(url(PANEL), { user: OTHER });
    expect(unknown.status).toBe(403);
    expect(unknown.text).toBe(foreign.text);
  });

  it("refuses an event of another guild, even for an admin session", async () => {
    events[EVENT_ID] = makeEvent({ guildId: "guild-2" });
    const asAdmin = await call(url(PANEL), { user: ADMIN, role: "admin" });
    expect(asAdmin.status).toBe(403);
    // The creator id matches, but the guild does not.
    const asCreator = await call(url(PANEL));
    expect(asCreator.status).toBe(403);
  });

  it("refuses a discarded cleanup-only row for everyone", async () => {
    events[EVENT_ID] = makeEvent({ nativeCleanupOnly: true });
    expect((await call(url(PANEL))).status).toBe(403);
    expect((await call(url(PANEL), { role: "admin" })).status).toBe(403);
  });

  it("refuses without a session cookie", async () => {
    const res = await fetch(`${base}${PANEL}`, { redirect: "manual" });
    expect(res.status).toBe(401);
  });

  it("applies the gate to path variants Express treats as the same route", async () => {
    for (const variant of [
      `${PANEL}/`,
      `//me/events/${EVENT_ID}/host`,
      `/ME/events/${EVENT_ID}/HOST`,
      `${PANEL}//`,
    ]) {
      const r = await call(variant, { user: OTHER });
      expect([403, 404]).toContain(r.status);
      expect(r.text).not.toContain("Quiz night");
    }
    // The creator reaches the page through the trailing-slash variant, which
    // shows the variants really are routed to the handler.
    expect((await call(`${PANEL}/`)).status).toBe(200);
  });

  it("does not trim or case-fold the creator id", async () => {
    events[EVENT_ID] = makeEvent({ createdBy: "Creator-1" });
    expect((await call(url(PANEL))).status).toBe(403);
  });
});

let groupReport: {
  warnings: string[];
  failures: Array<{ key: string; name: string; reason: string }>;
} | null = null;

describe("host panel page", () => {
  it("shows what the last group channel pass could not do, escaped (#1190)", async () => {
    events[EVENT_ID] = makeEvent({
      groupsEnabled: true,
      groups: [
        {
          key: "g_1",
          name: "Reds",
          kind: "team",
          size: null,
          tag: "",
          marker: "",
          channelId: null,
          captainId: null,
          memberIds: [],
        },
      ],
    });
    groupReport = {
      warnings: ["The bot lacks Manage Channels <here>"],
      failures: [{ key: "g_1", name: "Reds", reason: "Discord refused: full" }],
    };
    const r = await call(url(PANEL));
    expect(r.text).toContain("Some group channels could not be set up");
    expect(r.text).toContain("The bot lacks Manage Channels &lt;here&gt;");
    expect(r.text).toContain("Reds: Discord refused: full");
    expect(r.text).not.toContain("<here>");
    // Nothing is shown when the pass had nothing to report.
    groupReport = null;
    const clean = await call(url(PANEL));
    expect(clean.text).not.toContain("could not be set up");
  });

  it("shows groups and the control sections of a scheduled event", async () => {
    events[EVENT_ID] = makeEvent({
      groupsEnabled: true,
      groupLabel: "Team",
      channelLeadMinutes: 30,
      groups: [
        {
          key: "g_1",
          name: "Reds <b>",
          kind: "team",
          size: 4,
          tag: "RED",
          marker: "🔴",
          channelId: null,
          captainId: null,
          memberIds: ["a", "b"],
        },
      ],
    });
    const r = await call(url(PANEL));
    expect(r.status).toBe(200);
    expect(r.text).toContain("Reds &lt;b&gt;");
    expect(r.text).not.toContain("Reds <b>");
    for (const id of ["board", "end", "settings", "groupchanges"]) {
      expect(r.text).toContain(`id="host-${id}"`);
    }
    expect(r.text).toContain("30 minutes before the start");
  });

  it("labels the main voice channel from the guild cache, and shows a gone one by its id (#1394)", async () => {
    events[EVENT_ID] = makeEvent({ channelId: "vc1" });
    fakeClient.guilds = {
      cache: new Map([
        [
          GUILD,
          {
            channels: {
              cache: new Map([["vc1", { name: "Quiz room", type: 2 }]]),
            },
          },
        ],
      ]),
    };
    const live = await call(url(PANEL));
    expect(live.text).toContain('aria-label="Voice channel"');
    expect(live.text).toContain("Quiz room</span>");

    events[EVENT_ID] = makeEvent({ channelId: "gone1" });
    const gone = await call(url(PANEL));
    expect(gone.text).toContain("gone1 (unavailable)");
    expect(gone.text).not.toContain("Quiz room");
  });

  it("shows the Captains lobby as one line, never as a row of the group table (#1251)", async () => {
    const group = (
      key: string,
      name: string,
      kind: string,
      channelId = null,
    ) => ({
      key,
      name,
      kind,
      size: null,
      tag: "",
      marker: "",
      channelId,
      captainId: null,
      memberIds: [],
    });
    events[EVENT_ID] = makeEvent({
      groupsEnabled: true,
      captainsEnabled: true,
      groups: [
        group("g_1", "Reds", "team"),
        group("g_2", "Hidden command room", "leads"),
      ],
    } as never);
    const r = await call(url(PANEL));
    expect(r.status).toBe(200);
    expect(r.text).toContain("Reds");
    expect(r.text).not.toContain("Hidden command room");
    expect(r.text).not.toContain("Leaders only");
    expect(r.text).toContain(
      "Captains lobby:</strong> on, only you and the current leaders can join; its channel is not created yet.",
    );
    // With leaders off the line says who can really join.
    events[EVENT_ID] = makeEvent({
      groupsEnabled: true,
      captainsEnabled: false,
      groups: [
        group("g_1", "Reds", "team"),
        group("g_2", "Hidden command room", "leads", "c-lobby" as never),
      ],
    } as never);
    const off = await call(url(PANEL));
    expect(off.text).toContain(
      "on, leaders are off, so only you can join; its channel is created.",
    );
    // No lobby, no line.
    events[EVENT_ID] = makeEvent({
      groupsEnabled: true,
      groups: [group("g_1", "Reds", "team")],
    } as never);
    expect((await call(url(PANEL))).text).not.toContain("Captains lobby:");
  });

  it("a legacy event with only a leads group still shows the lobby's status and the channel warnings, not 'no groups' (#1251)", async () => {
    events[EVENT_ID] = makeEvent({
      groupsEnabled: true,
      captainsEnabled: true,
      groups: [
        {
          key: "g_1",
          name: "Hidden command room",
          kind: "leads",
          size: null,
          tag: "",
          marker: "",
          channelId: null,
          captainId: null,
          memberIds: [],
        },
      ],
    } as never);
    groupReport = {
      warnings: [],
      failures: [
        { key: "g_1", name: "Hidden command room", reason: "Discord refused" },
      ],
    };
    const r = await call(url(PANEL));
    expect(r.status).toBe(200);
    expect(r.text).not.toContain("This event has no groups.");
    expect(r.text).toContain("Captains lobby:</strong> on");
    expect(r.text).toContain("its channel is not created yet");
    expect(r.text).toContain("Some group channels could not be set up");
    expect(r.text).toContain("Discord refused");
    // No group is listed, so no empty table.
    expect(r.text).not.toContain('<thead><tr><th scope="col">Group</th>');
    groupReport = null;
  });

  it("shows only the sections that apply to a plain event", async () => {
    const r = await call(url(PANEL));
    expect(r.text).toContain("This event has no groups.");
    expect(r.text).toContain('id="host-end"');
    expect(r.text).not.toContain('id="host-board"');
    // Switching groups on is still offered, from the second fold.
    expect(r.text).toContain('id="host-groupchanges"');
  });

  it("is a read-only summary for ended and cancelled events", async () => {
    for (const state of ["ended", "cancelled"]) {
      events[EVENT_ID] = makeEvent({ state });
      const r = await call(url(PANEL));
      expect(r.status).toBe(200);
      expect(r.text).toContain("read-only summary");
      expect(r.text).not.toContain('id="host-end"');
    }
  });

  it("renders a signed flash and ignores a forged one", async () => {
    const msg = "Saved it.";
    const ok = await call(
      `${PANEL}?flash=ok&msg=${encodeURIComponent(msg)}&sig=${encodeURIComponent(signFlash("ok", msg))}`,
    );
    expect(ok.text).toContain("Saved it.");
    const forged = await call(`${PANEL}?flash=err&msg=Pwned&sig=nope`);
    expect(forged.text).not.toContain("Pwned");
    const unsigned = await call(`${PANEL}?flash=err&msg=Pwned`);
    expect(unsigned.text).not.toContain("Pwned");
  });
});

describe("host write plumbing", () => {
  // No real write action exists yet (later issues add them), so register a
  // stand-in on a router built like the production one and mount it beside
  // the real user router, behind the same session middleware.
  let probeServer: Server;
  let probeBase = "";
  let handled = 0;

  beforeAll(async () => {
    const client = {} as never;
    const app = express();
    app.use(express.urlencoded({ extended: false }));
    // As in production (createUserWebRouter): exposes the session-bound token.
    app.use(ensureCsrfCookie);
    const host = createHostEventsRouter(client);
    hostAction(host, "probe", "/probe", async ({ event }) => {
      handled++;
      return {
        ok: true,
        message: `Probed ${event.title}`,
        details: { note: "x".repeat(1000) },
      };
    });
    hostAction(
      host,
      "probefinished",
      "/probe-finished",
      async () => {
        handled++;
        return { ok: true, message: "ok" };
      },
      { allowFinished: true },
    );
    const me = express.Router();
    me.use(createSessionMiddleware(client));
    me.use("/events/:id/host", host);
    app.use("/me", me);
    await new Promise<void>((resolve) => {
      probeServer = app.listen(0, "127.0.0.1", resolve);
    });
    probeBase = `http://127.0.0.1:${(probeServer.address() as AddressInfo).port}`;
  });

  afterAll(async () => {
    await new Promise<void>((resolve) => probeServer.close(() => resolve()));
  });

  beforeEach(() => {
    handled = 0;
  });

  async function post(
    user: string,
    role: Role,
    withCsrf: boolean,
    path = "/probe",
  ): Promise<{ status: number; location: string | null }> {
    sessionRole = role;
    sessionUser = user;
    const res = await fetch(`${probeBase}${PANEL}${path}`, {
      method: "POST",
      headers: {
        cookie: cookie(user, role),
        "content-type": "application/x-www-form-urlencoded",
      },
      body: withCsrf ? `_csrf=${encodeURIComponent(csrf())}` : "",
      redirect: "manual",
    });
    return { status: res.status, location: res.headers.get("location") };
  }

  it("refuses a write without a CSRF token before anything runs", async () => {
    const r = await post(CREATOR, "user", false);
    expect(r.status).toBe(403);
    expect(handled).toBe(0);
    expect(auditRows).toHaveLength(0);
  });

  it("refuses and audits a write from someone who is not the host", async () => {
    const r = await post(OTHER, "user", true);
    expect(r.status).toBe(403);
    expect(handled).toBe(0);
    expect(auditRows).toHaveLength(1);
    expect(auditRows[0]).toMatchObject({
      action: "event.host.denied",
      targetId: EVENT_ID,
      discordUserId: OTHER,
      result: "failure",
    });
  });

  it("runs the action for the host, audits it with the event id and redirects with a signed flash", async () => {
    const r = await post(CREATOR, "user", true);
    expect(handled).toBe(1);
    expect(r.status).toBe(303);
    const loc = new URL(r.location ?? "", "http://x");
    expect(loc.pathname).toBe(PANEL);
    expect(loc.searchParams.get("msg")).toBe("Probed Quiz night");
    expect(loc.searchParams.get("sig")).toBe(
      signFlash("ok", "Probed Quiz night"),
    );
    expect(auditRows).toHaveLength(1);
    expect(auditRows[0]).toMatchObject({
      action: "event.host.probe",
      targetId: EVENT_ID,
      discordUserId: CREATOR,
      role: "user",
      result: "success",
    });
    // Details are bounded before they are stored.
    const note = (auditRows[0].details as { note: string }).note;
    expect(note.length).toBeLessThanOrEqual(260);
  });

  it("lets an admin session run the action on someone else's event", async () => {
    const r = await post(ADMIN, "admin", true);
    expect(r.status).toBe(303);
    expect(auditRows[0]).toMatchObject({
      action: "event.host.probe",
      discordUserId: ADMIN,
      role: "admin",
    });
  });

  it("refuses a write against an ended or cancelled event and audits the refusal", async () => {
    for (const state of ["ended", "cancelled"]) {
      auditRows = [];
      events[EVENT_ID] = makeEvent({ state });
      const r = await post(CREATOR, "user", true);
      expect(r.status).toBe(303);
      expect(handled).toBe(0);
      const loc = new URL(r.location ?? "", "http://x");
      expect(loc.searchParams.get("flash")).toBe("err");
      expect(loc.searchParams.get("msg")).toContain(`is ${state}`);
      expect(auditRows).toHaveLength(1);
      expect(auditRows[0]).toMatchObject({
        action: "event.host.probe",
        targetId: EVENT_ID,
        result: "failure",
      });
    }
  });

  it("runs an action that opts in to finished events", async () => {
    events[EVENT_ID] = makeEvent({ state: "ended" });
    const r = await post(CREATOR, "user", true, "/probe-finished");
    expect(r.status).toBe(303);
    expect(handled).toBe(1);
    expect(auditRows[0]).toMatchObject({
      action: "event.host.probefinished",
      result: "success",
    });
  });
});

describe("control sections supplied by later issues", () => {
  afterEach(() => {
    delete HOST_SECTION_RENDERERS.end;
  });

  it("get the CSRF token and action path, may be async, and run only for open events", async () => {
    const seen: string[] = [];
    HOST_SECTION_RENDERERS.end = async (ctx) => {
      seen.push(ctx.event.state);
      await Promise.resolve();
      return `<form method="POST" action="${ctx.actionPath("end")}"><input type="hidden" name="_csrf" value="${ctx.csrfToken}">END FORM</form>`;
    };
    const open = await call(url(PANEL));
    expect(open.text).toContain("END FORM");
    expect(open.text).toContain(`action="${PANEL}/end"`);
    expect(open.text).toContain(`value="${csrf()}"`);
    events[EVENT_ID] = makeEvent({ state: "ended" });
    const ended = await call(url(PANEL));
    expect(ended.text).not.toContain("END FORM");
    expect(seen).toEqual(["scheduled"]);
  });
});

describe("links to the host panel", () => {
  it("lists the member's open events on the overview", async () => {
    jest.spyOn(Event, "find").mockReturnValue({
      sort: () => ({
        limit: () => ({
          lean: async () => [
            {
              _id: EVENT_ID,
              title: "Quiz <night>",
              startTime: new Date("2030-01-01T19:00:00Z"),
              timezone: "UTC",
              state: "scheduled",
            },
          ],
        }),
      }),
    } as never);
    const r = await call("/me/");
    expect(r.status).toBe(200);
    expect(r.text).toContain(`href="${PANEL}"`);
    expect(r.text).toContain("Quiz &lt;night&gt;");
    expect(Event.find).toHaveBeenCalledWith(
      expect.objectContaining({
        guildId: GUILD,
        createdBy: CREATOR,
        state: { $in: ["scheduled", "active"] },
      }),
    );
  });

  it("still renders the overview when the lookup fails", async () => {
    jest.spyOn(Event, "find").mockImplementation(() => {
      throw new Error("db down");
    });
    const r = await call("/me/");
    expect(r.status).toBe(200);
    expect(r.text).not.toContain("Events you host");
  });
});
