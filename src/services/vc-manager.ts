import { VoiceChannel, Guild, GuildMember, TextChannel, ChannelType, PermissionsBitField } from 'discord.js';
import { startVCSession, endVCSession } from './database';

export class VCManager {
  private static instance: VCManager;
  private userChannels: Map<string, VoiceChannel> = new Map();
  private channelTextChannels: Map<string, TextChannel> = new Map();

  private constructor() {}

  public static getInstance(): VCManager {
    if (!VCManager.instance) {
      VCManager.instance = new VCManager();
    }
    return VCManager.instance;
  }

  public async handleVoiceStateUpdate(oldState: any, newState: any) {
    const member = newState.member;
    const guild = member.guild;
    const lobbyChannel = guild.channels.cache.find(
      (channel) => channel.name === process.env.LOBBY_CHANNEL_NAME
    ) as VoiceChannel;

    if (!lobbyChannel) return;

    // User joined lobby
    if (newState.channelId === lobbyChannel.id) {
      await this.createUserChannel(member, guild);
    }
    // User left their channel
    else if (oldState.channelId && this.userChannels.has(oldState.channelId)) {
      const channel = this.userChannels.get(oldState.channelId);
      if (channel && channel.members.size === 0) {
        await this.deleteUserChannel(channel);
      }
    }
  }

  private async createUserChannel(member: GuildMember, guild: Guild) {
    const category = guild.channels.cache.find(
      (channel) => channel.name === process.env.VC_CATEGORY_NAME
    ) || await guild.channels.create({
      name: process.env.VC_CATEGORY_NAME!,
      type: ChannelType.GuildCategory,
    });

    const channelName = `${process.env.VC_PREFIX} ${member.displayName}`;
    const channel = await guild.channels.create({
      name: channelName,
      type: ChannelType.GuildVoice,
      parent: category.id,
      permissionOverwrites: [
        {
          id: member.id,
          allow: [
            PermissionsBitField.Flags.ManageChannels,
            PermissionsBitField.Flags.MuteMembers,
            PermissionsBitField.Flags.DeafenMembers,
            PermissionsBitField.Flags.MoveMembers,
          ],
        },
      ],
    });

    // Create associated text channel
    const textChannel = await guild.channels.create({
      name: channelName.toLowerCase().replace(/\s+/g, '-'),
      type: ChannelType.GuildText,
      parent: category.id,
      permissionOverwrites: [
        {
          id: member.id,
          allow: [
            PermissionsBitField.Flags.ManageChannels,
            PermissionsBitField.Flags.ManageMessages,
          ],
        },
      ],
    });

    this.userChannels.set(channel.id, channel);
    this.channelTextChannels.set(channel.id, textChannel);

    // Move user to their new channel
    await member.voice.setChannel(channel);

    // Start tracking VC time
    await startVCSession(member.id, guild.id, channel.id);
  }

  private async deleteUserChannel(channel: VoiceChannel) {
    const textChannel = this.channelTextChannels.get(channel.id);
    if (textChannel) {
      await textChannel.delete();
      this.channelTextChannels.delete(channel.id);
    }

    await channel.delete();
    this.userChannels.delete(channel.id);
  }

  public async handleCommand(interaction: any) {
    if (!interaction.isCommand()) return;

    const { commandName, member } = interaction;
    const channel = member.voice.channel;

    if (!channel || !this.userChannels.has(channel.id)) {
      await interaction.reply('You must be in your own voice channel to use this command.');
      return;
    }

    switch (commandName) {
      case 'public':
        await channel.permissionOverwrites.create(channel.guild.roles.everyone, {
          ViewChannel: true,
          Connect: true,
        });
        await interaction.reply('Channel is now public!');
        break;

      case 'private':
        await channel.permissionOverwrites.create(channel.guild.roles.everyone, {
          ViewChannel: true,
          Connect: false,
        });
        await interaction.reply('Channel is now private!');
        break;

      case 'ban':
        const user = interaction.options.getUser('user');
        if (user) {
          await channel.permissionOverwrites.create(user, {
            ViewChannel: false,
            Connect: false,
          });
          await interaction.reply(`${user.tag} has been banned from this channel.`);
        }
        break;
    }
  }
}
