import {
  SlashCommandBuilder,
  ChatInputCommandInteraction,
  GuildMember,
  PermissionFlagsBits,
  AttachmentBuilder,
} from "discord.js";
import { quoteService } from "../services/quote-service.js";
import { QuoteChannelManager } from "../services/quote-channel-manager.js";
import logger from "../utils/logger.js";

// Hard cap on a restore upload. A quote backup is small text; this stops a
// misclicked giant attachment from being streamed into memory.
const MAX_IMPORT_BYTES = 5 * 1024 * 1024;

/**
 * Normalize a Discord user ID from various formats to a clean numeric ID
 * Handles: <@123>, <@!123>, @username, or plain 123
 * Returns the numeric ID or the original string if not parseable
 */
function normalizeUserId(input: string): string {
  // Extract ID from mention formats: <@123> or <@!123>
  const mentionMatch = input.match(/^<@!?(\d+)>$/);
  if (mentionMatch) {
    return mentionMatch[1];
  }

  // Remove leading @ if present
  const cleanInput = input.replace(/^@/, "");

  // If it's a numeric ID, return it
  if (/^\d+$/.test(cleanInput)) {
    return cleanInput;
  }

  // Return original if we can't parse it (might be a username)
  return input;
}

export const data = new SlashCommandBuilder()
  .setName("quote")
  .setDescription("Manage quotes in the quote channel")
  .addSubcommand((subcommand) =>
    subcommand
      .setName("add")
      .setDescription("Add a new quote to the quote channel")
      .addStringOption((option) =>
        option
          .setName("text")
          .setDescription("The quote text to add")
          .setRequired(true),
      )
      .addUserOption((option) =>
        option
          .setName("author")
          .setDescription("The author of the quote")
          .setRequired(true),
      ),
  )
  .addSubcommand((subcommand) =>
    subcommand
      .setName("edit")
      .setDescription("Edit an existing quote")
      .addStringOption((option) =>
        option
          .setName("id")
          .setDescription("The quote ID to edit (found in quote footer)")
          .setRequired(true),
      )
      .addStringOption((option) =>
        option
          .setName("text")
          .setDescription("The new quote text")
          .setRequired(false),
      )
      .addUserOption((option) =>
        option
          .setName("author")
          .setDescription("The new author of the quote")
          .setRequired(false),
      ),
  )
  .addSubcommand((subcommand) =>
    subcommand
      .setName("export")
      .setDescription("Admin: download a backup of all quotes (incl. votes)"),
  )
  .addSubcommand((subcommand) =>
    subcommand
      .setName("import")
      .setDescription("Admin: restore quotes from a backup file")
      .addAttachmentOption((option) =>
        option
          .setName("file")
          .setDescription("A backup file produced by /quote export")
          .setRequired(true),
      )
      .addBooleanOption((option) =>
        option
          .setName("rebuild")
          .setDescription(
            "Also purge and rebuild the quote channel after importing",
          )
          .setRequired(false),
      ),
  )
  .addSubcommand((subcommand) =>
    subcommand
      .setName("reset")
      .setDescription(
        "Admin: purge the quote channel and rebuild it from the database",
      ),
  );

/**
 * Whether the invoking guild member has the Administrator permission.
 * Mirrors the gating used by `/config`; returns false defensively when the
 * member object or permission bitfield is unavailable.
 */
function invokerIsAdmin(
  member: ChatInputCommandInteraction["member"],
): boolean {
  if (!member) return false;
  if (member instanceof GuildMember) {
    return member.permissions.has(PermissionFlagsBits.Administrator);
  }
  const raw = (member as { permissions?: unknown }).permissions;
  if (typeof raw !== "string") return false;
  try {
    return (
      (BigInt(raw) & PermissionFlagsBits.Administrator) ===
      PermissionFlagsBits.Administrator
    );
  } catch {
    return false;
  }
}

export async function execute(
  interaction: ChatInputCommandInteraction,
): Promise<void> {
  try {
    const subcommand = interaction.options.getSubcommand();

    if (subcommand === "add") {
      await handleAdd(interaction);
    } else if (subcommand === "edit") {
      await handleEdit(interaction);
    } else if (subcommand === "export") {
      await handleExport(interaction);
    } else if (subcommand === "import") {
      await handleImport(interaction);
    } else if (subcommand === "reset") {
      await handleReset(interaction);
    }
  } catch (error) {
    logger.error("Error executing quote command:", error);
    const errorMessage =
      error instanceof Error
        ? error.message
        : "There was an error while executing this command!";

    if (interaction.replied || interaction.deferred) {
      await interaction.followUp({
        content: `❌ ${errorMessage}`,
        ephemeral: true,
      });
    } else {
      await interaction.reply({
        content: `❌ ${errorMessage}`,
        ephemeral: true,
      });
    }
  }
}

async function handleAdd(
  interaction: ChatInputCommandInteraction,
): Promise<void> {
  const quoteText = interaction.options.getString("text", true);
  const author = interaction.options.getUser("author", true);

  // Add quote to database
  const quote = await quoteService.addQuote(
    quoteText,
    author.id,
    interaction.user.id,
    interaction.channelId,
    interaction.id,
  );

  // Post to quote channel
  const quoteChannelManager = QuoteChannelManager.getInstance(
    interaction.client,
  );
  const messageId = await quoteChannelManager.postQuote(
    quote._id.toString(),
    quote.content,
    quote.authorId,
    quote.addedById,
  );

  if (messageId) {
    // Update quote with message ID
    await quoteService.updateQuoteMessageId(quote._id.toString(), messageId);
    await interaction.reply({
      content: "✅ Quote added successfully and posted to the quote channel!",
      ephemeral: true,
    });
  } else {
    await interaction.reply({
      content:
        "✅ Quote added to database, but could not post to channel. Check quote channel configuration.",
      ephemeral: true,
    });
  }
}

async function handleEdit(
  interaction: ChatInputCommandInteraction,
): Promise<void> {
  const quoteId = interaction.options.getString("id", true);
  const newText = interaction.options.getString("text");
  const newAuthor = interaction.options.getUser("author");

  // Validate at least one field is being updated
  if (!newText && !newAuthor) {
    await interaction.reply({
      content:
        "❌ Please provide at least one field to update (text or author).",
      ephemeral: true,
    });
    return;
  }

  // Get existing quote to verify permissions
  const existingQuote = await quoteService.getQuoteById(quoteId);
  if (!existingQuote) {
    await interaction.reply({
      content: "❌ Quote not found with that ID.",
      ephemeral: true,
    });
    return;
  }

  // Check if user has permission to edit (only the person who added it can edit)
  if (existingQuote.addedById !== interaction.user.id) {
    await interaction.reply({
      content: "❌ You can only edit quotes that you added.",
      ephemeral: true,
    });
    return;
  }

  // Normalize authorId from existing quote (handles legacy formats)
  const normalizedExistingAuthorId = normalizeUserId(existingQuote.authorId);
  const normalizedAddedById = normalizeUserId(existingQuote.addedById);

  const finalContent = newText ?? existingQuote.content;
  const finalAuthorId = newAuthor?.id ?? normalizedExistingAuthorId;

  // First, try to update the message in the quote channel
  // This ensures we don't persist changes if the message can't be updated
  const quoteChannelManager = QuoteChannelManager.getInstance(
    interaction.client,
  );

  try {
    await quoteChannelManager.updateQuoteMessage(
      existingQuote.messageId,
      quoteId,
      finalContent,
      finalAuthorId,
      normalizedAddedById,
    );
  } catch (error) {
    logger.error(
      `Failed to update quote message for quote ${quoteId} (messageId=${existingQuote.messageId}):`,
      error,
    );

    await interaction.reply({
      content:
        "❌ I couldn't find or update the quote message in the quote channel. The quote may not have been posted successfully, or the message was deleted. Please contact a server admin.",
      ephemeral: true,
    });
    return;
  }

  // Only update quote in database after the message was successfully updated
  await quoteService.editQuote(quoteId, finalContent, finalAuthorId);

  await interaction.reply({
    content: "✅ Quote updated successfully!",
    ephemeral: true,
  });
}

async function handleExport(
  interaction: ChatInputCommandInteraction,
): Promise<void> {
  if (!invokerIsAdmin(interaction.member)) {
    await interaction.reply({
      content: "❌ This command requires the Administrator permission.",
      ephemeral: true,
    });
    return;
  }

  await interaction.deferReply({ ephemeral: true });

  const backup = await quoteService.exportQuotes();
  const json = JSON.stringify(backup, null, 2);
  const file = new AttachmentBuilder(Buffer.from(json, "utf-8"), {
    name: `quotes-backup-${new Date().toISOString().slice(0, 10)}.json`,
  });

  await interaction.editReply({
    content: `✅ Exported ${backup.quotes.length} quote${
      backup.quotes.length === 1 ? "" : "s"
    }. Keep this file safe — you can restore it with \`/quote import\`.`,
    files: [file],
  });
}

async function handleImport(
  interaction: ChatInputCommandInteraction,
): Promise<void> {
  if (!invokerIsAdmin(interaction.member)) {
    await interaction.reply({
      content: "❌ This command requires the Administrator permission.",
      ephemeral: true,
    });
    return;
  }

  const attachment = interaction.options.getAttachment("file", true);
  const rebuild = interaction.options.getBoolean("rebuild") ?? false;

  if (attachment.size > MAX_IMPORT_BYTES) {
    await interaction.reply({
      content: `❌ Backup file is too large (max ${MAX_IMPORT_BYTES / (1024 * 1024)} MB).`,
      ephemeral: true,
    });
    return;
  }

  await interaction.deferReply({ ephemeral: true });

  let payload: unknown;
  try {
    const response = await fetch(attachment.url);
    if (!response.ok) {
      throw new Error(`HTTP ${response.status}`);
    }
    payload = JSON.parse(await response.text());
  } catch (error) {
    logger.error("Failed to read quote backup attachment:", error);
    await interaction.editReply({
      content:
        "❌ Could not read the backup file. Make sure it's a valid JSON file produced by `/quote export`.",
    });
    return;
  }

  const result = await quoteService.importQuotes(payload);

  let summary = `✅ Imported ${result.imported}, skipped ${result.skipped}.`;
  if (result.errors.length > 0) {
    summary += ` First error: ${result.errors[0]}`;
  }

  if (rebuild && result.imported > 0) {
    try {
      const manager = QuoteChannelManager.getInstance(interaction.client);
      const { reposted } = await manager.resetChannel();
      summary += ` Rebuilt the quote channel (${reposted} quotes re-posted).`;
    } catch (error) {
      logger.error("Failed to rebuild quote channel after import:", error);
      summary +=
        " Import succeeded but the channel rebuild failed — run `/quote reset` to retry.";
    }
  }

  await interaction.editReply({ content: summary });
}

async function handleReset(
  interaction: ChatInputCommandInteraction,
): Promise<void> {
  if (!invokerIsAdmin(interaction.member)) {
    await interaction.reply({
      content: "❌ This command requires the Administrator permission.",
      ephemeral: true,
    });
    return;
  }

  await interaction.deferReply({ ephemeral: true });

  try {
    const manager = QuoteChannelManager.getInstance(interaction.client);
    const { reposted } = await manager.resetChannel();
    await interaction.editReply({
      content: `✅ Quote channel rebuilt: ${reposted} quote${
        reposted === 1 ? "" : "s"
      } re-posted with their saved vote tallies.`,
    });
  } catch (error) {
    logger.error("Failed to reset quote channel:", error);
    await interaction.editReply({
      content: `❌ Failed to rebuild the quote channel: ${
        error instanceof Error ? error.message : "Unknown error"
      }`,
    });
  }
}
