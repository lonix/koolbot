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
import { createKeyedLock } from "../../src/utils/keyed-lock.js";

const mockConfigGetBoolean = jest.fn<() => Promise<boolean>>();
const mockConfigGetNumber = jest.fn<() => Promise<number>>();
const mockCreatePost = jest.fn<() => Promise<Record<string, unknown>>>();
const mockJoinPost = jest.fn<() => Promise<Record<string, unknown>>>();
const mockLeavePost = jest.fn<() => Promise<Record<string, unknown>>>();
const mockCloseByHost = jest.fn<() => Promise<Record<string, unknown>>>();
const mockBuildPayload = jest.fn(() => ({ content: "refreshed" }));
/**
 * The per-post turn-taking lives in the service now, and the handler routes
 * through it. The mock uses the real lock so the ordering guarantee is still
 * exercised end to end here.
 */
const serviceLock = createKeyedLock();
const mockRecordRenderAttempt = jest.fn<() => Promise<void>>();
const mockMarkRenderPending = jest.fn<() => Promise<void>>();

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
  LFG_ROW_TTL_SECONDS: 60 * 60,
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
      recordRenderAttempt: mockRecordRenderAttempt,
      markRenderPending: mockMarkRenderPending,
      runOnPost: <T>(postId: string, work: () => Promise<T>): Promise<T> =>
        serviceLock.run(postId, work),
    }),
  },
}));

const { execute } = await import("../../src/commands/lfg.js");
const { handleLfgButton } =
  await import("../../src/handlers/lfg-button-handler.js");

const POST_ID = "0123456789abcdef01234567";

/**
 * A button interaction that acknowledges like the real thing: `deferUpdate`
 * flips `deferred`, so the handler's refusals land on `followUp` (ephemeral)
 * rather than `reply`, exactly as Discord would route them.
 */
function buttonInteraction(
  customId: string,
): ReturnType<typeof createMockButtonInteraction> {
  const btn = createMockButtonInteraction(customId, {
    editReply: jest.fn(async () => undefined),
  });
  (btn as unknown as { deferUpdate: unknown }).deferUpdate = jest.fn(
    async () => {
      (btn as unknown as { deferred: boolean }).deferred = true;
    },
  );
  return btn;
}

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
  mockRecordRenderAttempt.mockResolvedValue(undefined);
  mockMarkRenderPending.mockResolvedValue(undefined);
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
  // The click is acknowledged before the first database read, so a slow query
  // cannot blow Discord's three-second window and strand a recorded join
  // (#842). Everything after that edits via editReply / followUp.
  it("acknowledges the click before touching the database", async () => {
    mockJoinPost.mockImplementation(async () => {
      expect(btn.deferUpdate).toHaveBeenCalled();
      return { status: "joined", post: post(), filled: false };
    });
    const btn = buttonInteraction(`lfg_join_${POST_ID}`);

    await handleLfgButton(btn);

    expect(btn.deferUpdate).toHaveBeenCalledTimes(1);
  });

  it("refreshes the post and confirms the join privately", async () => {
    const joined = post({ memberIds: ["user-1", "user-2"] });
    mockJoinPost.mockResolvedValue({
      status: "joined",
      post: joined,
      filled: false,
    });
    const btn = buttonInteraction(`lfg_join_${POST_ID}`);

    await handleLfgButton(btn);

    expect(mockJoinPost).toHaveBeenCalledWith(POST_ID, "user-1");
    expect(btn.editReply).toHaveBeenCalledWith({ content: "refreshed" });
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
        state: "closed",
      }),
      filled: true,
    });
    const btn = buttonInteraction(`lfg_join_${POST_ID}`);

    await handleLfgButton(btn);

    const followUp = btn.followUp.mock.calls[0][0] as { content: string };
    expect(followUp.content).toContain("fills the party");
    expect(followUp.content).toContain("<#voice-1>");
  });

  // The handler renders by acknowledging its own interaction, so only it knows
  // how the edit went — otherwise the sweep would edit the same message again
  // a minute later, or purge a row whose message still read as open.
  it("clears the pending flag on a post it just closed", async () => {
    mockCloseByHost.mockResolvedValue({
      status: "closed",
      post: post({
        state: "closed",
        closeReason: "cancelled",
        renderPending: true,
      }),
    });
    const btn = buttonInteraction(`lfg_close_${POST_ID}`);

    await handleLfgButton(btn);

    expect(btn.editReply).toHaveBeenCalledWith({ content: "refreshed" });
    expect(mockRecordRenderAttempt).toHaveBeenCalledWith(POST_ID, true);
  });

  it("writes nothing extra for an ordinary click", async () => {
    mockJoinPost.mockResolvedValue({
      status: "joined",
      post: post({ memberIds: ["user-1", "user-2"] }),
      filled: false,
    });

    await handleLfgButton(buttonInteraction(`lfg_join_${POST_ID}`));

    // Nothing to settle, so a join costs one write, not two.
    expect(mockRecordRenderAttempt).not.toHaveBeenCalled();
    expect(mockMarkRenderPending).not.toHaveBeenCalled();
  });

  // The roster write is already committed by the time the edit runs, so a
  // failed edit has to leave the row flagged or the visible post disagrees
  // with it until someone else clicks.
  it("flags the post for the sweep when its own edit fails", async () => {
    mockJoinPost.mockResolvedValue({
      status: "joined",
      post: post({ memberIds: ["user-1", "user-2"] }),
      filled: false,
    });
    const btn = buttonInteraction(`lfg_join_${POST_ID}`);
    (btn.editReply as jest.Mock).mockImplementation(async () => {
      throw new Error("discord is having a moment");
    });

    await handleLfgButton(btn);

    expect(mockMarkRenderPending).toHaveBeenCalledWith(POST_ID);
    expect(
      (btn.followUp.mock.calls[0][0] as { content: string }).content,
    ).toContain("error updating this LFG post");
  });

  it.each([
    ["closed", "no longer open"],
    ["already_joined", "already on this roster"],
    ["full", "already full"],
  ])("answers a %s join without touching the post", async (status, text) => {
    mockJoinPost.mockResolvedValue({ status, post: post() });
    const btn = buttonInteraction(`lfg_join_${POST_ID}`);

    await handleLfgButton(btn);

    expect(btn.editReply).not.toHaveBeenCalled();
    expect(
      (btn.followUp.mock.calls[0][0] as { content: string }).content,
    ).toContain(text);
  });

  it("sends the host to Close rather than letting them leave", async () => {
    mockLeavePost.mockResolvedValue({ status: "host", post: post() });
    const btn = buttonInteraction(`lfg_leave_${POST_ID}`);

    await handleLfgButton(btn);

    expect(btn.editReply).not.toHaveBeenCalled();
    expect(
      (btn.followUp.mock.calls[0][0] as { content: string }).content,
    ).toContain("Close");
  });

  it("refreshes the post when someone leaves", async () => {
    mockLeavePost.mockResolvedValue({ status: "left", post: post() });
    const btn = buttonInteraction(`lfg_leave_${POST_ID}`);

    await handleLfgButton(btn);

    expect(btn.editReply).toHaveBeenCalledWith({ content: "refreshed" });
  });

  it("closes the post for its host", async () => {
    mockCloseByHost.mockResolvedValue({
      status: "closed",
      post: post({ state: "closed" }),
    });
    const btn = buttonInteraction(`lfg_close_${POST_ID}`);

    await handleLfgButton(btn);

    expect(mockCloseByHost).toHaveBeenCalledWith(POST_ID, "user-1");
    expect(btn.editReply).toHaveBeenCalledWith({ content: "refreshed" });
  });

  it("refuses a Close from anyone but the host", async () => {
    mockCloseByHost.mockResolvedValue({ status: "not_host" });
    const btn = buttonInteraction(`lfg_close_${POST_ID}`);

    await handleLfgButton(btn);

    expect(btn.editReply).not.toHaveBeenCalled();
    expect(
      (btn.followUp.mock.calls[0][0] as { content: string }).content,
    ).toContain("Only the host");
  });

  it("rejects a malformed customId without acknowledging or calling the service", async () => {
    const btn = buttonInteraction("lfg_bogus_1_2");

    await handleLfgButton(btn);

    expect(btn.deferUpdate).not.toHaveBeenCalled();
    expect(mockJoinPost).not.toHaveBeenCalled();
    expect(mockLeavePost).not.toHaveBeenCalled();
    expect(mockCloseByHost).not.toHaveBeenCalled();
    expect(
      (btn.reply.mock.calls[0][0] as { content: string }).content,
    ).toContain("Invalid LFG button");
  });

  it("always answers the click, even when the service throws", async () => {
    mockJoinPost.mockRejectedValue(new Error("mongo is down"));
    const btn = buttonInteraction(`lfg_join_${POST_ID}`);

    await handleLfgButton(btn);

    expect(
      (btn.followUp.mock.calls[0][0] as { content: string }).content,
    ).toContain("error updating this LFG post");
  });
});

// Two clicks on the same post in the same instant each render the snapshot
// their own write returned. Unordered, their Discord edits can land in the
// opposite order and leave the older roster on screen for good, since nothing
// re-renders a post that is still open.
describe("concurrent clicks on one post", () => {
  it("runs them one after another, so the last write is the last edit", async () => {
    const order: string[] = [];
    let releaseFirst: (() => void) | undefined;

    mockJoinPost
      .mockImplementationOnce(async () => {
        order.push("first:write");
        await new Promise<void>((resolve) => {
          releaseFirst = resolve;
        });
        return {
          status: "joined",
          post: post({ memberIds: ["user-1", "a"] }),
          filled: false,
        };
      })
      .mockImplementationOnce(async () => {
        order.push("second:write");
        return {
          status: "joined",
          post: post({ memberIds: ["user-1", "a", "b"] }),
          filled: false,
        };
      });

    const first = buttonInteraction(`lfg_join_${POST_ID}`);
    (first.editReply as jest.Mock).mockImplementation(async () => {
      order.push("first:edit");
      return undefined;
    });
    const second = buttonInteraction(`lfg_join_${POST_ID}`);
    (second.editReply as jest.Mock).mockImplementation(async () => {
      order.push("second:edit");
      return undefined;
    });

    const firstRun = handleLfgButton(first);
    const secondRun = handleLfgButton(second);

    // Let both clicks get as far as they can, then unblock the first. Without
    // the lock the second would already have written and edited by now.
    await new Promise((resolve) => setTimeout(resolve, 5));
    const queuedWhileFirstHeldTheLock = [...order];
    releaseFirst?.();
    await Promise.all([firstRun, secondRun]);

    expect(queuedWhileFirstHeldTheLock).toEqual(["first:write"]);

    expect(order).toEqual([
      "first:write",
      "first:edit",
      "second:write",
      "second:edit",
    ]);
  });

  it("lets the next click through even when the one before it threw", async () => {
    mockJoinPost
      .mockRejectedValueOnce(new Error("mongo is down"))
      .mockResolvedValueOnce({
        status: "joined",
        post: post({ memberIds: ["user-1", "b"] }),
        filled: false,
      });

    const first = buttonInteraction(`lfg_join_${POST_ID}`);
    const second = buttonInteraction(`lfg_join_${POST_ID}`);

    await Promise.all([handleLfgButton(first), handleLfgButton(second)]);

    expect(second.editReply).toHaveBeenCalledWith({ content: "refreshed" });
  });

  it("does not retain a chain once the clicks have drained", async () => {
    mockJoinPost.mockResolvedValue({
      status: "joined",
      post: post({ memberIds: ["user-1", "a"] }),
      filled: false,
    });

    await handleLfgButton(buttonInteraction(`lfg_join_${POST_ID}`));
    // A fresh click still works, which is what a leaked or stuck chain would
    // break; the map's own bookkeeping is internal.
    const later = buttonInteraction(`lfg_join_${POST_ID}`);
    await handleLfgButton(later);

    expect(later.editReply).toHaveBeenCalledWith({ content: "refreshed" });
  });
});
