import {
  CommandInteraction,
  SlashCommandBuilder,
  GuildMember,
} from "discord.js";
import logger from "../utils/logger.js";
import { ConfigService } from "../services/config-service.js";

const configService = ConfigService.getInstance();

const koolResponses = [
  "Yes, you are kool! 😎",
  "Absolutely kool! 🌟",
  "You're the koolest! 🎸",
  "Kool status: Confirmed! ✅",
  "100% kool certified! 🏆",
  "Kool as ice! ❄️",
  "Much kool, Such wow! 👑",
  "Kool vibes detected! 🎵",
  "Maximum koolness achieved! 🚀",
  "Kool level: Legendary! 🏅",
];

const notKoolResponses = [
  "No, you are not kool... yet! 😢",
  "Kool status: Pending... ⏳",
  "Not quite kool enough... 🥺",
  "Koolness level: Needs improvement 📈",
  "Almost kool, but not quite! 🎯",
  "Kool potential detected! 💫",
  "Koolness in progress... 🔄",
  "Future kool kid! 🌱",
  "Kool training required! 🎓",
  "Koolness upgrade available! 💎",
];

export const data = new SlashCommandBuilder()
  .setName("amikool")
  .setDescription("Check if you are kool");

export async function execute(interaction: CommandInteraction): Promise<void> {
  try {
    logger.info(`Executing amikool command for user ${interaction.user.tag}`);

    const member = interaction.member as GuildMember;
    const coolRoleName = await configService.get<string>(
      "COOL_ROLE_NAME",
      "Kool",
    );
    const hasCoolRole = member?.roles.cache.some(
      (role) => role.name === coolRoleName,
    );

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
