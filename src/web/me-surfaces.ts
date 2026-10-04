import { env } from "../config/env.js";
import { ConfigService } from "../services/config-service.js";

/**
 * Single derivation of which `/me/*` surfaces are enabled (#1016). The
 * `/me/` routes/nav (`readUserFeatureFlags` in `user-routes.ts`) and the
 * `/me` command registration both read from here, so they cannot drift.
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

/** Whether at least one `/me/*` surface is enabled. */
export async function isAnyMeSurfaceEnabled(): Promise<boolean> {
  if (UNGATED_ME_SURFACES.length > 0) return true;
  return Object.values(await readMeSurfaceFlags()).some(Boolean);
}

/** Whether the `/me` command should be registered: Web UI on + a surface on. */
export async function isMeCommandEnabled(): Promise<boolean> {
  return env.webui.enabled && (await isAnyMeSurfaceEnabled());
}
