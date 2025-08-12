import {
  SlashCommandBuilder,
  ChatInputCommandInteraction,
} from "discord.js";
import { quoteService } from "../services/quote-service.js";
import logger from "../utils/logger.js";

export const data = new SlashCommandBuilder()
  .setName("quote")
  .setDescription("Get a random quote or add a new one")
  .addStringOption((option) =>
    option
      .setName("text")
      .setDescription("The quote text to add")
      .setRequired(false),
  )
  .addStringOption((option) =>
    option
      .setName("author")
      .setDescription("The author of the quote")
      .setRequired(false),
  );

export async function execute(interaction: ChatInputCommandInteraction) {
  try {
    const quoteText = interaction.options.getString("text");
    const author = interaction.options.getString("author");

    if (quoteText) {
      // Add a new quote
      if (!author) {
        await interaction.reply("Please provide an author for the quote.");
        return;
      }

      await quoteService.addQuote(
        quoteText,
        author,
        interaction.user.id,
        interaction.channelId,
        interaction.id,
      );
      await interaction.reply("Quote added successfully!");
    } else {
      // Get a random quote
      const quote = await quoteService.getRandomQuote();
      if (!quote) {
        await interaction.reply("No quotes available.");
        return;
      }

      await interaction.reply(`"${quote.content}" - ${quote.authorId}`);
    }
  } catch (error) {
    logger.error("Error in quote command:", error);
    await interaction.reply({
      content: "There was an error while executing this command!",
      ephemeral: true,
    });
  }
}
