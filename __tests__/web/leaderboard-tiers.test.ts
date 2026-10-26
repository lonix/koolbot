import { describe, it, expect } from "@jest/globals";
import { PermissionFlagsBits } from "discord.js";
import {
  MAX_TIER_TOP_N,
  parseTierConfig,
  serializeTiers,
  storedTiersFromSnapshot,
  tierRoleIssue,
  tierRoleProblem,
  validateTierRows,
  checkTierRows,
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

describe("storedTiersFromSnapshot (#985)", () => {
  it("returns the stored row, or undefined when none is stored", () => {
    expect(
      storedTiersFromSnapshot([
        { key: "other", value: "x" },
        { key: "leaderboard_roles.tiers", value: "1:111" },
      ]),
    ).toBe("1:111");
    expect(storedTiersFromSnapshot([{ key: "other", value: "x" }])).toBe(
      undefined,
    );
  });
});

describe("tier roles with powerful permissions (#1145)", () => {
  const safe = { id: "r1", name: "Top", managed: false, position: 1 };
  const admin = {
    ...safe,
    permissions: { bitfield: PermissionFlagsBits.Administrator },
  };

  it("flags a role carrying Administrator and names the permission", () => {
    expect(tierRoleIssue(admin, "guild-1", 5)).toBe("privileged");
    expect(tierRoleProblem(admin, "guild-1", 5)).toContain("Administrator");
    expect(tierRoleProblem(admin, "guild-1", 5)).toContain(
      "powerful permissions",
    );
  });

  it("flags every forbidden permission, not just Administrator", () => {
    const ban = {
      ...safe,
      permissions: { bitfield: PermissionFlagsBits.BanMembers },
    };
    expect(tierRoleIssue(ban, "guild-1", 5)).toBe("privileged");
  });

  it("accepts a role with harmless permissions or none readable", () => {
    const harmless = {
      ...safe,
      permissions: { bitfield: PermissionFlagsBits.ManageMessages },
    };
    expect(tierRoleIssue(harmless, "guild-1", 5)).toBeNull();
    expect(tierRoleIssue(safe, "guild-1", 5)).toBeNull();
  });

  it("tolerates an existing role when the caller allows it", () => {
    expect(
      tierRoleIssue(admin, "guild-1", 5, { allowPrivileged: true }),
    ).toBeNull();
  });

  it("reports the structural issues first", () => {
    expect(tierRoleIssue({ ...admin, managed: true }, "guild-1", 5)).toBe(
      "managed",
    );
  });
});

describe("checkTierRows (#1523)", () => {
  it.each([
    [["", "1"], ["111", "222"], [[0, "topN", "Enter a Top N."]]],
    [["1", "2"], ["111", ""], [[1, "roleId", "Pick a role."]]],
    [["abc"], ["111"], [[0, "topN", "Use a whole number greater than 0."]]],
    [["0"], ["111"], [[0, "topN", "Use 1 to 1000."]]],
    [["1001"], ["111"], [[0, "topN", "Use 1 to 1000."]]],
    [["1"], ["x1"], [[0, "roleId", "Pick a role from the list."]]],
    [
      ["1", "1"],
      ["111", "222"],
      [[1, "topN", "Another tier has this Top N. Each Top N must be unique."]],
    ],
    [
      ["1", "2"],
      ["111", "111"],
      [
        [
          1,
          "roleId",
          "Another tier uses this role. Each tier needs its own role.",
        ],
      ],
    ],
  ])("names the field of %j / %j", (topNs, roleIds, expected) => {
    const { errors } = checkTierRows(topNs, roleIds);
    expect(errors.map((e) => [e.index, e.field, e.message])).toEqual(expected);
  });

  it("reports every refused field, not only the first", () => {
    const { errors } = checkTierRows(["x", "2"], ["", "222"]);
    expect(errors.map((e) => `${e.index}:${e.field}`)).toEqual([
      "0:topN",
      "0:roleId",
    ]);
  });

  it("puts the too-many-tiers refusal on the first row past the cap", () => {
    const topNs = Array.from({ length: 26 }, (_, i) => String(i + 1));
    const roleIds = Array.from({ length: 26 }, (_, i) => String(1000 + i));
    const { errors } = checkTierRows(topNs, roleIds);
    expect(errors).toHaveLength(1);
    expect(errors[0]).toMatchObject({ index: 25, field: "topN" });
  });

  it("agrees with validateTierRows on the first refusal", () => {
    const topNs = ["1", "", "1"];
    const roleIds = ["111", "222", "333"];
    expect(validateTierRows(topNs, roleIds)).toEqual({
      ok: false,
      error: checkTierRows(topNs, roleIds).errors[0].flat,
    });
  });
});
