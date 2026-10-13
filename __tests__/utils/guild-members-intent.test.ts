import { describe, it, expect } from "@jest/globals";
import { readdirSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { join, relative } from "node:path";
import { GUILD_MEMBERS_INTENT_HOWTO } from "../../src/utils/guild-members-intent.js";
import {
  categoryMetadata,
  settingsMetadata,
} from "../../src/services/config-schema.js";

/**
 * One source of truth for the GuildMembers intent guidance (#1132). The portal
 * toggle must be on BEFORE `GUILD_MEMBERS_INTENT=true` is set, because
 * requesting an intent the portal has not enabled makes login fail. A hand-
 * written "set GUILD_MEMBERS_INTENT=true" that skips the portal step sends an
 * operator straight into that failure, so these tests fail on any such copy.
 */

const SRC = fileURLToPath(new URL("../../src", import.meta.url));

/** Files that legitimately name the variable without explaining how to enable it. */
const ALLOWED = new Set([
  "utils/guild-members-intent.ts", // the definition itself
  "config/env.ts", // reads the variable
  "web/bootstrap-vars.ts", // lists it as a bootstrap variable
]);

function walk(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((e) =>
    e.isDirectory()
      ? walk(join(dir, e.name))
      : e.name.endsWith(".ts")
        ? [join(dir, e.name)]
        : [],
  );
}

describe("GUILD_MEMBERS_INTENT_HOWTO", () => {
  it("names the portal step before the env var step", () => {
    const portal = GUILD_MEMBERS_INTENT_HOWTO.indexOf("developer portal");
    const envVar = GUILD_MEMBERS_INTENT_HOWTO.indexOf(
      "GUILD_MEMBERS_INTENT=true",
    );
    expect(portal).toBeGreaterThanOrEqual(0);
    expect(envVar).toBeGreaterThan(portal);
    expect(GUILD_MEMBERS_INTENT_HOWTO).toContain("Server Members Intent");
  });
});

describe("intent guidance has a single definition", () => {
  it("no source file hand-writes GUILD_MEMBERS_INTENT in a message", () => {
    const offenders: string[] = [];
    for (const file of walk(SRC)) {
      const rel = relative(SRC, file).split("\\").join("/");
      if (ALLOWED.has(rel)) continue;
      readFileSync(file, "utf8")
        .split("\n")
        .forEach((line, i) => {
          const t = line.trim();
          const isComment =
            t.startsWith("//") || t.startsWith("*") || t.startsWith("/*");
          if (!isComment && /GUILD_MEMBERS_INTENT(?!_HOWTO)/.test(line)) {
            offenders.push(`${rel}:${i + 1}`);
          }
        });
    }
    // Use GUILD_MEMBERS_INTENT_HOWTO from utils/guild-members-intent.ts
    // instead of writing the instruction out (it carries the portal step).
    expect(offenders).toEqual([]);
  });

  it("every setting or category text that mentions the variable carries the full how-to", () => {
    const mentions = [
      ...Object.entries(settingsMetadata).map(
        ([key, m]) => [key, `${m.label} ${m.description}`] as const,
      ),
      ...Object.entries(categoryMetadata).map(
        ([key, m]) =>
          [`category ${key}`, `${m.title} ${m.description}`] as const,
      ),
    ].filter(([, text]) => text.includes("GUILD_MEMBERS_INTENT"));
    expect(mentions.length).toBeGreaterThanOrEqual(3);
    for (const [key, text] of mentions) {
      expect({ key, ok: text.includes(GUILD_MEMBERS_INTENT_HOWTO) }).toEqual({
        key,
        ok: true,
      });
    }
  });
});
