import logger from "../utils/logger.js";
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
}

function rowToPrefs(row: IUserNotificationPrefs): NotificationPrefs {
  return {
    achievements: row.achievements !== false,
    digest: row.digest !== false,
    rewind: row.rewind !== false,
  };
}
