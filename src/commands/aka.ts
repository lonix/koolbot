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
import { TrackingOptOutService } from "../services/tracking-opt-out-service.js";
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

/** Discord's message limit is 2000; leave headroom. */
const CHUNK_LIMIT = 1900;

/** Render grouped history as lines (section headers + one line per name). */
export function historyLines(history: NameHistoryByKind): string[] {
  const lines: string[] = [];
  for (const kind of NAME_KINDS) {
    const rows = history[kind];
    if (rows.length === 0) continue;
    if (lines.length > 0) lines.push("");
    lines.push(`**${KIND_TITLES[kind]}**`);
    for (const row of rows) {
      lines.push(
        `• **${plain(row.name)}** — first seen ${stamp(row.firstSeenAt)}, last seen ${stamp(row.lastSeenAt)}`,
      );
    }
  }
  return lines;
}

/** Render grouped history as one string. */
export function formatHistory(history: NameHistoryByKind): string {
  return historyLines(history).join("\n");
}

/**
 * Pack whole lines into messages no longer than `limit`, never splitting a
 * line, so a long history spills into follow-ups instead of being cut off.
 */
export function chunkLines(
  lines: string[],
  limit: number = CHUNK_LIMIT,
): string[] {
  const chunks: string[] = [];
  let current = "";
  for (const line of lines) {
    const next = current ? `${current}\n${line}` : line;
    if (next.length > limit && current) {
      chunks.push(current);
      current = line;
    } else {
      current = next;
    }
  }
  if (current) chunks.push(current);
  return chunks;
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

    // Before the first await (#918): a target who opts out or resets while
    // this command is suspended must not be re-recorded by it.
    const admission = TrackingOptOutService.getInstance().admission();

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
      await service.recordUser(
        interaction.guildId,
        targetUser,
        nickname,
        admission,
      );
    }

    const history = await service.getHistory(
      interaction.guildId,
      targetUser.id,
    );
    const lines = historyLines(history);
    const notes: string[] = [];
    if (!recording) {
      notes.push(
        "Name history recording is turned off, so no new names are being saved.",
      );
    } else if (!env.guildMembersIntent) {
      notes.push(
        "Live nickname-change tracking is off (the bot's `GuildMembers` intent isn't enabled), so nicknames are only captured when the bot happens to see the member.",
      );
    }

    const header = `Names previously known for <@${targetUser.id}>`;
    const messages =
      lines.length > 0
        ? chunkLines([header, "", ...lines])
        : [
            `No name history recorded yet for <@${targetUser.id}>. History only starts from when recording was enabled.`,
          ];
    if (notes.length > 0) {
      const footer = `_${notes.join(" ")}_`;
      const last = messages[messages.length - 1];
      if (last.length + footer.length + 2 <= 2000) {
        messages[messages.length - 1] = `${last}\n\n${footer}`;
      } else {
        messages.push(footer);
      }
    }

    const [first, ...rest] = messages;
    await interaction.editReply({
      content: first,
      allowedMentions: { parse: [] },
    });
    for (const content of rest) {
      await interaction.followUp({
        content,
        flags: MessageFlags.Ephemeral,
        allowedMentions: { parse: [] },
      });
    }
  } catch (error) {
    logger.error("Error in aka command:", error);
    await safeReply(interaction, {
      content: "There was an error while executing this command!",
    });
  }
}
