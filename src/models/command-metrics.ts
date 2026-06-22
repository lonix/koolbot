import mongoose, { Document, Schema } from "mongoose";

/**
 * Persisted, per-command daily metric bucket (issue #648).
 *
 * `MonitoringService` keeps rich per-command counters in memory, but those
 * are wiped on every restart and never surfaced outside the logs. This model
 * gives them a durable home: one document per `{command, date, guildId}`
 * (a UTC day bucket), upserted in batches by `MonitoringService.flushMetrics`.
 *
 * Daily bucketing (rather than one cumulative doc per command) yields natural
 * time-series data for the Admin → Command Metrics dashboard and makes
 * retention a simple matter of dropping old buckets.
 *
 * Retention is handled by a TTL index on `expiresAt`. Each write stamps
 * `expiresAt = lastUsedAt + monitoring.metrics_retention_days`, so the window
 * is operator-configurable at write time even though a TTL index's
 * `expireAfterSeconds` is otherwise fixed — Mongo simply removes a doc once
 * its own `expiresAt` passes.
 */
export interface ICommandMetrics extends Document {
  /** Slash-command name (no leading slash, no subcommand). */
  command: string;
  /** UTC day bucket key, formatted "YYYY-MM-DD". */
  date: string;
  guildId: string;
  /** Successful + failed invocations recorded in this bucket. */
  usageCount: number;
  /** Subset of `usageCount` that ended in an error. */
  errorCount: number;
  /** Summed response time (ms) across `usageCount` invocations. */
  totalResponseMs: number;
  firstUsedAt: Date;
  lastUsedAt: Date;
  /** TTL anchor — the doc is pruned once this timestamp passes. */
  expiresAt: Date;
}

const CommandMetricsSchema = new Schema<ICommandMetrics>(
  {
    command: { type: String, required: true },
    date: { type: String, required: true },
    guildId: { type: String, required: true },
    usageCount: { type: Number, default: 0 },
    errorCount: { type: Number, default: 0 },
    totalResponseMs: { type: Number, default: 0 },
    firstUsedAt: { type: Date, required: true, default: Date.now },
    lastUsedAt: { type: Date, required: true, default: Date.now },
    expiresAt: { type: Date, required: true },
  },
  { timestamps: false },
);

// One bucket per command per guild per day — the upsert key.
CommandMetricsSchema.index(
  { command: 1, date: 1, guildId: 1 },
  { unique: true },
);

// Backs the dashboard's "last N days for this guild" range scans.
CommandMetricsSchema.index({ guildId: 1, date: 1 });

// TTL: remove a bucket once its per-document `expiresAt` passes. The
// `expireAfterSeconds: 0` form defers entirely to each doc's own anchor,
// which is what lets the retention window stay config-driven.
CommandMetricsSchema.index({ expiresAt: 1 }, { expireAfterSeconds: 0 });

export const CommandMetrics = mongoose.model<ICommandMetrics>(
  "CommandMetrics",
  CommandMetricsSchema,
);
