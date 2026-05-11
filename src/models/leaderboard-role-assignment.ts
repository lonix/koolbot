import mongoose, { Schema, Document } from "mongoose";

/**
 * Tracks which users currently hold a leaderboard reward role for a given
 * tier. The service maintains this so it can compute who to add and who to
 * remove on the next run, without needing the privileged GuildMembers intent
 * or a full-guild member fetch.
 *
 * Identity: (guildId, roleId). `topN` is denormalised on the row for logs.
 */
export interface ILeaderboardRoleAssignment extends Document {
  guildId: string;
  roleId: string;
  topN: number;
  userIds: string[];
  createdAt: Date;
  updatedAt: Date;
}

const LeaderboardRoleAssignmentSchema = new Schema<ILeaderboardRoleAssignment>(
  {
    guildId: { type: String, required: true, index: true },
    roleId: { type: String, required: true },
    topN: { type: Number, required: true },
    userIds: { type: [String], default: [] },
  },
  { timestamps: true },
);

LeaderboardRoleAssignmentSchema.index(
  { guildId: 1, roleId: 1 },
  { unique: true },
);

export const LeaderboardRoleAssignment =
  mongoose.model<ILeaderboardRoleAssignment>(
    "LeaderboardRoleAssignment",
    LeaderboardRoleAssignmentSchema,
  );
