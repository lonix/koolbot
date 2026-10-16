import { describe, it, expect } from "@jest/globals";
import { renderChannelManagerPage } from "../../src/web/channel-manager-view.js";
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
