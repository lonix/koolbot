import logger from "../utils/logger.js";
import { isValidTimezone } from "../utils/timezone.js";
import {
  UserNotificationPrefs,
  type IUserNotificationPrefs,
} from "../models/user-notification-prefs.js";

/**
 * Plain shape (no Mongoose doc methods) returned by the service. Callers
 * outside of this module work with `NotificationPrefs`, never the raw
 * `IUserNotificationPrefs` document.
 */
export interface NotificationPrefs {
  achievements: boolean;
  digest: boolean;
  rewind: boolean;
}

export type NotificationPrefKey = keyof NotificationPrefs;

export const NOTIFICATION_PREF_KEYS: readonly NotificationPrefKey[] = [
  "achievements",
  "digest",
  "rewind",
];

export const DEFAULT_PREFS: NotificationPrefs = {
  achievements: true,
  digest: true,
  rewind: true,
};

/**
 * Per-user notification preferences service (#482).
 *
 * Backed by `UserNotificationPrefs` (one row per `(userId, guildId)`).
 * A missing row is treated as "all defaults true", so guards in DM-send
 * paths can call `getPrefs` unconditionally without first checking
 * whether the user has ever opened `/me/notifications`.
 */
export class UserNotificationPrefsService {
  private static instance: UserNotificationPrefsService | null = null;

  private constructor() {}

  public static getInstance(): UserNotificationPrefsService {
    if (!UserNotificationPrefsService.instance) {
      UserNotificationPrefsService.instance =
        new UserNotificationPrefsService();
    }
    return UserNotificationPrefsService.instance;
  }

  /**
   * Read the prefs for a user in a guild. Missing row → defaults
   * (everything enabled). DB errors are logged and also collapse to
   * defaults so a transient failure can't accidentally silence every DM.
   */
  public async getPrefs(
    userId: string,
    guildId: string,
  ): Promise<NotificationPrefs> {
    if (!userId || !guildId) return { ...DEFAULT_PREFS };
    try {
      const row = await UserNotificationPrefs.findOne({ userId, guildId });
      if (!row) return { ...DEFAULT_PREFS };
      return rowToPrefs(row);
    } catch (err) {
      logger.error("Failed to load notification prefs", err);
      return { ...DEFAULT_PREFS };
    }
  }

  /**
   * Read prefs and timezone in a single query. Callers that need both —
   * notably the weekly digest cron, which renders the week range in the
   * user's zone — use this to avoid a second `findOne` per user. Same
   * defaulting rules as `getPrefs`/`getTimezone` (missing row / error →
   * all-defaults + null zone).
   */
  public async getPrefsWithTimezone(
    userId: string,
    guildId: string,
  ): Promise<{ prefs: NotificationPrefs; timezone: string | null }> {
    if (!userId || !guildId) {
      return { prefs: { ...DEFAULT_PREFS }, timezone: null };
    }
    try {
      const row = await UserNotificationPrefs.findOne({ userId, guildId });
      if (!row) return { prefs: { ...DEFAULT_PREFS }, timezone: null };
      const tz =
        typeof row.timezone === "string" && row.timezone.length > 0
          ? row.timezone
          : null;
      return { prefs: rowToPrefs(row), timezone: tz };
    } catch (err) {
      logger.error("Failed to load notification prefs + timezone", err);
      return { prefs: { ...DEFAULT_PREFS }, timezone: null };
    }
  }

  /**
   * Apply a partial update. Only keys present in `patch` are written;
   * absent keys keep their prior stored value (or default if no row
   * existed). The merged result is returned so callers can render the
   * post-update state without an extra read.
   */
  public async setPrefs(
    userId: string,
    guildId: string,
    patch: Partial<NotificationPrefs>,
  ): Promise<NotificationPrefs> {
    if (!userId) throw new Error("userId required");
    if (!guildId) throw new Error("guildId required");
    const cleaned: Partial<NotificationPrefs> = {};
    for (const key of NOTIFICATION_PREF_KEYS) {
      const value = patch[key];
      if (typeof value === "boolean") cleaned[key] = value;
    }
    const row = await UserNotificationPrefs.findOneAndUpdate(
      { userId, guildId },
      { $set: { ...cleaned, updatedAt: new Date() } },
      { new: true, upsert: true, setDefaultsOnInsert: true },
    );
    return row ? rowToPrefs(row) : { ...DEFAULT_PREFS, ...cleaned };
  }

  /**
   * Read the user's preferred display timezone (#524). Returns the stored
   * IANA identifier, or `null` when unset (or on any read error) so
   * callers fall back to the server timezone without special-casing.
   */
  public async getTimezone(
    userId: string,
    guildId: string,
  ): Promise<string | null> {
    if (!userId || !guildId) return null;
    try {
      const row = await UserNotificationPrefs.findOne({ userId, guildId });
      const tz = row?.timezone;
      return typeof tz === "string" && tz.length > 0 ? tz : null;
    } catch (err) {
      logger.error("Failed to load user timezone", err);
      return null;
    }
  }

  /**
   * Set or clear the user's preferred display timezone (#524).
   *
   * Passing `null`/empty clears the preference ($unset) so the user falls
   * back to the server timezone. A non-empty value is validated against
   * the runtime's IANA database BEFORE hitting MongoDB; an unrecognized
   * zone throws a descriptive error. Returns the stored value (or `null`
   * when cleared).
   */
  public async setTimezone(
    userId: string,
    guildId: string,
    timezone: string | null,
  ): Promise<string | null> {
    if (!userId) throw new Error("userId required");
    if (!guildId) throw new Error("guildId required");

    if (timezone === null || timezone === "") {
      await UserNotificationPrefs.findOneAndUpdate(
        { userId, guildId },
        { $set: { updatedAt: new Date() }, $unset: { timezone: "" } },
        { new: true, upsert: true, setDefaultsOnInsert: true },
      );
      return null;
    }

    if (!isValidTimezone(timezone)) {
      throw new Error(
        `"${timezone}" is not a recognized IANA timezone identifier`,
      );
    }

    const row = await UserNotificationPrefs.findOneAndUpdate(
      { userId, guildId },
      { $set: { timezone, updatedAt: new Date() } },
      { new: true, upsert: true, setDefaultsOnInsert: true },
    );
    return row?.timezone ?? timezone;
  }
}

function rowToPrefs(row: IUserNotificationPrefs): NotificationPrefs {
  return {
    achievements: row.achievements !== false,
    digest: row.digest !== false,
    rewind: row.rewind !== false,
  };
}
