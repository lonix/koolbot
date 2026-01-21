import { describe, it, expect, jest, beforeEach } from "@jest/globals";
import type { ChatInputCommandInteraction, Client } from 'discord.js';
import { data, execute } from "../../src/commands/reactrole.js";
import { PermissionFlagsBits } from "discord.js";
import { ReactionRoleService } from '../../src/services/reaction-role-service.js';

jest.mock('../../src/services/reaction-role-service.js');
jest.mock('../../src/utils/logger.js');

describe("Reactrole Command", () => {
  describe("command metadata", () => {
    it("should have correct command name", () => {
      expect(data.name).toBe("reactrole");
    });

    it("should have a description", () => {
      expect(data.description).toBeTruthy();
      expect(data.description).toBe("Manage reaction-based roles");
    });

    it("should be a valid slash command", () => {
      const json = data.toJSON();
      expect(json).toHaveProperty("name", "reactrole");
      expect(json).toHaveProperty("description");
    });

    it("should require administrator permissions", () => {
      const json = data.toJSON();
      expect(json.default_member_permissions).toBe(
        String(PermissionFlagsBits.Administrator),
      );
    });

    it("should have all required subcommands", () => {
      const json = data.toJSON();
      expect(json.options).toBeDefined();
      expect(json.options?.length).toBe(6);

      const subcommands = json.options?.map((opt) => opt.name);
      expect(subcommands).toContain("create");
      expect(subcommands).toContain("archive");
      expect(subcommands).toContain("unarchive");
      expect(subcommands).toContain("delete");
      expect(subcommands).toContain("list");
      expect(subcommands).toContain("status");
    });
  });

  describe("create subcommand", () => {
    it("should have correct metadata", () => {
      const json = data.toJSON();
      const createCmd = json.options?.find((opt) => opt.name === "create");

      expect(createCmd).toBeDefined();
      expect(createCmd?.description).toContain("Create");
      expect(createCmd?.type).toBe(1); // SUB_COMMAND type
    });

    it("should have required name parameter", () => {
      const json = data.toJSON();
      const createCmd = json.options?.find((opt) => opt.name === "create");
      const nameOption = createCmd?.options?.find(
        (opt: { name: string }) => opt.name === "name",
      );

      expect(nameOption).toBeDefined();
      expect(nameOption?.required).toBe(true);
      expect(nameOption?.type).toBe(3); // STRING type
    });

    it("should have required emoji parameter", () => {
      const json = data.toJSON();
      const createCmd = json.options?.find((opt) => opt.name === "create");
      const emojiOption = createCmd?.options?.find(
        (opt: { name: string }) => opt.name === "emoji",
      );

      expect(emojiOption).toBeDefined();
      expect(emojiOption?.required).toBe(true);
      expect(emojiOption?.type).toBe(3); // STRING type
    });
  });

  describe("archive subcommand", () => {
    it("should have correct metadata", () => {
      const json = data.toJSON();
      const archiveCmd = json.options?.find((opt) => opt.name === "archive");

      expect(archiveCmd).toBeDefined();
      expect(archiveCmd?.description).toContain("Archive");
      expect(archiveCmd?.type).toBe(1); // SUB_COMMAND type
    });

    it("should have required name parameter", () => {
      const json = data.toJSON();
      const archiveCmd = json.options?.find((opt) => opt.name === "archive");
      const nameOption = archiveCmd?.options?.find(
        (opt: { name: string }) => opt.name === "name",
      );

      expect(nameOption).toBeDefined();
      expect(nameOption?.required).toBe(true);
      expect(nameOption?.type).toBe(3); // STRING type
    });
  });

  describe("unarchive subcommand", () => {
    it("should have correct metadata", () => {
      const json = data.toJSON();
      const unarchiveCmd = json.options?.find(
        (opt) => opt.name === "unarchive",
      );

      expect(unarchiveCmd).toBeDefined();
      expect(unarchiveCmd?.description).toContain("Unarchive");
      expect(unarchiveCmd?.type).toBe(1); // SUB_COMMAND type
    });

    it("should have required name parameter", () => {
      const json = data.toJSON();
      const unarchiveCmd = json.options?.find(
        (opt) => opt.name === "unarchive",
      );
      const nameOption = unarchiveCmd?.options?.find(
        (opt: { name: string }) => opt.name === "name",
      );

      expect(nameOption).toBeDefined();
      expect(nameOption?.required).toBe(true);
      expect(nameOption?.type).toBe(3); // STRING type
    });
  });

  describe("delete subcommand", () => {
    it("should have correct metadata", () => {
      const json = data.toJSON();
      const deleteCmd = json.options?.find((opt) => opt.name === "delete");

      expect(deleteCmd).toBeDefined();
      expect(deleteCmd?.description).toContain("delete");
      expect(deleteCmd?.type).toBe(1); // SUB_COMMAND type
    });

    it("should have required name parameter", () => {
      const json = data.toJSON();
      const deleteCmd = json.options?.find((opt) => opt.name === "delete");
      const nameOption = deleteCmd?.options?.find(
        (opt: { name: string }) => opt.name === "name",
      );

      expect(nameOption).toBeDefined();
      expect(nameOption?.required).toBe(true);
      expect(nameOption?.type).toBe(3); // STRING type
    });
  });

  describe("list subcommand", () => {
    it("should have correct metadata", () => {
      const json = data.toJSON();
      const listCmd = json.options?.find((opt) => opt.name === "list");

      expect(listCmd).toBeDefined();
      expect(listCmd?.description).toContain("List");
      expect(listCmd?.type).toBe(1); // SUB_COMMAND type
    });

    it("should not have any parameters", () => {
      const json = data.toJSON();
      const listCmd = json.options?.find((opt) => opt.name === "list");

      expect(listCmd?.options).toBeDefined();
      expect(Array.isArray(listCmd?.options)).toBe(true);
      expect(listCmd?.options?.length).toBe(0);
    });
  });

  describe("status subcommand", () => {
    it("should have correct metadata", () => {
      const json = data.toJSON();
      const statusCmd = json.options?.find((opt) => opt.name === "status");

      expect(statusCmd).toBeDefined();
      expect(statusCmd?.description).toContain("status");
      expect(statusCmd?.type).toBe(1); // SUB_COMMAND type
    });

    it("should have required name parameter", () => {
      const json = data.toJSON();
      const statusCmd = json.options?.find((opt) => opt.name === "status");
      const nameOption = statusCmd?.options?.find(
        (opt: { name: string }) => opt.name === "name",
      );

      expect(nameOption).toBeDefined();
      expect(nameOption?.required).toBe(true);
      expect(nameOption?.type).toBe(3); // STRING type
    });
  });

  describe('execute', () => {
    let mockInteraction: Partial<ChatInputCommandInteraction>;
    let mockReactionRoleService: any;

    beforeEach(() => {
      jest.clearAllMocks();

      mockInteraction = {
        guildId: 'guild123',
        client: {} as Client,
        options: {
          getSubcommand: jest.fn().mockReturnValue('list'),
        } as any,
        reply: jest.fn().mockResolvedValue(undefined),
      };

      mockReactionRoleService = {
        listReactionRoles: jest.fn().mockResolvedValue([]),
      };

      (ReactionRoleService.getInstance as jest.Mock).mockReturnValue(mockReactionRoleService);
    });

    it('should handle list subcommand', async () => {
      await execute(mockInteraction as ChatInputCommandInteraction);

      expect(mockReactionRoleService.listReactionRoles).toHaveBeenCalled();
    });

    it('should handle missing guild ID', async () => {
      mockInteraction.guildId = null;

      await execute(mockInteraction as ChatInputCommandInteraction);

      expect(mockInteraction.reply).toHaveBeenCalledWith(
        expect.objectContaining({
          ephemeral: true,
        })
      );
    });

    it('should handle errors', async () => {
      mockInteraction.options!.getSubcommand = jest.fn().mockImplementation(() => {
        throw new Error('Command error');
      });

      await execute(mockInteraction as ChatInputCommandInteraction);

      expect(mockInteraction.reply).toHaveBeenCalled();
    });
  });
});
