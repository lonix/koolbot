import { Client, Collection, GatewayIntentBits, Partials } from 'discord.js';
import { config } from 'dotenv';
import { Command } from './types/Command';
import { Event } from './types/Event';
import { PrismaClient } from '@prisma/client';

// Load environment variables
config();

// Extend Discord.js Client with custom properties
class KoolBot extends Client {
    public commands: Collection<string, Command>;
    public events: Collection<string, Event>;
    public db: PrismaClient;

    constructor() {
        super({
            intents: [
                GatewayIntentBits.Guilds,
                GatewayIntentBits.GuildMessages,
                GatewayIntentBits.MessageContent,
                GatewayIntentBits.GuildMembers,
                GatewayIntentBits.GuildVoiceStates
            ],
            partials: [Partials.Message, Partials.Channel, Partials.GuildMember, Partials.User]
        });

        this.commands = new Collection();
        this.events = new Collection();
        this.db = new PrismaClient();
    }

    async start() {
        try {
            // Load commands
            await this.loadCommands();

            // Load events
            await this.loadEvents();

            // Connect to database
            await this.db.$connect();

            // Login to Discord
            await this.login(process.env.DISCORD_TOKEN);

            console.log('Bot is ready!');
        } catch (error) {
            console.error('Error starting bot:', error);
            process.exit(1);
        }
    }

    private async loadCommands() {
        // Command loading logic will go here
    }

    private async loadEvents() {
        // Event loading logic will go here
    }
}

// Create and start the bot
const bot = new KoolBot();
bot.start();
