import { describe, it, expect } from "@jest/globals";
import {
  MAX_TIER_TOP_N,
  parseTierConfig,
  serializeTiers,
  tierRoleIssue,
  tierRoleProblem,
  validateTierRows,
} from "../../src/web/leaderboard-tiers.js";

describe("parseTierConfig (#985)", () => {
  it("parses topN:roleId pairs ascending by topN", () => {
    expect(parseTierConfig("10:333, 1:111,3:222")).toEqual({
      tiers: [
        { topN: 1, roleId: "111" },
        { topN: 3, roleId: "222" },
        { topN: 10, roleId: "333" },
      ],
      ignored: [],
    });
  });

  it("returns nothing for an empty string", () => {
    expect(parseTierConfig("")).toEqual({ tiers: [], ignored: [] });
    expect(parseTierConfig("  ,  ")).toEqual({ tiers: [], ignored: [] });
  });

  it("skips the entries the service skips and reports them", () => {
    const parsed = parseTierConfig("1:111,oops,0:222,2:abc,3:4:5,4:444");
    expect(parsed.tiers).toEqual([
      { topN: 1, roleId: "111" },
      { topN: 4, roleId: "444" },
    ]);
    expect(parsed.ignored).toEqual(["oops", "0:222", "2:abc", "3:4:5"]);
  });

  it("keeps the last role for a repeated topN, like the service", () => {
    const parsed = parseTierConfig("1:111,1:999");
    expect(parsed.tiers).toEqual([{ topN: 1, roleId: "999" }]);
    expect(parsed.ignored).toEqual(["1:111"]);
  });
});

describe("serializeTiers (#985)", () => {
  it("round-trips a canonical stored string unchanged", () => {
    const stored = "1:111,3:222,10:333";
    expect(serializeTiers(parseTierConfig(stored).tiers)).toBe(stored);
  });

  it("sorts ascending and returns empty for no tiers", () => {
    expect(
      serializeTiers([
        { topN: 5, roleId: "2" },
        { topN: 2, roleId: "1" },
      ]),
    ).toBe("2:1,5:2");
    expect(serializeTiers([])).toBe("");
  });
});

describe("validateTierRows (#985)", () => {
  it("accepts rows and drops fully blank ones", () => {
    expect(validateTierRows(["3", "", "1"], ["222", "", "111"])).toEqual({
      ok: true,
      tiers: [
        { topN: 1, roleId: "111" },
        { topN: 3, roleId: "222" },
      ],
    });
  });

  it("accepts no rows at all (clears the tiers)", () => {
    expect(validateTierRows([""], [""])).toEqual({ ok: true, tiers: [] });
  });

  it("rejects a half-filled row", () => {
    const missingRole = validateTierRows(["1"], [""]);
    expect(missingRole).toEqual({ ok: false, error: "Row 1: pick a role." });
    const missingN = validateTierRows(["", "", ""], ["", "", "111"]);
    expect(missingN).toEqual({ ok: false, error: "Row 3: enter a Top N." });
  });

  it.each(["0", "-1", "1.5", "abc", String(MAX_TIER_TOP_N + 1)])(
    "rejects Top N %p",
    (n) => {
      const result = validateTierRows([n], ["111"]);
      expect(result.ok).toBe(false);
    },
  );

  it("rejects a malformed role id", () => {
    expect(validateTierRows(["1"], ["<@&111>"]).ok).toBe(false);
  });

  it("rejects a duplicate Top N", () => {
    const result = validateTierRows(["1", "1"], ["111", "222"]);
    expect(result).toEqual({
      ok: false,
      error: expect.stringContaining("Top 1 is used by more than one tier"),
    });
  });

  it("rejects the same role on two tiers", () => {
    const result = validateTierRows(["1", "3"], ["111", "111"]);
    expect(result).toEqual({
      ok: false,
      error: expect.stringContaining("already used by another tier"),
    });
  });
});

describe("tierRoleProblem (#985)", () => {
  const role = { id: "r1", name: "Champion", managed: false, position: 3 };

  it("accepts a role below the bot's highest role", () => {
    expect(tierRoleProblem(role, "guild-1", 5)).toBeNull();
  });

  it("rejects a missing role, @everyone and managed roles", () => {
    expect(tierRoleProblem(null, "guild-1", 5)).toContain("no longer exists");
    expect(tierRoleProblem({ ...role, id: "guild-1" }, "guild-1", 5)).toContain(
      "@everyone",
    );
    expect(tierRoleProblem({ ...role, managed: true }, "guild-1", 5)).toContain(
      "managed by an integration",
    );
  });

  it("rejects a role at or above the bot's highest role", () => {
    expect(tierRoleProblem(role, "guild-1", 3)).toContain("above the bot");
    expect(tierRoleProblem({ ...role, position: 9 }, "guild-1", 3)).toContain(
      "above the bot",
    );
  });

  it("skips the hierarchy check when the bot's position is unknown", () => {
    expect(tierRoleProblem({ ...role, position: 99 }, "guild-1", null)).toBe(
      null,
    );
  });
});

describe("tierRoleIssue (#985)", () => {
  const role = { id: "r1", name: "Champion", managed: false, position: 3 };

  it("classifies each reason separately", () => {
    expect(tierRoleIssue(null, "guild-1", 5)).toBe("missing");
    expect(tierRoleIssue({ ...role, id: "guild-1" }, "guild-1", 5)).toBe(
      "everyone",
    );
    // Managed wins over hierarchy: raising the bot's role would not help.
    expect(
      tierRoleIssue({ ...role, managed: true, position: 9 }, "guild-1", 5),
    ).toBe("managed");
    expect(tierRoleIssue({ ...role, position: 9 }, "guild-1", 5)).toBe(
      "hierarchy",
    );
    expect(tierRoleIssue(role, "guild-1", 5)).toBeNull();
  });
});
