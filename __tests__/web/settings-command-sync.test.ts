/**
 * The slash-command state next to Reload commands on All settings (#1638): the
 * same words as the Dashboard row, an unreadable check never drawn as in sync,
 * and the existing button unchanged.
 */
import { describe, it, expect } from "@jest/globals";
import { renderSettingsPage } from "../../src/web/admin-views.js";
import type { CommandSyncReport } from "../../src/services/command-manager.js";

const render = (commandSync?: CommandSyncReport | null): string =>
  renderSettingsPage({
    csrfToken: "csrf",
    remainingMs: 60_000,
    groups: [],
    textChannels: [],
    voiceChannels: [],
    categoryChannels: [],
    roles: [],
    guildId: "g",
    guildName: "Guild",
    commandSync,
  });

describe("All settings: slash-command state (#1638)", () => {
  it("says the commands are in sync", () => {
    const html = render({ state: "in-sync", checkedAt: 0 });
    expect(html).toContain('id="commands-sync"');
    expect(html).toContain(
      '<span class="kb-status kb-status--ok">In sync</span><span>Discord has the slash commands the switched-on features need.</span>',
    );
    expect(html).not.toContain("out of sync");
  });

  it("names what differs, the impact and the way to apply it", () => {
    const html = render({
      state: "out-of-sync",
      checkedAt: 0,
      added: ["poll", "lfg"],
      removed: ["event"],
      changed: [],
    });
    expect(html).toContain(
      '<span class="kb-status kb-status--warn">Out of sync</span>',
    );
    expect(html).toContain("2 to add (/poll, /lfg), 1 to remove (/event).");
    expect(html).toContain("Members don&#39;t see /poll, /lfg in Discord yet.");
    expect(html).toContain("Reload commands applies the change.");
  });

  it("says Not checked, with the reason, for an unknown or missing check", () => {
    const unknown = render({
      state: "unknown",
      checkedAt: 0,
      reason: "Discord did not answer",
    });
    expect(unknown).toContain(">Not checked</span>");
    expect(unknown).toContain(
      "Discord did not answer. Whether the commands are in sync is not known.",
    );
    expect(unknown).not.toContain("In sync");
    const missing = render(null);
    expect(missing).toContain(">Not checked</span>");
    expect(missing).not.toContain("In sync");
  });

  it("shows nothing when the caller passes no check, and keeps the button", () => {
    const html = render();
    expect(html).not.toContain('id="commands-sync"');
    expect(html).toContain('action="/admin/settings/reload"');
    expect(html).toContain("Reload commands</button>");
  });

  it("escapes a command name", () => {
    const html = render({
      state: "out-of-sync",
      checkedAt: 0,
      added: ['<img src=x onerror="1">'],
      removed: [],
      changed: [],
    });
    expect(html).not.toContain("<img");
  });
});
