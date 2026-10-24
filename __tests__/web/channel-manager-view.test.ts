import { describe, it, expect } from "@jest/globals";
import {
  renderChannelDeleteConfirmPage,
  renderChannelManagerPage,
} from "../../src/web/channel-manager-view.js";
import {
  buildChannelTree,
  type ManagedChannelView,
} from "../../src/web/channel-manager.js";

const CAT = "100000000000000001";
const view = (
  id: string,
  over: Partial<ManagedChannelView>,
): ManagedChannelView => ({
  id,
  name: id,
  kind: "text",
  typeLabel: "text",
  parentId: null,
  position: 0,
  topic: null,
  userLimit: null,
  bitrate: null,
  ...over,
});

const render = (channels: ManagedChannelView[], maxBitrate = 96000): string =>
  renderChannelManagerPage({
    csrfToken: "csrf",
    remainingMs: 1,
    channels,
    tree: buildChannelTree(channels),
    protection: new Map(),
    botCanManage: true,
    maxBitrate,
  });

describe("edit form", () => {
  const voice = (bitrate: number): ManagedChannelView =>
    view("100000000000000010", {
      kind: "voice",
      name: "Hangout",
      typeLabel: "voice",
      parentId: CAT,
      userLimit: 4,
      bitrate,
    });
  const cat = view(CAT, { kind: "category", name: "Community" });

  it("keeps an existing bitrate above the server maximum inside the control's range", () => {
    // A boost downgrade left a 128 kbps channel on a server that now allows 96.
    const html = render([cat, voice(128000)]);
    const input = /<input type="number" name="bitrate"[^>]*>/.exec(
      html.slice(html.indexOf("Hangout")),
    )![0];
    const attr = (name: string): number =>
      Number(new RegExp(`${name}="(\\d+)"`).exec(input)![1]);
    expect(attr("value")).toBe(128);
    expect(attr("max")).toBeGreaterThanOrEqual(attr("value"));
    expect(attr("min")).toBeLessThanOrEqual(attr("value"));
    // The help text still states the real limit for new values.
    expect(html).toContain("8 to 96; empty keeps");
  });

  it("limits a normal bitrate to the server maximum", () => {
    const html = render([cat, voice(64000)]);
    expect(html).toMatch(/name="bitrate" min="8" max="96" value="64"/);
  });

  it("rounds an odd bitrate for display like the server does", () => {
    const html = render([cat, voice(65536)]);
    expect(html).toContain('name="bitrate" min="8" max="96" value="66"');
    expect(html).toContain('name="orig_bitrate" value="66"');
    // The exact value, for conflict detection.
    expect(html).toContain('name="orig_bitrate_bps" value="65536"');
  });

  it("carries what it displayed as hidden baseline fields, escaped", () => {
    const html = render([
      cat,
      view("100000000000000011", {
        name: 'a"><b>x',
        topic: "line1\nline2 <i>",
        parentId: CAT,
      }),
    ]);
    expect(html).toContain('name="orig_name" value="a&quot;&gt;&lt;b&gt;x"');
    expect(html).toContain('name="orig_topic"');
    expect(html).toContain(`name="orig_parent" value="${CAT}"`);
    expect(html).not.toContain("<b>x");
  });

  it("limits the other fields to ranges every existing value fits", () => {
    const html = render([cat, voice(64000)]);
    expect(html).toContain('name="userLimit" min="0" max="99" value="4"');
    expect(html).toContain('maxlength="100"');
  });

  it("draws each Up/Down button for the neighbour it would swap with", () => {
    const html = render([
      cat,
      view("100000000000000020", { parentId: CAT, position: 0 }),
      view("100000000000000021", { parentId: CAT, position: 1 }),
    ]);
    expect(html).toContain(
      'name="direction" value="up"><input type="hidden" name="neighbor" value="100000000000000020"',
    );
  });
});

describe("channel labels (#1394)", () => {
  const cat = view(CAT, { kind: "category", name: "Community" });
  const rows = [
    cat,
    view("100000000000000030", {
      kind: "text",
      name: "general",
      parentId: CAT,
    }),
    view("100000000000000031", {
      kind: "voice",
      name: "Hangout",
      parentId: CAT,
    }),
    view("100000000000000032", {
      kind: "other",
      name: "Town hall",
      typeLabel: "GuildStageVoice",
      parentId: CAT,
    }),
    view("100000000000000033", {
      kind: "other",
      name: "news",
      typeLabel: "GuildAnnouncement",
      parentId: CAT,
    }),
  ];

  it("shows each channel with its kind's icon, and the category in the card heading", () => {
    const html = render(rows);
    expect(html).toContain('aria-label="Text channel"');
    expect(html).toContain('aria-label="Voice channel"');
    expect(html).toContain('aria-label="Stage channel"');
    expect(html).toContain('aria-label="Announcement channel"');
    expect(html).toMatch(
      /<h2><span class="kb-mention kb-mention--category">.*?Community<\/span> <span class="tag">category<\/span><\/h2>/s,
    );
    expect(html).not.toContain("<strong>general</strong>");
  });

  it("keeps the Type column's words, so the kind is never the icon alone", () => {
    const html = render(rows);
    expect(html).toContain("<td>Text</td>");
    expect(html).toContain("<td>Voice</td>");
  });

  it("shows a channel of a type with no label by its plain name, never as unavailable", () => {
    const html = render([
      cat,
      view("100000000000000034", {
        kind: "other",
        name: "Directory",
        typeLabel: "GuildDirectory",
        parentId: CAT,
      }),
    ]);
    expect(html).toContain("Directory");
    expect(html).not.toContain("Directory (unavailable)");
  });

  it("does not label form values: the name field and baseline keep the bare name", () => {
    const html = render([
      cat,
      view("100000000000000035", {
        kind: "voice",
        name: "A & B",
        parentId: CAT,
      }),
    ]);
    expect(html).toContain('name="name" value="A &amp; B"');
    expect(html).toContain('name="orig_name" value="A &amp; B"');
    expect(html).toContain('aria-label="Delete A &amp; B"');
    expect(html).toContain('aria-label="Move A &amp; B up"');
  });

  it("escapes names in the mention", () => {
    const html = render([
      cat,
      view("100000000000000036", {
        kind: "text",
        name: "<img src=x>",
        parentId: CAT,
      }),
    ]);
    expect(html).not.toContain("<img");
    expect(html).toContain("&lt;img src=x&gt;");
  });

  it("writes categories in the parent picker as plain text with the folder glyph", () => {
    const html = render(rows);
    expect(html).toContain(`value="${CAT}">📁 Community</option>`);
  });
});

describe("delete confirmation labels (#1394)", () => {
  const channel = view("100000000000000040", {
    kind: "voice",
    name: "Hangout",
  });
  const page = (c: ManagedChannelView): string =>
    renderChannelDeleteConfirmPage({
      csrfToken: "csrf",
      remainingMs: 1,
      channel: c,
      verdict: { ok: true },
      botCanManage: true,
      confirmToken: "tok",
    } as never);

  it("names the channel with its icon in the sentence, and keeps the words", () => {
    const html = page(channel);
    expect(html).toContain("this voice channel");
    expect(html).toContain('aria-label="Voice channel"');
    expect(html).toContain("Hangout</span>");
  });

  it("escapes the name", () => {
    const html = page({ ...channel, name: "<b>x</b>" });
    expect(html).not.toContain("<b>x");
  });
});
