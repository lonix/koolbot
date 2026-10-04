import { SlashCommandBuilder, ChatInputCommandInteraction } from "discord.js";
import { runWebSignin } from "../services/web-signin-launcher.js";

export const data = new SlashCommandBuilder()
  .setName("me")
  .setDescription(
    "Open your personal Koolbot settings (sends you a single-use sign-in link)",
  );

export async function execute(
  interaction: ChatInputCommandInteraction,
): Promise<void> {
  // Always a `user`-role session, even for admins, so a personal link never
  // carries admin scope.
  await runWebSignin(interaction, {
    commandName: "me",
    role: "user",
    buildDmBody: (url, ttlMinutes) =>
      `🔗 **Koolbot sign-in link**\n` +
      `${url}\n` +
      `Opens **My preferences** (\`/me/\`) — your personal Koolbot settings ` +
      `for this server.\n` +
      `\n` +
      `This link is single-use and expires in about ${ttlMinutes} minute(s). ` +
      `If you did not run \`/me\`, ignore this message.`,
  });
}
