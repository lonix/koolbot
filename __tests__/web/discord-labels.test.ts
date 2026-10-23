/**
 * Channel, category and role labels follow Discord (#1303).
 *
 * `src/web/discord-labels.ts` is the one place that decides how a channel,
 * category or role name is shown. This covers the helper kind by kind, the
 * pickers built on it, and a guard that fails when a page in `src/web` goes
 * back to writing a `#` in front of a name itself.
 */

import { describe, it, expect } from "@jest/globals";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { ChannelType } from "discord.js";
import {
  channelGroupLabel,
  channelKindOf,
  channelMention,
  channelText,
  deletedVoiceMention,
  missingMention,
  missingText,
  roleMention,
  roleText,
} from "../../src/web/discord-labels.js";
import {
  renderSettingsPage,
  type ChannelOption,
} from "../../src/web/admin-views.js";

describe("channelText (plain text, for options and chips)", () => {
  const cases: Array<[string, ChannelType, string]> = [
    ["text", ChannelType.GuildText, "# general"],
    ["announcement", ChannelType.GuildAnnouncement, "📢 news"],
    ["voice", ChannelType.GuildVoice, "🔊 Lobby"],
    ["stage", ChannelType.GuildStageVoice, "🎙️ Town hall"],
    ["forum", ChannelType.GuildForum, "💬 ideas"],
    ["media", ChannelType.GuildMedia, "💬 ideas"],
    ["public thread", ChannelType.PublicThread, "🧵 ideas"],
    ["category", ChannelType.GuildCategory, "📁 Events"],
  ];
  const names: Record<string, string> = {
    text: "general",
    announcement: "news",
    voice: "Lobby",
    stage: "Town hall",
    forum: "ideas",
    media: "ideas",
    "public thread": "ideas",
    category: "Events",
  };
  it.each(cases)("%s", (kind, type, expected) => {
    expect(channelText({ name: names[kind], type })).toBe(expected);
  });

  it("never puts a # in front of a voice channel or a category", () => {
    expect(
      channelText({ name: "Lobby", type: ChannelType.GuildVoice }),
    ).not.toContain("#");
    expect(
      channelText({ name: "Events", type: ChannelType.GuildCategory }),
    ).not.toContain("#");
  });

  it("adds the category after the name, as Discord's autocomplete does", () => {
    expect(
      channelText({ name: "Lobby", type: ChannelType.GuildVoice }, "Scratch"),
    ).toBe("🔊 Lobby · SCRATCH");
  });

  it("does not add a parent to a category", () => {
    expect(
      channelText({ name: "Events", type: ChannelType.GuildCategory }, "x"),
    ).toBe("📁 Events");
  });

  it("shows a channel of unknown type as unavailable, never as a text channel", () => {
    expect(channelText({ name: "1234", type: null })).toBe(
      "⚠ 1234 (unavailable)",
    );
    expect(channelText({ name: "1234", type: undefined })).toBe(
      missingText("1234"),
    );
    expect(channelText({ name: "dm", type: ChannelType.DM })).toBe(
      "⚠ dm (unavailable)",
    );
  });

  it("writes roles as @Name", () => {
    expect(roleText("Moderators")).toBe("@Moderators");
  });
});

describe("channelMention (HTML, for tables and sentences)", () => {
  it("renders an icon with the kind as its accessible name, then the name", () => {
    const html = channelMention({
      name: "Lobby",
      type: ChannelType.GuildVoice,
    });
    expect(html).toContain('<span class="kb-mention">');
    expect(html).toContain('role="img" aria-label="Voice channel"');
    expect(html.endsWith("Lobby</span>")).toBe(true);
    expect(html).not.toContain("#");
  });

  it.each([
    [ChannelType.GuildText, "Text channel"],
    [ChannelType.GuildAnnouncement, "Announcement channel"],
    [ChannelType.GuildVoice, "Voice channel"],
    [ChannelType.GuildStageVoice, "Stage channel"],
    [ChannelType.GuildForum, "Forum channel"],
    [ChannelType.PrivateThread, "Thread"],
    [ChannelType.GuildCategory, "Category"],
  ])("type %s is announced as %s", (type, label) => {
    expect(channelMention({ name: "x", type })).toContain(
      `aria-label="${label}"`,
    );
  });

  it("marks a category with kb-mention--category and keeps the name's case", () => {
    const html = channelMention({
      name: "Events",
      type: ChannelType.GuildCategory,
    });
    expect(html).toContain('class="kb-mention kb-mention--category"');
    expect(html).toContain("Events</span>");
  });

  it("shows an unresolved channel as unavailable with an alert icon", () => {
    const html = channelMention({ name: "999", type: null });
    expect(html).toContain("kb-mention--missing");
    expect(html).toContain('aria-label="Unavailable"');
    expect(html).toContain("999 (unavailable)");
    expect(html).toBe(missingMention("999"));
  });

  it("shows a deleted voice room by its stored name with a muted (deleted)", () => {
    const html = channelMention({
      name: "999",
      type: null,
      storedName: "Alice's room",
    });
    expect(html).toContain('aria-label="Voice channel"');
    expect(html).toContain("Alice&#39;s room</span>");
    expect(html).toContain('<span class="kb-muted">(deleted)</span>');
    expect(html).not.toContain("unavailable");
    expect(html).not.toContain("kb-mention--missing");
    expect(html).toBe(deletedVoiceMention("Alice's room"));
  });

  it("keeps a live channel's own label even when a stored name exists", () => {
    const html = channelMention({
      name: "Lobby",
      type: ChannelType.GuildVoice,
      storedName: "Old name",
    });
    expect(html).toContain("Lobby</span>");
    expect(html).not.toContain("Old name");
    expect(html).not.toContain("(deleted)");
  });

  it("treats an empty stored name as no name", () => {
    expect(channelMention({ name: "999", type: null, storedName: "" })).toBe(
      missingMention("999"),
    );
    expect(channelMention({ name: "999", type: null, storedName: null })).toBe(
      missingMention("999"),
    );
  });

  it("escapes a stored name and has a plain-text form", () => {
    expect(deletedVoiceMention("<b>x</b>")).not.toContain("<b>");
    expect(
      channelText({ name: "999", type: null, storedName: "Alice's room" }),
    ).toBe("🔊 Alice's room (deleted)");
    expect(channelText({ name: "999", type: null })).toBe(missingText("999"));
  });

  it("escapes the name", () => {
    const html = channelMention({
      name: '<img src=x onerror="1">',
      type: ChannelType.GuildText,
    });
    expect(html).not.toContain("<img");
    expect(html).toContain("&lt;img");
    expect(roleMention("<b>")).toBe(
      '<span class="kb-mention">@&lt;b&gt;</span>',
    );
    expect(missingMention("<b>")).not.toContain("<b>");
  });
});

describe("kinds", () => {
  it("groups text and announcement together, voice and stage together", () => {
    expect(channelGroupLabel(ChannelType.GuildText)).toBe("Text channels");
    expect(channelGroupLabel(ChannelType.GuildAnnouncement)).toBe(
      "Text channels",
    );
    expect(channelGroupLabel(ChannelType.GuildVoice)).toBe("Voice channels");
    expect(channelGroupLabel(ChannelType.GuildStageVoice)).toBe(
      "Voice channels",
    );
    expect(channelGroupLabel(ChannelType.GuildCategory)).toBe("Categories");
  });

  it("has no kind for a type that is not a guild channel", () => {
    expect(channelKindOf(ChannelType.DM)).toBeNull();
    expect(channelKindOf(null)).toBeNull();
    expect(channelKindOf(undefined)).toBeNull();
  });
});

describe("settings pickers", () => {
  const text: ChannelOption[] = [
    {
      id: "1",
      name: "general",
      type: ChannelType.GuildText,
      parentName: "Chat",
    },
    { id: "2", name: "news", type: ChannelType.GuildAnnouncement },
  ];
  const voice: ChannelOption[] = [
    {
      id: "3",
      name: "Lobby",
      type: ChannelType.GuildVoice,
      parentName: "Scratch",
    },
  ];
  const category: ChannelOption[] = [
    { id: "4", name: "Events", type: ChannelType.GuildCategory },
  ];
  const pickers = {
    textChannels: text,
    voiceChannels: voice,
    categoryChannels: category,
    roles: [{ id: "9", name: "Moderators" }],
  };

  function page(
    type: string,
    value: string,
    channelKind?: "text" | "voice",
    overrides: Record<string, unknown> = {},
  ): string {
    return renderSettingsPage({
      csrfToken: "csrf",
      remainingMs: 60_000,
      ...pickers,
      ...overrides,
      groups: [
        {
          category: "test",
          rows: [
            {
              key: "test.picker",
              label: "Picker",
              current: value,
              defaultValue: "",
              type,
              description: "",
              category: "test",
              channelKind,
            },
          ],
        },
      ],
    } as never);
  }
  const control = (
    type: string,
    value: string,
    extra: { channelKind?: "text" | "voice" } = {},
  ): string => page(type, value, extra.channelKind);

  it("shows the event category as a category, not as #Events", () => {
    const html = control("category", "4");
    expect(html).toContain('<optgroup label="Categories">');
    expect(html).toContain('<option value="4" selected>📁 Events</option>');
    expect(html).not.toContain("#Events");
  });

  it("shows voice channels with the speaker and their category, never #", () => {
    const html = control("channel", "3", { channelKind: "voice" });
    expect(html).toContain('<optgroup label="Voice channels">');
    expect(html).toContain(
      '<option value="3" selected>🔊 Lobby · SCRATCH</option>',
    );
    expect(html).not.toContain("#Lobby");
  });

  it("lists text and announcement channels in one Text channels group", () => {
    const html = control("channel", "1");
    expect(html.match(/<optgroup /g)).toHaveLength(1);
    expect(html).toContain(
      '<option value="1" selected># general · CHAT</option>',
    );
    expect(html).toContain('<option value="2">📢 news</option>');
  });

  it("keeps roles as @Name, under a Roles group (#1394)", () => {
    const html = control("role", "9");
    expect(html).toContain('<option value="9" selected>@Moderators</option>');
    expect(html).toContain(`<optgroup label="Roles">`);
  });

  it("keeps a stored id that is no longer in the list, selected and unavailable", () => {
    const html = control("channel", "gone");
    expect(html).toContain(
      '<option value="gone" selected>⚠ gone (unavailable)</option>',
    );
    expect(html).not.toContain("#gone");
  });

  it("labels a multi-select's summary by kind too", () => {
    const html = control("channel_list", "3,gone", { channelKind: "voice" });
    expect(html).toContain(
      "Selected: 🔊 Lobby · SCRATCH, ⚠ gone (unavailable)",
    );
  });

  it("escapes names in options", () => {
    const html = page("channel", "", undefined, {
      textChannels: [
        { id: "1", name: '"><script>', type: ChannelType.GuildText },
      ],
    });
    expect(html).not.toContain('"><script>');
  });
});

// ---- guard -----------------------------------------------------------------

function sourceFiles(dir: string): string[] {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) return sourceFiles(full);
    return entry.name.endsWith(".ts") ? [full] : [];
  });
}

// A `#` written in front of an interpolated channel-ish name: `#${c.name}`,
// `#${escapeHtml(a.channelName)}`, `#${props.channel.name}`, `#${selectedId}`.
// Case numbers, ranks, issue numbers and colour hex codes interpolate other
// things and are not matched.
const HARD_CODED_PREFIX =
  /#\$\{[^}]*(name|channel|label|selectedId)[^}]*\}|["'`]#["'`]\s*\+|\bprefix\s*=\s*[^;\n]*"#"/i;

describe("no hard-coded channel prefix in src/web", () => {
  const root = fileURLToPath(new URL("../../src/web", import.meta.url));
  const helper = path.join(root, "discord-labels.ts");

  it("finds the pattern it is meant to catch", () => {
    for (const sample of [
      "`#${c.name}`",
      "`<td>#${escapeHtml(a.channelName)}</td>`",
      "`Channel #${props.channel.name}`",
      "`#${escapeHtml(selectedId)} (unavailable)`",
      'const prefix = r.type === "role" ? "@" : "#";',
    ]) {
      expect(HARD_CODED_PREFIX.test(sample)).toBe(true);
    }
    for (const sample of [
      "`Case #${c.caseNumber}`",
      "`#${entry.rank}`",
      '`#${color.toString(16).padStart(6, "0")}`',
      "`#${cov.issue}`",
    ]) {
      expect(HARD_CODED_PREFIX.test(sample)).toBe(false);
    }
  });

  it("finds no channel, category or role name written with its own #", () => {
    const offenders: string[] = [];
    for (const file of sourceFiles(root)) {
      if (file === helper) continue;
      fs.readFileSync(file, "utf8")
        .split("\n")
        .forEach((line, i) => {
          if (HARD_CODED_PREFIX.test(line)) {
            offenders.push(
              `${path.relative(root, file)}:${i + 1}: ${line.trim()}`,
            );
          }
        });
    }
    expect(offenders).toEqual([]);
  });
});
