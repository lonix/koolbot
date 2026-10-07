import mongoose, { Document, Schema } from "mongoose";

/**
 * One server-adoption apply run (#1018): the plan that was applied, the prior
 * state of everything it touched, and how far it got.
 *
 * It is written *before* the first Discord write and updated after every
 * operation, which is what makes an apply resumable after a partial failure
 * or a restart, and what `rollback` restores from. `plan` and `baseline` are
 * stored verbatim (Mixed) because their shape is owned by
 * `server-adoption-planner.ts`.
 */
export type AdoptionSnapshotStatus =
  "applying" | "applied" | "partial" | "rolled_back";

export type AdoptionOperationStatus =
  "pending" | "applied" | "failed" | "skipped";

export interface IAdoptionOperationRecord {
  opId: string;
  status: AdoptionOperationStatus;
  error?: string | null;
  at?: Date | null;
  /** Id the operation produced (e.g. the new role's id). */
  resultId?: string | null;
}

export interface IAdoptionSnapshot extends Document {
  planId: string;
  guildId: string;
  appliedBy: string;
  status: AdoptionSnapshotStatus;
  plan: Record<string, unknown>;
  /** Prior state of every role, channel and config key the plan touches. */
  baseline: Record<string, unknown>;
  operations: IAdoptionOperationRecord[];
  /** Roles the plan created: planner ref → real id. */
  createdRoles: Array<{ ref: string; roleId: string; name: string }>;
  /** Channels recreated by a rollback of a destructive step: old id → new id. */
  restoredChannels: Array<{ oldId: string; newId: string }>;
  /** Member-operation progress, keyed by opId. */
  /** Roles recreated by a rollback of a delete: old id → new id. */
  restoredRoles: Array<{ oldId: string; newId: string }>;
  /** Operations whose rollback already succeeded (retry skips them). */
  rolledBackOps: string[];
  memberProgress: Record<
    string,
    { done: number; failed: string[]; granted: string[] }
  >;
  rolledBackBy: string | null;
  rolledBackAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
}

const AdoptionSnapshotSchema = new Schema<IAdoptionSnapshot>(
  {
    planId: { type: String, required: true, index: true },
    guildId: { type: String, required: true, index: true },
    appliedBy: { type: String, required: true },
    status: {
      type: String,
      enum: ["applying", "applied", "partial", "rolled_back"],
      required: true,
      default: "applying",
    },
    plan: { type: Schema.Types.Mixed, required: true },
    baseline: { type: Schema.Types.Mixed, required: true },
    operations: { type: Schema.Types.Mixed, default: [] },
    createdRoles: { type: Schema.Types.Mixed, default: [] },
    restoredChannels: { type: Schema.Types.Mixed, default: [] },
    restoredRoles: { type: Schema.Types.Mixed, default: [] },
    rolledBackOps: { type: Schema.Types.Mixed, default: [] },
    memberProgress: { type: Schema.Types.Mixed, default: {} },
    rolledBackBy: { type: String, default: null },
    rolledBackAt: { type: Date, default: null },
  },
  { timestamps: true, minimize: false },
);

AdoptionSnapshotSchema.index({ createdAt: 1 });

export const AdoptionSnapshot = mongoose.model<IAdoptionSnapshot>(
  "AdoptionSnapshot",
  AdoptionSnapshotSchema,
);
