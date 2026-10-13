import { it, expect, beforeAll, beforeEach } from "@jest/globals";
import { describeWithMongo, useRealMongo } from "./mongo-harness.js";
import { AdoptionSnapshot } from "../../src/models/adoption-snapshot.js";
import {
  getSnapshotDetail,
  listSnapshots,
} from "../../src/services/adoption-snapshot-history.js";

/**
 * The history queries are aggregation pipelines; a mock cannot show that
 * Mongo accepts them or that member ids really stay out of the result (#1025).
 */
describeWithMongo("adoption snapshot history against a real MongoDB", () => {
  useRealMongo();

  beforeAll(async () => {
    await AdoptionSnapshot.init();
  });
  beforeEach(async () => {
    await AdoptionSnapshot.deleteMany({});
  });

  const make = (guildId: string, n: number, extra: object = {}) =>
    AdoptionSnapshot.create({
      planId: `plan-${n}`,
      guildId,
      appliedBy: "admin",
      status: "partial",
      createdAt: new Date(2026, 9, 1, 0, n),
      plan: {
        operations: [
          {
            id: "op-1",
            type: "member.role.add",
            class: "additive",
            summary: "Grant role",
            memberIds: ["secret-member-1", "secret-member-2"],
          },
          { id: "op-2", class: "destructive", summary: "Delete channel" },
        ],
      },
      baseline: { roles: [{ id: "baseline-marker" }] },
      operations: [
        { opId: "op-1", status: "failed" },
        { opId: "op-2", status: "skipped" },
      ],
      memberProgress: {
        "op-1": { done: 2, failed: [], granted: ["secret-member-1"] },
      },
      createdRoles: [{ ref: "r", roleId: "1", name: "x" }],
      ...extra,
    });

  it("pages through every snapshot of a server, newest first", async () => {
    for (let i = 0; i < 5; i += 1) await make("g1", i);
    await make("other", 9);
    const first = await listSnapshots("g1", 1, 2);
    const second = await listSnapshots("g1", 2, 2);
    const third = await listSnapshots("g1", 3, 2);
    expect(first.snapshots.map((s) => s.planId)).toEqual(["plan-4", "plan-3"]);
    expect(first.hasMore).toBe(true);
    expect(second.snapshots.map((s) => s.planId)).toEqual(["plan-2", "plan-1"]);
    expect(third.snapshots.map((s) => s.planId)).toEqual(["plan-0"]);
    expect(third.hasMore).toBe(false);
  });

  it("returns counts and summaries without member ids or the baseline", async () => {
    const doc = await make("g1", 1);
    const page = await listSnapshots("g1");
    expect(page.snapshots[0]).toMatchObject({
      failed: 1,
      skipped: 1,
      destructive: 1,
      createdRoles: 1,
    });
    const detail = await getSnapshotDetail("g1", String(doc._id));
    // op-1 failed but holds a persisted grant, so a rollback still reverts it.
    expect(detail?.operations).toEqual([
      { summary: "Grant role", destructive: false },
    ]);
    const text = JSON.stringify([page, detail]);
    expect(text).not.toContain("secret-member");
    expect(text).not.toContain("baseline-marker");
  });

  it("scopes a lookup to the server", async () => {
    const doc = await make("g1", 1);
    expect(await getSnapshotDetail("g2", String(doc._id))).toBeNull();
  });
});
