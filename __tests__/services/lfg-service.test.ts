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

jest.unstable_mockModule("../../src/services/config-service.js", () => ({
  ConfigService: {
    getInstance: jest.fn(() => ({
      registerReloadCallback: jest.fn(),
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
    expiresAt: new Date("2026-07-04T21:00:00Z"),
    ...overrides,
  };
}

/** Shared stand-in client: `getInstance` rejects a second, different one. */
const CLIENT = {} as never;

function buildService(): InstanceType<typeof LfgService> {
  return LfgService.getInstance(CLIENT);
}

beforeEach(() => {
  LfgService.reset();
  configValues.booleans = {};
  configValues.strings = {};
  configValues.numbers = {};
  LfgPostMock.find = jest.fn(async () => []);
  LfgPostMock.findById = jest.fn(async () => null);
  LfgPostMock.findOneAndUpdate = jest.fn(async () => null);
  LfgPostMock.countDocuments = jest.fn(async () => 0);
  LfgPostMock.deleteMany = jest.fn(async () => ({ deletedCount: 0 }));
  LfgPostMock.deleteOne = jest.fn(async () => ({ deletedCount: 1 }));
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
// two of them both see the last free slot (lost update).
describe("joinPost", () => {
  it("pushes the member with every precondition in the filter", async () => {
    const updated = post({ memberIds: ["host-1", "user-2"] });
    LfgPostMock.findOneAndUpdate = jest.fn(async () => updated);

    const result = await buildService().joinPost(POST_ID, "user-2");

    expect(result).toEqual({ status: "joined", post: updated, filled: false });
    expect(LfgPostMock.findOneAndUpdate).toHaveBeenCalledTimes(1);
    expect(LfgPostMock.findOneAndUpdate).toHaveBeenCalledWith(
      {
        _id: POST_ID,
        state: "open",
        memberIds: { $ne: "user-2" },
        $expr: { $lt: [{ $size: "$memberIds" }, "$partySize"] },
      },
      { $push: { memberIds: "user-2" } },
      { new: true },
    );
  });

  it("closes the post as `full` when the join completes the party", async () => {
    const filled = post({ memberIds: ["host-1", "user-2"], partySize: 2 });
    const closed = {
      ...filled,
      state: "closed" as const,
      closeReason: "full" as const,
    };
    LfgPostMock.findOneAndUpdate = jest
      .fn<(...args: unknown[]) => Promise<unknown>>()
      .mockResolvedValueOnce(filled)
      .mockResolvedValueOnce(closed);

    const result = await buildService().joinPost(POST_ID, "user-2");

    expect(result).toEqual({ status: "joined", post: closed, filled: true });
    // Second call is the close: a compare-and-set on the open state.
    expect(LfgPostMock.findOneAndUpdate).toHaveBeenNthCalledWith(
      2,
      { _id: POST_ID, state: "open" },
      { $set: { state: "closed", closeReason: "full" } },
      { new: true },
    );
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
        hostId: { $ne: "user-2" },
        memberIds: "user-2",
      },
      { $pull: { memberIds: "user-2" } },
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
      { $set: { state: "closed", closeReason: "cancelled" } },
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
  it("closes due posts, re-renders them, and ages out closed rows", async () => {
    const due = post();
    LfgPostMock.find = jest.fn(async () => [due]);
    const closed = {
      ...due,
      state: "closed" as const,
      closeReason: "expired" as const,
    };
    LfgPostMock.findOneAndUpdate = jest.fn(async () => closed);
    LfgPostMock.deleteMany = jest.fn(async () => ({ deletedCount: 3 }));

    const svc = buildService();
    const render = jest
      .spyOn(svc, "renderToMessage")
      .mockResolvedValue(undefined);
    configValues.booleans["lfg.enabled"] = true;

    const summary = await svc.runNow();

    expect(summary).toEqual({ expired: 1, purged: 3 });
    expect(render).toHaveBeenCalledWith(closed);
    expect(LfgPostMock.find).toHaveBeenCalledWith({
      state: "open",
      expiresAt: { $lte: expect.any(Date) },
    });
  });

  it("does not count a post another closer already took", async () => {
    LfgPostMock.find = jest.fn(async () => [post()]);
    LfgPostMock.findOneAndUpdate = jest.fn(async () => null);

    const svc = buildService();
    const render = jest
      .spyOn(svc, "renderToMessage")
      .mockResolvedValue(undefined);
    configValues.booleans["lfg.enabled"] = true;

    expect(await svc.runNow()).toEqual({ expired: 0, purged: 0 });
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

  it("refuses once the member is at their open-post cap", async () => {
    const { client } = stubChannel(jest.fn() as never);
    configValues.numbers["lfg.max_active_per_user"] = 2;
    LfgPostMock.countDocuments = jest.fn(async () => 2);

    const result = await LfgService.getInstance(client as never).createPost(
      input,
    );

    expect(result).toEqual({ status: "at_limit", limit: 2 });
    expect(LfgPostMock.countDocuments).toHaveBeenCalledWith({
      guildId: "guild-1",
      hostId: "host-1",
      state: "open",
    });
  });

  it("treats a cap of 0 as no cap", async () => {
    const send = jest.fn(async () => ({ id: "msg-9" }));
    const { client } = stubChannel(send as never);
    configValues.numbers["lfg.max_active_per_user"] = 0;
    LfgPostMock.mockImplementation(function (
      this: Record<string, unknown>,
      doc: Record<string, unknown>,
    ) {
      Object.assign(this, doc, { _id: POST_ID, save: jest.fn(async () => {}) });
    } as never);

    const result = await LfgService.getInstance(client as never).createPost(
      input,
    );

    expect(result.status).toBe("created");
    expect(LfgPostMock.countDocuments).not.toHaveBeenCalled();
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
    configValues.booleans["voicechannels.enabled"] = true;
    const createDynamicChannel = jest.fn();
    VcmMock.getInstance = jest.fn(() => ({
      getUserChannel: jest.fn(() => ({ id: "voice-existing" })),
      createDynamicChannel,
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

    expect(saved[0].voiceChannelId).toBe("voice-existing");
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

    expect(saved[0].voiceChannelId).toBeNull();
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

  it("edits the post in place", async () => {
    const edit = jest.fn(async () => undefined);
    const service = LfgService.getInstance(
      clientWithMessage(edit as never) as never,
    );

    await service.renderToMessage(post({ state: "closed" }) as never);

    expect(edit).toHaveBeenCalledTimes(1);
  });

  it("does nothing for a post whose message was never sent", async () => {
    const edit = jest.fn(async () => undefined);
    const client = clientWithMessage(edit as never);
    const service = LfgService.getInstance(client as never);

    await service.renderToMessage(post({ messageId: null }) as never);

    expect(client.channels.fetch).not.toHaveBeenCalled();
  });

  it("swallows a message that has been deleted", async () => {
    const gone = Object.assign(Object.create(DiscordAPIError.prototype), {
      code: 10008,
    });
    const fetch = jest.fn(async () => {
      throw gone;
    });
    const service = LfgService.getInstance(
      clientWithMessage(jest.fn() as never, fetch as never) as never,
    );

    await expect(
      service.renderToMessage(post() as never),
    ).resolves.toBeUndefined();
  });

  it("swallows any other Discord failure rather than killing the sweep", async () => {
    const fetch = jest.fn(async () => {
      throw new Error("gateway exploded");
    });
    const service = LfgService.getInstance(
      clientWithMessage(jest.fn() as never, fetch as never) as never,
    );

    await expect(
      service.renderToMessage(post() as never),
    ).resolves.toBeUndefined();
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

  function clientWithGuild(): unknown {
    const channel = {
      id: "chan-1",
      isTextBased: () => true,
      isDMBased: () => false,
      send: jest.fn(async () => ({ id: "msg-9" })),
    };
    return {
      channels: { fetch: jest.fn(async () => channel) },
      guilds: { fetch: jest.fn(async () => ({ id: "guild-1" })) },
    };
  }

  it("names the channel with the server's managed-channel prefix", async () => {
    configValues.booleans["voicechannels.enabled"] = true;
    configValues.strings["voicechannels.channel.prefix"] = "🎮";
    const createDynamicChannel = jest.fn(async () => ({ id: "voice-new" }));
    VcmMock.getInstance = jest.fn(() => ({
      getUserChannel: jest.fn(() => undefined),
      createDynamicChannel,
    }));
    const saved = stubSavedPosts();

    await LfgService.getInstance(clientWithGuild() as never).createPost(input);

    expect(createDynamicChannel).toHaveBeenCalledWith(
      { id: "guild-1" },
      "host-1",
      "🎮 Deep Rock Galactic",
    );
    expect(saved[0].voiceChannelId).toBe("voice-new");
  });

  it("posts without a channel when the operator turned the attachment off", async () => {
    configValues.booleans["lfg.voice_channel.enabled"] = false;
    configValues.booleans["voicechannels.enabled"] = true;
    const getInstance = jest.fn();
    VcmMock.getInstance = getInstance;
    const saved = stubSavedPosts();

    await LfgService.getInstance(clientWithGuild() as never).createPost(input);

    expect(saved[0].voiceChannelId).toBeNull();
    expect(getInstance).not.toHaveBeenCalled();
  });

  it("still posts when channel creation fails", async () => {
    configValues.booleans["voicechannels.enabled"] = true;
    VcmMock.getInstance = jest.fn(() => ({
      getUserChannel: jest.fn(() => undefined),
      createDynamicChannel: jest.fn(async () => null),
    }));
    const saved = stubSavedPosts();

    const result = await LfgService.getInstance(
      clientWithGuild() as never,
    ).createPost(input);

    expect(result.status).toBe("created");
    expect(saved[0].voiceChannelId).toBeNull();
  });

  it("does not let a voice-manager failure sink the post", async () => {
    configValues.booleans["voicechannels.enabled"] = true;
    VcmMock.getInstance = jest.fn(() => {
      throw new Error("voice manager is not initialised");
    });
    const saved = stubSavedPosts();

    const result = await LfgService.getInstance(
      clientWithGuild() as never,
    ).createPost(input);

    expect(result.status).toBe("created");
    expect(saved[0].voiceChannelId).toBeNull();
  });
});
