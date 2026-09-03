/**
 * `npm run validate-config` — read-only pre-flight check of a deployment's
 * configuration.
 *
 * The list of settings checked here is **derived from `config-schema.ts`**
 * (`defaultConfig` + `settingsMetadata`) rather than hand-maintained in this
 * file. An earlier version carried its own copy of the key names and their
 * defaults; the schema was renamed underneath it (`voice_channel.*` →
 * `voicechannels.*`, `tracking.*` → `voicetracking.*`) and the copy was never
 * updated, so every one of those keys resolved to nothing and the script
 * always reported "using default" — it could not surface a real
 * misconfiguration, and the defaults it printed were wrong (#858). Deriving
 * the list means a schema rename either flows through automatically or fails
 * the TypeScript build.
 *
 * What it reports:
 *   - required environment variables that are missing (error);
 *   - stored values whose type can't be read as the schema's type (error);
 *   - values outside a setting's fixed option list (error);
 *   - an enabled feature whose hard `dependsOn` prerequisite is off (error);
 *   - an enabled feature missing the id it needs to do anything (warning);
 *   - Discord id settings holding something that isn't a snowflake (warning);
 *   - numeric settings below their `warnBelow` recommendation (warning).
 *
 * Exit code is 1 when any error is reported, so the script can gate a deploy.
 * The script never writes to the database.
 */
import mongoose from "mongoose";
import { Config } from "../models/config.js";
import {
  env,
  getEnv,
  getEnvConfigValue,
  getMissingRequiredEnv,
  REQUIRED_VARS,
} from "../config/env.js";
import {
  defaultConfig,
  settingsMetadata,
  getDependencies,
  isEnabledValue,
  type ConfigSchema,
  type SettingType,
} from "../services/config-schema.js";
import { sanitizeForLog } from "../utils/log-sanitize.js";
import logger from "../utils/logger.js";

export type Severity = "ok" | "default" | "warning" | "error";

export interface Finding {
  key: string;
  severity: Severity;
  message: string;
}

/** Every key declared in the config schema, in declaration order. */
export function schemaKeys(): (keyof ConfigSchema)[] {
  return Object.keys(defaultConfig) as (keyof ConfigSchema)[];
}

/**
 * Env vars whose value must never be echoed to the logs. Everything else
 * (guild/client ids) is safe to print and useful when eyeballing output.
 */
const SECRET_ENV_VARS = new Set<string>(["DISCORD_TOKEN", "MONGODB_URI"]);

/**
 * Human-readable description per required env var. Typed against
 * `REQUIRED_VARS` so adding a required variable fails the build until it is
 * described here.
 */
const ENV_DESCRIPTIONS: Record<(typeof REQUIRED_VARS)[number], string> = {
  DISCORD_TOKEN: "Discord bot token",
  CLIENT_ID: "Discord application/client ID",
  GUILD_ID: "Discord guild/server ID",
  MONGODB_URI: "MongoDB connection URI",
};

/**
 * The primitive a stored value must be readable as, per schema setting type.
 * The Discord-specific and `cron` types are all strings on the wire.
 */
export function expectedPrimitive(
  type: SettingType,
): "boolean" | "number" | "string" {
  switch (type) {
    case "boolean":
      return "boolean";
    case "number":
      return "number";
    default:
      return "string";
  }
}

/** Setting types whose value is one or more Discord snowflake ids. */
const ID_TYPES = new Set<SettingType>([
  "channel",
  "category",
  "role",
  "channel_list",
  "role_list",
]);

const SNOWFLAKE = /^\d{17,20}$/;

/**
 * Can the runtime read `value` as `expected`? Mirrors the coercions
 * `ConfigService.getBoolean` / `getNumber` / `getString` actually perform, so
 * a value the bot reads fine is never reported as an error.
 */
function readableAs(
  value: unknown,
  expected: "boolean" | "number" | "string",
): boolean {
  switch (expected) {
    case "boolean":
      return (
        typeof value === "boolean" || value === "true" || value === "false"
      );
    case "number":
      if (typeof value === "number") return Number.isFinite(value);
      if (typeof value === "boolean") return true;
      return (
        typeof value === "string" &&
        value.trim() !== "" &&
        !Number.isNaN(Number(value))
      );
    case "string":
      // getString() stringifies numbers and booleans, so any primitive reads.
      return (
        typeof value === "string" ||
        typeof value === "number" ||
        typeof value === "boolean"
      );
  }
}

/** Render a value for the log: sanitized, with blank values made visible. */
export function formatValue(value: unknown): string {
  if (value === null || value === undefined) return "(unset)";
  if (value === "") return "(empty)";
  return sanitizeForLog(value);
}

/**
 * Ids a feature cannot run without. The runtime logs a warning and skips the
 * feature when the gate is on but the id is blank (see e.g.
 * `quote-channel-manager.ts`, `event-service.ts`), so this reports the same
 * situation before the bot is started. Typed against `ConfigSchema`: a
 * renamed key breaks the build instead of silently checking nothing.
 */
export const REQUIRED_WHEN_ENABLED: ReadonlyArray<{
  gate: keyof ConfigSchema;
  key: keyof ConfigSchema;
  consequence: string;
}> = [
  {
    gate: "voicechannels.enabled",
    key: "voicechannels.category_id",
    consequence: "no category to create managed voice channels in",
  },
  {
    gate: "voicetracking.announcements.enabled",
    key: "voicetracking.announcements.channel_id",
    consequence: "the scheduled recap has nowhere to post",
  },
  {
    gate: "quotes.enabled",
    key: "quotes.channel_id",
    consequence: "the quote channel is not managed",
  },
  {
    gate: "notices.enabled",
    key: "notices.channel_id",
    consequence: "the notices channel is not managed",
  },
  {
    gate: "reactionroles.enabled",
    key: "reactionroles.message_channel_id",
    consequence: "reaction-role messages have nowhere to post",
  },
  {
    gate: "leaderboard_roles.enabled",
    key: "leaderboard_roles.tiers",
    consequence: "no tiers are defined, so no roles are ever assigned",
  },
  {
    gate: "celebrations.enabled",
    key: "celebrations.channel_id",
    consequence: "milestone shout-outs have nowhere to post",
  },
  {
    gate: "birthdays.enabled",
    key: "birthdays.channel_id",
    consequence: "birthday announcements have nowhere to post",
  },
  {
    gate: "events.enabled",
    key: "events.category_id",
    consequence: "no category to create temporary event channels in",
  },
  {
    gate: "events.enabled",
    key: "events.announcement_channel_id",
    consequence: "RSVP and reminder messages have nowhere to post",
  },
];

/** Findings for the environment variables the bot cannot start without. */
export function buildEnvFindings(missing: readonly string[]): Finding[] {
  return REQUIRED_VARS.map((key) => {
    const description = ENV_DESCRIPTIONS[key];
    if (missing.includes(key)) {
      return {
        key,
        severity: "error" as const,
        message: `${key}: missing required environment variable — ${description}`,
      };
    }
    const shown = SECRET_ENV_VARS.has(key)
      ? "set (value hidden)"
      : formatValue(getEnv(key));
    return {
      key,
      severity: "ok" as const,
      message: `${key}: ${shown} (${description})`,
    };
  });
}

/**
 * Validate one schema-declared setting. `value` is what is stored (in the DB
 * or an env var); `null`/`undefined` means nothing is stored and the schema
 * default applies.
 */
export function validateSetting(
  key: keyof ConfigSchema,
  value: unknown,
): Finding {
  const meta = settingsMetadata[key];
  const label = meta.label;

  if (value === null || value === undefined) {
    return {
      key,
      severity: "default",
      message: `${key}: not set — using default ${formatValue(
        defaultConfig[key],
      )} (${label})`,
    };
  }

  const expected = expectedPrimitive(meta.type);
  if (!readableAs(value, expected)) {
    return {
      key,
      severity: "error",
      message: `${key}: expected ${expected}, got ${typeof value} ${formatValue(
        value,
      )} — the bot will fall back to ${formatValue(defaultConfig[key])}`,
    };
  }

  if (meta.options && !meta.options.some((o) => o.value === String(value))) {
    return {
      key,
      severity: "error",
      message: `${key}: ${formatValue(value)} is not one of ${meta.options
        .map((o) => o.value)
        .join(", ")}`,
    };
  }

  if (ID_TYPES.has(meta.type)) {
    const ids = String(value)
      .split(",")
      .map((id) => id.trim())
      .filter((id) => id !== "");
    const bad = ids.filter((id) => !SNOWFLAKE.test(id));
    if (bad.length > 0) {
      return {
        key,
        severity: "warning",
        message: `${key}: ${bad
          .map(formatValue)
          .join(
            ", ",
          )} is not a Discord ID — this setting takes numeric IDs, not names`,
      };
    }
  }

  if (meta.min !== undefined && Number(value) < meta.min) {
    return {
      key,
      severity: "error",
      message: `${key}: ${formatValue(value)} is below the minimum of ${meta.min} — the Web UI refuses this value; a negative retention window would prune everything`,
    };
  }

  if (
    meta.warnBelow &&
    Number(value) < meta.warnBelow.value &&
    !(meta.warnBelow.exemptZero && Number(value) === 0)
  ) {
    return {
      key,
      severity: "warning",
      message: `${key}: ${formatValue(value)} — ${meta.warnBelow.message}`,
    };
  }

  return {
    key,
    severity: "ok",
    message: `${key}: ${formatValue(value)} (${label})`,
  };
}

/** The value the running bot would see: the stored value, else the default. */
function effectiveValue(
  stored: ReadonlyMap<keyof ConfigSchema, unknown>,
  key: keyof ConfigSchema,
): unknown {
  const value = stored.get(key);
  return value === null || value === undefined ? defaultConfig[key] : value;
}

/**
 * Cross-setting checks: enabled features whose hard dependency is off, and
 * enabled features missing the id they need.
 */
export function buildFeatureFindings(
  stored: ReadonlyMap<keyof ConfigSchema, unknown>,
): Finding[] {
  const effective = (key: keyof ConfigSchema): unknown =>
    effectiveValue(stored, key);
  const findings: Finding[] = [];

  // Only keys an operator has actually written are checked here. Several
  // sub-toggles ship `true` while their parent feature ships off (schema rule
  // 2 — they are inert until the parent is enabled), so judging defaults
  // against the dependency graph would report a stock install as broken.
  for (const key of stored.keys()) {
    if (settingsMetadata[key]?.type !== "boolean") continue;
    if (!isEnabledValue(stored.get(key))) continue;
    const unmet = getDependencies(key).filter(
      (dep) => !isEnabledValue(effective(dep)),
    );
    if (unmet.length > 0) {
      findings.push({
        key,
        severity: "error",
        message: `${key} is enabled but requires ${unmet.join(
          ", ",
        )} to be enabled`,
      });
    }
  }

  for (const { gate, key, consequence } of REQUIRED_WHEN_ENABLED) {
    if (!isEnabledValue(effective(gate))) continue;
    const value = effective(key);
    if (value === null || value === undefined || String(value).trim() === "") {
      findings.push({
        key,
        severity: "warning",
        message: `${gate} is enabled but ${key} is not set — ${consequence}`,
      });
    }
  }

  return findings;
}

export interface ValidationReport {
  env: Finding[];
  settings: Finding[];
  features: Finding[];
}

/**
 * Build the full report from the values actually stored. Pure: everything that
 * touches Mongo or the environment happens in `validateConfiguration()`.
 */
export function buildReport(
  stored: ReadonlyMap<keyof ConfigSchema, unknown>,
  missingEnv: readonly string[],
): ValidationReport {
  return {
    env: buildEnvFindings(missingEnv),
    settings: schemaKeys().map((key) =>
      validateSetting(key, stored.has(key) ? stored.get(key) : null),
    ),
    features: buildFeatureFindings(stored),
  };
}

export interface ValidationSummary {
  ok: number;
  defaults: number;
  warnings: number;
  errors: number;
}

export function summarize(report: ValidationReport): ValidationSummary {
  const summary: ValidationSummary = {
    ok: 0,
    defaults: 0,
    warnings: 0,
    errors: 0,
  };
  for (const finding of [
    ...report.env,
    ...report.settings,
    ...report.features,
  ]) {
    if (finding.severity === "ok") summary.ok++;
    else if (finding.severity === "default") summary.defaults++;
    else if (finding.severity === "warning") summary.warnings++;
    else summary.errors++;
  }
  return summary;
}

const ICONS: Record<Severity, string> = {
  ok: "✅",
  default: "•",
  warning: "⚠️ ",
  error: "❌",
};

function report(findings: Finding[], verbose: boolean): void {
  for (const finding of findings) {
    const line = `${ICONS[finding.severity]} ${finding.message}`;
    switch (finding.severity) {
      case "error":
        logger.error(line);
        break;
      case "warning":
        logger.warn(line);
        break;
      case "default":
        // Settings left at their schema default are the common case; only
        // list them when the operator asks for the full picture.
        if (verbose) logger.info(line);
        break;
      default:
        logger.info(line);
    }
  }
}

/**
 * Read every schema-declared setting as the running bot would resolve it:
 * database row first, else an env var (coerced by the same helper
 * `ConfigService.get()` uses), else nothing.
 *
 * This deliberately bypasses `ConfigService` rather than calling `get()` per
 * key. `initialize()` runs `cleanupUnknownSettings()`, which *deletes* rows,
 * and `get()` itself writes when it migrates a legacy `gamification.*` key —
 * a validator must never mutate. Reading the collection once also avoids a
 * findOne per key across ~100 settings.
 */
async function readStoredValues(): Promise<Map<keyof ConfigSchema, unknown>> {
  const rows = await Config.find({}, { key: 1, value: 1 }).lean();
  const byKey = new Map<string, unknown>(
    rows.map((row) => [row.key, row.value]),
  );

  const stored = new Map<keyof ConfigSchema, unknown>();
  for (const key of schemaKeys()) {
    if (byKey.has(key)) {
      const value = byKey.get(key);
      if (value !== null && value !== undefined) stored.set(key, value);
      continue;
    }
    const fromEnv = getEnvConfigValue(key);
    if (fromEnv !== null) stored.set(key, fromEnv);
  }
  return stored;
}

async function validateConfiguration(): Promise<void> {
  const verbose =
    process.argv.includes("--verbose") || process.argv.includes("-v");

  try {
    logger.info("Starting configuration validation...");

    await mongoose.connect(env.mongoUri);

    const stored = await readStoredValues();
    const result = buildReport(stored, getMissingRequiredEnv());
    const summary = summarize(result);

    logger.info("\nEnvironment:");
    report(result.env, verbose);

    logger.info("\nSettings:");
    report(result.settings, verbose);
    if (!verbose && summary.defaults > 0) {
      logger.info(
        `• ${summary.defaults} setting(s) left at their schema default (run with --verbose to list them)`,
      );
    }

    logger.info("\nFeature checks:");
    if (result.features.length === 0) {
      logger.info("✅ No feature configuration problems found");
    } else {
      report(result.features, verbose);
    }

    logger.info("\nValidation Summary:");
    logger.info(`✅ Valid: ${summary.ok}`);
    logger.info(`• Defaults: ${summary.defaults}`);
    logger.info(`⚠️  Warnings: ${summary.warnings}`);
    logger.info(`❌ Errors: ${summary.errors}`);

    if (summary.errors === 0) {
      logger.info("🎉 No configuration errors found!");
    } else {
      logger.error(
        "❌ Some configurations have errors. Please fix them before starting the bot.",
      );
      process.exitCode = 1;
    }

    if (summary.warnings > 0) {
      logger.warn(
        "⚠️  Some configurations have warnings. The bot may not work as expected.",
      );
    }
  } catch (error) {
    logger.error("Fatal error during configuration validation:", error);
    process.exitCode = 1;
  } finally {
    await mongoose.disconnect();
  }
}

// Run validation if this script is executed directly
if (import.meta.url === `file://${process.argv[1]}`) {
  validateConfiguration();
}

export { validateConfiguration };
