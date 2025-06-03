import winston from "winston";
import { config as dotenvConfig } from "dotenv";

dotenvConfig();

const isDebug = process.env.DEBUG === "true";

const logger = winston.createLogger({
  level: isDebug ? "debug" : "info",
  format: winston.format.combine(
    winston.format.timestamp(),
    winston.format.printf(({ timestamp, level, message }) => {
      return `${timestamp} [${level.toUpperCase()}]: ${message}`;
    }),
  ),
  transports: [new winston.transports.Console()],
});

export default logger;
