import {
  SlashCommandBuilder,
  ChatInputCommandInteraction,
} from "discord.js";
import { quoteService } from "../services/quote-service.js";
import { QuoteChannelManager } from "../services/quote-channel-manager.js";
import logger from "../utils/logger.js";

export const data = new SlashCommandBuilder()
  .setName("quote")
  .setDescription("Add a new quote to the quote channel")
  .addStringOption((option) =>
    option
      .setName("text")
      .setDescription("The quote text to add")
      .setRequired(true),
  )
  .addStringOption((option) =>
    option
      .setName("author")
      .setDescription("The author of the quote")
      .setRequired(true),
  );

export async function execute(
  interaction: ChatInputCommandInteraction,
): Promise<void> {
  try {
    const quoteText = interaction.options.getString("text", true);
    const author = interaction.options.getString("author", true);

    // Add quote to database
    const quote = await quoteService.addQuote(
      quoteText,
      author,
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
  } catch (error) {
    logger.error("Error in quote command:", error);
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
