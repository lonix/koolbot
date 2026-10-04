import type { GuildMember, PartialGuildMember } from "discord.js";
import logger from "../utils/logger.js";
import { sanitizeForLog } from "../utils/log-sanitize.js";
import { ConfigService } from "./config-service.js";
import { TrackingOptOutService } from "./tracking-opt-out-service.js";
import {
  NameKind,
  UserNameHistory,
  IUserNameHistory,
} from "../models/user-name-history.js";

/** The slice of a Discord `User` the history needs. */
export interface NameSourceUser {
  id: string;
  username?: string | null;
  globalName?: string | null;
  bot?: boolean;
}

/** Names seen for a member, grouped by kind, newest first. */
export type NameHistoryByKind = Record<
  NameKind,
  Pick<IUserNameHistory, "name" | "firstSeenAt" | "lastSeenAt">[]
>;

/**
 * An unchanged name set is re-written at most this often, just to keep
 * `lastSeenAt` honest. A *changed* name always writes immediately.
 */
export const SNAPSHOT_THROTTLE_MS = 6 * 60 * 60 * 1000;

/** Soft cap on the throttle cache; it is simply cleared when exceeded. */
const MAX_CACHE_ENTRIES = 20_000;

/** Discord caps names at 32 chars; guard against anything unexpected. */
const MAX_NAME_LENGTH = 64;

/**
 * Records and reads the names members have gone by (#1038).
 *
 * Capture is opportunistic: any handler that already holds a user or member
 * calls `recordUser` / `recordMember`. A per-member in-memory fingerprint
 * means an unchanged member costs no database round trip at all, so wiring it
 * into the message / reaction / voice handlers does not add a write per event.
 *
 * Gated on `namehistory.enabled` and on the member tracking opt-out (#918):
 * an opted-out member's names are never recorded.
 */
export class NameHistoryService {
  private static instance: NameHistoryService | null = null;
  private configService: ConfigService;
  /**
   * `guildId:userId` -> per-kind last recorded name and time. Tracked per
   * kind so a user-only snapshot (no nickname known, e.g. from a reaction)
   * and a full member snapshot (message, voice join) don't evict each other
   * and defeat the throttle by alternating.
   */
  private recent = new Map<
    string,
    Partial<Record<NameKind, { name: string; at: number }>>
  >();

  private constructor() {
    this.configService = ConfigService.getInstance();
  }

  public static getInstance(): NameHistoryService {
    if (!NameHistoryService.instance) {
      NameHistoryService.instance = new NameHistoryService();
    }
    return NameHistoryService.instance;
  }

  public static reset(): void {
    NameHistoryService.instance = null;
  }

  public async isEnabled(): Promise<boolean> {
    return this.configService
      .getBoolean("namehistory.enabled", false)
      .catch(() => false);
  }

  /**
   * Record a user's username and global display name, plus the server
   * nickname when `nickname` is a string (`null` means "no nickname", and
   * `undefined` means "not known here" — nothing is recorded for it).
   * Never throws: this runs inside hot event handlers.
   */
  public async recordUser(
    guildId: string,
    user: NameSourceUser,
    nickname?: string | null,
    since?: number,
  ): Promise<void> {
    try {
      if (user.bot) return;
      const names = this.collectNames(user, nickname);
      const key = `${guildId}:${user.id}`;
      const cached = this.recent.get(key);

      // A name observed as *absent* (`null`, as opposed to `undefined` =
      // "not known here") must drop its cache entry. Otherwise a name that
      // goes away and comes back inside the throttle window would look
      // unchanged and skip its write.
      if (cached) {
        if (user.globalName === null || user.globalName === "") {
          delete cached.globalName;
        }
        if (nickname === null || nickname === "") delete cached.nickname;
      }
      if (names.length === 0) return;
      const now = Date.now();
      if (
        cached &&
        names.every(({ kind, name }) => {
          const last = cached[kind];
          return (
            last && last.name === name && now - last.at < SNAPSHOT_THROTTLE_MS
          );
        })
      ) {
        return;
      }

      if (!(await this.isEnabled())) return;

      const optOuts = TrackingOptOutService.getInstance();
      const wrote = await optOuts.trackWrite(
        user.id,
        guildId,
        () => this.upsertNames(guildId, user.id, names, new Date(now)),
        since,
      );
      if (wrote) {
        if (this.recent.size >= MAX_CACHE_ENTRIES) this.recent.clear();
        const entry = this.recent.get(key) ?? {};
        for (const { kind, name } of names) entry[kind] = { name, at: now };
        this.recent.set(key, entry);
      }
    } catch (error) {
      logger.error(
        `Failed to record name history for ${sanitizeForLog(user.id)}:`,
        error,
      );
    }
  }

  /** Record from a guild member: their user names plus server nickname. */
  public async recordMember(
    member: GuildMember | PartialGuildMember,
    since?: number,
  ): Promise<void> {
    await this.recordUser(
      member.guild.id,
      member.user,
      member.nickname ?? null,
      since,
    );
  }

  /** Forget the throttle fingerprint for a member (after a data reset). */
  public forget(guildId: string, userId: string): void {
    this.recent.delete(`${guildId}:${userId}`);
  }

  /** Every recorded name for a member, grouped by kind, newest first. */
  public async getHistory(
    guildId: string,
    userId: string,
  ): Promise<NameHistoryByKind> {
    const rows = await UserNameHistory.find({ guildId, userId })
      .sort({ lastSeenAt: -1 })
      .lean();
    const grouped: NameHistoryByKind = {
      username: [],
      globalName: [],
      nickname: [],
    };
    for (const row of rows) {
      grouped[row.kind].push({
        name: row.name,
        firstSeenAt: row.firstSeenAt,
        lastSeenAt: row.lastSeenAt,
      });
    }
    return grouped;
  }

  private collectNames(
    user: NameSourceUser,
    nickname?: string | null,
  ): { kind: NameKind; name: string }[] {
    const out: { kind: NameKind; name: string }[] = [];
    const add = (kind: NameKind, value: string | null | undefined): void => {
      const name = typeof value === "string" ? value.trim() : "";
      if (name) out.push({ kind, name: name.slice(0, MAX_NAME_LENGTH) });
    };
    add("username", user.username);
    add("globalName", user.globalName);
    if (typeof nickname === "string") add("nickname", nickname);
    return out;
  }

  private async upsertNames(
    guildId: string,
    userId: string,
    names: { kind: NameKind; name: string }[],
    at: Date,
  ): Promise<void> {
    await UserNameHistory.bulkWrite(
      names.map(({ kind, name }) => ({
        updateOne: {
          filter: { guildId, userId, kind, name },
          update: {
            $set: { lastSeenAt: at },
            $setOnInsert: { firstSeenAt: at },
          },
          upsert: true,
        },
      })),
      { ordered: false },
    );
  }
}
