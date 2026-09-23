import { describe, it, expect, jest, beforeEach } from "@jest/globals";
import { DiscordAPIError } from "discord.js";

// The lfg-service module registers a config reload callback and touches a
// Mongoose model at import time. Mock the heavy dependencies so the pure
// helpers and the service methods can be exercised in isolation (mirrors the
// event service test).
const configValues: {
  booleans: Record<string, boolean>;
  strings: Record<string, string>;
  numbers: Record<string, number>;
} = { booleans: {}, strings: {}, numbers: {} };

/** Reload callbacks the service registers, so tests can fire them. */
const reloadCallbacks: Array<() => Promise<void>> = [];

jest.unstable_mockModule("../../src/services/config-service.js", () => ({
  ConfigService: {
    getInstance: jest.fn(() => ({
      registerReloadCallback: jest.fn((cb: () => Promise<void>) => {
        reloadCallbacks.push(cb);
      }),
      getBoolean: jest.fn(async (key: string, fallback?: boolean) =>
        key in configValues.booleans ? configValues.booleans[key] : fallback,
      ),
      getString: jest.fn(async (key: string, fallback?: string) =>
        key in configValues.strings ? configValues.strings[key] : fallback,
      ),
      getNumber: jest.fn(async (key: string, fallback?: number) =>
        key in configValues.numbers ? configValues.numbers[key] : fallback,
      ),
    })),
  },
}));

jest.unstable_mockModule("../../src/services/voice-channel-manager.js", () => ({
  VoiceChannelManager: { getInstance: jest.fn() },
}));

jest.unstable_mockModule("../../src/models/lfg-post.js", () => ({
  LfgPost: jest.fn(),
  LFG_ROW_TTL_SECONDS: 60 * 60,
}));

jest.unstable_mockModule("../../src/utils/logger.js", () => ({
  default: {
    info: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
    debug: jest.fn(),
  },
}));

const { LfgPost } = await import("../../src/models/lfg-post.js");
const LfgPostMock = LfgPost as unknown as jest.Mock & {
  find: jest.Mock;
  findById: jest.Mock;
  findOneAndUpdate: jest.Mock;
  countDocuments: jest.Mock;
  deleteMany: jest.Mock;
  deleteOne: jest.Mock;
  updateOne: jest.Mock;
};

const { VoiceChannelManager } =
  await import("../../src/services/voice-channel-manager.js");
const VcmMock = VoiceChannelManager as unknown as { getInstance: jest.Mock };

const {
  LfgService,
  resolvePartySize,
  isPartyFull,
  spotsLeft,
  closedSummary,
  formatRoster,
  isStillOpen,
  MIN_PARTY_SIZE,
  MAX_PARTY_SIZE,
} = await import("../../src/services/lfg-service.js");

const POST_ID = "0123456789abcdef01234567"; // valid ObjectId shape

interface PostLike {
  _id: string;
  guildId: string;
  hostId: string;
  game: string;
  note: string;
  partySize: number;
  memberIds: string[];
  channelId: string;
  messageId: string | null;
  voiceChannelId: string | null;
  state: "open" | "closed";
  closeReason: "expired" | "full" | "cancelled" | null;
  renderPending: boolean;
  lastRenderAttemptAt: Date | null;
  expiresAt: Date;
}

function post(overrides: Partial<PostLike> = {}): PostLike {
  return {
    _id: POST_ID,
    guildId: "guild-1",
    hostId: "host-1",
    game: "Helldivers 2",
    note: "",
    partySize: 4,
    memberIds: ["host-1"],
    channelId: "chan-1",
    messageId: "msg-1",
    voiceChannelId: null,
    state: "open",
    closeReason: null,
    renderPending: false,
    lastRenderAttemptAt: null,
    // Comfortably in the future: every interactive mutation now refuses a
    // post that has run past its advertised closing time.
    expiresAt: new Date(Date.now() + 30 * 60 * 1000),
    ...overrides,
  };
}

/**
 * A stand-in for the chainable query the sweep builds: both of its `find`
 * calls are bounded, oldest-first batches (`.sort().limit()`).
 */
function queryReturning(rows: PostLike[]): {
  sort: () => { limit: () => Promise<PostLike[]> };
} {
  return { sort: () => ({ limit: async () => rows }) };
}

/** Shared stand-in client: `getInstance` rejects a second, different one. */
const CLIENT = {} as never;

function buildService(): InstanceType<typeof LfgService> {
  return LfgService.getInstance(CLIENT);
}

beforeEach(() => {
  LfgService.reset();
  reloadCallbacks.length = 0;
  configValues.booleans = {};
  configValues.strings = {};
  configValues.numbers = {};
  LfgPostMock.find = jest.fn(() => queryReturning([]));
  LfgPostMock.findById = jest.fn(async () => null);
  LfgPostMock.findOneAndUpdate = jest.fn(async () => null);
  LfgPostMock.countDocuments = jest.fn(async () => 0);
  LfgPostMock.deleteMany = jest.fn(async () => ({ deletedCount: 0 }));
  LfgPostMock.deleteOne = jest.fn(async () => ({ deletedCount: 1 }));
  LfgPostMock.updateOne = jest.fn(async () => ({ modifiedCount: 1 }));
  VcmMock.getInstance = jest.fn();
});

describe("resolvePartySize", () => {
  it("uses the configured default when the member gives no size", () => {
    expect(resolvePartySize(null, 5)).toBe(5);
  });
  it("prefers an explicit size over the default", () => {
    expect(resolvePartySize(3, 5)).toBe(3);
  });
  it("clamps below the minimum", () => {
    expect(resolvePartySize(1, 4)).toBe(MIN_PARTY_SIZE);
  });
  it("clamps above the maximum so the roster fits one embed field", () => {
    expect(resolvePartySize(400, 4)).toBe(MAX_PARTY_SIZE);
  });
  it("clamps a nonsense configured default rather than trusting it", () => {
    expect(resolvePartySize(undefined, -7)).toBe(MIN_PARTY_SIZE);
  });
});

describe("isPartyFull / spotsLeft", () => {
  it("counts a party with room as open", () => {
    const p = post({ memberIds: ["a", "b"], partySize: 4 });
    expect(isPartyFull(p)).toBe(false);
    expect(spotsLeft(p)).toBe(2);
  });
  it("counts a party at its requested size as full", () => {
    const p = post({ memberIds: ["a", "b"], partySize: 2 });
    expect(isPartyFull(p)).toBe(true);
    expect(spotsLeft(p)).toBe(0);
  });
  it("never reports negative spots if a roster overshoots", () => {
    expect(spotsLeft(post({ memberIds: ["a", "b", "c"], partySize: 2 }))).toBe(
      0,
    );
  });
});

describe("closedSummary", () => {
  it("explains each close reason", () => {
    expect(closedSummary("full")).toMatch(/filled/i);
    expect(closedSummary("cancelled")).toMatch(/host/i);
    expect(closedSummary("expired")).toMatch(/expired/i);
  });
  it("falls back for a row with no recorded reason", () => {
    expect(closedSummary(null)).toBe("Closed.");
  });
});

describe("formatRoster", () => {
  it("renders members as mentions", () => {
    expect(formatRoster(["a", "b"])).toBe("<@a> · <@b>");
  });
  it("says so when nobody is on the roster", () => {
    expect(formatRoster([])).toBe("_nobody yet_");
  });
  it("stays inside the embed field limit for a full roster", () => {
    const ids = Array.from({ length: MAX_PARTY_SIZE }, (_, i) =>
      String(100000000000000000n + BigInt(i)),
    );
    expect(formatRoster(ids).length).toBeLessThanOrEqual(1024);
  });
});

// The join path is the highest-concurrency write in the feature: one post
// draws several clicks in the same tick, and a fetch/modify/save would let
// two of them both see the last free slot (lost update). Appending in one
// write and closing in another has its own race — a Leave landing between
// them closes a post as `full` with an underfilled roster — so both happen
// in a single pipeline update.
describe("joinPost", () => {
  it("appends and conditionally closes in one atomic write", async () => {
    const updated = post({ memberIds: ["host-1", "user-2"] });
    LfgPostMock.findOneAndUpdate = jest.fn(async () => updated);

    const result = await buildService().joinPost(POST_ID, "user-2");

    expect(result).toEqual({ status: "joined", post: updated, filled: false });
    expect(LfgPostMock.findOneAndUpdate).toHaveBeenCalledTimes(1);

    const [filter, pipeline, options] =
      LfgPostMock.findOneAndUpdate.mock.calls[0];
    expect(filter).toEqual({
      _id: POST_ID,
      state: "open",
      expiresAt: { $gt: expect.any(Date) },
      memberIds: { $ne: "user-2" },
      $expr: { $lt: [{ $size: "$memberIds" }, "$partySize"] },
    });
    expect(options).toEqual({ new: true });
    // Stage 1 appends; stage 2 reads the *post-append* roster to decide
    // whether the party is now full.
    expect(pipeline).toEqual([
      { $set: { memberIds: { $concatArrays: ["$memberIds", ["user-2"]] } } },
      {
        $set: {
          state: {
            $cond: [
              { $gte: [{ $size: "$memberIds" }, "$partySize"] },
              "closed",
              "$state",
            ],
          },
          closeReason: {
            $cond: [
              { $gte: [{ $size: "$memberIds" }, "$partySize"] },
              "full",
              "$closeReason",
            ],
          },
          // Recorded in the same write, so a crash between the commit and the
          // edit still leaves the post on the sweep's retry list — which is
          // the only thing that would ever render a row this write closed.
          renderPending: true,
        },
      },
    ]);
  });

  it("reports the post as filled when that same write closed it", async () => {
    const closed = post({
      memberIds: ["host-1", "user-2"],
      partySize: 2,
      state: "closed",
      closeReason: "full",
    });
    LfgPostMock.findOneAndUpdate = jest.fn(async () => closed);

    const result = await buildService().joinPost(POST_ID, "user-2");

    expect(result).toEqual({ status: "joined", post: closed, filled: true });
    // No follow-up close: one write did both, so a concurrent Leave or host
    // Close cannot slip between them.
    expect(LfgPostMock.findOneAndUpdate).toHaveBeenCalledTimes(1);
  });

  it("reports a closed post rather than a silent no-op", async () => {
    LfgPostMock.findById = jest.fn(async () => post({ state: "closed" }));

    expect(await buildService().joinPost(POST_ID, "user-2")).toEqual({
      status: "closed",
    });
  });

  it("distinguishes 'already on the roster' from 'full'", async () => {
    const current = post({ memberIds: ["host-1", "user-2"] });
    LfgPostMock.findById = jest.fn(async () => current);

    expect(await buildService().joinPost(POST_ID, "user-2")).toEqual({
      status: "already_joined",
      post: current,
    });

    const full = post({ memberIds: ["host-1", "x"], partySize: 2 });
    LfgPostMock.findById = jest.fn(async () => full);
    expect(await buildService().joinPost(POST_ID, "user-3")).toEqual({
      status: "full",
      post: full,
    });
  });

  it("rejects a malformed post id without touching the database", async () => {
    const result = await buildService().joinPost("not-an-id", "user-2");
    expect(result).toEqual({ status: "closed" });
    expect(LfgPostMock.findOneAndUpdate).not.toHaveBeenCalled();
  });
});

describe("leavePost", () => {
  it("pulls the member server-side, excluding the host", async () => {
    const updated = post({ memberIds: ["host-1"] });
    LfgPostMock.findOneAndUpdate = jest.fn(async () => updated);

    const result = await buildService().leavePost(POST_ID, "user-2");

    expect(result).toEqual({ status: "left", post: updated });
    expect(LfgPostMock.findOneAndUpdate).toHaveBeenCalledWith(
      {
        _id: POST_ID,
        state: "open",
        expiresAt: { $gt: expect.any(Date) },
        hostId: { $ne: "user-2" },
        memberIds: "user-2",
      },
      { $pull: { memberIds: "user-2" }, $set: { renderPending: true } },
      { new: true },
    );
  });

  it("tells the host to close instead of leaving", async () => {
    const current = post();
    LfgPostMock.findById = jest.fn(async () => current);

    expect(await buildService().leavePost(POST_ID, "host-1")).toEqual({
      status: "host",
      post: current,
    });
  });

  it("reports a member who was never on the roster", async () => {
    const current = post();
    LfgPostMock.findById = jest.fn(async () => current);

    expect(await buildService().leavePost(POST_ID, "stranger")).toEqual({
      status: "not_joined",
      post: current,
    });
  });
});

describe("closeByHost", () => {
  it("closes with the host in the filter so only they can", async () => {
    const closed = post({ state: "closed", closeReason: "cancelled" });
    LfgPostMock.findOneAndUpdate = jest.fn(async () => closed);

    expect(await buildService().closeByHost(POST_ID, "host-1")).toEqual({
      status: "closed",
      post: closed,
    });
    expect(LfgPostMock.findOneAndUpdate).toHaveBeenCalledWith(
      { _id: POST_ID, state: "open", hostId: "host-1" },
      // The close itself records that the embed is now out of date.
      {
        $set: {
          state: "closed",
          closeReason: "cancelled",
          renderPending: true,
        },
      },
      { new: true },
    );
  });

  it("refuses anyone but the host", async () => {
    LfgPostMock.findById = jest.fn(async () => post());

    expect(await buildService().closeByHost(POST_ID, "someone-else")).toEqual({
      status: "not_host",
    });
  });

  it("reports an already-closed post", async () => {
    LfgPostMock.findById = jest.fn(async () => post({ state: "closed" }));

    expect(await buildService().closeByHost(POST_ID, "host-1")).toEqual({
      status: "closed_already",
    });
  });
});

describe("sweep (runOnce)", () => {
  /** `find` is called twice per sweep: due posts, then unrendered closed. */
  function stubFinds(due: PostLike[], unrendered: PostLike[] = []): jest.Mock {
    const find = jest
      .fn<(...args: unknown[]) => unknown>()
      .mockReturnValueOnce(queryReturning(due))
      .mockReturnValueOnce(queryReturning(unrendered));
    LfgPostMock.find = find;
    return find as jest.Mock;
  }

  it("closes due posts, re-renders them, and ages out rendered rows", async () => {
    const due = post();
    const find = stubFinds([due]);
    const closed = {
      ...due,
      state: "closed" as const,
      closeReason: "expired" as const,
    };
    LfgPostMock.findOneAndUpdate = jest.fn(async () => closed);
    // What the sweep's re-read sees once the close has landed.
    LfgPostMock.findById = jest.fn(async () => closed);
    LfgPostMock.deleteMany = jest.fn(async () => ({ deletedCount: 3 }));

    const svc = buildService();
    const render = jest.spyOn(svc, "renderToMessage").mockResolvedValue(true);
    configValues.booleans["lfg.enabled"] = true;

    const summary = await svc.runNow();

    expect(summary).toEqual({ expired: 1, retried: 0, purged: 3 });
    expect(render).toHaveBeenCalledWith(closed);
    expect(find).toHaveBeenNthCalledWith(1, {
      state: "open",
      expiresAt: { $lte: expect.any(Date) },
    });
    // Only rows whose message is confirmed up to date are purged.
    expect(LfgPostMock.deleteMany).toHaveBeenCalledWith({
      state: "closed",
      renderPending: false,
      updatedAt: { $lte: expect.any(Date) },
    });
  });

  it("marks a post rendered so it is neither retried nor left stale", async () => {
    const due = post();
    stubFinds([due]);
    const closed = { ...due, state: "closed" as const };
    LfgPostMock.findOneAndUpdate = jest.fn(async () => closed);
    LfgPostMock.findById = jest.fn(async () => closed);

    const svc = buildService();
    jest.spyOn(svc, "renderToMessage").mockResolvedValue(true);
    configValues.booleans["lfg.enabled"] = true;

    await svc.runNow();

    expect(LfgPostMock.updateOne).toHaveBeenCalledWith(
      { _id: POST_ID },
      {
        $set: {
          lastRenderAttemptAt: expect.any(Date),
          renderPending: false,
        },
      },
    );
  });

  it("leaves a post unmarked when the edit failed, so a later tick retries", async () => {
    const due = post();
    stubFinds([due]);
    const closed = { ...due, state: "closed" as const };
    LfgPostMock.findOneAndUpdate = jest.fn(async () => closed);
    LfgPostMock.findById = jest.fn(async () => closed);

    const svc = buildService();
    jest.spyOn(svc, "renderToMessage").mockResolvedValue(false);
    configValues.booleans["lfg.enabled"] = true;

    const summary = await svc.runNow();

    expect(summary.expired).toBe(1);
    // The attempt is stamped so the row rotates to the back of the retry
    // batch, but `renderPending` stays set so a later tick tries again.
    expect(LfgPostMock.updateOne).toHaveBeenCalledWith(
      { _id: POST_ID },
      { $set: { lastRenderAttemptAt: expect.any(Date) } },
    );
  });

  it("retries any post whose message never got re-rendered", async () => {
    const stale = post({
      state: "closed",
      closeReason: "cancelled",
      renderPending: true,
    });
    stubFinds([], [stale]);
    LfgPostMock.findById = jest.fn(async () => stale);

    const svc = buildService();
    const render = jest.spyOn(svc, "renderToMessage").mockResolvedValue(true);
    configValues.booleans["lfg.enabled"] = true;

    const summary = await svc.runNow();

    expect(summary).toEqual({ expired: 0, retried: 1, purged: 0 });
    expect(render).toHaveBeenCalledWith(stale);
    // Not filtered by state: a click whose edit failed leaves an *open* post
    // showing a stale roster, and nothing else would re-read it either.
    expect(LfgPostMock.find).toHaveBeenNthCalledWith(2, {
      renderPending: true,
    });
  });

  it("does not count a post another closer already took", async () => {
    stubFinds([post()]);
    LfgPostMock.findOneAndUpdate = jest.fn(async () => null);

    const svc = buildService();
    const render = jest.spyOn(svc, "renderToMessage").mockResolvedValue(true);
    configValues.booleans["lfg.enabled"] = true;

    expect(await svc.runNow()).toEqual({
      expired: 0,
      retried: 0,
      purged: 0,
    });
    expect(render).not.toHaveBeenCalled();
  });

  it("does not run at all while the feature is disabled", async () => {
    configValues.booleans["lfg.enabled"] = false;

    expect(await buildService().runNow()).toBeNull();
    expect(LfgPostMock.find).not.toHaveBeenCalled();
  });
});

describe("createPost", () => {
  function stubChannel(send: jest.Mock): { client: unknown; send: jest.Mock } {
    const channel = {
      id: "chan-1",
      isTextBased: () => true,
      isDMBased: () => false,
      send,
    };
    return {
      client: { channels: { fetch: jest.fn(async () => channel) } },
      send,
    };
  }

  const input = {
    guildId: "guild-1",
    hostId: "host-1",
    game: "Valorant",
    note: "",
    partySize: 5,
    fallbackChannelId: "chan-1",
  };

  /** Capture what each `save()` wrote, in order. */
  function stubSavedPosts(): Record<string, unknown>[] {
    const saved: Record<string, unknown>[] = [];
    LfgPostMock.mockImplementation(function (
      this: Record<string, unknown>,
      doc: Record<string, unknown>,
    ) {
      Object.assign(this, doc, {
        _id: POST_ID,
        save: jest.fn(async () => {
          saved.push({ ...this });
        }),
      });
    } as never);
    return saved;
  }

  it("saves the row, posts the embed, and records the message id", async () => {
    const send = jest.fn(async () => ({ id: "msg-9" }));
    const { client } = stubChannel(send as never);
    const saved: Record<string, unknown>[] = [];
    LfgPostMock.mockImplementation(function (
      this: Record<string, unknown>,
      doc: Record<string, unknown>,
    ) {
      Object.assign(this, doc, {
        _id: POST_ID,
        save: jest.fn(async () => {
          saved.push({ ...this });
        }),
      });
    } as never);

    const service = LfgService.getInstance(client as never);
    const result = await service.createPost(input);

    expect(result.status).toBe("created");
    expect(send).toHaveBeenCalledTimes(1);
    // Host is seeded onto their own roster, and the message id is persisted
    // so the sweep can re-render the post later.
    expect(saved[0].memberIds).toEqual(["host-1"]);
    expect(saved[1].messageId).toBe("msg-9");
  });

  // Counting before the insert would let two `/lfg` runs in the same instant
  // both see a count below the cap. Counting the member's *older* open rows
  // after inserting cannot: of two racing posts, exactly one sees the other
  // as older, and that one stands down.
  it("settles the cap against older rows, after reserving its own", async () => {
    const send = jest.fn(async () => ({ id: "msg-9" }));
    const { client } = stubChannel(send as never);
    configValues.numbers["lfg.max_active_per_user"] = 2;
    LfgPostMock.countDocuments = jest.fn(async () => 2);
    stubSavedPosts();

    const result = await LfgService.getInstance(client as never).createPost(
      input,
    );

    expect(result).toEqual({ status: "at_limit", limit: 2 });
    expect(LfgPostMock.countDocuments).toHaveBeenCalledWith({
      guildId: "guild-1",
      hostId: "host-1",
      // A reservation counts too, so a member cannot outrun their own cap by
      // running /lfg twice in the same instant.
      state: { $in: ["creating", "open"] },
      // An expired post accepts nobody, so it must not hold a slot either.
      expiresAt: { $gt: expect.any(Date) },
      _id: { $lt: POST_ID },
    });
    // The reservation is given back, and no post goes out.
    expect(LfgPostMock.deleteOne).toHaveBeenCalledWith({ _id: POST_ID });
    expect(send).not.toHaveBeenCalled();
  });

  it("does not create a voice channel for a post it then refuses", async () => {
    const { client } = stubChannel(jest.fn() as never);
    configValues.numbers["lfg.max_active_per_user"] = 1;
    configValues.booleans["voicechannels.enabled"] = true;
    LfgPostMock.countDocuments = jest.fn(async () => 1);
    const getInstance = jest.fn();
    VcmMock.getInstance = getInstance;
    stubSavedPosts();

    await LfgService.getInstance(client as never).createPost(input);

    expect(getInstance).not.toHaveBeenCalled();
  });

  it("treats a cap of 0 as no cap", async () => {
    const send = jest.fn(async () => ({ id: "msg-9" }));
    const { client } = stubChannel(send as never);
    configValues.numbers["lfg.max_active_per_user"] = 0;
    stubSavedPosts();

    const result = await LfgService.getInstance(client as never).createPost(
      input,
    );

    expect(result.status).toBe("created");
    expect(LfgPostMock.countDocuments).not.toHaveBeenCalled();
  });

  // The message is already out by then, so dropping the row alone would leave
  // a post that looks live but can never be joined, closed or expired.
  it("takes the message down when its id cannot be recorded", async () => {
    const del = jest.fn(async () => undefined);
    const send = jest.fn(async () => ({ id: "msg-9", delete: del }));
    const { client } = stubChannel(send as never);
    let saves = 0;
    LfgPostMock.mockImplementation(function (
      this: Record<string, unknown>,
      doc: Record<string, unknown>,
    ) {
      Object.assign(this, doc, {
        _id: POST_ID,
        save: jest.fn(async () => {
          // The reservation save succeeds; recording the message id does not.
          if (++saves > 1) throw new Error("connection reset");
        }),
      });
    } as never);

    const result = await LfgService.getInstance(client as never).createPost(
      input,
    );

    expect(result).toEqual({ status: "post_failed" });
    expect(del).toHaveBeenCalledTimes(1);
    expect(LfgPostMock.deleteOne).toHaveBeenCalledWith({ _id: POST_ID });
  });

  it("drops the row when the post cannot be sent, so no invisible post is left", async () => {
    const send = jest.fn(async () => {
      throw new Error("missing permissions");
    });
    const { client } = stubChannel(send as never);
    LfgPostMock.mockImplementation(function (
      this: Record<string, unknown>,
      doc: Record<string, unknown>,
    ) {
      Object.assign(this, doc, { _id: POST_ID, save: jest.fn(async () => {}) });
    } as never);

    const result = await LfgService.getInstance(client as never).createPost(
      input,
    );

    expect(result).toEqual({ status: "post_failed" });
    expect(LfgPostMock.deleteOne).toHaveBeenCalledWith({ _id: POST_ID });
  });

  it("reports a channel it cannot post in", async () => {
    const client = {
      channels: { fetch: jest.fn(async () => null) },
    };

    const result = await LfgService.getInstance(client as never).createPost(
      input,
    );

    expect(result).toEqual({ status: "no_channel" });
  });

  it("attaches the host's existing dynamic channel rather than a second one", async () => {
    const send = jest.fn(async () => ({ id: "msg-9" }));
    const { client } = stubChannel(send as never);
    // The host is sitting in the channel they already own.
    (client as { guilds: unknown }).guilds = {
      fetch: jest.fn(async () => ({
        id: "guild-1",
        members: {
          fetch: jest.fn(async () => ({
            voice: { channelId: "voice-existing", setChannel: jest.fn() },
          })),
        },
      })),
    };
    configValues.booleans["voicechannels.enabled"] = true;
    const createDynamicChannel = jest.fn();
    VcmMock.getInstance = jest.fn(() => ({
      getUserChannel: jest.fn(() => ({ id: "voice-existing" })),
      createDynamicChannel,
    }));
    const saved = stubSavedPosts();

    await LfgService.getInstance(client as never).createPost(input);

    expect(saved[saved.length - 1].voiceChannelId).toBe("voice-existing");
    expect(createDynamicChannel).not.toHaveBeenCalled();
  });

  it("posts without a channel while voice channel management is off", async () => {
    const send = jest.fn(async () => ({ id: "msg-9" }));
    const { client } = stubChannel(send as never);
    configValues.booleans["voicechannels.enabled"] = false;
    const getUserChannel = jest.fn();
    VcmMock.getInstance = jest.fn(() => ({
      getUserChannel,
      createDynamicChannel: jest.fn(),
    }));
    const saved: Record<string, unknown>[] = [];
    LfgPostMock.mockImplementation(function (
      this: Record<string, unknown>,
      doc: Record<string, unknown>,
    ) {
      Object.assign(this, doc, {
        _id: POST_ID,
        save: jest.fn(async () => {
          saved.push({ ...this });
        }),
      });
    } as never);

    await LfgService.getInstance(client as never).createPost(input);

    expect(saved[saved.length - 1].voiceChannelId).toBeNull();
    expect(getUserChannel).not.toHaveBeenCalled();
  });
});

describe("buildPayload", () => {
  it("renders an open post with live buttons and a countdown", () => {
    const payload = buildService().buildPayload(
      post({
        memberIds: ["host-1", "user-2"],
        voiceChannelId: "voice-1",
      }) as never,
    );
    const embed = payload.embeds[0].toJSON();

    expect(embed.title).toContain("LFG");
    expect(embed.fields?.find((f) => f.name === "Party")?.value).toBe("2/4");
    expect(embed.fields?.find((f) => f.name === "Voice channel")?.value).toBe(
      "<#voice-1>",
    );
    expect(embed.fields?.find((f) => f.name === "Closes")?.value).toContain(
      ":R>",
    );
    const row = payload.components[0].toJSON();
    expect(
      row.components.map((c) => (c as { custom_id: string }).custom_id),
    ).toEqual([
      `lfg_join_${POST_ID}`,
      `lfg_leave_${POST_ID}`,
      `lfg_close_${POST_ID}`,
    ]);
    expect(
      row.components.every(
        (c) => (c as { disabled?: boolean }).disabled === false,
      ),
    ).toBe(true);
  });

  it("greys out every button on a closed post and says why it closed", () => {
    const payload = buildService().buildPayload(
      post({
        state: "closed",
        closeReason: "full",
        voiceChannelId: "voice-1",
      }) as never,
    );
    const embed = payload.embeds[0].toJSON();

    expect(embed.title).toContain("closed");
    expect(embed.footer?.text).toMatch(/filled/i);
    // A closed post drops the countdown and the channel link: the channel is
    // not this feature's to advertise once the party is over.
    expect(embed.fields?.some((f) => f.name === "Closes")).toBe(false);
    expect(embed.fields?.some((f) => f.name === "Voice channel")).toBe(false);
    expect(
      payload.components[0]
        .toJSON()
        .components.every(
          (c) => (c as { disabled?: boolean }).disabled === true,
        ),
    ).toBe(true);
  });
});

describe("renderToMessage", () => {
  function clientWithMessage(
    edit: jest.Mock,
    fetch?: jest.Mock,
  ): { channels: { fetch: jest.Mock } } {
    const channel = {
      id: "chan-1",
      isTextBased: () => true,
      isDMBased: () => false,
      messages: { fetch: fetch ?? jest.fn(async () => ({ edit })) },
    };
    return { channels: { fetch: jest.fn(async () => channel) } };
  }

  it("edits the post in place and reports success", async () => {
    const edit = jest.fn(async () => undefined);
    const service = LfgService.getInstance(
      clientWithMessage(edit as never) as never,
    );

    await expect(
      service.renderToMessage(post({ state: "closed" }) as never),
    ).resolves.toBe(true);
    expect(edit).toHaveBeenCalledTimes(1);
  });

  it("does nothing for a post whose message was never sent", async () => {
    const edit = jest.fn(async () => undefined);
    const client = clientWithMessage(edit as never);
    const service = LfgService.getInstance(client as never);

    await service.renderToMessage(post({ messageId: null }) as never);

    expect(client.channels.fetch).not.toHaveBeenCalled();
  });

  // A deleted message counts as rendered: nothing stale is left on screen,
  // so the sweep must stop retrying it (and may purge the row).
  it("treats a message that has been deleted as rendered", async () => {
    const gone = Object.assign(Object.create(DiscordAPIError.prototype), {
      code: 10008,
    });
    const fetch = jest.fn(async () => {
      throw gone;
    });
    const service = LfgService.getInstance(
      clientWithMessage(jest.fn() as never, fetch as never) as never,
    );

    await expect(service.renderToMessage(post() as never)).resolves.toBe(true);
  });

  it("reports any other Discord failure so a later tick retries it", async () => {
    const fetch = jest.fn(async () => {
      throw new Error("gateway exploded");
    });
    const service = LfgService.getInstance(
      clientWithMessage(jest.fn() as never, fetch as never) as never,
    );

    await expect(service.renderToMessage(post() as never)).resolves.toBe(false);
  });
});

describe("voice channel attachment", () => {
  const input = {
    guildId: "guild-1",
    hostId: "host-1",
    game: "Deep Rock Galactic",
    note: "",
    partySize: 4,
    fallbackChannelId: "chan-1",
  };

  function stubSavedPosts(): Record<string, unknown>[] {
    const saved: Record<string, unknown>[] = [];
    LfgPostMock.mockImplementation(function (
      this: Record<string, unknown>,
      doc: Record<string, unknown>,
    ) {
      Object.assign(this, doc, {
        _id: POST_ID,
        save: jest.fn(async () => {
          saved.push({ ...this });
        }),
      });
    } as never);
    return saved;
  }

  /**
   * A client whose guild reports the host's voice state. `voiceChannelId`
   * null stands for a host who is not connected to voice at all.
   */
  function clientWithGuild(
    voiceChannelId: string | null = "voice-somewhere",
    setChannel: jest.Mock = jest.fn(async () => undefined),
  ): { client: unknown; setChannel: jest.Mock } {
    const channel = {
      id: "chan-1",
      isTextBased: () => true,
      isDMBased: () => false,
      send: jest.fn(async () => ({ id: "msg-9" })),
    };
    return {
      client: {
        channels: { fetch: jest.fn(async () => channel) },
        guilds: {
          fetch: jest.fn(async () => ({
            id: "guild-1",
            members: {
              fetch: jest.fn(async () => ({
                voice: { channelId: voiceChannelId, setChannel },
              })),
            },
          })),
        },
      },
      setChannel,
    };
  }

  // An empty managed channel is deleted by the voice-channel sweep within
  // minutes, so a channel the host is not moved into would leave the post
  // pointing at a dead link.
  it("creates the channel with the server's prefix and moves the host in", async () => {
    configValues.booleans["voicechannels.enabled"] = true;
    configValues.strings["voicechannels.channel.prefix"] = "🎮";
    const createDynamicChannel = jest.fn(async () => ({ id: "voice-new" }));
    VcmMock.getInstance = jest.fn(() => ({
      getUserChannel: jest.fn(() => undefined),
      createDynamicChannel,
    }));
    const saved = stubSavedPosts();
    const { client, setChannel } = clientWithGuild();

    await LfgService.getInstance(client as never).createPost(input);

    expect(createDynamicChannel).toHaveBeenCalledWith(
      expect.objectContaining({ id: "guild-1" }),
      "host-1",
      "🎮 Deep Rock Galactic",
    );
    expect(setChannel).toHaveBeenCalledWith("voice-new");
    expect(saved[saved.length - 1].voiceChannelId).toBe("voice-new");
  });

  it("creates no channel for a host who is not in voice", async () => {
    configValues.booleans["voicechannels.enabled"] = true;
    const createDynamicChannel = jest.fn();
    VcmMock.getInstance = jest.fn(() => ({
      getUserChannel: jest.fn(() => undefined),
      createDynamicChannel,
    }));
    const saved = stubSavedPosts();
    const { client } = clientWithGuild(null);

    const result = await LfgService.getInstance(client as never).createPost(
      input,
    );

    expect(result.status).toBe("created");
    expect(createDynamicChannel).not.toHaveBeenCalled();
    expect(saved[saved.length - 1].voiceChannelId).toBeNull();
  });

  it("does not link the host's own channel while they are elsewhere", async () => {
    configValues.booleans["voicechannels.enabled"] = true;
    const createDynamicChannel = jest.fn();
    VcmMock.getInstance = jest.fn(() => ({
      getUserChannel: jest.fn(() => ({ id: "voice-owned" })),
      createDynamicChannel,
    }));
    const saved = stubSavedPosts();
    const { client } = clientWithGuild("voice-elsewhere");

    await LfgService.getInstance(client as never).createPost(input);

    // Their empty room is the next sweep's; a second channel would also drop
    // the first out of the one-per-owner map.
    expect(saved[saved.length - 1].voiceChannelId).toBeNull();
    expect(createDynamicChannel).not.toHaveBeenCalled();
  });

  it("drops a channel it could not move the host into", async () => {
    configValues.booleans["voicechannels.enabled"] = true;
    VcmMock.getInstance = jest.fn(() => ({
      getUserChannel: jest.fn(() => undefined),
      createDynamicChannel: jest.fn(async () => ({ id: "voice-new" })),
    }));
    const saved = stubSavedPosts();
    const { client } = clientWithGuild(
      "voice-somewhere",
      jest.fn(async () => {
        throw new Error("missing Move Members");
      }) as never,
    );

    const result = await LfgService.getInstance(client as never).createPost(
      input,
    );

    expect(result.status).toBe("created");
    expect(saved[saved.length - 1].voiceChannelId).toBeNull();
  });

  it("posts without a channel when the operator turned the attachment off", async () => {
    configValues.booleans["lfg.voice_channel.enabled"] = false;
    configValues.booleans["voicechannels.enabled"] = true;
    const getInstance = jest.fn();
    VcmMock.getInstance = getInstance;
    const saved = stubSavedPosts();
    const { client } = clientWithGuild();

    await LfgService.getInstance(client as never).createPost(input);

    expect(saved[saved.length - 1].voiceChannelId).toBeNull();
    expect(getInstance).not.toHaveBeenCalled();
  });

  it("still posts when channel creation fails", async () => {
    configValues.booleans["voicechannels.enabled"] = true;
    VcmMock.getInstance = jest.fn(() => ({
      getUserChannel: jest.fn(() => undefined),
      createDynamicChannel: jest.fn(async () => null),
    }));
    const saved = stubSavedPosts();
    const { client } = clientWithGuild();

    const result = await LfgService.getInstance(client as never).createPost(
      input,
    );

    expect(result.status).toBe("created");
    expect(saved[saved.length - 1].voiceChannelId).toBeNull();
  });

  it("does not let a voice-manager failure sink the post", async () => {
    configValues.booleans["voicechannels.enabled"] = true;
    VcmMock.getInstance = jest.fn(() => {
      throw new Error("voice manager is not initialised");
    });
    const saved = stubSavedPosts();

    const { client } = clientWithGuild();
    const result = await LfgService.getInstance(client as never).createPost(
      input,
    );

    expect(result.status).toBe("created");
    expect(saved[saved.length - 1].voiceChannelId).toBeNull();
  });
});

// A post advertises when it closes. The sweep gets there within a minute, but
// a click landing inside that minute — or at any point after, if the feature
// was switched off and the sweep with it — must not be honoured.
describe("expiry is enforced on interactive writes, not just by the sweep", () => {
  const expired = () => post({ expiresAt: new Date(Date.now() - 60 * 1000) });

  it("treats an expired post as closed on join", async () => {
    LfgPostMock.findOneAndUpdate = jest.fn(async () => null);
    LfgPostMock.findById = jest.fn(async () => expired());

    // Not `full`, and not a join that could close it as `full` — closed.
    expect(await buildService().joinPost(POST_ID, "user-2")).toEqual({
      status: "closed",
    });
  });

  it("treats an expired post as closed on leave", async () => {
    LfgPostMock.findOneAndUpdate = jest.fn(async () => null);
    LfgPostMock.findById = jest.fn(async () => expired());

    expect(await buildService().leavePost(POST_ID, "user-2")).toEqual({
      status: "closed",
    });
  });

  it("does not mistake an expired post for one the member merely left", async () => {
    LfgPostMock.findOneAndUpdate = jest.fn(async () => null);
    LfgPostMock.findById = jest.fn(async () =>
      post({ expiresAt: new Date(Date.now() - 1), hostId: "user-2" }),
    );

    // The host branch would otherwise win and tell them to press Close.
    expect(await buildService().leavePost(POST_ID, "user-2")).toEqual({
      status: "closed",
    });
  });
});

describe("isStillOpen", () => {
  it("is true only for an open post inside its window", () => {
    const future = new Date(Date.now() + 1000);
    const past = new Date(Date.now() - 1000);
    expect(isStillOpen({ state: "open", expiresAt: future })).toBe(true);
    expect(isStillOpen({ state: "open", expiresAt: past })).toBe(false);
    expect(isStillOpen({ state: "closed", expiresAt: future })).toBe(false);
  });
});

describe("closedSummary wording", () => {
  it("does not claim nobody joined when some did", () => {
    // An expired post may well have had joiners; it just never filled.
    expect(closedSummary("expired")).not.toMatch(/nobody/i);
    expect(closedSummary("expired")).toMatch(/filled/i);
  });
});

// The cap counts the same posts the buttons will accept. Otherwise a member
// whose post expired seconds ago is refused a new one until the sweep gets
// round to relabelling the dead one.
describe("the cap and the buttons agree on what 'open' means", () => {
  it("does not let an expired post hold its host's slot", async () => {
    const channel = {
      id: "chan-1",
      isTextBased: () => true,
      isDMBased: () => false,
      send: jest.fn(async () => ({ id: "msg-9" })),
    };
    const client = { channels: { fetch: jest.fn(async () => channel) } };
    configValues.numbers["lfg.max_active_per_user"] = 1;
    // Nothing *unexpired* is open, so the count comes back empty and the post
    // is allowed even though a dead row is still sitting there.
    LfgPostMock.countDocuments = jest.fn(async () => 0);
    LfgPostMock.mockImplementation(function (
      this: Record<string, unknown>,
      doc: Record<string, unknown>,
    ) {
      Object.assign(this, doc, { _id: POST_ID, save: jest.fn(async () => {}) });
    } as never);

    const result = await LfgService.getInstance(client as never).createPost({
      guildId: "guild-1",
      hostId: "host-1",
      game: "Valorant",
      note: "",
      partySize: 4,
      fallbackChannelId: "chan-1",
    });

    expect(result.status).toBe("created");
    const filter = LfgPostMock.countDocuments.mock.calls[0][0] as {
      expiresAt: unknown;
    };
    expect(filter.expiresAt).toEqual({ $gt: expect.any(Date) });
  });
});

describe("the sweep works in bounded batches", () => {
  it("takes the oldest due posts first, in a capped batch", async () => {
    const limit = jest.fn(async () => []);
    const sort = jest.fn(() => ({ limit }));
    LfgPostMock.find = jest.fn(() => ({ sort }));
    configValues.booleans["lfg.enabled"] = true;

    await buildService().runNow();

    // Unbounded, a backlog after an outage would hold every row in memory and
    // starve newly due posts, since ticks coalesce.
    expect(sort).toHaveBeenCalledWith({ expiresAt: 1 });
    expect(limit).toHaveBeenCalledWith(100);
    // Oldest attempt first, so a row whose edits keep failing rotates to the
    // back instead of occupying the batch and starving newer posts.
    expect(sort).toHaveBeenCalledWith({ lastRenderAttemptAt: 1 });
  });
});

// `VoiceChannelManager` tracks one dynamic channel per owner, and the check
// for an existing one is not atomic with creating a new one. Where the cap
// allows a second post, two `/lfg` runs by one member could otherwise both
// look while the other was still awaiting Discord and each make a room.
describe("one member's concurrent posts resolve voice one at a time", () => {
  it("lets the second run see the room the first one made", async () => {
    configValues.booleans["voicechannels.enabled"] = true;
    configValues.numbers["lfg.max_active_per_user"] = 0; // no cap
    const owned: { id: string }[] = [];
    const createDynamicChannel = jest.fn(async () => {
      // Creating is slow (a Discord round-trip); the ownership map only
      // updates once it returns.
      await new Promise((resolve) => setTimeout(resolve, 5));
      const channel = { id: "voice-new" };
      owned.push(channel);
      return channel;
    });
    VcmMock.getInstance = jest.fn(() => ({
      getUserChannel: jest.fn(() => owned[0]),
      createDynamicChannel,
    }));

    const channel = {
      id: "chan-1",
      isTextBased: () => true,
      isDMBased: () => false,
      send: jest.fn(async () => ({ id: "msg-9" })),
    };
    const client = {
      channels: { fetch: jest.fn(async () => channel) },
      guilds: {
        fetch: jest.fn(async () => ({
          id: "guild-1",
          members: {
            fetch: jest.fn(async () => ({
              voice: {
                channelId: owned[0]?.id ?? "voice-lobby",
                setChannel: jest.fn(async () => undefined),
              },
            })),
          },
        })),
      },
    };
    LfgPostMock.mockImplementation(function (
      this: Record<string, unknown>,
      doc: Record<string, unknown>,
    ) {
      Object.assign(this, doc, { _id: POST_ID, save: jest.fn(async () => {}) });
    } as never);

    const service = LfgService.getInstance(client as never);
    const input = {
      guildId: "guild-1",
      hostId: "host-1",
      game: "Valorant",
      note: "",
      partySize: 4,
      fallbackChannelId: "chan-1",
    };
    await Promise.all([service.createPost(input), service.createPost(input)]);

    // The second run took its turn after the first, so it adopted the room
    // rather than making a second one for the sweep to delete.
    expect(createDynamicChannel).toHaveBeenCalledTimes(1);
  });
});

// The sweep and the button handlers both read a post, act on it and edit its
// message. Interleaved, the sweep can edit a snapshot that a click has already
// superseded — and worse, clear `renderPending` for it, leaving nothing to
// retry.
describe("the sweep takes the post's turn before rendering", () => {
  it("re-reads the row inside the lock, so it renders what the row says now", async () => {
    const due = post();
    const closed = { ...due, state: "closed" as const, renderPending: true };
    // What a click committed while the sweep's batch query was in flight.
    const newer = { ...closed, memberIds: ["host-1", "late-joiner"] };
    LfgPostMock.find = jest
      .fn<(...args: unknown[]) => unknown>()
      .mockReturnValueOnce({ sort: () => ({ limit: async () => [due] }) })
      .mockReturnValueOnce({ sort: () => ({ limit: async () => [] }) });
    LfgPostMock.findOneAndUpdate = jest.fn(async () => closed);
    LfgPostMock.findById = jest.fn(async () => newer);

    const svc = buildService();
    const render = jest.spyOn(svc, "renderToMessage").mockResolvedValue(true);
    configValues.booleans["lfg.enabled"] = true;

    await svc.runNow();

    // The newer roster, not the snapshot the batch query returned.
    expect(render).toHaveBeenCalledWith(newer);
  });

  it("renders nothing for a row that has since been purged", async () => {
    const due = post();
    LfgPostMock.find = jest
      .fn<(...args: unknown[]) => unknown>()
      .mockReturnValueOnce({ sort: () => ({ limit: async () => [due] }) })
      .mockReturnValueOnce({ sort: () => ({ limit: async () => [] }) });
    LfgPostMock.findOneAndUpdate = jest.fn(async () => ({
      ...due,
      state: "closed" as const,
    }));
    LfgPostMock.findById = jest.fn(async () => null);

    const svc = buildService();
    const render = jest.spyOn(svc, "renderToMessage").mockResolvedValue(true);
    configValues.booleans["lfg.enabled"] = true;

    await svc.runNow();

    expect(render).not.toHaveBeenCalled();
  });

  it("serialises a sweep render against a click on the same post", async () => {
    const order: string[] = [];
    const svc = buildService();
    const held = new Promise<void>((resolve) =>
      setTimeout(() => {
        order.push("click:done");
        resolve();
      }, 10),
    );

    // A click holds the post's turn; the sweep's render has to wait for it.
    const click = svc.runOnPost(POST_ID, () => held);
    const sweep = svc.runOnPost(POST_ID, async () => {
      order.push("sweep:render");
    });

    await Promise.all([click, sweep]);

    expect(order).toEqual(["click:done", "sweep:render"]);
  });
});

// Disabling the feature stops the sweep — that is the base class doing its
// job — but it would otherwise abandon every live post: the buttons start
// refusing at expiry and the TTL removes the row, while the message sits
// there looking open with enabled buttons for good.
describe("turning the feature off closes what is still open", () => {
  /** Fire the reload callbacks the service registered at construction. */
  async function triggerReload(): Promise<void> {
    for (const cb of reloadCallbacks) await cb();
  }

  it("closes and re-renders open posts when LFG is switched off", async () => {
    const open = post();
    const closed = {
      ...open,
      state: "closed" as const,
      closeReason: "disabled" as const,
      renderPending: true,
    };
    const svc = buildService();
    configValues.booleans["lfg.enabled"] = false;
    LfgPostMock.find = jest.fn(() => queryReturning([open]));
    LfgPostMock.findOneAndUpdate = jest.fn(async () => closed);
    LfgPostMock.findById = jest.fn(async () => closed);
    const render = jest.spyOn(svc, "renderToMessage").mockResolvedValue(true);

    await triggerReload();

    expect(LfgPostMock.find).toHaveBeenCalledWith({ state: "open" });
    expect(LfgPostMock.findOneAndUpdate).toHaveBeenCalledWith(
      { _id: POST_ID, state: "open" },
      {
        $set: {
          state: "closed",
          closeReason: "disabled",
          renderPending: true,
        },
      },
      { new: true },
    );
    expect(render).toHaveBeenCalledWith(closed);
  });

  it("does nothing while the feature is still on", async () => {
    buildService();
    configValues.booleans["lfg.enabled"] = true;
    LfgPostMock.find = jest.fn(() => queryReturning([post()]));

    await triggerReload();

    // A reload that merely changed some other setting must not close posts.
    expect(LfgPostMock.findOneAndUpdate).not.toHaveBeenCalled();
  });

  it("says so on the post rather than blaming the host", () => {
    expect(closedSummary("disabled")).toMatch(/switched off/i);
    expect(closedSummary("disabled")).not.toMatch(/host/i);
  });
});

// The row exists before its message does. A sweep or drain that acted on it
// in that window would "successfully" settle a post with no message to edit,
// clear its pending flag, and strand the message that was about to be sent —
// a closed row displayed with live buttons and nothing left to retry.
describe("a post is not live until its message exists", () => {
  function stubChannelClient(send: jest.Mock): unknown {
    const channel = {
      id: "chan-1",
      isTextBased: () => true,
      isDMBased: () => false,
      send,
    };
    return { channels: { fetch: jest.fn(async () => channel) } };
  }

  const input = {
    guildId: "guild-1",
    hostId: "host-1",
    game: "Valorant",
    note: "",
    partySize: 4,
    fallbackChannelId: "chan-1",
  };

  it("reserves the row as `creating`, then promotes it once sent", async () => {
    const saved: Record<string, unknown>[] = [];
    LfgPostMock.mockImplementation(function (
      this: Record<string, unknown>,
      doc: Record<string, unknown>,
    ) {
      Object.assign(this, doc, {
        _id: POST_ID,
        save: jest.fn(async () => {
          saved.push({ ...this });
        }),
      });
    } as never);
    const client = stubChannelClient(jest.fn(async () => ({ id: "msg-9" })));

    await LfgService.getInstance(client as never).createPost(input);

    expect(saved[0].state).toBe("creating");
    expect(saved[0].messageId).toBeUndefined();
    expect(saved[saved.length - 1].state).toBe("open");
    expect(saved[saved.length - 1].messageId).toBe("msg-9");
  });

  it("keeps the expiry sweep off rows that have no message yet", async () => {
    const find = jest
      .fn<(...args: unknown[]) => unknown>()
      .mockReturnValueOnce(queryReturning([]))
      .mockReturnValueOnce(queryReturning([]));
    LfgPostMock.find = find;
    configValues.booleans["lfg.enabled"] = true;

    await buildService().runNow();

    // `creating` is not `open`, so a half-made post is never closed out from
    // under `createPost`.
    expect(find).toHaveBeenNthCalledWith(1, {
      state: "open",
      expiresAt: { $lte: expect.any(Date) },
    });
  });
});

describe("the disable drain keeps going until it is done", () => {
  async function triggerReload(): Promise<void> {
    for (const cb of reloadCallbacks) await cb();
  }

  it("works through more than one batch of open posts", async () => {
    const svc = buildService();
    configValues.booleans["lfg.enabled"] = false;
    const batches = [[post()], [post()], []];
    let call = 0;
    LfgPostMock.find = jest.fn(() => {
      const rows = batches[Math.min(call++, batches.length - 1)] ?? [];
      return queryReturning(rows);
    });
    const closed = { ...post(), state: "closed" as const };
    LfgPostMock.findOneAndUpdate = jest.fn(async () => closed);
    LfgPostMock.findById = jest.fn(async () => closed);
    LfgPostMock.countDocuments = jest.fn(async () => 0);
    jest.spyOn(svc, "renderToMessage").mockResolvedValue(true);

    await triggerReload();

    // One batch was never the whole job: a second pass ran, and a third found
    // nothing and stopped.
    expect(LfgPostMock.findOneAndUpdate).toHaveBeenCalledTimes(2);
  });

  it("stops rather than hammering a batch where every edit fails", async () => {
    const svc = buildService();
    configValues.booleans["lfg.enabled"] = false;
    const stuck = post({ state: "closed", renderPending: true });
    LfgPostMock.find = jest.fn((filter: unknown) =>
      queryReturning(
        (filter as { renderPending?: boolean }).renderPending ? [stuck] : [],
      ),
    );
    LfgPostMock.findById = jest.fn(async () => stuck);
    LfgPostMock.countDocuments = jest.fn(async () => 1);
    const render = jest.spyOn(svc, "renderToMessage").mockResolvedValue(false);

    await triggerReload();

    // One pass, not ten: nothing is getting through, so retrying the same
    // batch nine more times inside a config reload helps nobody.
    expect(render).toHaveBeenCalledTimes(1);
  });
});
