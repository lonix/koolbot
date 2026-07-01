import { describe, it, expect } from "@jest/globals";
import { ChannelType } from "discord.js";
import {
  buildSettingRows,
  fetchChannelData,
  VOICE_CHANNELS_SETTING_KEYS,
} from "../../src/web/read-only-routes.js";
import { createMockCollection } from "../test-utils.js";

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
