/**
 * The removed-bot cleanup page names channels the way Discord does (#1394):
 * an icon per kind, and a channel with no known type by its plain name.
 */

import { describe, it, expect } from "@jest/globals";
import { renderBotCleanupPage } from "../../src/web/bot-cleanup-view.js";
import type { RemovedBotCandidate } from "../../src/services/bot-removal-cleanup.js";

const bot: RemovedBotCandidate = {
  userId: "155149108183695360",
  name: "Dyno",
  evidence: "catalogue",
  needsCheck: false,
  reason: "Its id is in the bot catalogue and it is no longer in the server.",
  overwriteChannels: [
    { id: "11", name: "news", typeName: "GuildText" },
    { id: "12", name: "Hang <b>out</b>", typeName: "GuildVoice" },
    { id: "14", name: "Directory", typeName: "GuildDirectory" },
    { id: "15", name: "Untyped" },
  ],
  ownedChannels: [
    {
      id: "13",
      name: "log",
      typeName: "GuildText",
      usedBy: ["core"],
      claimKey: "core.errors.channel_id",
    },
  ],
  boundFeatures: [
    { channel: "log", typeName: "GuildText", features: ["core"] },
  ],
};

const page = (): string =>
  renderBotCleanupPage({
    csrfToken: "t",
    remainingMs: 1000,
    botId: bot.userId,
    candidates: [bot],
    planned: null,
    selectedChannelIds: [],
    sampled: false,
    approvedAt: null,
  });

describe("bot cleanup page labels", () => {
  it("shows each overwrite channel with the icon of its kind", () => {
    const html = page();
    expect(html).toContain('aria-label="Text channel"');
    expect(html).toContain('aria-label="Voice channel"');
    expect(html).toContain("news</span>");
  });

  it("escapes names, and keeps the checkbox label's words", () => {
    const html = page();
    expect(html).not.toContain("<b>out");
    expect(html).toContain("Hang &lt;b&gt;out&lt;/b&gt;");
    expect(html).toContain("Remove the overwrite for the removed bot on");
  });

  it("shows a channel of an unlabelled or missing type by its plain name, never as unavailable", () => {
    const html = page();
    expect(html).toContain("Directory");
    expect(html).toContain("Untyped");
    expect(html).not.toContain("Directory (unavailable)");
    expect(html).not.toContain("Untyped (unavailable)");
  });

  it("labels the channels it mostly wrote to", () => {
    const html = page();
    expect(html).toContain("Channels it mostly wrote to");
    expect(html).toContain("bound to core");
    expect(html).not.toContain("<strong>log</strong>");
  });
});
