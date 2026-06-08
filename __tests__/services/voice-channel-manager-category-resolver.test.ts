import {
  describe,
  it,
  expect,
  beforeEach,
  afterEach,
  jest,
} from "@jest/globals";
import { ChannelType } from "discord.js";
import { resolveManagedCategory } from "../../src/services/voice-channel-manager.js";
import { ConfigService } from "../../src/services/config-service.js";

/**
 * Coverage for the #447 helper. The helper replaces ~10 call sites that
 * previously looked up the managed VC category by `name`. The contract
 * is now strictly ID-based, with a `null` return when the key is unset
 * or the stored ID doesn't resolve to a category channel in the guild
 * cache.
 */
describe("resolveManagedCategory", () => {
  let getStringSpy: jest.SpiedFunction<typeof ConfigService.prototype.getString>;

  beforeEach(() => {
    getStringSpy = jest.spyOn(ConfigService.prototype, "getString");
  });

  afterEach(() => {
    getStringSpy.mockRestore();
  });

  function mockGuild(channels: Record<string, { type: ChannelType; name: string }>) {
    return {
      channels: {
        cache: {
          get: (id: string) => {
            const ch = channels[id];
            if (!ch) return undefined;
            return { id, ...ch };
          },
        },
      },
    } as any;
  }

  it("returns null when voicechannels.category_id is unset", async () => {
    getStringSpy.mockResolvedValue("");
    const guild = mockGuild({});
    expect(await resolveManagedCategory(guild)).toBeNull();
  });

  it("returns null when the configured ID doesn't resolve to anything", async () => {
    // Operator's category was deleted from Discord, or the bot cache is
    // stale. Caller is expected to log and bail.
    getStringSpy.mockResolvedValue("gone-cat-id");
    const guild = mockGuild({});
    expect(await resolveManagedCategory(guild)).toBeNull();
  });

  it("returns null when the configured ID resolves to a non-category channel", async () => {
    // Defensive against operator pasting a text-channel ID into the
    // category field via raw YAML import or /config set bypass.
    getStringSpy.mockResolvedValue("text-id");
    const guild = mockGuild({
      "text-id": { type: ChannelType.GuildText, name: "general" },
    });
    expect(await resolveManagedCategory(guild)).toBeNull();
  });

  it("returns the CategoryChannel when the configured ID resolves", async () => {
    getStringSpy.mockResolvedValue("cat-id");
    const guild = mockGuild({
      "cat-id": { type: ChannelType.GuildCategory, name: "Voice Channels" },
    });
    const result = await resolveManagedCategory(guild);
    expect(result).not.toBeNull();
    expect(result?.name).toBe("Voice Channels");
    expect(result?.id).toBe("cat-id");
  });
});
