/**
 * The permission notice on the All settings sections (#1487), from literal
 * reports: the category-to-area table, one check per page, the per-section
 * split, and the degrade rules (off, unset channel, unavailable, stale).
 */

import { describe, it, expect, jest } from "@jest/globals";
import type { Client } from "discord.js";
import type {
  BotPermissionReport,
  CheckOutcome,
  FeatureCheck,
  PermissionTarget,
} from "../../src/services/bot-permission-check.js";
import {
  FEATURE_REQUIREMENTS,
  LOG_CHANNEL_TYPES,
} from "../../src/services/bot-permission-registry.js";
import { renderPermissionNotice } from "../../src/web/permission-notice.js";
import {
  SETTINGS_NOTICE_AREAS,
  loadSettingsPermissionNotices,
  sectionInUse,
} from "../../src/web/settings-permission-notices.js";

const client = {} as unknown as Client;
const text = (name: string): PermissionTarget => ({
  kind: "channel",
  id: `ch-${name}`,
  name,
});

function featureRef(id: string): FeatureCheck["feature"] {
  const r = FEATURE_REQUIREMENTS.find((x) => x.id === id);
  if (!r) throw new Error(`no registry entry ${id}`);
  return {
    id: r.id,
    area: r.area,
    feature: r.feature,
    effect: r.effect,
    fix: r.fix,
  };
}

function check(
  id: string,
  outcome: CheckOutcome,
  channel: string,
  missing: string[] = [],
): FeatureCheck {
  return {
    feature: featureRef(id),
    kind: "permission",
    enabled: true,
    outcome,
    target: text(channel),
    missing,
  };
}

function report(
  checks: FeatureCheck[],
  o: Partial<BotPermissionReport> = {},
): BotPermissionReport {
  return {
    available: true,
    reason: null,
    fresh: true,
    problems: [],
    unknown: [],
    quiet: [],
    okFeatures: [],
    notes: [],
    checks,
    ...o,
  };
}

type Row = { key: string; current: unknown };
const group = (category: string, rows: Record<string, unknown>) => ({
  category,
  rows: Object.entries(rows).map(([key, current]): Row => ({ key, current })),
});

/** Every mapped section with its feature on and a channel set. */
const ALL_ON = [
  group("celebrations", {
    "celebrations.enabled": true,
    "achievements.enabled": true,
    "voicetracking.enabled": true,
    "celebrations.channel_id": "111",
  }),
  group("welcome", { "welcome.enabled": true, "welcome.channel_id": "222" }),
  group("lfg", { "lfg.enabled": true, "lfg.channel_id": "333" }),
  group("voicetracking", {
    "voicetracking.enabled": true,
    "voicetracking.announcements.enabled": true,
    "voicetracking.announcements.include_voice_stats": true,
    "voicetracking.announcements.channel_id": "444",
  }),
  group("core", {
    "core.errors.enabled": true,
    "core.errors.channel_id": "555",
  }),
];

const CELEBRATE = check("celebrations-post", "missing", "party", [
  "Send Messages",
]);
const WELCOME = check("welcome-post", "ok", "hello");
const ERRORS = check("log-errors", "missing", "errors", ["Embed Links"]);

describe("SETTINGS_NOTICE_AREAS", () => {
  it("maps the five sections of the issue", () => {
    expect(Object.keys(SETTINGS_NOTICE_AREAS).sort()).toEqual(
      ["celebrations", "core", "lfg", "voicetracking", "welcome"].sort(),
    );
  });

  it("names only areas that exist in the registry", () => {
    const known = new Set(FEATURE_REQUIREMENTS.map((r) => r.area));
    for (const [category, areas] of Object.entries(SETTINGS_NOTICE_AREAS)) {
      for (const area of areas) {
        expect({ category, area, exists: known.has(area) }).toEqual({
          category,
          area,
          exists: true,
        });
      }
    }
  });

  it("covers every log channel type through the Discord logging area", () => {
    const logEntries = FEATURE_REQUIREMENTS.filter(
      (r) => r.area === "Discord logging",
    );
    expect(logEntries).toHaveLength(LOG_CHANNEL_TYPES.length);
  });
});

describe("loadSettingsPermissionNotices", () => {
  it("runs the check once for the whole page and gives each section its own notice", async () => {
    const run = jest.fn(async () => report([CELEBRATE, WELCOME, ERRORS]));
    const notices = await loadSettingsPermissionNotices({
      client,
      guildId: "g1",
      groups: ALL_ON,
      check: run,
    });
    expect(run).toHaveBeenCalledTimes(1);
    expect(Object.keys(notices).sort()).toEqual(["celebrations", "core"]);
    const opts = { canLinkToPage: true };
    const celebrations = renderPermissionNotice(notices.celebrations, opts);
    expect(celebrations).toContain("Send Messages");
    expect(celebrations).toContain("in the channel “party”");
    expect(celebrations).not.toContain("Embed Links");
    const core = renderPermissionNotice(notices.core, opts);
    expect(core).toContain("Embed Links");
    expect(core).toContain("in the channel “errors”");
    expect(core).not.toContain("Send Messages");
  });

  it("says nothing when the permissions are in place", async () => {
    const notices = await loadSettingsPermissionNotices({
      client,
      guildId: "g1",
      groups: ALL_ON,
      check: async () => report([WELCOME]),
    });
    expect(notices).toEqual({});
  });

  it("labels a read from the bot's cache as possibly out of date", async () => {
    const notices = await loadSettingsPermissionNotices({
      client,
      guildId: "g1",
      groups: ALL_ON,
      check: async () => report([CELEBRATE], { fresh: false }),
    });
    expect(notices.celebrations.stale).toBe(true);
    expect(
      renderPermissionNotice(notices.celebrations, { canLinkToPage: true }),
    ).toContain("may be out of date");
  });

  it("says the check could not run, with the reason, on each section in use", async () => {
    const notices = await loadSettingsPermissionNotices({
      client,
      guildId: "g1",
      groups: ALL_ON,
      check: async () =>
        report([], { available: false, reason: "The bot is not connected." }),
    });
    expect(Object.keys(notices).sort()).toEqual(
      Object.keys(SETTINGS_NOTICE_AREAS).sort(),
    );
    const html = renderPermissionNotice(notices.lfg, { canLinkToPage: true });
    expect(html).toContain("Bot permissions could not be checked");
    expect(html).toContain("The bot is not connected.");
  });

  it("says the check could not run when it throws or takes too long", async () => {
    const thrown = await loadSettingsPermissionNotices({
      client,
      guildId: "g1",
      groups: [ALL_ON[1]],
      check: async () => {
        throw new Error("boom");
      },
    });
    expect(thrown.welcome.unavailable).toContain("could not be checked");
    const slow = await loadSettingsPermissionNotices({
      client,
      guildId: "g1",
      groups: [ALL_ON[1]],
      timeoutMs: 5,
      check: () => new Promise<BotPermissionReport>(() => undefined),
    });
    expect(slow.welcome.unavailable).toContain("did not finish in time");
  });

  it("makes no check and shows nothing for off features, unset channels and unmapped sections", async () => {
    const run = jest.fn(async () => report([CELEBRATE, WELCOME, ERRORS]));
    const notices = await loadSettingsPermissionNotices({
      client,
      guildId: "g1",
      groups: [
        group("welcome", {
          "welcome.enabled": false,
          "welcome.channel_id": "2",
        }),
        group("lfg", { "lfg.enabled": true, "lfg.channel_id": "" }),
        group("core", {
          "core.errors.enabled": true,
          "core.errors.channel_id": "  ",
        }),
        group("quotes", { "quotes.enabled": true, "quotes.channel_id": "9" }),
      ],
      check: run,
    });
    expect(notices).toEqual({});
    expect(run).not.toHaveBeenCalled();
  });

  it("does not show an unmapped section a finding of its own", async () => {
    const notices = await loadSettingsPermissionNotices({
      client,
      guildId: "g1",
      groups: [ALL_ON[1], group("quotes", { "quotes.enabled": true })],
      check: async () =>
        report([check("welcome-post", "missing", "hello", ["Send Messages"])]),
    });
    expect(Object.keys(notices)).toEqual(["welcome"]);
  });

  it("respects alsoKeys: a log type whose producer is off shows nothing", async () => {
    // Cleanup logs only while the voice-session cleanup is on.
    const off = group("core", {
      "core.cleanup.enabled": true,
      "core.cleanup.channel_id": "7",
      "voicetracking.cleanup.enabled": false,
    });
    expect(sectionInUse("core", (k) => rowValue(off, k))).toBe(false);
    const on = group("core", {
      "core.cleanup.enabled": true,
      "core.cleanup.channel_id": "7",
      "voicetracking.cleanup.enabled": true,
    });
    expect(sectionInUse("core", (k) => rowValue(on, k))).toBe(true);
  });

  it("reads a setting the page did not render from the schema default", async () => {
    // moderation.enabled is not on the page; its default (off) keeps the
    // moderation log quiet, as the registry's alsoKeys say.
    const g = group("core", {
      "core.moderation.enabled": true,
      "core.moderation.channel_id": "8",
    });
    expect(sectionInUse("core", (k) => rowValue(g, k))).toBe(false);
  });
});

function rowValue(g: ReturnType<typeof group>, key: string): unknown {
  return g.rows.find((r) => r.key === key)?.current;
}
