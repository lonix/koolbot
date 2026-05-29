/**
 * Centralised access to the process environment / bootstrap variables.
 *
 * This is the ONLY module in `src/` that is allowed to read from
 * `process.env`. Everything else imports from here so that:
 *
 *   1. Env vars are read and (where applicable) defaulted in one place,
 *      removing duplicated fallback logic scattered across call sites.
 *   2. Required vars can be validated up-front with an informative error
 *      (see `requireEnv` / `getMissingRequiredEnv`) instead of failing
 *      deep inside application logic with a silent `undefined`.
 *   3. Tests can inject configuration by mocking this module rather than
 *      monkeypatching `process.env`.
 *
 * The accessors are intentionally lazy getters rather than values frozen
 * at import time: a handful of consumers (and their tests) mutate the
 * environment after startup and expect the latest value to be read.
 */
import { config as dotenvConfig } from "dotenv";

// Load `.env` as early as the first consumer imports this module so that
// every other module observes a populated `process.env`.
dotenvConfig();

/**
 * Read a single env var by name. The only sanctioned dynamic accessor for
 * keys that aren't known at compile time (e.g. config-key lookups).
 */
export function getEnv(key: string): string | undefined {
  return process.env[key];
}

/** True when the env var is defined (even if empty). */
export function hasEnv(key: string): boolean {
  return process.env[key] !== undefined;
}

/**
 * Read a required env var, throwing an informative error when it is absent
 * or empty. Use for fail-fast startup paths and one-shot CLI scripts.
 */
export function requireEnv(key: string): string {
  const value = process.env[key];
  if (!value) {
    throw new Error(`Missing required environment variable: ${key}`);
  }
  return value;
}

/**
 * Env vars the bot cannot start without. `getMissingRequiredEnv` reports
 * which (if any) are absent so the caller can emit one clear error.
 */
export const REQUIRED_VARS = [
  "DISCORD_TOKEN",
  "CLIENT_ID",
  "GUILD_ID",
  "MONGODB_URI",
] as const;

/** Returns the names of any required env vars that are missing or empty. */
export function getMissingRequiredEnv(): string[] {
  return REQUIRED_VARS.filter((key) => !process.env[key]);
}

const DEFAULT_MONGODB_URI = "mongodb://mongodb:27017/koolbot";

/**
 * Typed, defaulted view over the known environment variables. Getters read
 * `process.env` lazily on each access (see module note above).
 */
export const env = Object.freeze({
  get discordToken(): string | undefined {
    return process.env.DISCORD_TOKEN;
  },
  get clientId(): string | undefined {
    return process.env.CLIENT_ID;
  },
  get guildId(): string | undefined {
    return process.env.GUILD_ID;
  },
  get mongoUri(): string {
    return process.env.MONGODB_URI || DEFAULT_MONGODB_URI;
  },
  get nodeEnv(): string {
    return process.env.NODE_ENV || "development";
  },
  get debug(): boolean {
    return process.env.DEBUG === "true";
  },
  get isProduction(): boolean {
    return process.env.NODE_ENV === "production";
  },
  webui: Object.freeze({
    get enabled(): boolean {
      return (process.env.WEBUI_ENABLED || "").toLowerCase() === "true";
    },
    get baseUrl(): string {
      return process.env.WEBUI_BASE_URL ?? "";
    },
    get sessionSecret(): string | undefined {
      return process.env.WEBUI_SESSION_SECRET;
    },
    get sessionTtlMinutes(): string | undefined {
      return process.env.WEBUI_SESSION_TTL_MINUTES;
    },
    get sessionLifetimeHours(): string | undefined {
      return process.env.WEBUI_SESSION_LIFETIME_HOURS;
    },
    get inactivityTimeoutMinutes(): string | undefined {
      return process.env.WEBUI_INACTIVITY_TIMEOUT_MINUTES;
    },
    get trustProxy(): string | undefined {
      return process.env.WEBUI_TRUST_PROXY;
    },
  }),
});
