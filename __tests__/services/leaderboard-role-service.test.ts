import { describe, it, expect, beforeEach, jest } from "@jest/globals";
import type { Client } from "discord.js";

const mockRegisterReloadCallback = jest.fn();
const mockConfigGetBoolean = jest.fn();
const mockConfigGetString = jest.fn();

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
    },
  }),
);

jest.unstable_mockModule("../../src/utils/logger.js", () => ({
  default: {
    info: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
    debug: jest.fn(),
  },
}));

const { LeaderboardRoleService } =
  await import("../../src/services/leaderboard-role-service.js");

type ServiceInstance = InstanceType<typeof LeaderboardRoleService>;

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

      // One of them ran, the other was coalesced and returned null.
      const succeeded = [first, second].filter((r) => r !== null);
      const skipped = [first, second].filter((r) => r === null);
      expect(succeeded).toHaveLength(1);
      expect(skipped).toHaveLength(1);
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

      // Largest tier (5) drives how many top users to fetch
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
      // getTopUsers should be called with the widest tier (5)
      expect(mockGetTopUsers).toHaveBeenCalledWith(5, "alltime");
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
});
