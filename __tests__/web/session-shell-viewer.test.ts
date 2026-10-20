/**
 * What the session middleware hands the app shell (#1317): the display name
 * (read from the client cache, never a new Discord call), the role names behind
 * the host and moderator scopes, and the request's viewer for the layouts.
 */

import { Buffer } from "buffer";
import {
  describe,
  it,
  expect,
  jest,
  beforeEach,
  afterEach,
} from "@jest/globals";
import { Client } from "discord.js";
import {
  createSessionMiddleware,
  type AuthenticatedRequest,
} from "../../src/web/session.js";
import { currentViewer, type ShellViewer } from "../../src/web/app-shell.js";
import { signValue } from "../../src/web/cookies.js";
import { WebSessionService } from "../../src/services/web-session-service.js";
import { PermissionsService } from "../../src/services/permissions-service.js";
import type { Response, NextFunction } from "express";

const SECRET = "test-secret-for-session-shell-viewer";
const ORIGINAL_ENV = { ...process.env };
const now = Date.UTC(2026, 0, 1, 12, 0, 0);

function cookieFor(role: "admin" | "user"): string {
  const payload = {
    sid: "session-id",
    uid: "u-1",
    gid: "g-1",
    rol: role,
    iat: now,
    act: now,
  };
  const encoded = Buffer.from(JSON.stringify(payload)).toString("base64url");
  return signValue(encoded, SECRET);
}

function makeRes(): Response {
  const res: Record<string, unknown> = {};
  res.status = () => res;
  res.type = () => res;
  res.send = () => res;
  res.setHeader = () => res;
  res.getHeader = () => undefined;
  return res as unknown as Response;
}

function clientWithMember(displayName: string | null): Client {
  const members = new Map(
    displayName === null ? [] : [["u-1", { displayName }]],
  );
  return {
    guilds: { cache: new Map([["g-1", { members: { cache: members } }]]) },
    users: { cache: new Map() },
  } as unknown as Client;
}

async function run(
  role: "admin" | "user",
  client: Client,
): Promise<{ req: AuthenticatedRequest; viewerInNext: ShellViewer | null }> {
  const req = {
    headers: { cookie: `koolbot_session=${cookieFor(role)}` },
    method: "GET",
  } as unknown as AuthenticatedRequest;
  let viewerInNext: ShellViewer | null = null;
  const next = (() => {
    viewerInNext = currentViewer();
  }) as unknown as NextFunction;
  await createSessionMiddleware(client)(req, makeRes(), next);
  return { req, viewerInNext };
}

describe("session middleware: who is looking (#1317)", () => {
  let storedRole: "admin" | "user";
  let resolveWebScopes: jest.Mock<(...a: unknown[]) => Promise<unknown>>;
  let resolveWebScopeReasons: jest.Mock<(...a: unknown[]) => Promise<unknown>>;

  beforeEach(() => {
    process.env.WEBUI_SESSION_SECRET = SECRET;
    process.env.WEBUI_INACTIVITY_TIMEOUT_MINUTES = "30";
    (WebSessionService as unknown as { instance: unknown }).instance = null;
    jest.spyOn(Date, "now").mockImplementation(() => now);
    storedRole = "user";
    jest
      .spyOn(WebSessionService.getInstance(), "findById")
      .mockImplementation((async () => ({
        discordUserId: "u-1",
        guildId: "g-1",
        role: storedRole,
        scopes: [],
        revokedAt: null,
        expiresAt: new Date(now + 24 * 60 * 60 * 1000),
      })) as never);
    resolveWebScopes = jest.fn(async () => ["member"]);
    resolveWebScopeReasons = jest.fn(async () => ({
      host: ["Event hosts"],
      staff: [],
      elevated: false,
    }));
    jest.spyOn(PermissionsService, "getInstance").mockReturnValue({
      checkCommandPermission: async () => true,
      isAdministrator: async () => true,
      resolveWebScopes,
      resolveWebScopeReasons,
    } as never);
  });

  afterEach(() => {
    process.env = { ...ORIGINAL_ENV };
    jest.restoreAllMocks();
    (WebSessionService as unknown as { instance: unknown }).instance = null;
  });

  it("reads the display name from the cached member", async () => {
    const { req } = await run("user", clientWithMember("Kari Nordmann"));
    expect(req.webSession?.displayName).toBe("Kari Nordmann");
  });

  it("leaves the name unset when nothing is cached, and survives a bare client", async () => {
    const empty = await run("user", clientWithMember(null));
    expect(empty.req.webSession?.displayName).toBeUndefined();
    const bare = await run("user", {} as Client);
    expect(bare.req.webSession?.displayName).toBeUndefined();
  });

  it("gives the layouts the request's viewer while the route runs", async () => {
    resolveWebScopes.mockResolvedValue(["member", "host"]);
    const { viewerInNext } = await run("user", clientWithMember("Kari"));
    expect(viewerInNext).toEqual({
      displayName: "Kari",
      role: "user",
      scopes: ["member", "host"],
      reasons: { host: ["Event hosts"], staff: [], elevated: false },
    });
    // Nothing leaks past the request.
    expect(currentViewer()).toBeNull();
  });

  it("looks the role names up only for a session with a scope beyond member", async () => {
    await run("user", clientWithMember("Kari"));
    expect(resolveWebScopeReasons).not.toHaveBeenCalled();
    resolveWebScopes.mockResolvedValue(["member", "moderator"]);
    const { req } = await run("user", clientWithMember("Kari"));
    expect(resolveWebScopeReasons).toHaveBeenCalledWith("u-1", "g-1");
    expect(req.webSession?.scopeReasons?.host).toEqual(["Event hosts"]);
  });

  it("does not look them up for an admin session", async () => {
    storedRole = "admin";
    const { req, viewerInNext } = await run("admin", clientWithMember("Ola"));
    expect(resolveWebScopeReasons).not.toHaveBeenCalled();
    expect(req.webSession?.scopeReasons).toBeUndefined();
    expect(viewerInNext?.role).toBe("admin");
  });

  it("serves the request when the role names cannot be read", async () => {
    resolveWebScopes.mockResolvedValue(["member", "host"]);
    resolveWebScopeReasons.mockRejectedValue(new Error("groups down"));
    const { req } = await run("user", clientWithMember("Kari"));
    expect(req.webSession?.scopes).toEqual(["member", "host"]);
    expect(req.webSession?.scopeReasons).toBeUndefined();
  });
});
