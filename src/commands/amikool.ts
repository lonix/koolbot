import {
  CommandInteraction,
  SlashCommandBuilder,
  GuildMember,
} from "discord.js";
import logger from "../utils/logger.js";
import { ConfigService } from "../services/config-service.js";
import {
  koolResponses,
  notKoolResponses,
} from "../content/amikool-responses.js";

const configService = ConfigService.getInstance();

export const data = new SlashCommandBuilder()
  .setName("amikool")
  .setDescription("Check if you are kool");

export async function execute(interaction: CommandInteraction): Promise<void> {
  try {
    logger.info(`Executing amikool command for user ${interaction.user.tag}`);

    const member = interaction.member as GuildMember;
    const coolRoleId = await configService.getString("amikool.role_id", "");
    const hasCoolRole = coolRoleId
      ? Boolean(member?.roles.cache.has(coolRoleId))
      : false;

    const response = hasCoolRole
      ? koolResponses[Math.floor(Math.random() * koolResponses.length)]
      : notKoolResponses[Math.floor(Math.random() * notKoolResponses.length)];

    await interaction.reply(response);
    logger.info(`Amikool command completed for user ${interaction.user.tag}`);
  } catch (error) {
    logger.error("Error executing amikool command:", error);
    await interaction.reply({
      content: "An error occurred while checking your kool status.",
      ephemeral: true,
    });
  }
}
