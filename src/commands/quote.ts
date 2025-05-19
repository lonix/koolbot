import { SlashCommandBuilder, PermissionFlagsBits } from 'discord.js';
import { quoteService } from '../services/quote-service.js';
import { ConfigService } from '../services/config-service.js';

const configService = ConfigService.getInstance();

export const data = new SlashCommandBuilder()
  .setName('quote')
  .setDescription('Manage quotes')
  .addSubcommand(subcommand =>
    subcommand
      .setName('add')
      .setDescription('Add a new quote')
      .addStringOption(option =>
        option
          .setName('content')
          .setDescription('The quote content')
          .setRequired(true)
      )
      .addUserOption(option =>
        option
          .setName('author')
          .setDescription('The person who said the quote')
          .setRequired(true)
      )
  )
  .addSubcommand(subcommand =>
    subcommand
      .setName('random')
      .setDescription('Get a random quote')
  )
  .addSubcommand(subcommand =>
    subcommand
      .setName('search')
      .setDescription('Search for quotes')
      .addStringOption(option =>
        option
          .setName('query')
          .setDescription('Search query')
          .setRequired(true)
      )
  )
  .addSubcommand(subcommand =>
    subcommand
      .setName('delete')
      .setDescription('Delete a quote')
      .addStringOption(option =>
        option
          .setName('id')
          .setDescription('The quote ID')
          .setRequired(true)
      )
  );

export async function execute(interaction: any) {
  const subcommand = interaction.options.getSubcommand();

  try {
    switch (subcommand) {
      case 'add': {
        // Check if user has permission to add quotes
        const addRoles = (await configService.get<string>('quotes.add_roles')).split(',').filter(Boolean);
        const hasPermission = addRoles.length === 0 || // Empty means all users can add
          interaction.member.roles.cache.some((role: any) => addRoles.includes(role.id));

        if (!hasPermission) {
          return interaction.reply({ content: 'You do not have permission to add quotes', ephemeral: true });
        }

        const content = interaction.options.getString('content');
        const author = interaction.options.getUser('author');

        const quote = await quoteService.addQuote(
          content,
          author.id,
          interaction.user.id,
          interaction.channelId,
          interaction.id
        );

        return interaction.reply({
          content: `Quote added! ID: ${quote._id}`,
          ephemeral: true
        });
      }

      case 'random': {
        const quote = await quoteService.getRandomQuote();
        const author = await interaction.client.users.fetch(quote.authorId);

        return interaction.reply({
          content: `"${quote.content}"\n- ${author.username}`,
          allowedMentions: { users: [] }
        });
      }

      case 'search': {
        const query = interaction.options.getString('query');
        const quotes = await quoteService.searchQuotes(query);

        if (quotes.length === 0) {
          return interaction.reply({ content: 'No quotes found matching your search', ephemeral: true });
        }

        const quoteList = quotes.map((quote: any) =>
          `ID: ${quote._id}\n"${quote.content}"\n- <@${quote.authorId}>\n`
        ).join('\n');

        return interaction.reply({
          content: quoteList,
          allowedMentions: { users: [] }
        });
      }

      case 'delete': {
        const quoteId = interaction.options.getString('id');
        const userRoles = interaction.member.roles.cache.map((role: any) => role.id);

        await quoteService.deleteQuote(quoteId, interaction.user.id, userRoles);
        return interaction.reply({ content: 'Quote deleted successfully', ephemeral: true });
      }
    }
  } catch (error: any) {
    return interaction.reply({
      content: `Error: ${error.message}`,
      ephemeral: true
    });
  }
}
