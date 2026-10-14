import mongoose, { Document, Schema } from "mongoose";

export type WebSessionRole = "admin" | "user";

export interface IWebSession extends Document {
  tokenHash: string;
  discordUserId: string;
  guildId: string;
  /**
   * Determines which web surface this session is authorised for. `admin`
   * sessions may use `/admin/*` and `/me/*`; `user` sessions are limited to
   * `/me/*`. Pre-role rows in the DB are missing this field — callers must
   * treat that case as legacy `admin` (the only role that could exist before
   * #481) at read time.
   */
  role: WebSessionRole;
  scopes: string[];
  createdAt: Date;
  expiresAt: Date;
  usedAt: Date | null;
  revokedAt: Date | null;
}

const WebSessionSchema = new Schema<IWebSession>(
  {
    tokenHash: {
      type: String,
      required: true,
      unique: true,
      index: true,
    },
    // Indexed through the compound `{ discordUserId, revokedAt }` below.
    discordUserId: {
      type: String,
      required: true,
    },
    guildId: {
      type: String,
      required: true,
    },
    role: {
      type: String,
      enum: ["admin", "user"],
      required: true,
      default: "user",
    },
    scopes: {
      type: [String],
      required: true,
      default: [],
    },
    createdAt: {
      type: Date,
      required: true,
      default: Date.now,
    },
    expiresAt: {
      type: Date,
      required: true,
    },
    usedAt: {
      type: Date,
      default: null,
    },
    revokedAt: {
      type: Date,
      default: null,
    },
  },
  { timestamps: false },
);

/**
 * How long a session row is kept after `expiresAt` before MongoDB removes it.
 *
 * Rows used to be soft-revoked and never deleted, so a member issuing sign-in
 * links in a loop grew the collection without bound (#1147). Every read path
 * (`redeem`, `peek`, the cookie middleware) already refuses a row once
 * `expiresAt` has passed, so purging one changes nothing a member or an admin
 * can do; the grace only keeps the "expired" (rather than "not found") reason
 * in the redeem logs for a week. `expiresAt` is the hard cap for both the
 * magic link and the redeemed session, so a row lives at most
 * `WEBUI_SESSION_LIFETIME_HOURS` (default 24h) plus this grace.
 *
 * Fixed rather than configurable: a TTL index's `expireAfterSeconds` cannot
 * follow a setting without an index-options conflict on existing databases,
 * and the rows hold only token hashes and timestamps.
 */
export const WEB_SESSION_PURGE_GRACE_SECONDS = 7 * 24 * 60 * 60;

// `revokeForUser` runs on every sign-in (`{ discordUserId, revokedAt: null }`).
// Without this it scanned every row the member ever had.
WebSessionSchema.index({ discordUserId: 1, revokedAt: 1 });

// TTL: MongoDB removes a row once `expiresAt` + the grace has passed. Mongoose
// creates both indexes at startup on existing databases (autoIndex is left on)
// without blocking the bot; `syncIndexes` is never used, so no existing index
// is dropped.
WebSessionSchema.index(
  { expiresAt: 1 },
  { expireAfterSeconds: WEB_SESSION_PURGE_GRACE_SECONDS },
);

export const WebSession = mongoose.model<IWebSession>(
  "WebSession",
  WebSessionSchema,
);
