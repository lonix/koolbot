import { describe, it, expect } from "@jest/globals";
import { renderChannelClaimsPage } from "../../src/web/channel-claims-view.js";

const flags = {
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
};
const ch = (over: Record<string, unknown>) => ({
  id: "1",
  name: "x",
  kind: "text",
  typeName: "GuildText",
  parentId: null,
  parentName: null,
  syncedToParent: null,
  position: 0,
  overwrites: [],
  usedBy: [],
  featureGuess: null,
  gatedByRoleIds: [],
  ownerHint: null,
  flags,
  ...over,
});
const role = (over: Record<string, unknown>) => ({
  managed: false,
  isEveryone: false,
  botId: null,
  ...over,
});
const scan = {
  guildName: "G",
  guildId: "g",
  scanned: { botRoleIds: [], botHighestRolePosition: 50, roles: [] },
  webhooks: {
    known: true,
    unavailable: null,
    list: [{ id: "w1", name: "bridge", channelId: "11", kind: "incoming" }],
  },
  roles: [
    role({ id: "r1", name: "<b>Mod</b>", position: 3 }),
    role({ id: "r2", name: "Booster", position: 2, managed: true }),
    role({ id: "r3", name: "Dyno", position: 1, managed: true, botId: "b1" }),
    role({ id: "g", name: "@everyone", position: 0, isEveryone: true }),
  ],
  channels: [
    ch({
      id: "10",
      name: "Games <script>",
      kind: "category",
      typeName: "GuildCategory",
    }),
    ch({
      id: "11",
      name: "news",
      parentId: "10",
      flags: { ...flags, webhookFed: true },
    }),
    ch({
      id: "12",
      name: "forum",
      parentId: "10",
      flags: { ...flags, forum: true },
    }),
    ch({
      id: "13",
      name: "Lobby",
      kind: "voice",
      typeName: "GuildVoice",
      parentId: "10",
    }),
    ch({ id: "14", name: "loose", position: 5 }),
  ],
  naming: { suggestedPrefix: "🔊 | " },
} as any;
const groups = [{ id: "grp1", name: "Mods <i>" }] as any;
const base = { csrfToken: "t", remainingMs: 1000, navFeatureStatus: {} as any };
const empty = {
  ...base,
  scan,
  groups,
  claims: [] as any[],
  plan: null,
  problems: [] as string[],
  previewToken: null,
};
const planOf = (operations: unknown[], extra: Record<string, unknown> = {}) =>
  ({
    scan,
    groups,
    errors: [],
    warnings: [],
    plan: {
      id: "abc",
      errors: [],
      warnings: [],
      operations,
      baseline: { roles: [], channels: [], config: {}, absentRoleNames: [] },
    },
    ...extra,
  }) as any;

describe("renderChannelClaimsPage (#1022)", () => {
  it("renders every category and channel with 'leave alone' selected, escaped", () => {
    const html = renderChannelClaimsPage(empty);
    expect(html).toContain("Games &lt;script&gt;");
    expect(html).not.toContain("<script>Games");
    expect(html).toContain("&lt;b&gt;Mod&lt;/b&gt;");
    expect(html).toContain("Mods &lt;i&gt;");
    for (const id of ["10", "11", "12", "13", "14"]) {
      expect(html).toMatch(
        new RegExp(`name="action_${id}"[^>]*><option value="leave" selected`),
      );
    }
    expect(html).toContain('name="bulk_10"');
    expect(html).not.toContain('name="bulk_11"');
    expect(html).toContain("news feed: read-only is suggested");
    expect(html).toContain("Forum: also stop replies");
    expect(html).toContain("(bot integration)");
    expect(html).toMatch(/<option value="r3" disabled/);
    expect(html).toContain("Nothing is written to Discord yet");
    expect(html).not.toContain("Apply plan");
  });

  it("only offers features that fit the channel kind, and sync only with a category", () => {
    const html = renderChannelClaimsPage(empty);
    const row = (id: string): string =>
      html.slice(html.indexOf(`name="action_${id}"`)).split("</tr>")[0];
    expect(row("10")).toContain("voicechannels.category_id");
    expect(row("10")).not.toContain("quotes.channel_id");
    expect(row("13")).toContain("voicechannels.lobby.channel_id");
    expect(row("14")).toContain("quotes.channel_id");
    expect(row("12")).not.toContain("quotes.channel_id");
    expect(row("14")).not.toContain('value="sync"');
    expect(row("11")).toContain('value="sync"');
  });

  it("keeps the admin's choices after a preview and shows advice", () => {
    const html = renderChannelClaimsPage({
      ...empty,
      claims: [
        {
          channelId: "14",
          action: "gate",
          bindKey: "quotes.channel_id",
          roleIds: ["r1"],
          minGroupId: "grp1",
        },
      ],
      plan: planOf([], {
        warnings: [{ code: "rebind", message: "careful <b>" }],
      }),
      problems: ["Ignored an unknown action for channel 9."],
      previewToken: "tok-1",
    });
    expect(html).toMatch(/name="action_14"[^>]*>[^]*?value="gate" selected/);
    expect(html).toMatch(/value="quotes.channel_id" selected/);
    expect(html).toMatch(/value="r1" selected/);
    expect(html).toMatch(/value="grp1" selected/);
    expect(html).toContain("careful &lt;b&gt;");
    expect(html).toContain("Ignored an unknown action");
    expect(html).not.toContain("Apply plan");
  });

  it("shows the apply form for an applicable plan, claims escaped in a hidden field", () => {
    const html = renderChannelClaimsPage({
      ...empty,
      claims: [{ channelId: "14", action: "read-only" }],
      plan: planOf([
        {
          id: "op-1",
          type: "overwrite.set",
          class: "additive",
          summary: "Edit overwrite",
          before: null,
          after: null,
        },
      ]),
      previewToken: "tok-1",
    });
    expect(html).toContain('action="/admin/adopt/claims/apply"');
    expect(html).toContain('name="planId" value="abc"');
    expect(html).toContain('name="token" value="tok-1"');
    // The claims stay server-side: nothing but the token is carried.
    expect(html).not.toContain('name="payload"');
    expect(html).not.toContain("&quot;channelId&quot;");
  });

  it("offers no apply button while the plan has problems", () => {
    const html = renderChannelClaimsPage({
      ...empty,
      plan: planOf(
        [
          {
            id: "op-1",
            type: "config.set",
            class: "additive",
            summary: "Set x",
            before: null,
            after: null,
          },
        ],
        { errors: [{ code: "voice-cleanup-risk", message: "no <x>" }] },
      ),
      previewToken: "tok-1",
    });
    expect(html).toContain("voice-cleanup-risk");
    expect(html).toContain("no &lt;x&gt;");
    expect(html).not.toContain("Apply plan");
  });

  it("shows a prefilled feature as chosen on its row, and says where it came from", () => {
    const html = renderChannelClaimsPage({
      ...empty,
      claims: [
        { channelId: "14", action: "leave", bindKey: "quotes.channel_id" },
      ],
      prefill: {
        channelId: "14",
        channelName: "loose <b>",
        featureLabel: "Quotes",
      },
    });
    expect(html).toMatch(
      /name="bind_14"><option value="">\(none\)<\/option><option value="quotes\.channel_id" selected>/,
    );
    expect(html).toContain('<tr id="claim-14">');
    expect(html).toContain(
      "Prefilled from the Server scan: <strong>loose &lt;b&gt;</strong> is set to be bound to <strong>Quotes</strong>.",
    );
    expect(html).toContain(
      "Nothing changes until you preview the plan and apply it.",
    );
    // Still only a form: nothing is applied and no plan exists yet.
    expect(html).not.toContain("Apply plan");
  });

  it("says nothing about a prefill when there is none", () => {
    expect(renderChannelClaimsPage(empty)).not.toContain("Prefilled from");
  });

  it("reports a failed scan", () => {
    const html = renderChannelClaimsPage({
      ...empty,
      scan: null,
      error: "boom <x>",
    });
    expect(html).toContain("The scan failed: boom &lt;x&gt;");
  });

  it("tracks a running apply", () => {
    const html = renderChannelClaimsPage({
      ...empty,
      jobId: "11111111-1111-1111-1111-111111111111",
    });
    expect(html).toContain('id="cc-job"');
    expect(html).toContain("/admin/role-groups/job/");
  });

  describe("suggestions", () => {
    const gatedScan = {
      ...scan,
      scanned: {
        botRoleIds: [],
        botHighestRolePosition: 50,
        roles: [
          { id: "r1", permissions: "0", position: 3 },
          { id: "r9", permissions: "8", position: 4 },
        ],
      },
      roles: [
        ...scan.roles,
        role({ id: "r9", name: "Root <i>", position: 4, usedBy: [] }),
      ].map((r: any) => ({ usedBy: [], ...r })),
      channels: [
        ch({
          id: "10",
          name: "Games <script>",
          kind: "category",
          typeName: "GuildCategory",
          overwrites: [
            { id: "g", type: "role", allow: [], deny: ["ViewChannel"] },
            { id: "r1", type: "role", allow: ["ViewChannel"], deny: [] },
          ],
        }),
        ch({
          id: "20",
          name: "Admins",
          kind: "category",
          typeName: "GuildCategory",
          overwrites: [
            { id: "g", type: "role", allow: [], deny: ["ViewChannel"] },
            { id: "r9", type: "role", allow: ["ViewChannel"], deny: [] },
          ],
        }),
        ch({ id: "11", name: "news", parentId: "10" }),
        ch({
          id: "30",
          name: "stage",
          kind: "voice",
          typeName: "GuildStageVoice",
          flags: { ...flags, stage: true },
        }),
        ch({
          id: "31",
          name: "announcements",
          flags: { ...flags, announcement: true },
        }),
      ],
    } as any;

    it("lists detected pairs with an escaped role, refuses a dangerous one and offers accept-all", () => {
      const html = renderChannelClaimsPage({ ...empty, scan: gatedScan });
      expect(html).toContain("Game-role categories");
      expect(html).toContain('name="pair_10"');
      expect(html).toContain('name="pairemoji_10"');
      expect(html).not.toContain('name="pair_20"');
      expect(html).toContain("refused");
      expect(html).toContain("powerful permissions (Administrator)");
      expect(html).toContain("Root &lt;i&gt;");
      expect(html).not.toContain("Root <i>");
      expect(html).toContain('name="pairs_all"');
      expect(html).toContain("Register all 1 detected pair");
    });

    it("shows the feed choice, and says webhook data is unavailable instead of guessing", () => {
      const html = renderChannelClaimsPage({ ...empty, scan: gatedScan });
      expect(html).toContain('name="feed_11"');
      const off = renderChannelClaimsPage({
        ...empty,
        scan: {
          ...gatedScan,
          webhooks: {
            known: false,
            unavailable: "missing-permission",
            list: [],
          },
        },
      });
      expect(off).toContain("Webhook data is unavailable");
      expect(off).toContain("Manage Webhooks");
      expect(off).not.toContain('name="feed_11"');
      expect(off).not.toContain("news feed: read-only is suggested");
    });

    it("labels an announcement channel without selecting it and offers stage speakers", () => {
      const html = renderChannelClaimsPage({ ...empty, scan: gatedScan });
      expect(html).toContain("read-only is suggested (not selected for you)");
      expect(html).toMatch(
        /name="action_31"[^>]*><option value="leave" selected/,
      );
      expect(html).toContain('name="speakers_30"');
      expect(html).not.toContain('name="speakers_31"');
    });

    it("keeps ticked pairs and feeds after a preview", () => {
      const html = renderChannelClaimsPage({
        ...empty,
        scan: gatedScan,
        claims: [
          {
            channelId: "10",
            action: "leave",
            registerPairing: true,
            pairEmoji: "🎯",
          },
          { channelId: "11", action: "read-only", feed: true },
        ],
      });
      expect(html).toMatch(/name="pair_10" value="1" checked/);
      expect(html).toContain('value="🎯"');
      expect(html).toMatch(/name="feed_11" value="1" checked/);
    });
  });
});
