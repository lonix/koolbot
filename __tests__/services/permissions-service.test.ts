import { describe, it, expect, jest, beforeEach } from "@jest/globals";
import {
  PermissionsService,
  PermissionCheckError,
} from "../../src/services/permissions-service.js";
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

      (CommandPermission.findOneAndUpdate as jest.Mock) = mockFindOneAndUpdate;

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
      (CommandPermission.findOneAndUpdate as jest.Mock) = mockFindOneAndUpdate;

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
      (CommandPermission.findOneAndUpdate as jest.Mock) = mockFindOneAndUpdate;

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
      (CommandPermission.findOneAndUpdate as jest.Mock) = mockFindOneAndUpdate;

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

  describe("clearRoleFromAllCommands", () => {
    it("should remove a role from all commands", async () => {
      const mockPermissions = [
        {
          guildId: "guild123",
          commandName: "quote",
          roleIds: ["role1", "role2"],
        },
        {
          guildId: "guild123",
          commandName: "vcstats",
          roleIds: ["role1", "role3"],
        },
        {
          guildId: "guild123",
          commandName: "ping",
          roleIds: ["role3"],
        },
      ];

      const mockFind = jest.fn().mockResolvedValue(mockPermissions);
      const mockDeleteOne = jest.fn().mockResolvedValue({ deletedCount: 1 });
      const mockFindOneAndUpdate = jest.fn().mockResolvedValue({});

      (CommandPermission.find as jest.Mock) = mockFind;
      (CommandPermission.deleteOne as jest.Mock) = mockDeleteOne;
      (CommandPermission.findOneAndUpdate as jest.Mock) = mockFindOneAndUpdate;

      const clearedCount = await service.clearRoleFromAllCommands(
        "guild123",
        "role1",
      );

      expect(clearedCount).toBe(2); // quote and vcstats
      expect(mockFind).toHaveBeenCalledWith({ guildId: "guild123" });
    });

    it("should delete command permission when removing last role", async () => {
      const mockPermissions = [
        {
          guildId: "guild123",
          commandName: "quote",
          roleIds: ["role1"],
        },
      ];

      const mockFind = jest.fn().mockResolvedValue(mockPermissions);
      const mockDeleteOne = jest.fn().mockResolvedValue({ deletedCount: 1 });

      (CommandPermission.find as jest.Mock) = mockFind;
      (CommandPermission.deleteOne as jest.Mock) = mockDeleteOne;

      const clearedCount = await service.clearRoleFromAllCommands(
        "guild123",
        "role1",
      );

      expect(clearedCount).toBe(1);
      expect(mockDeleteOne).toHaveBeenCalledWith({
        guildId: "guild123",
        commandName: "quote",
      });
    });
  });

  describe("clearRolesFromAllCommands", () => {
    it("should remove multiple roles from all commands", async () => {
      const mockPermissions = [
        {
          guildId: "guild123",
          commandName: "quote",
          roleIds: ["role1", "role2", "role3"],
        },
        {
          guildId: "guild123",
          commandName: "vcstats",
          roleIds: ["role1", "role4"],
        },
      ];

      const mockFind = jest.fn().mockResolvedValue(mockPermissions);
      const mockFindOneAndUpdate = jest.fn().mockResolvedValue({});

      (CommandPermission.find as jest.Mock) = mockFind;
      (CommandPermission.findOneAndUpdate as jest.Mock) = mockFindOneAndUpdate;

      const clearedCount = await service.clearRolesFromAllCommands("guild123", [
        "role1",
        "role2",
      ]);

      expect(clearedCount).toBe(2); // quote and vcstats affected
      expect(mockFind).toHaveBeenCalledWith({ guildId: "guild123" });
    });

    it("should delete permission entry when all roles removed", async () => {
      const mockPermissions = [
        {
          guildId: "guild123",
          commandName: "quote",
          roleIds: ["role1", "role2"],
        },
      ];

      const mockFind = jest.fn().mockResolvedValue(mockPermissions);
      const mockDeleteOne = jest.fn().mockResolvedValue({ deletedCount: 1 });

      (CommandPermission.find as jest.Mock) = mockFind;
      (CommandPermission.deleteOne as jest.Mock) = mockDeleteOne;

      const clearedCount = await service.clearRolesFromAllCommands("guild123", [
        "role1",
        "role2",
      ]);

      expect(clearedCount).toBe(1);
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

    // #781 — transient internal failures must be distinguishable from a
    // genuine denial when the caller opts in via onUnavailable: "throw".
    describe("internal failure handling (#781)", () => {
      function makeServiceWithFailingFetch(
        fetchError: unknown,
      ): PermissionsService {
        const mockGuild = {
          members: {
            fetch: jest.fn().mockRejectedValue(fetchError as never),
          },
        };
        mockClient.guilds.fetch = jest.fn().mockResolvedValue(mockGuild);

        const mockConfigService = {
          getString: jest.fn().mockResolvedValue("guild123" as never),
        };

        (PermissionsService as unknown as { instance: unknown }).instance =
          undefined;
        const serviceWithMocks = PermissionsService.getInstance(
          mockClient as never,
        );
        (serviceWithMocks as never)["configService"] = mockConfigService;
        return serviceWithMocks;
      }

      it("returns false on a transient error by default (legacy behavior)", async () => {
        const serviceWithMocks = makeServiceWithFailingFetch(
          new Error("Discord API timeout"),
        );

        const result = await serviceWithMocks.checkCommandPermission(
          "user123",
          "guild123",
          "quote",
        );

        expect(result).toBe(false);
      });

      it("throws PermissionCheckError on a transient error when onUnavailable is 'throw'", async () => {
        const underlying = new Error("Discord API timeout");
        const serviceWithMocks = makeServiceWithFailingFetch(underlying);

        await expect(
          serviceWithMocks.checkCommandPermission(
            "user123",
            "guild123",
            "quote",
            { onUnavailable: "throw" },
          ),
        ).rejects.toThrow(PermissionCheckError);

        try {
          await serviceWithMocks.checkCommandPermission(
            "user123",
            "guild123",
            "quote",
            { onUnavailable: "throw" },
          );
          throw new Error("expected checkCommandPermission to throw");
        } catch (err) {
          expect(err).toBeInstanceOf(PermissionCheckError);
          expect((err as PermissionCheckError).cause).toBe(underlying);
        }
      });

      function makeServiceWithFailingCacheLoad(
        isAdmin: boolean,
      ): PermissionsService {
        const mockGuild = {
          members: {
            fetch: jest.fn().mockResolvedValue({
              id: "user123",
              permissions: {
                has: jest.fn().mockReturnValue(isAdmin),
              },
              roles: {
                cache: new Map(),
              },
            } as never),
          },
        };
        mockClient.guilds.fetch = jest.fn().mockResolvedValue(mockGuild);

        const mockConfigService = {
          getString: jest.fn().mockResolvedValue("guild123" as never),
        };

        // The cache load itself fails (e.g. Mongo outage) — initializeCache
        // swallows this and leaves the cache empty and uninitialized.
        (CommandPermission.find as jest.Mock) = jest
          .fn()
          .mockRejectedValue(new Error("Mongo connection lost") as never);

        (PermissionsService as unknown as { instance: unknown }).instance =
          undefined;
        const serviceWithMocks = PermissionsService.getInstance(
          mockClient as never,
        );
        (serviceWithMocks as never)["configService"] = mockConfigService;
        return serviceWithMocks;
      }

      it("throws in 'throw' mode when the permission cache failed to load (non-admin)", async () => {
        const serviceWithMocks = makeServiceWithFailingCacheLoad(false);

        // Without this guard the empty cache would fall through to the
        // default-open branch and authorize the user despite the outage.
        await expect(
          serviceWithMocks.checkCommandPermission(
            "user123",
            "guild123",
            "quote",
            { onUnavailable: "throw" },
          ),
        ).rejects.toThrow(PermissionCheckError);
      });

      it("still allows Administrators in 'throw' mode when the cache failed to load", async () => {
        const serviceWithMocks = makeServiceWithFailingCacheLoad(true);

        // The admin short-circuit rests on live Discord data, not the
        // cache, so a cache outage must not lock admins out.
        const result = await serviceWithMocks.checkCommandPermission(
          "user123",
          "guild123",
          "quote",
          { onUnavailable: "throw" },
        );

        expect(result).toBe(true);
      });

      // #836 — the guard must not depend on the caller opting in: a
      // failed cache load fails closed in the default "deny" mode too,
      // rather than falling through to the default-open branch.
      it("returns false on cache load failure in default mode (#836)", async () => {
        const serviceWithMocks = makeServiceWithFailingCacheLoad(false);

        const result = await serviceWithMocks.checkCommandPermission(
          "user123",
          "guild123",
          "quote",
        );

        expect(result).toBe(false);
      });

      it("still allows Administrators on cache load failure in default mode", async () => {
        const serviceWithMocks = makeServiceWithFailingCacheLoad(true);

        const result = await serviceWithMocks.checkCommandPermission(
          "user123",
          "guild123",
          "quote",
        );

        expect(result).toBe(true);
      });

      it("allows again once a later cache load succeeds", async () => {
        const serviceWithMocks = makeServiceWithFailingCacheLoad(false);

        await expect(
          serviceWithMocks.checkCommandPermission(
            "user123",
            "guild123",
            "quote",
          ),
        ).resolves.toBe(false);

        // The outage clears and the cache loads cleanly: no gating is
        // configured, so the default-open branch applies again.
        (CommandPermission.find as jest.Mock) = jest
          .fn()
          .mockResolvedValue([] as never);
        await serviceWithMocks.reloadCache();

        await expect(
          serviceWithMocks.checkCommandPermission(
            "user123",
            "guild123",
            "quote",
          ),
        ).resolves.toBe(true);
      });

      it("returns false (genuine denial) for Unknown Member even when onUnavailable is 'throw'", async () => {
        // Shaped like a DiscordAPIError: 10007 = Unknown Member.
        const unknownMember = Object.assign(new Error("Unknown Member"), {
          code: 10007,
        });
        const serviceWithMocks = makeServiceWithFailingFetch(unknownMember);

        const result = await serviceWithMocks.checkCommandPermission(
          "user123",
          "guild123",
          "quote",
          { onUnavailable: "throw" },
        );

        expect(result).toBe(false);
      });
    });
  });
});
