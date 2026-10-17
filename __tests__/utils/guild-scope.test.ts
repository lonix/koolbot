import { describe, it, expect, jest, beforeEach } from "@jest/globals";

const warn = jest.fn();
const info = jest.fn();
const error = jest.fn();
jest.unstable_mockModule("../../src/utils/logger.js", () => ({
  default: { info, warn, error, debug: jest.fn() },
}));

const {
  isForeignGuild,
  shouldIgnoreGuild,
  applyGuildScope,
  resetForeignGuildWarnings,
  isConfiguredGuildMember,
} = await import("../../src/utils/guild-scope.js");

describe("guild scope (#1144)", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    resetForeignGuildWarnings();
    delete process.env.GUILD_MEMBERS_INTENT;
  });

  describe("isConfiguredGuildMember", () => {
    const fetch = jest.fn<(o: unknown) => Promise<unknown>>();
    const callApi = jest.fn(<T>(call: () => Promise<T>) => call());
    const clientWith = (ids: string[]) => ({
      guilds: {
        cache: {
          get: (id: string) =>
            id === "g1"
              ? {
                  members: {
                    cache: { has: (u: string) => ids.includes(u) },
                    fetch,
                  },
                }
              : undefined,
        },
      },
    });
    beforeEach(() => {
      fetch.mockReset();
      callApi.mockClear();
    });

    it("trusts the cache when the intent is on", async () => {
      process.env.GUILD_MEMBERS_INTENT = "true";
      const c = clientWith(["u1"]);
      expect(await isConfiguredGuildMember(c, "g1", "u1", callApi)).toBe(true);
      expect(await isConfiguredGuildMember(c, "g1", "u2", callApi)).toBe(false);
      expect(fetch).not.toHaveBeenCalled();
    });
    it("does not trust a cached former member when the intent is off", async () => {
      fetch.mockRejectedValue(
        Object.assign(new Error("Unknown Member"), { code: 10007 }),
      );
      // u1 is still in the cache (no removal event arrives) but has left.
      expect(
        await isConfiguredGuildMember(clientWith(["u1"]), "g1", "u1", callApi),
      ).toBe(false);
      expect(fetch).toHaveBeenCalledWith({ user: "u1", force: true });
    });
    it("accepts a member the fresh lookup confirms when the intent is off", async () => {
      fetch.mockResolvedValue({ id: "u1" });
      expect(
        await isConfiguredGuildMember(clientWith([]), "g1", "u1", callApi),
      ).toBe(true);
    });
    it("fails closed when the lookup errors or times out", async () => {
      fetch.mockRejectedValue(new Error("Discord API timeout after 5000ms"));
      expect(
        await isConfiguredGuildMember(clientWith(["u1"]), "g1", "u1", callApi),
      ).toBe(false);
    });
    it("is false when no guild is configured or the guild is unknown", async () => {
      expect(
        await isConfiguredGuildMember(
          clientWith(["u1"]),
          undefined,
          "u1",
          callApi,
        ),
      ).toBe(false);
      expect(
        await isConfiguredGuildMember(clientWith(["u1"]), "g9", "u1", callApi),
      ).toBe(false);
    });
  });

  describe("isForeignGuild", () => {
    it("is false for the configured guild", () => {
      expect(isForeignGuild("g1", "g1")).toBe(false);
    });
    it("is true for any other guild", () => {
      expect(isForeignGuild("g2", "g1")).toBe(true);
    });
    it("treats a DM (no guild) as in scope", () => {
      expect(isForeignGuild(null, "g1")).toBe(false);
      expect(isForeignGuild(undefined, "g1")).toBe(false);
    });
    it("fails open when no guild is configured", () => {
      expect(isForeignGuild("g2", undefined)).toBe(false);
      expect(isForeignGuild("g2", "")).toBe(false);
    });
  });

  describe("shouldIgnoreGuild", () => {
    it("lets the configured guild and DMs through without logging", () => {
      expect(shouldIgnoreGuild("g1", "g1")).toBe(false);
      expect(shouldIgnoreGuild(null, "g1")).toBe(false);
      expect(warn).not.toHaveBeenCalled();
    });

    it("ignores a foreign guild and warns once per guild", () => {
      expect(shouldIgnoreGuild("g2", "g1")).toBe(true);
      expect(shouldIgnoreGuild("g2", "g1")).toBe(true);
      expect(shouldIgnoreGuild("g2", "g1")).toBe(true);
      expect(warn).toHaveBeenCalledTimes(1);
      expect(String(warn.mock.calls[0]?.[0])).toContain("g2");

      expect(shouldIgnoreGuild("g3", "g1")).toBe(true);
      expect(warn).toHaveBeenCalledTimes(2);
    });
  });

  describe("applyGuildScope", () => {
    const guild = (id: string, leave = jest.fn<() => Promise<void>>()) => ({
      id,
      name: `name-${id}`,
      leave,
    });

    it("never leaves anything while the opt-in is off, but still warns", async () => {
      const foreign = guild("g2");
      const left = await applyGuildScope([guild("g1"), foreign], "g1", false);
      expect(left).toEqual([]);
      expect(foreign.leave).not.toHaveBeenCalled();
      expect(warn).toHaveBeenCalledTimes(1);
    });

    it("leaves only foreign guilds when the opt-in is on", async () => {
      const home = guild("g1");
      const a = guild("g2");
      const b = guild("g3");
      const left = await applyGuildScope([home, a, b], "g1", true);
      expect(left).toEqual(["g2", "g3"]);
      expect(home.leave).not.toHaveBeenCalled();
      expect(a.leave).toHaveBeenCalledTimes(1);
      expect(b.leave).toHaveBeenCalledTimes(1);
    });

    it("does nothing at all when no guild is configured", async () => {
      const g = guild("g2");
      expect(await applyGuildScope([g], undefined, true)).toEqual([]);
      expect(await applyGuildScope([g], "", true)).toEqual([]);
      expect(g.leave).not.toHaveBeenCalled();
    });

    it("keeps going when one leave fails", async () => {
      const bad = guild(
        "g2",
        jest.fn<() => Promise<void>>().mockRejectedValue(new Error("nope")),
      );
      const ok = guild("g3");
      const left = await applyGuildScope([bad, ok], "g1", true);
      expect(left).toEqual(["g3"]);
      expect(error).toHaveBeenCalledTimes(1);
    });
  });
});
