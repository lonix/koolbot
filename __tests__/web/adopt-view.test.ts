import { describe, it, expect } from "@jest/globals";
import {
  parseScanTab,
  renderAdoptPage,
  suggestionAction,
  SCAN_TABS,
  type ScanTab,
} from "../../src/web/adopt-view.js";
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
      {
        name: "ManageRoles",
        granted: false,
        purpose: "Hand out roles to members",
        required: true,
      },
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
  suggestions: [
    { code: "s", message: "Add AFK" },
    { code: "fed-channel-c1", message: "quotes is fed by a webhook" },
    { code: "naming-prefix", message: "Use a prefix" },
    { code: "afk-not-excluded", message: "Exclude AFK" },
  ],
  webhooks: { known: true, list: [], unavailable: null },
  partial: ["webhooks"],
};

const common = {
  csrfToken: "t",
  remainingMs: 1000,
  navFeatureStatus: {} as any,
  sampled: false,
};

type Props = Partial<Parameters<typeof renderAdoptPage>[0]>;
const page = (tab: ScanTab, extra: Props = {}): string =>
  renderAdoptPage({ ...common, scan, tab, ...extra });
const mainOf = (html: string): string =>
  html.slice(html.indexOf("<main"), html.indexOf("</main>"));
const DYNO = "155149108183695360";

describe("Server scan tabs (#1323)", () => {
  it("accepts only the five tab names and falls back to the Overview", () => {
    for (const t of SCAN_TABS) expect(parseScanTab(t)).toBe(t);
    for (const bad of [
      undefined,
      "",
      "ROLES",
      "roles ",
      "<script>",
      ["roles"],
      42,
    ]) {
      expect(parseScanTab(bad)).toBe("overview");
    }
  });

  it("marks exactly the current tab and renders only its content", () => {
    for (const t of SCAN_TABS) {
      const html = mainOf(page(t));
      expect(html.match(/aria-current="page"/g)).toHaveLength(1);
      const nav = html.slice(html.indexOf('<nav class="kb-tabs"'));
      const current = nav
        .slice(0, nav.indexOf("</nav>"))
        .split("\n")
        .find((l) => l.includes('aria-current="page"'));
      expect(current).toContain(
        t === "overview"
          ? 'href="/admin/adopt"'
          : `href="/admin/adopt?tab=${t}"`,
      );
    }
    expect(mainOf(page("roles"))).not.toContain("Needs fixing");
    expect(mainOf(page("overview"))).not.toContain('id="p-roles"');
    expect(mainOf(page("channels"))).not.toContain('id="p-roles"');
  });

  it("links every tab with a count badge, so the tabs work without JavaScript", () => {
    const html = mainOf(page("overview"));
    expect(html).toContain(
      '<a href="/admin/adopt?tab=roles">Roles <span class="kb-badge kb-badge--count">1</span></a>',
    );
    expect(html).toContain(
      'href="/admin/adopt?tab=channels">Channels <span class="kb-badge kb-badge--count">1</span>',
    );
    expect(html).toContain(
      'href="/admin/adopt?tab=bots">Other bots <span class="kb-badge kb-badge--count">1</span>',
    );
    expect(html).toContain('href="/admin/adopt?tab=discord">Discord</a>');
  });

  it("keeps the ownership hints in every tab link while they are on, and drops them when off", () => {
    const on = mainOf(page("roles", { sampled: true }));
    for (const t of SCAN_TABS) {
      const href = t === "overview" ? "?sample=1" : `?tab=${t}&amp;sample=1`;
      expect(on).toContain(`href="/admin/adopt${href}"`);
    }
    const off = mainOf(page("roles"));
    expect(off).not.toContain("sample=1");
  });

  it("shows the ownership hints as a switch in the header, on the current tab", () => {
    const off = mainOf(page("roles"));
    expect(off).toContain(
      '<input type="checkbox" role="switch" name="sample" value="1"><span class="kb-switch__track" aria-hidden="true"></span><span class="kb-switch__state" aria-hidden="true"></span>',
    );
    expect(off).toContain('<input type="hidden" name="tab" value="roles">');
    const on = mainOf(page("overview", { sampled: true }));
    expect(on).toContain('name="sample" value="1" checked>');
    // kb.css prints On/Off itself from :checked; literal text would double it.
    for (const html of [off, on]) {
      expect(html).toContain(
        '<span class="kb-switch__state" aria-hidden="true"></span>',
      );
      expect(html).not.toMatch(/kb-switch__state[^>]*>(On|Off)</);
    }
    expect(on).not.toContain('name="tab"');
    expect(on).toContain('href="/admin/adopt?sample=1&amp;refresh=1"');
  });

  it("keeps the ownership hints in every Overview link while they are on", () => {
    const withBots = {
      ...scan,
      bots: [
        {
          userId: DYNO,
          tag: "Dyno#1",
          roleIds: [],
          overwriteChannelIds: [],
          verified: true,
          isKoolBot: false,
        },
      ],
    };
    const on = mainOf(page("overview", { sampled: true, scan: withBots }));
    for (const t of ["roles", "channels", "bots"]) {
      expect(on).toContain(
        `<a class="kb-tile" href="/admin/adopt?tab=${t}&amp;sample=1">`,
      );
    }
    expect(on).toContain(
      'href="/admin/adopt?tab=bots&amp;sample=1">1 in detail</a>',
    );
    expect(on).toContain(
      'href="/admin/adopt?tab=discord&amp;sample=1">See the Discord tab</a>',
    );
    const off = mainOf(page("overview", { scan: withBots }));
    expect(off).not.toContain("sample=1");
    expect(off).toContain(
      'href="/admin/adopt?tab=discord">See the Discord tab</a>',
    );
  });

  it("is read-only: the only form is the GET switch, with no CSRF field and no other button", () => {
    for (const t of SCAN_TABS) {
      const html = mainOf(page(t, { sampled: true }));
      const forms = html.match(/<form\b[^>]*>/gi) ?? [];
      expect(forms).toEqual([
        '<form method="get" action="/admin/adopt" class="kb-toolbar__end">',
      ]);
      expect(html).not.toMatch(/method="post"/i);
      expect(html).not.toContain("_csrf");
      expect(html).not.toContain('value="t"');
      expect(html.match(/<button/gi)).toHaveLength(1);
    }
  });

  it("states the verdict first, with the blocker count and a way to Bot permissions", () => {
    const html = mainOf(page("overview"));
    expect(html.indexOf("is not ready to manage this server yet")).toBeLessThan(
      html.indexOf("kb-tiles"),
    );
    expect(html).toContain("Fix 1 blocker below first.");
    expect(html).toContain("kb-callout--err");
    expect(html).toContain(
      'href="/admin/bot-permissions">Open Bot permissions',
    );
    const ready = mainOf(
      page("overview", {
        scan: {
          ...scan,
          readiness: { ...scan.readiness, ready: true, issues: [] },
        },
      }),
    );
    expect(ready).toContain("KoolBot has what it needs to manage this server.");
    expect(ready).toContain("kb-callout--ok");
    expect(ready).not.toContain("not ready");
  });

  it("links the Readiness tile to Bot permissions and the others to their tabs", () => {
    const html = mainOf(page("overview"));
    expect(html).toContain(
      '<a class="kb-tile kb-tile--warn" href="/admin/bot-permissions">',
    );
    expect(html).toContain('<a class="kb-tile" href="/admin/adopt?tab=roles">');
    expect(html).toContain(
      '<a class="kb-tile" href="/admin/adopt?tab=channels">',
    );
    expect(html).toContain('<a class="kb-tile" href="/admin/adopt?tab=bots">');
  });

  it("does not repeat the permission table: detail links to Bot permissions", () => {
    for (const t of SCAN_TABS) {
      const html = mainOf(page(t));
      expect(html).not.toContain("Hand out roles to members");
      expect(html).not.toContain("Bot guild permissions");
    }
    const html = mainOf(page("overview"));
    expect(html).toContain("Move the KoolBot role above X");
  });

  it("sends each suggestion to the page that acts, and gives an unknown one no button", () => {
    const html = mainOf(page("overview"));
    expect(html).toContain('href="/admin/adopt/claims">Open Channel claims');
    expect(html).toContain('href="/admin/voice-channels">Open Voice channels');
    expect(html).toContain(
      'href="/admin/settings#section-voicetracking">Open voice tracking settings',
    );
    const addAfk = html.slice(
      html.indexOf("Add AFK"),
      html.indexOf("</li>", html.indexOf("Add AFK")),
    );
    expect(addAfk).not.toContain("<a ");
    expect(suggestionAction("fed-channel-123")).toEqual({
      href: "/admin/adopt/claims",
      label: "Open Channel claims",
    });
    expect(suggestionAction("naming-prefix")?.href).toBe(
      "/admin/voice-channels",
    );
    expect(suggestionAction("afk-not-excluded")?.href).toBe(
      "/admin/settings#section-voicetracking",
    );
    expect(suggestionAction("something-else")).toBeNull();
  });

  it("keeps the troubleshooting link on a blocker, links permission blockers to Bot permissions, and folds notes", () => {
    const html = mainOf(page("overview"));
    expect(html).toContain("TROUBLESHOOTING.md");
    // The test blocker's code is "x": no Bot permissions link in its fix box.
    const fix = html.slice(html.indexOf('class="kb-issue__fix"'));
    expect(fix.slice(0, fix.indexOf("</article>"))).not.toContain(
      "bot-permissions",
    );
    const missing = mainOf(
      page("overview", {
        scan: {
          ...scan,
          readiness: {
            ...scan.readiness,
            issues: [
              {
                code: "missing-ManageRoles",
                severity: "error",
                message: "Needs Manage Roles",
                help: "h",
              },
              {
                code: "n",
                severity: "info",
                message: "A quiet note",
                help: "h",
              },
            ],
          },
        },
      }),
    );
    const fixBox = missing.slice(missing.indexOf('class="kb-issue__fix"'));
    expect(fixBox.slice(0, fixBox.indexOf("</article>"))).toContain(
      'href="/admin/bot-permissions"',
    );
    expect(missing).toMatch(
      /<details class="kb-disclosure"><summary>.*Notes \(1\)/s,
    );
    expect(missing.indexOf("A quiet note")).toBeGreaterThan(
      missing.indexOf("Notes (1)"),
    );
  });

  it("renders each inventory in its own tab and escapes values", () => {
    const overview = mainOf(page("overview"));
    expect(overview).toContain("Test &lt;b&gt;Guild");
    expect(overview).toContain("Some parts could not be read");
    expect(overview).not.toContain("SendMessages");
    const roles = mainOf(page("roles"));
    expect(roles).toContain("&lt;script&gt;x&lt;/script&gt;");
    expect(roles).not.toContain("<script>x</script>");
    expect(roles).toContain("4+");
    const channels = mainOf(page("channels"));
    expect(channels).toContain("SendMessages");
    expect(channels).toContain(">quotes</th>");
    const bots = mainOf(page("bots"));
    expect(bots).toContain("Dyno#1");
    const discord = mainOf(page("discord"));
    expect(discord).toContain("Pick");
    expect(discord).toContain("r-gone");
  });

  it("shows webhook-mark caveats on the Channels tab, where they apply", () => {
    const known = page("channels");
    expect(known).not.toContain("not marked below");
    expect(
      page("overview", {
        scan: {
          ...scan,
          webhooks: { known: false, list: [], unavailable: "error" },
        },
      }),
    ).not.toContain("not marked below");
    const denied = page("channels", {
      scan: {
        ...scan,
        webhooks: { known: false, list: [], unavailable: "missing-permission" },
      },
    });
    expect(denied).toContain("does not hold Manage Webhooks");
    expect(denied).toContain("not marked below");
    expect(denied).toContain(
      'href="/admin/bot-permissions">Open Bot permissions',
    );
    const failed = page("channels", {
      scan: {
        ...scan,
        webhooks: { known: false, list: [], unavailable: "error" },
      },
    });
    expect(failed).toContain("Webhooks could not be read");
    expect(failed).not.toContain("Manage Webhooks");
  });

  it("renders the bot replacement report as a card per bot, with a coverage bar and the table folded", () => {
    const withBots = {
      ...scan,
      scanned: { config: { "moderation.enabled": true } } as any,
      bots: [
        ...scan.bots,
        {
          userId: DYNO,
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
    };
    const html = mainOf(page("bots", { scan: withBots }));
    expect(html).toContain("Combined view");
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
    // One panel per bot, the capability table inside a closed disclosure.
    expect(
      html.match(/<section class="kb-panel" aria-labelledby="bot-/g),
    ).toHaveLength(4);
    expect(html).toMatch(
      /<details class="kb-disclosure"><summary>[^]*?What KoolBot can replace[^]*?<table class="kb-table">/,
    );
    expect(html).not.toMatch(/<details[^>]*\bopen\b/);
    // The bar says what it shows in words and never by colour alone.
    expect(html).toMatch(
      /role="img" aria-label="\d+ of \d+ capabilities fully covered by KoolBot"/,
    );
    expect(html).toMatch(/\d+ full · \d+ partial · \d+ keep · \d+ not covered/);
    expect(html).toMatch(/<span style="width:\d+%"><\/span>/);
    // The Overview carries a compact card per bot.
    expect(mainOf(page("overview", { scan: withBots }))).toContain(
      "capabilities fully covered by KoolBot",
    );
  });

  it("sizes the coverage bar by the capabilities KoolBot fully covers", () => {
    const html = mainOf(
      page("bots", {
        scan: {
          ...scan,
          bots: [
            {
              userId: DYNO,
              tag: "Dyno#1",
              roleIds: [],
              overwriteChannelIds: [],
              verified: true,
              isKoolBot: false,
            },
          ],
        },
      }),
    );
    const m =
      /aria-label="(\d+) of (\d+) capabilities fully covered by KoolBot"[^]*?width:(\d+)%/.exec(
        html,
      );
    expect(m).not.toBeNull();
    expect(Number(m![3])).toBe(
      Math.round((Number(m![1]) / Number(m![2])) * 100),
    );
    expect(Number(m![2])).toBeGreaterThan(1);
  });

  it("tells the operator how to enable the GuildMembers intent (#1121)", () => {
    const escaped = escapeHtml(GUILD_MEMBERS_INTENT_HOWTO);
    const roles = page("roles");
    expect(roles).toContain(escaped);
    expect(roles).toContain(
      `<p class="kb-muted">Member counts come from the cache and may be low (marked <code>+</code>) unless the bot requests the GuildMembers intent. ${escaped}</p>`,
    );
    // The replacement report's own warning carries the wording as well.
    const bots = renderAdoptPage({
      ...common,
      tab: "bots",
      scan: {
        ...scan,
        bots: [
          {
            userId: DYNO,
            tag: "Dyno#1",
            roleIds: [],
            overwriteChannelIds: [],
            verified: true,
            isKoolBot: false,
          },
        ],
      },
    });
    expect(bots).toContain(escaped);
    expect(GUILD_MEMBERS_INTENT_HOWTO).toContain("GUILD_MEMBERS_INTENT=true");
    expect(GUILD_MEMBERS_INTENT_HOWTO).toContain("Server Members Intent");
    expect(GUILD_MEMBERS_INTENT_HOWTO).toContain("developer portal");
  });
  it("omits the intent how-to from the Roles caption when the intent is on", () => {
    const html = page("roles", {
      scan: { ...scan, readiness: { ...scan.readiness, membersIntent: true } },
    });
    expect(html).not.toContain(escapeHtml(GUILD_MEMBERS_INTENT_HOWTO));
    expect(html).toContain(
      '<p class="kb-muted">Member counts come from the cache and may be low (marked <code>+</code>).</p>',
    );
  });

  const botBase = { roleIds: [], overwriteChannelIds: [], isKoolBot: false };
  const CATALOG_LINK = "CONTRIBUTING.md#adding-a-known-bot-entry";
  const onlyBots = (bots: any[]): string =>
    page("bots", { scan: { ...scan, bots } });

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
  it("says so when there are no other bots", () => {
    const html = onlyBots([]);
    expect(html).toContain("No other bots found.");
    expect(html).not.toContain("Combined view");
  });
  it("lists the integration role and overwrite channels on a bot card", () => {
    const html = page("bots");
    expect(html).toContain("<dt>Channels with overwrites</dt><dd>quotes</dd>");
  });

  it("links the scheduled events to adoption on the Discord tab, escaping their names", () => {
    const withEvents = {
      ...scan,
      scheduledEvents: [
        {
          id: "1",
          name: "Game <i>night</i>",
          startsAt: "2026-11-01T18:00:00.000Z",
          status: "1",
          channelId: null,
          endsAt: null,
          description: "",
          creatorId: null,
          creatorIsBot: null,
          entityType: "external" as const,
          recurring: false,
        },
      ],
    };
    const html = page("discord", { scan: withEvents });
    expect(html).toContain("Game &lt;i&gt;night&lt;/i&gt;");
    expect(html).toContain('href="/admin/adopt/events"');
    expect(page("discord")).not.toContain('href="/admin/adopt/events"');
  });

  it("says when the scan was read, in UTC", () => {
    expect(page("overview")).toContain(
      "Read from Discord 2026-10-07 00:00 UTC",
    );
  });

  it("warns on every tab when a part could not be read, so an empty list is not read as an absence", () => {
    const partial = {
      ...scan,
      scheduledEvents: [],
      partial: ["scheduled events"],
    };
    for (const t of SCAN_TABS) {
      const html = mainOf(page(t, { scan: partial }));
      expect(html).toContain("Some parts could not be read.");
      expect(html).toContain("Not read: scheduled events.");
      expect(html.match(/Some parts could not be read/g)).toHaveLength(1);
    }
    const discord = mainOf(page("discord", { scan: partial }));
    expect(discord.indexOf("Some parts could not be read")).toBeLessThan(
      discord.indexOf("No native scheduled events."),
    );
    for (const t of SCAN_TABS) {
      expect(mainOf(page(t, { scan: { ...scan, partial: [] } }))).not.toContain(
        "Some parts could not be read",
      );
    }
  });

  it("renders a failure notice, with no tabs, when the scan failed", () => {
    const html = renderAdoptPage({
      ...common,
      tab: "overview",
      scan: null,
      error: "boom <x>",
    });
    expect(html).toContain("The scan failed");
    expect(html).toContain("boom &lt;x&gt;");
    expect(html).not.toContain('class="kb-tabs"');
    expect(html).not.toContain('role="switch"');
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
