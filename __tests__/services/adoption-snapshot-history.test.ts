import { describe, it, expect, jest, beforeEach } from "@jest/globals";

const chain = (result: unknown) => {
  const q: Record<string, unknown> = {};
  for (const m of ["select", "sort", "limit"]) q[m] = jest.fn(() => q);
  q.lean = jest.fn(async () => result);
  return q;
};
const mockFind = jest.fn<(...a: any[]) => any>();
const mockFindOne = jest.fn<(...a: any[]) => any>();
jest.unstable_mockModule("../../src/models/adoption-snapshot.js", () => ({
  AdoptionSnapshot: { find: mockFind, findOne: mockFindOne },
}));

const { listSnapshots, getSnapshotDetail, canRollback } =
  await import("../../src/services/adoption-snapshot-history.js");

const ID = "b".repeat(24);
const doc = {
  _id: ID,
  planId: "p1",
  appliedBy: "admin",
  status: "partial",
  createdAt: new Date("2026-10-01T10:00:00Z"),
  operations: [
    { opId: "a", status: "applied" },
    { opId: "b", status: "failed" },
    { opId: "c", status: "skipped" },
  ],
  createdRoles: [{ ref: "r" }],
  plan: {
    operations: [
      { id: "a", summary: "Create role", class: "additive" },
      { id: "b", summary: "Delete channel", class: "destructive" },
    ],
  },
};

beforeEach(() => jest.clearAllMocks());

describe("adoption snapshot history", () => {
  it("lists newest first, scoped to the server, never selecting baseline or member ids", async () => {
    const q = chain([doc]);
    mockFind.mockReturnValue(q);
    const rows = await listSnapshots("g1", 10);
    expect(mockFind).toHaveBeenCalledWith({ guildId: "g1" });
    expect(q.sort).toHaveBeenCalledWith({ createdAt: -1 });
    expect(q.limit).toHaveBeenCalledWith(10);
    const fields = String((q.select as jest.Mock).mock.calls[0][0]);
    expect(fields).not.toContain("baseline");
    expect(fields).not.toContain("memberProgress");
    expect(rows[0]).toMatchObject({
      id: ID,
      applied: 1,
      failed: 1,
      skipped: 1,
      destructive: 1,
      createdRoles: 1,
    });
  });

  it("returns per-step status for one snapshot of this server only", async () => {
    mockFindOne.mockReturnValue(chain(doc));
    const d = await getSnapshotDetail("g1", ID);
    expect(mockFindOne).toHaveBeenCalledWith({ _id: ID, guildId: "g1" });
    expect(d?.operations).toEqual([
      { summary: "Create role", destructive: false, status: "applied" },
      { summary: "Delete channel", destructive: true, status: "failed" },
    ]);
  });

  it("answers null for a missing snapshot and never queries a malformed id", async () => {
    mockFindOne.mockReturnValue(chain(null));
    expect(await getSnapshotDetail("g1", ID)).toBeNull();
    mockFindOne.mockClear();
    expect(await getSnapshotDetail("g1", "not-an-id")).toBeNull();
    expect(mockFindOne).not.toHaveBeenCalled();
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
