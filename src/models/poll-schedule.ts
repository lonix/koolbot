import mongoose, { Schema, Document } from "mongoose";

export interface IPollSchedule extends Document {
  guildId: string;
  channelId: string;
  cronSchedule: string; // Cron expression for when to post
  pollDuration: number; // Duration in hours (1-768, max 32 days)
  roleIdToPing: string | null; // Optional role to mention
  enabled: boolean;
  createdBy: string; // User ID who created the schedule
  lastRun: Date | null; // Last time a poll was posted
  createdAt: Date;
  updatedAt: Date;
}

const PollScheduleSchema = new Schema<IPollSchedule>(
  {
    guildId: { type: String, required: true, index: true },
    channelId: { type: String, required: true },
    cronSchedule: { type: String, required: true },
    pollDuration: {
      type: Number,
      required: true,
      min: 1,
      max: 768,
      default: 24,
    },
    roleIdToPing: { type: String, default: null },
    enabled: { type: Boolean, default: true },
    createdBy: { type: String, required: true },
    lastRun: { type: Date, default: null },
  },
  {
    timestamps: true,
  },
);

export const PollSchedule = mongoose.model<IPollSchedule>(
  "PollSchedule",
  PollScheduleSchema,
);
