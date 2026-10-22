import { env } from "../config/env.js";
import { ConfigService } from "../services/config-service.js";
import { defaultConfig } from "../services/config-schema.js";
import { isRewindNudgeEnabled } from "../services/rewind-nudge-config.js";
import type { NotificationPrefKey } from "../services/user-notification-prefs-service.js";

/**
 * Single derivation of which `/me/*` surfaces are enabled (#1016). The
 * `/me/` routes/nav (`readUserFeatureFlags` in `user-routes.ts`) and the
 * `/me` command registration both read from here, so they cannot drift. The
 * pages read it strictly (`readMeSurfaceFlagsStrict`, #1292).
 */

/** Feature-gated surfaces and the config key that gates each. */
export const GATED_ME_SURFACES = {
  rewindEnabled: "rewind.enabled",
  presetsEnabled: "voicechannels.presets.enabled",
  birthdayEnabled: "birthdays.enabled",
  privacyEnabled: "privacy.enabled",
} as const;

export type MeSurfaceFlags = Record<keyof typeof GATED_ME_SURFACES, boolean>;

/**
 * `/me/*` surfaces with no feature gate (#1016, Option A): always available
 * whenever the Web UI is on. If one gains a gate, move it to
 * `GATED_ME_SURFACES`.
 */
export const UNGATED_ME_SURFACES = ["notifications", "timezone"] as const;

/** Enabled-state of every feature-gated `/me/*` surface. */
export async function readMeSurfaceFlags(): Promise<MeSurfaceFlags> {
  const config = ConfigService.getInstance();
  const entries = await Promise.all(
    Object.entries(GATED_ME_SURFACES).map(
      async ([flag, key]) =>
        [flag, await config.getBoolean(key, false)] as const,
    ),
  );
  return Object.fromEntries(entries) as MeSurfaceFlags;
}

/**
 * `readMeSurfaceFlags` for the pages themselves (#1292): a failed read rejects
 * (the route's error handler answers 500) instead of reading as off. The
 * pages hide a switched-off feature and answer 404 for it, so a database
 * hiccup must not take a page that is on away from the member. The lenient
 * reader above stays for callers that only decide whether something is
 * offered at all (command registration, scope-gated routers).
 */
export async function readMeSurfaceFlagsStrict(): Promise<MeSurfaceFlags> {
  const config = ConfigService.getInstance();
  const entries = await Promise.all(
    Object.entries(GATED_ME_SURFACES).map(
      async ([flag, key]) =>
        [flag, await config.getBooleanStrict(key, false)] as const,
    ),
  );
  return Object.fromEntries(entries) as MeSurfaceFlags;
}

/**
 * Whether the DM behind each `/me/notifications` row can actually be sent
 * (#1292), so only those rows are offered. Stored choices are never touched:
 * a hidden row keeps its value and shows it again when the feature is back.
 *
 * `Record<NotificationPrefKey, ...>` makes a new preference a compile error
 * until it says what gates it. Strict reads, as `readMeSurfaceFlagsStrict`.
 */
export type MeNotificationAvailability = Record<NotificationPrefKey, boolean>;

export async function readMeNotificationAvailability(
  flags: MeSurfaceFlags,
): Promise<MeNotificationAvailability> {
  const config = ConfigService.getInstance();
  // An absent setting reads as its schema default (the DM switch defaults on).
  const on = (key: keyof typeof defaultConfig): Promise<boolean> =>
    config.getBooleanStrict(key, defaultConfig[key] === true);
  const [achievements, achievementDms, digest, nudge] = await Promise.all([
    on("achievements.enabled"),
    on("achievements.dm_notifications.enabled"),
    on("digest.enabled"),
    isRewindNudgeEnabled((key, fallback) =>
      config.getBooleanStrict(key, fallback),
    ),
  ]);
  return {
    achievements: achievements && achievementDms,
    digest,
    // `nudge` already includes the Rewind page; the flag keeps this row
    // aligned with the page gate even if the helper changes.
    rewind: flags.rewindEnabled && nudge,
  };
}

/** Whether at least one `/me/*` surface is enabled. */
export async function isAnyMeSurfaceEnabled(): Promise<boolean> {
  if (UNGATED_ME_SURFACES.length > 0) return true;
  return Object.values(await readMeSurfaceFlags()).some(Boolean);
}

/** Whether the `/me` command should be registered: Web UI on + a surface on. */
export async function isMeCommandEnabled(): Promise<boolean> {
  return env.webui.enabled && (await isAnyMeSurfaceEnabled());
}
