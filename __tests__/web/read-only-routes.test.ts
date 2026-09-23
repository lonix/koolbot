import { describe, it, expect, jest } from "@jest/globals";
import { ChannelType } from "discord.js";
import {
  buildSettingRows,
  fetchChannelData,
  loadFeatureSettings,
  VOICE_CHANNELS_SETTING_KEYS,
  readInvalidKeys,
} from "../../src/web/read-only-routes.js";
import { createMockCollection } from "../test-utils.js";
import { ConfigService } from "../../src/services/config-service.js";
import {
  defaultConfig,
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

  it("excludes the feature master voicechannels.enabled from the key list", () => {
    expect(VOICE_CHANNELS_SETTING_KEYS).not.toContain("voicechannels.enabled");
    expect(VOICE_CHANNELS_SETTING_KEYS).toContain("voicechannels.category_id");
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
