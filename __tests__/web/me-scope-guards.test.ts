/**
 * Route guards on `/me` (#1316): `/me/events*` needs the host scope and
 * `/me/moderation*` the moderator scope, over real HTTP through the real
 * `createUserRouter`. The sub-routers are replaced by markers so the
 * test sees only whether the guard let the request through; the creator check
 * behind the guard (`isEventHost`) has its own tests in `event-host.test.ts`
 * and `host-panel-routes.test.ts`.
 */
import { describe, it, expect, jest, beforeAll, afterAll } from "@jest/globals";
import { Router } from "express";
import {
  startAdminHarness,
  createTestSession,
  type AdminHarness,
} from "./admin-harness.js";
import type { WebSessionContext } from "../../src/web/session.js";

process.env.WEBUI_SESSION_SECRET = "test-secret-for-me-scope-guards";

jest.unstable_mockModule("../../src/web/routes/host-events.js", () => ({
  createHostEventsRouter: (): Router => {
    const r = Router({ mergeParams: true });
    r.use((_req, res) => {
      res.status(200).type("text/plain").send("host-panel-reached");
    });
    return r;
  },
}));
jest.unstable_mockModule("../../src/web/routes/me-event-presets.js", () => ({
  createMeEventPresetsRouter: (): Router => {
    const r = Router();
    r.use((_req, res) => {
      res.status(200).type("text/plain").send("presets-reached");
    });
    return r;
  },
}));

jest.unstable_mockModule("../../src/web/routes/me-moderation.js", () => ({
  createMeModerationRouter: (): Router => {
    const r = Router();
    r.use((_req, res) => {
      res.status(200).type("text/plain").send("moderation-reached");
    });
    return r;
  },
}));

const { createUserRouter } = await import("../../src/web/user-routes.js");

let current: WebSessionContext | null = null;
let harness: AdminHarness;

const as = (
  role: "user" | "admin",
  scopes: WebSessionContext["scopes"],
): void => {
  current = createTestSession({
    discordUserId: "u-1",
    guildId: "guild-1",
    role,
    scopes,
  });
};

beforeAll(async () => {
  harness = await startAdminHarness(
    [
      createUserRouter({} as never, (req, _res, next): void => {
        if (current) Object.assign(req, { webSession: current });
        next();
      }),
    ],
    "/me",
  );
});

afterAll(async () => {
  await harness.close();
});

const EVENT_PATHS = [
  "/events/presets",
  "/events/presets/save",
  "/events/abc123/host",
  "/events/abc123/host/end",
];
const MODERATION_PATHS = ["/moderation", "/moderation/log", "/moderation/x/y"];

async function status(path: string, method: "GET" | "POST"): Promise<number> {
  const res =
    method === "GET" ? await harness.get(path) : await harness.post(path, {});
  return res.status;
}

describe("/me/events needs the host scope (#1316)", () => {
  it.each([
    ["a member only", "user", ["member"]],
    ["a moderator only", "user", ["member", "moderator"]],
    ["a session with no scopes at all", "user", []],
  ] as const)("refuses %s on every events path", async (_n, role, scopes) => {
    as(role, [...scopes]);
    for (const path of EVENT_PATHS) {
      expect(await status(path, "GET")).toBe(403);
      expect(await status(path, "POST")).toBe(403);
    }
  });

  it.each([
    ["a host only", "user", ["member", "host"]],
    ["a host and moderator", "user", ["member", "host", "moderator"]],
    ["an admin session", "admin", ["member"]],
  ] as const)(
    "lets %s through to the events routers",
    async (_n, role, scopes) => {
      as(role, [...scopes]);
      for (const path of EVENT_PATHS) {
        expect(await status(path, "GET")).toBe(200);
      }
      const panel = await harness.get("/events/abc123/host");
      expect(await panel.text()).toBe("host-panel-reached");
    },
  );

  it("refuses the same session on the next request once the scope is gone", async () => {
    as("user", ["member", "host"]);
    expect(await status("/events/abc123/host", "GET")).toBe(200);
    as("user", ["member"]);
    expect(await status("/events/abc123/host", "GET")).toBe(403);
  });

  it("answers 401, not a pass, when no session was attached", async () => {
    current = null;
    expect(await status("/events/abc123/host", "GET")).toBe(401);
  });
});

describe("/me/moderation needs the moderator scope (#1316)", () => {
  it.each([
    ["a member only", "user", ["member"]],
    ["a host only", "user", ["member", "host"]],
  ] as const)(
    "refuses %s on every moderation path",
    async (_n, role, scopes) => {
      as(role, [...scopes]);
      for (const path of MODERATION_PATHS) {
        expect(await status(path, "GET")).toBe(403);
        expect(await status(path, "POST")).toBe(403);
      }
    },
  );

  it.each([
    ["a moderator only", "user", ["member", "moderator"]],
    ["a host and moderator", "user", ["member", "host", "moderator"]],
    ["an admin session", "admin", ["member"]],
  ] as const)("lets %s past the guard", async (_n, role, scopes) => {
    as(role, [...scopes]);
    for (const path of MODERATION_PATHS) {
      const res = await harness.get(path);
      expect(res.status).toBe(200);
      expect(await res.text()).toBe("moderation-reached");
    }
  });

  it("a moderator scope does not open the events routers, nor a host scope moderation", async () => {
    as("user", ["member", "moderator"]);
    expect(await status("/events/abc123/host", "GET")).toBe(403);
    as("user", ["member", "host"]);
    expect(await status("/moderation/log", "GET")).toBe(403);
  });
});
