import {
  SlashCommandBuilder,
  ChatInputCommandInteraction,
  SlashCommandUserOption,
  MessageFlags,
} from "discord.js";
import { env } from "../config/env.js";
import {
  NameHistoryByKind,
  NameHistoryService,
} from "../services/name-history-service.js";
import { NAME_KINDS, NameKind } from "../models/user-name-history.js";
import logger from "../utils/logger.js";
import { safeReply } from "../utils/safe-reply.js";

export const data = new SlashCommandBuilder()
  .setName("aka")
  .setDescription("Show the names a member has previously gone by")
  .addUserOption((option: SlashCommandUserOption) =>
    option
      .setName("user")
      .setDescription("The member to look up")
      .setRequired(true),
  );

const KIND_TITLES: Record<NameKind, string> = {
  username: "Usernames",
  globalName: "Display names",
  nickname: "Server nicknames",
};

/** Escape Discord markdown so a name cannot restyle or ping in the reply. */
function plain(name: string): string {
  return name.replace(/([\\*_~`|>[\]()#-])/g, "\\$1").replace(/@/g, "@\u200b");
}

function stamp(date: Date): string {
  return `<t:${Math.floor(new Date(date).getTime() / 1000)}:D>`;
}

/** Render grouped history; exported so the layout can be tested directly. */
export function formatHistory(history: NameHistoryByKind): string {
  const sections: string[] = [];
  for (const kind of NAME_KINDS) {
    const rows = history[kind];
    if (rows.length === 0) continue;
    const lines = rows.map(
      (row) =>
        `• **${plain(row.name)}** — first seen ${stamp(row.firstSeenAt)}, last seen ${stamp(row.lastSeenAt)}`,
    );
    sections.push(`**${KIND_TITLES[kind]}**\n${lines.join("\n")}`);
  }
  return sections.join("\n\n");
}

export async function execute(
  interaction: ChatInputCommandInteraction,
): Promise<void> {
  try {
    const targetUser = interaction.options.getUser("user");
    if (!targetUser) {
      await interaction.reply({
        content: "Please specify a member to look up.",
        flags: MessageFlags.Ephemeral,
      });
      return;
    }
    if (!interaction.guildId) {
      await interaction.reply({
        content: "This command can only be used in a server.",
        flags: MessageFlags.Ephemeral,
      });
      return;
    }

    // Acknowledge before the DB lookup (#842). Ephemeral: past names are the
    // kind of thing a member may not want broadcast to the channel.
    await interaction.deferReply({ flags: MessageFlags.Ephemeral });

    const service = NameHistoryService.getInstance();
    const recording = await service.isEnabled();

    // Opportunistic capture: the target is right here, so snapshot them now.
    if (recording) {
      const member = interaction.options.getMember("user");
      const nickname =
        member && "nickname" in member ? (member.nickname ?? null) : undefined;
      await service.recordUser(interaction.guildId, targetUser, nickname);
    }

    const history = await service.getHistory(
      interaction.guildId,
      targetUser.id,
    );
    const body = formatHistory(history);
    const notes: string[] = [];
    if (!recording) {
      notes.push(
        "Name history recording is turned off, so no new names are being saved.",
      );
    } else if (!env.guildMembersIntent) {
      notes.push(
        "Server nickname history isn't being recorded: the bot's `GuildMembers` intent is off.",
      );
    }

    const header = `Names previously known for <@${targetUser.id}>`;
    const text = body
      ? `${header}\n\n${body}`
      : `No name history recorded yet for <@${targetUser.id}>. History only starts from when recording was enabled.`;
    const footer = notes.length ? `\n\n_${notes.join(" ")}_` : "";
    await interaction.editReply({
      content: (text + footer).slice(0, 2000),
      allowedMentions: { parse: [] },
    });
  } catch (error) {
    logger.error("Error in aka command:", error);
    await safeReply(interaction, {
      content: "There was an error while executing this command!",
    });
  }
}
