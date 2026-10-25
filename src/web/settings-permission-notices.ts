/**
 * The bot-permission notice on the sections of All settings (#1487).
 *
 * Celebrations, welcome messages, looking for group, the weekly voice stats
 * announcements and the Discord log channels have no admin page of their own, so
 * the notice from `permission-notice.ts` (#1253) cannot sit on a page for them.
 * `SETTINGS_NOTICE_AREAS` maps a Settings category to the registry areas whose
 * entries belong in that section; a new registry entry in a mapped area shows up
 * without another edit, and mapping one more category is one more line.
 *
 * The page runs the check once (`loadPermissionReport`, which shares one Discord
 * read per `SNAPSHOT_TTL_MS`) and splits the report per section with
 * `buildPermissionNotice`. It follows the same rules as the other pages: only
 * enabled features with a channel set, never "all is well", and "could not be
 * checked" with the reason when the check cannot run.
 */

import type { Client } from "discord.js";
import {
  FEATURE_REQUIREMENTS,
  type FeatureRequirement,
} from "../services/bot-permission-registry.js";
import { defaultConfig, isEnabledValue } from "../services/config-schema.js";
import {
  buildPermissionNotice,
  inAreas,
  loadPermissionReport,
  type LoadOptions,
  type PermissionNotice,
} from "./permission-notice.js";

/**
 * Settings category -> registry areas shown at the top of that section. Every
 * area must exist in the registry (a test fails on a renamed one).
 */
export const SETTINGS_NOTICE_AREAS: Readonly<
  Record<string, readonly string[]>
> = {
  celebrations: ["Celebrations"],
  welcome: ["Welcome messages"],
  lfg: ["Looking for group"],
  voicetracking: ["Voice stats"],
  core: ["Discord logging"],
};

/** The value of a setting as the page shows it, else the schema default. */
export type SettingValueOf = (key: string) => unknown;

function isSet(value: unknown): boolean {
  return typeof value === "string" ? value.trim() !== "" : Boolean(value);
}

function inUse(r: FeatureRequirement, valueOf: SettingValueOf): boolean {
  const on = (key: string): boolean => isEnabledValue(valueOf(key));
  if (r.enabledKey && !on(r.enabledKey)) return false;
  if (!(r.alsoKeys ?? []).every(on)) return false;
  return !r.targetKey || isSet(valueOf(r.targetKey));
}

/**
 * Whether a section has a feature that is switched on with its channel set,
 * read from the values the page shows. Used when the check cannot run, where
 * the report has no per-feature answer, so a section whose features are all off
 * stays quiet.
 */
export function sectionInUse(
  category: string,
  valueOf: SettingValueOf,
): boolean {
  const areas = SETTINGS_NOTICE_AREAS[category];
  if (!areas) return false;
  return FEATURE_REQUIREMENTS.some(
    (r) => areas.includes(r.area) && inUse(r, valueOf),
  );
}

export interface SettingsNoticeOptions {
  client: Client;
  guildId: string;
  /** The sections on the page, with the values it shows. */
  groups: ReadonlyArray<{
    category: string;
    rows: ReadonlyArray<{ key: string; current: unknown }>;
  }>;
  check?: LoadOptions["check"];
  timeoutMs?: number;
}

/**
 * One notice per mapped section on the page. One check for the whole page, and
 * none at all when no mapped section has a feature in use. A section without a
 * notice is absent from the result.
 */
export async function loadSettingsPermissionNotices(
  opts: SettingsNoticeOptions,
): Promise<Record<string, PermissionNotice>> {
  const values = new Map<string, unknown>();
  for (const g of opts.groups) {
    for (const r of g.rows) values.set(r.key, r.current);
  }
  const valueOf: SettingValueOf = (key) =>
    values.has(key)
      ? values.get(key)
      : (defaultConfig as unknown as Record<string, unknown>)[key];
  const sections = opts.groups
    .map((g) => g.category)
    .filter((c) => c in SETTINGS_NOTICE_AREAS);
  const active = sections.filter((c) => sectionInUse(c, valueOf));
  const notices: Record<string, PermissionNotice> = {};
  if (active.length === 0) return notices;
  const report = await loadPermissionReport(opts);
  for (const category of active) {
    const notice = buildPermissionNotice(report, {
      enabled: true,
      filter: inAreas(...SETTINGS_NOTICE_AREAS[category]),
    });
    if (notice) notices[category] = notice;
  }
  return notices;
}
