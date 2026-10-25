/**
 * Where the permission notice (#1490) sits on the Reaction roles, Role groups
 * and Leaderboard roles pages, and what each view makes of the notice it is
 * given. What the notice says is in `permission-notice.test.ts`.
 */

import { describe, it, expect } from "@jest/globals";
import { ChannelType } from "discord.js";
import {
  renderLeaderboardRolesPage,
  renderReactionRolesPage,
} from "../../src/web/admin-views.js";
import { renderRoleGroupsPage } from "../../src/web/role-groups-views.js";
import type { PermissionNotice } from "../../src/web/permission-notice.js";

const COMMON = { csrfToken: "t", remainingMs: 60_000 };

const feature = (id: string, area: string, name: string) => ({
  id,
  area,
  feature: name,
  effect: `${name} does not work.`,
  fix: "",
});

const missingRole: PermissionNotice = {
  unavailable: null,
  stale: false,
  unchecked: [],
  missing: [
    {
      feature: feature(
        "leaderboard-roles-hierarchy",
        "Leaderboard roles",
        "Handing out leaderboard roles",
      ),
      permissions: ["Bot role below this role"],
      target: { kind: "role", id: "r1", name: "Top Voice" },
    },
  ],
};
const unreadable: PermissionNotice = {
  unavailable: null,
  stale: true,
  missing: [],
  unchecked: [
    {
      feature: feature(
        "leaderboard-roles-hierarchy",
        "Leaderboard roles",
        "Handing out leaderboard roles",
      ),
      target: { kind: "role", id: "r1", name: "Top Voice" },
      note: "The bot's own roles could not be read.",
    },
  ],
};
const unavailable: PermissionNotice = {
  unavailable: "The bot could not read this server from Discord.",
  stale: false,
  missing: [],
  unchecked: [],
};

const pages: [string, (n: PermissionNotice | null) => string, string][] = [
  [
    "Reaction roles",
    (n) =>
      renderReactionRolesPage({
        ...COMMON,
        enabled: true,
        configChannel: { name: "r", id: "c1", type: ChannelType.GuildText },
        active: [],
        archived: [],
        textChannels: [],
        permissionNotice: n,
      }),
    "kb-statusline",
  ],
  [
    "Leaderboard roles",
    (n) =>
      renderLeaderboardRolesPage({
        ...COMMON,
        enabled: true,
        voiceTrackingEnabled: true,
        period: "week",
        cron: "0 0 * * 1",
        tiers: [],
        ignoredEntries: [],
        roles: [],
        settingRows: [],
        pickers: {
          textChannels: [],
          voiceChannels: [],
          categoryChannels: [],
          roles: [],
        },
        permissionNotice: n,
      }),
    "kb-statusline",
  ],
  [
    "Role groups",
    (n) =>
      renderRoleGroupsPage({
        ...COMMON,
        groups: [],
        roleOptions: [],
        plan: null,
        extraErrors: [],
        botScanUnavailable: false,
        botsMissing: 0,
        adminReport: null,
        adminGroupLacksAdministrator: false,
        membersUnavailable: false,
        roleNames: {},
        globalPolicy: "flag",
        permissionNotice: n,
      }),
    // This page has no status line: the notice leads the first card.
    "<h2>Groups</h2>",
  ],
];

describe.each(pages)("%s page", (_name, render, anchor) => {
  it("renders nothing without a notice", () => {
    expect(render(null)).not.toContain("data-permission-notice");
    expect(render(null)).not.toContain("Open Bot permissions");
  });

  it("names the role for a role-position finding", () => {
    const html = render(missingRole);
    expect(html).toContain("for the role “Top Voice”");
    expect(html).toContain("<strong>Bot role below this role</strong>");
    expect(html).toContain('href="/admin/bot-permissions"');
  });

  it("lists an unreadable hierarchy as could not be checked, with its note and the cache label", () => {
    const html = render(unreadable);
    expect(html).toContain("Some bot permissions could not be checked");
    expect(html).toContain("The bot&#39;s own roles could not be read.");
    expect(html).toContain("may be out of date");
  });

  it("says the whole check could not run, with the reason", () => {
    const html = render(unavailable);
    expect(html).toContain("Bot permissions could not be checked");
    expect(html).toContain("The bot could not read this server from Discord.");
  });

  it("places the notice under the status line (or before the first card)", () => {
    const html = render(missingRole);
    const at = html.indexOf("data-permission-notice");
    expect(at).toBeGreaterThan(-1);
    if (anchor === "kb-statusline") {
      expect(html.indexOf(anchor)).toBeGreaterThan(-1);
      expect(html.indexOf(anchor)).toBeLessThan(at);
    } else {
      expect(at).toBeLessThan(html.indexOf(anchor));
    }
  });
});
