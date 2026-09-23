/**
 * `execute()` tests for `/lfg` and its Join / Leave / Close buttons (#957).
 *
 * Both surfaces are member-facing and unauthenticated in Discord terms —
 * anyone in the guild can post and anyone can click — so the branches that
 * matter here are the refusals: the feature gate, the per-member post cap,
 * a channel the bot cannot post in, and a button pressed by someone who is
 * not the host.
 */

import { describe, it, expect, jest, beforeEach } from "@jest/globals";
import {
  createMockChatInputInteraction,
  createMockButtonInteraction,
  type MockChatInputInteraction,
  type MockCommandOptions,
} from "../test-utils.js";

const mockConfigGetBoolean = jest.fn<() => Promise<boolean>>();
const mockConfigGetNumber = jest.fn<() => Promise<number>>();
const mockCreatePost = jest.fn<() => Promise<Record<string, unknown>>>();
const mockJoinPost = jest.fn<() => Promise<Record<string, unknown>>>();
const mockLeavePost = jest.fn<() => Promise<Record<string, unknown>>>();
const mockCloseByHost = jest.fn<() => Promise<Record<string, unknown>>>();
const mockBuildPayload = jest.fn(() => ({ content: "refreshed" }));

jest.unstable_mockModule("../../src/services/config-service.js", () => ({
  ConfigService: {
    getInstance: (): unknown => ({
      getBoolean: mockConfigGetBoolean,
      getString: jest.fn(async () => ""),
      getNumber: mockConfigGetNumber,
      registerReloadCallback: jest.fn(),
    }),
  },
}));

jest.unstable_mockModule("../../src/utils/logger.js", () => ({
  default: {
    info: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
    debug: jest.fn(),
  },
}));

// The real `lfg-service` module is imported below for its pure helpers, so
// its heavier dependencies are stubbed the same way the service's own test
// stubs them.
jest.unstable_mockModule("../../src/services/voice-channel-manager.js", () => ({
  VoiceChannelManager: { getInstance: jest.fn() },
}));

jest.unstable_mockModule("../../src/models/lfg-post.js", () => ({
  LfgPost: jest.fn(),
}));

// Keep the real pure helpers (`resolvePartySize`, `spotsLeft`) and swap only
// the service singleton.
const actualLfgService = await import("../../src/services/lfg-service.js");
jest.unstable_mockModule("../../src/services/lfg-service.js", () => ({
  ...actualLfgService,
  LfgService: {
    getInstance: (): unknown => ({
      createPost: mockCreatePost,
      joinPost: mockJoinPost,
      leavePost: mockLeavePost,
      closeByHost: mockCloseByHost,
      buildPayload: mockBuildPayload,
    }),
  },
}));

const { execute } = await import("../../src/commands/lfg.js");
const { handleLfgButton } =
  await import("../../src/handlers/lfg-button-handler.js");

const POST_ID = "0123456789abcdef01234567";

function post(
  overrides: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    _id: POST_ID,
    guildId: "guild-1",
    hostId: "user-1",
    game: "Valorant",
    partySize: 4,
    memberIds: ["user-1"],
    channelId: "channel-1",
    messageId: "msg-1",
    voiceChannelId: null,
    ...overrides,
  };
}

function interaction(
  options: MockCommandOptions = {},
  overrides: Record<string, unknown> = {},
): MockChatInputInteraction {
  return createMockChatInputInteraction(options, overrides);
}

beforeEach(() => {
  jest.clearAllMocks();
  mockConfigGetBoolean.mockResolvedValue(true);
  mockConfigGetNumber.mockResolvedValue(4);
  mockCreatePost.mockResolvedValue({ status: "created", post: post() });
});

describe("/lfg", () => {
  it("acknowledges before doing any work so it can't miss the ACK window", async () => {
    const it_ = interaction({ strings: { game: "Valorant" } });
    await execute(it_);
    expect(it_.deferReply).toHaveBeenCalled();
  });

  it("declines while lfg.enabled is false", async () => {
    mockConfigGetBoolean.mockResolvedValue(false);
    const it_ = interaction({ strings: { game: "Valorant" } });
    await execute(it_);
    expect(it_.editReply).toHaveBeenCalledWith(
      "The LFG feature is currently disabled.",
    );
    expect(mockCreatePost).not.toHaveBeenCalled();
  });

  it("declines outside a guild", async () => {
    const it_ = interaction(
      { strings: { game: "Valorant" } },
      { guildId: null },
    );
    await execute(it_);
    expect(it_.editReply).toHaveBeenCalledWith(
      "This command must be run inside a guild.",
    );
  });

  it("passes the requested party size straight through", async () => {
    const it_ = interaction({
      strings: { game: "Valorant", note: " ranked only " },
      integers: { size: 5 },
    });
    await execute(it_);
    expect(mockCreatePost).toHaveBeenCalledWith({
      guildId: "guild-1",
      hostId: "user-1",
      game: "Valorant",
      note: "ranked only",
      partySize: 5,
      fallbackChannelId: "channel-1",
    });
  });

  it("falls back to the configured default size", async () => {
    mockConfigGetNumber.mockResolvedValue(6);
    const it_ = interaction({ strings: { game: "Valorant" } });
    await execute(it_);
    expect(
      (mockCreatePost.mock.calls[0][0] as { partySize: number }).partySize,
    ).toBe(6);
  });

  it("clamps a size the schema would otherwise let through", async () => {
    const it_ = interaction({
      strings: { game: "Valorant" },
      integers: { size: 99 },
    });
    await execute(it_);
    expect(
      (mockCreatePost.mock.calls[0][0] as { partySize: number }).partySize,
    ).toBe(25);
  });

  it("links the post it just made", async () => {
    const it_ = interaction({ strings: { game: "Valorant" } });
    await execute(it_);
    const reply = it_.editReply.mock.calls[0][0] as string;
    expect(reply).toContain("Valorant");
    expect(reply).toContain(
      `https://discord.com/channels/guild-1/channel-1/msg-1`,
    );
  });

  it("explains the one-post cap instead of silently doing nothing", async () => {
    mockCreatePost.mockResolvedValue({ status: "at_limit", limit: 1 });
    const it_ = interaction({ strings: { game: "Valorant" } });
    await execute(it_);
    expect(it_.editReply.mock.calls[0][0]).toContain("already have an open");
  });

  it("explains a missing channel", async () => {
    mockCreatePost.mockResolvedValue({ status: "no_channel" });
    const it_ = interaction({ strings: { game: "Valorant" } });
    await execute(it_);
    expect(it_.editReply.mock.calls[0][0]).toContain("channel to post in");
  });

  it("explains a send that failed", async () => {
    mockCreatePost.mockResolvedValue({ status: "post_failed" });
    const it_ = interaction({ strings: { game: "Valorant" } });
    await execute(it_);
    expect(it_.editReply.mock.calls[0][0]).toContain("send messages");
  });
});

describe("LFG buttons", () => {
  it("refreshes the post and confirms the join privately", async () => {
    const joined = post({ memberIds: ["user-1", "user-2"] });
    mockJoinPost.mockResolvedValue({
      status: "joined",
      post: joined,
      filled: false,
    });
    const btn = createMockButtonInteraction(`lfg_join_${POST_ID}`);

    await handleLfgButton(btn);

    expect(mockJoinPost).toHaveBeenCalledWith(POST_ID, "user-1");
    expect(btn.update).toHaveBeenCalledWith({ content: "refreshed" });
    expect(
      (btn.followUp.mock.calls[0][0] as { content: string }).content,
    ).toContain("2 spot(s) left");
  });

  it("points a joiner at the voice channel when there is one", async () => {
    mockJoinPost.mockResolvedValue({
      status: "joined",
      post: post({
        memberIds: ["user-1", "user-2"],
        voiceChannelId: "voice-1",
      }),
      filled: true,
    });
    const btn = createMockButtonInteraction(`lfg_join_${POST_ID}`);

    await handleLfgButton(btn);

    const followUp = btn.followUp.mock.calls[0][0] as { content: string };
    expect(followUp.content).toContain("fills the party");
    expect(followUp.content).toContain("<#voice-1>");
  });

  it.each([
    ["closed", "no longer open"],
    ["already_joined", "already on this roster"],
    ["full", "already full"],
  ])("answers a %s join without touching the post", async (status, text) => {
    mockJoinPost.mockResolvedValue({ status, post: post() });
    const btn = createMockButtonInteraction(`lfg_join_${POST_ID}`);

    await handleLfgButton(btn);

    expect(btn.update).not.toHaveBeenCalled();
    expect(
      (btn.reply.mock.calls[0][0] as { content: string }).content,
    ).toContain(text);
  });

  it("sends the host to Close rather than letting them leave", async () => {
    mockLeavePost.mockResolvedValue({ status: "host", post: post() });
    const btn = createMockButtonInteraction(`lfg_leave_${POST_ID}`);

    await handleLfgButton(btn);

    expect(btn.update).not.toHaveBeenCalled();
    expect(
      (btn.reply.mock.calls[0][0] as { content: string }).content,
    ).toContain("Close");
  });

  it("refreshes the post when someone leaves", async () => {
    mockLeavePost.mockResolvedValue({ status: "left", post: post() });
    const btn = createMockButtonInteraction(`lfg_leave_${POST_ID}`);

    await handleLfgButton(btn);

    expect(btn.update).toHaveBeenCalledWith({ content: "refreshed" });
  });

  it("closes the post for its host", async () => {
    mockCloseByHost.mockResolvedValue({
      status: "closed",
      post: post({ state: "closed" }),
    });
    const btn = createMockButtonInteraction(`lfg_close_${POST_ID}`);

    await handleLfgButton(btn);

    expect(mockCloseByHost).toHaveBeenCalledWith(POST_ID, "user-1");
    expect(btn.update).toHaveBeenCalledWith({ content: "refreshed" });
  });

  it("refuses a Close from anyone but the host", async () => {
    mockCloseByHost.mockResolvedValue({ status: "not_host" });
    const btn = createMockButtonInteraction(`lfg_close_${POST_ID}`);

    await handleLfgButton(btn);

    expect(btn.update).not.toHaveBeenCalled();
    expect(
      (btn.reply.mock.calls[0][0] as { content: string }).content,
    ).toContain("Only the host");
  });

  it("rejects a malformed customId without calling the service", async () => {
    const btn = createMockButtonInteraction("lfg_bogus_1_2");

    await handleLfgButton(btn);

    expect(mockJoinPost).not.toHaveBeenCalled();
    expect(mockLeavePost).not.toHaveBeenCalled();
    expect(mockCloseByHost).not.toHaveBeenCalled();
    expect(
      (btn.reply.mock.calls[0][0] as { content: string }).content,
    ).toContain("Invalid LFG button");
  });

  it("always answers the click, even when the service throws", async () => {
    mockJoinPost.mockRejectedValue(new Error("mongo is down"));
    const btn = createMockButtonInteraction(`lfg_join_${POST_ID}`);

    await handleLfgButton(btn);

    expect(
      (btn.reply.mock.calls[0][0] as { content: string }).content,
    ).toContain("error updating this LFG post");
  });
});
