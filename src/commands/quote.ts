import { SlashCommandBuilder, ChatInputCommandInteraction, GuildMemberRoleManager, Role } from 'discord.js';
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

export async function execute(interaction: ChatInputCommandInteraction): Promise<void> {
  const subcommand = interaction.options.getSubcommand();

  try {
    switch (subcommand) {
      case 'add': {
        // Check if user has permission to add quotes
        const addRoles = (await configService.get<string>('quotes.add_roles')).split(',').filter(Boolean);
        const memberRoles = interaction.member?.roles;
        const hasPermission = addRoles.length === 0 || // Empty means all users can add
          (memberRoles instanceof GuildMemberRoleManager &&
           memberRoles.cache.some((role: Role) => addRoles.includes(role.id)));

        if (!hasPermission) {
          await interaction.reply({ content: 'You do not have permission to add quotes', ephemeral: true });
          return;
        }

        const content = interaction.options.getString('content');
        const author = interaction.options.getUser('author');

        if (!content || !author) {
          await interaction.reply({ content: 'Missing required options', ephemeral: true });
          return;
        }

        const quote = await quoteService.addQuote(
          content,
          author.id,
          interaction.user.id,
          interaction.channelId,
          interaction.id
        );

        await interaction.reply({
          content: `Quote added! ID: ${quote._id}`,
          ephemeral: true
        });
        break;
      }

      case 'random': {
        const quote = await quoteService.getRandomQuote();
        const author = await interaction.client.users.fetch(quote.authorId);

        await interaction.reply({
          content: `"${quote.content}"\n- ${author.username}`,
          allowedMentions: { users: [] }
        });
        break;
      }

      case 'search': {
        const query = interaction.options.getString('query');
        if (!query) {
          await interaction.reply({ content: 'Missing search query', ephemeral: true });
          return;
        }

        const quotes = await quoteService.searchQuotes(query);

        if (quotes.length === 0) {
          await interaction.reply({ content: 'No quotes found matching your search', ephemeral: true });
          return;
        }

        const quoteList = quotes.map(quote =>
          `ID: ${quote._id}\n"${quote.content}"\n- <@${quote.authorId}>\n`
        ).join('\n');

        await interaction.reply({
          content: quoteList,
          allowedMentions: { users: [] }
        });
        break;
      }

      case 'delete': {
        const quoteId = interaction.options.getString('id');
        if (!quoteId) {
          await interaction.reply({ content: 'Missing quote ID', ephemeral: true });
          return;
        }

        const memberRoles = interaction.member?.roles;
        const userRoles = memberRoles instanceof GuildMemberRoleManager
          ? memberRoles.cache.map((role: Role) => role.id)
          : [];

        await quoteService.deleteQuote(quoteId, interaction.user.id, userRoles);
        await interaction.reply({ content: 'Quote deleted successfully', ephemeral: true });
        break;
      }
    }
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : 'An unknown error occurred';
    await interaction.reply({
      content: `Error: ${errorMessage}`,
      ephemeral: true
    });
  }
}
