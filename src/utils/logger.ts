import winston from "winston";
import { env } from "../config/env.js";

/**
 * Fields a discord.js `DiscordAPIError` carries that can hold request payloads
 * (DM bodies, including one-time sign-in links). Dropped from every record so
 * passing such an error as meta can never write them to the log (#1152).
 */
const SENSITIVE_META_KEYS = ["requestBody", "rawError"];

const redactRequestPayloads = winston.format((info) => {
  for (const key of SENSITIVE_META_KEYS) {
    if (key in info) delete (info as Record<string, unknown>)[key];
  }
  return info;
});

export const isDebugMode = (): boolean => env.debug;

const logger = winston.createLogger({
  level: isDebugMode() ? "debug" : "info",
  format: winston.format.combine(
    winston.format.timestamp(),
    winston.format.errors({ stack: true }), // Properly serialize error objects
    redactRequestPayloads(),
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
