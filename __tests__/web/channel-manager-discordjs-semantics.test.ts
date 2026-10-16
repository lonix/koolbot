/**
 * Pins the discord.js behaviour the Channel Manager's Up/Down relies on: a
 * relative `setPosition` reorders within the channel's own parent and its
 * text/voice group, not the guild-wide list. `siblingsOf()` in
 * `src/web/channel-manager.ts` must stay in step with it; if a discord.js
 * upgrade changes the bucket, this fails.
 */

import { describe, it, expect } from "@jest/globals";
import { ChannelType, Collection, Guild } from "discord.js";
import {
  siblingsOf,
  type ManagedChannelView,
} from "../../src/web/channel-manager.js";

type Fake = {
  id: string;
  type: ChannelType;
  parentId: string | null;
  rawPosition: number;
};

const fake = (
  id: string,
  type: ChannelType,
  parentId: string | null,
  rawPosition: number,
): Fake => ({ id, type, parentId, rawPosition });

const sortedBucket = (all: Fake[], target: Fake): string[] => {
  const guild = {
    channels: { cache: new Collection(all.map((c) => [c.id, c])) },
  };
  const sorted = (
    Guild.prototype as unknown as {
      _sortedChannels(this: unknown, c: Fake): Collection<string, Fake>;
    }
  )._sortedChannels.call(guild, target);
  return [...sorted.values()].map((c) => c.id);
};

const viewOf = (
  c: Fake,
  kind: ManagedChannelView["kind"],
): ManagedChannelView => ({
  id: c.id,
  name: c.id,
  kind,
  typeLabel: kind,
  parentId: c.parentId,
  position: c.rawPosition,
  topic: null,
  userLimit: null,
  bitrate: null,
});

describe("discord.js relative-move bucket vs siblingsOf", () => {
  const CAT1 = "100000000000000001";
  const CAT2 = "100000000000000002";
  const a = fake("100000000000000010", ChannelType.GuildText, CAT1, 0);
  const b = fake("100000000000000011", ChannelType.GuildText, CAT2, 1);
  const c = fake("100000000000000012", ChannelType.GuildText, CAT1, 2);
  const v = fake("100000000000000013", ChannelType.GuildVoice, CAT1, 3);
  const stage = fake(
    "100000000000000014",
    ChannelType.GuildStageVoice,
    CAT1,
    4,
  );
  const forum = fake("100000000000000015", ChannelType.GuildForum, CAT1, 5);
  const all = [a, b, c, v, stage, forum];

  it("keeps interleaved channels of two categories apart", () => {
    expect(sortedBucket(all, c)).toEqual([a.id, c.id, forum.id]);
  });

  it("matches siblingsOf for text, voice, stage and forum channels", () => {
    const views = [
      viewOf(a, "text"),
      viewOf(b, "text"),
      viewOf(c, "text"),
      viewOf(v, "voice"),
      { ...viewOf(stage, "other"), typeLabel: "GuildStageVoice" },
      { ...viewOf(forum, "other"), typeLabel: "GuildForum" },
    ];
    for (const [fakeChannel, view] of all.map(
      (f, i) => [f, views[i]] as const,
    )) {
      expect(siblingsOf(views, view).map((s) => s.id)).toEqual(
        sortedBucket(all, fakeChannel),
      );
    }
  });
});
