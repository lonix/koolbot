import { describe, it, expect } from "@jest/globals";
import { PermissionFlagsBits, PermissionsBitField } from "discord.js";
import { PERMISSION_PRESETS } from "../../src/services/role-group-plan.js";
import {
  OTHER_GROUP_KEY,
  PERMISSION_GROUPS,
  groupPermissionRows,
} from "../../src/web/role-group-permission-groups.js";

const distinctBits = new Set(Object.values(PermissionFlagsBits));

describe("role group permission groups (#1615)", () => {
  it("places every permission bit in exactly one group, once", () => {
    const seen = groupPermissionRows().flatMap((g) => g.rows.map((r) => r.bit));
    expect(seen).toHaveLength(distinctBits.size);
    expect(new Set(seen)).toEqual(distinctBits);
  });

  it("names only flags discord.js has, and lists a flag in one group only", () => {
    const names = PERMISSION_GROUPS.flatMap((g) => [...g.flags]);
    for (const n of names) expect(PermissionFlagsBits).toHaveProperty(n);
    expect(new Set(names).size).toBe(names.length);
  });

  it("leaves nothing in Other today, so the group is not drawn", () => {
    const groups = groupPermissionRows();
    expect(groups.some((g) => g.key === OTHER_GROUP_KEY)).toBe(false);
  });

  it("puts a flag Discord adds later in an Other group, last", () => {
    const flags = {
      ...PermissionFlagsBits,
      BrandNewThing: 1n << 60n,
    } as Record<string, bigint>;
    const groups = groupPermissionRows(flags);
    const last = groups[groups.length - 1];
    expect(last.key).toBe(OTHER_GROUP_KEY);
    expect(last.title).toBe("Other");
    expect(last.rows.map((r) => r.key)).toEqual(["BrandNewThing"]);
    const all = groups.flatMap((g) => g.rows.map((r) => r.bit));
    expect(new Set(all).size).toBe(distinctBits.size + 1);
  });

  it("keeps Administrator last in the Advanced group", () => {
    const advanced = groupPermissionRows().find((g) => g.key === "advanced");
    expect(advanced?.rows.map((r) => r.key).at(-1)).toBe("Administrator");
  });

  it("finds a flag by its deprecated alias too (one bit, two names)", () => {
    const g = groupPermissionRows().find((x) =>
      x.rows.some((r) => r.key === "ManageEmojisAndStickers"),
    );
    expect(g?.key).toBe("general");
  });

  // The preset script ticks a switch when its value is in the preset's list of names.
  it.each(PERMISSION_PRESETS.map((p) => [p.key, p.permissions] as const))(
    "gives the %s preset a switch for every permission it sets",
    (_key, bits) => {
      const names = new PermissionsBitField(BigInt(bits)).toArray();
      const values = new Set(
        groupPermissionRows().flatMap((g) => g.rows.map((r) => r.key)),
      );
      const ticked = [...values].filter((v) => names.includes(v as never));
      const setBits = ticked.reduce(
        (a, v) =>
          a | PermissionFlagsBits[v as keyof typeof PermissionFlagsBits],
        0n,
      );
      expect(setBits.toString()).toBe(bits);
    },
  );
});
