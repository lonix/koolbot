import winston from "winston";
import { TextChannel, Client } from "discord.js";

class Logger {
  private static instance: Logger;
  private logger: winston.Logger;
  private logChannel: TextChannel | null = null;

  private constructor() {
    this.logger = winston.createLogger({
      level: process.env.DEBUG === "true" ? "debug" : "info",
      format: winston.format.combine(
        winston.format.timestamp(),
        winston.format.printf(({ level, message, timestamp }) => {
          return `${timestamp} [${level}]: ${message}`;
        }),
      ),
      transports: [
        new winston.transports.Console(),
        new winston.transports.File({ filename: "error.log", level: "error" }),
        new winston.transports.File({ filename: "combined.log" }),
      ],
    });
  }

  public static getInstance(): Logger {
    if (!Logger.instance) {
      Logger.instance = new Logger();
    }
    return Logger.instance;
  }

  public async setLogChannel(client: Client, channelId: string): Promise<void> {
    try {
      const channel = await client.channels.fetch(channelId);
      if (channel instanceof TextChannel) {
        this.logChannel = channel;
        this.info("Log channel set successfully");
      }
    } catch (error) {
      this.error("Failed to set log channel:", error);
    }
  }

  public info(message: string, ...args: unknown[]): void {
    this.logger.info(message, ...args);
    if (this.logChannel) {
      this.logChannel.send(`[INFO] ${message}`).catch((error) => {
        this.logger.error("Failed to send log to Discord:", error);
      });
    }
  }

  public error(message: string, ...args: unknown[]): void {
    this.logger.error(message, ...args);
    if (this.logChannel) {
      this.logChannel.send(`[ERROR] ${message}`).catch((error) => {
        this.logger.error("Failed to send log to Discord:", error);
      });
    }
  }

  public debug(message: string, ...args: unknown[]): void {
    this.logger.debug(message, ...args);
  }
}

export { Logger };
