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

jest.unstable_mockModule("../../src/utils/logger.js", () => ({
  default: {
    info: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
    debug: jest.fn(),
  },
}));

const { LeaderboardRoleService } = await import(
  "../../src/services/leaderboard-role-service.js"
);

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
  role: { id: string; name: string; members: Map<string, { id: string }> };
}

function makeGuildWithRole(opts: {
  roleId: string;
  roleName: string;
  currentHolders: string[];
}): MockGuild {
  const role = {
    id: opts.roleId,
    name: opts.roleName,
    members: new Map(
      opts.currentHolders.map((id) => [id, { id }]),
    ),
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
    // No-arg call: prime the cache; returns the full collection (unused here).
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
  });

  describe("singleton", () => {
    it("returns the same instance", () => {
      const a = LeaderboardRoleService.getInstance(makeClient());
      const b = LeaderboardRoleService.getInstance(makeClient());
      expect(a).toBe(b);
    });

    it("registers a config reload callback on construction", () => {
      LeaderboardRoleService.getInstance(makeClient());
      expect(mockRegisterReloadCallback).toHaveBeenCalledTimes(1);
    });
  });

  describe("runNow guards", () => {
    it("returns null when the feature is disabled", async () => {
      mockConfigGetBoolean.mockResolvedValue(false);
      const svc: ServiceInstance = LeaderboardRoleService.getInstance(
        makeClient(),
      );
      const result = await svc.runNow();
      expect(result).toBeNull();
      expect(mockGetTopUsers).not.toHaveBeenCalled();
    });

    it("returns null when no tiers are configured", async () => {
      const svc: ServiceInstance = LeaderboardRoleService.getInstance(
        makeClient(),
      );
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
      const svc: ServiceInstance = LeaderboardRoleService.getInstance(
        makeClient(),
      );
      const result = await svc.runNow();
      expect(result).toBeNull();
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
        currentHolders: [],
      });
      mockClientGuildsFetch.mockResolvedValue(guild);

      const svc: ServiceInstance = LeaderboardRoleService.getInstance(
        makeClient(),
      );
      const result = await svc.runNow();

      expect(result).not.toBeNull();
      // Only "1:111" and "5:222" parse successfully → 2 tiers reconciled
      expect(result!.tiers.map((t) => t.topN).sort()).toEqual([1, 5]);
      // getTopUsers should be called with the widest tier (5)
      expect(mockGetTopUsers).toHaveBeenCalledWith(5, "alltime");
    });
  });

  describe("role reconciliation", () => {
    it("adds the role to qualifying users who don't have it", async () => {
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
      const guild = makeGuildWithRole({
        roleId: "99999003",
        roleName: "Top 3",
        currentHolders: [], // nobody has it yet
      });
      mockClientGuildsFetch.mockResolvedValue(guild);

      const svc: ServiceInstance = LeaderboardRoleService.getInstance(
        makeClient(),
      );
      const result = await svc.runNow();

      expect(result).not.toBeNull();
      expect(result!.period).toBe("week");
      expect(result!.tiers).toHaveLength(1);
      expect(result!.tiers[0].added.sort()).toEqual(["u1", "u2", "u3"]);
      expect(result!.tiers[0].removed).toEqual([]);
      expect(mockRolesAdd).toHaveBeenCalledTimes(3);
      expect(mockRolesRemove).not.toHaveBeenCalled();
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
      const guild = makeGuildWithRole({
        roleId: "99999002",
        roleName: "Top 2",
        // u1 is still top, u2 is new top, u-old should lose the role
        currentHolders: ["u1", "u-old"],
      });
      mockClientGuildsFetch.mockResolvedValue(guild);

      const svc: ServiceInstance = LeaderboardRoleService.getInstance(
        makeClient(),
      );
      const result = await svc.runNow();

      expect(result).not.toBeNull();
      expect(result!.tiers[0].added).toEqual(["u2"]);
      expect(result!.tiers[0].removed).toEqual(["u-old"]);
      expect(mockRolesAdd).toHaveBeenCalledTimes(1);
      expect(mockRolesRemove).toHaveBeenCalledTimes(1);
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

      const svc: ServiceInstance = LeaderboardRoleService.getInstance(
        makeClient(),
      );
      const result = await svc.runNow();

      expect(result).not.toBeNull();
      expect(result!.tiers[0].skippedReason).toBe("role-not-found");
      expect(mockRolesAdd).not.toHaveBeenCalled();
    });
  });
});
