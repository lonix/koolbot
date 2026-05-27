import crypto from "crypto";
import logger from "../utils/logger.js";
import {
  WebSession,
  IWebSession,
  WebSessionRole,
} from "../models/web-session.js";

const DEFAULT_TTL_MINUTES = 10;

/**
 * Translate a DB-stored `role` to a strict `WebSessionRole`. Rows written
 * before #481 lack the field entirely; we treat that case as legacy
 * `"admin"` (the only role that could exist back then). An unrecognised
 * value also collapses to `"admin"` defensively so a corrupt row can't
 * upgrade itself by claiming an unknown role.
 */
function normalizeRole(raw: unknown): WebSessionRole {
  return raw === "user" ? "user" : "admin";
}

export interface CreatedSession {
  token: string;
  url: string;
  expiresAt: Date;
  role: WebSessionRole;
}

export interface RedeemedSession {
  sessionId: string;
  discordUserId: string;
  guildId: string;
  role: WebSessionRole;
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
   *
   * `role` decides whether the redeemed session can use the admin surface
   * (`/admin/*`) or only the user self-service surface (`/me/*`). The
   * default of `"user"` is the safest choice — callers in possession of
   * Administrator should pass `"admin"` explicitly. See #481.
   */
  public async create(
    discordUserId: string,
    guildId: string,
    role: WebSessionRole = "user",
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
      tokenHash,
      discordUserId,
      guildId,
      role,
      scopes,
      createdAt: now,
      expiresAt,
      usedAt: null,
      revokedAt: null,
    });

    logger.info(
      `Web session created for user=${discordUserId} guild=${guildId} role=${role} expires=${expiresAt.toISOString()}`,
    );

    const url = `${this.getBaseUrl()}/admin/s/${token}`;
    return { token, url, expiresAt, role };
  }

  /**
   * Redeem a magic-link token. Returns null if the token is missing,
   * already used, expired, or revoked. Marks the session used on success.
   */
  public async redeem(token: string): Promise<RedeemedSession | null> {
    if (!token) {
      logger.info("Web session redeem rejected: empty token");
      return null;
    }
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
        tokenHash,
        usedAt: null,
        revokedAt: null,
        expiresAt: { $gt: now },
      },
      { $set: { usedAt: now } },
      { new: true },
    );

    if (!session) {
      const reason = await this.classifyRedeemFailure(tokenHash, now);
      logger.info(`Web session redeem rejected: ${reason}`);
      return null;
    }

    logger.info(
      `Web session redeemed for user=${session.discordUserId} guild=${session.guildId} session=${String(session._id)}`,
    );

    return {
      sessionId: String(session._id),
      discordUserId: session.discordUserId,
      guildId: session.guildId,
      role: normalizeRole(session.role),
      scopes: session.scopes,
    };
  }

  /**
   * Validate a magic-link token *without* consuming it. Returns the same
   * shape as redeem() on success. Used by the consent screen so that
   * server-side link previewers (Discordbot, Slackbot, etc.) doing a GET
   * on the magic link don't burn the single-use token before the admin
   * has a chance to click "Continue".
   */
  public async peek(token: string): Promise<RedeemedSession | null> {
    if (!token) {
      logger.info("Web session peek rejected: empty token");
      return null;
    }
    let tokenHash: string;
    try {
      tokenHash = this.hashToken(token);
    } catch (err) {
      logger.error("Failed to hash token for peek", err);
      return null;
    }

    const now = new Date();
    let existing: IWebSession | null;
    try {
      existing = await WebSession.findOne({ tokenHash });
    } catch (err) {
      logger.error("Failed to look up session for peek", err);
      return null;
    }

    if (!existing) {
      logger.info("Web session peek rejected: not_found");
      return null;
    }
    if (existing.revokedAt) {
      logger.info("Web session peek rejected: revoked");
      return null;
    }
    if (existing.usedAt) {
      logger.info("Web session peek rejected: already_used");
      return null;
    }
    if (existing.expiresAt <= now) {
      logger.info("Web session peek rejected: expired");
      return null;
    }

    return {
      sessionId: String(existing._id),
      discordUserId: existing.discordUserId,
      guildId: existing.guildId,
      role: normalizeRole(existing.role),
      scopes: existing.scopes,
    };
  }

  /**
   * Diagnose why a redeem() lookup missed: token not found, already used,
   * expired, revoked, or a more obscure state. Best-effort — any error
   * collapses to "unknown" so a logging path never breaks the request.
   */
  private async classifyRedeemFailure(
    tokenHash: string,
    now: Date,
  ): Promise<string> {
    try {
      const existing = await WebSession.findOne({ tokenHash });
      if (!existing) return "not_found";
      if (existing.revokedAt) return "revoked";
      if (existing.usedAt) return "already_used";
      if (existing.expiresAt <= now) return "expired";
      return "unknown";
    } catch {
      return "unknown";
    }
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
      { discordUserId, revokedAt: null },
      { $set: { revokedAt: now } },
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
        { _id: sessionId, revokedAt: null },
        { $set: { revokedAt: now } },
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
