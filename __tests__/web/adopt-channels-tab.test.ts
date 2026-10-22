import { describe, it, expect } from "@jest/globals";
import {
  CHANNEL_FILTERS,
  claimHref,
  parseChannelFilter,
  renderAdoptPage,
  type ChannelFilter,
} from "../../src/web/adopt-view.js";
import { channelsScan, scanChannel } from "./channels-scan-fixtures.js";

/** The Channels tab (#1364): the Discord tree, filters, overwrites and Claim. */

const common = {
  csrfToken: "t",
  remainingMs: 1000,
  navFeatureStatus: {} as never,
  sampled: false,
};

type Props = Partial<Parameters<typeof renderAdoptPage>[0]>;
const channelsPage = (extra: Props = {}): string => {
  const html = renderAdoptPage({
    ...common,
    scan: channelsScan(),
    tab: "channels",
    ...extra,
  });
  return html.slice(html.indexOf("<main"), html.indexOf("</main>"));
};

/** The channel names of the rows, in the order they are listed. */
const rowNames = (html: string): string[] =>
  [
    ...html.matchAll(
      /<th scope="row"[^>]*><span class="kb-mention[^"]*"><svg[^>]*>[\s\S]*?<\/svg>([^<]+)<\/span>/g,
    ),
  ].map((m) => m[1]);

const rowOf = (html: string, name: string): string => {
  const rows = html.split("<tr").filter((r) => r.includes('<th scope="row"'));
  const row = rows.find((r) => rowNames(`<tr${r}`)[0] === name);
  if (!row) throw new Error(`no row for ${name}`);
  return row;
};

describe("parseChannelFilter", () => {
  it("accepts only the four filter names and shows everything for the rest", () => {
    for (const f of CHANNEL_FILTERS) expect(parseChannelFilter(f)).toBe(f);
    for (const bad of [undefined, "", "nope", "<script>", ["used"], 1]) {
      expect(parseChannelFilter(bad)).toBe("all");
    }
  });
});

describe("Channels tab as the Discord tree (#1364)", () => {
  it("lists channels outside a category first, then each category with its channels under it", () => {
    expect(rowNames(channelsPage())).toEqual([
      "general",
      "quote-board",
      "stray",
      "Community",
      "quotes",
      "poll-night",
      "rules",
      "lobby",
      "Support",
      "ticket-log",
    ]);
  });

  it("lists voice channels after the text channels of their category, whatever the positions", () => {
    const names = rowNames(channelsPage());
    expect(names.indexOf("lobby")).toBeGreaterThan(names.indexOf("rules"));
  });

  it("never drops a channel whose category is not in the scan", () => {
    expect(rowNames(channelsPage())).toContain("stray");
    expect(rowOf(channelsPage(), "stray")).not.toContain("kb-tree__child");
  });

  it("shows categories in capitals, indents their channels, and says each kind", () => {
    const html = channelsPage();
    const community = rowOf(html, "Community");
    expect(community).toContain(
      '<span class="kb-mention kb-mention--category">',
    );
    expect(community).toContain('aria-label="Category"');
    expect(rowOf(html, "quotes")).toContain(
      '<th scope="row" class="kb-tree__child">',
    );
    expect(rowOf(html, "general")).not.toContain("kb-tree__child");
    expect(rowOf(html, "lobby")).toContain('aria-label="Voice channel"');
    expect(rowOf(html, "general")).toContain('aria-label="Text channel"');
  });

  it("shows what uses a channel as a green chip, and what it looks like it could be", () => {
    const html = channelsPage();
    expect(rowOf(html, "quotes")).toContain(
      '<span class="kb-chip kb-chip--ok">quotes</span>',
    );
    expect(rowOf(html, "quotes")).not.toContain("looks like");
    expect(rowOf(html, "quote-board")).toContain("looks like Quotes");
    expect(rowOf(html, "poll-night")).toContain("looks like Polls");
  });

  it("says Custom permissions only on a channel that is not synced to its category", () => {
    const html = channelsPage();
    expect(rowOf(html, "quotes")).toContain(
      '<span class="kb-badge kb-badge--warn">Custom permissions</span>',
    );
    for (const synced of ["lobby", "poll-night", "rules", "general"]) {
      expect(rowOf(html, synced)).not.toContain("Custom permissions");
    }
  });

  it("opens a row's overwrites on demand and says how many are inside", () => {
    const html = channelsPage();
    const quotes = rowOf(html, "quotes");
    expect(quotes).toContain(
      '<details class="kb-disclosure kb-disclosure--inline">',
    );
    expect(quotes).toContain("1 overwrite</summary>");
    expect(quotes).not.toContain("<details open");
    expect(quotes).toContain("SendMessages");
    // A channel with none has nothing to open.
    expect(rowOf(html, "general")).not.toContain("<details");
    expect(rowOf(html, "general")).toContain(">none<");
  });

  it("shows Discord's own flags on a row", () => {
    expect(rowOf(channelsPage(), "rules")).toContain("Rules (Discord)");
  });

  it("escapes channel names", () => {
    const scan = channelsScan();
    scan.channels.push(
      scanChannel({ id: "50", name: "<img src=x onerror=1>", position: 20 }),
    );
    const html = channelsPage({ scan });
    expect(html).toContain("&lt;img src=x onerror=1&gt;");
    expect(html).not.toContain("<img src=x");
  });
});

describe("Claim on a looks-like row (#1364)", () => {
  const claimLinks = (html: string): string[] =>
    [
      ...html.matchAll(
        /<a class="kb-btn kb-btn--sm" href="([^"]*claims[^"]*)">/g,
      ),
    ].map((m) => m[1]);

  it("opens Channel claims with the channel and the feature in the query", () => {
    const html = channelsPage();
    expect(rowOf(html, "quote-board")).toContain(
      'href="/admin/adopt/claims?channel=11&amp;feature=quotes.channel_id#claim-11"',
    );
    expect(claimHref("11", "quotes.channel_id")).toBe(
      "/admin/adopt/claims?channel=11&feature=quotes.channel_id#claim-11",
    );
  });

  it("names the channel and the feature for a screen reader", () => {
    expect(rowOf(channelsPage(), "quote-board")).toContain(
      'Claim<span class="kb-visually-hidden"> quote-board as Quotes</span>',
    );
  });

  it("offers Claim only where the claims form has that feature for that channel", () => {
    const html = channelsPage();
    expect(claimLinks(html).map((l) => l.split("?")[1])).toEqual([
      "channel=11&amp;feature=quotes.channel_id#claim-11",
      "channel=21&amp;feature=voicechannels.lobby.channel_id#claim-21",
      "channel=30&amp;feature=tickets.category_id#claim-30",
    ]);
    // Looks like a feature, but nothing honest to bind.
    expect(rowOf(html, "poll-night")).not.toContain("Claim");
    // A text channel cannot be the Tickets category.
    expect(rowOf(html, "ticket-log")).not.toContain("Claim");
    // Discord's own rules channel is never offered to a feature.
    expect(rowOf(html, "rules")).toContain("looks like Notices");
    expect(rowOf(html, "rules")).not.toContain("Claim");
  });

  it("gives no Claim to a channel a feature already uses", () => {
    expect(rowOf(channelsPage(), "quotes")).not.toContain(">Claim<");
  });

  it("stays read-only: Claim is a link, and the one form is still the GET switch", () => {
    const html = channelsPage({ sampled: true });
    expect(html.match(/<form\b[^>]*>/gi)).toEqual([
      '<form method="get" action="/admin/adopt" class="kb-toolbar__end">',
    ]);
    expect(html.match(/<button/gi)).toHaveLength(1);
    expect(html).not.toContain("_csrf");
  });
});

describe("Channels filters (#1364)", () => {
  const names = (filter: ChannelFilter): string[] =>
    rowNames(channelsPage({ filter }));

  it("lists everything for all, and when no filter is given", () => {
    expect(names("all")).toHaveLength(10);
    expect(rowNames(channelsPage())).toEqual(names("all"));
  });

  it("used: the channels a feature uses, under their category", () => {
    expect(names("used")).toEqual(["Community", "quotes"]);
  });

  it("claimable: exactly the rows that show Claim, with a category kept as the heading of its channel", () => {
    expect(names("claimable")).toEqual([
      "quote-board",
      "Community",
      "lobby",
      "Support",
    ]);
    const html = channelsPage({ filter: "claimable" });
    expect(html.match(/>Claim</g)).toHaveLength(3);
  });

  it("custom: the channels not synced to their category", () => {
    expect(names("custom")).toEqual(["Community", "quotes"]);
  });

  it("counts on each filter link the channels that match it", () => {
    const html = channelsPage();
    const nav = html.slice(html.indexOf('aria-label="Filter channels"'));
    const counts = [
      ...nav
        .slice(0, nav.indexOf("</nav>"))
        .matchAll(/<span class="kb-badge kb-badge--count">(\d+)<\/span>/g),
    ].map((m) => Number(m[1]));
    expect(counts).toEqual([10, 1, 3, 1]);
  });

  it("links each filter as a plain link that keeps the tab and the ownership hints", () => {
    const html = channelsPage({ sampled: true, filter: "used" });
    expect(html).toContain('href="/admin/adopt?tab=channels&amp;sample=1">All');
    expect(html).toContain(
      'href="/admin/adopt?tab=channels&amp;sample=1&amp;filter=used" aria-current="true">Used by KoolBot',
    );
    expect(html).toContain(
      'href="/admin/adopt?tab=channels&amp;sample=1&amp;filter=claimable">Could be claimed',
    );
    expect(html).toContain(
      'href="/admin/adopt?tab=channels&amp;sample=1&amp;filter=custom">Custom permissions',
    );
  });

  it("marks exactly one filter as current, and keeps the tab strip's own marker", () => {
    for (const f of CHANNEL_FILTERS) {
      const html = channelsPage({ filter: f });
      expect(html.match(/aria-current="true"/g)).toHaveLength(1);
      expect(html.match(/aria-current="page"/g)).toHaveLength(1);
    }
  });

  it("does not carry the filter into the other tabs", () => {
    const html = channelsPage({ filter: "used" });
    const tabs = html.slice(
      html.indexOf('<nav class="kb-tabs" aria-label="Server scan'),
    );
    expect(tabs.slice(0, tabs.indexOf("</nav>"))).not.toContain("filter=");
  });

  it("keeps the filter when the hints switch is applied and when scanning again", () => {
    const html = channelsPage({ sampled: true, filter: "claimable" });
    expect(html).toContain(
      '<input type="hidden" name="tab" value="channels"><input type="hidden" name="filter" value="claimable">',
    );
    expect(html).toContain(
      'href="/admin/adopt?tab=channels&amp;sample=1&amp;filter=claimable&amp;refresh=1">Scan again',
    );
  });

  it("drops the filter from the switch and Scan again when it shows everything", () => {
    const html = channelsPage();
    expect(html).not.toContain('name="filter"');
    expect(html).toContain(
      'href="/admin/adopt?tab=channels&amp;refresh=1">Scan again',
    );
  });

  it("does not put the filter in the other tabs' switch or Scan again", () => {
    const html = renderAdoptPage({
      ...common,
      scan: channelsScan(),
      tab: "roles",
      filter: "used",
    });
    expect(html).not.toContain("filter=");
    expect(html).not.toContain('name="filter"');
  });

  it("says so, with a way back, when nothing matches", () => {
    const scan = { ...channelsScan(), channels: [scanChannel({ id: "1" })] };
    const html = channelsPage({ scan, filter: "used", sampled: true });
    expect(html).toContain("No channels match this filter.");
    expect(html).toContain(
      'href="/admin/adopt?tab=channels&amp;sample=1">Show all channels',
    );
    expect(html).not.toContain("<table");
  });

  it("says so when the scan found no channels at all", () => {
    const html = channelsPage({ scan: { ...channelsScan(), channels: [] } });
    expect(html).toContain("No channels were found.");
    expect(html).not.toContain("Show all channels");
  });
});
