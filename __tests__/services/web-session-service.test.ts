import {
  describe,
  it,
  expect,
  jest,
  beforeEach,
  afterEach,
} from "@jest/globals";
import { WebSessionService } from "../../src/services/web-session-service.js";
import { WebSession } from "../../src/models/web-session.js";
import logger from "../../src/utils/logger.js";

jest.mock("../../src/models/web-session.js");
jest.mock("../../src/utils/logger.js");

const ORIGINAL_ENV = { ...process.env };

describe("WebSessionService", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    process.env.WEBUI_SESSION_SECRET = "test-secret-of-sufficient-length";
    process.env.WEBUI_BASE_URL = "https://example.test";
    process.env.WEBUI_SESSION_TTL_MINUTES = "10";

    // Reset singleton between tests
    (WebSessionService as unknown as { instance: unknown }).instance = null;
  });

  afterEach(() => {
    process.env = { ...ORIGINAL_ENV };
  });

  it("hashToken is deterministic for same secret and produces hex output", () => {
    const svc = WebSessionService.getInstance();
    const a = svc.hashToken("hello");
    const b = svc.hashToken("hello");
    expect(a).toBe(b);
    expect(a).toMatch(/^[a-f0-9]+$/);
  });

  it("hashToken throws when secret missing", () => {
    delete process.env.WEBUI_SESSION_SECRET;
    const svc = WebSessionService.getInstance();
    expect(() => svc.hashToken("x")).toThrow(/WEBUI_SESSION_SECRET/);
  });

  it("create revokes prior sessions and inserts a new row", async () => {
    const updateMany = jest.fn().mockResolvedValue({ modifiedCount: 1 });
    const create = jest.fn().mockResolvedValue({ _id: "abc" });
    (WebSession as unknown as { updateMany: unknown }).updateMany = updateMany;
    (WebSession as unknown as { create: unknown }).create = create;

    const svc = WebSessionService.getInstance();
    const result = await svc.create("user-1", "guild-1", ["scope:a"]);

    expect(updateMany).toHaveBeenCalledWith(
      { discordUserId: "user-1", revokedAt: null },
      { $set: expect.objectContaining({ revokedAt: expect.any(Date) }) },
    );
    expect(create).toHaveBeenCalledTimes(1);
    expect(result.url).toMatch(
      /^https:\/\/example\.test\/admin\/s\/[A-Za-z0-9_-]+$/,
    );
    expect(result.expiresAt.getTime()).toBeGreaterThan(Date.now());
  });

  it("redeem returns null when no matching unused session exists", async () => {
    (WebSession as unknown as { updateMany: unknown }).updateMany = jest
      .fn()
      .mockResolvedValue({ modifiedCount: 0 });
    (WebSession as unknown as { findOneAndUpdate: unknown }).findOneAndUpdate =
      jest.fn().mockResolvedValue(null);

    const svc = WebSessionService.getInstance();
    const result = await svc.redeem("not-a-real-token");
    expect(result).toBeNull();
  });

  it("redeem marks the session used and returns context on success", async () => {
    const findOneAndUpdate = jest.fn().mockResolvedValue({
      _id: { toString: () => "session-id" },
      discordUserId: "user-1",
      guildId: "guild-1",
      scopes: ["scope:a"],
    });
    (
      WebSession as unknown as { findOneAndUpdate: unknown }
    ).findOneAndUpdate = findOneAndUpdate;

    const svc = WebSessionService.getInstance();
    const result = await svc.redeem("any-token");

    expect(result).toEqual({
      sessionId: "session-id",
      discordUserId: "user-1",
      guildId: "guild-1",
      scopes: ["scope:a"],
    });
    const call = findOneAndUpdate.mock.calls[0];
    expect(call[0]).toMatchObject({
      usedAt: null,
      revokedAt: null,
    });
    expect(call[1]).toMatchObject({ $set: { usedAt: expect.any(Date) } });
  });

  it("revokeSession returns true when modifiedCount > 0", async () => {
    (WebSession as unknown as { updateOne: unknown }).updateOne = jest
      .fn()
      .mockResolvedValue({ modifiedCount: 1 });
    const svc = WebSessionService.getInstance();
    expect(await svc.revokeSession("abc")).toBe(true);
  });

  it("revokeSession returns false when nothing updated", async () => {
    (WebSession as unknown as { updateOne: unknown }).updateOne = jest
      .fn()
      .mockResolvedValue({ modifiedCount: 0 });
    const svc = WebSessionService.getInstance();
    expect(await svc.revokeSession("abc")).toBe(false);
  });

  it("revokeSession returns false for empty id without hitting the model", async () => {
    const updateOne = jest.fn();
    (WebSession as unknown as { updateOne: unknown }).updateOne = updateOne;
    const svc = WebSessionService.getInstance();
    expect(await svc.revokeSession("")).toBe(false);
    expect(updateOne).not.toHaveBeenCalled();
  });

  describe("redeem failure classification", () => {
    let infoMock: jest.Mock;

    beforeEach(() => {
      // ts-jest's ESM auto-mock for the logger module produces a default
      // export whose method shape isn't a jest.fn() we can introspect, so
      // patch `info` directly with a known mock for these assertions.
      infoMock = jest.fn();
      (logger as unknown as { info: unknown }).info = infoMock;
    });

    function mockClassifierState(existing: unknown): void {
      (
        WebSession as unknown as { findOneAndUpdate: unknown }
      ).findOneAndUpdate = jest.fn().mockResolvedValue(null);
      (WebSession as unknown as { findOne: unknown }).findOne = jest
        .fn()
        .mockResolvedValue(existing);
    }

    function reasonsLogged(): string[] {
      return infoMock.mock.calls.map((c) => String(c[0]));
    }

    it("logs 'not_found' when no row matches the tokenHash", async () => {
      mockClassifierState(null);
      const svc = WebSessionService.getInstance();
      expect(await svc.redeem("anything")).toBeNull();
      expect(reasonsLogged()).toEqual(
        expect.arrayContaining([expect.stringContaining("not_found")]),
      );
    });

    it("logs 'revoked' when revokedAt is set (takes precedence over used/expired)", async () => {
      mockClassifierState({
        revokedAt: new Date(),
        usedAt: new Date(),
        expiresAt: new Date(Date.now() - 1000),
      });
      const svc = WebSessionService.getInstance();
      expect(await svc.redeem("anything")).toBeNull();
      expect(reasonsLogged()).toEqual(
        expect.arrayContaining([expect.stringContaining("revoked")]),
      );
    });

    it("logs 'already_used' when usedAt is set and not revoked", async () => {
      mockClassifierState({
        revokedAt: null,
        usedAt: new Date(),
        expiresAt: new Date(Date.now() + 60_000),
      });
      const svc = WebSessionService.getInstance();
      expect(await svc.redeem("anything")).toBeNull();
      expect(reasonsLogged()).toEqual(
        expect.arrayContaining([expect.stringContaining("already_used")]),
      );
    });

    it("logs 'expired' when expiresAt is in the past, not used or revoked", async () => {
      mockClassifierState({
        revokedAt: null,
        usedAt: null,
        expiresAt: new Date(Date.now() - 1000),
      });
      const svc = WebSessionService.getInstance();
      expect(await svc.redeem("anything")).toBeNull();
      expect(reasonsLogged()).toEqual(
        expect.arrayContaining([expect.stringContaining("expired")]),
      );
    });

    it("logs 'unknown' when the row is otherwise live (lookup raced with state change)", async () => {
      mockClassifierState({
        revokedAt: null,
        usedAt: null,
        expiresAt: new Date(Date.now() + 60_000),
      });
      const svc = WebSessionService.getInstance();
      expect(await svc.redeem("anything")).toBeNull();
      expect(reasonsLogged()).toEqual(
        expect.arrayContaining([expect.stringContaining("unknown")]),
      );
    });

    it("collapses to 'unknown' if the diagnostic findOne throws", async () => {
      (
        WebSession as unknown as { findOneAndUpdate: unknown }
      ).findOneAndUpdate = jest.fn().mockResolvedValue(null);
      (WebSession as unknown as { findOne: unknown }).findOne = jest
        .fn()
        .mockRejectedValue(new Error("mongo down"));
      const svc = WebSessionService.getInstance();
      expect(await svc.redeem("anything")).toBeNull();
      expect(reasonsLogged()).toEqual(
        expect.arrayContaining([expect.stringContaining("unknown")]),
      );
    });
  });

  describe("peek (validate without consuming)", () => {
    let infoMock: jest.Mock;

    beforeEach(() => {
      infoMock = jest.fn();
      (logger as unknown as { info: unknown }).info = infoMock;
    });

    function mockFindOne(existing: unknown): jest.Mock {
      const fn = jest.fn().mockResolvedValue(existing);
      (WebSession as unknown as { findOne: unknown }).findOne = fn;
      // No findOneAndUpdate stub — peek must not call it.
      (WebSession as unknown as { findOneAndUpdate: unknown }).findOneAndUpdate =
        jest.fn(() => {
          throw new Error("peek() must not consume the token");
        });
      return fn;
    }

    it("returns session context without marking the token used", async () => {
      const findOne = mockFindOne({
        _id: { toString: () => "session-id" },
        discordUserId: "user-1",
        guildId: "guild-1",
        scopes: ["scope:a"],
        usedAt: null,
        revokedAt: null,
        expiresAt: new Date(Date.now() + 60_000),
      });
      const svc = WebSessionService.getInstance();
      const result = await svc.peek("any-token");
      expect(result).toEqual({
        sessionId: "session-id",
        discordUserId: "user-1",
        guildId: "guild-1",
        scopes: ["scope:a"],
      });
      expect(findOne).toHaveBeenCalledTimes(1);
    });

    it("returns null and logs 'empty token' for an empty token", async () => {
      const svc = WebSessionService.getInstance();
      expect(await svc.peek("")).toBeNull();
      expect(infoMock).toHaveBeenCalledWith(
        expect.stringContaining("empty token"),
      );
    });

    it("returns null and logs 'not_found' when no row matches", async () => {
      mockFindOne(null);
      const svc = WebSessionService.getInstance();
      expect(await svc.peek("anything")).toBeNull();
      expect(infoMock).toHaveBeenCalledWith(
        expect.stringContaining("not_found"),
      );
    });

    it("returns null and logs 'revoked' when revokedAt is set", async () => {
      mockFindOne({
        _id: { toString: () => "x" },
        discordUserId: "u",
        guildId: "g",
        scopes: [],
        usedAt: null,
        revokedAt: new Date(),
        expiresAt: new Date(Date.now() + 60_000),
      });
      const svc = WebSessionService.getInstance();
      expect(await svc.peek("anything")).toBeNull();
      expect(infoMock).toHaveBeenCalledWith(
        expect.stringContaining("revoked"),
      );
    });

    it("returns null and logs 'already_used' when usedAt is set", async () => {
      mockFindOne({
        _id: { toString: () => "x" },
        discordUserId: "u",
        guildId: "g",
        scopes: [],
        usedAt: new Date(),
        revokedAt: null,
        expiresAt: new Date(Date.now() + 60_000),
      });
      const svc = WebSessionService.getInstance();
      expect(await svc.peek("anything")).toBeNull();
      expect(infoMock).toHaveBeenCalledWith(
        expect.stringContaining("already_used"),
      );
    });

    it("returns null and logs 'expired' when expiresAt is in the past", async () => {
      mockFindOne({
        _id: { toString: () => "x" },
        discordUserId: "u",
        guildId: "g",
        scopes: [],
        usedAt: null,
        revokedAt: null,
        expiresAt: new Date(Date.now() - 1000),
      });
      const svc = WebSessionService.getInstance();
      expect(await svc.peek("anything")).toBeNull();
      expect(infoMock).toHaveBeenCalledWith(
        expect.stringContaining("expired"),
      );
    });
  });
});
