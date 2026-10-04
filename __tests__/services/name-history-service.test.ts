import { describe, it, expect, beforeEach, jest } from "@jest/globals";

const mockGetBoolean =
  jest.fn<(key: string, def: boolean) => Promise<boolean>>();
jest.unstable_mockModule("../../src/services/config-service.js", () => ({
  ConfigService: {
    getInstance: jest.fn(() => ({ getBoolean: mockGetBoolean })),
  },
}));

const mockTrackWrite =
  jest.fn<
    (
      u: string,
      g: string,
      w: () => Promise<void>,
      since?: number,
    ) => Promise<boolean>
  >();
jest.unstable_mockModule(
  "../../src/services/tracking-opt-out-service.js",
  () => ({
    TrackingOptOutService: {
      getInstance: () => ({ trackWrite: mockTrackWrite }),
    },
  }),
);

const mockBulkWrite = jest.fn<(ops: unknown[], o: unknown) => Promise<void>>();
const mockFind = jest.fn();
jest.unstable_mockModule("../../src/models/user-name-history.js", () => ({
  NAME_KINDS: ["username", "globalName", "nickname"],
  UserNameHistory: { bulkWrite: mockBulkWrite, find: mockFind },
}));

jest.unstable_mockModule("../../src/utils/logger.js", () => ({
  default: {
    info: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
    debug: jest.fn(),
  },
}));

const { NameHistoryService, SNAPSHOT_THROTTLE_MS } =
  await import("../../src/services/name-history-service.js");

const user = { id: "u1", username: "alice", globalName: "Alice A" };

describe("NameHistoryService", () => {
  beforeEach(() => {
    NameHistoryService.reset();
    mockGetBoolean.mockReset().mockResolvedValue(true);
    mockBulkWrite.mockReset().mockResolvedValue(undefined);
    mockFind.mockReset();
    mockTrackWrite.mockReset().mockImplementation(async (_u, _g, write) => {
      await write();
      return true;
    });
  });

  it("upserts one row per name kind, setting firstSeenAt only on insert", async () => {
    await NameHistoryService.getInstance().recordUser("g1", user, "Ally");
    const ops = mockBulkWrite.mock.calls[0]?.[0] as Array<{
      updateOne: {
        filter: Record<string, string>;
        update: Record<string, unknown>;
        upsert: boolean;
      };
    }>;
    expect(ops.map((o) => o.updateOne.filter.kind)).toEqual([
      "username",
      "globalName",
      "nickname",
    ]);
    expect(ops[0].updateOne.upsert).toBe(true);
    expect(Object.keys(ops[0].updateOne.update)).toEqual([
      "$set",
      "$setOnInsert",
    ]);
  });

  it("skips nickname when it is unknown (undefined) but records null as none", async () => {
    await NameHistoryService.getInstance().recordUser("g1", user);
    expect((mockBulkWrite.mock.calls[0]?.[0] as unknown[]).length).toBe(2);
  });

  it("does nothing when namehistory.enabled is off", async () => {
    mockGetBoolean.mockResolvedValue(false);
    await NameHistoryService.getInstance().recordUser("g1", user);
    expect(mockTrackWrite).not.toHaveBeenCalled();
  });

  it("ignores bots", async () => {
    await NameHistoryService.getInstance().recordUser("g1", {
      ...user,
      bot: true,
    });
    expect(mockTrackWrite).not.toHaveBeenCalled();
  });

  it("does not write when the opt-out service refuses the write", async () => {
    mockTrackWrite.mockResolvedValue(false);
    const service = NameHistoryService.getInstance();
    await service.recordUser("g1", user);
    // A refused write must not be cached, so a later sighting retries.
    await service.recordUser("g1", user);
    expect(mockTrackWrite).toHaveBeenCalledTimes(2);
  });

  it("throttles an unchanged member but writes immediately on a change", async () => {
    const service = NameHistoryService.getInstance();
    await service.recordUser("g1", user);
    await service.recordUser("g1", user);
    expect(mockBulkWrite).toHaveBeenCalledTimes(1);

    await service.recordUser("g1", { ...user, username: "alice2" });
    expect(mockBulkWrite).toHaveBeenCalledTimes(2);
  });

  it("re-snapshots an unchanged member after the throttle window", async () => {
    const service = NameHistoryService.getInstance();
    const now = jest.spyOn(Date, "now");
    now.mockReturnValue(1_000_000);
    await service.recordUser("g1", user);
    now.mockReturnValue(1_000_000 + SNAPSHOT_THROTTLE_MS + 1);
    await service.recordUser("g1", user);
    now.mockRestore();
    expect(mockBulkWrite).toHaveBeenCalledTimes(2);
  });

  it("forget() clears the throttle so the next sighting writes", async () => {
    const service = NameHistoryService.getInstance();
    await service.recordUser("g1", user);
    service.forget("g1", "u1");
    await service.recordUser("g1", user);
    expect(mockBulkWrite).toHaveBeenCalledTimes(2);
  });

  it("never throws from a failing write", async () => {
    mockBulkWrite.mockRejectedValue(new Error("db down"));
    await expect(
      NameHistoryService.getInstance().recordUser("g1", user),
    ).resolves.toBeUndefined();
  });

  it("groups history by kind", async () => {
    const d = new Date("2025-01-01");
    mockFind.mockReturnValue({
      sort: () => ({
        lean: async () => [
          { kind: "username", name: "a", firstSeenAt: d, lastSeenAt: d },
          { kind: "nickname", name: "n", firstSeenAt: d, lastSeenAt: d },
        ],
      }),
    });
    const history = await NameHistoryService.getInstance().getHistory(
      "g1",
      "u1",
    );
    expect(history.username).toHaveLength(1);
    expect(history.globalName).toHaveLength(0);
    expect(history.nickname[0].name).toBe("n");
  });
});
