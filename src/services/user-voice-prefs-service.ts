/**
 * Single source of truth for per-user voice-channel preferences (#656).
 *
 * Both the Discord modal/button handlers (`vc-modal-handler`,
 * `vc-preset-handler`) and the `/me/voice` web surface go through this
 * service so the validation rules — name bounds, max-per-user, user-limit
 * and bitrate bounds, name-pattern length — can never diverge between the
 * two surfaces. The service is pure data + validation; anything that
 * touches a live Discord channel (applying a preset, naming a freshly
 * spawned channel) stays in the caller.
 *
 * Preferences are keyed by Discord `userId` only (presets are global to a
 * user, not per-guild — see `models/user-voice-preferences.ts`).
 */

import {
  UserVoicePreferences,
  IChannelPreset,
  IUserVoicePreferences,
} from "../models/user-voice-preferences.js";

// Bounds shared by every write path. Kept in sync with the Mongoose schema
// in `models/user-voice-preferences.ts`.
export const PRESET_NAME_MAX = 50;
export const CHANNEL_NAME_MAX = 100;
export const USER_LIMIT_MIN = 0;
export const USER_LIMIT_MAX = 99;
export const BITRATE_MIN = 8;
export const BITRATE_MAX = 384;
export const NAME_PATTERN_MAX = 100;

/**
 * Thrown by validating writes with a user-facing message. Callers surface
 * `.message` directly (Discord reply / web flash) — keep messages friendly.
 */
export class VoicePrefsValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "VoicePrefsValidationError";
  }
}

export interface PresetSnapshot {
  channelName?: string;
  userLimit?: number;
  bitrate?: number;
}

export interface PresetEdit {
  name: string;
  channelName?: string;
  userLimit?: number;
  bitrate?: number;
}

/**
 * Apply a user's naming pattern to produce a channel name.
 *
 * Substitutes `{username}` / `{displayName}` (case-insensitive) with the
 * member's display name, trims, and clamps to Discord's 100-char channel
 * name limit. Returns `null` when the result is empty so the caller can
 * fall back to the default naming scheme.
 */
export function applyNamePattern(
  pattern: string,
  displayName: string,
): string | null {
  const substituted = pattern
    .replace(/\{username\}/gi, displayName)
    .replace(/\{displayname\}/gi, displayName)
    .trim();
  if (substituted.length === 0) return null;
  return substituted.slice(0, CHANNEL_NAME_MAX);
}

export class UserVoicePrefsService {
  private static instance: UserVoicePrefsService | null = null;

  static getInstance(): UserVoicePrefsService {
    if (!UserVoicePrefsService.instance) {
      UserVoicePrefsService.instance = new UserVoicePrefsService();
    }
    return UserVoicePrefsService.instance;
  }

  /** Load (or lazily create) the preferences document for a user. */
  async getPrefs(userId: string): Promise<IUserVoicePreferences> {
    return (
      (await UserVoicePreferences.findOne({ userId })) ??
      (await UserVoicePreferences.create({ userId, presets: [] }))
    );
  }

  // ---------- Validation helpers ----------

  validatePresetName(raw: string): string {
    const name = raw.trim();
    if (name.length === 0 || name.length > PRESET_NAME_MAX) {
      throw new VoicePrefsValidationError(
        `Preset name must be 1–${PRESET_NAME_MAX} characters.`,
      );
    }
    return name;
  }

  /**
   * Normalise a name pattern: trims, treats empty as "cleared" (`null`),
   * and enforces the length cap. Returns the value to store.
   */
  validateNamePattern(raw: string | null): string | null {
    if (raw === null) return null;
    const pattern = raw.trim();
    if (pattern.length === 0) return null;
    if (pattern.length > NAME_PATTERN_MAX) {
      throw new VoicePrefsValidationError(
        `Name pattern must be ${NAME_PATTERN_MAX} characters or less.`,
      );
    }
    return pattern;
  }

  /** Validate an optional channel-name override (preset field). */
  validateChannelName(raw: string | undefined): string | undefined {
    if (raw === undefined) return undefined;
    const name = raw.trim();
    if (name.length === 0) return undefined;
    if (name.length > CHANNEL_NAME_MAX) {
      throw new VoicePrefsValidationError(
        `Channel name must be ${CHANNEL_NAME_MAX} characters or less.`,
      );
    }
    return name;
  }

  /** Validate an optional user limit (0 = unlimited). */
  validateUserLimit(raw: number | undefined): number | undefined {
    if (raw === undefined) return undefined;
    if (
      !Number.isInteger(raw) ||
      raw < USER_LIMIT_MIN ||
      raw > USER_LIMIT_MAX
    ) {
      throw new VoicePrefsValidationError(
        `User limit must be a whole number between ${USER_LIMIT_MIN} and ${USER_LIMIT_MAX} (0 = unlimited).`,
      );
    }
    return raw;
  }

  /** Validate an optional bitrate in kbps. */
  validateBitrate(raw: number | undefined): number | undefined {
    if (raw === undefined) return undefined;
    if (!Number.isInteger(raw) || raw < BITRATE_MIN || raw > BITRATE_MAX) {
      throw new VoicePrefsValidationError(
        `Bitrate must be a whole number between ${BITRATE_MIN} and ${BITRATE_MAX} kbps.`,
      );
    }
    return raw;
  }

  // ---------- Name pattern ----------

  async getNamePattern(userId: string): Promise<string | null> {
    const prefs = await UserVoicePreferences.findOne({ userId }).lean();
    return prefs?.namePattern ?? null;
  }

  /**
   * Persist a name pattern (or clear it with `null`/empty). Returns the
   * stored value so callers can report the normalised result.
   */
  async setNamePattern(
    userId: string,
    raw: string | null,
  ): Promise<string | null> {
    const value = this.validateNamePattern(raw);
    const prefs = await this.getPrefs(userId);
    prefs.namePattern = value ?? undefined;
    await prefs.save();
    return value;
  }

  // ---------- Preset writes ----------

  /**
   * Save a snapshot of the current channel as a named preset, or update an
   * existing preset of the same name (case-insensitive). Enforces the
   * max-per-user cap for genuinely new presets.
   *
   * Returns whether an existing preset was updated (vs. created) so the
   * caller can word its confirmation.
   */
  async savePreset(
    userId: string,
    rawName: string,
    snapshot: PresetSnapshot,
    maxPerUser: number,
  ): Promise<{ updated: boolean; name: string }> {
    const name = this.validatePresetName(rawName);
    const prefs = await this.getPrefs(userId);

    const existingIndex = prefs.presets.findIndex(
      (p) => p.name.toLowerCase() === name.toLowerCase(),
    );

    if (existingIndex === -1 && prefs.presets.length >= maxPerUser) {
      throw new VoicePrefsValidationError(
        `You already have ${maxPerUser} presets (the configured maximum). Delete one first or rename an existing preset.`,
      );
    }

    const preset: IChannelPreset = {
      name,
      channelName: this.validateChannelName(snapshot.channelName),
      userLimit: this.validateUserLimit(snapshot.userLimit),
      bitrate: this.validateBitrate(snapshot.bitrate),
      isDefault:
        existingIndex !== -1 ? !!prefs.presets[existingIndex].isDefault : false,
    };

    if (existingIndex !== -1) {
      prefs.presets[existingIndex] = preset;
    } else {
      prefs.presets.push(preset);
    }
    prefs.markModified("presets");
    await prefs.save();
    return { updated: existingIndex !== -1, name };
  }

  /**
   * Rename a preset by index. `expectedName`, when supplied, guards against
   * a stale web form acting on the wrong row after the list shifted.
   */
  async renamePreset(
    userId: string,
    index: number,
    rawNewName: string,
    expectedName?: string,
  ): Promise<{ oldName: string; newName: string }> {
    const newName = this.validatePresetName(rawNewName);
    const prefs = await this.getPrefs(userId);
    const preset = prefs.presets[index];
    if (
      !preset ||
      (expectedName !== undefined && preset.name !== expectedName)
    ) {
      throw new VoicePrefsValidationError("Preset no longer exists.");
    }

    const collision = prefs.presets.findIndex(
      (p, i) => i !== index && p.name.toLowerCase() === newName.toLowerCase(),
    );
    if (collision !== -1) {
      throw new VoicePrefsValidationError(
        `You already have a preset named "${newName}".`,
      );
    }

    const oldName = preset.name;
    preset.name = newName;
    prefs.markModified("presets");
    await prefs.save();
    return { oldName, newName };
  }

  /**
   * Edit a preset's full field set (name + channelName + userLimit +
   * bitrate) in one write. Used by the web surface where all fields are
   * editable at once. `isDefault` is preserved.
   */
  async editPreset(
    userId: string,
    index: number,
    edit: PresetEdit,
    expectedName?: string,
  ): Promise<{ name: string }> {
    const name = this.validatePresetName(edit.name);
    const channelName = this.validateChannelName(edit.channelName);
    const userLimit = this.validateUserLimit(edit.userLimit);
    const bitrate = this.validateBitrate(edit.bitrate);

    const prefs = await this.getPrefs(userId);
    const preset = prefs.presets[index];
    if (
      !preset ||
      (expectedName !== undefined && preset.name !== expectedName)
    ) {
      throw new VoicePrefsValidationError("Preset no longer exists.");
    }

    const collision = prefs.presets.findIndex(
      (p, i) => i !== index && p.name.toLowerCase() === name.toLowerCase(),
    );
    if (collision !== -1) {
      throw new VoicePrefsValidationError(
        `You already have a preset named "${name}".`,
      );
    }

    preset.name = name;
    preset.channelName = channelName;
    preset.userLimit = userLimit;
    preset.bitrate = bitrate;
    prefs.markModified("presets");
    await prefs.save();
    return { name };
  }

  /** Delete a preset by index, returning the removed name and remaining count. */
  async deletePreset(
    userId: string,
    index: number,
    expectedName?: string,
  ): Promise<{ name: string; remaining: number }> {
    const prefs = await this.getPrefs(userId);
    const preset = prefs.presets[index];
    if (
      !preset ||
      (expectedName !== undefined && preset.name !== expectedName)
    ) {
      throw new VoicePrefsValidationError("Preset no longer exists.");
    }

    const name = preset.name;
    prefs.presets.splice(index, 1);
    prefs.markModified("presets");
    await prefs.save();
    return { name, remaining: prefs.presets.length };
  }

  /**
   * Toggle (or set) which preset auto-applies on the next channel spawn.
   * Only one preset can be the default; setting one clears the others.
   * Returns the new default state of the targeted preset.
   */
  async setDefault(
    userId: string,
    index: number,
    expectedName?: string,
  ): Promise<{ name: string; isDefault: boolean }> {
    const prefs = await this.getPrefs(userId);
    const target = prefs.presets[index];
    if (
      !target ||
      (expectedName !== undefined && target.name !== expectedName)
    ) {
      throw new VoicePrefsValidationError("Preset no longer exists.");
    }

    const wasDefault = !!target.isDefault;
    prefs.presets.forEach((p) => {
      p.isDefault = false;
    });
    if (!wasDefault) target.isDefault = true;
    prefs.markModified("presets");
    await prefs.save();
    return { name: target.name, isDefault: !wasDefault };
  }
}
