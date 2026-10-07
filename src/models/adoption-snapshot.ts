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
/** No heartbeat for this long means an apply/rollback is dead, not slow. */
export const ADOPTION_STALE_AFTER_MS = 30 * 60 * 1000;

export type AdoptionSnapshotStatus =
  "applying" | "rolling_back" | "applied" | "partial" | "rolled_back";

export type AdoptionOperationStatus =
  "pending" | "applied" | "failed" | "skipped";

export interface IAdoptionOperationRecord {
  opId: string;
  status: AdoptionOperationStatus;
  error?: string | null;
  at?: Date | null;
  /** Set before a non-idempotent write; lets a resume reconcile a crash. */
  startedAt?: Date | null;
  /** Id the operation produced (e.g. the new role's id). */
  resultId?: string | null;
}

export interface IRestoreIntent {
  kind: "role" | "channel";
  oldId: string;
  name: string;
  /** When the recreation began; only later-created candidates qualify. */
  startedAt: string;
  parentId?: string | null;
  rawType?: number | null;
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
  /** Recreations a rollback began; a retry reconciles them instead of duplicating. */
  restoreIntents: IRestoreIntent[];
  /** Roles recreated by a rollback of a delete: old id → new id. */
  restoredRoles: Array<{ oldId: string; newId: string }>;
  /** Operations whose rollback already succeeded (retry skips them). */
  rolledBackOps: string[];
  memberProgress: Record<
    string,
    {
      done: number;
      failed: string[];
      granted: string[];
      inflight?: string[];
    }
  >;
  rolledBackBy: string | null;
  rolledBackAt: Date | null;
  /** True while applying or rolling back: at most one per server. */
  active: boolean;
  /** Refreshed on every write; a stale active snapshot is recoverable. */
  heartbeatAt: Date;
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
      enum: ["applying", "rolling_back", "applied", "partial", "rolled_back"],
      required: true,
      default: "applying",
    },
    plan: { type: Schema.Types.Mixed, required: true },
    baseline: { type: Schema.Types.Mixed, required: true },
    operations: { type: Schema.Types.Mixed, default: [] },
    createdRoles: { type: Schema.Types.Mixed, default: [] },
    restoredChannels: { type: Schema.Types.Mixed, default: [] },
    restoreIntents: { type: Schema.Types.Mixed, default: [] },
    restoredRoles: { type: Schema.Types.Mixed, default: [] },
    rolledBackOps: { type: Schema.Types.Mixed, default: [] },
    memberProgress: { type: Schema.Types.Mixed, default: {} },
    active: { type: Boolean, default: false },
    heartbeatAt: { type: Date, default: Date.now },
    rolledBackBy: { type: String, default: null },
    rolledBackAt: { type: Date, default: null },
  },
  { timestamps: true, minimize: false },
);

AdoptionSnapshotSchema.index({ createdAt: 1 });
// One apply or rollback at a time per server, enforced by the database.
AdoptionSnapshotSchema.index(
  { guildId: 1 },
  { unique: true, partialFilterExpression: { active: true } },
);

export const AdoptionSnapshot = mongoose.model<IAdoptionSnapshot>(
  "AdoptionSnapshot",
  AdoptionSnapshotSchema,
);
