import { describe, it, expect, jest, beforeEach } from "@jest/globals";
import { AuditLogEvent } from "discord.js";

// The moderation-service touches a Mongoose model and ConfigService at
// runtime. Mock both so the pure mapper and the service's gating/write logic
// can be exercised without a DB (mirrors the event-service test).
const getBooleanMock = jest.fn<() => Promise<boolean>>();

jest.unstable_mockModule("../../src/services/config-service.js", () => ({
  ConfigService: {
    getInstance: jest.fn(() => ({
      getBoolean: getBooleanMock,
      getString: jest.fn(),
      getNumber: jest.fn(),
      registerReloadCallback: jest.fn(),
    })),
  },
}));

const createMock = jest.fn<(doc: unknown) => Promise<unknown>>();
const findMock = jest.fn();
const countExecMock = jest.fn<() => Promise<number>>();
const countDocumentsMock = jest.fn(() => ({ exec: countExecMock }));

function makeQuery(result: unknown[]): Record<string, unknown> {
  const q: Record<string, unknown> = {};
  q.sort = jest.fn(() => q);
  q.skip = jest.fn(() => q);
  q.limit = jest.fn(() => q);
  q.lean = jest.fn(() => q);
  q.exec = jest.fn(async () => result);
  return q;
}

jest.unstable_mockModule("../../src/models/moderation-log.js", () => ({
  ModerationLog: {
    create: createMock,
    find: findMock,
    countDocuments: countDocumentsMock,
  },
}));

jest.unstable_mockModule("../../src/utils/logger.js", () => ({
  default: {
    info: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
    debug: jest.fn(),
  },
}));

jest.unstable_mockModule("../../src/utils/log-sanitize.js", () => ({
  sanitizeForLog: (v: unknown) => String(v),
}));

const { ModerationService, mapAuditLogEntry } = await import(
  "../../src/services/moderation-service.js"
);

// A distinct fake client per test keeps the getInstance singleton from
// leaking a stale client across the suite.
function freshService(): InstanceType<typeof ModerationService> {
  ModerationService.reset();
  const client = { tag: "fake-client" } as never;
  return ModerationService.getInstance(client);
}

beforeEach(() => {
  jest.clearAllMocks();
  findMock.mockImplementation(() => makeQuery([]));
});

describe("mapAuditLogEntry", () => {
  const base = { reason: "spam", changes: [] as never[] };

  it("maps kick / ban / unban actions", () => {
    expect(mapAuditLogEntry({ ...base, action: AuditLogEvent.MemberKick })).toEqual({
      action: "kick",
      reason: "spam",
    });
    expect(
      mapAuditLogEntry({ ...base, action: AuditLogEvent.MemberBanAdd }),
    ).toEqual({ action: "ban", reason: "spam" });
    expect(
      mapAuditLogEntry({ ...base, action: AuditLogEvent.MemberBanRemove }),
    ).toEqual({ action: "unban", reason: "spam" });
  });

  it("treats a MemberUpdate that sets communication_disabled_until as a timeout", () => {
    const result = mapAuditLogEntry({
      action: AuditLogEvent.MemberUpdate,
      reason: null,
      changes: [
        {
          key: "communication_disabled_until",
          new: "2999-01-01T00:00:00.000Z",
        },
      ],
    });
    expect(result).toEqual({ action: "timeout", reason: null });
  });

  it("treats a cleared communication_disabled_until as untimeout", () => {
    const result = mapAuditLogEntry({
      action: AuditLogEvent.MemberUpdate,
      reason: null,
      changes: [{ key: "communication_disabled_until", new: undefined }],
    });
    expect(result).toEqual({ action: "untimeout", reason: null });
  });

  it("ignores a MemberUpdate without a timeout change (e.g. nickname edit)", () => {
    expect(
      mapAuditLogEntry({
        action: AuditLogEvent.MemberUpdate,
        reason: null,
        changes: [{ key: "nick", new: "New Nick" }],
      }),
    ).toBeNull();
  });

  it("ignores unrelated audit-log actions", () => {
    expect(
      mapAuditLogEntry({
        action: AuditLogEvent.ChannelCreate,
        reason: null,
        changes: [],
      }),
    ).toBeNull();
  });
});

describe("ModerationService.isEnabled", () => {
  it("reads the moderation.enabled config key", async () => {
    getBooleanMock.mockResolvedValueOnce(true);
    const service = freshService();

    await expect(service.isEnabled()).resolves.toBe(true);
    expect(getBooleanMock).toHaveBeenCalledWith("moderation.enabled", false);
  });
});

describe("ModerationService.logWarn", () => {
  it("writes a warn row with source=command", async () => {
    createMock.mockResolvedValueOnce({ id: "row1" });
    const service = freshService();

    const result = await service.logWarn({
      guildId: "g1",
      userId: "u1",
      moderatorId: "m1",
      reason: "being rude",
    });

    expect(createMock).toHaveBeenCalledWith({
      guildId: "g1",
      userId: "u1",
      moderatorId: "m1",
      action: "warn",
      reason: "being rude",
      source: "command",
    });
    expect(result).toEqual({ id: "row1" });
  });
});

describe("ModerationService.handleAuditLogEntry", () => {
  const guild = { id: "g1" } as never;

  it("does nothing when the feature is disabled", async () => {
    getBooleanMock.mockResolvedValue(false);
    const service = freshService();

    await service.handleAuditLogEntry(
      {
        action: AuditLogEvent.MemberKick,
        reason: "x",
        changes: [],
        targetId: "u1",
        executorId: "m1",
      } as never,
      guild,
    );

    expect(createMock).not.toHaveBeenCalled();
  });

  it("mirrors a native kick as an audit-sourced row", async () => {
    getBooleanMock.mockResolvedValue(true);
    const service = freshService();

    await service.handleAuditLogEntry(
      {
        action: AuditLogEvent.MemberBanAdd,
        reason: "raiding",
        changes: [],
        targetId: "u9",
        executorId: "m9",
      } as never,
      guild,
    );

    expect(createMock).toHaveBeenCalledWith({
      guildId: "g1",
      userId: "u9",
      moderatorId: "m9",
      action: "ban",
      reason: "raiding",
      source: "audit",
    });
  });

  it("skips entries with no target", async () => {
    getBooleanMock.mockResolvedValue(true);
    const service = freshService();

    await service.handleAuditLogEntry(
      {
        action: AuditLogEvent.MemberKick,
        reason: null,
        changes: [],
        targetId: null,
        executorId: "m1",
      } as never,
      guild,
    );

    expect(createMock).not.toHaveBeenCalled();
  });

  it("never throws when the write fails", async () => {
    getBooleanMock.mockResolvedValue(true);
    createMock.mockRejectedValueOnce(new Error("db down"));
    const service = freshService();

    await expect(
      service.handleAuditLogEntry(
        {
          action: AuditLogEvent.MemberKick,
          reason: null,
          changes: [],
          targetId: "u1",
          executorId: "m1",
        } as never,
        guild,
      ),
    ).resolves.toBeUndefined();
  });
});

describe("ModerationService query helpers", () => {
  it("getHistory filters by guild + user and paginates", async () => {
    const query = makeQuery([{ id: "h1" }]);
    findMock.mockReturnValueOnce(query);
    const service = freshService();

    const rows = await service.getHistory("g1", "u1", { limit: 10, skip: 20 });

    expect(findMock).toHaveBeenCalledWith({ guildId: "g1", userId: "u1" });
    expect(query.skip).toHaveBeenCalledWith(20);
    expect(query.limit).toHaveBeenCalledWith(10);
    expect(rows).toEqual([{ id: "h1" }]);
  });

  it("getRecent applies action + user filters when provided", async () => {
    const query = makeQuery([]);
    findMock.mockReturnValueOnce(query);
    const service = freshService();

    await service.getRecent("g1", {
      action: "ban",
      userId: "u1",
      limit: 50,
      skip: 0,
    });

    expect(findMock).toHaveBeenCalledWith({
      guildId: "g1",
      action: "ban",
      userId: "u1",
    });
  });

  it("countRecent omits absent filters", async () => {
    countExecMock.mockResolvedValueOnce(7);
    const service = freshService();

    const total = await service.countRecent("g1", {});

    expect(countDocumentsMock).toHaveBeenCalledWith({ guildId: "g1" });
    expect(total).toBe(7);
  });
});
