import { isMeCommandEnabled } from "../web/me-surfaces.js";

/**
 * The single source of truth for which slash commands KoolBot ships.
 *
 * `CommandManager` reads this list to register commands with Discord and to
 * load their execute handlers, and `/help` derives its output from it (plus
 * each command's `SlashCommandBuilder`), so adding an entry here is the only
 * registration step a new command needs.
 */
export interface CommandConfig {
  /** Slash command name as registered with Discord. */
  readonly name: string;
  /**
   * Config key gating the command (read via `ConfigService.getBoolean`), or
   * `null` for core commands that are always enabled.
   */
  readonly configKey: string | null;
  /**
   * Derived gate for commands whose availability is not a single config key
   * (e.g. `/me`). When set, it replaces `configKey` as the enablement check
   * and is re-evaluated on every registration, so `/config reload` picks up
   * changes to the underlying keys.
   */
  readonly isEnabled?: () => Promise<boolean>;
  /** Module basename under `src/commands/` (without extension). */
  readonly file: string;
}

/** Resolve whether a registry entry is currently enabled. */
export async function isCommandEnabled(
  config: Pick<CommandConfig, "configKey" | "isEnabled">,
  getBoolean: (key: string, defaultValue: boolean) => Promise<boolean>,
): Promise<boolean> {
  if (config.isEnabled) return config.isEnabled();
  if (config.configKey) return getBoolean(config.configKey, false);
  return true;
}

/**
 * The command that is always Administrator-only (#1016). Role gating on the
 * Web UI's Permissions page cannot affect it, so that page neither lists nor
 * accepts edits for it.
 */
export const ADMIN_ONLY_COMMAND = "config";

export const COMMAND_CONFIGS: readonly CommandConfig[] = [
  { name: "ping", configKey: "ping.enabled", file: "ping" },
  { name: "help", configKey: null, file: "help" }, // Always enabled - core feature
  {
    name: "voicestats",
    configKey: "voicetracking.enabled",
    file: "voicestats",
  },
  { name: "seen", configKey: "voicetracking.seen.enabled", file: "seen" },
  {
    name: "achievements",
    configKey: "achievements.enabled",
    file: "achievements",
  },
  { name: "quote", configKey: "quotes.enabled", file: "quote" },
  { name: "event", configKey: "events.enabled", file: "event" },
  { name: "lfg", configKey: "lfg.enabled", file: "lfg" },
  { name: "remind", configKey: "reminders.enabled", file: "remind" },
  { name: "warn", configKey: "moderation.enabled", file: "warn" },
  { name: "timeout", configKey: "moderation.enabled", file: "timeout" },
  { name: "ban", configKey: "moderation.enabled", file: "ban" },
  { name: "modlog", configKey: "moderation.enabled", file: "modlog" },
  { name: "config", configKey: null, file: "config" }, // Always enabled - admin WebUI launcher
  // Derived gate (no `me.enabled` key): Web UI on and a /me/* surface on (#1016)
  { name: "me", configKey: null, isEnabled: isMeCommandEnabled, file: "me" },
];
