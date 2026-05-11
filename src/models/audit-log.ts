import mongoose, { Document, Schema } from "mongoose";

export interface IAuditLog extends Document {
  action: string;
  userId: string;
  guildId: string;
  key?: string;
  before?: unknown;
  after?: unknown;
  extra?: Record<string, unknown>;
  createdAt: Date;
  updatedAt: Date;
}

const AuditLogSchema = new Schema<IAuditLog>(
  {
    action: { type: String, required: true, index: true },
    userId: { type: String, required: true, index: true },
    guildId: { type: String, required: true, index: true },
    key: { type: String },
    before: { type: Schema.Types.Mixed },
    after: { type: Schema.Types.Mixed },
    extra: { type: Schema.Types.Mixed },
  },
  { timestamps: true },
);

export const AuditLog = mongoose.model<IAuditLog>("AuditLog", AuditLogSchema);
