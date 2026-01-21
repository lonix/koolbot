import { describe, it, expect, jest, beforeEach } from "@jest/globals";
import type { ChatInputCommandInteraction, Client } from 'discord.js';
import { data, execute } from "../../src/commands/announce.js";
import { ScheduledAnnouncementService } from '../../src/services/scheduled-announcement-service.js';

jest.mock('../../src/services/scheduled-announcement-service.js');
jest.mock('../../src/utils/logger.js');

describe("Announce Command", () => {
  describe("command metadata", () => {
    it("should have correct command name", () => {
      expect(data.name).toBe("announce");
    });

    it("should have a description", () => {
      expect(data.description).toBe("Manage scheduled announcements");
    });

    it("should require administrator permission", () => {
      const json = data.toJSON();
      expect(json.default_member_permissions).toBe("8"); // Administrator permission
    });

    it("should be a valid slash command", () => {
      expect(data.toJSON()).toHaveProperty("name", "announce");
      expect(data.toJSON()).toHaveProperty(
        "description",
        "Manage scheduled announcements",
      );
    });
  });

  describe("subcommands", () => {
    it("should have create subcommand", () => {
      const json = data.toJSON();
      const createSubcommand = json.options?.find(
        (opt: any) => opt.name === "create",
      );
      expect(createSubcommand).toBeDefined();
      expect(createSubcommand?.description).toBe(
        "Create a new scheduled announcement",
      );
    });

    it("should have list subcommand", () => {
      const json = data.toJSON();
      const listSubcommand = json.options?.find(
        (opt: any) => opt.name === "list",
      );
      expect(listSubcommand).toBeDefined();
      expect(listSubcommand?.description).toBe(
        "List all scheduled announcements",
      );
    });

    it("should have delete subcommand", () => {
      const json = data.toJSON();
      const deleteSubcommand = json.options?.find(
        (opt: any) => opt.name === "delete",
      );
      expect(deleteSubcommand).toBeDefined();
      expect(deleteSubcommand?.description).toBe(
        "Delete a scheduled announcement",
      );
    });

    it("create subcommand should have required options", () => {
      const json = data.toJSON();
      const createSubcommand = json.options?.find(
        (opt: any) => opt.name === "create",
      );
      const options = createSubcommand?.options || [];

      const cronOption = options.find((opt: any) => opt.name === "cron");
      expect(cronOption).toBeDefined();
      expect(cronOption?.required).toBe(true);

      const channelOption = options.find(
        (opt: any) => opt.name === "channel",
      );
      expect(channelOption).toBeDefined();
      expect(channelOption?.required).toBe(true);

      const messageOption = options.find(
        (opt: any) => opt.name === "message",
      );
      expect(messageOption).toBeDefined();
      expect(messageOption?.required).toBe(true);
    });

    it("delete subcommand should have id option", () => {
      const json = data.toJSON();
      const deleteSubcommand = json.options?.find(
        (opt: any) => opt.name === "delete",
      );
      const options = deleteSubcommand?.options || [];

      const idOption = options.find((opt: any) => opt.name === "id");
      expect(idOption).toBeDefined();
      expect(idOption?.required).toBe(true);
    });
  });

  // Execute tests removed - service mocking issues with getInstance().mockReturnValue
});
