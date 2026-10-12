import { randomBytes } from "node:crypto";
import type { ChannelClaim } from "../services/channel-claims.js";

/**
 * Short-lived, server-side memory of what an admin previewed on the Channel
 * Claims page (#1022).
 *
 * The preview used to carry every claim in a hidden form field, which can far
 * exceed the Web UI's urlencoded body limit. Instead the validated claims and
 * the approval stamp stay here and the form carries only an unguessable token.
 * A token is bound to the session and server that created it, so a client can
 * neither apply a plan someone else previewed nor choose different claims than
 * the ones it saw. The plan id is still recomputed and compared at apply time,
 * and the plan is re-validated against the live server.
 *
 * In memory by design: a restart just means "preview again".
 */

export interface StoredPreview {
  claims: ChannelClaim[];
  approvedAt: string;
}

interface Entry extends StoredPreview {
  sessionId: string;
  guildId: string;
  expiresAt: number;
}

export const PREVIEW_TTL_MS = 30 * 60 * 1000;
const MAX_ENTRIES = 200;

export class ClaimsPreviewStore {
  private readonly entries = new Map<string, Entry>();

  public constructor(private readonly now: () => number = Date.now) {}

  public put(
    sessionId: string,
    guildId: string,
    preview: StoredPreview,
  ): string {
    this.prune();
    // Bounded: drop the oldest previews rather than grow without limit.
    while (this.entries.size >= MAX_ENTRIES) {
      const oldest = this.entries.keys().next().value;
      if (oldest === undefined) break;
      this.entries.delete(oldest);
    }
    const token = randomBytes(24).toString("base64url");
    this.entries.set(token, {
      ...preview,
      sessionId,
      guildId,
      expiresAt: this.now() + PREVIEW_TTL_MS,
    });
    return token;
  }

  /** The preview for a token, only for the session and server that made it. */
  public get(
    token: string,
    sessionId: string,
    guildId: string,
  ): StoredPreview | null {
    const entry = this.entries.get(token);
    if (!entry) return null;
    if (entry.expiresAt <= this.now()) {
      this.entries.delete(token);
      return null;
    }
    if (entry.sessionId !== sessionId || entry.guildId !== guildId) {
      return null;
    }
    return { claims: entry.claims, approvedAt: entry.approvedAt };
  }

  public delete(token: string): void {
    this.entries.delete(token);
  }

  private prune(): void {
    const t = this.now();
    for (const [token, e] of this.entries) {
      if (e.expiresAt <= t) this.entries.delete(token);
    }
  }
}

export const claimsPreviewStore = new ClaimsPreviewStore();
