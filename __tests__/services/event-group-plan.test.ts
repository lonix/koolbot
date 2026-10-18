import { describe, it, expect } from "@jest/globals";
import {
  EVENT_MEMBER_MAX,
  GROUP_MEMBER_MAX,
  groupCapacity,
  planAssign,
  planRandomise,
  seededRandom,
  shuffle,
  type PlanGroup,
} from "../../src/services/event-group-plan.js";

const g = (
  key: string,
  size: number | null,
  memberIds: string[] = [],
  kind = "team",
): PlanGroup => ({ key, kind, size, memberIds });

const ids = (n: number, prefix = "u"): string[] =>
  Array.from({ length: n }, (_, i) => `${prefix}${i + 1}`);

describe("groupCapacity", () => {
  it("is the size, or the voice-channel maximum when unsized", () => {
    expect(groupCapacity({ size: 5 })).toBe(5);
    expect(groupCapacity({ size: null })).toBe(GROUP_MEMBER_MAX);
    expect(groupCapacity({ size: 500 })).toBe(GROUP_MEMBER_MAX);
  });
});

describe("planAssign", () => {
  it("adds a member to a team group", () => {
    const plan = planAssign([g("a", 2), g("b", null)], "x", "a");
    expect(plan).toEqual({
      ok: true,
      changed: true,
      fromKey: null,
      toKey: "a",
      changes: { a: ["x"] },
    });
  });

  it("moves a member: out of the old group and into the new one in one change set", () => {
    const plan = planAssign([g("a", 2, ["x", "y"]), g("b", 2)], "x", "b");
    expect(plan).toMatchObject({
      ok: true,
      changed: true,
      fromKey: "a",
      toKey: "b",
      changes: { a: ["y"], b: ["x"] },
    });
  });

  it("refuses a full group and changes nothing", () => {
    const groups = [g("a", 2, ["y", "z"]), g("b", 2, ["x"])];
    expect(planAssign(groups, "x", "a")).toEqual({ ok: false, reason: "full" });
  });

  it("lets a member stay in a full group they are already in", () => {
    const plan = planAssign([g("a", 1, ["x"])], "x", "a");
    expect(plan).toMatchObject({ ok: true, changed: false, changes: {} });
  });

  it("refuses open and leads groups and unknown keys", () => {
    const groups = [
      g("t", 2),
      g("o", null, [], "open"),
      g("l", 2, [], "leads"),
    ];
    expect(planAssign(groups, "x", "o")).toEqual({
      ok: false,
      reason: "not-team",
    });
    expect(planAssign(groups, "x", "l")).toEqual({
      ok: false,
      reason: "not-team",
    });
    expect(planAssign(groups, "x", "nope")).toEqual({
      ok: false,
      reason: "no-group",
    });
  });

  it("unassigns, and unassigning an unassigned member is a no-op", () => {
    const groups = [g("a", 2, ["x"]), g("b", 2)];
    expect(planAssign(groups, "x", null)).toMatchObject({
      ok: true,
      changed: true,
      fromKey: "a",
      toKey: null,
      changes: { a: [] },
    });
    expect(planAssign(groups, "nobody", null)).toMatchObject({
      ok: true,
      changed: false,
    });
  });

  it("cleans a member who somehow sits in two groups", () => {
    const plan = planAssign([g("a", 3, ["x"]), g("b", 3, ["x"])], "x", "a");
    expect(plan).toMatchObject({
      ok: true,
      changed: true,
      changes: { b: [] },
    });
  });

  it("holds an unsized group to the voice-channel maximum", () => {
    const full = ids(GROUP_MEMBER_MAX);
    expect(planAssign([g("a", null, full)], "x", "a")).toEqual({
      ok: false,
      reason: "full",
    });
  });

  it("holds an event to its total member limit", () => {
    const groups = Array.from({ length: 6 }, (_, i) =>
      g(`k${i}`, null, ids(84, `m${i}_`)),
    );
    // 6 groups x 84 = 504 >= 500: a newcomer is refused, a mover is not.
    expect(planAssign(groups, "new", "k0")).toEqual({
      ok: false,
      reason: "event-full",
    });
    expect(planAssign(groups, "m1_1", "k0")).toMatchObject({
      ok: true,
      changed: true,
    });
  });
});

describe("seeded shuffle", () => {
  it("is deterministic per seed and a permutation", () => {
    const a = shuffle(ids(20), seededRandom(7));
    const b = shuffle(ids(20), seededRandom(7));
    const c = shuffle(ids(20), seededRandom(8));
    expect(a).toEqual(b);
    expect(a).not.toEqual(c);
    expect([...a].sort()).toEqual([...ids(20)].sort());
  });

  it("does not modify its input", () => {
    const input = ids(5);
    shuffle(input, seededRandom(1));
    expect(input).toEqual(ids(5));
  });
});

describe("planRandomise", () => {
  const sizes = (
    groups: PlanGroup[],
    changes: Record<string, string[]>,
  ): Record<string, number> =>
    Object.fromEntries(
      groups
        .filter((x) => x.kind === "team")
        .map((x) => [x.key, (changes[x.key] ?? x.memberIds).length]),
    );

  it("splits people evenly across unsized groups (sizes differ by at most one)", () => {
    for (const n of [1, 2, 7, 12, 13, 98]) {
      const groups = [g("a", null), g("b", null), g("c", null), g("d", null)];
      const plan = planRandomise(groups, ids(n), "unassigned", seededRandom(n));
      if (!plan.ok) throw new Error("expected a plan");
      const counts = Object.values(sizes(groups, plan.changes));
      expect(Math.max(...counts) - Math.min(...counts)).toBeLessThanOrEqual(1);
      expect(counts.reduce((x, y) => x + y, 0)).toBe(n);
      expect(plan.unplaced).toEqual([]);
    }
  });

  it("fills sized groups up to their size, in order, and lists who does not fit", () => {
    const groups = [g("heli", 2), g("assault", 3)];
    const plan = planRandomise(groups, ids(8), "unassigned", seededRandom(3));
    if (!plan.ok) throw new Error("expected a plan");
    expect(plan.changes.heli).toHaveLength(2);
    expect(plan.changes.assault).toHaveLength(3);
    expect(plan.placed).toHaveLength(5);
    expect(plan.unplaced).toHaveLength(3);
    // Everyone is either placed or listed, exactly once.
    const all = [...plan.placed.map((p) => p.userId), ...plan.unplaced].sort();
    expect(all).toEqual([...ids(8)].sort());
  });

  it("fills sized groups before sharing the rest evenly among unsized ones", () => {
    const groups = [g("sized", 2), g("u1", null), g("u2", null)];
    const plan = planRandomise(groups, ids(7), "unassigned", seededRandom(1));
    if (!plan.ok) throw new Error("expected a plan");
    expect(plan.changes.sized).toHaveLength(2);
    expect(plan.changes.u1.length + plan.changes.u2.length).toBe(5);
    expect(Math.abs(plan.changes.u1.length - plan.changes.u2.length)).toBe(1);
  });

  it("is reproducible for a seed and different for another", () => {
    const groups = [g("a", null), g("b", null)];
    const run = (seed: number): unknown => {
      const p = planRandomise(
        groups,
        ids(10),
        "unassigned",
        seededRandom(seed),
      );
      return p.ok ? p.changes : null;
    };
    expect(run(5)).toEqual(run(5));
    expect(run(5)).not.toEqual(run(6));
  });

  it("deals only the unassigned in 'unassigned' mode and leaves the placed alone", () => {
    const groups = [g("a", null, ["p1", "p2"]), g("b", null, [])];
    const plan = planRandomise(
      groups,
      ["p1", "p2", "n1", "n2", "n3", "n4"],
      "unassigned",
      seededRandom(2),
    );
    if (!plan.ok) throw new Error("expected a plan");
    // p1, p2 stay in a; the four newcomers go to b first (fewest), then evenly (3 and 3).
    expect(plan.changes.a ?? groups[0].memberIds).toEqual(
      expect.arrayContaining(["p1", "p2"]),
    );
    const counts = sizes(groups, plan.changes);
    expect(counts.a).toBe(3);
    expect(counts.b).toBe(3);
    expect(plan.placed).toHaveLength(4);
  });

  it("deals everyone again in 'everyone' mode, keeping the absent in place", () => {
    const groups = [
      g("a", null, ["here1", "away"]),
      g("b", null, ["here2", "here3"]),
    ];
    const plan = planRandomise(
      groups,
      ["here1", "here2", "here3"],
      "everyone",
      seededRandom(9),
    );
    if (!plan.ok) throw new Error("expected a plan");
    const after: Record<string, string[]> = {
      a: plan.changes.a ?? groups[0].memberIds,
      b: plan.changes.b ?? groups[1].memberIds,
    };
    expect(after.a).toContain("away");
    const everyone = [...after.a, ...after.b].sort();
    expect(everyone).toEqual(["away", "here1", "here2", "here3"].sort());
    // One group per member.
    expect(new Set(everyone).size).toBe(everyone.length);
    // The absent member counts towards their group's load: 4 people, 2 and 2.
    expect(after.a).toHaveLength(2);
    expect(after.b).toHaveLength(2);
  });

  it("an 'everyone' deal that does not fit leaves the overflow unassigned", () => {
    const groups = [g("a", 1, ["x"]), g("b", 1, ["y"])];
    const plan = planRandomise(
      groups,
      ["x", "y", "z"],
      "everyone",
      seededRandom(4),
    );
    if (!plan.ok) throw new Error("expected a plan");
    expect(plan.placed).toHaveLength(2);
    expect(plan.unplaced).toHaveLength(1);
    expect(plan.before.x).toBe("a");
  });

  it("never targets open or leads groups, and refuses an event without a team", () => {
    const groups = [
      g("t", null),
      g("o", null, [], "open"),
      g("l", 3, [], "leads"),
    ];
    const plan = planRandomise(groups, ids(5), "unassigned", seededRandom(1));
    if (!plan.ok) throw new Error("expected a plan");
    expect(plan.changes.o).toBeUndefined();
    expect(plan.changes.l).toBeUndefined();
    expect(plan.changes.t).toHaveLength(5);
    expect(
      planRandomise(
        [g("o", null, [], "open")],
        ids(2),
        "unassigned",
        seededRandom(1),
      ),
    ).toEqual({ ok: false, reason: "no-teams" });
  });

  it("ignores duplicate and empty candidate ids", () => {
    const groups = [g("a", null)];
    const plan = planRandomise(
      groups,
      ["x", "x", "", "y"],
      "unassigned",
      seededRandom(1),
    );
    if (!plan.ok) throw new Error("expected a plan");
    expect(plan.changes.a.sort()).toEqual(["x", "y"]);
  });

  it("stops at the event member limit", () => {
    const groups = Array.from({ length: 6 }, (_, i) => g(`k${i}`, null));
    const plan = planRandomise(groups, ids(520), "unassigned", seededRandom(1));
    if (!plan.ok) throw new Error("expected a plan");
    expect(plan.placed).toHaveLength(EVENT_MEMBER_MAX);
    expect(plan.unplaced).toHaveLength(20);
  });
});
