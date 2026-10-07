import {
  SlashCommandBuilder,
  ChatInputCommandInteraction,
  PermissionFlagsBits,
} from "discord.js";
import {
  invokerIsAdminOrGroup,
  runWebSignin,
} from "../services/web-signin-launcher.js";

export const data = new SlashCommandBuilder()
  .setName("config")
  .setDescription(
    "Admins: open the Koolbot admin web UI (sends you a single-use sign-in link)",
  )
  // Hides the command from non-admins in the picker; the runtime check below
  // is defence in depth (guild admins can re-scope command permissions).
  .setDefaultMemberPermissions(PermissionFlagsBits.Administrator);

export async function execute(
  interaction: ChatInputCommandInteraction,
): Promise<void> {
  await runWebSignin(
    interaction,
    {
      commandName: "config",
      role: "admin",
      buildDmBody: (url, ttlMinutes) =>
        `🔗 **Koolbot admin sign-in link**\n` +
        `${url}\n` +
        `\n` +
        `Once you've signed in:\n` +
        `• **Admin panel:** the link above drops you on \`/admin/\`.\n` +
        `• **My preferences:** your own settings are at \`/me/\` ` +
        `(also reachable via the header link on every admin page). ` +
        `Run \`/me\` for a link that opens them directly.\n` +
        `\n` +
        `This link is single-use and expires in about ${ttlMinutes} minute(s). ` +
        `If you did not run \`/config\`, ignore this message.`,
    },
    async () =>
      (await invokerIsAdminOrGroup(interaction))
        ? null
        : "`/config` is for administrators. Use `/me` to open your personal settings.",
  );
}
