/**
 * The host panel's "Team names and tags" section and its reset action (#1196),
 * over real HTTP: real Express, the real session middleware, the real CSRF
 * check, the real host gate (#1189) and the REAL customise writer with its real
 * group lock. Stubbed: the session row, the permission check, the Event model
 * (the in-memory stand-in of `event-customise-fake-event.ts`), the audit table,
 * the nickname tags and the Discord side of the channel rename.
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
  cstore,
  cupdates,
  cfake,
  CEventMock,
  type CDoc,
  type CGroup,
} from "../services/event-customise-fake-event.js";

jest.unstable_mockModule("../../src/models/event.js", () => ({
  EVENT_RECURRENCES: ["none", "weekly", "biweekly", "monthly"],
  EVENT_GROUP_KINDS: ["team", "open", "leads"],
  Event: CEventMock,
}));
jest.unstable_mockModule(
  "../../src/services/tracking-opt-out-service.js",
  () => ({
    TrackingOptOutService: {
      getInstance: () => ({
        admission: () => 1,
        resetAwareWrite: async (
          ids: string[],
          _g: string,
          write: (i: string[]) => Promise<unknown>,
        ) => ({ admitted: ids, value: await write(ids) }),
      }),
    },
  }),
);
const syncMember = jest.fn(async () => "none");
jest.unstable_mockModule("../../src/services/event-nickname-tags.js", () => ({
  EventNicknameTags: {
    getInstance: () => ({
      syncMember,
      requestSweep: jest.fn(),
      getReport: () => null,
    }),
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
const { UserNotificationPrefsService } =
  await import("../../src/services/user-notification-prefs-service.js");

const SECRET = "test-secret-for-host-customise-routes";
const GUILD = "guild-1";
const CREATOR = "111111111111111111";
const STRANGER = "999999999999999991";
const EVENT_ID = "65a000000000000000000001";
const PANEL = `/me/events/${EVENT_ID}/host`;
const RED = "g_00000001";
const BLUE = "g_00000002";
const ANA = "211111111111111111";
const BEN = "222222222222222222";

function group(key: string, over: Partial<CGroup> = {}): CGroup {
  return {
    key,
    name: key === RED ? "Red" : "Blue",
    tag: key === RED ? "RED" : "BLU",
    kind: "team",
    channelId: key === RED ? "200000000000000001" : "200000000000000002",
    captainId: key === RED ? ANA : BEN,
    memberIds: key === RED ? [ANA] : [BEN],
    ...over,
  };
}
function seed(over: Record<string, unknown> = {}): void {
  cstore.set(EVENT_ID, {
    _id: EVENT_ID,
    guildId: GUILD,
    createdBy: CREATOR,
    title: "Clan match",
    description: "",
    state: "active",
    startTime: new Date("2030-01-01T19:00:00Z"),
    timezone: "UTC",
    durationMinutes: 90,
    recurrence: "none",
    groupsEnabled: true,
    groupLabel: "Squad",
    leaderLabel: "Captain",
    captainsEnabled: true,
    captainCustomisationEnabled: true,
    tagsEnabled: true,
    channelId: "main-1",
    groups: [group(RED), group(BLUE)],
    ...over,
  } as unknown as CDoc);
}
const groupOf = (key: string): CGroup =>
  cstore.get(EVENT_ID)!.groups.find((g) => g.key === key)!;

let auditRows: Array<Record<string, unknown>> = [];
let leaderEditRows: Array<Record<string, unknown>> = [];
let memberZone: string | null = null;
let sessionUser = CREATOR;
let eventsOn = true;
let server: Server;
let base = "";
const syncGroupNames = jest.fn(async (_e: string, _g: string, key: string) => [
  { groupKey: key, status: "applied" },
]);

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
    user?: string;
    csrf?: boolean;
    body?: Record<string, string>;
  } = {},
): Promise<{ status: number; text: string; location: string | null }> {
  const method = init.method ?? "GET";
  const form = new globalThis.URLSearchParams();
  if (method !== "GET" && init.csrf !== false) form.set("_csrf", csrf());
  for (const [k, v] of Object.entries(init.body ?? {})) form.set(k, v);
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
const reset = (
  body: Record<string, string>,
  init: Record<string, unknown> = {},
) => call(`${PANEL}/reset-team`, { method: "POST", body, ...init });

beforeAll(async () => {
  process.env.WEBUI_SESSION_SECRET = SECRET;
  process.env.WEBUI_INACTIVITY_TIMEOUT_MINUTES = "30";
  process.env.GUILD_ID = GUILD;
  const app = express();
  app.use(express.urlencoded({ extended: false }));
  app.use(ensureCsrfCookie);
  const client = {
    guilds: { cache: { get: () => undefined } },
  } as never;
  app.use(
    "/me",
    createUserRouter(client, createSessionMiddleware({} as never)),
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
  cstore.clear();
  cupdates.length = 0;
  cfake.beforeNextUpdate = null;
  cfake.failFind = false;
  seed();
  auditRows = [];
  leaderEditRows = [];
  memberZone = null;
  sessionUser = CREATOR;
  eventsOn = true;
  syncGroupNames.mockClear();
  syncMember.mockClear();
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
    isAdministrator: async () => false,
    checkCommandPermission: async () => true,
    resolveWebScopes: async () => ["member", "host"],
  } as never);
  jest.spyOn(UserNotificationPrefsService, "getInstance").mockReturnValue({
    getTimezone: async () => memberZone,
  } as never);
  jest.spyOn(EventService, "getInstance").mockReturnValue({
    getEvent: async (id: string) => {
      const d = cstore.get(id);
      return d ? (JSON.parse(JSON.stringify(d)) as unknown) : null;
    },
    getGroupChannelReport: () => null,
    isEventBeingEnded: () => false,
    syncGroupNames,
  } as never);
  jest.spyOn(ConfigService, "getInstance").mockReturnValue({
    getBoolean: async () => eventsOn,
    getNumber: async (_k: string, f: number) => f,
    getString: async (_k: string, f: string) => f,
  } as never);
  jest.spyOn(WebAuditLog, "create").mockImplementation(async (row: unknown) => {
    auditRows.push(row as Record<string, unknown>);
    return {} as never;
  });
  jest.spyOn(WebAuditLog, "find").mockImplementation((() => ({
    sort: () => ({ limit: () => ({ lean: async () => leaderEditRows }) }),
  })) as never);
});
afterEach(() => {
  jest.restoreAllMocks();
});

describe("the board's reset (#1196, #1424)", () => {
  it("shows each team and a reset only where a leader changed it", async () => {
    groupOf(RED).name = "Crimson <b>";
    groupOf(RED).tag = "CRM";
    groupOf(RED).originalName = "Red";
    groupOf(RED).originalTag = "RED";
    const res = await call(`${PANEL}`);
    expect(res.status).toBe(200);
    expect(res.text).toContain("Crimson &lt;b&gt;");
    expect(res.text).not.toContain("Crimson <b>");
    expect(res.text).toContain(`${PANEL}/reset-team`);
    // One reset form, for the changed team only.
    expect(res.text.match(/action="[^"]*\/reset-team"/g)).toHaveLength(1);
    expect(res.text).toContain(`value="${RED}"`);
    expect(res.text).toContain('name="_csrf"');
    // The reset button sits in the changed team's column only.
    const col = res.text.slice(res.text.indexOf(`data-group="${RED}"`));
    expect(col.slice(0, col.indexOf("</section>"))).toContain(
      "Reset name and tag",
    );
    const blue = res.text.slice(res.text.indexOf(`data-group="${BLUE}"`));
    expect(blue.slice(0, blue.indexOf("</section>"))).not.toContain(
      "Reset name and tag",
    );
  });

  it("lists the recent leader edits with who and what, escaped", async () => {
    leaderEditRows = [
      {
        createdAt: new Date("2030-01-01T19:30:00Z"),
        discordUserId: ANA,
        details: {
          nameFrom: "Red",
          nameTo: "<script>x</script>",
          tagFrom: "RED",
          tagTo: "CRM",
        },
      },
    ];
    // The event is in UTC; the member reads Auckland time (UTC+13 in January).
    memberZone = "Pacific/Auckland";
    const res = await call(`${PANEL}`);
    expect(res.text).toContain("2030-01-02 08:30 (Pacific/Auckland)");
    expect(res.text).not.toContain("2030-01-01T19:30:00.000Z");
    expect(res.text).toContain("&lt;script&gt;x&lt;/script&gt;");
    expect(res.text).not.toContain("<script>x</script>");
    expect(res.text).toContain("tag &quot;RED&quot; to &quot;CRM&quot;");
  });

  it("offers the reset whatever the leaders' switches say", async () => {
    seed({
      captainsEnabled: false,
      captainCustomisationEnabled: false,
      groups: [
        group(RED, {
          name: "Crimson",
          tag: "CRM",
          originalName: "Red",
          originalTag: "RED",
        }),
        group(BLUE),
      ],
    });
    const res = await call(`${PANEL}`);
    expect(res.text).toContain(`${PANEL}/reset-team`);
    expect(res.text).toContain("Reset name and tag");
  });
});

describe("POST reset-team (#1196)", () => {
  function customise(): void {
    groupOf(RED).name = "Crimson";
    groupOf(RED).tag = "CRM";
    groupOf(RED).originalName = "Red";
    groupOf(RED).originalTag = "RED";
  }

  it("puts the name and tag back, finishes the channel and the nicknames, and audits it", async () => {
    customise();
    const res = await reset({ group: RED });
    expect(res.status).toBe(303);
    const flash = flashOf(res.location);
    expect(flash.type).toBe("ok");
    expect(flash.msg).toContain("Team reset to");
    expect(groupOf(RED).name).toBe("Red");
    expect(groupOf(RED).tag).toBe("RED");
    expect(groupOf(RED).originalName).toBeUndefined();
    expect(groupOf(RED).nameSyncPending).toBe(true);
    expect(syncGroupNames).toHaveBeenCalledWith(EVENT_ID, GUILD, RED);
    for (let i = 0; i < 20; i++) await Promise.resolve();
    expect(syncMember).toHaveBeenCalledWith(
      expect.objectContaining({ eventId: EVENT_ID, userId: ANA }),
    );
    const row = auditRows.find((r) => r.action === "event.host.reset-team");
    expect(row).toMatchObject({
      result: "success",
      targetId: EVENT_ID,
      discordUserId: CREATOR,
    });
    expect(row?.details).toMatchObject({
      group: RED,
      nameFrom: "Crimson",
      nameTo: "Red",
    });
  });

  it("works whatever the leaders' switches say", async () => {
    customise();
    seed({
      captainsEnabled: false,
      captainCustomisationEnabled: false,
      groups: [
        group(RED, {
          name: "Crimson",
          tag: "CRM",
          originalName: "Red",
          originalTag: "RED",
        }),
        group(BLUE),
      ],
    });
    const res = await reset({ group: RED });
    expect(flashOf(res.location).type).toBe("ok");
    expect(groupOf(RED).name).toBe("Red");
  });

  it("is refused, and writes nothing, while events.enabled is off", async () => {
    customise();
    eventsOn = false;
    const res = await reset({ group: RED });
    const flash = flashOf(res.location);
    expect(flash.type).toBe("err");
    expect(flash.msg).toContain("events.enabled");
    expect(groupOf(RED).name).toBe("Crimson");
    expect(groupOf(RED).originalName).toBe("Red");
    expect(syncGroupNames).not.toHaveBeenCalled();
  });

  it("a team nobody changed says so and writes nothing", async () => {
    const res = await reset({ group: BLUE });
    const flash = flashOf(res.location);
    expect(flash.type).toBe("ok");
    expect(flash.msg).toContain("already has its original");
    expect(cupdates).toHaveLength(0);
  });

  it("refuses a request without the CSRF token and changes nothing", async () => {
    customise();
    const res = await reset({ group: RED }, { csrf: false });
    expect(res.status).toBe(403);
    expect(groupOf(RED).name).toBe("Crimson");
  });

  it("refuses someone who is not this event's host, with the same answer for an unknown event", async () => {
    customise();
    sessionUser = STRANGER;
    const res = await reset({ group: RED });
    expect(res.status).toBe(403);
    expect(groupOf(RED).name).toBe("Crimson");
    expect(syncGroupNames).not.toHaveBeenCalled();
  });

  it.each([[""], ["not-a-key"], ["g_zzzzzzzz"], [`${RED}x`]])(
    "refuses a bad team key (%j)",
    async (key) => {
      customise();
      const res = await reset({ group: key });
      expect(flashOf(res.location).type).toBe("err");
      expect(groupOf(RED).name).toBe("Crimson");
    },
  );

  it("an unknown team is an error, not a write", async () => {
    const res = await reset({ group: "g_ffffffff" });
    expect(flashOf(res.location).type).toBe("err");
    expect(cupdates).toHaveLength(0);
  });

  it("is refused once the event has ended", async () => {
    customise();
    cstore.get(EVENT_ID)!.state = "ended";
    const res = await reset({ group: RED });
    const flash = flashOf(res.location);
    expect(flash.type).toBe("err");
    expect(flash.msg).toContain("can no longer be changed");
    expect(groupOf(RED).name).toBe("Crimson");
  });

  it("is refused when another team now has the original name, and says why", async () => {
    customise();
    groupOf(BLUE).name = "Red";
    const res = await reset({ group: RED });
    const flash = flashOf(res.location);
    expect(flash.type).toBe("err");
    expect(flash.msg).toContain("Reset that team first");
    expect(groupOf(RED).name).toBe("Crimson");
    const row = auditRows.find((r) => r.action === "event.host.reset-team");
    expect(row).toMatchObject({ result: "failure" });
  });
});
