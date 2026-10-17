import mongoose, { Schema, Document } from "mongoose";

/**
 * The optional cover image of a KoolBot event (#1181), kept in its own small
 * collection (`event-images`) instead of on the event rows: a recurring series
 * has one row per occurrence, and the bytes would otherwise be copied into
 * every row, read by every scan (`Event.find` loads whole documents) and count
 * towards each row's 16 MB document limit. The row carries only the content
 * hash (`Event.coverHash`).
 *
 * One image per event or series, keyed by `key`: the series id for a recurring
 * event, the event's own `_id` (as a string) for a one-off. The upload is
 * validated (real file signature, size cap) before it is stored, so a document
 * here is always a PNG, JPEG or GIF of at most `COVER_MAX_BYTES`
 * (`services/event-cover.ts`). It is admin-authored content: it holds no
 * member data and no user id.
 */
export interface IEventImage extends Document {
  guildId: string;
  /** Series id, or the event `_id` as a string for a one-off event. */
  key: string;
  /** Detected from the file signature, never from the upload's declared type. */
  mime: "image/png" | "image/jpeg" | "image/gif";
  data: Buffer;
  /** Hex SHA-256 of `data`; what the native-event sync compares. */
  hash: string;
  bytes: number;
  createdAt: Date;
  updatedAt: Date;
}

const EventImageSchema = new Schema<IEventImage>(
  {
    guildId: { type: String, required: true },
    key: { type: String, required: true },
    mime: {
      type: String,
      required: true,
      enum: ["image/png", "image/jpeg", "image/gif"],
    },
    data: { type: Buffer, required: true },
    hash: { type: String, required: true },
    bytes: { type: Number, required: true },
  },
  { timestamps: true, collection: "event-images" },
);

// One image per event or series.
EventImageSchema.index({ guildId: 1, key: 1 }, { unique: true });

export const EventImage = mongoose.model<IEventImage>(
  "EventImage",
  EventImageSchema,
);
