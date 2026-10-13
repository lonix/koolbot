import { describe, it, expect } from "@jest/globals";
import { renderAdoptPage } from "../../src/web/adopt-view.js";
import { escapeHtml } from "../../src/web/html.js";
import { GUILD_MEMBERS_INTENT_HOWTO } from "../../src/utils/guild-members-intent.js";
import type { ServerScan } from "../../src/services/server-scan-service.js";

const scan: ServerScan = {
  guildId: "g1",
  guildName: "Test <b>Guild</b>",
  scannedAt: "2026-10-07T00:00:00Z",
  scanned: {} as any,
  roles: [
    {
      id: "r1",
      name: "<script>x</script>",
      color: 0xff0000,
      position: 3,
      managed: false,
      isEveryone: false,
      permissions: [],
      memberCount: 4,
      memberCountApproximate: true,
      botId: null,
      botCanManage: false,
      usedBy: ["birthdays"],
      onboardingManaged: false,
    },
  ],
  channels: [
    {
      id: "c1",
      name: "quotes",
      kind: "text",
      typeName: "GuildText",
      parentId: null,
      parentName: null,
      syncedToParent: null,
      position: 0,
      overwrites: [
        {
          id: "r1",
          type: "role",
          label: "Mod",
          allow: ["ViewChannel"],
          deny: ["SendMessages"],
        },
      ],
      usedBy: ["quotes"],
      featureGuess: null,
      gatedByRoleIds: [],
      ownerHint: null,
      flags: {
        afk: false,
        rules: false,
        system: false,
        publicUpdates: false,
        webhookFed: false,
        followed: false,
        announcement: false,
        forum: false,
        stage: false,
        onboardingDefault: false,
      },
    },
  ],
  bots: [
    {
      userId: "d",
      tag: "Dyno#1",
      roleIds: [],
      overwriteChannelIds: ["c1"],
      verified: true,
      isKoolBot: false,
    },
  ],
  readiness: {
    botUserId: "b",
    botRoleIds: [],
    highestRoleId: null,
    highestRoleName: "KoolBot",
    highestRolePosition: 2,
    roleCount: 5,
    administrator: false,
    permissions: [
      { name: "ManageRoles", granted: false, purpose: "p", required: true },
    ],
    rolesAboveBot: [],
    membersIntent: false,
    issues: [
      {
        code: "x",
        severity: "error",
        message: "Move the KoolBot role above X",
        help: "h",
      },
    ],
    ready: false,
  },
  community: {
    community: true,
    features: [],
    rulesChannelId: null,
    systemChannelId: null,
    publicUpdatesChannelId: null,
    onboardingEnabled: true,
    onboardingRoleIds: ["r1"],
    onboardingChannelIds: [],
    onboardingPrompts: [{ title: "Pick", roleIds: ["r1", "r-gone"] }],
  },
  naming: {
    pattern: "lower-kebab",
    separator: null,
    confidence: 1,
    samples: [],
    categoryEmojiPrefix: false,
    suggestedPrefix: null,
    suggestedSuffix: null,
  },
  scheduledEvents: [],
  suggestions: [{ code: "s", message: "Add AFK" }],
  partial: ["webhooks"],
};

const common = {
  csrfToken: "t",
  remainingMs: 1000,
  navFeatureStatus: {} as any,
  sampled: false,
};

describe("renderAdoptPage (#1019)", () => {
  it("renders readiness, roles, channels, bots and escapes values", () => {
    const html = renderAdoptPage({ ...common, scan });
    expect(html).toContain("Move the KoolBot role above X");
    expect(html).toContain("TROUBLESHOOTING.md");
    expect(html).toContain("&lt;script&gt;");
    expect(html).not.toContain("<script>x</script>");
    expect(html).toContain("Test &lt;b&gt;Guild");
    expect(html).toContain("Dyno#1");
    expect(html).toContain("SendMessages");
    expect(html).toContain("Some parts could not be read");
    expect(html).toContain("4+");
    expect(html).toContain("&lt;script&gt;x&lt;/script&gt;");
  });
  it("shows onboarding role names, falling back to ids", () => {
    const html = renderAdoptPage({ ...common, scan });
    expect(html).toContain("Pick");
    expect(html).toContain("r-gone");
  });
  it("has no forms: the page is read-only", () => {
    const html = renderAdoptPage({ ...common, scan });
    const main = html.slice(html.indexOf("<main"), html.indexOf("</main>"));
    expect(main).toContain("Server scan");
    expect(main).not.toMatch(/<form/i);
    expect(main).not.toMatch(/<button/i);
  });
  it("renders the bot replacement report with escaped values and verification notes", () => {
    const html = renderAdoptPage({
      ...common,
      scan: {
        ...scan,
        scanned: { config: { "moderation.enabled": true } } as any,
        bots: [
          ...scan.bots,
          {
            userId: "155149108183695360",
            tag: "Dyno#1",
            roleIds: [],
            overwriteChannelIds: [],
            verified: true,
            isKoolBot: false,
          },
          {
            userId: "204255221017214977",
            tag: "YAGPDB#1",
            roleIds: [],
            overwriteChannelIds: [],
            verified: true,
            isKoolBot: false,
          },
          {
            userId: "300000000000000001",
            tag: "<img src=x>#1",
            roleIds: [],
            overwriteChannelIds: [],
            verified: false,
            isKoolBot: false,
          },
        ],
      },
    });
    expect(html).toContain("Bot replacement report");
    expect(html).toContain("Can replace");
    expect(html).toContain("Missing:");
    expect(html).toContain("moderation.enabled");
    expect(html).toContain("Community-built bot");
    expect(html).toContain("unverified entry");
    expect(html).toContain(
      "Id checked against: id only: https://top.gg/bot/155149108183695360",
    );
    expect(html).toContain("may be out of date");
    expect(html).toContain("&lt;img src=x&gt;#1");
    expect(html).not.toContain("<img src=x>");
    expect(html).toContain("GUILD_MEMBERS_INTENT=true");
  });

  it("tells the operator how to enable the GuildMembers intent (#1121)", () => {
    const html = renderAdoptPage({ ...common, scan });
    // Roles caption plus the bot replacement report note both carry the wording.
    const escaped = escapeHtml(GUILD_MEMBERS_INTENT_HOWTO);
    expect(html).toContain(escaped);
    expect(html.split(escaped).length - 1).toBeGreaterThanOrEqual(2);
    expect(GUILD_MEMBERS_INTENT_HOWTO).toContain("GUILD_MEMBERS_INTENT=true");
    expect(GUILD_MEMBERS_INTENT_HOWTO).toContain("Server Members Intent");
    expect(GUILD_MEMBERS_INTENT_HOWTO).toContain("developer portal");
  });
  const botBase = {
    roleIds: [],
    overwriteChannelIds: [],
    isKoolBot: false,
  };
  const CATALOG_LINK = "CONTRIBUTING.md#adding-a-known-bot-entry";
  const onlyBots = (bots: any[]): string =>
    renderAdoptPage({ ...common, scan: { ...scan, bots } });

  it("links the catalogue docs on an unknown (verified, unlisted) bot card", () => {
    const html = onlyBots([
      {
        ...botBase,
        userId: "300000000000000002",
        tag: "Mystery#1",
        verified: true,
      },
    ]);
    expect(html).toContain("Not in the catalogue; no claims made");
    expect(html).toContain(CATALOG_LINK);
    expect(html).not.toContain("Community-built bot");
  });
  it("treats a bot whose verified flag is unknown as unknown, not custom", () => {
    const html = onlyBots([
      {
        ...botBase,
        userId: "300000000000000003",
        tag: "Maybe#1",
        verified: null,
      },
    ]);
    expect(html).toContain("Not in the catalogue; no claims made");
    expect(html).toContain(CATALOG_LINK);
  });
  it("shows a custom bot card without the catalogue link", () => {
    const html = onlyBots([
      {
        ...botBase,
        userId: "300000000000000004",
        tag: "Homemade#1",
        verified: false,
      },
    ]);
    expect(html).toContain("Community-built bot");
    expect(html).not.toContain(CATALOG_LINK);
  });
  it("renders a failure notice when the scan failed", () => {
    const html = renderAdoptPage({ ...common, scan: null, error: "boom <x>" });
    expect(html).toContain("The scan failed");
    expect(html).toContain("boom &lt;x&gt;");
  });
});

describe("/admin/adopt routing (#1019)", () => {
  it("is mounted for GET only: no write route exists for the page", async () => {
    const { createReadOnlyRouter } =
      await import("../../src/web/read-only-routes.js");
    const router: any = createReadOnlyRouter(
      {} as any,
      ((_q: any, _s: any, n: any) => n()) as any,
    );
    const layers = router.stack.filter((l: any) => l.route?.path === "/adopt");
    expect(layers).toHaveLength(1);
    expect(Object.keys(layers[0].route.methods)).toEqual(["get"]);
  });
});
