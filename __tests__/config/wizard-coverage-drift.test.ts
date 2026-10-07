import { describe, it, expect } from "@jest/globals";
import {
  defaultConfig,
  settingsMetadata,
} from "../../src/services/config-schema.js";
import {
  WIZARD_FEATURE_ORDER,
  WIZARD_FEATURE_SETTINGS,
} from "../../src/web/routes/write/helpers.js";

/**
 * Guards the Setup Wizard against drifting away from `config-schema.ts`
 * (#1043). CLAUDE.md says multi-setting features belong in the wizard, but
 * nothing enforced it, so six features went unwired.
 *
 * A category with two or more keys must either be a wizard step or be listed
 * here with a reason. Add to this list only for settings that are not a
 * first-time-setup feature.
 */
const WIZARD_OPT_OUT: Record<string, string> = {
  core: "Bot-wide plumbing (logging, startup); configured on the Settings page.",
  privacy: "Data-handling policy, deliberately not part of feature setup.",
  ratelimit: "Operational tuning, not first-time setup.",
  messagetracking: "Tracking tunables, configured on the Settings page.",
  reactiontracking: "Tracking tunables, configured on the Settings page.",
  rewind: "Annual nudge with its own admin handling.",
  celebrations: "Piggybacks on achievements; single channel opt-in.",
  adoption:
    "Server Adoption has its own Web UI flow (Role Groups); retention and sync tunables live on the Settings page.",
};

describe("Setup Wizard coverage", () => {
  const counts = new Map<string, number>();
  for (const meta of Object.values(settingsMetadata)) {
    counts.set(meta.category, (counts.get(meta.category) ?? 0) + 1);
  }
  const multi = [...counts].filter(([, n]) => n >= 2).map(([c]) => c);

  it("wires every multi-setting category or opts it out explicitly", () => {
    const missing = multi.filter(
      (c) => !WIZARD_FEATURE_ORDER.includes(c) && !(c in WIZARD_OPT_OUT),
    );
    expect(missing).toEqual([]);
  });

  it("does not keep opt-outs for categories that are now wired", () => {
    const stale = Object.keys(WIZARD_OPT_OUT).filter((c) =>
      WIZARD_FEATURE_ORDER.includes(c),
    );
    expect(stale).toEqual([]);
  });

  it("has a settings list for every wizard step, using real keys", () => {
    for (const fk of WIZARD_FEATURE_ORDER) {
      const keys = WIZARD_FEATURE_SETTINGS[fk];
      expect(keys?.length).toBeGreaterThan(0);
      for (const k of keys) expect(k in defaultConfig).toBe(true);
      expect(keys[0]).toBe(`${fk}.enabled`);
    }
  });
});
