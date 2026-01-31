import { SlashCommandBuilder, ChatInputCommandInteraction } from "discord.js";
import { quoteService } from "../services/quote-service.js";
import { QuoteChannelManager } from "../services/quote-channel-manager.js";
import logger from "../utils/logger.js";

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
  );

export async function execute(
  interaction: ChatInputCommandInteraction,
): Promise<void> {
  try {
    const subcommand = interaction.options.getSubcommand();

    if (subcommand === "add") {
      await handleAdd(interaction);
    } else if (subcommand === "edit") {
      await handleEdit(interaction);
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
