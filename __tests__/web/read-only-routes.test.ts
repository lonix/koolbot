import { describe, it, expect, jest } from "@jest/globals";
import { ChannelType } from "discord.js";
import {
  buildSettingRows,
  fetchChannelData,
  loadFeatureSettings,
  ANNOUNCEMENTS_SETTING_KEYS,
  MODERATION_SETTING_KEYS,
  POLLS_SETTING_KEYS,
  EVENTS_SETTING_KEYS,
  DIGEST_SETTING_KEYS,
  VOICE_CHANNELS_SETTING_KEYS,
  REACTION_ROLES_SETTING_KEYS,
  NOTICES_SETTING_KEYS,
  METRICS_SETTING_KEYS,
  COMMAND_AUDIT_SETTING_KEYS,
  QUOTES_SETTING_KEYS,
  BIRTHDAYS_SETTING_KEYS,
  envSettingFallback,
  readInvalidKeys,
} from "../../src/web/read-only-routes.js";
import { createMockCollection } from "../test-utils.js";
import { ConfigService } from "../../src/services/config-service.js";
import {
  defaultConfig,
  getDependencies,
  settingsMetadata,
} from "../../src/services/config-schema.js";

/**
 * Build a minimal mock Client whose single guild exposes the given channels
 * through the `guild.channels.cache` collection that fetchChannelData iterates.
 */
function mockClientWithChannels(
  channels: Array<{ id: string; name: string; type: number }>,
): any {
  const cache = createMockCollection(channels.map((c) => [c.id, c]));
  const guild = {
    id: "guild-1",
    name: "Test Guild",
    channels: {
      fetch: async (): Promise<void> => undefined,
      cache,
    },
  };
  return {
    guilds: {
      fetch: async (): Promise<typeof guild> => guild,
    },
  };
}

describe("fetchChannelData (#611)", () => {
  it("collects voice and stage channels into voiceChannels, not textChannels", async () => {
    const client = mockClientWithChannels([
      { id: "t1", name: "general", type: ChannelType.GuildText },
      { id: "t2", name: "news", type: ChannelType.GuildAnnouncement },
      { id: "v1", name: "Lounge", type: ChannelType.GuildVoice },
      { id: "v2", name: "Stage", type: ChannelType.GuildStageVoice },
      { id: "cat", name: "Voice Channels", type: ChannelType.GuildCategory },
    ]);

    const data = await fetchChannelData(client, "guild-1");

    // Voice + stage land in voiceChannels.
    expect(data.voiceChannels.map((c) => c.id).sort()).toEqual(["v1", "v2"]);
    // Text + announcement stay in textChannels (no voice leakage).
    expect(data.textChannels.map((c) => c.id).sort()).toEqual(["t1", "t2"]);
    expect(data.voiceChannels.some((c) => c.id === "t1")).toBe(false);
    // Categories remain separate.
    expect(data.categoryChannels.map((c) => c.id)).toEqual(["cat"]);
    // Every channel contributes to the id→name map.
    expect(data.names.get("v1")).toBe("Lounge");
  });

  it("sorts voiceChannels by name", async () => {
    const client = mockClientWithChannels([
      { id: "v1", name: "Zeta", type: ChannelType.GuildVoice },
      { id: "v2", name: "Alpha", type: ChannelType.GuildVoice },
    ]);

    const data = await fetchChannelData(client, "guild-1");

    expect(data.voiceChannels.map((c) => c.name)).toEqual(["Alpha", "Zeta"]);
  });

  it("returns empty lists when the guild fetch throws", async () => {
    const client = {
      guilds: {
        fetch: async (): Promise<never> => {
          throw new Error("no guild");
        },
      },
    } as any;

    const data = await fetchChannelData(client, "guild-1");

    expect(data.voiceChannels).toEqual([]);
    expect(data.textChannels).toEqual([]);
    expect(data.categoryChannels).toEqual([]);
  });
});

describe("buildSettingRows (#705)", () => {
  it("derives label/type/description from the config schema", () => {
    const rows = buildSettingRows(
      ["voicechannels.category_id", "voicechannels.presets.max_per_user"],
      [],
    );
    expect(rows).toHaveLength(2);
    const [category, maxPerUser] = rows;
    expect(category.key).toBe("voicechannels.category_id");
    expect(category.type).toBe("category");
    expect(category.label).toBe("Managed category");
    // No stored row → current falls back to the schema default.
    expect(category.current).toBe("");
    expect(maxPerUser.type).toBe("number");
    expect(maxPerUser.current).toBe(3);
  });

  it("prefers a stored DB value over the schema default", () => {
    const rows = buildSettingRows(
      ["voicechannels.lobby.name"],
      [
        {
          key: "voicechannels.lobby.name",
          value: "General",
          description: "custom",
          category: "voicechannels",
        },
      ],
    );
    expect(rows[0].current).toBe("General");
    expect(rows[0].description).toBe("custom");
  });

  it("includes the reactionroles.enabled master and style options (#974)", () => {
    expect(REACTION_ROLES_SETTING_KEYS).toEqual([
      "reactionroles.enabled",
      "reactionroles.message_channel_id",
      "reactionroles.style",
    ]);
    const [enabled, channel, style] = buildSettingRows(
      REACTION_ROLES_SETTING_KEYS,
      [],
    );
    expect(enabled.type).toBe("boolean");
    expect(channel.type).toBe("channel");
    expect(style.current).toBe("reaction");
    expect(style.options?.map((o) => o.value)).toEqual([
      "reaction",
      "button",
      "select",
    ]);
  });

  it("keeps the reactionroles keys free of dependsOn (#974)", () => {
    // The Reaction Roles route builds its rows with `buildSettingRows` and
    // passes no dependency state. If one of these keys gains a dependency,
    // switch that route to `loadFeatureSettings`.
    for (const key of REACTION_ROLES_SETTING_KEYS) {
      expect(getDependencies(key)).toEqual([]);
    }
  });

  it("falls back to an env-supplied value before the schema default (#972)", () => {
    // Same order as ConfigService.get and the Settings page: stored row,
    // then env, then default.
    const prev = process.env["notices.enabled"];
    process.env["notices.enabled"] = "true";
    try {
      const [fromEnv] = buildSettingRows(["notices.enabled"], []);
      expect(fromEnv.current).toBe(true);
      const [fromDb] = buildSettingRows(
        ["notices.enabled"],
        [{ key: "notices.enabled", value: false }],
      );
      expect(fromDb.current).toBe(false);
    } finally {
      if (prev === undefined) delete process.env["notices.enabled"];
      else process.env["notices.enabled"] = prev;
    }
  });

  it("keeps an env-supplied snowflake id as the exact string", () => {
    const prev = process.env["notices.channel_id"];
    process.env["notices.channel_id"] = "123456789012345678";
    try {
      const [row] = buildSettingRows(["notices.channel_id"], []);
      expect(row.current).toBe("123456789012345678");
    } finally {
      if (prev === undefined) delete process.env["notices.channel_id"];
      else process.env["notices.channel_id"] = prev;
    }
  });

  it("envSettingFallback coerces only non-string keys", () => {
    const prev = process.env["quotes.max_length"];
    process.env["quotes.max_length"] = "500";
    try {
      expect(envSettingFallback("quotes.max_length", 1000)).toBe(500);
      expect(envSettingFallback("quotes.max_length", "")).toBe("500");
    } finally {
      if (prev === undefined) delete process.env["quotes.max_length"];
      else process.env["quotes.max_length"] = prev;
    }
    expect(envSettingFallback("definitely.unset.key", "")).toBeNull();
  });

  it("envSettingFallback reads a boolean key the way getBoolean does", () => {
    const prev = process.env["notices.header_enabled"];
    try {
      for (const [raw, expected] of [
        ["1", true],
        ["0", false],
        ["true", true],
        ["false", false],
        ["yes", false],
      ] as const) {
        process.env["notices.header_enabled"] = raw;
        expect(envSettingFallback("notices.header_enabled", true)).toBe(
          expected,
        );
      }
      // Unset keeps null so the schema default still applies.
      delete process.env["notices.header_enabled"];
      expect(envSettingFallback("notices.header_enabled", true)).toBeNull();
      process.env["notices.header_enabled"] = "1";
      const [row] = buildSettingRows(["notices.header_enabled"], []);
      expect(row.current).toBe(true);
    } finally {
      if (prev === undefined) delete process.env["notices.header_enabled"];
      else process.env["notices.header_enabled"] = prev;
    }
  });

  it("lists every voicechannels key, master included (#979)", () => {
    expect([...VOICE_CHANNELS_SETTING_KEYS]).toEqual([
      "voicechannels.enabled",
      "voicechannels.category_id",
      "voicechannels.lobby.name",
      "voicechannels.lobby.offlinename",
      "voicechannels.channel.prefix",
      "voicechannels.channel.suffix",
      "voicechannels.controlpanel.enabled",
      "voicechannels.presets.enabled",
      "voicechannels.presets.max_per_user",
    ]);
  });

  it("lists every editable notices key, master included, bookkeeping excluded (#972)", () => {
    expect([...NOTICES_SETTING_KEYS]).toEqual([
      "notices.enabled",
      "notices.channel_id",
      "notices.header_enabled",
      "notices.header_pin_enabled",
    ]);
    const rows = buildSettingRows(NOTICES_SETTING_KEYS, []);
    expect(rows.map((r) => r.type)).toEqual([
      "boolean",
      "channel",
      "boolean",
      "boolean",
    ]);
  });

  it("lists every quotes key, master included, bookkeeping excluded (#984)", () => {
    const quoteKeys = Object.keys(defaultConfig).filter((k) =>
      k.startsWith("quotes."),
    );
    expect([...QUOTES_SETTING_KEYS].sort()).toEqual(
      quoteKeys.filter((k) => k !== "quotes.header_message_id").sort(),
    );
    const rows = buildSettingRows(QUOTES_SETTING_KEYS, []);
    const typeOf = (key: string): string | undefined =>
      rows.find((r) => r.key === key)?.type;
    expect(typeOf("quotes.channel_id")).toBe("channel");
    expect(typeOf("quotes.delete_roles")).toBe("role_list");
    expect(typeOf("quotes.cooldown")).toBe("number");
  });

  it("lists every birthdays key, master included (#986)", () => {
    const birthdayKeys = Object.keys(defaultConfig).filter((k) =>
      k.startsWith("birthdays."),
    );
    expect([...BIRTHDAYS_SETTING_KEYS].sort()).toEqual(birthdayKeys.sort());
    const rows = buildSettingRows(BIRTHDAYS_SETTING_KEYS, []);
    const typeOf = (key: string): string | undefined =>
      rows.find((r) => r.key === key)?.type;
    expect(typeOf("birthdays.enabled")).toBe("boolean");
    expect(typeOf("birthdays.channel_id")).toBe("channel");
    expect(typeOf("birthdays.cron")).toBe("cron");
    expect(typeOf("birthdays.role_id")).toBe("role");
    expect(typeOf("birthdays.role_duration_hours")).toBe("number");
  });
});

// Issue #971: the route-side one-liner behind every feature-page settings
// card. It must fetch only the picker lists the card's keys render, and
// resolve off-card dependencies the same way the Settings page does.
describe("loadFeatureSettings (#971)", () => {
  function countingClient(): {
    client: any;
    calls: { channels: number; roles: number };
  } {
    const calls = { channels: 0, roles: 0 };
    const guild = {
      id: "guild-1",
      channels: {
        fetch: async (): Promise<void> => {
          calls.channels += 1;
        },
        cache: createMockCollection([
          ["t1", { id: "t1", name: "general", type: ChannelType.GuildText }],
          ["c1", { id: "c1", name: "Voice", type: ChannelType.GuildCategory }],
        ]),
      },
      roles: {
        fetch: async (): Promise<void> => {
          calls.roles += 1;
        },
        cache: createMockCollection([
          ["guild-1", { id: "guild-1", name: "@everyone" }],
          ["r1", { id: "r1", name: "Mods" }],
        ]),
      },
    };
    return {
      client: { guilds: { fetch: async () => guild } },
      calls,
    };
  }

  it("loads the Moderation card with a text-channel picker for its log channel (#977)", async () => {
    const { client, calls } = countingClient();
    const data = await loadFeatureSettings(
      client,
      "guild-1",
      MODERATION_SETTING_KEYS,
      [
        { key: "moderation.retention_days", value: 30 },
        { key: "core.moderation.channel_id", value: "t1" },
      ],
    );
    expect(data.settingRows.map((r) => r.key)).toEqual([
      ...MODERATION_SETTING_KEYS,
    ]);
    const byKey = new Map(data.settingRows.map((r) => [r.key, r]));
    expect(byKey.get("moderation.retention_days")?.current).toBe(30);
    expect(byKey.get("core.moderation.channel_id")?.type).toBe("channel");
    expect(byKey.get("core.moderation.channel_id")?.current).toBe("t1");
    expect(byKey.get("core.moderation.enabled")?.category).toBe("core");
    expect(calls).toEqual({ channels: 1, roles: 0 });
    expect(data.pickers.textChannels).toEqual([{ id: "t1", name: "general" }]);
  });

  it("loads the Announcements card as the lone master toggle, no guild fetch (#977)", async () => {
    const { client, calls } = countingClient();
    const data = await loadFeatureSettings(
      client,
      "guild-1",
      ANNOUNCEMENTS_SETTING_KEYS,
      [{ key: "announcements.enabled", value: true }],
    );
    expect(data.settingRows.map((r) => [r.key, r.current])).toEqual([
      ["announcements.enabled", true],
    ]);
    expect(calls).toEqual({ channels: 0, roles: 0 });
  });

  it("skips every guild fetch when no key needs a picker", async () => {
    const { client, calls } = countingClient();
    const data = await loadFeatureSettings(
      client,
      "guild-1",
      ["quotes.enabled", "quotes.max_length"],
      [{ key: "quotes.max_length", value: 99 }],
    );
    expect(calls).toEqual({ channels: 0, roles: 0 });
    expect(data.pickers).toEqual({});
    expect(data.settingRows.map((r) => r.key)).toEqual([
      "quotes.enabled",
      "quotes.max_length",
    ]);
    expect(data.settingRows[1].current).toBe(99);
  });

  it("fetches channels for a category key but not roles", async () => {
    const { client, calls } = countingClient();
    const data = await loadFeatureSettings(
      client,
      "guild-1",
      ["voicechannels.category_id"],
      [],
    );
    expect(calls).toEqual({ channels: 1, roles: 0 });
    expect(data.pickers.categoryChannels).toEqual([
      { id: "c1", name: "Voice" },
    ]);
    expect(data.pickers.textChannels).toEqual([{ id: "t1", name: "general" }]);
    expect(data.pickers.roles).toBeUndefined();
  });

  it("fetches roles (minus @everyone) for a role key", async () => {
    const roleKey = Object.keys(defaultConfig).find(
      (k) =>
        settingsMetadata[k as keyof typeof settingsMetadata]?.type === "role",
    );
    expect(roleKey).toBeDefined();
    const { client, calls } = countingClient();
    const data = await loadFeatureSettings(client, "guild-1", [roleKey!], []);
    expect(calls.roles).toBe(1);
    expect(data.pickers.roles).toEqual([{ id: "r1", name: "Mods" }]);
  });

  it("falls back to an env-supplied value before the schema default", async () => {
    const { client } = countingClient();
    const previous = process.env["achievements.enabled"];
    const flipped = defaultConfig["achievements.enabled"] !== true;
    process.env["achievements.enabled"] = String(flipped);
    try {
      const data = await loadFeatureSettings(
        client,
        "guild-1",
        ["digest.include_achievements"],
        [],
      );
      expect(data.dependencyState.get("achievements.enabled")).toBe(flipped);
      // A stored row still wins over the environment.
      const stored = await loadFeatureSettings(
        client,
        "guild-1",
        ["digest.include_achievements"],
        [{ key: "achievements.enabled", value: !flipped }],
      );
      expect(stored.dependencyState.get("achievements.enabled")).toBe(!flipped);
    } finally {
      if (previous === undefined) delete process.env["achievements.enabled"];
      else process.env["achievements.enabled"] = previous;
    }
  });

  it("renders an env-supplied value for a key with no stored row (#973)", async () => {
    const { client } = countingClient();
    const previous = process.env["polls.enabled"];
    process.env["polls.enabled"] = "true";
    try {
      const data = await loadFeatureSettings(
        client,
        "guild-1",
        ["polls.enabled", "polls.cooldown_days"],
        [],
      );
      expect(data.settingRows[0].current).toBe(true);
      // Keys without an env var still fall back to the schema default.
      expect(data.settingRows[1].current).toBe(
        defaultConfig["polls.cooldown_days"],
      );
      // A stored row still wins over the environment.
      const stored = await loadFeatureSettings(
        client,
        "guild-1",
        ["polls.enabled"],
        [{ key: "polls.enabled", value: false }],
      );
      expect(stored.settingRows[0].current).toBe(false);
    } finally {
      if (previous === undefined) delete process.env["polls.enabled"];
      else process.env["polls.enabled"] = previous;
    }
  });

  it("coerces env values to the key's type like ConfigService does (#973)", async () => {
    const { client } = countingClient();
    const saved = {
      enabled: process.env["polls.enabled"],
      cooldown: process.env["polls.cooldown_days"],
      duration: process.env["polls.default_duration_hours"],
    };
    process.env["polls.enabled"] = "1";
    process.env["polls.cooldown_days"] = "not-a-number";
    process.env["polls.default_duration_hours"] = "true";
    try {
      const data = await loadFeatureSettings(
        client,
        "guild-1",
        [
          "polls.enabled",
          "polls.cooldown_days",
          "polls.default_duration_hours",
        ],
        [],
      );
      const byKey = new Map(data.settingRows.map((r) => [r.key, r.current]));
      // getBoolean treats a non-zero number as on.
      expect(byKey.get("polls.enabled")).toBe(true);
      // getNumber falls back to the default for an unparsable string...
      expect(byKey.get("polls.cooldown_days")).toBe(
        defaultConfig["polls.cooldown_days"],
      );
      // ...and reads a boolean as 1 / 0.
      expect(byKey.get("polls.default_duration_hours")).toBe(1);
    } finally {
      const restore = (key: string, value: string | undefined) => {
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
      };
      restore("polls.enabled", saved.enabled);
      restore("polls.cooldown_days", saved.cooldown);
      restore("polls.default_duration_hours", saved.duration);
    }
  });

  it("resolves off-card dependencies from stored rows, else the schema default", async () => {
    const { client } = countingClient();
    const data = await loadFeatureSettings(
      client,
      "guild-1",
      ["digest.enabled", "digest.include_achievements"],
      [{ key: "voicetracking.enabled", value: true }],
    );
    expect(data.dependencyState.get("voicetracking.enabled")).toBe(true);
    expect(data.dependencyState.get("achievements.enabled")).toBe(
      defaultConfig["achievements.enabled"] === true,
    );
    // Keys on the card judge themselves from their own rows.
    expect(data.dependencyState.has("digest.enabled")).toBe(false);
  });

  it("reports a readable snapshot as available", async () => {
    const { client } = countingClient();
    const data = await loadFeatureSettings(
      client,
      "guild-1",
      ["quotes.enabled"],
      [],
    );
    expect(data.unavailable).toBe(false);
  });

  it("fails closed when the caller's snapshot read failed (null)", async () => {
    const { client, calls } = countingClient();
    const data = await loadFeatureSettings(
      client,
      "guild-1",
      ["voicechannels.category_id", "voicechannels.lobby.name"],
      null,
    );
    // No rows built from schema defaults, and no picker round-trips for a
    // card that won't render.
    expect(data.unavailable).toBe(true);
    expect(data.settingRows).toEqual([]);
    expect(data.pickers).toEqual({});
    expect(data.dependencyState.size).toBe(0);
    expect(calls).toEqual({ channels: 0, roles: 0 });
  });

  it("fails closed when its own config.getAll() read rejects", async () => {
    const { client, calls } = countingClient();
    const spy = jest.spyOn(ConfigService, "getInstance").mockReturnValue({
      getAll: async () => {
        throw new Error("mongo down");
      },
    } as unknown as ConfigService);
    try {
      const data = await loadFeatureSettings(client, "guild-1", [
        "voicechannels.category_id",
      ]);
      expect(data.unavailable).toBe(true);
      expect(data.settingRows).toEqual([]);
      expect(calls).toEqual({ channels: 0, roles: 0 });
    } finally {
      spy.mockRestore();
    }
  });

  it("builds rows from its own config.getAll() read when it succeeds", async () => {
    const { client } = countingClient();
    const spy = jest.spyOn(ConfigService, "getInstance").mockReturnValue({
      getAll: async () => [{ key: "quotes.max_length", value: 42 }],
    } as unknown as ConfigService);
    try {
      const data = await loadFeatureSettings(client, "guild-1", [
        "quotes.max_length",
      ]);
      expect(data.unavailable).toBe(false);
      expect(data.settingRows[0].current).toBe(42);
    } finally {
      spy.mockRestore();
    }
  });
});

// Issue #976: the Weekly Digest page edits every `digest.*` key in place.
describe("DIGEST_SETTING_KEYS (#976)", () => {
  it("lists every digest.* key in the schema, master first", () => {
    const schemaKeys = Object.keys(defaultConfig).filter((k) =>
      k.startsWith("digest."),
    );
    expect([...DIGEST_SETTING_KEYS].sort()).toEqual(schemaKeys.sort());
    expect(DIGEST_SETTING_KEYS[0]).toBe("digest.enabled");
  });

  it("resolves the off-card voice tracking and achievements dependencies", async () => {
    const data = await loadFeatureSettings(
      {} as any,
      "guild-1",
      DIGEST_SETTING_KEYS,
      [
        { key: "digest.cron", value: "0 16 * * 5" },
        { key: "voicetracking.enabled", value: true },
        { key: "achievements.enabled", value: false },
      ],
    );
    expect(data.unavailable).toBe(false);
    expect(data.settingRows.map((r) => r.key)).toEqual([
      ...DIGEST_SETTING_KEYS,
    ]);
    expect(data.settingRows.find((r) => r.key === "digest.cron")?.current).toBe(
      "0 16 * * 5",
    );
    expect(data.dependencyState.get("voicetracking.enabled")).toBe(true);
    expect(data.dependencyState.get("achievements.enabled")).toBe(false);
    // No channel or role keys, so no guild fetches were needed.
    expect(data.pickers).toEqual({});
  });
});

// Issue #975: the Events page edits every `events.*` key in place.
describe("EVENTS_SETTING_KEYS (#975)", () => {
  it("lists every events.* key in the schema, master first", () => {
    const schemaKeys = Object.keys(defaultConfig).filter((k) =>
      k.startsWith("events."),
    );
    expect([...EVENTS_SETTING_KEYS].sort()).toEqual(schemaKeys.sort());
    expect(EVENTS_SETTING_KEYS[0]).toBe("events.enabled");
  });

  it("fetches the channel pickers but not roles", async () => {
    const calls = { channels: 0, roles: 0 };
    const guild = {
      id: "guild-1",
      channels: {
        fetch: async (): Promise<void> => {
          calls.channels += 1;
        },
        cache: createMockCollection([
          ["t1", { id: "t1", name: "general", type: ChannelType.GuildText }],
          ["c1", { id: "c1", name: "Events", type: ChannelType.GuildCategory }],
        ]),
      },
      roles: {
        fetch: async (): Promise<void> => {
          calls.roles += 1;
        },
        cache: createMockCollection([]),
      },
    };
    const client: any = { guilds: { fetch: async () => guild } };
    const data = await loadFeatureSettings(
      client,
      "guild-1",
      EVENTS_SETTING_KEYS,
      [{ key: "events.reminder_minutes", value: 45 }],
    );
    expect(calls).toEqual({ channels: 1, roles: 0 });
    expect(data.pickers.textChannels?.map((c) => c.id)).toEqual(["t1"]);
    expect(data.pickers.categoryChannels?.map((c) => c.id)).toEqual(["c1"]);
    expect(data.pickers.roles).toBeUndefined();
    expect(data.settingRows.map((r) => r.key)).toEqual([
      ...EVENTS_SETTING_KEYS,
    ]);
    expect(
      data.settingRows.find((r) => r.key === "events.reminder_minutes")
        ?.current,
    ).toBe(45);
  });
});

// Issue #978: the Command Metrics and Command Audit pages edit their keys in
// place.
describe("METRICS_SETTING_KEYS / COMMAND_AUDIT_SETTING_KEYS (#978)", () => {
  it("cover every metrics and audit key in the schema", () => {
    const schemaKeys = Object.keys(defaultConfig);
    expect([...METRICS_SETTING_KEYS].sort()).toEqual(
      schemaKeys.filter((k) => k.startsWith("monitoring.metrics")).sort(),
    );
    expect([...COMMAND_AUDIT_SETTING_KEYS].sort()).toEqual(
      schemaKeys.filter((k) => /^core\.(command|web)_audit\./.test(k)).sort(),
    );
  });

  it("builds rows without fetching any guild picker", async () => {
    const fetchGuild = jest.fn(async () => ({}));
    const client: any = { guilds: { fetch: fetchGuild } };
    const data = await loadFeatureSettings(
      client,
      "guild-1",
      COMMAND_AUDIT_SETTING_KEYS,
      [{ key: "core.command_audit.retention_days", value: 14 }],
    );
    expect(fetchGuild).not.toHaveBeenCalled();
    expect(data.unavailable).toBe(false);
    expect(data.settingRows.map((r) => r.key)).toEqual([
      ...COMMAND_AUDIT_SETTING_KEYS,
    ]);
    expect(
      data.settingRows.find(
        (r) => r.key === "core.command_audit.retention_days",
      )?.current,
    ).toBe(14);
    expect(data.settingRows.every((r) => r.category === "core")).toBe(true);
  });
});

// Issue #973: the Polls page edits every `polls.*` key in place.
describe("POLLS_SETTING_KEYS (#973)", () => {
  it("lists every polls.* key in the schema, master first", () => {
    const schemaKeys = Object.keys(defaultConfig).filter((k) =>
      k.startsWith("polls."),
    );
    expect([...POLLS_SETTING_KEYS].sort()).toEqual(schemaKeys.sort());
    expect(POLLS_SETTING_KEYS[0]).toBe("polls.enabled");
  });

  it("builds rows without any guild picker fetch", async () => {
    let fetched = 0;
    const client: any = {
      guilds: {
        fetch: async () => {
          fetched += 1;
          throw new Error("unexpected guild fetch");
        },
      },
    };
    const data = await loadFeatureSettings(
      client,
      "guild-1",
      POLLS_SETTING_KEYS,
      [{ key: "polls.cooldown_days", value: 14 }],
    );
    expect(fetched).toBe(0);
    expect(data.settingRows.map((r) => r.key)).toEqual([...POLLS_SETTING_KEYS]);
    expect(
      data.settingRows.find((r) => r.key === "polls.cooldown_days")?.current,
    ).toBe(14);
  });
});

// Issue #854: the Settings page marks the controls a failed save rejected,
// driven by the `?invalid=` list the redirect carries. The list arrives from
// the URL, so it is filtered to the shape a config key can take and capped —
// a hand-crafted redirect must not be able to inject ids into the page or
// pump an unbounded list through it.
describe("readInvalidKeys (#854)", () => {
  it("returns nothing when the param is absent or empty", () => {
    expect(readInvalidKeys({ query: {} })).toEqual([]);
    expect(readInvalidKeys({ query: { invalid: "" } })).toEqual([]);
  });

  it("splits a comma-separated list of dotted config keys", () => {
    expect(
      readInvalidKeys({
        query: { invalid: "quotes.enabled,voicechannels.lobby_channel_name" },
      }),
    ).toEqual(["quotes.enabled", "voicechannels.lobby_channel_name"]);
  });

  it("drops entries that aren't shaped like a config key", () => {
    expect(
      readInvalidKeys({
        query: { invalid: 'quotes.enabled,"><script>,a b,x..y,,ok.key' },
      }),
    ).toEqual(["quotes.enabled", "ok.key"]);
  });

  it("de-duplicates and caps the list", () => {
    expect(readInvalidKeys({ query: { invalid: "a.b,a.b,c.d" } })).toEqual([
      "a.b",
      "c.d",
    ]);
    const many = Array.from({ length: 60 }, (_, i) => `x.k${i}`).join(",");
    expect(readInvalidKeys({ query: { invalid: many } })).toHaveLength(25);
  });

  it("ignores a repeated param that arrives as an array", () => {
    expect(readInvalidKeys({ query: { invalid: ["a.b", "c.d"] } })).toEqual([]);
  });
});
