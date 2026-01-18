import mongoose, { Schema, Document } from "mongoose";

export interface IScheduledAnnouncement extends Document {
  guildId: string;
  channelId: string;
  cronSchedule: string;
  message: string;
  embedData?: {
    title?: string;
    description?: string;
    color?: number;
    fields?: Array<{
      name: string;
      value: string;
      inline?: boolean;
    }>;
    footer?: {
      text: string;
      iconUrl?: string;
    };
    thumbnail?: string;
    image?: string;
  };
  placeholders: boolean; // Whether to process placeholders in message/embed
  enabled: boolean;
  createdBy: string; // User ID who created the announcement
  createdAt: Date;
  updatedAt: Date;
}

const ScheduledAnnouncementSchema = new Schema<IScheduledAnnouncement>(
  {
    guildId: { type: String, required: true, index: true },
    channelId: { type: String, required: true },
    cronSchedule: { type: String, required: true },
    message: { type: String, required: true },
    embedData: {
      type: {
        title: { type: String },
        description: { type: String },
        color: { type: Number },
        fields: [
          {
            name: { type: String, required: true },
            value: { type: String, required: true },
            inline: { type: Boolean, default: false },
          },
        ],
        footer: {
          text: { type: String },
          iconUrl: { type: String },
        },
        thumbnail: { type: String },
        image: { type: String },
      },
      required: false,
    },
    placeholders: { type: Boolean, default: false },
    enabled: { type: Boolean, default: true },
    createdBy: { type: String, required: true },
  },
  {
    timestamps: true,
  },
);

export const ScheduledAnnouncement = mongoose.model<IScheduledAnnouncement>(
  "ScheduledAnnouncement",
  ScheduledAnnouncementSchema,
);
