/**
 * The "Where" cell of the permission matrix labels places the way Discord does
 * (#1394 section 2): an icon per channel kind, `@` for a role, and an unknown
 * place shown as unavailable, all through `web/discord-labels.ts`.
 */

import { describe, it, expect } from "@jest/globals";
import { ChannelType } from "discord.js";
import {
  type BotPermissionReport,
  type CheckOutcome,
  type FeatureCheck,
  type PermissionTarget,
} from "../../src/services/bot-permission-check.js";
import {
  FEATURE_REQUIREMENTS,
  ROLE_HIERARCHY_REQUIREMENTS,
} from "../../src/services/bot-permission-registry.js";
import { renderBotPermissionsPage } from "../../src/web/bot-permissions-view.js";

function feature(id: string): FeatureCheck["feature"] {
  const r =
    FEATURE_REQUIREMENTS.find((x) => x.id === id) ??
    ROLE_HIERARCHY_REQUIREMENTS.find((x) => x.id === id);
  if (!r) throw new Error(`no registry entry ${id}`);
  return {
    id: r.id,
    area: r.area,
    feature: r.feature,
    effect: r.effect,
    fix: r.fix,
  };
}

/** The matrix body for one check on `target`. */
function matrix(
  id: string,
  outcome: CheckOutcome,
  target: PermissionTarget,
): string {
  const check: FeatureCheck = {
    feature: feature(id),
    kind: target.kind === "role" ? "role-position" : "permission",
    enabled: true,
    outcome,
    target,
    missing: [],
  };
  const report: BotPermissionReport = {
    available: true,
    reason: null,
    fresh: true,
    problems: [],
    unknown: [],
    quiet: [],
    okFeatures: [],
    notes: [],
    checks: [check],
  };
  const html = renderBotPermissionsPage({
    csrfToken: "t",
    remainingMs: 1000,
    report,
  });
  const m = html.match(/<tbody>.*?<\/tbody>/s);
  if (!m) throw new Error("no matrix body");
  return m[0];
}

describe("matrix places carry Discord labels", () => {
  it("shows a voice channel with the speaker icon and its kind as the accessible name", () => {
    const html = matrix("voice-rooms", "ok", {
      kind: "channel",
      id: "5",
      name: "Lobby",
      channelType: ChannelType.GuildVoice,
    });
    expect(html).toContain('aria-label="Voice channel"');
    expect(html).toContain("Lobby</span>");
    expect(html).not.toContain("#Lobby");
  });

  it("shows a category as a category, not as a channel", () => {
    const html = matrix("event-channels", "ok", {
      kind: "category",
      id: "4",
      name: "Events",
      channelType: ChannelType.GuildCategory,
    });
    expect(html).toContain("kb-mention--category");
    expect(html).toContain('aria-label="Category"');
  });

  it("keeps a category a category when the target carries no type", () => {
    const html = matrix("event-channels", "ok", {
      kind: "category",
      id: "4",
      name: "Events",
    });
    expect(html).toContain('aria-label="Category"');
    expect(html).not.toContain("unavailable");
  });

  it("shows a text channel with the hash icon", () => {
    const html = matrix("voice-rooms", "ok", {
      kind: "channel",
      id: "6",
      name: "general",
      channelType: ChannelType.GuildText,
    });
    expect(html).toContain('aria-label="Text channel"');
  });

  it("shows a channel the bot cannot find as unavailable, with its id, never as a text channel", () => {
    const html = matrix("voice-rooms", "unknown", {
      kind: "channel",
      id: "777",
      name: "777",
    });
    expect(html).toContain("kb-mention--missing");
    expect(html).toContain("777 (unavailable)");
    expect(html).not.toContain('aria-label="Text channel"');
  });

  it("shows a role as @Name, announced as a role", () => {
    const html = matrix("rules-role-hierarchy", "ok", {
      kind: "role",
      id: "9",
      name: "Staff",
    });
    expect(html).toContain('<span class="kb-mention">@Staff</span>');
    expect(html).toContain('<span class="kb-visually-hidden">Role </span>');
  });

  it("shows a role that no longer exists as unavailable with its id", () => {
    const html = matrix("rules-role-hierarchy", "unknown", {
      kind: "role",
      id: "9",
      name: "9",
    });
    expect(html).toContain("kb-mention--missing");
    expect(html).toContain("9 (unavailable)");
  });

  it("escapes names", () => {
    const channel = matrix("voice-rooms", "ok", {
      kind: "channel",
      id: "5",
      name: "<img src=x onerror=1>",
      channelType: ChannelType.GuildVoice,
    });
    expect(channel).not.toContain("<img");
    expect(channel).toContain("&lt;img");
    const role = matrix("rules-role-hierarchy", "ok", {
      kind: "role",
      id: "9",
      name: "<b>x</b>",
    });
    expect(role).not.toContain("<b>x");
  });

  it("keeps the server-wide pill", () => {
    const html = matrix("event-tags", "ok", {
      kind: "server",
      id: null,
      name: "the server",
    });
    expect(html).toContain("Server-wide");
  });
});
