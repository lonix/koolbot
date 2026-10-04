import { env } from "../config/env.js";

/**
 * `/me/*` surfaces with no feature gate: they are always available whenever
 * the Web UI is on (#1016, Option A). Because at least one surface is always
 * on, `/me` needs no `me.enabled` key and is available exactly when the Web
 * UI is. If one of these ever gains a gate, add its check to
 * `isAnyMeSurfaceEnabled` — the command registry and the `/me/` nav both
 * derive from here so they cannot drift.
 */
export const UNGATED_ME_SURFACES = ["notifications", "timezone"] as const;

/** Whether at least one `/me/*` surface is enabled. */
export async function isAnyMeSurfaceEnabled(): Promise<boolean> {
  return UNGATED_ME_SURFACES.length > 0;
}

/** Whether the `/me` command should be registered: Web UI on + a surface on. */
export async function isMeCommandEnabled(): Promise<boolean> {
  return env.webui.enabled && (await isAnyMeSurfaceEnabled());
}
