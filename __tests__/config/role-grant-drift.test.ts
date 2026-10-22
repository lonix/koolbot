/**
 * Drift guard for roles that features hand to members (#1321).
 *
 * A role mapped to Admins, Moderators or Event hosts must not also be handed
 * out by a feature, or everyone that feature qualifies would get that access.
 * The guards (Settings, wizard, Access step, "used by") all read one list in
 * `role-grants.ts`. These tests fail when a role setting or a role-granting
 * code path exists that the list does not know about.
 */

import { describe, it, expect } from "@jest/globals";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  defaultConfig,
  settingsMetadata,
} from "../../src/services/config-schema.js";
import {
  ROLE_GRANTING_SETTINGS,
  ROLE_GRANT_CODE,
  ROLE_SETTINGS_NOT_GRANTING,
} from "../../src/services/role-grants.js";

const SRC = fileURLToPath(new URL("../../src/", import.meta.url));

const granting = new Set(ROLE_GRANTING_SETTINGS.map((s) => s.key));
const notGranting = new Set(Object.keys(ROLE_SETTINGS_NOT_GRANTING));

/** Keys whose last segment names a role or roles (`rules.role_id`, `*_roles`). */
const NAMED_LIKE_A_ROLE = /(^|[._])roles?(_ids?)?$/;

describe("role-typed settings", () => {
  const roleKeys = Object.entries(settingsMetadata)
    .filter(
      ([key, meta]) =>
        meta.type === "role" ||
        meta.type === "role_list" ||
        NAMED_LIKE_A_ROLE.test(key.split(".").slice(-1)[0]),
    )
    .map(([key]) => key);

  it("finds the role settings the schema has", () => {
    expect(roleKeys).toEqual(
      expect.arrayContaining(["rules.role_id", "birthdays.role_id"]),
    );
  });

  it.each(roleKeys)("%s is guarded or explicitly marked as safe", (key) => {
    expect(granting.has(key) || notGranting.has(key)).toBe(true);
  });

  it("covers role ids kept inside another kind of setting", () => {
    expect(granting.has("leaderboard_roles.tiers")).toBe(true);
  });

  it("lists only settings that exist, in one place only", () => {
    for (const key of [...granting, ...notGranting]) {
      expect(Object.keys(defaultConfig)).toContain(key);
    }
    for (const key of granting) expect(notGranting.has(key)).toBe(false);
  });

  it("gives every safe setting a reason", () => {
    for (const reason of Object.values(ROLE_SETTINGS_NOT_GRANTING)) {
      expect(reason.length).toBeGreaterThan(10);
    }
  });
});

describe("code that adds a role to a member", () => {
  function files(dir: string): string[] {
    return fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
      const full = path.join(dir, e.name);
      if (e.isDirectory()) return files(full);
      return e.name.endsWith(".ts") ? [full] : [];
    });
  }
  const adders = files(SRC)
    .filter((f) => /roles\.add\(|\.addRole\(/.test(fs.readFileSync(f, "utf8")))
    .map((f) => path.relative(SRC, f).split(path.sep).join("/"))
    .sort();

  it("is known: a new file that grants roles must be added to ROLE_GRANT_CODE", () => {
    expect(adders).toEqual(Object.keys(ROLE_GRANT_CODE).sort());
  });
});

describe("grant-time guard (#1375)", () => {
  // Configuration-time guards only run when a setting is saved. A combination
  // stored earlier, or created some other way, is stopped when the grant
  // happens, so every file behind a role-granting setting must ask the role
  // groups (any scope) before it adds the role.
  const featureFiles = Object.entries(ROLE_GRANT_CODE)
    .filter(([, key]) => granting.has(key))
    .map(([file]) => file);

  it("finds the features that grant through a setting", () => {
    expect([...featureFiles].sort()).toEqual([
      "services/birthday-service.ts",
      "services/leaderboard-role-service.ts",
      "services/raid-protection-service.ts",
      "services/rules-service.ts",
    ]);
  });

  it.each(featureFiles)(
    "%s refuses a group-backed role before granting it",
    (file) => {
      const text = fs.readFileSync(path.join(SRC, file), "utf8");
      expect(text).toMatch(/\.groupBackedRoles\(/);
      expect(text).toMatch(
        /(automaticGrantBlockReason|groupBackedBlockReason)\(/,
      );
    },
  );
});
