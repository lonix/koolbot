/**
 * The host's cover image (#1393): `POST /me/events/:id/host/cover` and
 * `/cover/remove`, and the cover panel on the edit page. Real HTTP through the
 * real session middleware, CSRF check, scope guard and host gate, the real raw
 * body parser and the real validation in `services/event-cover.ts`. Stubbed:
 * the session row, the permission lookup, the audit write and the Mongo models.
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
const imageUpsert = jest.fn<(...a: unknown[]) => Promise<unknown>>(
  async () => ({}),
);
const imageDelete = jest.fn<(...a: unknown[]) => Promise<unknown>>(
  async () => ({}),
);
const eventUpdateMany = jest.fn<(...a: unknown[]) => Promise<unknown>>(
  async () => ({}),
);

jest.unstable_mockModule("../../src/models/event-image.js", () => ({
  EventImage: { findOneAndUpdate: imageUpsert, deleteOne: imageDelete },
}));
jest.unstable_mockModule("../../src/models/event.js", () => ({
  EVENT_RECURRENCES: ["none", "weekly", "biweekly", "monthly"],
  EVENT_GROUP_KINDS: ["team", "open", "leads"],
  Event: {
    findById: (id: string) => {
      const value = events[id] ? { ...events[id] } : null;
      return {
        lean: async () => value,
        catch: () => Promise.resolve(value),
        then: (ok: (v: unknown) => unknown) => Promise.resolve(value).then(ok),
      };
    },
    updateMany: eventUpdateMany,
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
const { COVER_MAX_BYTES } = await import("../../src/services/event-cover.js");

const SECRET = "test-secret-for-host-cover-routes";
const GUILD = "guild-1";
const CREATOR = "111111111111111111";
const OTHER = "222222222222222222";
const EVENT_ID = "65a000000000000000000001";
const PANEL = `/me/events/${EVENT_ID}/host`;
const COVER = `${PANEL}/cover`;
const REMOVE = `${PANEL}/cover/remove`;
const EDIT = `${PANEL}/edit`;

const PNG = Buffer.concat([
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
  Buffer.from("not really a picture, but it has the signature"),
]);

function makeEvent(over: Json = {}): Json {
  return {
    _id: EVENT_ID,
    guildId: GUILD,
    createdBy: CREATOR,
    title: "Quiz night",
    description: "",
    state: "scheduled",
    startTime: new Date("2099-06-01T18:00:00.000Z"),
    timezone: "UTC",
    durationMinutes: 90,
    recurrence: "none",
    seriesId: null,
    nativeAdopted: false,
    nativeDetached: false,
    nativeCleanupOnly: false,
    nextSpawned: false,
    seriesCancelled: false,
    coverHash: null,
    groupsEnabled: false,
    groups: [],
    ...over,
  };
}

let auditRows: Array<Record<string, unknown>> = [];
let sessionUser = CREATOR;
let sessionRole: "user" | "admin" = "user";
let scopes: string[] = ["member", "host"];
let eventsOn = true;
let server: Server;
let base = "";

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

async function upload(
  path: string,
  body: Buffer,
  init: { csrf?: boolean; json?: boolean; type?: string } = {},
): Promise<{ status: number; text: string; location: string | null }> {
  const headers: Record<string, string> = {
    cookie: cookie(sessionUser),
    "content-type": init.type ?? "application/octet-stream",
  };
  if (init.csrf !== false) headers["x-csrf-token"] = csrf();
  if (init.json !== false) {
    headers.accept = "application/json";
    headers["x-requested-with"] = "fetch";
  }
  const res = await fetch(`${base}${path}`, {
    method: "POST",
    headers,
    body: new Uint8Array(body),
    redirect: "manual",
  });
  return {
    status: res.status,
    text: await res.text(),
    location: res.headers.get("location"),
  };
}

async function form(
  path: string,
  init: { csrf?: boolean } = {},
): Promise<{ status: number; text: string; location: string | null }> {
  const params = new globalThis.URLSearchParams();
  if (init.csrf !== false) params.set("_csrf", csrf());
  const res = await fetch(`${base}${path}`, {
    method: "POST",
    headers: {
      cookie: cookie(sessionUser),
      "content-type": "application/x-www-form-urlencoded",
    },
    body: params.toString(),
    redirect: "manual",
  });
  return {
    status: res.status,
    text: await res.text(),
    location: res.headers.get("location"),
  };
}

async function page(path: string): Promise<{ status: number; text: string }> {
  const res = await fetch(`${base}${path}`, {
    headers: { cookie: cookie(sessionUser) },
    redirect: "manual",
  });
  return { status: res.status, text: await res.text() };
}

function flashOf(location: string | null): { type: string; msg: string } {
  const q = new globalThis.URL(location ?? "", "http://x").searchParams;
  return { type: q.get("flash") ?? "", msg: q.get("msg") ?? "" };
}

const lastAudit = (): Record<string, unknown> | undefined =>
  auditRows[auditRows.length - 1];

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
  auditRows = [];
  sessionUser = CREATOR;
  sessionRole = "user";
  scopes = ["member", "host"];
  eventsOn = true;
  imageUpsert.mockClear();
  imageDelete.mockClear();
  eventUpdateMany.mockClear();

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
  const service = EventService.getInstance(fakeClient());
  jest.spyOn(EventService, "getInstance").mockReturnValue(service);
});

afterEach(() => {
  jest.restoreAllMocks();
});

describe("uploading a cover", () => {
  it("stores the image for the host's own event and audits it", async () => {
    const r = await upload(COVER, PNG);
    expect(r.status).toBe(200);
    const body = JSON.parse(r.text) as Json;
    expect(body.type).toBe("ok");
    expect(String(body.reload)).toMatch(new RegExp(`^${EDIT}\\?flash=ok`));
    expect(imageUpsert).toHaveBeenCalledTimes(1);
    expect(imageUpsert.mock.calls[0][0]).toEqual({
      guildId: GUILD,
      key: EVENT_ID,
    });
    expect(eventUpdateMany).toHaveBeenCalledTimes(1);
    expect(lastAudit()).toMatchObject({
      action: "event.host.cover-set",
      targetId: EVENT_ID,
      result: "success",
    });
  });

  it("answers a plain post with a redirect back to the edit page", async () => {
    const r = await upload(COVER, PNG, { json: false });
    expect(r.status).toBe(303);
    expect(r.location?.startsWith(EDIT)).toBe(true);
    expect(flashOf(r.location).type).toBe("ok");
  });

  it("says the cover is shared by the whole series", async () => {
    events[EVENT_ID] = makeEvent({
      recurrence: "weekly",
      seriesId: "series-1",
    });
    const r = await upload(COVER, PNG);
    expect((JSON.parse(r.text) as Json).text).toMatch(/whole series/);
    expect(imageUpsert.mock.calls[0][0]).toEqual({
      guildId: GUILD,
      key: "series-1",
    });
  });

  it("rejects a file that is not an image by its signature, whatever the type says", async () => {
    const r = await upload(COVER, Buffer.from("<html>not an image</html>"), {
      type: "application/octet-stream",
    });
    const body = JSON.parse(r.text) as Json;
    expect(body.type).toBe("err");
    expect(String(body.text)).toMatch(/PNG, JPEG or GIF/);
    expect(imageUpsert).not.toHaveBeenCalled();
    expect(lastAudit()).toMatchObject({
      action: "event.host.cover-set",
      result: "failure",
    });
  });

  it("rejects an image over the size cap", async () => {
    const big = Buffer.concat([PNG, Buffer.alloc(COVER_MAX_BYTES)]);
    const r = await upload(COVER, big);
    expect(JSON.parse(r.text)).toMatchObject({
      type: "err",
      text: expect.stringMatching(/too large/),
    });
    expect(imageUpsert).not.toHaveBeenCalled();
  });

  it("rejects an empty body", async () => {
    const r = await upload(COVER, Buffer.alloc(0));
    expect((JSON.parse(r.text) as Json).type).toBe("err");
    expect(imageUpsert).not.toHaveBeenCalled();
  });

  it("refuses without a CSRF token", async () => {
    const r = await upload(COVER, PNG, { csrf: false });
    expect(r.status).toBe(403);
    expect(imageUpsert).not.toHaveBeenCalled();
  });

  it("answers 403 to a host uploading to somebody else's event", async () => {
    sessionUser = OTHER;
    const r = await upload(COVER, PNG);
    expect(r.status).toBe(403);
    expect(imageUpsert).not.toHaveBeenCalled();
    expect(auditRows.some((a) => a.action === "event.host.denied")).toBe(true);
  });

  it("answers 403 to a member without the host scope", async () => {
    scopes = ["member"];
    expect((await upload(COVER, PNG)).status).toBe(403);
    expect(imageUpsert).not.toHaveBeenCalled();
  });

  it("lets an administrator upload to somebody else's event", async () => {
    sessionRole = "admin";
    sessionUser = OTHER;
    scopes = ["member"];
    const r = await upload(COVER, PNG);
    expect((JSON.parse(r.text) as Json).type).toBe("ok");
  });

  it.each([
    ["cancelled", { state: "cancelled" }],
    ["ended", { state: "ended" }],
    ["adopted", { nativeAdopted: true }],
    ["no longer mirrored", { nativeDetached: true }],
  ])("refuses a %s event and stores nothing", async (_n, over) => {
    events[EVENT_ID] = makeEvent(over);
    const r = await upload(COVER, PNG);
    expect((JSON.parse(r.text) as Json).type).toBe("err");
    expect(imageUpsert).not.toHaveBeenCalled();
    expect(lastAudit()).toMatchObject({ result: "failure" });
  });

  it("refuses while Events is switched off", async () => {
    eventsOn = false;
    const r = await upload(COVER, PNG);
    expect((JSON.parse(r.text) as Json).type).toBe("err");
    expect(imageUpsert).not.toHaveBeenCalled();
  });
});

describe("storage that throws", () => {
  it("audits a failed set for the actor, forwards the error, and leaves the rows alone", async () => {
    imageUpsert.mockRejectedValueOnce(new Error("mongo down"));
    const r = await upload(COVER, PNG);
    expect(r.status).toBe(500);
    expect(lastAudit()).toMatchObject({
      action: "event.host.cover-set",
      targetId: EVENT_ID,
      result: "failure",
      errorMessage: "mongo down",
      discordUserId: CREATOR,
    });
    // The image is written first, so the rows were never pointed at it.
    expect(eventUpdateMany).not.toHaveBeenCalled();
  });

  it("audits a failed remove for the actor and forwards the error", async () => {
    events[EVENT_ID] = makeEvent({ coverHash: "abc" });
    imageDelete.mockRejectedValueOnce(new Error("mongo down"));
    const r = await form(REMOVE);
    expect(r.status).toBe(500);
    expect(lastAudit()).toMatchObject({
      action: "event.host.cover-remove",
      targetId: EVENT_ID,
      result: "failure",
      errorMessage: "mongo down",
    });
  });
});

describe("removing a cover", () => {
  it("clears the rows and deletes the image, and returns to the edit page", async () => {
    events[EVENT_ID] = makeEvent({ coverHash: "abc" });
    const r = await form(REMOVE);
    expect(r.status).toBe(303);
    expect(r.location?.startsWith(EDIT)).toBe(true);
    expect(flashOf(r.location).type).toBe("ok");
    expect(imageDelete).toHaveBeenCalledWith({ guildId: GUILD, key: EVENT_ID });
    expect(lastAudit()).toMatchObject({
      action: "event.host.cover-remove",
      result: "success",
    });
  });

  it("refuses without CSRF, for another host and for a finished event", async () => {
    expect((await form(REMOVE, { csrf: false })).status).toBe(403);
    sessionUser = OTHER;
    expect((await form(REMOVE)).status).toBe(403);
    sessionUser = CREATOR;
    events[EVENT_ID] = makeEvent({ state: "cancelled" });
    const r = await form(REMOVE);
    expect(flashOf(r.location).type).toBe("err");
    expect(imageDelete).not.toHaveBeenCalled();
  });
});

describe("the edit page", () => {
  it("offers the upload, and no admin link to a host", async () => {
    const r = await page(EDIT);
    expect(r.status).toBe(200);
    expect(r.text).toContain(`action="${COVER}"`);
    expect(r.text).toContain("Upload cover");
    // The page script rides in a nonce-carrying tag (the security-headers
    // middleware fills the nonce in; this harness has none).
    expect(r.text).toMatch(
      /<script nonce="[^"]+">\(function\(\)\{var forms=document\.querySelectorAll\('form\[data-cover-upload\]'\)/,
    );
    expect(r.text).not.toContain("/cover/remove");
    expect(r.text).not.toContain('href="/admin/events"');
  });

  it("offers Replace and Remove when a cover is set, and says a series shares it", async () => {
    events[EVENT_ID] = makeEvent({
      coverHash: "abc",
      recurrence: "weekly",
      seriesId: "series-1",
    });
    const r = await page(EDIT);
    expect(r.text).toContain("Replace cover");
    // One primary button per view (docs/design/components.md): Save changes.
    // The cover buttons are neutral and danger.
    const main = r.text.slice(
      r.text.indexOf("<main"),
      r.text.indexOf("</main>"),
    );
    expect(main.match(/kb-btn--primary/g)).toHaveLength(1);
    expect(main).toMatch(/class="kb-btn kb-btn--primary">Save changes/);
    expect(main).toMatch(/class="kb-btn">Replace cover/);
    expect(r.text).toContain(`action="${REMOVE}"`);
    expect(r.text).toMatch(/belongs to the whole series/);
  });

  it("gives an administrator a plain link to the admin control", async () => {
    sessionRole = "admin";
    sessionUser = OTHER;
    scopes = ["member"];
    const r = await page(EDIT);
    expect(r.text).toContain('href="/admin/events"');
  });
});
