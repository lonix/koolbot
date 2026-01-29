import { Client } from "discord.js";
import {
  CommandPermission,
  ICommandPermission,
} from "../models/command-permissions.js";
import { ConfigService } from "./config-service.js";
import logger from "../utils/logger.js";

export class PermissionsService {
  private static instance: PermissionsService;
  private client: Client;
  private configService: ConfigService;
  private permissionsCache: Map<string, string[]> = new Map();
  private cacheInitialized = false;
  private cacheInitializing: Promise<void> | null = null;

  private constructor(client: Client) {
    this.client = client;
    this.configService = ConfigService.getInstance();
  }

  public static getInstance(client: Client): PermissionsService {
    if (!PermissionsService.instance) {
      PermissionsService.instance = new PermissionsService(client);
    }
    return PermissionsService.instance;
  }

  /**
   * Initialize the permissions cache from database
   */
  private async initializeCache(): Promise<void> {
    if (this.cacheInitialized) return;
    if (this.cacheInitializing) {
      return this.cacheInitializing;
    }

    this.cacheInitializing = (async () => {
      try {
        const guildId = await this.configService.getString("GUILD_ID");
        if (!guildId) {
          logger.warn(
            "GUILD_ID not set, skipping permissions cache initialization",
          );
          return;
        }

        const permissions = await CommandPermission.find({ guildId });
        this.permissionsCache.clear();

        for (const perm of permissions) {
          const cacheKey = `${perm.guildId}:${perm.commandName}`;
          this.permissionsCache.set(cacheKey, perm.roleIds);
        }

        this.cacheInitialized = true;
        logger.info(
          `Permissions cache initialized with ${permissions.length} entries`,
        );
      } catch (error) {
        logger.error("Error initializing permissions cache:", error);
      } finally {
        this.cacheInitializing = null;
      }
    })();

    return this.cacheInitializing;
  }

  /**
   * Reload the cache from database
   */
  public async reloadCache(): Promise<void> {
    this.cacheInitialized = false;
    await this.initializeCache();
  }

  /**
   * Check if a user has permission to execute a command
   * @param userId - Discord user ID
   * @param guildId - Discord guild ID
   * @param commandName - Name of the command
   * @returns True if user has permission, false otherwise
   */
  public async checkCommandPermission(
    userId: string,
    guildId: string,
    commandName: string,
  ): Promise<boolean> {
    try {
      // Ensure cache is initialized
      await this.initializeCache();

      // Get the guild
      const guild = await this.client.guilds.fetch(guildId);
      if (!guild) {
        logger.warn(`Guild ${guildId} not found`);
        return false;
      }

      // Get the member
      const member = await guild.members.fetch(userId);
      if (!member) {
        logger.warn(`Member ${userId} not found in guild ${guildId}`);
        return false;
      }

      // Admins bypass all permission checks
      if (member.permissions.has("Administrator")) {
        return true;
      }

      // Check if there are any permissions set for this command
      const cacheKey = `${guildId}:${commandName}`;
      const allowedRoleIds = this.permissionsCache.get(cacheKey);

      // If no permissions set, allow access (default open)
      if (!allowedRoleIds || allowedRoleIds.length === 0) {
        return true;
      }

      // Check if user has ANY of the allowed roles (OR logic)
      const userRoleIds = member.roles.cache.map((role) => role.id);
      const hasPermission = allowedRoleIds.some((roleId) =>
        userRoleIds.includes(roleId),
      );

      return hasPermission;
    } catch (error) {
      logger.error("Error checking command permission:", error);
      return false;
    }
  }

  /**
   * Set permissions for a command (replaces existing)
   * @param guildId - Discord guild ID
   * @param commandName - Name of the command
   * @param roleIds - Array of role IDs
   */
  public async setCommandPermissions(
    guildId: string,
    commandName: string,
    roleIds: string[],
  ): Promise<void> {
    try {
      await CommandPermission.findOneAndUpdate(
        { guildId, commandName },
        { roleIds },
        { upsert: true, new: true },
      );

      // Update cache
      const cacheKey = `${guildId}:${commandName}`;
      this.permissionsCache.set(cacheKey, roleIds);

      logger.info(
        `Set permissions for command ${commandName}: ${roleIds.length} role(s)`,
      );
    } catch (error) {
      logger.error("Error setting command permissions:", error);
      throw error;
    }
  }

  /**
   * Add roles to existing command permissions
   * @param guildId - Discord guild ID
   * @param commandName - Name of the command
   * @param roleIds - Array of role IDs to add
   */
  public async addCommandPermissions(
    guildId: string,
    commandName: string,
    roleIds: string[],
  ): Promise<void> {
    try {
      const existing = await CommandPermission.findOne({
        guildId,
        commandName,
      });
      const currentRoleIds = existing?.roleIds || [];
      const newRoleIds = [...new Set([...currentRoleIds, ...roleIds])];

      await this.setCommandPermissions(guildId, commandName, newRoleIds);
      logger.info(`Added ${roleIds.length} role(s) to command ${commandName}`);
    } catch (error) {
      logger.error("Error adding command permissions:", error);
      throw error;
    }
  }

  /**
   * Remove specific roles from command permissions
   * @param guildId - Discord guild ID
   * @param commandName - Name of the command
   * @param roleIds - Array of role IDs to remove
   */
  public async removeCommandPermissions(
    guildId: string,
    commandName: string,
    roleIds: string[],
  ): Promise<void> {
    try {
      const existing = await CommandPermission.findOne({
        guildId,
        commandName,
      });
      if (!existing) {
        logger.warn(`No permissions found for command ${commandName}`);
        return;
      }

      const newRoleIds = existing.roleIds.filter(
        (roleId) => !roleIds.includes(roleId),
      );

      if (newRoleIds.length === 0) {
        // If no roles left, delete the permission entry
        await CommandPermission.deleteOne({ guildId, commandName });
        this.permissionsCache.delete(`${guildId}:${commandName}`);
        logger.info(
          `Removed all permissions for command ${commandName} (entry deleted)`,
        );
      } else {
        await this.setCommandPermissions(guildId, commandName, newRoleIds);
        logger.info(
          `Removed ${roleIds.length} role(s) from command ${commandName}`,
        );
      }
    } catch (error) {
      logger.error("Error removing command permissions:", error);
      throw error;
    }
  }

  /**
   * Get permissions for a specific command
   * @param guildId - Discord guild ID
   * @param commandName - Name of the command
   * @returns Array of role IDs or null if no permissions set
   */
  public async getCommandPermissions(
    guildId: string,
    commandName: string,
  ): Promise<string[] | null> {
    try {
      await this.initializeCache();
      const cacheKey = `${guildId}:${commandName}`;
      return this.permissionsCache.get(cacheKey) || null;
    } catch (error) {
      logger.error("Error getting command permissions:", error);
      return null;
    }
  }

  /**
   * Clear all permissions for a command
   * @param guildId - Discord guild ID
   * @param commandName - Name of the command
   */
  public async clearCommandPermissions(
    guildId: string,
    commandName: string,
  ): Promise<void> {
    try {
      await CommandPermission.deleteOne({ guildId, commandName });
      this.permissionsCache.delete(`${guildId}:${commandName}`);
      logger.info(`Cleared all permissions for command ${commandName}`);
    } catch (error) {
      logger.error("Error clearing command permissions:", error);
      throw error;
    }
  }

  /**
   * Clear a specific role from all commands
   * @param guildId - Discord guild ID
   * @param roleId - Role ID to remove from all commands
   * @returns Number of commands affected
   */
  public async clearRoleFromAllCommands(
    guildId: string,
    roleId: string,
  ): Promise<number> {
    try {
      const permissions = await CommandPermission.find({ guildId });
      let clearedCount = 0;

      for (const perm of permissions) {
        if (perm.roleIds.includes(roleId)) {
          const newRoleIds = perm.roleIds.filter((id) => id !== roleId);

          if (newRoleIds.length === 0) {
            // If no roles left, delete the permission entry
            await CommandPermission.deleteOne({
              guildId,
              commandName: perm.commandName,
            });
            this.permissionsCache.delete(`${guildId}:${perm.commandName}`);
          } else {
            // Update with remaining roles
            await this.setCommandPermissions(
              guildId,
              perm.commandName,
              newRoleIds,
            );
          }
          clearedCount++;
        }
      }

      logger.info(
        `Cleared role ${roleId} from ${clearedCount} command(s) in guild ${guildId}`,
      );
      return clearedCount;
    } catch (error) {
      logger.error("Error clearing role from all commands:", error);
      throw error;
    }
  }

  /**
   * Clear multiple roles from all commands
   * @param guildId - Discord guild ID
   * @param roleIds - Array of role IDs to remove from all commands
   * @returns Number of commands affected
   */
  public async clearRolesFromAllCommands(
    guildId: string,
    roleIds: string[],
  ): Promise<number> {
    try {
      const permissions = await CommandPermission.find({ guildId });
      let clearedCount = 0;

      for (const perm of permissions) {
        const hasAnyRole = perm.roleIds.some((id) => roleIds.includes(id));

        if (hasAnyRole) {
          const newRoleIds = perm.roleIds.filter((id) => !roleIds.includes(id));

          if (newRoleIds.length === 0) {
            // If no roles left, delete the permission entry
            await CommandPermission.deleteOne({
              guildId,
              commandName: perm.commandName,
            });
            this.permissionsCache.delete(`${guildId}:${perm.commandName}`);
          } else {
            // Update with remaining roles
            await this.setCommandPermissions(
              guildId,
              perm.commandName,
              newRoleIds,
            );
          }
          clearedCount++;
        }
      }

      logger.info(
        `Cleared ${roleIds.length} role(s) from ${clearedCount} command(s) in guild ${guildId}`,
      );
      return clearedCount;
    } catch (error) {
      logger.error("Error clearing roles from all commands:", error);
      throw error;
    }
  }

  /**
   * List all permissions for a guild
   * @param guildId - Discord guild ID
   * @returns Array of permission entries
   */
  public async listAllPermissions(
    guildId: string,
  ): Promise<ICommandPermission[]> {
    try {
      return await CommandPermission.find({ guildId });
    } catch (error) {
      logger.error("Error listing permissions:", error);
      return [];
    }
  }

  /**
   * Get all commands a user can access
   * @param userId - Discord user ID
   * @param guildId - Discord guild ID
   * @returns Array of command names
   */
  public async getUserPermissions(
    userId: string,
    guildId: string,
  ): Promise<string[]> {
    try {
      const guild = await this.client.guilds.fetch(guildId);
      if (!guild) return [];

      const member = await guild.members.fetch(userId);
      if (!member) return [];

      // Admins have access to all commands
      if (member.permissions.has("Administrator")) {
        // Get all registered commands
        const allCommands = this.client.commands.map((_, name) => name);
        return allCommands;
      }

      const userRoleIds = member.roles.cache.map((role) => role.id);
      const allPermissions = await this.listAllPermissions(guildId);
      const accessibleCommands: string[] = [];

      // Get all registered commands
      const registeredCommands = Array.from(this.client.commands.keys());

      for (const commandName of registeredCommands) {
        const permission = allPermissions.find(
          (p) => p.commandName === commandName,
        );

        // If no permission set or user has one of the required roles
        if (
          !permission ||
          permission.roleIds.length === 0 ||
          permission.roleIds.some((roleId) => userRoleIds.includes(roleId))
        ) {
          accessibleCommands.push(commandName);
        }
      }

      return accessibleCommands;
    } catch (error) {
      logger.error("Error getting user permissions:", error);
      return [];
    }
  }

  /**
   * Get all commands a role can access
   * @param roleId - Discord role ID
   * @param guildId - Discord guild ID
   * @returns Array of command names
   */
  public async getRolePermissions(
    roleId: string,
    guildId: string,
  ): Promise<string[]> {
    try {
      const allPermissions = await this.listAllPermissions(guildId);
      const accessibleCommands: string[] = [];

      // Get all registered commands
      const registeredCommands = Array.from(this.client.commands.keys());

      for (const commandName of registeredCommands) {
        const permission = allPermissions.find(
          (p) => p.commandName === commandName,
        );

        // If no permission set or role is in the allowed list
        if (
          !permission ||
          permission.roleIds.length === 0 ||
          permission.roleIds.includes(roleId)
        ) {
          accessibleCommands.push(commandName);
        }
      }

      return accessibleCommands;
    } catch (error) {
      logger.error("Error getting role permissions:", error);
      return [];
    }
  }

  /**
   * Initialize default permissions for admin-only commands
   * This should be called during bot startup
   * @param guildId - Discord guild ID
   */
  public async initializeDefaultPermissions(guildId: string): Promise<void> {
    try {
      logger.info(
        "Initializing default permissions for admin-only commands...",
      );

      const guild = await this.client.guilds.fetch(guildId);
      if (!guild) {
        logger.warn(
          "Guild not found, skipping default permission initialization",
        );
        return;
      }

      // Get the Administrator role (usually @everyone with admin perms or a dedicated admin role)
      // For now, we'll just ensure admin-only commands are documented
      // Users can manually configure these using /permissions commands

      // Admin-only commands that should be restricted by default
      const adminCommands = ["dbtrunk", "vc", "config"];

      for (const commandName of adminCommands) {
        // Only set default if no permissions exist yet (idempotent)
        const existing = await CommandPermission.findOne({
          guildId,
          commandName,
        });

        if (!existing) {
          // Don't set any roles - let admins configure it
          // The middleware will allow admins through anyway
          logger.debug(
            `Admin command ${commandName} has no permissions (admins can access by default)`,
          );
        } else {
          logger.debug(
            `Admin command ${commandName} already has permissions configured`,
          );
        }
      }

      logger.info("Default permissions initialization complete");
    } catch (error) {
      logger.error("Error initializing default permissions:", error);
    }
  }
}
