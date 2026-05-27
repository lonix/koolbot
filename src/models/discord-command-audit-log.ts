import mongoose, { Document, Schema } from "mongoose";

/**
 * Audit-log entry for Discord slash-command invocations (issue #459).
 * One row per `CommandManager.executeCommand` call so an operator can see
 * who ran which command, when, and what the outcome was. Mirrors the
 * shape of `WebAuditLog` but keyed by Discord user rather than WebUI
 * session because slash-command runs don't have a WebUI session.
 *
 * Raw command arguments are deliberately excluded — they may contain
 * user-private text (e.g. /quote add) and rotate too often to be useful
 * for the operator-visibility use case this log was designed for.
 */
export interface IDiscordCommandAuditLog extends Document {
  guildId: string;
  discordUserId: string;
  commandName: string;
  subcommand: string | null;
  channelId: string | null;
  result: "success" | "error" | "denied";
  errorMessage: string | null;
  durationMs: number;
  createdAt: Date;
}

const DiscordCommandAuditLogSchema = new Schema<IDiscordCommandAuditLog>(
  {
    guildId: { type: String, required: true, index: true },
    discordUserId: { type: String, required: true, index: true },
    commandName: { type: String, required: true, index: true },
    subcommand: { type: String, default: null },
    channelId: { type: String, default: null },
    result: {
      type: String,
      enum: ["success", "error", "denied"],
      required: true,
    },
    errorMessage: { type: String, default: null },
    durationMs: { type: Number, required: true },
    createdAt: { type: Date, required: true, default: Date.now, index: true },
  },
  { timestamps: false },
);

export const DiscordCommandAuditLog = mongoose.model<IDiscordCommandAuditLog>(
  "DiscordCommandAuditLog",
  DiscordCommandAuditLogSchema,
);
