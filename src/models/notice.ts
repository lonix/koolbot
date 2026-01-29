import mongoose, { Document, Schema } from "mongoose";

export interface INotice extends Document {
  title: string;
  content: string;
  category: string;
  order: number;
  messageId?: string; // Discord message ID
  createdBy: string; // User ID
  createdAt: Date;
  updatedAt: Date;
}

const NoticeSchema = new Schema<INotice>(
  {
    title: {
      type: String,
      required: true,
      maxlength: 256,
    },
    content: {
      type: String,
      required: true,
      maxlength: 4000,
    },
    category: {
      type: String,
      required: true,
      default: "general",
      enum: ["general", "rules", "info", "help", "game-servers"],
    },
    order: {
      type: Number,
      required: true,
      default: 0,
    },
    messageId: {
      type: String,
      required: false,
    },
    createdBy: {
      type: String,
      required: true,
    },
  },
  {
    timestamps: true,
  },
);

// Index for efficient querying
NoticeSchema.index({ category: 1, order: 1 });
NoticeSchema.index({ messageId: 1 });

const Notice = mongoose.model<INotice>("Notice", NoticeSchema);

export default Notice;
