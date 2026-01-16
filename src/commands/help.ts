import {
  SlashCommandBuilder,
  ChatInputCommandInteraction,
  EmbedBuilder,
} from "discord.js";
import logger from "../utils/logger.js";
import { ConfigService } from "../services/config-service.js";

export const data = new SlashCommandBuilder()
  .setName("help")
  .setDescription("Get help with KoolBot commands")
  .addStringOption((option) =>
    option
      .setName("command")
      .setDescription("Get detailed help for a specific command")
      .setRequired(false),
  );

// Command descriptions with details
const commandDetails: Record<
  string,
  { description: string; usage: string; configKey?: string }
> = {
  ping: {
    description: "Check if the bot is responding and measure latency.",
    usage: "/ping",
    configKey: "ping.enabled",
  },
  help: {
    description: "Get help with KoolBot commands.",
    usage: "/help [command]",
    configKey: "help.enabled",
  },
  quote: {
    description: "Add a new quote to the quote channel.",
    usage: "/quote text:<text> author:<author>",
    configKey: "quotes.enabled",
  },
  amikool: {
    description: "Check if you have the kool role.",
    usage: "/amikool",
    configKey: "amikool.enabled",
  },
  vctop: {
    description: "View voice channel activity leaderboards.",
    usage: "/vctop [limit:10] [period:week|month|alltime]",
    configKey: "voicetracking.enabled",
  },
  vcstats: {
    description: "View your voice channel statistics.",
    usage: "/vcstats [period:week|month|alltime]",
    configKey: "voicetracking.enabled",
  },
  seen: {
    description: "Check when a user was last seen in voice channels.",
    usage: "/seen <user>",
    configKey: "voicetracking.seen.enabled",
  },
  "transfer-ownership": {
    description: "Transfer ownership of your voice channel to another user.",
    usage: "/transfer-ownership <user>",
    configKey: "voicechannels.enabled",
  },
  "announce-vc-stats": {
    description: "Manually trigger voice channel statistics announcement.",
    usage: "/announce-vc-stats",
    configKey: "voicetracking.announcements.enabled",
  },
  vc: {
    description: "Voice channel management commands.",
    usage: "/vc <subcommand> [options]",
    configKey: "voicechannels.enabled",
  },
  config: {
    description: "Manage bot configuration (Admin only).",
    usage: "/config <subcommand> [options]",
  },
  botstats: {
    description: "View bot statistics and health information.",
    usage: "/botstats",
  },
  dbtrunk: {
    description: "Database truncation commands (Admin only).",
    usage: "/dbtrunk <subcommand>",
  },
  "setup-lobby": {
    description: "Set up voice channel lobby (Admin only).",
    usage: "/setup-lobby",
    configKey: "voicechannels.enabled",
  },
  "exclude-channel": {
    description: "Manage voice channel tracking exclusions (Admin only).",
    usage: "/exclude-channel <subcommand> [channel]",
    configKey: "voicetracking.enabled",
  },
};

export async function execute(
  interaction: ChatInputCommandInteraction,
): Promise<void> {
  try {
    const requestedCommand = interaction.options.getString("command");
    const configService = ConfigService.getInstance();

    if (requestedCommand) {
      // Show detailed help for a specific command
      const commandInfo = commandDetails[requestedCommand];
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

      for (const [commandName, commandInfo] of Object.entries(commandDetails)) {
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
    await interaction.reply({
      content: "There was an error while executing this command!",
      ephemeral: true,
    });
  }
}
