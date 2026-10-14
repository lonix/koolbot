import { describe, it, expect, beforeEach, jest } from "@jest/globals";
import { AuditLogEvent } from "discord.js";
import { GUILD_MEMBERS_INTENT_HOWTO } from "../../src/utils/guild-members-intent.js";

const mockRevokeForUser = jest.fn<(id: string) => Promise<number>>();
const mockEnv = { guildId: "guild-1", guildMembersIntent: true };
const mockLogger = {
  warn: jest.fn(),
  error: jest.fn(),
  info: jest.fn(),
  debug: jest.fn(),
};

jest.unstable_mockModule("../../src/services/web-session-service.js", () => ({
  WebSessionService: {
    getInstance: jest.fn(() => ({ revokeForUser: mockRevokeForUser })),
  },
}));
jest.unstable_mockModule("../../src/config/env.js", () => ({ env: mockEnv }));
jest.unstable_mockModule("../../src/utils/logger.js", () => ({
  default: mockLogger,
}));

const {
  revokeWebSessionsForDeparture,
  handleDepartureAuditEntry,
  warnIfLeaveEventsMissing,
} = await import("../../src/services/member-departure-sessions.js");

describe("member departure web session revocation (#1151)", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockRevokeForUser.mockResolvedValue(1);
    mockEnv.guildMembersIntent = true;
  });

  it("revokes a member's sessions when they leave", async () => {
    await expect(revokeWebSessionsForDeparture("42", "left")).resolves.toBe(1);
    expect(mockRevokeForUser).toHaveBeenCalledWith("42");
  });

  it("revokes on a kick audit entry", async () => {
    await handleDepartureAuditEntry({
      action: AuditLogEvent.MemberKick,
      targetId: "42",
    });
    expect(mockRevokeForUser).toHaveBeenCalledWith("42");
  });

  it("revokes on a ban audit entry", async () => {
    await handleDepartureAuditEntry({
      action: AuditLogEvent.MemberBanAdd,
      targetId: "42",
    });
    expect(mockRevokeForUser).toHaveBeenCalledWith("42");
  });

  it.each([
    AuditLogEvent.MemberBanRemove,
    AuditLogEvent.MemberUpdate,
    AuditLogEvent.ChannelCreate,
  ])("ignores audit action %s", async (action) => {
    await handleDepartureAuditEntry({ action, targetId: "42" });
    expect(mockRevokeForUser).not.toHaveBeenCalled();
  });

  it("ignores a kick entry with no target", async () => {
    await handleDepartureAuditEntry({
      action: AuditLogEvent.MemberKick,
      targetId: null,
    });
    expect(mockRevokeForUser).not.toHaveBeenCalled();
  });

  it("is a quiet no-op for a member who is not signed in", async () => {
    mockRevokeForUser.mockResolvedValue(0);
    await expect(revokeWebSessionsForDeparture("42", "left")).resolves.toBe(0);
    expect(mockLogger.info).not.toHaveBeenCalled();
    expect(mockLogger.warn).not.toHaveBeenCalled();
  });

  it("never throws when the revoke fails", async () => {
    mockRevokeForUser.mockRejectedValue(new Error("db down"));
    await expect(revokeWebSessionsForDeparture("42", "ban")).resolves.toBe(0);
    expect(mockLogger.warn).toHaveBeenCalledWith(
      expect.stringContaining("db down"),
    );
    await expect(
      handleDepartureAuditEntry({
        action: AuditLogEvent.MemberKick,
        targetId: "42",
      }),
    ).resolves.toBeUndefined();
  });

  describe("warnIfLeaveEventsMissing", () => {
    it("warns once-per-call when the Web UI is on and the intent is off", () => {
      mockEnv.guildMembersIntent = false;
      expect(warnIfLeaveEventsMissing(true)).toBe(true);
      expect(mockLogger.warn).toHaveBeenCalledWith(
        expect.stringContaining(GUILD_MEMBERS_INTENT_HOWTO),
      );
    });

    it("stays quiet with the intent on or the Web UI off", () => {
      expect(warnIfLeaveEventsMissing(true)).toBe(false);
      mockEnv.guildMembersIntent = false;
      expect(warnIfLeaveEventsMissing(false)).toBe(false);
      expect(mockLogger.warn).not.toHaveBeenCalled();
    });
  });
});
