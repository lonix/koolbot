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
  approvedAt: null,
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
      approvedAt: "2026-10-07T10:00:00.000Z",
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
      approvedAt: "2026-10-07T10:00:00.000Z",
    });
    expect(html).toContain('action="/admin/adopt/claims/apply"');
    expect(html).toContain('name="planId" value="abc"');
    expect(html).toContain('name="at" value="2026-10-07T10:00:00.000Z"');
    expect(html).toContain("&quot;channelId&quot;:&quot;14&quot;");
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
      approvedAt: "2026-10-07T10:00:00.000Z",
    });
    expect(html).toContain("voice-cleanup-risk");
    expect(html).toContain("no &lt;x&gt;");
    expect(html).not.toContain("Apply plan");
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
});
