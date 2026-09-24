import { describe, it, expect, jest, beforeEach } from "@jest/globals";
import { ChannelType, type Client } from "discord.js";
import type { ConfigService } from "../../src/services/config-service.js";

const mockLogger = {
  info: jest.fn(),
  warn: jest.fn(),
  error: jest.fn(),
  debug: jest.fn(),
};
jest.unstable_mockModule("../../src/utils/logger.js", () => ({
  default: mockLogger,
}));

const { runNameToIdMigrations } =
  await import("../../src/services/name-id-migrator.js");

const OLD_CHANNEL = "voicetracking.announcements.channel";
const NEW_CHANNEL = "voicetracking.announcements.channel_id";
const OLD_CATEGORY = "voicechannels.category.name";
const NEW_CATEGORY = "voicechannels.category_id";

interface FakeChannel {
  id: string;
  name: string;
  type: ChannelType;
}

function makeGuild(channels: FakeChannel[]) {
  return {
    name: "Test Guild",
    channels: {
      cache: {
        find: (pred: (ch: FakeChannel) => boolean) => channels.find(pred),
      },
      fetch: jest.fn<() => Promise<unknown>>().mockResolvedValue(undefined),
    },
    roles: {
      fetch: jest.fn<() => Promise<unknown>>().mockResolvedValue(undefined),
    },
  };
}

function makeClient(guild: unknown, fetchError?: Error): Client {
  const fetch = jest.fn<(id: string) => Promise<unknown>>();
  if (fetchError) fetch.mockRejectedValue(fetchError);
  else fetch.mockResolvedValue(guild);
  return { guilds: { fetch } } as unknown as Client;
}

// In-memory stand-in for ConfigService's getString/set/delete surface.
function makeConfig(initial: Record<string, string>) {
  const store = new Map(Object.entries(initial));
  const service = {
    getString: jest.fn(
      async (key: string, def = ""): Promise<string> => store.get(key) ?? def,
    ),
    set: jest.fn(async (key: string, value: unknown): Promise<void> => {
      store.set(key, String(value));
    }),
    delete: jest.fn(async (key: string): Promise<void> => {
      store.delete(key);
    }),
  };
  return {
    store,
    service,
    asConfig: service as unknown as ConfigService,
  };
}

const channels: FakeChannel[] = [
  { id: "c-voice", name: "Voice", type: ChannelType.GuildVoice },
  { id: "c-text", name: "voice-stats", type: ChannelType.GuildText },
  { id: "c-news", name: "news", type: ChannelType.GuildAnnouncement },
  { id: "c-cat", name: "Dynamic Voice", type: ChannelType.GuildCategory },
];

beforeEach(() => {
  jest.clearAllMocks();
});

describe("runNameToIdMigrations", () => {
  it("skips entirely when no guild id is configured", async () => {
    const client = makeClient(makeGuild(channels));
    const cfg = makeConfig({ [OLD_CHANNEL]: "voice-stats" });

    await runNameToIdMigrations(client, "", cfg.asConfig);

    expect(client.guilds.fetch).not.toHaveBeenCalled();
    expect(cfg.service.getString).not.toHaveBeenCalled();
    expect(mockLogger.warn).toHaveBeenCalledWith(
      expect.stringContaining("GUILD_ID not configured"),
    );
  });

  it("resolves legacy names to ids, writes the new keys and removes the old ones", async () => {
    const guild = makeGuild(channels);
    const client = makeClient(guild);
    const cfg = makeConfig({
      [OLD_CHANNEL]: "voice-stats",
      [OLD_CATEGORY]: "Dynamic Voice",
    });

    await runNameToIdMigrations(client, "guild-1", cfg.asConfig);

    expect(client.guilds.fetch).toHaveBeenCalledWith("guild-1");
    expect(guild.channels.fetch).toHaveBeenCalled();
    expect(guild.roles.fetch).toHaveBeenCalled();
    expect(cfg.service.set).toHaveBeenCalledWith(
      NEW_CHANNEL,
      "c-text",
      `Migrated from ${OLD_CHANNEL}="voice-stats"`,
      "voicetracking",
      { skipDependencyCheck: true },
    );
    expect(cfg.service.set).toHaveBeenCalledWith(
      NEW_CATEGORY,
      "c-cat",
      `Migrated from ${OLD_CATEGORY}="Dynamic Voice"`,
      "voicechannels",
      { skipDependencyCheck: true },
    );
    expect(Object.fromEntries(cfg.store)).toEqual({
      [NEW_CHANNEL]: "c-text",
      [NEW_CATEGORY]: "c-cat",
    });
  });

  it("accepts an announcement channel for the voice-stats channel", async () => {
    const cfg = makeConfig({ [OLD_CHANNEL]: "news" });

    await runNameToIdMigrations(
      makeClient(makeGuild(channels)),
      "guild-1",
      cfg.asConfig,
    );

    expect(cfg.store.get(NEW_CHANNEL)).toBe("c-news");
    expect(cfg.store.has(OLD_CHANNEL)).toBe(false);
  });

  it("only matches channels of the expected type", async () => {
    // "Voice" exists, but as a voice channel — neither a text channel nor a
    // category — so neither rename may pick it up.
    const cfg = makeConfig({ [OLD_CHANNEL]: "Voice", [OLD_CATEGORY]: "Voice" });

    await runNameToIdMigrations(
      makeClient(makeGuild(channels)),
      "guild-1",
      cfg.asConfig,
    );

    expect(cfg.service.set).not.toHaveBeenCalled();
    expect(cfg.service.delete).not.toHaveBeenCalled();
  });

  it("skips all renames when the guild cannot be fetched", async () => {
    const cfg = makeConfig({ [OLD_CHANNEL]: "voice-stats" });
    const client = makeClient(undefined, new Error("Unknown Guild"));

    await expect(
      runNameToIdMigrations(client, "guild-1", cfg.asConfig),
    ).resolves.toBeUndefined();

    expect(cfg.service.getString).not.toHaveBeenCalled();
    expect(cfg.service.set).not.toHaveBeenCalled();
    expect(cfg.store.get(OLD_CHANNEL)).toBe("voice-stats");
    expect(mockLogger.warn).toHaveBeenCalledWith(
      expect.stringContaining("could not fetch guild guild-1"),
      expect.any(Error),
    );
  });

  it("leaves the legacy key in place when the name does not resolve", async () => {
    const cfg = makeConfig({ [OLD_CHANNEL]: "deleted-channel" });

    await runNameToIdMigrations(
      makeClient(makeGuild(channels)),
      "guild-1",
      cfg.asConfig,
    );

    expect(cfg.service.set).not.toHaveBeenCalled();
    expect(cfg.service.delete).not.toHaveBeenCalled();
    expect(cfg.store.get(OLD_CHANNEL)).toBe("deleted-channel");
    expect(mockLogger.warn).toHaveBeenCalledWith(
      expect.stringContaining(`Leaving ${OLD_CHANNEL} in place`),
    );
  });

  it("deletes a stale legacy row when the new key is already populated", async () => {
    const cfg = makeConfig({
      [NEW_CHANNEL]: "c-existing",
      [OLD_CHANNEL]: "voice-stats",
    });

    await runNameToIdMigrations(
      makeClient(makeGuild(channels)),
      "guild-1",
      cfg.asConfig,
    );

    expect(cfg.service.set).not.toHaveBeenCalled();
    expect(cfg.service.delete).toHaveBeenCalledWith(OLD_CHANNEL);
    // The already-migrated value is never overwritten.
    expect(cfg.store.get(NEW_CHANNEL)).toBe("c-existing");
    expect(cfg.store.has(OLD_CHANNEL)).toBe(false);
  });

  it("is a no-op on repeat starts once everything is migrated", async () => {
    const cfg = makeConfig({
      [NEW_CHANNEL]: "c-text",
      [NEW_CATEGORY]: "c-cat",
    });

    await runNameToIdMigrations(
      makeClient(makeGuild(channels)),
      "guild-1",
      cfg.asConfig,
    );

    expect(cfg.service.set).not.toHaveBeenCalled();
    expect(cfg.service.delete).not.toHaveBeenCalled();
  });

  it("is a no-op when neither the old nor the new key is set", async () => {
    const cfg = makeConfig({});

    await runNameToIdMigrations(
      makeClient(makeGuild(channels)),
      "guild-1",
      cfg.asConfig,
    );

    expect(cfg.service.set).not.toHaveBeenCalled();
    expect(cfg.service.delete).not.toHaveBeenCalled();
  });

  it("swallows a per-rename failure and still processes the remaining renames", async () => {
    const cfg = makeConfig({
      [OLD_CHANNEL]: "voice-stats",
      [OLD_CATEGORY]: "Dynamic Voice",
    });
    cfg.service.set.mockImplementationOnce(async () => {
      throw new Error("db down");
    });

    await expect(
      runNameToIdMigrations(
        makeClient(makeGuild(channels)),
        "guild-1",
        cfg.asConfig,
      ),
    ).resolves.toBeUndefined();

    expect(mockLogger.error).toHaveBeenCalledWith(
      expect.stringContaining(`failed for ${OLD_CHANNEL} → ${NEW_CHANNEL}`),
      expect.any(Error),
    );
    // The failed rename keeps its legacy key; the next one still migrates.
    expect(cfg.store.get(OLD_CHANNEL)).toBe("voice-stats");
    expect(cfg.store.has(NEW_CHANNEL)).toBe(false);
    expect(cfg.store.get(NEW_CATEGORY)).toBe("c-cat");
    expect(cfg.store.has(OLD_CATEGORY)).toBe(false);
  });
});
