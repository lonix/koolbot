import { describe, it, expect, jest, beforeEach } from "@jest/globals";
import { PermissionsService } from "../../src/services/permissions-service.js";
import { CommandPermission } from "../../src/models/command-permissions.js";

// Mock dependencies
jest.mock("../../src/services/config-service.js");
jest.mock("../../src/models/command-permissions.js");
jest.mock("../../src/utils/logger.js");

describe("PermissionsService", () => {
  let mockClient: {
    guilds: { fetch: jest.Mock };
    commands: Map<string, unknown>;
  };
  let service: PermissionsService;

  beforeEach(() => {
    jest.clearAllMocks();

    // Mock Discord client
    mockClient = {
      guilds: {
        fetch: jest.fn(),
      },
      commands: new Map([
        ["ping", {}],
        ["help", {}],
        ["quote", {}],
        ["vcstats", {}],
        ["config", {}],
      ]),
    };

    // Reset singleton
    (PermissionsService as unknown as { instance: unknown }).instance =
      undefined;
    service = PermissionsService.getInstance(mockClient as never);
  });

  describe("initialization", () => {
    it("should create a singleton instance", () => {
      const instance1 = PermissionsService.getInstance(mockClient as never);
      const instance2 = PermissionsService.getInstance(mockClient as never);

      expect(instance1).toBeDefined();
      expect(instance1).toBe(instance2);
    });

    it("should have required methods", () => {
      expect(typeof service.checkCommandPermission).toBe("function");
      expect(typeof service.setCommandPermissions).toBe("function");
      expect(typeof service.addCommandPermissions).toBe("function");
      expect(typeof service.removeCommandPermissions).toBe("function");
      expect(typeof service.getCommandPermissions).toBe("function");
      expect(typeof service.clearCommandPermissions).toBe("function");
      expect(typeof service.listAllPermissions).toBe("function");
      expect(typeof service.getUserPermissions).toBe("function");
      expect(typeof service.getRolePermissions).toBe("function");
      expect(typeof service.initializeDefaultPermissions).toBe("function");
      expect(typeof service.reloadCache).toBe("function");
    });
  });

  describe("setCommandPermissions", () => {
    it("should set permissions with multiple roles", async () => {
      const mockFindOneAndUpdate = jest.fn().mockResolvedValue({
        guildId: "guild123",
        commandName: "quote",
        roleIds: ["role1", "role2", "role3"],
      });

      (CommandPermission.findOneAndUpdate as jest.Mock) =
        mockFindOneAndUpdate;

      await service.setCommandPermissions("guild123", "quote", [
        "role1",
        "role2",
        "role3",
      ]);

      expect(mockFindOneAndUpdate).toHaveBeenCalledWith(
        { guildId: "guild123", commandName: "quote" },
        { roleIds: ["role1", "role2", "role3"] },
        { upsert: true, new: true },
      );
    });
  });

  describe("addCommandPermissions", () => {
    it("should add roles to existing permissions", async () => {
      const mockFindOne = jest.fn().mockResolvedValue({
        guildId: "guild123",
        commandName: "quote",
        roleIds: ["role1"],
      });

      const mockFindOneAndUpdate = jest.fn().mockResolvedValue({
        guildId: "guild123",
        commandName: "quote",
        roleIds: ["role1", "role2"],
      });

      (CommandPermission.findOne as jest.Mock) = mockFindOne;
      (CommandPermission.findOneAndUpdate as jest.Mock) =
        mockFindOneAndUpdate;

      await service.addCommandPermissions("guild123", "quote", ["role2"]);

      expect(mockFindOne).toHaveBeenCalledWith({
        guildId: "guild123",
        commandName: "quote",
      });
    });

    it("should handle adding to non-existent permissions", async () => {
      const mockFindOne = jest.fn().mockResolvedValue(null);
      const mockFindOneAndUpdate = jest.fn().mockResolvedValue({
        guildId: "guild123",
        commandName: "newcmd",
        roleIds: ["role1"],
      });

      (CommandPermission.findOne as jest.Mock) = mockFindOne;
      (CommandPermission.findOneAndUpdate as jest.Mock) =
        mockFindOneAndUpdate;

      await service.addCommandPermissions("guild123", "newcmd", ["role1"]);

      expect(mockFindOne).toHaveBeenCalled();
    });
  });

  describe("removeCommandPermissions", () => {
    it("should remove specific roles from permissions", async () => {
      const mockFindOne = jest.fn().mockResolvedValue({
        guildId: "guild123",
        commandName: "quote",
        roleIds: ["role1", "role2", "role3"],
      });

      const mockFindOneAndUpdate = jest.fn().mockResolvedValue({
        guildId: "guild123",
        commandName: "quote",
        roleIds: ["role1", "role3"],
      });

      (CommandPermission.findOne as jest.Mock) = mockFindOne;
      (CommandPermission.findOneAndUpdate as jest.Mock) =
        mockFindOneAndUpdate;

      await service.removeCommandPermissions("guild123", "quote", ["role2"]);

      expect(mockFindOne).toHaveBeenCalled();
    });

    it("should delete permission entry when no roles remain", async () => {
      const mockFindOne = jest.fn().mockResolvedValue({
        guildId: "guild123",
        commandName: "quote",
        roleIds: ["role1"],
      });

      const mockDeleteOne = jest.fn().mockResolvedValue({ deletedCount: 1 });

      (CommandPermission.findOne as jest.Mock) = mockFindOne;
      (CommandPermission.deleteOne as jest.Mock) = mockDeleteOne;

      await service.removeCommandPermissions("guild123", "quote", ["role1"]);

      expect(mockDeleteOne).toHaveBeenCalledWith({
        guildId: "guild123",
        commandName: "quote",
      });
    });
  });

  describe("getCommandPermissions", () => {
    it("should return role IDs for a command", async () => {
      const mockFind = jest.fn().mockResolvedValue([
        {
          guildId: "guild123",
          commandName: "quote",
          roleIds: ["role1", "role2"],
        },
      ]);

      (CommandPermission.find as jest.Mock) = mockFind;

      const mockConfigService = {
        getString: jest.fn().mockResolvedValue("guild123"),
      };

      // Reinitialize with mocked config
      (PermissionsService as unknown as { instance: unknown }).instance =
        undefined;
      const serviceWithConfig = PermissionsService.getInstance(
        mockClient as never,
      );

      // Override config service
      (serviceWithConfig as never)["configService"] = mockConfigService;

      // Initialize cache
      await serviceWithConfig["initializeCache"]();

      const result = await serviceWithConfig.getCommandPermissions(
        "guild123",
        "quote",
      );

      expect(result).toEqual(["role1", "role2"]);
    });

    it("should return null when no permissions set", async () => {
      const mockFind = jest.fn().mockResolvedValue([]);

      (CommandPermission.find as jest.Mock) = mockFind;

      const mockConfigService = {
        getString: jest.fn().mockResolvedValue("guild123"),
      };

      (PermissionsService as unknown as { instance: unknown }).instance =
        undefined;
      const serviceWithConfig = PermissionsService.getInstance(
        mockClient as never,
      );
      (serviceWithConfig as never)["configService"] = mockConfigService;

      await serviceWithConfig["initializeCache"]();

      const result = await serviceWithConfig.getCommandPermissions(
        "guild123",
        "unknown",
      );

      expect(result).toBeNull();
    });
  });

  describe("clearCommandPermissions", () => {
    it("should delete permission entry", async () => {
      const mockDeleteOne = jest.fn().mockResolvedValue({ deletedCount: 1 });

      (CommandPermission.deleteOne as jest.Mock) = mockDeleteOne;

      await service.clearCommandPermissions("guild123", "quote");

      expect(mockDeleteOne).toHaveBeenCalledWith({
        guildId: "guild123",
        commandName: "quote",
      });
    });
  });

  describe("listAllPermissions", () => {
    it("should return all permissions for a guild", async () => {
      const mockPermissions = [
        {
          guildId: "guild123",
          commandName: "quote",
          roleIds: ["role1"],
        },
        {
          guildId: "guild123",
          commandName: "vcstats",
          roleIds: ["role2", "role3"],
        },
      ];

      const mockFind = jest.fn().mockResolvedValue(mockPermissions);

      (CommandPermission.find as jest.Mock) = mockFind;

      const result = await service.listAllPermissions("guild123");

      expect(mockFind).toHaveBeenCalledWith({ guildId: "guild123" });
      expect(result).toEqual(mockPermissions);
    });
  });

  describe("checkCommandPermission", () => {
    it("should allow admins to bypass permission checks", async () => {
      const mockGuild = {
        members: {
          fetch: jest.fn().mockResolvedValue({
            id: "user123",
            permissions: {
              has: jest.fn().mockReturnValue(true), // Admin
            },
            roles: {
              cache: new Map(),
            },
          }),
        },
      };

      mockClient.guilds.fetch = jest.fn().mockResolvedValue(mockGuild);

      const mockConfigService = {
        getString: jest.fn().mockResolvedValue("guild123"),
      };

      (PermissionsService as unknown as { instance: unknown }).instance =
        undefined;
      const serviceWithMocks = PermissionsService.getInstance(
        mockClient as never,
      );
      (serviceWithMocks as never)["configService"] = mockConfigService;

      const result = await serviceWithMocks.checkCommandPermission(
        "user123",
        "guild123",
        "quote",
      );

      expect(result).toBe(true);
    });

    it("should allow access when no permissions are set", async () => {
      const mockGuild = {
        members: {
          fetch: jest.fn().mockResolvedValue({
            id: "user123",
            permissions: {
              has: jest.fn().mockReturnValue(false), // Not admin
            },
            roles: {
              cache: new Map(),
            },
          }),
        },
      };

      mockClient.guilds.fetch = jest.fn().mockResolvedValue(mockGuild);

      const mockConfigService = {
        getString: jest.fn().mockResolvedValue("guild123"),
      };

      const mockFind = jest.fn().mockResolvedValue([]);
      (CommandPermission.find as jest.Mock) = mockFind;

      (PermissionsService as unknown as { instance: unknown }).instance =
        undefined;
      const serviceWithMocks = PermissionsService.getInstance(
        mockClient as never,
      );
      (serviceWithMocks as never)["configService"] = mockConfigService;

      await serviceWithMocks["initializeCache"]();

      const result = await serviceWithMocks.checkCommandPermission(
        "user123",
        "guild123",
        "quote",
      );

      expect(result).toBe(true);
    });
  });
});
