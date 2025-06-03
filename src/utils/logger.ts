import winston from "winston";
import { ConfigService } from "../services/config-service.js";

const configService = ConfigService.getInstance();

class Logger {
  private static instance: Logger;
  private logger: winston.Logger;
  private logChannel: any = null;

  private constructor() {
    this.logger = winston.createLogger({
      level: "info",
      format: winston.format.combine(
        winston.format.timestamp(),
        winston.format.json()
      ),
      transports: [
        new winston.transports.Console({
          format: winston.format.combine(
            winston.format.colorize(),
            winston.format.simple()
          ),
        }),
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

  public setLogChannel(channel: any): void {
    this.logChannel = channel;
  }

  private async updateLogLevel(): Promise<void> {
    const isDebug = await configService.get("DEBUG", false);
    this.logger.level = isDebug ? "debug" : "info";
  }

  public async info(message: string, meta?: any): Promise<void> {
    await this.updateLogLevel();
    this.logger.info(message, meta);
    if (this.logChannel) {
      const isDebug = await configService.get("DEBUG", false);
      if (isDebug) {
        await this.logChannel.send(`[INFO] ${message}`);
      }
    }
  }

  public async error(message: string, meta?: any): Promise<void> {
    await this.updateLogLevel();
    this.logger.error(message, meta);
    if (this.logChannel) {
      await this.logChannel.send(`[ERROR] ${message}`);
    }
  }

  public async debug(message: string, meta?: any): Promise<void> {
    await this.updateLogLevel();
    this.logger.debug(message, meta);
    if (this.logChannel) {
      const isDebug = await configService.get("DEBUG", false);
      if (isDebug) {
        await this.logChannel.send(`[DEBUG] ${message}`);
      }
    }
  }

  public async warn(message: string, meta?: any): Promise<void> {
    await this.updateLogLevel();
    this.logger.warn(message, meta);
    if (this.logChannel) {
      await this.logChannel.send(`[WARN] ${message}`);
    }
  }
}

export default Logger;
