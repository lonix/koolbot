import { describe, it, expect, jest, beforeEach } from "@jest/globals";

jest.unstable_mockModule("../../src/utils/logger.js", () => ({
  isDebugMode: () => false,
  default: {
    info: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
    debug: jest.fn(),
  },
}));

const { repostManagedMessage, describeRepost, sendFailureText } =
  await import("../../src/services/managed-message-repost.js");

const discordError = (code: number): Error =>
  Object.assign(new Error(`Discord ${code}`), { code });

function setup(
  opts: {
    oldId?: string;
    fetchImpl?: () => Promise<unknown>;
    sendImpl?: () => Promise<unknown>;
    storeImpl?: () => Promise<void>;
    oldDeleteImpl?: () => Promise<unknown>;
    oldAuthor?: string;
    newDeleteImpl?: () => Promise<unknown>;
  } = {},
) {
  const calls: string[] = [];
  const oldMessage = {
    id: "old1",
    author: { id: opts.oldAuthor ?? "bot" },
    delete: jest.fn(async () => {
      calls.push("delete-old");
      return opts.oldDeleteImpl ? opts.oldDeleteImpl() : undefined;
    }),
  };
  const newMessage = {
    id: "new1",
    delete: jest.fn(async () => {
      calls.push("delete-new");
      if (opts.newDeleteImpl) await opts.newDeleteImpl();
    }),
  };
  const params = {
    channel: {
      id: "c1",
      name: "quotes",
      messages: {
        fetch: jest.fn(async () =>
          opts.fetchImpl ? opts.fetchImpl() : oldMessage,
        ),
      },
    },
    botUserId: "bot",
    oldId: opts.oldId ?? "old1",
    send: jest.fn(async () => {
      calls.push("send");
      return opts.sendImpl ? opts.sendImpl() : newMessage;
    }),
    store: jest.fn(async (id: string) => {
      void id;
      calls.push("store");
      if (opts.storeImpl) await opts.storeImpl();
    }),
    label: "test message",
  } as any;
  return { params, calls, oldMessage, newMessage };
}

describe("repostManagedMessage", () => {
  beforeEach(() => jest.clearAllMocks());

  it("sends the new message, stores its id, then deletes the old one", async () => {
    const { params, calls } = setup();
    const result = await repostManagedMessage(params);
    expect(result).toEqual({
      ok: true,
      messageId: "new1",
      oldMessageId: "old1",
      old: "deleted",
    });
    expect(calls).toEqual(["send", "store", "delete-old"]);
    expect(params.store).toHaveBeenCalledWith("new1");
  });

  it("treats an old message that is already gone as done", async () => {
    const { params, oldMessage } = setup({
      fetchImpl: async () => {
        throw discordError(10008);
      },
    });
    const result = await repostManagedMessage(params);
    expect(result).toMatchObject({ ok: true, old: "not-found" });
    expect(oldMessage.delete).not.toHaveBeenCalled();
  });

  it("treats an old message deleted between lookup and delete as gone", async () => {
    const { params } = setup({
      oldDeleteImpl: async () => {
        throw discordError(10008);
      },
    });
    expect(await repostManagedMessage(params)).toMatchObject({
      ok: true,
      old: "not-found",
    });
  });

  it("posts and stores without a lookup when no id was stored", async () => {
    const { params } = setup({ oldId: "" });
    const result = await repostManagedMessage(params);
    expect(result).toMatchObject({ ok: true, old: "none", oldMessageId: null });
    expect(params.channel.messages.fetch).not.toHaveBeenCalled();
  });

  it("changes nothing and names the permissions when the bot may not post", async () => {
    const { params, oldMessage } = setup({
      sendImpl: async () => {
        throw discordError(50013);
      },
    });
    const result = await repostManagedMessage(params);
    expect(result).toMatchObject({ ok: false, reason: "no-permission" });
    expect((result as { error: string }).error).toContain("#quotes");
    expect((result as { error: string }).error).toContain("Send Messages");
    expect(params.store).not.toHaveBeenCalled();
    expect(oldMessage.delete).not.toHaveBeenCalled();
  });

  it("reports a missing channel without storing anything", async () => {
    const { params } = setup({
      sendImpl: async () => {
        throw discordError(10003);
      },
    });
    const result = await repostManagedMessage(params);
    expect(result).toMatchObject({ ok: false, reason: "failed" });
    expect(params.store).not.toHaveBeenCalled();
  });

  it("takes the new message down and keeps the old one when the id can't be saved", async () => {
    const { params, calls, oldMessage } = setup({
      storeImpl: async () => {
        throw new Error("mongo down");
      },
    });
    const result = await repostManagedMessage(params);
    expect(result).toMatchObject({ ok: false, reason: "not-saved" });
    expect(calls).toEqual(["send", "store", "delete-new"]);
    expect(oldMessage.delete).not.toHaveBeenCalled();
  });

  it("treats a new message that is already gone as taken down", async () => {
    const { params } = setup({
      storeImpl: async () => {
        throw new Error("mongo down");
      },
      newDeleteImpl: async () => {
        throw discordError(10008);
      },
    });
    const result = await repostManagedMessage(params);
    expect(result).toMatchObject({ ok: false, reason: "not-saved" });
    expect((result as { error: string }).error).toContain("taken down again");
  });

  it("names the new message for manual cleanup, and does not invite a blind retry, when it can't be taken down", async () => {
    const { params } = setup({
      storeImpl: async () => {
        throw new Error("mongo down");
      },
      newDeleteImpl: async () => {
        throw discordError(50013);
      },
    });
    const result = await repostManagedMessage(params);
    expect(result).toMatchObject({ ok: false, reason: "not-saved" });
    const text = (result as { error: string }).error;
    expect(text).not.toContain("was taken down again");
    expect(text).toContain("new1");
    expect(text).toContain("#quotes");
    expect(text).toContain("by hand");
    expect(text).toContain("only then try again");
  });

  it("never deletes a message the bot did not write", async () => {
    const { params, oldMessage } = setup({ oldAuthor: "someone-else" });
    expect(await repostManagedMessage(params)).toMatchObject({
      ok: true,
      old: "not-ours",
    });
    expect(oldMessage.delete).not.toHaveBeenCalled();
  });

  it("reports an old message it could not delete, without throwing", async () => {
    const { params } = setup({
      oldDeleteImpl: async () => {
        throw discordError(50013);
      },
    });
    const result = await repostManagedMessage(params);
    expect(result).toMatchObject({ ok: true, old: "delete-failed" });
    const flash = describeRepost(result as any, "The header");
    expect(flash.type).toBe("warn");
    expect(flash.text).toContain("old1");
  });

  it("reports an old message it could not look up", async () => {
    const { params } = setup({
      fetchImpl: async () => {
        throw discordError(50001);
      },
    });
    expect(await repostManagedMessage(params)).toMatchObject({
      ok: true,
      old: "lookup-failed",
    });
  });
});

describe("describeRepost and sendFailureText", () => {
  it("is a plain success only when the old message is gone", () => {
    const base = { ok: true as const, messageId: "n", oldMessageId: "o" };
    expect(describeRepost({ ...base, old: "deleted" }, "X").type).toBe("ok");
    expect(describeRepost({ ...base, old: "none" }, "X").type).toBe("ok");
    for (const old of [
      "not-found",
      "not-ours",
      "delete-failed",
      "lookup-failed",
    ] as const) {
      expect(describeRepost({ ...base, old }, "X").type).toBe("warn");
    }
  });

  it("explains a wrong-channel old message", () => {
    const flash = describeRepost(
      { ok: true, messageId: "n", oldMessageId: "o", old: "not-found" },
      "The header",
    );
    expect(flash.text).toContain("channel it was posted in before");
  });

  it("neutralises a channel name that carries mentions or Markdown", () => {
    const text = sendFailureText(
      discordError(50013),
      "@everyone <@123> **bold** [x](http://e)",
    );
    expect(text).not.toContain("@everyone");
    expect(text).not.toContain("<@123>");
    expect(text).not.toContain("**bold**");
    expect(text).toContain("@\u200beveryone");
    expect(text).toContain("\\<@123\\>");
  });

  it("falls back to a generic channel name", () => {
    expect(sendFailureText(discordError(50001))).toContain("the channel");
  });
});
