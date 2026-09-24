import { describe, it, expect, beforeEach, jest } from "@jest/globals";
import { DiscordAPIError, type Client } from "discord.js";

const mockRegisterReloadCallback = jest.fn();
const mockConfigGetBoolean = jest.fn();
const mockConfigGetString = jest.fn();
const mockLoggerWarn = jest.fn();

const mockGetTopUsers = jest.fn();
const mockTrackerGetInstance = jest.fn(() => ({
  getTopUsers: mockGetTopUsers,
}));

const mockRolesAdd = jest.fn();
const mockRolesRemove = jest.fn();
const mockGuildMembersFetch = jest.fn();
const mockGuildRolesFetch = jest.fn();
const mockGuildChannelsFetch = jest.fn();
const mockClientGuildsFetch = jest.fn();

const mockAssignmentFindOne = jest.fn();
const mockAssignmentFindOneAndUpdate = jest.fn();
const mockAssignmentFind = jest.fn();
const mockAssignmentUpdateOne = jest.fn();
const mockAssignmentDeleteOne = jest.fn();

jest.unstable_mockModule("../../src/services/config-service.js", () => ({
  ConfigService: {
    getInstance: jest.fn(() => ({
      registerReloadCallback: mockRegisterReloadCallback,
      getBoolean: mockConfigGetBoolean,
      getString: mockConfigGetString,
    })),
  },
}));

jest.unstable_mockModule("../../src/services/voice-channel-tracker.js", () => ({
  VoiceChannelTracker: {
    getInstance: mockTrackerGetInstance,
  },
}));

jest.unstable_mockModule(
  "../../src/models/leaderboard-role-assignment.js",
  () => ({
    LeaderboardRoleAssignment: {
      findOne: mockAssignmentFindOne,
      findOneAndUpdate: mockAssignmentFindOneAndUpdate,
      find: mockAssignmentFind,
      updateOne: mockAssignmentUpdateOne,
      deleteOne: mockAssignmentDeleteOne,
    },
  }),
);

jest.unstable_mockModule("../../src/utils/logger.js", () => ({
  default: {
    info: jest.fn(),
    warn: mockLoggerWarn,
    error: jest.fn(),
    debug: jest.fn(),
  },
}));

const { LeaderboardRoleService } =
  await import("../../src/services/leaderboard-role-service.js");

type ServiceInstance = InstanceType<typeof LeaderboardRoleService>;

/** Discord's Unknown Role rejection, as `guild.roles.fetch` throws it. */
function unknownRoleError(): DiscordAPIError {
  return new DiscordAPIError(
    { code: 10011, message: "Unknown Role" },
    10011,
    404,
    "GET",
    "",
    {},
  );
}

function resetSingleton(): void {
  (LeaderboardRoleService as unknown as { instance: unknown }).instance =
    undefined;
}

function makeClient(): Client {
  return {
    isReady: () => true,
    guilds: { fetch: mockClientGuildsFetch },
  } as unknown as Client;
}

interface MockGuild {
  id: string;
  members: { fetch: typeof mockGuildMembersFetch };
  roles: { fetch: typeof mockGuildRolesFetch };
  channels: { fetch: typeof mockGuildChannelsFetch };
  role: { id: string; name: string };
}

function makeGuildWithRole(opts: {
  roleId: string;
  roleName: string;
}): MockGuild {
  const role = {
    id: opts.roleId,
    name: opts.roleName,
  };

  mockGuildRolesFetch.mockResolvedValue(role);
  mockGuildMembersFetch.mockImplementation(async (...args: unknown[]) => {
    const arg = args[0];
    if (typeof arg === "string") {
      return {
        id: arg,
        user: { tag: `user-${arg}` },
        roles: { add: mockRolesAdd, remove: mockRolesRemove },
      };
    }
    return new Map();
  });

  return {
    id: "guild-1",
    members: { fetch: mockGuildMembersFetch },
    roles: { fetch: mockGuildRolesFetch },
    channels: { fetch: mockGuildChannelsFetch },
    role,
  };
}

describe("LeaderboardRoleService", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    resetSingleton();
    mockConfigGetBoolean.mockResolvedValue(true);
    mockConfigGetString.mockImplementation(async (key: unknown) => {
      const k = key as string;
      switch (k) {
        case "GUILD_ID":
          return "guild-1";
        case "leaderboard_roles.period":
          return "alltime";
        case "leaderboard_roles.update_cron":
          return "0 0 * * 1";
        case "leaderboard_roles.tiers":
          return "";
        case "leaderboard_roles.announcement_channel_id":
          return "";
        default:
          return "";
      }
    });
    mockAssignmentFindOne.mockResolvedValue(null);
    mockAssignmentFindOneAndUpdate.mockResolvedValue({});
    mockAssignmentFind.mockResolvedValue([]);
    mockAssignmentUpdateOne.mockResolvedValue({ modifiedCount: 1 });
    mockAssignmentDeleteOne.mockResolvedValue({ deletedCount: 1 });
  });

  describe("singleton", () => {
    it("returns the same instance", () => {
      const client = makeClient();
      const a = LeaderboardRoleService.getInstance(client);
      const b = LeaderboardRoleService.getInstance(client);
      expect(a).toBe(b);
    });

    it("throws when called with a different client", () => {
      LeaderboardRoleService.getInstance(makeClient());
      expect(() => LeaderboardRoleService.getInstance(makeClient())).toThrow(
        /already initialised with a different client/,
      );
    });

    it("registers a config reload callback on construction", () => {
      LeaderboardRoleService.getInstance(makeClient());
      expect(mockRegisterReloadCallback).toHaveBeenCalledTimes(1);
    });
  });

  describe("runNow guards", () => {
    it("returns null when the feature is disabled", async () => {
      mockConfigGetBoolean.mockResolvedValue(false);
      const svc: ServiceInstance =
        LeaderboardRoleService.getInstance(makeClient());
      const result = await svc.runNow();
      expect(result).toBeNull();
      expect(mockGetTopUsers).not.toHaveBeenCalled();
    });

    it("short-circuits and warns when voice tracking is disabled", async () => {
      // Feature on, but its hard dependency (voice tracking) is off.
      mockConfigGetBoolean.mockImplementation(async (key: unknown) =>
        key === "voicetracking.enabled" ? false : true,
      );
      mockConfigGetString.mockImplementation(async (key: unknown) => {
        const k = key as string;
        if (k === "GUILD_ID") return "guild-1";
        if (k === "leaderboard_roles.tiers") return "1:99999001";
        if (k === "leaderboard_roles.period") return "alltime";
        return "";
      });
      const svc: ServiceInstance =
        LeaderboardRoleService.getInstance(makeClient());
      const result = await svc.runNow();
      expect(result).toBeNull();
      expect(mockGetTopUsers).not.toHaveBeenCalled();
      expect(mockLoggerWarn).toHaveBeenCalledWith(
        expect.stringContaining("voice tracking is disabled"),
      );
    });

    it("returns null when no tiers are configured", async () => {
      const svc: ServiceInstance =
        LeaderboardRoleService.getInstance(makeClient());
      const result = await svc.runNow();
      expect(result).toBeNull();
      expect(mockGetTopUsers).not.toHaveBeenCalled();
    });

    it("returns null when GUILD_ID is missing", async () => {
      mockConfigGetString.mockImplementation(async (key: unknown) => {
        if (key === "leaderboard_roles.tiers") return "1:role-a";
        if (key === "leaderboard_roles.period") return "alltime";
        return "";
      });
      const svc: ServiceInstance =
        LeaderboardRoleService.getInstance(makeClient());
      const result = await svc.runNow();
      expect(result).toBeNull();
    });

    it("coalesces concurrent invocations", async () => {
      mockConfigGetString.mockImplementation(async (key: unknown) => {
        const k = key as string;
        if (k === "GUILD_ID") return "guild-1";
        if (k === "leaderboard_roles.tiers") return "1:99999001";
        if (k === "leaderboard_roles.period") return "alltime";
        return "";
      });
      mockGetTopUsers.mockResolvedValue([
        { userId: "u1", username: "u1", totalTime: 100 },
      ]);
      mockClientGuildsFetch.mockResolvedValue(
        makeGuildWithRole({ roleId: "99999001", roleName: "Top 1" }),
      );

      const svc: ServiceInstance =
        LeaderboardRoleService.getInstance(makeClient());
      const [first, second] = await Promise.all([svc.runNow(), svc.runNow()]);

      // The second caller joins the run already in flight and gets its
      // result, so the reconciliation itself only happens once.
      expect(first).not.toBeNull();
      expect(second).toBe(first);
      expect(mockGetTopUsers).toHaveBeenCalledTimes(1);
    });
  });

  describe("tier parsing", () => {
    it("skips malformed entries and runs the surviving ones", async () => {
      mockConfigGetString.mockImplementation(async (key: unknown) => {
        const k = key as string;
        if (k === "GUILD_ID") return "guild-1";
        if (k === "leaderboard_roles.tiers")
          return "1:111,foo,3:not-a-snowflake,5:222,,:333,7:,abc:444";
        if (k === "leaderboard_roles.period") return "alltime";
        return "";
      });

      mockGetTopUsers.mockResolvedValue([
        { userId: "u1", username: "u1", totalTime: 100 },
        { userId: "u2", username: "u2", totalTime: 90 },
        { userId: "u3", username: "u3", totalTime: 80 },
        { userId: "u4", username: "u4", totalTime: 70 },
        { userId: "u5", username: "u5", totalTime: 60 },
      ]);

      const guild = makeGuildWithRole({
        roleId: "111",
        roleName: "Top 1",
      });
      mockClientGuildsFetch.mockResolvedValue(guild);

      const svc: ServiceInstance =
        LeaderboardRoleService.getInstance(makeClient());
      const result = await svc.runNow();

      expect(result).not.toBeNull();
      // Only "1:111" and "5:222" parse successfully → 2 tiers reconciled
      expect(result!.tiers.map((t) => t.topN).sort()).toEqual([1, 5]);
      // Full ranking is fetched with the "all ranked users" sentinel (0);
      // per-tier cutoffs happen in reconcileTier.
      expect(mockGetTopUsers).toHaveBeenCalledWith(0, "alltime");
    });
  });

  describe("ranking fetch", () => {
    it("fetches all ranked users so tiers wider than leaderboard_max_results are not truncated", async () => {
      mockConfigGetString.mockImplementation(async (key: unknown) => {
        const k = key as string;
        if (k === "GUILD_ID") return "guild-1";
        // Tier wider than the default leaderboard_max_results cap (50).
        if (k === "leaderboard_roles.tiers") return "100:99999100";
        if (k === "leaderboard_roles.period") return "week";
        return "";
      });
      // With the sentinel, the tracker returns every ranked user (60 > 50).
      const allRanked = Array.from({ length: 60 }, (_, i) => ({
        userId: `u${i + 1}`,
        username: `u${i + 1}`,
        totalTime: 1000 - i,
      }));
      mockGetTopUsers.mockResolvedValue(allRanked);
      mockClientGuildsFetch.mockResolvedValue(
        makeGuildWithRole({ roleId: "99999100", roleName: "Top 100" }),
      );

      const svc: ServiceInstance =
        LeaderboardRoleService.getInstance(makeClient());
      const result = await svc.runNow();

      expect(result).not.toBeNull();
      // Never passes a positive limit that would be clamped server-side.
      expect(mockGetTopUsers).toHaveBeenCalledWith(0, "week");
      // All 60 ranked users fall within the top-100 tier and get the role.
      expect(result!.tiers[0].added).toHaveLength(60);
      expect(result!.tiers[0].added).toContain("u60");
    });
  });

  describe("role reconciliation", () => {
    it("adds the role to qualifying users with no previous assignment", async () => {
      mockConfigGetString.mockImplementation(async (key: unknown) => {
        const k = key as string;
        if (k === "GUILD_ID") return "guild-1";
        if (k === "leaderboard_roles.tiers") return "3:99999003";
        if (k === "leaderboard_roles.period") return "week";
        return "";
      });
      mockGetTopUsers.mockResolvedValue([
        { userId: "u1", username: "u1", totalTime: 100 },
        { userId: "u2", username: "u2", totalTime: 90 },
        { userId: "u3", username: "u3", totalTime: 80 },
      ]);
      mockAssignmentFindOne.mockResolvedValue(null); // first-ever run
      mockClientGuildsFetch.mockResolvedValue(
        makeGuildWithRole({ roleId: "99999003", roleName: "Top 3" }),
      );

      const svc: ServiceInstance =
        LeaderboardRoleService.getInstance(makeClient());
      const result = await svc.runNow();

      expect(result).not.toBeNull();
      expect(result!.period).toBe("week");
      expect(result!.tiers).toHaveLength(1);
      expect(result!.tiers[0].added.sort()).toEqual(["u1", "u2", "u3"]);
      expect(result!.tiers[0].removed).toEqual([]);
      expect(mockRolesAdd).toHaveBeenCalledTimes(3);
      expect(mockRolesRemove).not.toHaveBeenCalled();
      // Persists the new holder set
      expect(mockAssignmentFindOneAndUpdate).toHaveBeenCalledWith(
        { guildId: "guild-1", roleId: "99999003" },
        expect.objectContaining({
          guildId: "guild-1",
          roleId: "99999003",
          topN: 3,
          userIds: expect.arrayContaining(["u1", "u2", "u3"]),
        }),
        { upsert: true },
      );
    });

    it("removes the role from users who no longer qualify", async () => {
      mockConfigGetString.mockImplementation(async (key: unknown) => {
        const k = key as string;
        if (k === "GUILD_ID") return "guild-1";
        if (k === "leaderboard_roles.tiers") return "2:99999002";
        if (k === "leaderboard_roles.period") return "alltime";
        return "";
      });
      mockGetTopUsers.mockResolvedValue([
        { userId: "u1", username: "u1", totalTime: 100 },
        { userId: "u2", username: "u2", totalTime: 90 },
      ]);
      // Previous run: u1 + u-old had the role. u-old should now lose it.
      mockAssignmentFindOne.mockResolvedValue({
        guildId: "guild-1",
        roleId: "99999002",
        topN: 2,
        userIds: ["u1", "u-old"],
      });
      mockClientGuildsFetch.mockResolvedValue(
        makeGuildWithRole({ roleId: "99999002", roleName: "Top 2" }),
      );

      const svc: ServiceInstance =
        LeaderboardRoleService.getInstance(makeClient());
      const result = await svc.runNow();

      expect(result).not.toBeNull();
      expect(result!.tiers[0].added).toEqual(["u2"]); // u1 already had it
      expect(result!.tiers[0].removed).toEqual(["u-old"]);
      expect(mockRolesAdd).toHaveBeenCalledTimes(1);
      expect(mockRolesRemove).toHaveBeenCalledTimes(1);
      // Final holder set should be u1 + u2
      expect(mockAssignmentFindOneAndUpdate).toHaveBeenCalledWith(
        { guildId: "guild-1", roleId: "99999002" },
        expect.objectContaining({
          userIds: expect.arrayContaining(["u1", "u2"]),
        }),
        { upsert: true },
      );
    });

    it("counts a member who left the guild as removed without erroring", async () => {
      mockConfigGetString.mockImplementation(async (key: unknown) => {
        const k = key as string;
        if (k === "GUILD_ID") return "guild-1";
        if (k === "leaderboard_roles.tiers") return "2:99999002";
        if (k === "leaderboard_roles.period") return "alltime";
        return "";
      });
      mockGetTopUsers.mockResolvedValue([
        { userId: "u1", username: "u1", totalTime: 100 },
        { userId: "u2", username: "u2", totalTime: 90 },
      ]);
      mockAssignmentFindOne.mockResolvedValue({
        guildId: "guild-1",
        roleId: "99999002",
        topN: 2,
        userIds: ["u-left"],
      });
      mockClientGuildsFetch.mockResolvedValue(
        makeGuildWithRole({ roleId: "99999002", roleName: "Top 2" }),
      );
      // Override member fetch: "u-left" rejects (user is gone)
      mockGuildMembersFetch.mockImplementation(async (...args: unknown[]) => {
        const arg = args[0];
        if (arg === "u-left") throw new Error("Unknown member");
        if (typeof arg === "string") {
          return {
            id: arg,
            user: { tag: `user-${arg}` },
            roles: { add: mockRolesAdd, remove: mockRolesRemove },
          };
        }
        return new Map();
      });

      const svc: ServiceInstance =
        LeaderboardRoleService.getInstance(makeClient());
      const result = await svc.runNow();

      expect(result).not.toBeNull();
      expect(result!.tiers[0].removed).toEqual(["u-left"]);
      expect(mockRolesRemove).not.toHaveBeenCalled();
    });

    it("marks a tier as skipped when the role is not found", async () => {
      mockConfigGetString.mockImplementation(async (key: unknown) => {
        const k = key as string;
        if (k === "GUILD_ID") return "guild-1";
        if (k === "leaderboard_roles.tiers") return "1:99999998";
        return k === "leaderboard_roles.period" ? "alltime" : "";
      });
      mockGetTopUsers.mockResolvedValue([
        { userId: "u1", username: "u1", totalTime: 100 },
      ]);
      mockClientGuildsFetch.mockResolvedValue({
        id: "guild-1",
        members: { fetch: mockGuildMembersFetch },
        roles: { fetch: jest.fn().mockResolvedValue(null) },
        channels: { fetch: mockGuildChannelsFetch },
      });

      const svc: ServiceInstance =
        LeaderboardRoleService.getInstance(makeClient());
      const result = await svc.runNow();

      expect(result).not.toBeNull();
      expect(result!.tiers[0].skippedReason).toBe("role-not-found");
      expect(mockRolesAdd).not.toHaveBeenCalled();
      expect(mockAssignmentFindOneAndUpdate).not.toHaveBeenCalled();
    });
  });

  it("skips a tier whose role fetch rejects with Unknown Role (#985)", async () => {
    // Discord usually reports a deleted role as a 10011 rejection, not null;
    // that must skip the tier, not fail the whole run.
    mockConfigGetString.mockImplementation(async (key: unknown) => {
      const k = key as string;
      if (k === "GUILD_ID") return "guild-1";
      if (k === "leaderboard_roles.tiers") return "1:99999998";
      return k === "leaderboard_roles.period" ? "alltime" : "";
    });
    mockGetTopUsers.mockResolvedValue([
      { userId: "u1", username: "u1", totalTime: 100 },
    ]);
    mockClientGuildsFetch.mockResolvedValue({
      id: "guild-1",
      members: { fetch: mockGuildMembersFetch },
      roles: { fetch: jest.fn().mockRejectedValue(unknownRoleError()) },
      channels: { fetch: mockGuildChannelsFetch },
    });

    const svc: ServiceInstance =
      LeaderboardRoleService.getInstance(makeClient());
    const result = await svc.runNow();

    expect(result).not.toBeNull();
    expect(result!.tiers[0].skippedReason).toBe("role-not-found");
  });

  // #985. A tier that is removed, or given a different role, leaves a roster
  // row no tier reconciles any more; without this its holders would keep the
  // old role forever.
  describe("removed tiers (#985)", () => {
    function tiersConfig(tiers: string): void {
      mockConfigGetString.mockImplementation(async (key: unknown) => {
        const k = key as string;
        if (k === "GUILD_ID") return "guild-1";
        if (k === "leaderboard_roles.tiers") return tiers;
        if (k === "leaderboard_roles.period") return "alltime";
        return "";
      });
    }

    beforeEach(() => {
      mockRolesRemove.mockResolvedValue(undefined);
      mockGetTopUsers.mockResolvedValue([]);
    });

    it("takes the old role back and deletes the roster row", async () => {
      tiersConfig("1:99999001");
      mockAssignmentFind.mockResolvedValue([
        { guildId: "guild-1", roleId: "99999001", userIds: [] },
        { guildId: "guild-1", roleId: "99999777", userIds: ["u1", "u2"] },
      ]);
      mockClientGuildsFetch.mockResolvedValue(
        makeGuildWithRole({ roleId: "99999777", roleName: "Old tier" }),
      );

      const svc: ServiceInstance =
        LeaderboardRoleService.getInstance(makeClient());
      const result = await svc.runNow();

      expect(result!.retired).toEqual([
        {
          roleId: "99999777",
          roleName: "Old tier",
          removed: ["u1", "u2"],
          retained: [],
        },
      ]);
      expect(mockRolesRemove).toHaveBeenCalledTimes(2);
      expect(mockAssignmentDeleteOne).toHaveBeenCalledWith({
        guildId: "guild-1",
        roleId: "99999777",
      });
      // The configured tier's row is left to reconcileTier.
      expect(mockAssignmentDeleteOne).toHaveBeenCalledTimes(1);
    });

    it("still takes the roles back when every tier was removed", async () => {
      tiersConfig("");
      mockAssignmentFind.mockResolvedValue([
        { guildId: "guild-1", roleId: "99999777", userIds: ["u1"] },
      ]);
      mockClientGuildsFetch.mockResolvedValue(
        makeGuildWithRole({ roleId: "99999777", roleName: "Old tier" }),
      );

      const svc: ServiceInstance =
        LeaderboardRoleService.getInstance(makeClient());
      const result = await svc.runNow();

      expect(result).toMatchObject({
        tiers: [],
        retired: [{ removed: ["u1"] }],
      });
      expect(mockRolesRemove).toHaveBeenCalledTimes(1);
      expect(mockGetTopUsers).not.toHaveBeenCalled();
    });

    it("keeps a member whose revoke failed on the roster to retry", async () => {
      tiersConfig("");
      mockAssignmentFind.mockResolvedValue([
        { guildId: "guild-1", roleId: "99999777", userIds: ["u1", "u2"] },
      ]);
      mockClientGuildsFetch.mockResolvedValue(
        makeGuildWithRole({ roleId: "99999777", roleName: "Old tier" }),
      );
      mockRolesRemove
        .mockRejectedValueOnce(new Error("missing permissions"))
        .mockResolvedValueOnce(undefined);

      const svc: ServiceInstance =
        LeaderboardRoleService.getInstance(makeClient());
      const result = await svc.runNow();

      expect(result!.retired[0]).toMatchObject({
        removed: ["u2"],
        retained: ["u1"],
      });
      expect(mockAssignmentDeleteOne).not.toHaveBeenCalled();
      expect(mockAssignmentUpdateOne).toHaveBeenCalledWith(
        { guildId: "guild-1", roleId: "99999777" },
        { $pull: { userIds: { $in: ["u2"] } } },
      );
    });

    it("drops the row when the old role no longer exists", async () => {
      tiersConfig("");
      mockAssignmentFind.mockResolvedValue([
        { guildId: "guild-1", roleId: "99999777", userIds: ["u1"] },
      ]);
      mockClientGuildsFetch.mockResolvedValue({
        id: "guild-1",
        members: { fetch: mockGuildMembersFetch },
        roles: { fetch: jest.fn().mockResolvedValue(null) },
        channels: { fetch: mockGuildChannelsFetch },
      });

      const svc: ServiceInstance =
        LeaderboardRoleService.getInstance(makeClient());
      const result = await svc.runNow();

      expect(result!.retired[0]).toMatchObject({
        roleName: "99999777",
        removed: ["u1"],
      });
      expect(mockRolesRemove).not.toHaveBeenCalled();
      expect(mockAssignmentDeleteOne).toHaveBeenCalledTimes(1);
    });

    it("drops the row when the old role fetch rejects with Unknown Role", async () => {
      tiersConfig("");
      mockAssignmentFind.mockResolvedValue([
        { guildId: "guild-1", roleId: "99999777", userIds: ["u1"] },
      ]);
      mockClientGuildsFetch.mockResolvedValue({
        id: "guild-1",
        members: { fetch: mockGuildMembersFetch },
        roles: { fetch: jest.fn().mockRejectedValue(unknownRoleError()) },
        channels: { fetch: mockGuildChannelsFetch },
      });

      const svc: ServiceInstance =
        LeaderboardRoleService.getInstance(makeClient());
      const result = await svc.runNow();

      expect(result!.retired[0]).toMatchObject({ removed: ["u1"] });
      expect(mockAssignmentDeleteOne).toHaveBeenCalledTimes(1);
    });

    it("announces roles taken back from removed tiers", async () => {
      const mockSend = jest.fn(async () => undefined);
      mockConfigGetString.mockImplementation(async (key: unknown) => {
        const k = key as string;
        if (k === "GUILD_ID") return "guild-1";
        if (k === "leaderboard_roles.announcement_channel_id") return "chan-1";
        return k === "leaderboard_roles.period" ? "alltime" : "";
      });
      mockAssignmentFind.mockResolvedValue([
        { guildId: "guild-1", roleId: "99999777", userIds: ["u1"] },
      ]);
      mockClientGuildsFetch.mockResolvedValue(
        makeGuildWithRole({ roleId: "99999777", roleName: "Old tier" }),
      );
      mockGuildChannelsFetch.mockResolvedValue({
        isTextBased: () => true,
        send: mockSend,
      });

      const svc: ServiceInstance =
        LeaderboardRoleService.getInstance(makeClient());
      await svc.runNow();

      // Every tier was removed, and the announcement still goes out.
      expect(mockSend).toHaveBeenCalledTimes(1);
      const [payload] = mockSend.mock.calls[0] as unknown as [
        { embeds: Array<{ toJSON(): { fields?: unknown[] } }> },
      ];
      expect(payload.embeds[0].toJSON().fields).toEqual([
        {
          name: "Removed tier — Old tier",
          value: "Removed: <@u1>",
          inline: false,
        },
      ]);
    });

    it("leaves the row alone when the role lookup errors", async () => {
      // A transient failure must not read as "role deleted".
      tiersConfig("");
      mockAssignmentFind.mockResolvedValue([
        { guildId: "guild-1", roleId: "99999777", userIds: ["u1"] },
      ]);
      mockClientGuildsFetch.mockResolvedValue({
        id: "guild-1",
        members: { fetch: mockGuildMembersFetch },
        roles: { fetch: jest.fn().mockRejectedValue(new Error("503")) },
        channels: { fetch: mockGuildChannelsFetch },
      });

      const svc: ServiceInstance =
        LeaderboardRoleService.getInstance(makeClient());
      const result = await svc.runNow();

      expect(result!.retired).toEqual([]);
      expect(mockAssignmentDeleteOne).not.toHaveBeenCalled();
      expect(mockAssignmentUpdateOne).not.toHaveBeenCalled();
    });
  });

  // #914. `reconcileTier` only ever walks the persisted `userIds[]` when
  // deciding what to revoke (the bot has no GuildMembers intent), so pulling
  // an id before the Discord role is actually gone strands the role on the
  // member forever. These tests pin the ordering.
  describe("holdOutForPurge (#917)", () => {
    function configureTopTwo(): void {
      mockConfigGetString.mockImplementation(async (key: unknown) => {
        const k = key as string;
        if (k === "GUILD_ID") return "guild-1";
        if (k === "leaderboard_roles.tiers") return "2:99999002";
        if (k === "leaderboard_roles.period") return "alltime";
        return "";
      });
      mockGetTopUsers.mockResolvedValue([
        { userId: "u1", username: "u1", totalTime: 100 },
        { userId: "u2", username: "u2", totalTime: 90 },
        { userId: "u3", username: "u3", totalTime: 80 },
      ]);
      mockClientGuildsFetch.mockResolvedValue(
        makeGuildWithRole({ roleId: "99999002", roleName: "Top 2" }),
      );
    }

    it("never grants the role to a held member, and lets the next one move up", async () => {
      configureTopTwo();
      const svc: ServiceInstance =
        LeaderboardRoleService.getInstance(makeClient());

      const release = await svc.holdOutForPurge("u1");
      const result = await svc.runNow();

      expect(result!.tiers[0].added.sort()).toEqual(["u2", "u3"]);
      expect(mockAssignmentFindOneAndUpdate).toHaveBeenCalledWith(
        { guildId: "guild-1", roleId: "99999002" },
        expect.objectContaining({ userIds: ["u2", "u3"] }),
        { upsert: true },
      );

      // Released: u1 qualifies again (their data would be gone in a real
      // purge, so in practice they simply no longer rank).
      release();
      jest.clearAllMocks();
      configureTopTwo();
      mockAssignmentFindOne.mockResolvedValue(null);
      const after = await svc.runNow();
      expect(after!.tiers[0].added.sort()).toEqual(["u1", "u2"]);
    });

    it("revokes the role from a held member already on the roster", async () => {
      configureTopTwo();
      mockAssignmentFindOne.mockResolvedValue({
        guildId: "guild-1",
        roleId: "99999002",
        topN: 2,
        userIds: ["u1", "u2"],
      });
      const svc: ServiceInstance =
        LeaderboardRoleService.getInstance(makeClient());

      await svc.holdOutForPurge("u1");
      const result = await svc.runNow();

      expect(result!.tiers[0].removed).toEqual(["u1"]);
      expect(mockRolesRemove).toHaveBeenCalledTimes(1);
    });

    it("waits out a reconcile already in flight before returning", async () => {
      configureTopTwo();
      let finishRanking: () => void = () => undefined;
      mockGetTopUsers.mockImplementation(
        () =>
          new Promise((resolve) => {
            finishRanking = () =>
              resolve([
                { userId: "u1", username: "u1", totalTime: 100 },
                { userId: "u2", username: "u2", totalTime: 90 },
              ]);
          }) as never,
      );
      const svc: ServiceInstance =
        LeaderboardRoleService.getInstance(makeClient());

      const run = svc.runNow();
      await new Promise((r) => setTimeout(r, 0));
      let held = false;
      const hold = svc.holdOutForPurge("u1").then((release) => {
        held = true;
        return release;
      });
      await new Promise((r) => setTimeout(r, 0));
      // The run is still ranking, so the hold has not returned yet — the
      // purge's revoke would otherwise race the run's roster write.
      expect(held).toBe(false);

      finishRanking();
      await run;
      await hold;
      expect(held).toBe(true);
    });

    it("keeps the hold until every overlapping holder has released", async () => {
      configureTopTwo();
      const svc: ServiceInstance =
        LeaderboardRoleService.getInstance(makeClient());

      const releaseA = await svc.holdOutForPurge("u1");
      const releaseB = await svc.holdOutForPurge("u1");
      releaseA();
      releaseA(); // idempotent
      const result = await svc.runNow();
      expect(result!.tiers[0].added).not.toContain("u1");

      releaseB();
      jest.clearAllMocks();
      configureTopTwo();
      mockAssignmentFindOne.mockResolvedValue(null);
      const after = await svc.runNow();
      expect(after!.tiers[0].added).toContain("u1");
    });
  });

  describe("revokeForUser", () => {
    beforeEach(() => {
      // `jest.clearAllMocks()` clears calls but keeps implementations, so a
      // rejection set by the revoke-failure test would leak into the next.
      mockRolesRemove.mockResolvedValue(undefined);
    });

    function rosterRows(...roleIds: string[]): void {
      mockAssignmentFind.mockResolvedValue(
        roleIds.map((roleId) => ({
          guildId: "guild-1",
          roleId,
          topN: 1,
          userIds: ["u1"],
        })),
      );
    }

    it("revokes on Discord first, then pulls the id server-side", async () => {
      rosterRows("99999001");
      mockClientGuildsFetch.mockResolvedValue(
        makeGuildWithRole({ roleId: "99999001", roleName: "Top 1" }),
      );

      const svc: ServiceInstance =
        LeaderboardRoleService.getInstance(makeClient());
      const result = await svc.revokeForUser("guild-1", "u1");

      expect(result).toEqual({ revoked: ["99999001"], retained: [] });
      expect(mockRolesRemove).toHaveBeenCalledTimes(1);
      // `$pull`, not a read-modify-write: a concurrent reconcile writes the
      // whole `userIds` array, and would clobber a rewritten one.
      expect(mockAssignmentUpdateOne).toHaveBeenCalledWith(
        { guildId: "guild-1", roleId: "99999001" },
        { $pull: { userIds: "u1" } },
      );
      // Ordering: the role removal has to have landed before the pull.
      expect(mockRolesRemove.mock.invocationCallOrder[0]).toBeLessThan(
        mockAssignmentUpdateOne.mock.invocationCallOrder[0],
      );
    });

    it("keeps going when one role throws, retaining just that one", async () => {
      // A throw used to reject the whole method, so the purge report said
      // nothing had happened — while the member really had lost the roles
      // handled before it (#916).
      rosterRows("99999001", "99999002");
      mockClientGuildsFetch.mockResolvedValue(
        makeGuildWithRole({ roleId: "99999001", roleName: "Top 1" }),
      );
      mockAssignmentUpdateOne.mockImplementation(
        async (filter: { roleId: string }) => {
          if (filter.roleId === "99999002") throw new Error("write conflict");
          return { modifiedCount: 1 };
        },
      );

      const svc: ServiceInstance =
        LeaderboardRoleService.getInstance(makeClient());
      const result = await svc.revokeForUser("guild-1", "u1");

      expect(result.revoked).toContain("99999001");
      // Retained is the safe classification: the id stays on the roster, so
      // the next reconcile retries the whole role.
      expect(result.retained).toEqual(["99999002"]);
    });

    it("leaves the id in userIds[] when the Discord revoke fails", async () => {
      rosterRows("99999001");
      mockClientGuildsFetch.mockResolvedValue(
        makeGuildWithRole({ roleId: "99999001", roleName: "Top 1" }),
      );
      mockRolesRemove.mockRejectedValue(new Error("Missing Permissions"));

      const svc: ServiceInstance =
        LeaderboardRoleService.getInstance(makeClient());
      const result = await svc.revokeForUser("guild-1", "u1");

      expect(result).toEqual({ revoked: [], retained: ["99999001"] });
      // The id stays on the roster so the next reconcile retries the revoke
      // instead of the member keeping the reward role permanently.
      expect(mockAssignmentUpdateOne).not.toHaveBeenCalled();
      expect(mockLoggerWarn).toHaveBeenCalled();
    });

    /** A real `DiscordAPIError` with the given code, as discord.js throws. */
    function apiError(code: number): DiscordAPIError {
      return new DiscordAPIError(
        { code, message: "nope" },
        code,
        400,
        "GET",
        "",
        {},
      );
    }

    it("keeps the roster entry when the member lookup merely failed", async () => {
      // A rate limit is not proof they left. Reading it as one would drop the
      // roster id — the only handle on the grant — while the role sat on a
      // member who is still here (#916).
      rosterRows("99999001");
      mockClientGuildsFetch.mockResolvedValue(
        makeGuildWithRole({ roleId: "99999001", roleName: "Top 1" }),
      );
      mockGuildMembersFetch.mockRejectedValue(new Error("rate limited"));

      const svc: ServiceInstance =
        LeaderboardRoleService.getInstance(makeClient());
      const result = await svc.revokeForUser("guild-1", "u1");

      expect(result.retained).toEqual(["99999001"]);
      expect(result.revoked).toEqual([]);
      expect(mockAssignmentUpdateOne).not.toHaveBeenCalled();
    });

    it("pulls the id when the member has left the guild", async () => {
      rosterRows("99999001");
      mockClientGuildsFetch.mockResolvedValue(
        makeGuildWithRole({ roleId: "99999001", roleName: "Top 1" }),
      );
      // 10007 Unknown Member — definitive, unlike a transient failure.
      mockGuildMembersFetch.mockRejectedValue(apiError(10007));

      const svc: ServiceInstance =
        LeaderboardRoleService.getInstance(makeClient());
      const result = await svc.revokeForUser("guild-1", "u1");

      // The role went with them, so there is nothing for a retry to fix.
      expect(result.revoked).toEqual(["99999001"]);
      expect(mockRolesRemove).not.toHaveBeenCalled();
      expect(mockAssignmentUpdateOne).toHaveBeenCalledTimes(1);
    });

    it("pulls the id when the role itself no longer exists", async () => {
      rosterRows("99999001");
      mockClientGuildsFetch.mockResolvedValue({
        id: "guild-1",
        members: { fetch: mockGuildMembersFetch },
        roles: { fetch: jest.fn().mockResolvedValue(null) },
        channels: { fetch: mockGuildChannelsFetch },
      });

      const svc: ServiceInstance =
        LeaderboardRoleService.getInstance(makeClient());
      const result = await svc.revokeForUser("guild-1", "u1");

      expect(result.revoked).toEqual(["99999001"]);
      expect(mockAssignmentUpdateOne).toHaveBeenCalledTimes(1);
    });

    it("retains every row when the guild is unreachable", async () => {
      rosterRows("99999001", "99999002");
      mockClientGuildsFetch.mockRejectedValue(new Error("Unknown guild"));

      const svc: ServiceInstance =
        LeaderboardRoleService.getInstance(makeClient());
      const result = await svc.revokeForUser("guild-1", "u1");

      expect(result).toEqual({
        revoked: [],
        retained: ["99999001", "99999002"],
      });
      expect(mockAssignmentUpdateOne).not.toHaveBeenCalled();
    });

    it("handles every tier the member holds", async () => {
      rosterRows("99999001", "99999002");
      mockClientGuildsFetch.mockResolvedValue(
        makeGuildWithRole({ roleId: "99999001", roleName: "Top 1" }),
      );

      const svc: ServiceInstance =
        LeaderboardRoleService.getInstance(makeClient());
      const result = await svc.revokeForUser("guild-1", "u1");

      expect(result.revoked).toEqual(["99999001", "99999002"]);
      expect(mockRolesRemove).toHaveBeenCalledTimes(2);
      expect(mockAssignmentUpdateOne).toHaveBeenCalledTimes(2);
    });

    it("does nothing and touches no Discord API when the member holds no roles", async () => {
      mockAssignmentFind.mockResolvedValue([]);

      const svc: ServiceInstance =
        LeaderboardRoleService.getInstance(makeClient());
      const result = await svc.revokeForUser("guild-1", "u1");

      expect(result).toEqual({ revoked: [], retained: [] });
      expect(mockClientGuildsFetch).not.toHaveBeenCalled();
      expect(mockAssignmentUpdateOne).not.toHaveBeenCalled();
    });
  });
});
