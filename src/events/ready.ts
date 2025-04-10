import { Client } from 'discord.js';
import { Event } from '../types/Event';

export const ready: Event<'ready'> = {
    name: 'ready',
    once: true,
    async execute(client: Client) {
        console.log(`Ready! Logged in as ${client.user?.tag}`);

        // Register slash commands
        try {
            const commands = client.commands.map(cmd => cmd.data.toJSON());
            await client.application?.commands.set(commands);
            console.log('Successfully registered application commands.');
        } catch (error) {
            console.error('Error registering commands:', error);
        }
    }
};
