/**
 * Audit-log helper for Discord slash-command invocations (issue #459).
 * `CommandManager.executeCommand` calls this exactly once per command
 * run so each invocation produces one row in `DiscordCommandAuditLog`.
 * Analogous to `src/web/audit.ts` but keyed by Discord user rather
 * than a WebUI session.
 */

import logger from "./logger.js";
import { DiscordCommandAuditLog } from "../models/discord-command-audit-log.js";

export interface CommandAuditEntry {
  guildId: string;
  discordUserId: string;
  commandName: string;
  subcommand?: string | null;
  channelId?: string | null;
  result: "success" | "error" | "denied";
  errorMessage?: string | null;
  durationMs: number;
}

export async function recordCommandAudit(
  entry: CommandAuditEntry,
): Promise<void> {
  try {
    await DiscordCommandAuditLog.create({
      guildId: entry.guildId,
      discordUserId: entry.discordUserId,
      commandName: entry.commandName,
      subcommand: entry.subcommand ?? null,
      channelId: entry.channelId ?? null,
      result: entry.result,
      errorMessage: entry.errorMessage ?? null,
      durationMs: entry.durationMs,
    });
  } catch (err) {
    // Audit failures must never break the user's command. Surface them in
    // logs so operators notice persistent breakage.
    logger.error("Failed to record Discord command audit entry", err);
  }
}
