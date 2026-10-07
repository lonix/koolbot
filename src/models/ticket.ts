import mongoose, { Document, Schema } from "mongoose";

/**
 * Support ticket (#1004). One row per private ticket channel a member opens
 * with `/ticket open`. The row is the source of truth for the ticket's
 * lifecycle — the channel is just where the conversation happens — so closing
 * archives the channel (locked and renamed, never deleted) and the row keeps
 * the status, who claimed and who closed it, and a pointer to the transcript
 * message when `tickets.transcript_on_close` is on.
 *
 * Lifecycle: `open → claimed → closed`, and `closed → open` on reopen. The
 * Web UI and the command drive the same transitions through
 * `TicketChannelManager`.
 */
export type TicketStatus = "open" | "claimed" | "closed";

export const TICKET_STATUSES: readonly TicketStatus[] = [
  "open",
  "claimed",
  "closed",
];

export interface ITicket extends Document {
  _id: mongoose.Types.ObjectId;
  guildId: string;
  /** The member who opened the ticket. */
  authorId: string;
  /** The private text channel. Kept after close (the channel is archived). */
  channelId: string;
  status: TicketStatus;
  /** Staff member who claimed the ticket. Null until claimed. */
  claimedBy: string | null;
  /** Who closed it (the author or staff). Null while open. */
  closedBy: string | null;
  closedAt: Date | null;
  /** Short text the member gave when opening. */
  subject: string;
  /** Message holding the transcript attachment, when one was written. */
  transcriptMessageId: string | null;
  createdAt: Date;
}

const TicketSchema = new Schema<ITicket>(
  {
    guildId: { type: String, required: true, index: true },
    authorId: { type: String, required: true, index: true },
    channelId: { type: String, required: true, index: true },
    status: {
      type: String,
      enum: TICKET_STATUSES,
      required: true,
      default: "open",
    },
    claimedBy: { type: String, default: null },
    closedBy: { type: String, default: null },
    closedAt: { type: Date, default: null },
    subject: { type: String, required: true },
    transcriptMessageId: { type: String, default: null },
    createdAt: { type: Date, required: true, default: Date.now },
  },
  { timestamps: false },
);

// Admin listing: filter by guild + status, newest first.
TicketSchema.index({ guildId: 1, status: 1, createdAt: -1 });

export const Ticket = mongoose.model<ITicket>("Ticket", TicketSchema);
