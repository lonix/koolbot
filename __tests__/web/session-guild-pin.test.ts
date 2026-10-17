/**
 * Web sessions are pinned to the configured GUILD_ID (#1144): a session row
 * for any other guild is refused when the cookie is validated.
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
import { createSessionPingHandler } from "../../src/web/session.js";
import { signValue } from "../../src/web/cookies.js";
import { WebSessionService } from "../../src/services/web-session-service.js";

const ORIGINAL_ENV = { ...process.env };
const SECRET = "test-secret-for-guild-pin-tests";

function cookieFor(gid: string): string {
  const now = Date.now();
  const payload = { sid: "s1", uid: "u1", gid, iat: now, act: now };
  const encoded = Buffer.from(JSON.stringify(payload)).toString("base64url");
  return `koolbot_session=${signValue(encoded, SECRET)}`;
}

async function ping(
  cookieGuild: string,
  rowGuild: string,
): Promise<{ status: number }> {
  jest.spyOn(WebSessionService.getInstance(), "findById").mockResolvedValue({
    discordUserId: "u1",
    guildId: rowGuild,
    scopes: [],
    revokedAt: null,
    expiresAt: new Date(Date.now() + 3_600_000),
  } as unknown as never);
  const res = {
    statusCode: 200,
    status: jest.fn((code: number) => {
      res.statusCode = code;
      return res;
    }),
    json: jest.fn(() => res),
    setHeader: jest.fn(),
  };
  await createSessionPingHandler()(
    { headers: { cookie: cookieFor(cookieGuild) } } as never,
    res as never,
    jest.fn() as never,
  );
  return { status: res.statusCode };
}

describe("web session guild pin (#1144)", () => {
  beforeEach(() => {
    process.env.WEBUI_SESSION_SECRET = SECRET;
    (WebSessionService as unknown as { instance: unknown }).instance = null;
  });
  afterEach(() => {
    process.env = { ...ORIGINAL_ENV };
    jest.restoreAllMocks();
  });

  it("accepts a session of the configured guild", async () => {
    process.env.GUILD_ID = "g1";
    expect((await ping("g1", "g1")).status).toBe(200);
  });

  it("refuses a session bound to another guild, even with a matching cookie", async () => {
    process.env.GUILD_ID = "g1";
    expect((await ping("g2", "g2")).status).toBe(401);
  });

  it("does not pin when GUILD_ID is unset", async () => {
    delete process.env.GUILD_ID;
    expect((await ping("g2", "g2")).status).toBe(200);
  });
});
