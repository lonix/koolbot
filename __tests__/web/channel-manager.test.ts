import { describe, it, expect } from "@jest/globals";
import {
  buildChannelTree,
  buildProtectionMap,
  canMove,
  compareIds,
  neighbourOf,
  checkCapacity,
  cleanName,
  deleteVerdict,
  resolveParent,
  validateBitrateKbps,
  validateName,
  validateTopic,
  validateUserLimit,
  type ManagedChannelView,
  type ProtectionInputs,
} from "../../src/web/channel-manager.js";

const ch = (
  id: string,
  over: Partial<ManagedChannelView> = {},
): ManagedChannelView => ({
  id,
  name: `chan-${id}`,
  kind: "text",
  typeLabel: "text",
  parentId: null,
  position: 0,
  topic: null,
  userLimit: null,
  bitrate: null,
  ...over,
});
const CAT = "100000000000000001";
const A = "100000000000000002";
const B = "100000000000000003";
const V = "100000000000000004";

describe("validateName / cleanName", () => {
  it("strips control characters and collapses whitespace", () => {
    expect(cleanName("  a\u0000b \n\n c​ ")).toBe("a b c");
  });
  it("keeps zero-width joiners so compound emoji survive", () => {
    const family = "👨‍👩‍👧‍👦 family";
    expect(cleanName(family)).toBe(family);
    expect(validateName(family)).toEqual({ ok: true, value: family });
    expect(cleanName("a‎b‏c")).toBe("a b c");
  });
  it("rejects empty and over-long names", () => {
    expect(validateName("   ").ok).toBe(false);
    const long = validateName("x".repeat(101));
    expect(long).toMatchObject({ ok: false });
    expect(validateName("x".repeat(100))).toEqual({
      ok: true,
      value: "x".repeat(100),
    });
  });
});

describe("validateTopic", () => {
  it("allows empty, keeps line breaks, and caps at 1024", () => {
    expect(validateTopic("")).toEqual({ ok: true, value: "" });
    expect(validateTopic("a\r\nb\u0007")).toEqual({ ok: true, value: "a\nb" });
    expect(validateTopic("x".repeat(1024)).ok).toBe(true);
    expect(validateTopic("x".repeat(1025)).ok).toBe(false);
  });
});

describe("validateUserLimit", () => {
  it("treats empty as 0 and bounds the range", () => {
    expect(validateUserLimit("")).toEqual({ ok: true, value: 0 });
    expect(validateUserLimit("99")).toEqual({ ok: true, value: 99 });
    expect(validateUserLimit("100").ok).toBe(false);
    expect(validateUserLimit("-1").ok).toBe(false);
    expect(validateUserLimit("2.5").ok).toBe(false);
    expect(validateUserLimit("abc").ok).toBe(false);
  });
});

describe("validateBitrateKbps", () => {
  it("converts kbps to bps and enforces 8 kbps up to the server maximum", () => {
    expect(validateBitrateKbps("", 96000)).toEqual({
      ok: true,
      value: undefined,
    });
    expect(validateBitrateKbps("64", 96000)).toEqual({
      ok: true,
      value: 64000,
    });
    expect(validateBitrateKbps("8", 96000).ok).toBe(true);
    expect(validateBitrateKbps("7", 96000).ok).toBe(false);
    expect(validateBitrateKbps("97", 96000).ok).toBe(false);
    expect(validateBitrateKbps("128", 128000).ok).toBe(true);
    expect(validateBitrateKbps("64000", 96000).ok).toBe(false);
    expect(validateBitrateKbps("x", 96000).ok).toBe(false);
  });
});

describe("checkCapacity", () => {
  const many = (n: number, parentId: string | null): ManagedChannelView[] =>
    Array.from({ length: n }, (_, i) =>
      ch(`2${String(i).padStart(17, "0")}`, { parentId }),
    );

  it("refuses a create at 500 channels", () => {
    expect(
      checkCapacity(many(500, null), { parentId: null, creating: true }).ok,
    ).toBe(false);
    expect(
      checkCapacity(many(499, null), { parentId: null, creating: true }).ok,
    ).toBe(true);
  });
  it("refuses the 51st channel in a category, but not a no-op move", () => {
    const full = many(50, CAT);
    expect(checkCapacity(full, { parentId: CAT, creating: true }).ok).toBe(
      false,
    );
    expect(
      checkCapacity(full, { parentId: CAT, creating: false, movingFrom: null })
        .ok,
    ).toBe(false);
    expect(
      checkCapacity(full, { parentId: CAT, creating: false, movingFrom: CAT })
        .ok,
    ).toBe(true);
  });
  it("does not count moves against the server total", () => {
    expect(
      checkCapacity(many(500, null), { parentId: null, creating: false }).ok,
    ).toBe(true);
  });
});

describe("resolveParent", () => {
  const list = [ch(CAT, { kind: "category" }), ch(A)];
  it("accepts empty, an existing category, and rejects everything else", () => {
    expect(resolveParent(list, "")).toEqual({ ok: true, value: null });
    expect(resolveParent(list, CAT)).toEqual({ ok: true, value: CAT });
    expect(resolveParent(list, A).ok).toBe(false); // not a category
    expect(resolveParent(list, "999999999999999999").ok).toBe(false);
    expect(resolveParent(list, "../etc").ok).toBe(false);
  });
});

describe("tree and reordering", () => {
  const list = [
    ch(CAT, { kind: "category", position: 1 }),
    ch("100000000000000009", { kind: "category", position: 0 }),
    ch(V, { kind: "voice", parentId: CAT, position: 0 }),
    ch(B, { parentId: CAT, position: 2 }),
    ch(A, { parentId: CAT, position: 1 }),
    ch("100000000000000010"),
  ];
  it("orders categories, lists text before voice, and finds uncategorized", () => {
    const tree = buildChannelTree(list);
    expect(tree.categories.map((n) => n.category.id)).toEqual([
      "100000000000000009",
      CAT,
    ]);
    expect(tree.categories[1].children.map((c) => c.id)).toEqual([A, B, V]);
    expect(tree.uncategorized.map((c) => c.id)).toEqual(["100000000000000010"]);
    expect(tree.total).toBe(6);
  });
  it("only moves within the same group and stops at the edges", () => {
    const get = (id: string): ManagedChannelView =>
      list.find((c) => c.id === id)!;
    expect(canMove(list, get(A), "up")).toBe(false);
    expect(canMove(list, get(A), "down")).toBe(true);
    expect(canMove(list, get(B), "down")).toBe(false);
    // the voice channel is alone in its group
    expect(canMove(list, get(V), "up")).toBe(false);
    expect(canMove(list, get(V), "down")).toBe(false);
    expect(canMove(list, get(CAT), "up")).toBe(true);
    expect(canMove(list, get("100000000000000009"), "up")).toBe(false);
  });

  it("orders and moves stage channels with the voice channels", () => {
    const S = "100000000000000030";
    const V2 = "100000000000000031";
    const withStage = [
      ch(CAT, { kind: "category" }),
      ch(A, { parentId: CAT, position: 0 }),
      ch(V, { kind: "voice", parentId: CAT, position: 1 }),
      ch(S, {
        kind: "other",
        typeLabel: "GuildStageVoice",
        parentId: CAT,
        position: 2,
      }),
      ch(V2, { kind: "voice", parentId: CAT, position: 3 }),
      ch("100000000000000032", {
        kind: "other",
        typeLabel: "GuildForum",
        parentId: CAT,
        position: 4,
      }),
    ];
    const tree = buildChannelTree(withStage);
    // Forum (unsupported) stays in the text-like group, ahead of voice and stage.
    expect(tree.categories[0].children.map((c) => c.id)).toEqual([
      A,
      "100000000000000032",
      V,
      S,
      V2,
    ]);
    const get = (id: string): ManagedChannelView =>
      withStage.find((c) => c.id === id)!;
    // V2 sits after the stage channel, so it can move up past it...
    expect(canMove(withStage, get(V2), "up")).toBe(true);
    // ...and V can move down past it (a stage is a voice sibling).
    expect(canMove(withStage, get(V), "down")).toBe(true);
    expect(canMove(withStage, get(V2), "down")).toBe(false);
    // The text channel only has the other text-like channel to move past.
    expect(canMove(withStage, get(A), "down")).toBe(true);
    expect(canMove(withStage, get(V), "up")).toBe(false);
  });
});

const baseInputs = (
  over: Partial<ProtectionInputs> = {},
): ProtectionInputs => ({
  config: {},
  managedVoice: [],
  ownedVoiceIds: [],
  tickets: [],
  events: [],
  lfg: [],
  reactionRoles: [],
  pollSchedules: [],
  announcements: [],
  lobbyNames: [],
  isTriggerName: (n: string) => n === "➕ New Channel",
  voiceInMemory: [],
  discord: [],
  channels: [],
  ...over,
});

describe("buildProtectionMap: voice service memory and legacy trigger", () => {
  it("protects channels the voice service holds in memory, with its reason", () => {
    const map = buildProtectionMap(
      baseInputs({
        voiceInMemory: [
          { channelId: A, reason: "a waiting room (Voice Channels)" },
          { channelId: B, reason: "a voice channel KoolBot just created" },
        ],
      }),
    );
    expect(map.get(A)).toEqual(["a waiting room (Voice Channels)"]);
    expect(map.get(B)![0]).toContain("just created");
  });

  it("protects an untracked legacy trigger anywhere, with no id, row or category setting", () => {
    const channels = [
      ch(V, {
        kind: "voice",
        name: "➕ New Channel",
        parentId: "100000000000000099",
      }),
      ch(A, { kind: "voice", name: "➕ New Channel", parentId: null }),
      ch(B, { kind: "text", name: "➕ New Channel" }),
      ch("100000000000000050", { kind: "voice", name: "Squad" }),
    ];
    const map = buildProtectionMap(
      baseInputs({ channels, config: { "voicechannels.category_id": CAT } }),
    );
    expect(map.get(V)![0]).toContain("New Channel");
    expect(map.has(A)).toBe(true);
    expect(map.has(B)).toBe(false); // a text channel is not a trigger
    expect(map.has("100000000000000050")).toBe(false);
  });
});

describe("buildProtectionMap: Mongo-backed feature bindings", () => {
  it("protects reaction-role channels and categories, naming the feature", () => {
    const map = buildProtectionMap(
      baseInputs({
        reactionRoles: [
          { id: "rr1", channelId: A, categoryId: CAT },
          { id: "rr2", channelId: null, categoryId: null },
        ],
      }),
    );
    expect(map.get(A)![0]).toContain("Reaction Roles");
    expect(map.get(A)![0]).toContain("rr1");
    expect(map.get(CAT)![0]).toContain("Reaction Roles");
    expect(map.size).toBe(2);
  });

  it("protects the channel a reaction-role picker was posted in, even after the setting moved", () => {
    // The configured channel (B) is protected through config; the picker's own
    // channel (A) is not configured any more but still holds a live picker.
    const map = buildProtectionMap(
      baseInputs({
        config: { "reactionroles.message_channel_id": B },
        reactionRoles: [
          { id: "rr1", channelId: null, categoryId: null, messageChannelId: A },
          { id: "rr2", channelId: null, categoryId: null },
        ],
      }),
    );
    expect(map.get(A)![0]).toContain("picker channel");
    expect(map.get(A)![0]).toContain("rr1");
    expect(map.has(B)).toBe(true);
  });

  it("protects poll schedule destinations, naming the feature", () => {
    const map = buildProtectionMap(
      baseInputs({ pollSchedules: [{ id: "ps1", channelId: B }] }),
    );
    expect(map.get(B)![0]).toContain("Polls");
    expect(map.get(B)![0]).toContain("ps1");
  });

  it("protects scheduled announcement channels, naming the feature", () => {
    const map = buildProtectionMap(
      baseInputs({ announcements: [{ id: "an1", channelId: V }] }),
    );
    expect(map.get(V)![0]).toContain("Announcements");
  });

  it("turns each into a refusal that names the feature", () => {
    const target = ch(A, { name: "picker" });
    const map = buildProtectionMap(
      baseInputs({
        reactionRoles: [{ id: "rr1", channelId: A, categoryId: null }],
      }),
    );
    const verdict = deleteVerdict(target, [target], map);
    expect(!verdict.ok && verdict.message).toContain("Reaction Roles");
  });
});

describe("buildProtectionMap", () => {
  it("names every *_channel_id and *_category_id setting that points at a channel", () => {
    const map = buildProtectionMap(
      baseInputs({
        config: {
          "quotes.channel_id": A,
          "tickets.category_id": CAT,
          "voicetracking.excluded_channels": B, // an exclusion list, not a binding
          "rules.role_id": V, // a role, not a channel
          "core.errors.channel_id": "",
          "notices.enabled": true,
        },
      }),
    );
    expect(map.get(A)).toEqual(["the quotes.channel_id setting"]);
    expect(map.get(CAT)).toEqual(["the tickets.category_id setting"]);
    expect(map.has(B)).toBe(false);
    expect(map.has(V)).toBe(false);
  });

  it("covers temporary voice channels, tickets, events, LFG and Discord's own channels", () => {
    const map = buildProtectionMap(
      baseInputs({
        managedVoice: [
          { channelId: A, kind: "channel" },
          { channelId: B, kind: "lobby" },
          { channelId: V, kind: "waiting_room" },
        ],
        ownedVoiceIds: ["100000000000000020"],
        tickets: [{ id: "t1", channelId: "100000000000000021" }],
        events: [
          {
            id: "e1",
            channelId: "100000000000000022",
            categoryId: "100000000000000023",
            announcementChannelId: "100000000000000024",
          },
        ],
        lfg: [
          {
            voiceChannelId: "100000000000000025",
            channelId: "100000000000000026",
          },
        ],
        discord: [
          {
            label: "the server's rules channel (Discord)",
            channelId: "100000000000000027",
          },
        ],
      }),
    );
    expect(map.get(A)![0]).toContain("temporary voice channel");
    expect(map.get(B)![0]).toContain("voice lobby");
    expect(map.get(V)![0]).toContain("waiting room");
    expect(map.get("100000000000000020")).toBeDefined();
    expect(map.get("100000000000000021")![0]).toContain("ticket t1");
    for (const id of [
      "100000000000000022",
      "100000000000000023",
      "100000000000000024",
      "100000000000000025",
      "100000000000000026",
    ]) {
      expect(map.has(id)).toBe(true);
    }
    expect(map.get("100000000000000027")![0]).toContain("rules channel");
  });

  it("finds the lobby by name inside the voice category when no id resolves", () => {
    const channels = [
      ch(V, { kind: "voice", name: "lobby", parentId: CAT }),
      ch(A, { kind: "voice", name: "Offline Lobby", parentId: CAT }),
      ch(B, { kind: "voice", name: "Lobby", parentId: "100000000000000099" }),
    ];
    const map = buildProtectionMap(
      baseInputs({
        channels,
        lobbyNames: ["Lobby", "Offline Lobby"],
        config: { "voicechannels.category_id": CAT },
      }),
    );
    expect(map.has(V)).toBe(true);
    expect(map.has(A)).toBe(true);
    expect(map.has(B)).toBe(false); // same name, but outside the voice category
  });

  const lobbyConfig = { "voicechannels.category_id": CAT };
  const lobbyNames = ["Lobby", "Offline Lobby"];

  it("keeps the real lobby protected when a stale lobby id points at a text channel", () => {
    // VoiceChannelManager ignores an id that isn't a voice channel and finds
    // the lobby by name instead, so the name lookup must not be suppressed.
    const channels = [
      ch(V, { kind: "voice", name: "Lobby", parentId: CAT }),
      ch(A, { kind: "text", name: "old-lobby", parentId: CAT }),
    ];
    const map = buildProtectionMap(
      baseInputs({
        channels,
        lobbyNames,
        config: { ...lobbyConfig, "voicechannels.lobby.channel_id": A },
      }),
    );
    expect(map.has(V)).toBe(true);
    expect(map.get(A)).toEqual(["the voicechannels.lobby.channel_id setting"]);
  });

  it("keeps the real lobby protected when a stale lobby id points at a voice channel outside the category", () => {
    const OUT = "100000000000000099";
    const channels = [
      ch(V, { kind: "voice", name: "Lobby", parentId: CAT }),
      ch(A, { kind: "voice", name: "elsewhere", parentId: OUT }),
    ];
    const map = buildProtectionMap(
      baseInputs({
        channels,
        lobbyNames,
        config: { ...lobbyConfig, "voicechannels.lobby.channel_id": A },
      }),
    );
    expect(map.has(V)).toBe(true);
    expect(map.has(A)).toBe(true);
  });

  it("protects the lobby and offline lobby by name when the id is empty or missing", () => {
    const channels = [
      ch(V, { kind: "voice", name: "Lobby", parentId: CAT }),
      ch(A, { kind: "voice", name: "offline lobby ", parentId: CAT }),
      ch(B, { kind: "voice", name: "Squad", parentId: CAT }),
    ];
    for (const id of [undefined, "", "199999999999999999"]) {
      const map = buildProtectionMap(
        baseInputs({
          channels,
          lobbyNames,
          config: { ...lobbyConfig, "voicechannels.lobby.channel_id": id },
        }),
      );
      expect(map.has(V)).toBe(true);
      expect(map.has(A)).toBe(true);
      expect(map.has(B)).toBe(false);
    }
  });

  it("still protects the offline lobby when the lobby id is valid", () => {
    const channels = [
      ch(V, { kind: "voice", name: "Lobby", parentId: CAT }),
      ch(A, { kind: "voice", name: "Offline Lobby", parentId: CAT }),
    ];
    const map = buildProtectionMap(
      baseInputs({
        channels,
        lobbyNames,
        config: { ...lobbyConfig, "voicechannels.lobby.channel_id": V },
      }),
    );
    expect(map.get(V)).toContain("the voicechannels.lobby.channel_id setting");
    expect(map.has(A)).toBe(true);
  });
});

describe("neighbourOf", () => {
  it("names the sibling a step swaps with, and null at the edges", () => {
    const list = [
      ch(CAT, { kind: "category" }),
      ch(A, { parentId: CAT, position: 0 }),
      ch(B, { parentId: CAT, position: 1 }),
    ];
    const get = (id: string): ManagedChannelView =>
      list.find((c) => c.id === id)!;
    expect(neighbourOf(list, get(A), "down")?.id).toBe(B);
    expect(neighbourOf(list, get(B), "up")?.id).toBe(A);
    expect(neighbourOf(list, get(A), "up")).toBeNull();
    expect(neighbourOf(list, get(B), "down")).toBeNull();
  });
});

describe("deleteVerdict", () => {
  it("refuses a managed channel and names the setting", () => {
    const target = ch(A, { name: "quotes" });
    const verdict = deleteVerdict(
      target,
      [target],
      new Map([[A, ["the quotes.channel_id setting"]]]),
    );
    expect(verdict).toMatchObject({ ok: false });
    expect(!verdict.ok && verdict.message).toContain("quotes.channel_id");
  });
  it("allows an unmanaged channel and an empty category", () => {
    const text = ch(A);
    const cat = ch(CAT, { kind: "category" });
    expect(deleteVerdict(text, [text, cat], new Map())).toEqual({ ok: true });
    expect(deleteVerdict(cat, [text, cat], new Map())).toEqual({ ok: true });
  });
  it("refuses a populated category and says which children KoolBot manages", () => {
    const cat = ch(CAT, { kind: "category", name: "Voice" });
    const kid = ch(A, { parentId: CAT, name: "lobby" });
    const plain = ch(B, { parentId: CAT, name: "plain" });
    const verdict = deleteVerdict(
      cat,
      [cat, kid, plain],
      new Map([[A, ["the voice lobby"]]]),
    );
    expect(!verdict.ok && verdict.message).toContain("2 channels");
    expect(!verdict.ok && verdict.message).toContain("lobby");
    const single = deleteVerdict(cat, [cat, plain], new Map());
    expect(!single.ok && single.message).toContain("1 channel.");
  });
});

describe("compareIds", () => {
  it("orders snowflakes numerically, so a longer id sorts after a shorter one", () => {
    expect(
      compareIds("900000000000000000", "1000000000000000000"),
    ).toBeLessThan(0);
    expect(
      compareIds("1000000000000000000", "900000000000000000"),
    ).toBeGreaterThan(0);
    expect(compareIds("123", "123")).toBe(0);
    expect(compareIds("124", "123")).toBeGreaterThan(0);
  });

  it("breaks position ties by numeric id in the tree and the sibling order", () => {
    const small = "900000000000000000";
    const mid = "950000000000000000";
    const big = "1000000000000000000";
    const list = [
      ch(CAT, { kind: "category" }),
      ch(big, { parentId: CAT, position: 0 }),
      ch(small, { parentId: CAT, position: 0 }),
      ch(mid, { parentId: CAT, position: 0 }),
    ];
    expect(
      buildChannelTree(list).categories[0].children.map((c) => c.id),
    ).toEqual([small, mid, big]);
    expect(neighbourOf(list, list[2], "down")?.id).toBe(mid);
    expect(neighbourOf(list, list[1], "up")?.id).toBe(mid);
  });
});
