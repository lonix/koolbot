import winston from "winston";
import { config as dotenvConfig } from "dotenv";

dotenvConfig();

const isDebug = process.env.DEBUG === "true";

const logger = winston.createLogger({
  level: isDebug ? "debug" : "info",
  format: winston.format.combine(
    winston.format.timestamp(),
    winston.format.errors({ stack: true }), // Properly serialize error objects
    winston.format.printf(({ timestamp, level, message, stack, ...meta }) => {
      let log = `${timestamp} [${level.toUpperCase()}]: ${message}`;

      // Append stack trace if available
      if (stack) {
        log += `\n${stack}`;
      }

      // Append any additional metadata
      const metaKeys = Object.keys(meta).filter(
        (key) => !["timestamp", "level", "message", "stack"].includes(key),
      );
      if (metaKeys.length > 0) {
        log += `\n${JSON.stringify(meta, null, 2)}`;
      }

      return log;
    }),
  ),
  transports: [new winston.transports.Console()],
});

export default logger;
