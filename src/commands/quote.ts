import {
  SlashCommandBuilder,
  ChatInputCommandInteraction,
  EmbedBuilder,
} from "discord.js";
import { quoteService } from "../services/quote-service.js";
import logger from "../utils/logger.js";

export const data = new SlashCommandBuilder()
  .setName("quote")
  .setDescription(
    "Manage quotes - add, search, like, dislike, delete, or list quotes",
  )
  .addSubcommand((subcommand) =>
    subcommand.setName("random").setDescription("Get a random quote"),
  )
  .addSubcommand((subcommand) =>
    subcommand
      .setName("add")
      .setDescription("Add a new quote")
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
      ),
  )
  .addSubcommand((subcommand) =>
    subcommand
      .setName("search")
      .setDescription("Search for quotes by content")
      .addStringOption((option) =>
        option
          .setName("query")
          .setDescription("Search query")
          .setRequired(true),
      ),
  )
  .addSubcommand((subcommand) =>
    subcommand
      .setName("like")
      .setDescription("Like a quote")
      .addStringOption((option) =>
        option
          .setName("id")
          .setDescription("The ID of the quote to like")
          .setRequired(true),
      ),
  )
  .addSubcommand((subcommand) =>
    subcommand
      .setName("dislike")
      .setDescription("Dislike a quote")
      .addStringOption((option) =>
        option
          .setName("id")
          .setDescription("The ID of the quote to dislike")
          .setRequired(true),
      ),
  )
  .addSubcommand((subcommand) =>
    subcommand
      .setName("delete")
      .setDescription("Delete a quote (admin or own quotes only)")
      .addStringOption((option) =>
        option
          .setName("id")
          .setDescription("The ID of the quote to delete")
          .setRequired(true),
      ),
  )
  .addSubcommand((subcommand) =>
    subcommand
      .setName("list")
      .setDescription("List all quotes with pagination")
      .addIntegerOption((option) =>
        option
          .setName("page")
          .setDescription("Page number (default: 1)")
          .setRequired(false)
          .setMinValue(1),
      ),
  );

export async function execute(
  interaction: ChatInputCommandInteraction,
): Promise<void> {
  try {
    const subcommand = interaction.options.getSubcommand();

    switch (subcommand) {
      case "random": {
        const quote = await quoteService.getRandomQuote();
        if (!quote) {
          await interaction.reply("No quotes available.");
          return;
        }

        const embed = new EmbedBuilder()
          .setColor(0x0099ff)
          .setDescription(`"${quote.content}"`)
          .addFields(
            { name: "Author", value: `<@${quote.authorId}>`, inline: true },
            { name: "Added by", value: `<@${quote.addedById}>`, inline: true },
            { name: "👍 Likes", value: quote.likes.toString(), inline: true },
            {
              name: "👎 Dislikes",
              value: quote.dislikes.toString(),
              inline: true,
            },
          )
          .setFooter({ text: `ID: ${quote._id}` })
          .setTimestamp(quote.createdAt);

        await interaction.reply({ embeds: [embed] });
        break;
      }

      case "add": {
        const quoteText = interaction.options.getString("text", true);
        const author = interaction.options.getString("author", true);

        await quoteService.addQuote(
          quoteText,
          author,
          interaction.user.id,
          interaction.channelId,
          interaction.id,
        );
        await interaction.reply("✅ Quote added successfully!");
        break;
      }

      case "search": {
        const query = interaction.options.getString("query", true);
        const results = await quoteService.searchQuotes(query);

        if (results.length === 0) {
          await interaction.reply(`No quotes found matching "${query}".`);
          return;
        }

        const embed = new EmbedBuilder()
          .setColor(0x0099ff)
          .setTitle(`🔍 Search Results for "${query}"`)
          .setDescription(`Found ${results.length} quote(s)`)
          .setTimestamp();

        results.forEach((quote, index) => {
          embed.addFields({
            name: `${index + 1}. ${quote._id}`,
            value: `"${quote.content.substring(0, 100)}${quote.content.length > 100 ? "..." : ""}"\n— <@${quote.authorId}> (👍 ${quote.likes} 👎 ${quote.dislikes})`,
            inline: false,
          });
        });

        await interaction.reply({ embeds: [embed] });
        break;
      }

      case "like": {
        const quoteId = interaction.options.getString("id", true);
        const quote = await quoteService.getQuoteById(quoteId);

        if (!quote) {
          await interaction.reply({
            content: "❌ Quote not found. Please check the ID and try again.",
            ephemeral: true,
          });
          return;
        }

        await quoteService.likeQuote(quoteId);
        await interaction.reply(
          `👍 Liked quote: "${quote.content.substring(0, 50)}..."`,
        );
        break;
      }

      case "dislike": {
        const quoteId = interaction.options.getString("id", true);
        const quote = await quoteService.getQuoteById(quoteId);

        if (!quote) {
          await interaction.reply({
            content: "❌ Quote not found. Please check the ID and try again.",
            ephemeral: true,
          });
          return;
        }

        await quoteService.dislikeQuote(quoteId);
        await interaction.reply(
          `👎 Disliked quote: "${quote.content.substring(0, 50)}..."`,
        );
        break;
      }

      case "delete": {
        const quoteId = interaction.options.getString("id", true);
        const member = interaction.member;

        if (!member) {
          await interaction.reply({
            content: "❌ Could not verify your permissions.",
            ephemeral: true,
          });
          return;
        }

        // Get user roles
        const userRoles =
          "roles" in member && member.roles instanceof Array
            ? member.roles
            : "roles" in member &&
                typeof member.roles === "object" &&
                "cache" in member.roles
              ? Array.from(member.roles.cache.values()).map((role) => role.name)
              : [];

        await quoteService.deleteQuote(quoteId, interaction.user.id, userRoles);
        await interaction.reply("✅ Quote deleted successfully!");
        break;
      }

      case "list": {
        const page = interaction.options.getInteger("page") || 1;
        const { quotes, total, totalPages } = await quoteService.listQuotes(
          page,
          5,
        );

        if (quotes.length === 0) {
          await interaction.reply("No quotes available.");
          return;
        }

        const embed = new EmbedBuilder()
          .setColor(0x0099ff)
          .setTitle("📚 Quote List")
          .setDescription(
            `Page ${page} of ${totalPages} (${total} total quotes)`,
          )
          .setTimestamp();

        quotes.forEach((quote, index) => {
          const quoteNumber = (page - 1) * 5 + index + 1;
          embed.addFields({
            name: `${quoteNumber}. ${quote._id}`,
            value: `"${quote.content.substring(0, 100)}${quote.content.length > 100 ? "..." : ""}"\n— <@${quote.authorId}> (👍 ${quote.likes} 👎 ${quote.dislikes})`,
            inline: false,
          });
        });

        if (totalPages > 1) {
          embed.setFooter({
            text: `Use /quote list page:${page + 1} for next page`,
          });
        }

        await interaction.reply({ embeds: [embed] });
        break;
      }

      default:
        await interaction.reply({
          content: "Unknown subcommand.",
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
