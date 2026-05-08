import crypto from "crypto";
import logger from "../utils/logger.js";
import { WebSession, IWebSession } from "../models/web-session.js";

const DEFAULT_TTL_MINUTES = 10;

export interface CreatedSession {
  token: string;
  url: string;
  expiresAt: Date;
}

export interface RedeemedSession {
  sessionId: string;
  discordUserId: string;
  guildId: string;
  scopes: string[];
}

export class WebSessionService {
  private static instance: WebSessionService | null = null;

  private constructor() {}

  public static getInstance(): WebSessionService {
    if (!WebSessionService.instance) {
      WebSessionService.instance = new WebSessionService();
    }
    return WebSessionService.instance;
  }

  /**
   * Hash a token using HMAC-SHA256 with WEBUI_SESSION_SECRET so a stolen DB
   * row alone cannot be replayed.
   */
  public hashToken(token: string): string {
    const secret = process.env.WEBUI_SESSION_SECRET;
    if (!secret) {
      throw new Error("WEBUI_SESSION_SECRET not configured");
    }
    return crypto.createHmac("sha256", secret).update(token).digest("hex");
  }

  private getTtlMinutes(): number {
    const raw = process.env.WEBUI_SESSION_TTL_MINUTES;
    const parsed = raw ? Number(raw) : NaN;
    return Number.isFinite(parsed) && parsed > 0 ? parsed : DEFAULT_TTL_MINUTES;
  }

  private getBaseUrl(): string {
    const baseUrl = process.env.WEBUI_BASE_URL;
    if (!baseUrl) {
      throw new Error("WEBUI_BASE_URL not configured");
    }
    return baseUrl.replace(/\/+$/, "");
  }

  /**
   * Create a new magic-link session. Revokes any prior unused/active
   * sessions for this user so re-issuing a link invalidates the old one.
   */
  public async create(
    discordUserId: string,
    guildId: string,
    scopes: string[] = [],
  ): Promise<CreatedSession> {
    if (!discordUserId) throw new Error("discordUserId required");
    if (!guildId) throw new Error("guildId required");

    await this.revokeForUser(discordUserId);

    const token = crypto.randomBytes(32).toString("base64url");
    const tokenHash = this.hashToken(token);
    const ttlMs = this.getTtlMinutes() * 60 * 1000;
    const now = new Date();
    const expiresAt = new Date(now.getTime() + ttlMs);

    await WebSession.create({
      token_hash: tokenHash,
      discord_user_id: discordUserId,
      guild_id: guildId,
      scopes,
      created_at: now,
      expires_at: expiresAt,
      used_at: null,
      revoked_at: null,
    });

    const url = `${this.getBaseUrl()}/admin/s/${token}`;
    return { token, url, expiresAt };
  }

  /**
   * Redeem a magic-link token. Returns null if the token is missing,
   * already used, expired, or revoked. Marks the session used on success.
   */
  public async redeem(token: string): Promise<RedeemedSession | null> {
    if (!token) return null;
    let tokenHash: string;
    try {
      tokenHash = this.hashToken(token);
    } catch (err) {
      logger.error("Failed to hash token for redemption", err);
      return null;
    }

    const now = new Date();
    const session = await WebSession.findOneAndUpdate(
      {
        token_hash: tokenHash,
        used_at: null,
        revoked_at: null,
        expires_at: { $gt: now },
      },
      { $set: { used_at: now } },
      { new: true },
    );

    if (!session) return null;

    return {
      sessionId: String(session._id),
      discordUserId: session.discord_user_id,
      guildId: session.guild_id,
      scopes: session.scopes,
    };
  }

  /**
   * Look up a session by its database id. Used by the cookie-session
   * middleware to revalidate every request.
   */
  public async findById(sessionId: string): Promise<IWebSession | null> {
    if (!sessionId) return null;
    try {
      return await WebSession.findById(sessionId);
    } catch {
      return null;
    }
  }

  /**
   * Revoke all unrevoked sessions for a user (whether redeemed or not).
   */
  public async revokeForUser(discordUserId: string): Promise<number> {
    const now = new Date();
    const result = await WebSession.updateMany(
      { discord_user_id: discordUserId, revoked_at: null },
      { $set: { revoked_at: now } },
    );
    const modified = (result as { modifiedCount?: number }).modifiedCount ?? 0;
    if (modified > 0) {
      logger.debug(
        `Revoked ${modified} active web session(s) for user ${discordUserId}`,
      );
    }
    return modified;
  }

  /**
   * Revoke a specific session by its database id.
   */
  public async revokeSession(sessionId: string): Promise<boolean> {
    if (!sessionId) return false;
    try {
      const now = new Date();
      const result = await WebSession.updateOne(
        { _id: sessionId, revoked_at: null },
        { $set: { revoked_at: now } },
      );
      const modified =
        (result as { modifiedCount?: number }).modifiedCount ?? 0;
      return modified > 0;
    } catch (err) {
      logger.error("Failed to revoke web session", err);
      return false;
    }
  }
}
