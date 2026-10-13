import { describe, it, expect, jest, beforeEach } from "@jest/globals";

const mockAggregate = jest.fn<(...a: any[]) => Promise<any[]>>();
jest.unstable_mockModule("../../src/models/adoption-snapshot.js", () => ({
  AdoptionSnapshot: { aggregate: mockAggregate },
}));

const { listSnapshots, getSnapshotDetail, canRollback, snapshotPipeline } =
  await import("../../src/services/adoption-snapshot-history.js");
const { appliedOperationIds, remainingReversibleIds } =
  await import("../../src/services/adoption-rollback-selection.js");

const ID = "b".repeat(24);
const doc = (over: Record<string, unknown> = {}) => ({
  _id: ID,
  planId: "p1",
  appliedBy: "admin",
  status: "partial",
  createdAt: new Date("2026-10-01T10:00:00Z"),
  operations: [
    { opId: "a", status: "applied" },
    { opId: "b", status: "failed" },
    { opId: "c", status: "skipped" },
    { opId: "d", status: "failed" },
    { opId: "e", status: "applied" },
  ],
  createdRoles: 1,
  planOps: [
    { id: "a", summary: "Create role", class: "additive" },
    { id: "b", summary: "Delete channel", class: "destructive" },
    { id: "c", summary: "Skipped", class: "additive" },
    { id: "d", summary: "Grant role", class: "additive" },
    { id: "e", summary: "Edit role", class: "additive" },
  ],
  grantedOps: ["d"],
  rolledBackOps: ["e"],
  ...over,
});

beforeEach(() => jest.clearAllMocks());

describe("adoption snapshot history", () => {
  it("lists a page newest first, scoped to the server, and says whether older snapshots exist", async () => {
    mockAggregate.mockResolvedValue([doc(), doc(), doc()]);
    const page = await listSnapshots("g1", 2, 2);
    const pipeline = mockAggregate.mock.calls[0][0] as Record<
      string,
      unknown
    >[];
    expect(pipeline[0]).toEqual({ $match: { guildId: "g1" } });
    expect(pipeline[1]).toEqual({ $sort: { createdAt: -1 } });
    expect(pipeline).toContainEqual({ $skip: 2 });
    expect(pipeline).toContainEqual({ $limit: 3 });
    expect(page.snapshots).toHaveLength(2);
    expect(page.hasMore).toBe(true);
    expect(page.page).toBe(2);
    expect(page.snapshots[0]).toMatchObject({
      applied: 2,
      failed: 2,
      skipped: 1,
      destructive: 1,
      createdRoles: 1,
    });
  });

  it("reaches the last page without claiming more, and clamps a bad page", async () => {
    mockAggregate.mockResolvedValue([doc()]);
    expect((await listSnapshots("g1", 3, 2)).hasMore).toBe(false);
    await listSnapshots("g1", -4, 2);
    const pipeline = mockAggregate.mock.calls[1][0] as Record<
      string,
      unknown
    >[];
    expect(pipeline).toContainEqual({ $skip: 0 });
  });

  it("never selects member ids, grants or the baseline", () => {
    const text = JSON.stringify(snapshotPipeline({ guildId: "g" }));
    expect(text).not.toContain("memberIds");
    expect(text).not.toContain("baseline");
    const project = (
      snapshotPipeline({ guildId: "g" }).find((s) => "$project" in s) as {
        $project: Record<string, any>;
      }
    ).$project;
    // Three fields per planned operation, nothing else.
    expect(Object.keys(project.planOps.$map.in).sort()).toEqual([
      "class",
      "id",
      "summary",
      "type",
    ]);
    expect(Object.keys(project.operations.$map.in).sort()).toEqual([
      "opId",
      "startedAt",
      "status",
    ]);
    // Grants are reduced to the operation names; the granted ids stay put.
    expect(project.grantedOps.$map.in).toBe("$$p.k");
    expect(project.inflightOps.$map.in).toBe("$$p.k");
    expect(project.memberProgress).toBeUndefined();
    expect(project.plan).toBeUndefined();
  });

  it("lists exactly what a rollback would still revert", async () => {
    mockAggregate.mockResolvedValue([doc()]);
    const d = await getSnapshotDetail("g1", ID);
    // a: applied; b, c: failed or skipped with no grants; d: failed with
    // persisted grants (reversible); e: applied but already rolled back.
    expect(d?.operations).toEqual([
      { summary: "Create role", destructive: false },
      { summary: "Grant role", destructive: false },
    ]);
  });

  it("counts interrupted steps a restore may also revert, so the page never under-promises", async () => {
    mockAggregate.mockResolvedValue([
      doc({
        operations: [
          { opId: "a", status: "applied" },
          // Started, never recorded as finished: the engine looks it up live.
          { opId: "b", status: "pending", startedAt: new Date() },
          { opId: "c", status: "pending", startedAt: new Date() },
          { opId: "d", status: "failed" },
          { opId: "e", status: "applied" },
        ],
        planOps: [
          { id: "a", type: "role.edit", summary: "A", class: "additive" },
          {
            id: "b",
            type: "channel.delete",
            summary: "B",
            class: "destructive",
          },
          // A config write is never reconciled, so it is not "interrupted".
          { id: "c", type: "config.set", summary: "C", class: "additive" },
          { id: "d", type: "member.role.add", summary: "D", class: "additive" },
          { id: "e", type: "role.edit", summary: "E", class: "additive" },
        ],
        grantedOps: [],
        // Member grants that were in flight when the bot died.
        inflightOps: ["d"],
        rolledBackOps: ["e"],
      }),
    ]);
    const d = await getSnapshotDetail("g1", ID);
    expect(d?.operations.map((o) => o.summary)).toEqual(["A"]);
    expect(d?.interrupted).toBe(2); // b (started delete) and d (in flight)
  });

  it("offers deleting created roles only for role creations a restore can still reach", async () => {
    const planOps = [
      { id: "r1", type: "role.create", summary: "R1", class: "additive" },
      { id: "r2", type: "role.create", summary: "R2", class: "additive" },
    ];
    const operations = [
      { opId: "r1", status: "applied" },
      { opId: "r2", status: "applied" },
    ];
    // A previous restore with the box unticked still marks both as rolled back.
    mockAggregate.mockResolvedValue([
      doc({
        planOps,
        operations,
        rolledBackOps: ["r1", "r2"],
        createdRoles: 2,
      }),
    ]);
    const spent = await getSnapshotDetail("g1", ID);
    expect(spent?.createdRoles).toBe(2);
    expect(spent?.revertibleCreatedRoles).toBe(0);
    mockAggregate.mockResolvedValue([
      doc({ planOps, operations, rolledBackOps: ["r1"], createdRoles: 2 }),
    ]);
    expect((await getSnapshotDetail("g1", ID))?.revertibleCreatedRoles).toBe(1);
  });

  it("answers null for a missing snapshot and never queries a malformed id", async () => {
    mockAggregate.mockResolvedValue([]);
    expect(await getSnapshotDetail("g1", ID)).toBeNull();
    mockAggregate.mockClear();
    expect(await getSnapshotDetail("g1", "not-an-id")).toBeNull();
    expect(mockAggregate).not.toHaveBeenCalled();
  });

  it("only offers rollback for the statuses the engine can claim", () => {
    expect(["applied", "partial", "rollback_partial"].every(canRollback)).toBe(
      true,
    );
    expect(
      ["applying", "rolling_back", "rolled_back"].some((s) =>
        canRollback(s as never),
      ),
    ).toBe(false);
  });
});

describe("rollback selection (shared with the engine)", () => {
  const ops = [
    { opId: "a", status: "applied" },
    { opId: "b", status: "failed" },
    { opId: "c", status: "failed" },
    { opId: "d", status: "skipped" },
  ];
  it("reverts applied operations and failed ones that hold grants", () => {
    const granted = (id: string) => (id === "c" ? 2 : 0);
    expect([...appliedOperationIds(ops, granted)].sort()).toEqual(["a", "c"]);
    expect(remainingReversibleIds(ops, granted, ["a"])).toEqual(["c"]);
  });
});
