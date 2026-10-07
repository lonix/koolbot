import { describe, it, expect } from "@jest/globals";
import { ChannelType, PermissionsBitField } from "discord.js";
import {
  BOT_CATEGORY,
  GATED_CATEGORY_EVERYONE,
  GATED_CATEGORY_ROLE,
  NOTICES_BOT,
  NOTICES_EVERYONE,
  VOICE_ROOM_EVERYONE,
  VOICE_ROOM_OWNER,
  bitsOf,
  channelFamily,
  gateEveryone,
  gateMember,
  mergeOverwrite,
  readOnlyEveryone,
  readOnlyPoster,
  toBitfields,
  toOverwriteOptions,
} from "../../src/utils/channel-permissions.js";

const F = PermissionsBitField.Flags;

describe("channel-permissions: one declaration, two forms", () => {
  it("derives the discord.js options and the planner bitfields from the same names", () => {
    for (const set of [
      NOTICES_EVERYONE,
      NOTICES_BOT,
      GATED_CATEGORY_EVERYONE,
      GATED_CATEGORY_ROLE,
      BOT_CATEGORY,
      VOICE_ROOM_EVERYONE,
      VOICE_ROOM_OWNER,
      readOnlyEveryone("forum", { lockReplies: true }),
      gateEveryone("voice"),
    ]) {
      const options = toOverwriteOptions(set);
      const allow = Object.entries(options)
        .filter(([, v]) => v === true)
        .map(([k]) => k as keyof typeof F);
      const deny = Object.entries(options)
        .filter(([, v]) => v === false)
        .map(([k]) => k as keyof typeof F);
      expect(toBitfields(set)).toEqual({
        allow: bitsOf(allow),
        deny: bitsOf(deny),
      });
    }
  });

  it("keeps the notices channel call shape byte-identical to the old inline object", () => {
    expect(toOverwriteOptions(NOTICES_EVERYONE)).toEqual({
      SendMessages: false,
      SendMessagesInThreads: false,
      CreatePublicThreads: false,
      CreatePrivateThreads: false,
      AddReactions: true,
      ViewChannel: true,
      ReadMessageHistory: true,
    });
    expect(toOverwriteOptions(NOTICES_BOT)).toEqual({
      SendMessages: true,
      ManageMessages: true,
      ManageChannels: true,
      AddReactions: true,
      ViewChannel: true,
      ReadMessageHistory: true,
    });
  });

  it("keeps the reaction-role category shapes", () => {
    expect(toOverwriteOptions(GATED_CATEGORY_EVERYONE)).toEqual({
      ViewChannel: false,
    });
    expect(toOverwriteOptions(GATED_CATEGORY_ROLE)).toEqual({
      ViewChannel: true,
    });
    expect(toOverwriteOptions(BOT_CATEGORY)).toEqual({
      ViewChannel: true,
      ManageChannels: true,
      ManageRoles: true,
    });
  });

  it("keeps the voice room permission lists", () => {
    expect([...VOICE_ROOM_EVERYONE.allow]).toEqual([
      "Connect",
      "Speak",
      "ViewChannel",
    ]);
    expect([...VOICE_ROOM_OWNER.allow]).toEqual([
      "ManageChannels",
      "Connect",
      "Speak",
      "ViewChannel",
    ]);
  });
});

describe("channelFamily", () => {
  it("maps Discord types and falls back to the kind", () => {
    expect(channelFamily(ChannelType.GuildForum, "text")).toBe("forum");
    expect(channelFamily(ChannelType.GuildMedia, "text")).toBe("forum");
    expect(channelFamily(ChannelType.GuildAnnouncement, "text")).toBe(
      "announcement",
    );
    expect(channelFamily(ChannelType.GuildStageVoice, "voice")).toBe("stage");
    expect(channelFamily(ChannelType.GuildVoice, "voice")).toBe("voice");
    expect(channelFamily(ChannelType.GuildCategory, "category")).toBe(
      "category",
    );
    expect(channelFamily(undefined, "voice")).toBe("voice");
    expect(channelFamily(undefined, "other")).toBe("text");
  });
});

describe("read-only rules by channel type", () => {
  it("text and announcement: no posting, replies or threads; reactions denied unless allowed", () => {
    const set = readOnlyEveryone("text", { allowReactions: false });
    expect(set.deny).toEqual(
      expect.arrayContaining([
        "SendMessages",
        "SendMessagesInThreads",
        "CreatePublicThreads",
        "AddReactions",
      ]),
    );
    expect(
      readOnlyEveryone("announcement", { allowReactions: true }).deny,
    ).not.toContain("AddReactions");
  });

  it("never grants anything to @everyone (a gate must survive)", () => {
    for (const family of [
      "text",
      "forum",
      "stage",
      "voice",
      "category",
    ] as const) {
      expect(readOnlyEveryone(family).allow).toEqual([]);
    }
  });

  it("forum: no new posts, replies stay open unless locked", () => {
    expect(readOnlyEveryone("forum").deny).toContain("SendMessages");
    expect(readOnlyEveryone("forum").deny).not.toContain(
      "SendMessagesInThreads",
    );
    expect(readOnlyEveryone("forum", { lockReplies: true }).deny).toContain(
      "SendMessagesInThreads",
    );
  });

  it("stage and voice: speaking, not posting", () => {
    expect(readOnlyEveryone("stage").deny).toEqual(["RequestToSpeak"]);
    expect(readOnlyEveryone("voice").deny).toEqual(["Speak"]);
    expect(readOnlyPoster("stage").allow).toEqual(["RequestToSpeak"]);
  });
});

describe("gate rules by channel type", () => {
  it("voice and stage keep Connect consistent with ViewChannel", () => {
    expect(gateEveryone("voice").deny).toEqual(["ViewChannel", "Connect"]);
    expect(gateMember("stage").allow).toEqual(["ViewChannel", "Connect"]);
    expect(gateEveryone("text").deny).toEqual(["ViewChannel"]);
  });
});

describe("mergeOverwrite", () => {
  it("keeps unrelated bits, and lets the new set win on its own bits", () => {
    const existing = {
      allow: bitsOf(["AttachFiles", "SendMessages"]),
      deny: bitsOf(["EmbedLinks", "ViewChannel"]),
    };
    const merged = mergeOverwrite(existing, {
      allow: ["ViewChannel"],
      deny: ["SendMessages"],
    });
    expect(BigInt(merged.allow)).toBe(F.AttachFiles | F.ViewChannel);
    expect(BigInt(merged.deny)).toBe(F.EmbedLinks | F.SendMessages);
  });

  it("starts from nothing when there is no overwrite", () => {
    expect(mergeOverwrite(undefined, { allow: [], deny: [] })).toEqual({
      allow: "0",
      deny: "0",
    });
  });
});
