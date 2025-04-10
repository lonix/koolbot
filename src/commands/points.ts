import { SlashCommandBuilder, CommandInteraction, EmbedBuilder } from 'discord.js';
import { Command } from '../types/command';
import { addPoints, getUserPoints } from '../utils/database';

export const points: Command = {
  data: new SlashCommandBuilder()
    .setName('points')
    .setDescription('Manage your points')
    .addSubcommand(subcommand =>
      subcommand
        .setName('check')
        .setDescription('Check your current points')
    )
    .addSubcommand(subcommand =>
      subcommand
        .setName('add')
        .setDescription('Add points to a user')
        .addUserOption(option =>
          option
            .setName('user')
            .setDescription('The user to add points to')
            .setRequired(true)
        )
        .addIntegerOption(option =>
          option
            .setName('amount')
            .setDescription('The amount of points to add')
            .setRequired(true)
            .setMinValue(1)
        )
        .addStringOption(option =>
          option
            .setName('reason')
            .setDescription('The reason for adding points')
            .setRequired(true)
        )
    ),

  async execute(interaction: CommandInteraction) {
    if (!interaction.guild) {
      await interaction.reply({ content: 'This command can only be used in a server!', ephemeral: true });
      return;
    }

    const subcommand = interaction.options.data[0]?.name;

    if (subcommand === 'check') {
      const points = await getUserPoints(interaction.user.id);
      const embed = new EmbedBuilder()
        .setTitle('Your Points')
        .setDescription(`You currently have ${points} points!`)
        .setColor('#00ff00');
      await interaction.reply({ embeds: [embed] });
    } else if (subcommand === 'add') {
      // Check if user has permission to add points
      if (!interaction.memberPermissions?.has('Administrator')) {
        await interaction.reply({ content: 'You need administrator permissions to add points!', ephemeral: true });
        return;
      }

      const user = interaction.options.get('user')?.user;
      const amount = interaction.options.get('amount')?.value as number;
      const reason = interaction.options.get('reason')?.value as string;

      if (!user || !amount || !reason) {
        await interaction.reply({ content: 'Invalid options provided!', ephemeral: true });
        return;
      }

      const newPoints = await addPoints(user.id, amount, reason);
      const embed = new EmbedBuilder()
        .setTitle('Points Added')
        .setDescription(`${user.tag} now has ${newPoints} points!`)
        .addFields(
          { name: 'Amount', value: amount.toString(), inline: true },
          { name: 'Reason', value: reason, inline: true }
        )
        .setColor('#00ff00');
      await interaction.reply({ embeds: [embed] });
    }
  }
};
