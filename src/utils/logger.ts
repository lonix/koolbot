import winston from 'winston';
import { Client, TextChannel } from 'discord.js';

const { createLogger, format, transports } = winston;
const { combine, timestamp, printf } = format;

const logFormat = printf(({ level, message, timestamp }) => {
  return `${timestamp} [${level}]: ${message}`;
});

export class Logger {
  private static instance: Logger;
  private logger: winston.Logger;
  private logChannel: TextChannel | null = null;

  private constructor() {
    this.logger = createLogger({
      format: combine(
        timestamp(),
        logFormat
      ),
      transports: [
        new transports.Console({
          level: process.env.DEBUG === 'true' ? 'debug' : 'info'
        })
      ]
    });
  }

  public static getInstance(): Logger {
    if (!Logger.instance) {
      Logger.instance = new Logger();
    }
    return Logger.instance;
  }

  public async setLogChannel(client: Client, channelId: string) {
    try {
      const channel = await client.channels.fetch(channelId);
      if (channel instanceof TextChannel) {
        this.logChannel = channel;
      }
    } catch (error) {
      this.error('Failed to set log channel:', error);
    }
  }

  public info(message: string) {
    this.logger.info(message);
    this.sendToDiscord('INFO', message);
  }

  public error(message: string, error?: any) {
    this.logger.error(message, error);
    this.sendToDiscord('ERROR', `${message} ${error ? JSON.stringify(error) : ''}`);
  }

  public debug(message: string) {
    if (process.env.DEBUG === 'true') {
      this.logger.debug(message);
      this.sendToDiscord('DEBUG', message);
    }
  }

  private async sendToDiscord(level: string, message: string) {
    if (this.logChannel) {
      try {
        await this.logChannel.send(`[${level}] ${message}`);
      } catch (error) {
        this.logger.error('Failed to send log to Discord:', error);
      }
    }
  }
}
