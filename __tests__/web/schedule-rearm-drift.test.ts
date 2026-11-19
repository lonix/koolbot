/**
 * Drift guard for #1775: every `ScheduledService` subclass must be re-armed
 * when its schedule keys are saved from the Settings page, or be on the
 * exempt list below with a reason. An ordinary Settings save only calls
 * `ConfigService.set()`, so a service missing from `SCHEDULE_REARMS` keeps its
 * old schedule (or stays unarmed) until the bot restarts.
 */

import { describe, it, expect } from "@jest/globals";
import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { defaultConfig } from "../../src/services/config-schema.js";

const root = path.resolve(process.cwd());
const servicesDir = path.join(root, "src/services");
const rearmSource = readFileSync(
  path.join(root, "src/web/routes/write/schedule-rearm.ts"),
  "utf8",
);

/** Subclasses that need no re-arm, each with the reason. */
const EXEMPT: Readonly<Record<string, string>> = {
  AdoptionSnapshotCleanupService:
    "isEnabled() is always true and the cron is a fixed constant, so no setting can change when or whether it runs",
};

function scheduledServiceClasses(): string[] {
  const found: string[] = [];
  for (const file of readdirSync(servicesDir)) {
    if (!file.endsWith(".ts") || file === "scheduled-service.ts") continue;
    const text = readFileSync(path.join(servicesDir, file), "utf8");
    for (const m of text.matchAll(
      /export\s+class\s+(\w+)\s+extends\s+ScheduledService\b/g,
    )) {
      found.push(m[1]);
    }
  }
  return found.sort();
}

describe("SCHEDULE_REARMS covers every ScheduledService (#1775)", () => {
  const classes = scheduledServiceClasses();

  it("finds the scheduled services", () => {
    expect(classes.length).toBeGreaterThanOrEqual(13);
  });

  it.each(classes)("%s is re-armed or explicitly exempt", (cls) => {
    const rearmed = new RegExp(
      `\\b${cls}\\.getInstance\\([^)]*\\)\\.reload\\(`,
    );
    const isRearmed = rearmed.test(rearmSource);
    const isExempt = cls in EXEMPT;
    expect({ cls, isRearmed, isExempt }).toEqual({
      cls,
      isRearmed: !isExempt,
      isExempt,
    });
  });

  it("keeps the exempt list free of stale entries", () => {
    for (const cls of Object.keys(EXEMPT)) {
      expect(classes).toContain(cls);
      expect(EXEMPT[cls].length).toBeGreaterThan(10);
    }
  });

  it("only lists keys that exist in the config schema", () => {
    const block = rearmSource.slice(rearmSource.indexOf("SCHEDULE_REARMS"));
    const keys = [...block.matchAll(/"([a-z_]+(?:\.[a-z_]+)+)"/g)]
      .map((m) => m[1])
      .filter((k) => !k.endsWith(".js"));
    expect(keys.length).toBeGreaterThan(20);
    for (const key of keys) {
      expect(Object.keys(defaultConfig)).toContain(key);
    }
  });
});
