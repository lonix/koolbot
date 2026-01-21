import mongoose, { Schema, Document } from "mongoose";

export interface IChannelInvite extends Document {
  channelId: string;
  userId: string; // User being invited
  invitedBy: string; // User who sent the invite
  status: "pending" | "accepted" | "declined" | "expired";
  expiresAt: Date;
  createdAt: Date;
  updatedAt: Date;
}

const ChannelInviteSchema = new Schema(
  {
    channelId: { type: String, required: true, index: true },
    userId: { type: String, required: true, index: true },
    invitedBy: { type: String, required: true },
    status: {
      type: String,
      enum: ["pending", "accepted", "declined", "expired"],
      default: "pending",
    },
    expiresAt: { type: Date, required: true, index: true },
  },
  {
    timestamps: true,
  },
);

// Compound index for efficient lookups
ChannelInviteSchema.index({ channelId: 1, userId: 1 });

export const ChannelInvite = mongoose.model<IChannelInvite>(
  "ChannelInvite",
  ChannelInviteSchema,
);
