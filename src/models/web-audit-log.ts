import mongoose, { Document, Schema } from "mongoose";

/**
 * Audit-log entry for write actions performed through the WebUI (issue #383
 * onwards). One row per state-changing request, keyed by the WebUI session
 * that produced it so an operator can trace every change back to a specific
 * `/config` redemption.
 */
export interface IWebAuditLog extends Document {
  guildId: string;
  sessionId: string;
  discordUserId: string;
  action: string;
  targetId: string | null;
  details: Record<string, unknown>;
  result: "success" | "failure";
  errorMessage: string | null;
  createdAt: Date;
}

const WebAuditLogSchema = new Schema<IWebAuditLog>(
  {
    guildId: { type: String, required: true, index: true },
    sessionId: { type: String, required: true, index: true },
    discordUserId: { type: String, required: true, index: true },
    action: { type: String, required: true },
    targetId: { type: String, default: null },
    details: { type: Schema.Types.Mixed, default: {} },
    result: {
      type: String,
      enum: ["success", "failure"],
      required: true,
    },
    errorMessage: { type: String, default: null },
    createdAt: { type: Date, required: true, default: Date.now, index: true },
  },
  { timestamps: false },
);

export const WebAuditLog = mongoose.model<IWebAuditLog>(
  "WebAuditLog",
  WebAuditLogSchema,
);
