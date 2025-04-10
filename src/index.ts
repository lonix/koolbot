import { Client, GatewayIntentBits, REST, Routes, GuildMember, Role, ApplicationCommandOptionType, ChatInputCommandInteraction, Interaction } from 'discord.js';
import dotenv from 'dotenv';
import axios from 'axios';
import { VCManager } from './services/vc-manager';
import { getVCTime, getLastSeen, initializeDatabase } from './services/database';
import { config } from 'dotenv';
import { logger } from './utils/logger';
import { connectDB, addPoints, getUserPoints } from './utils/database';
import { Command } from './types/command';
import { handleVoiceStateUpdate } from './events/voiceStateUpdate';
import { handleInteractionCreate } from './events/interactionCreate';
import { handleReady } from './events/ready';
import { handleError } from './events/error';
import { handleWarn } from './events/warn';
import { handleDebug } from './events/debug';
import { handleDisconnect } from './events/disconnect';
import { handleReconnecting } from './events/reconnecting';
import { handleInvalidated } from './events/invalidated';
import { handleRateLimit } from './events/rateLimit';
import { handleShardError } from './events/shardError';
import { handleShardReady } from './events/shardReady';
import { handleShardReconnecting } from './events/shardReconnecting';
import { handleShardResume } from './events/shardResume';
import { handleShardDisconnect } from './events/shardDisconnect';
import { handleShardDeath } from './events/shardDeath';
import { handleMessageCreate } from './events/messageCreate';
import { handleMessageDelete } from './events/messageDelete';
import { handleMessageUpdate } from './events/messageUpdate';
import { handleMessageReactionAdd } from './events/messageReactionAdd';
import { handleMessageReactionRemove } from './events/messageReactionRemove';
import { handleMessageReactionRemoveAll } from './events/messageReactionRemoveAll';
import { handleMessageReactionRemoveEmoji } from './events/messageReactionRemoveEmoji';
import { handleChannelCreate } from './events/channelCreate';
import { handleChannelDelete } from './events/channelDelete';
import { handleChannelUpdate } from './events/channelUpdate';
import { handleChannelPinsUpdate } from './events/channelPinsUpdate';
import { handleThreadCreate } from './events/threadCreate';
import { handleThreadDelete } from './events/threadDelete';
import { handleThreadUpdate } from './events/threadUpdate';
import { handleThreadListSync } from './events/threadListSync';
import { handleThreadMemberUpdate } from './events/threadMemberUpdate';
import { handleThreadMembersUpdate } from './events/threadMembersUpdate';
import { handleGuildCreate } from './events/guildCreate';
import { handleGuildDelete } from './events/guildDelete';
import { handleGuildUpdate } from './events/guildUpdate';
import { handleGuildUnavailable } from './events/guildUnavailable';
import { handleGuildMemberAdd } from './events/guildMemberAdd';
import { handleGuildMemberRemove } from './events/guildMemberRemove';
import { handleGuildMemberUpdate } from './events/guildMemberUpdate';
import { handleGuildMemberAvailable } from './events/guildMemberAvailable';
import { handleGuildMembersChunk } from './events/guildMembersChunk';
import { handleGuildIntegrationsUpdate } from './events/guildIntegrationsUpdate';
import { handleGuildRoleCreate } from './events/guildRoleCreate';
import { handleGuildRoleDelete } from './events/guildRoleDelete';
import { handleGuildRoleUpdate } from './events/guildRoleUpdate';
import { handleGuildEmojiCreate } from './events/guildEmojiCreate';
import { handleGuildEmojiDelete } from './events/guildEmojiDelete';
import { handleGuildEmojiUpdate } from './events/guildEmojiUpdate';
import { handleGuildStickersUpdate } from './events/guildStickersUpdate';
import { handleGuildScheduledEventCreate } from './events/guildScheduledEventCreate';
import { handleGuildScheduledEventDelete } from './events/guildScheduledEventDelete';
import { handleGuildScheduledEventUpdate } from './events/guildScheduledEventUpdate';
import { handleGuildScheduledEventUserAdd } from './events/guildScheduledEventUserAdd';
import { handleGuildScheduledEventUserRemove } from './events/guildScheduledEventUserRemove';
import { handleInviteCreate } from './events/inviteCreate';
import { handleInviteDelete } from './events/inviteDelete';
import { handleUserUpdate } from './events/userUpdate';
import { handlePresenceUpdate } from './events/presenceUpdate';
import { handleTypingStart } from './events/typingStart';
import { handleWebhookUpdate } from './events/webhookUpdate';
import { handleVoiceServerUpdate } from './events/voiceServerUpdate';
import { handleStageInstanceCreate } from './events/stageInstanceCreate';
import { handleStageInstanceDelete } from './events/stageInstanceDelete';
import { handleStageInstanceUpdate } from './events/stageInstanceUpdate';
import { handleAutoModerationRuleCreate } from './events/autoModerationRuleCreate';
import { handleAutoModerationRuleDelete } from './events/autoModerationRuleDelete';
import { handleAutoModerationRuleUpdate } from './events/autoModerationRuleUpdate';
import { handleAutoModerationActionExecution } from './events/autoModerationActionExecution';

dotenv.config();

const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent,
    GatewayIntentBits.GuildVoiceStates,
    GatewayIntentBits.GuildMembers,
    GatewayIntentBits.GuildPresences,
    GatewayIntentBits.GuildMessageReactions,
    GatewayIntentBits.DirectMessages,
    GatewayIntentBits.DirectMessageReactions,
    GatewayIntentBits.GuildScheduledEvents,
    GatewayIntentBits.AutoModerationConfiguration,
    GatewayIntentBits.AutoModerationExecution
  ],
});

const vcManager = VCManager.getInstance();

const commands = [
  {
    name: 'ping',
    description: 'Replies with Pong!',
    enabled: process.env.ENABLE_PING === 'true',
  },
  {
    name: 'plexprice',
    description: 'Get the current Jita split price of PLEX',
    enabled: process.env.ENABLE_PLEXPRICE === 'true',
  },
  {
    name: 'amikool',
    description: 'Check if you are cool',
    enabled: process.env.ENABLE_AMIKOOL === 'true',
  },
  {
    name: 'public',
    description: 'Make your voice channel public',
    enabled: process.env.ENABLE_VC_MANAGEMENT === 'true',
  },
  {
    name: 'private',
    description: 'Make your voice channel private',
    enabled: process.env.ENABLE_VC_MANAGEMENT === 'true',
  },
  {
    name: 'ban',
    description: 'Ban a user from your voice channel',
    enabled: process.env.ENABLE_VC_MANAGEMENT === 'true',
    options: [
      {
        name: 'user',
        description: 'The user to ban',
        type: ApplicationCommandOptionType.User,
        required: true,
      },
    ],
  },
  {
    name: 'vctime',
    description: 'Check voice chat time for a user',
    enabled: process.env.ENABLE_VC_TRACKING === 'true',
    options: [
      {
        name: 'user',
        description: 'The user to check',
        type: ApplicationCommandOptionType.User,
        required: true,
      },
      {
        name: 'period',
        description: 'Time period to check',
        type: ApplicationCommandOptionType.String,
        required: false,
        choices: [
          { name: 'Today', value: 'today' },
          { name: 'Week', value: 'week' },
          { name: 'Month', value: 'month' },
          { name: 'All Time', value: 'alltime' },
        ],
      },
    ],
  },
  {
    name: 'seen',
    description: 'Check when a user was last in voice chat',
    enabled: process.env.ENABLE_VC_TRACKING === 'true',
    options: [
      {
        name: 'user',
        description: 'The user to check',
        type: ApplicationCommandOptionType.User,
        required: true,
      },
    ],
  },
];

// Filter enabled commands
const enabledCommands = commands.filter(cmd => cmd.enabled);

const rest = new REST({ version: '10' }).setToken(process.env.DISCORD_TOKEN!);

client.once('ready', async () => {
  console.log('Koolbot is ready!');
  console.log('Bot user:', client.user?.tag);
  console.log('Enabled features:', enabledCommands.map(cmd => cmd.name).join(', '));

  // Initialize database
  await initializeDatabase();

  try {
    // Get the first guild the bot is in
    const guild = client.guilds.cache.first();
    if (!guild) {
      console.error('Bot is not in any guilds!');
      return;
    }

    console.log(`Registering commands for guild: ${guild.name} (${guild.id})`);

    // Clean up existing commands first
    console.log('Cleaning up existing commands...');
    const existingCommands = await rest.get(Routes.applicationGuildCommands(process.env.CLIENT_ID!, guild.id));
    console.log('Existing commands:', JSON.stringify(existingCommands, null, 2));

    if (Array.isArray(existingCommands)) {
      for (const command of existingCommands) {
        console.log(`Deleting command: ${command.name} (${command.id})`);
        await rest.delete(Routes.applicationGuildCommand(process.env.CLIENT_ID!, guild.id, command.id));
      }
    }
    console.log('Successfully cleaned up existing commands.');

    // Register new commands
    console.log('Started refreshing application (/) commands...');
    console.log('Commands to register:', JSON.stringify(enabledCommands, null, 2));

    const data = await rest.put(
      Routes.applicationGuildCommands(process.env.CLIENT_ID!, guild.id),
      { body: enabledCommands },
    ) as any[];

    console.log('Successfully reloaded application (/) commands.');
    console.log('Registered commands:', JSON.stringify(data.map(cmd => ({ name: cmd.name, id: cmd.id })), null, 2));
  } catch (error) {
    console.error('Error during command registration:', error);
    if (error instanceof Error) {
      console.error('Error details:', {
        message: error.message,
        stack: error.stack,
      });
    }
  }
});

client.on('voiceStateUpdate', async (oldState, newState) => {
  if (process.env.ENABLE_VC_MANAGEMENT === 'true') {
    await vcManager.handleVoiceStateUpdate(oldState, newState);
  }
});

client.on('interactionCreate', async (interaction: Interaction) => {
  if (!interaction.isChatInputCommand()) return;

  const { commandName, user } = interaction;

  if (process.env.DEBUG === 'true') {
    console.log(`Command received: ${commandName} from user ${user.tag} (${user.id})`);
  }

  // Check if command is enabled
  const command = commands.find(cmd => cmd.name === commandName);
  if (!command?.enabled) {
    await interaction.reply('This command is currently disabled.');
    return;
  }

  switch (commandName) {
    case 'ping':
      await interaction.reply('Pong!');
      break;

    case 'plexprice':
      try {
        const response = await axios.get('https://esi.evetech.net/latest/markets/10000002/orders/?datasource=tranquility&order_type=all&page=1&type_id=44992');
        const orders = response.data;
        const sellOrders = orders.filter((order: any) => order.is_buy_order === false);
        const lowestPrice = Math.min(...sellOrders.map((order: any) => order.price));
        await interaction.reply(`Current Jita PLEX price: ${lowestPrice.toLocaleString()} ISK`);
      } catch (error) {
        console.error('Error fetching PLEX price:', error);
        await interaction.reply('Sorry, I couldn\'t fetch the PLEX price right now.');
      }
      break;

    case 'amikool':
      if (interaction.member instanceof GuildMember) {
        const coolRoleName = process.env.COOL_ROLE_NAME || 'Kool Kids';
        const hasCoolRole = interaction.member.roles.cache.some((role: Role) => role.name === coolRoleName);
        const coolResponses = [
          'Hell yes!',
          'Yea buddy!',
          'Absolutely!',
          'You\'re the coolest!',
          '100% certified cool!'
        ];
        const notCoolResponses = [
          'Fuck no!',
          'Not even close!',
          'Try harder!',
          'Maybe next time!',
          'Not cool enough!'
        ];

        const response = hasCoolRole
          ? coolResponses[Math.floor(Math.random() * coolResponses.length)]
          : notCoolResponses[Math.floor(Math.random() * notCoolResponses.length)];

        await interaction.reply(response);
      } else {
        await interaction.reply('I can\'t check your coolness status right now.');
      }
      break;

    case 'public':
    case 'private':
    case 'ban':
      await vcManager.handleCommand(interaction);
      break;

    case 'vctime': {
      const targetUser = interaction.options.getUser('user', true);
      const period = (interaction.options.getString('period') || 'alltime') as 'today' | 'week' | 'month' | 'alltime';
      const time = await getVCTime(targetUser.id, interaction.guildId!, period);
      const hours = Math.floor(time / (1000 * 60 * 60));
      const minutes = Math.floor((time % (1000 * 60 * 60)) / (1000 * 60));

      await interaction.reply(
        `${targetUser.username}'s voice chat time (${period}): ${hours}h ${minutes}m`
      );
      break;
    }

    case 'seen': {
      const user = interaction.options.getUser('user', true);
      const lastSeen = await getLastSeen(user.id, interaction.guildId!);

      if (lastSeen) {
        const date = new Date(lastSeen);
        await interaction.reply(`${user.username} was last seen in voice chat on ${date.toLocaleString()}`);
      } else {
        await interaction.reply(`${user.username} hasn't been seen in voice chat yet.`);
      }
      break;
    }
  }
});

// Connect to MongoDB
connectDB().catch((error) => {
  logger.error('Failed to connect to MongoDB:', error);
  process.exit(1);
});

// Event handlers
client.on('ready', handleReady);
client.on('interactionCreate', handleInteractionCreate);
client.on('voiceStateUpdate', handleVoiceStateUpdate);
client.on('error', handleError);
client.on('warn', handleWarn);
client.on('debug', handleDebug);
client.on('disconnect', handleDisconnect);
client.on('reconnecting', handleReconnecting);
client.on('invalidated', handleInvalidated);
client.on('rateLimit', handleRateLimit);
client.on('shardError', handleShardError);
client.on('shardReady', handleShardReady);
client.on('shardReconnecting', handleShardReconnecting);
client.on('shardResume', handleShardResume);
client.on('shardDisconnect', handleShardDisconnect);
client.on('shardDeath', handleShardDeath);
client.on('messageCreate', handleMessageCreate);
client.on('messageDelete', handleMessageDelete);
client.on('messageUpdate', handleMessageUpdate);
client.on('messageReactionAdd', handleMessageReactionAdd);
client.on('messageReactionRemove', handleMessageReactionRemove);
client.on('messageReactionRemoveAll', handleMessageReactionRemoveAll);
client.on('messageReactionRemoveEmoji', handleMessageReactionRemoveEmoji);
client.on('channelCreate', handleChannelCreate);
client.on('channelDelete', handleChannelDelete);
client.on('channelUpdate', handleChannelUpdate);
client.on('channelPinsUpdate', handleChannelPinsUpdate);
client.on('threadCreate', handleThreadCreate);
client.on('threadDelete', handleThreadDelete);
client.on('threadUpdate', handleThreadUpdate);
client.on('threadListSync', handleThreadListSync);
client.on('threadMemberUpdate', handleThreadMemberUpdate);
client.on('threadMembersUpdate', handleThreadMembersUpdate);
client.on('guildCreate', handleGuildCreate);
client.on('guildDelete', handleGuildDelete);
client.on('guildUpdate', handleGuildUpdate);
client.on('guildUnavailable', handleGuildUnavailable);
client.on('guildMemberAdd', handleGuildMemberAdd);
client.on('guildMemberRemove', handleGuildMemberRemove);
client.on('guildMemberUpdate', handleGuildMemberUpdate);
client.on('guildMemberAvailable', handleGuildMemberAvailable);
client.on('guildMembersChunk', handleGuildMembersChunk);
client.on('guildIntegrationsUpdate', handleGuildIntegrationsUpdate);
client.on('guildRoleCreate', handleGuildRoleCreate);
client.on('guildRoleDelete', handleGuildRoleDelete);
client.on('guildRoleUpdate', handleGuildRoleUpdate);
client.on('guildEmojiCreate', handleGuildEmojiCreate);
client.on('guildEmojiDelete', handleGuildEmojiDelete);
client.on('guildEmojiUpdate', handleGuildEmojiUpdate);
client.on('guildStickersUpdate', handleGuildStickersUpdate);
client.on('guildScheduledEventCreate', handleGuildScheduledEventCreate);
client.on('guildScheduledEventDelete', handleGuildScheduledEventDelete);
client.on('guildScheduledEventUpdate', handleGuildScheduledEventUpdate);
client.on('guildScheduledEventUserAdd', handleGuildScheduledEventUserAdd);
client.on('guildScheduledEventUserRemove', handleGuildScheduledEventUserRemove);
client.on('inviteCreate', handleInviteCreate);
client.on('inviteDelete', handleInviteDelete);
client.on('userUpdate', handleUserUpdate);
client.on('presenceUpdate', handlePresenceUpdate);
client.on('typingStart', handleTypingStart);
client.on('webhookUpdate', handleWebhookUpdate);
client.on('voiceServerUpdate', handleVoiceServerUpdate);
client.on('stageInstanceCreate', handleStageInstanceCreate);
client.on('stageInstanceDelete', handleStageInstanceDelete);
client.on('stageInstanceUpdate', handleStageInstanceUpdate);
client.on('autoModerationRuleCreate', handleAutoModerationRuleCreate);
client.on('autoModerationRuleDelete', handleAutoModerationRuleDelete);
client.on('autoModerationRuleUpdate', handleAutoModerationRuleUpdate);
client.on('autoModerationActionExecution', handleAutoModerationActionExecution);

client.login(process.env.DISCORD_TOKEN);
