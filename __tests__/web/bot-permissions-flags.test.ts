/**
 * "All Discord permissions" (#1366): the flag classification, the bot role's
 * server-wide bits on the report, and the folded list on the page.
 */

import { describe, it, expect } from "@jest/globals";
import { PermissionFlagsBits } from "discord.js";
import {
  allFlagRows,
  FLAG_USE,
} from "../../src/services/bot-permission-flags.js";
import type {
  BotPermissionReport,
  FeatureCheck,
} from "../../src/services/bot-permission-check.js";
import {
  FEATURE_REQUIREMENTS,
  PERM,
} from "../../src/services/bot-permission-registry.js";
import {
  neededButNotInRole,
  renderBotPermissionsPage,
} from "../../src/web/bot-permissions-view.js";

const ADMIN = PermissionFlagsBits.Administrator;

function check(id: string, enabled = true): FeatureCheck {
  const r = FEATURE_REQUIREMENTS.find((x) => x.id === id);
  if (!r) throw new Error(`no registry entry ${id}`);
  return {
    feature: {
      id: r.id,
      area: r.area,
      feature: r.feature,
      effect: r.effect,
      fix: r.fix,
    },
    kind: "permission",
    enabled,
    outcome: "ok",
    target: { kind: "server", id: null, name: "the server" },
    missing: [],
  };
}

function report(extra: Partial<BotPermissionReport> = {}): BotPermissionReport {
  return {
    available: true,
    reason: null,
    fresh: true,
    problems: [],
    unknown: [],
    quiet: [],
    okFeatures: [],
    notes: [],
    checks: [],
    ...extra,
  };
}

const page = (r: BotPermissionReport): string =>
  renderBotPermissionsPage({ csrfToken: "t", remainingMs: 1000, report: r });

/** The table row of one permission, by its name. */
function rowOf(html: string, name: string): string {
  const m = html.match(
    new RegExp(`<tr><th scope="row">${name}</th>.*?</tr>`, "s"),
  );
  if (!m) throw new Error(`no row ${name}`);
  return m[0];
}

describe("flag classification", () => {
  it("classifies every discord.js permission flag (a new flag must be added to FLAG_USE)", () => {
    const registryBits = new Set(Object.values(PERM).map((p) => p.bit));
    const unclassified = allFlagRows().filter(
      (r) => r.use.kind === "unclassified",
    );
    expect(unclassified.map((r) => r.key)).toEqual([]);
    // Everything in FLAG_USE names a real flag, and registry flags are not repeated there.
    for (const key of Object.keys(FLAG_USE)) {
      expect(PermissionFlagsBits).toHaveProperty(key);
      expect(registryBits.has(PermissionFlagsBits[key as never])).toBe(false);
    }
  });

  it("shows a flag discord.js adds later as unclassified, never as unused", () => {
    const rows = allFlagRows({
      ...PermissionFlagsBits,
      BrandNewFlag: 1n << 60n,
    });
    expect(rows.find((r) => r.key === "BrandNewFlag")?.use.kind).toBe(
      "unclassified",
    );
  });

  it("lists one row per distinct bit", () => {
    const rows = allFlagRows();
    expect(new Set(rows.map((r) => r.bit)).size).toBe(rows.length);
    expect(rows.length).toBe(new Set(Object.values(PermissionFlagsBits)).size);
  });

  it("marks what the page checks, and never calls a permission KoolBot posts or moderates with unused", () => {
    const byKey = new Map(allFlagRows().map((r) => [r.key, r.use.kind]));
    expect(byKey.get("ManageNicknames")).toBe("checked");
    for (const key of [
      "SendMessages",
      "EmbedLinks",
      "ReadMessageHistory",
      "ManageMessages",
      "PinMessages",
      "BanMembers",
      "KickMembers",
      "ModerateMembers",
    ]) {
      expect(byKey.get(key)).toBe("used");
    }
    for (const key of ["MentionEveryone", "SendPolls", "ManageGuild"]) {
      expect(byKey.get(key)).toBe("used");
    }
    expect(byKey.get("CreateInstantInvite")).toBe("unused");
  });
});

describe("neededButNotInRole", () => {
  it("names what switched-on features need and the role does not hold itself", () => {
    const r = report({
      checks: [check("event-tags"), check("reaction-roles", false)],
    });
    expect(neededButNotInRole(r, ADMIN)).toEqual(["Manage Nicknames"]);
    expect(neededButNotInRole(r, ADMIN | PERM.manageNicknames.bit)).toEqual([]);
  });

  it("treats an either-is-enough need as met when one of them is held", () => {
    const r = report({ checks: [check("event-native")] });
    expect(neededButNotInRole(r, ADMIN)).toEqual([
      "Create Events or Manage Events",
    ]);
    expect(neededButNotInRole(r, ADMIN | PERM.manageEvents.bit)).toEqual([]);
  });
});

describe("the All Discord permissions list", () => {
  it("is absent when the bot role's bits are unknown", () => {
    expect(page(report())).not.toContain("All Discord permissions");
    expect(page(report({ serverPermissions: null }))).not.toContain(
      "All Discord permissions",
    );
  });

  it("is folded, has a row per permission, and uses the role's own bits", () => {
    const html = page(
      report({ serverPermissions: PermissionFlagsBits.SendMessages }),
    );
    expect(html).toContain('<details class="kb-disclosure">');
    expect(rowOf(html, "Send Messages")).toContain("Has");
    expect(rowOf(html, "Send Messages")).toContain("Used, not checked");
    expect(rowOf(html, "Create Invite")).toContain("Not in the role");
    expect(rowOf(html, "Create Invite")).toContain("Not used by KoolBot");
    expect(rowOf(html, "Manage Nicknames")).toContain("Checked in the table");
    expect(html).not.toContain("Administrator covers it");
  });

  it("with Administrator, rows still show the role's own bits and the warning names what would break", () => {
    const html = page(
      report({
        serverPermissions: ADMIN | PermissionFlagsBits.ManageChannels,
        checks: [check("event-tags")],
      }),
    );
    expect(rowOf(html, "Manage Channels")).toContain("Has");
    expect(rowOf(html, "Kick Members")).toContain("Administrator covers it");
    const admin = rowOf(html, "Administrator");
    expect(admin).toContain("not required");
    expect(admin).toContain("<strong>Manage Nicknames</strong>");
    expect(admin).toContain("Before you remove it");
    expect(admin).toContain("channel overwrites that deny something");
  });

  it("never says Administrator is safe to remove without the unchecked permissions and overwrites", () => {
    const html = page(
      report({
        serverPermissions: ADMIN | PERM.manageNicknames.bit,
        checks: [check("event-tags")],
      }),
    );
    const admin = rowOf(html, "Administrator");
    expect(admin).toContain("holds the checked server-wide permissions");
    expect(admin).toContain("Used, not checked on this page");
    expect(admin).toContain("channel overwrites that deny something");
    expect(admin).not.toContain("consider removing");
  });

  it("does not mention removing Administrator when the role does not hold it", () => {
    const html = page(report({ serverPermissions: 0n }));
    expect(rowOf(html, "Administrator")).not.toContain("remove");
  });
});
