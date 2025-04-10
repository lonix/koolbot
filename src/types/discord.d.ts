import { Client, Collection } from 'discord.js';
import { Command } from './command';

declare module 'discord.js' {
  interface Client {
    commands: Collection<string, Command>;
  }
}
