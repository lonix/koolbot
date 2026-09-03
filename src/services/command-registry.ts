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
  /** Module basename under `src/commands/` (without extension). */
  readonly file: string;
}

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
  { name: "remind", configKey: "reminders.enabled", file: "remind" },
  { name: "warn", configKey: "moderation.enabled", file: "warn" },
  { name: "modlog", configKey: "moderation.enabled", file: "modlog" },
  { name: "config", configKey: null, file: "config" }, // Always enabled - WebUI launcher
];
