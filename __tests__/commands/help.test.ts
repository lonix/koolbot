import { describe, it, expect, jest, beforeEach } from "@jest/globals";
import {
  data,
  execute,
  buildHelpEntries,
  getCommandHelpEntries,
  usageFromCommand,
} from "../../src/commands/help.js";
import { COMMAND_CONFIGS } from "../../src/services/command-registry.js";
import {
  ApplicationCommandOptionType,
  type ChatInputCommandInteraction,
  type RESTPostAPIChatInputApplicationCommandsJSONBody,
} from "discord.js";

// Mock logger
jest.mock("../../src/utils/logger.js");

describe("Help Command", () => {
  describe("command metadata", () => {
    it("should have correct command name", () => {
      expect(data.name).toBe("help");
    });

    it("should have a description", () => {
      expect(data.description).toBeTruthy();
      expect(data.description).toBe("Get help with KoolBot commands");
    });

    it("should be a valid slash command", () => {
      const json = data.toJSON();
      expect(json).toHaveProperty("name", "help");
      expect(json).toHaveProperty("description");
    });

    it("should have optional command parameter", () => {
      const json = data.toJSON();
      expect(json.options).toBeDefined();
      expect(json.options?.length).toBe(1);

      const commandOption = json.options?.[0];
      expect(commandOption?.name).toBe("command");
      expect(commandOption?.type).toBe(3); // STRING type
      expect(commandOption?.required).toBe(false);
    });

    it("should have description for command parameter", () => {
      const json = data.toJSON();
      const commandOption = json.options?.[0];
      expect(commandOption?.description).toBeTruthy();
      expect(commandOption?.description).toContain("specific command");
    });
  });

  describe("execute", () => {
    let mockInteraction: Partial<ChatInputCommandInteraction>;

    beforeEach(() => {
      jest.clearAllMocks();

      mockInteraction = {
        options: {
          getString: jest.fn().mockReturnValue(null),
        } as any,
        reply: jest.fn().mockResolvedValue(undefined),
      };
    });

    it("should show general help when no command is specified", async () => {
      await execute(mockInteraction as ChatInputCommandInteraction);

      expect(mockInteraction.reply).toHaveBeenCalledWith({
        embeds: expect.arrayContaining([
          expect.objectContaining({
            data: expect.objectContaining({
              title: "📚 KoolBot Help",
            }),
          }),
        ]),
        ephemeral: true,
      });
    });

    it("should show specific command help when valid command is specified", async () => {
      (mockInteraction.options!.getString as jest.Mock).mockReturnValue("ping");

      await execute(mockInteraction as ChatInputCommandInteraction);

      expect(mockInteraction.reply).toHaveBeenCalledWith({
        embeds: expect.arrayContaining([
          expect.objectContaining({
            data: expect.objectContaining({
              title: "📖 Help: /ping",
            }),
          }),
        ]),
        ephemeral: true,
      });
    });

    it("should show error for non-existent command", async () => {
      (mockInteraction.options!.getString as jest.Mock).mockReturnValue(
        "nonexistent",
      );

      await execute(mockInteraction as ChatInputCommandInteraction);

      expect(mockInteraction.reply).toHaveBeenCalledWith({
        content: expect.stringContaining("Command `/nonexistent` not found"),
        ephemeral: true,
      });
    });

    it("should handle commands without config keys", async () => {
      (mockInteraction.options!.getString as jest.Mock).mockReturnValue(
        "config",
      );

      await execute(mockInteraction as ChatInputCommandInteraction);

      expect(mockInteraction.reply).toHaveBeenCalled();
    });

    it("should include usage information in specific command help", async () => {
      (mockInteraction.options!.getString as jest.Mock).mockReturnValue(
        "voicestats",
      );

      await execute(mockInteraction as ChatInputCommandInteraction);

      expect(mockInteraction.reply).toHaveBeenCalledWith({
        embeds: expect.arrayContaining([
          expect.objectContaining({
            data: expect.objectContaining({
              fields: expect.arrayContaining([
                expect.objectContaining({
                  name: "Usage",
                }),
              ]),
            }),
          }),
        ]),
        ephemeral: true,
      });
    });

    it("should accept a leading slash and mixed case in the command name", async () => {
      (mockInteraction.options!.getString as jest.Mock).mockReturnValue(
        " /Ping ",
      );

      await execute(mockInteraction as ChatInputCommandInteraction);

      expect(mockInteraction.reply).toHaveBeenCalledWith({
        embeds: expect.arrayContaining([
          expect.objectContaining({
            data: expect.objectContaining({
              title: "📖 Help: /ping",
            }),
          }),
        ]),
        ephemeral: true,
      });
    });

    it("should answer /help <command> for every command in the registry", async () => {
      for (const { name } of COMMAND_CONFIGS) {
        mockInteraction.reply = jest.fn().mockResolvedValue(undefined);
        (mockInteraction.options!.getString as jest.Mock).mockReturnValue(name);

        await execute(mockInteraction as ChatInputCommandInteraction);

        expect(mockInteraction.reply).toHaveBeenCalledWith({
          embeds: expect.arrayContaining([
            expect.objectContaining({
              data: expect.objectContaining({
                title: `📖 Help: /${name}`,
              }),
            }),
          ]),
          ephemeral: true,
        });
      }
    });

    it("should list every registered command in the general help", async () => {
      await execute(mockInteraction as ChatInputCommandInteraction);

      const embed = (mockInteraction.reply as jest.Mock).mock.calls[0][0]
        .embeds[0];
      const listed = embed.data.fields
        .filter((field: { name: string }) =>
          /Enabled Commands|Disabled Commands/.test(field.name),
        )
        .map((field: { value: string }) => field.value)
        .join("\n");

      for (const { name } of COMMAND_CONFIGS) {
        expect(listed).toContain(`\`/${name}\` - `);
      }
    });

    it("should handle multiple known commands", async () => {
      const commands = ["ping", "help", "quote", "achievements"];

      for (const cmd of commands) {
        mockInteraction.reply = jest.fn().mockResolvedValue(undefined);
        (mockInteraction.options!.getString as jest.Mock).mockReturnValue(cmd);

        await execute(mockInteraction as ChatInputCommandInteraction);

        expect(mockInteraction.reply).toHaveBeenCalled();
      }
    });
  });

  describe("registry-derived help entries", () => {
    it("should have an entry for every command in the registry (#845)", async () => {
      const entries = await getCommandHelpEntries();

      expect([...entries.keys()].sort()).toEqual(
        COMMAND_CONFIGS.map((config) => config.name).sort(),
      );

      for (const config of COMMAND_CONFIGS) {
        const entry = entries.get(config.name);
        expect(entry?.description).toBeTruthy();
        expect(entry?.usage).toMatch(new RegExp(`^/${config.name}( |$)`));
        expect(entry?.configKey).toBe(config.configKey);
      }
    });

    it("should describe the commands that used to be missing from /help", async () => {
      const entries = await getCommandHelpEntries();

      expect(entries.get("event")?.usage).toBe(
        "/event <create|list|cancel|start> [options]",
      );
      expect(entries.get("warn")?.usage).toBe("/warn <user> <reason>");
      expect(entries.get("modlog")?.usage).toBe("/modlog <user> [page]");
    });

    it("should reflect the /quote subcommand split instead of the old text: usage", async () => {
      const entries = await getCommandHelpEntries();

      expect(entries.get("quote")?.usage).toBe(
        "/quote <add|edit|export|import|reset> [options]",
      );
      expect(entries.get("quote")?.usage).not.toContain("text:");
    });

    it("should return the same cached map on repeated calls", async () => {
      const first = await getCommandHelpEntries();
      const second = await getCommandHelpEntries();
      expect(second).toBe(first);
    });

    it("should keep a fallback entry for a command whose module fails to load", async () => {
      const failing = "quote";
      const { entries, complete } = await buildHelpEntries(async (file) => {
        if (file === failing) {
          throw new Error("boom");
        }
        return import(`../../src/commands/${file}.js`);
      });

      expect(complete).toBe(false);
      // Every registry entry is still present, so /help never shrinks.
      expect([...entries.keys()].sort()).toEqual(
        COMMAND_CONFIGS.map((config) => config.name).sort(),
      );
      expect(entries.get(failing)).toEqual({
        name: failing,
        description: expect.stringContaining("unavailable"),
        usage: `/${failing}`,
        configKey: "quotes.enabled",
      });
      // Other commands are unaffected.
      expect(entries.get("warn")?.usage).toBe("/warn <user> <reason>");
    });

    it("should report a complete load when every module resolves", async () => {
      const { complete } = await buildHelpEntries();
      expect(complete).toBe(true);
    });
  });

  describe("usageFromCommand", () => {
    const command = (
      options: RESTPostAPIChatInputApplicationCommandsJSONBody["options"],
    ): RESTPostAPIChatInputApplicationCommandsJSONBody => ({
      name: "demo",
      description: "demo",
      options,
    });

    it("should render a bare command with no options", () => {
      expect(usageFromCommand(command(undefined))).toBe("/demo");
      expect(usageFromCommand(command([]))).toBe("/demo");
    });

    it("should mark required options with <> and optional ones with []", () => {
      expect(
        usageFromCommand(
          command([
            {
              type: ApplicationCommandOptionType.User,
              name: "user",
              description: "u",
              required: true,
            },
            {
              type: ApplicationCommandOptionType.Integer,
              name: "page",
              description: "p",
            },
          ]),
        ),
      ).toBe("/demo <user> [page]");
    });

    it("should list subcommands and note when they take options", () => {
      expect(
        usageFromCommand(
          command([
            {
              type: ApplicationCommandOptionType.Subcommand,
              name: "list",
              description: "l",
            },
            {
              type: ApplicationCommandOptionType.Subcommand,
              name: "add",
              description: "a",
              options: [
                {
                  type: ApplicationCommandOptionType.String,
                  name: "text",
                  description: "t",
                  required: true,
                },
              ],
            },
          ]),
        ),
      ).toBe("/demo <list|add> [options]");

      expect(
        usageFromCommand(
          command([
            {
              type: ApplicationCommandOptionType.Subcommand,
              name: "list",
              description: "l",
            },
          ]),
        ),
      ).toBe("/demo <list>");
    });
  });
});
