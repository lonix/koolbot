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
} = await import("../../src/utils/guild-scope.js");

describe("guild scope (#1144)", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    resetForeignGuildWarnings();
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
