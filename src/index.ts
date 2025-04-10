import { Client, GatewayIntentBits, REST, Routes, GuildMember, Role } from 'discord.js';
import dotenv from 'dotenv';
import axios from 'axios';

dotenv.config();

const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent,
  ],
});

const commands = [
  {
    name: 'ping',
    description: 'Replies with Pong!',
  },
  {
    name: 'plexprice',
    description: 'Get the current Jita split price of PLEX',
  },
  {
    name: 'amikool',
    description: 'Check if you are cool',
  },
];

const rest = new REST({ version: '10' }).setToken(process.env.DISCORD_TOKEN!);

client.once('ready', async () => {
  console.log('Koolbot is ready!');

  try {
    // Clean up existing commands first
    console.log('Cleaning up existing commands...');
    const existingCommands = await rest.get(Routes.applicationCommands(process.env.CLIENT_ID!));
    if (Array.isArray(existingCommands)) {
      for (const command of existingCommands) {
        await rest.delete(Routes.applicationCommand(process.env.CLIENT_ID!, command.id));
      }
    }
    console.log('Successfully cleaned up existing commands.');

    // Register new commands
    console.log('Started refreshing application (/) commands.');
    await rest.put(
      Routes.applicationCommands(process.env.CLIENT_ID!),
      { body: commands },
    );
    console.log('Successfully reloaded application (/) commands.');
  } catch (error) {
    console.error('Error during command registration:', error);
  }
});

client.on('interactionCreate', async (interaction) => {
  if (!interaction.isCommand()) return;

  const { commandName, user } = interaction;

  if (process.env.DEBUG === 'true') {
    console.log(`Command received: ${commandName} from user ${user.tag} (${user.id})`);
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
  }
});

client.login(process.env.DISCORD_TOKEN);
