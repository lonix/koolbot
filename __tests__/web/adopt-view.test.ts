import { describe, it, expect } from "@jest/globals";
import { renderAdoptPage } from "../../src/web/adopt-view.js";
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
    onboardingRoleIds: [],
    onboardingChannelIds: [],
    onboardingPrompts: [],
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
  });
  it("has no forms: the page is read-only", () => {
    const html = renderAdoptPage({ ...common, scan });
    const main = html.slice(html.indexOf("<main"), html.indexOf("</main>"));
    expect(main).toContain("Server scan");
    expect(main).not.toMatch(/<form/i);
    expect(main).not.toMatch(/<button/i);
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
