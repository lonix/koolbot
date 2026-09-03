import {
  SlashCommandBuilder,
  ChatInputCommandInteraction,
  EmbedBuilder,
  ApplicationCommandOptionType,
  type APIApplicationCommandSubcommandGroupOption,
  type APIApplicationCommandSubcommandOption,
  type RESTPostAPIChatInputApplicationCommandsJSONBody,
} from "discord.js";
import logger from "../utils/logger.js";
import { safeReply } from "../utils/safe-reply.js";
import { ConfigService } from "../services/config-service.js";
import { COMMAND_CONFIGS } from "../services/command-registry.js";

export const data = new SlashCommandBuilder()
  .setName("help")
  .setDescription("Get help with KoolBot commands")
  .addStringOption((option) =>
    option
      .setName("command")
      .setDescription("Get detailed help for a specific command")
      .setRequired(false),
  );

/** Help metadata for one registered slash command. */
export interface CommandHelpEntry {
  name: string;
  description: string;
  usage: string;
  configKey: string | null;
}

type SubcommandLike =
  | APIApplicationCommandSubcommandOption
  | APIApplicationCommandSubcommandGroupOption;

function isSubcommandLike(
  option: NonNullable<
    RESTPostAPIChatInputApplicationCommandsJSONBody["options"]
  >[number],
): option is SubcommandLike {
  return (
    option.type === ApplicationCommandOptionType.Subcommand ||
    option.type === ApplicationCommandOptionType.SubcommandGroup
  );
}

/** Leaf subcommand paths: `add` for a subcommand, `group sub` for each subcommand in a group. */
function subcommandPaths(option: SubcommandLike): string[] {
  if (option.type === ApplicationCommandOptionType.SubcommandGroup) {
    return (option.options ?? []).map((sub) => `${option.name} ${sub.name}`);
  }
  return [option.name];
}

/** Whether any leaf subcommand under this option takes parameters. */
function takesParameters(option: SubcommandLike): boolean {
  if (option.type === ApplicationCommandOptionType.SubcommandGroup) {
    return (option.options ?? []).some((sub) => (sub.options?.length ?? 0) > 0);
  }
  return (option.options?.length ?? 0) > 0;
}

/**
 * Builds a one-line usage string from a command's registration payload:
 * `/quote <add|edit|export|import|reset> [options]` for subcommand-based
 * commands (a subcommand group expands to `group sub` paths, e.g.
 * `/foo <add|settings show|settings set>`), and `/warn <user> <reason>` /
 * `/modlog <user> [page]` for plain option lists.
 */
export function usageFromCommand(
  command: RESTPostAPIChatInputApplicationCommandsJSONBody,
): string {
  const options = command.options ?? [];
  const subcommands = options.filter(isSubcommandLike);

  if (subcommands.length > 0) {
    const hasOptions = subcommands.some(takesParameters);
    const paths = subcommands.flatMap(subcommandPaths).join("|");
    return `/${command.name} <${paths}>${hasOptions ? " [options]" : ""}`;
  }

  const params = options.map((option) =>
    option.required ? `<${option.name}>` : `[${option.name}]`,
  );
  return [`/${command.name}`, ...params].join(" ");
}

type CommandModuleLoader = (
  file: string,
) => Promise<{ data: SlashCommandBuilder }>;

const importCommandModule: CommandModuleLoader = (file) =>
  import(`./${file}.js`);

/**
 * Builds the help entries for every command in the registry. A command whose
 * module fails to load still gets a minimal entry (name + config key) so the
 * list never silently shrinks; `complete` reports whether every module loaded.
 */
export async function buildHelpEntries(
  loadCommandModule: CommandModuleLoader = importCommandModule,
): Promise<{ entries: Map<string, CommandHelpEntry>; complete: boolean }> {
  const entries = new Map<string, CommandHelpEntry>();
  let complete = true;

  for (const config of COMMAND_CONFIGS) {
    try {
      const json = (await loadCommandModule(config.file)).data.toJSON();
      entries.set(config.name, {
        name: config.name,
        description: json.description,
        usage: usageFromCommand(json),
        configKey: config.configKey,
      });
    } catch (error) {
      complete = false;
      logger.warn(`Failed to load help metadata for /${config.name}:`, error);
      entries.set(config.name, {
        name: config.name,
        description: "Description unavailable (command module failed to load).",
        usage: `/${config.name}`,
        configKey: config.configKey,
      });
    }
  }

  return { entries, complete };
}

let cachedHelpEntries: Map<string, CommandHelpEntry> | undefined;

/**
 * Help entries derived from the command registry and each command's
 * `SlashCommandBuilder`, so `/help` never needs a hand-maintained copy of
 * command metadata. Cached once every command module has loaded; a partial
 * result (some module failed) is returned but not cached, so a transient
 * failure is retried on the next `/help` instead of sticking until restart.
 */
export async function getCommandHelpEntries(): Promise<
  Map<string, CommandHelpEntry>
> {
  if (cachedHelpEntries) {
    return cachedHelpEntries;
  }
  const { entries, complete } = await buildHelpEntries();
  if (complete) {
    cachedHelpEntries = entries;
  }
  return entries;
}

export async function execute(
  interaction: ChatInputCommandInteraction,
): Promise<void> {
  try {
    const requestedCommand = interaction.options
      .getString("command")
      ?.trim()
      .replace(/^\//, "")
      .toLowerCase();
    const configService = ConfigService.getInstance();
    const helpEntries = await getCommandHelpEntries();

    if (requestedCommand) {
      // Show detailed help for a specific command
      const commandInfo = helpEntries.get(requestedCommand);
      if (!commandInfo) {
        await interaction.reply({
          content: `❌ Command \`/${requestedCommand}\` not found. Use \`/help\` to see all available commands.`,
          ephemeral: true,
        });
        return;
      }

      // Check if command is enabled
      let isEnabled = true;
      if (commandInfo.configKey) {
        isEnabled = await configService.getBoolean(
          commandInfo.configKey,
          false,
        );
      }

      const embed = new EmbedBuilder()
        .setColor(isEnabled ? 0x00ff00 : 0xff0000)
        .setTitle(`📖 Help: /${requestedCommand}`)
        .setDescription(commandInfo.description)
        .addFields(
          { name: "Usage", value: `\`${commandInfo.usage}\``, inline: false },
          {
            name: "Status",
            value: isEnabled ? "✅ Enabled" : "❌ Disabled",
            inline: true,
          },
        )
        .setTimestamp();

      if (commandInfo.configKey) {
        embed.addFields({
          name: "Config Key",
          value: `\`${commandInfo.configKey}\``,
          inline: true,
        });
      }

      await interaction.reply({ embeds: [embed], ephemeral: true });
    } else {
      // Show list of all commands
      const enabledCommands: string[] = [];
      const disabledCommands: string[] = [];

      for (const [commandName, commandInfo] of helpEntries) {
        let isEnabled = true;
        if (commandInfo.configKey) {
          isEnabled = await configService.getBoolean(
            commandInfo.configKey,
            false,
          );
        }

        if (isEnabled) {
          enabledCommands.push(
            `\`/${commandName}\` - ${commandInfo.description}`,
          );
        } else {
          disabledCommands.push(
            `\`/${commandName}\` - ${commandInfo.description}`,
          );
        }
      }

      const embed = new EmbedBuilder()
        .setColor(0x0099ff)
        .setTitle("📚 KoolBot Help")
        .setDescription(
          "Here are all available commands. Use `/help <command>` for detailed information about a specific command.",
        )
        .setTimestamp();

      if (enabledCommands.length > 0) {
        embed.addFields({
          name: "✅ Enabled Commands",
          value: enabledCommands.join("\n"),
          inline: false,
        });
      }

      if (disabledCommands.length > 0) {
        embed.addFields({
          name: "❌ Disabled Commands",
          value: disabledCommands.join("\n"),
          inline: false,
        });
      }

      embed.addFields({
        name: "💡 Tip",
        value:
          "Use `/help <command>` to get detailed information about a specific command.",
        inline: false,
      });

      await interaction.reply({ embeds: [embed], ephemeral: true });
    }
  } catch (error) {
    logger.error("Error in help command:", error);
    await safeReply(interaction, {
      content: "There was an error while executing this command!",
      ephemeral: true,
    });
  }
}
