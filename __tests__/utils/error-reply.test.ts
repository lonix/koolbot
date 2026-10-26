import { describe, it, expect, beforeEach, jest } from "@jest/globals";
import { MessageFlags } from "discord.js";

const mockLoggerError = jest.fn();
jest.unstable_mockModule("../../src/utils/logger.js", () => ({
  default: {
    info: jest.fn(),
    warn: jest.fn(),
    error: mockLoggerError,
    debug: jest.fn(),
  },
}));

const {
  errorEmbed,
  replyWithError,
  replyWithUnexpectedError,
  UNEXPECTED_ERROR,
  afterWrite,
  replyAfterWriteError,
} = await import("../../src/utils/error-reply.js");
const { embedColor } = await import("../../src/utils/embed-style.js");

type MockInteraction = {
  id: string;
  replied: boolean;
  deferred: boolean;
  reply: jest.Mock;
  editReply: jest.Mock;
  followUp: jest.Mock;
};

function makeInteraction(
  state: { replied?: boolean; deferred?: boolean } = {},
): MockInteraction {
  return {
    id: "interaction-1",
    replied: state.replied ?? false,
    deferred: state.deferred ?? false,
    reply: jest.fn<() => Promise<void>>().mockResolvedValue(undefined),
    editReply: jest.fn<() => Promise<void>>().mockResolvedValue(undefined),
    followUp: jest.fn<() => Promise<void>>().mockResolvedValue(undefined),
  };
}

const MESSAGE = {
  title: "Couldn't post your LFG",
  next: "Check that I can send messages in the LFG channel, then try again.",
};

describe("errorEmbed", () => {
  it("is an embed-danger embed with the title and the next step", () => {
    const json = errorEmbed(MESSAGE).toJSON();

    expect(json.color).toBe(embedColor("danger"));
    expect(json.title).toBe(MESSAGE.title);
    expect(json.description).toBe(MESSAGE.next);
    expect(json.footer).toBeUndefined();
  });

  it("clips a title or description past Discord's limits instead of failing the reply", () => {
    const json = errorEmbed({
      title: "t".repeat(300),
      next: "n".repeat(5000),
    }).toJSON();

    expect(json.title).toHaveLength(256);
    expect(json.description).toHaveLength(4096);
    expect(json.title?.endsWith("…")).toBe(true);
  });
});

describe("replyWithError", () => {
  beforeEach(() => {
    mockLoggerError.mockClear();
  });

  it("replies ephemerally when nothing was acknowledged yet", async () => {
    const interaction = makeInteraction();

    await expect(replyWithError(interaction as never, MESSAGE)).resolves.toBe(
      true,
    );

    expect(interaction.reply).toHaveBeenCalledTimes(1);
    const payload = interaction.reply.mock.calls[0][0] as {
      flags: number;
      embeds: { toJSON(): { title: string } }[];
    };
    expect(payload.flags).toBe(MessageFlags.Ephemeral);
    expect(payload.embeds).toHaveLength(1);
    expect(payload.embeds[0].toJSON().title).toBe(MESSAGE.title);
    expect(interaction.editReply).not.toHaveBeenCalled();
    expect(interaction.followUp).not.toHaveBeenCalled();
  });

  it("edits the deferred response and adds no ephemeral flag the edit would reject", async () => {
    const interaction = makeInteraction({ deferred: true });

    await expect(replyWithError(interaction as never, MESSAGE)).resolves.toBe(
      true,
    );

    expect(interaction.editReply).toHaveBeenCalledTimes(1);
    const payload = interaction.editReply.mock.calls[0][0] as Record<
      string,
      unknown
    >;
    expect(payload).not.toHaveProperty("flags");
    expect(payload).not.toHaveProperty("ephemeral");
    // An error replaces a panel: old text and buttons do not stay under it.
    expect(payload.content).toBe("");
    expect(payload.components).toEqual([]);
    expect(payload.embeds).toHaveLength(1);
    expect(interaction.reply).not.toHaveBeenCalled();
  });

  it("follows up once the interaction has been replied to", async () => {
    const interaction = makeInteraction({ replied: true });

    await replyWithError(interaction as never, MESSAGE);

    expect(interaction.followUp).toHaveBeenCalledTimes(1);
    expect(
      (interaction.followUp.mock.calls[0][0] as { flags: number }).flags,
    ).toBe(MessageFlags.Ephemeral);
    expect(interaction.editReply).not.toHaveBeenCalled();
    expect(interaction.reply).not.toHaveBeenCalled();
  });

  it("whenDeferred: followUp sends an ephemeral follow-up and leaves the deferred message alone", async () => {
    // A component that called deferUpdate() on a public message.
    const interaction = makeInteraction({ deferred: true });

    await replyWithError(interaction as never, {
      ...MESSAGE,
      whenDeferred: "followUp",
    });

    expect(interaction.followUp).toHaveBeenCalledTimes(1);
    expect(
      (interaction.followUp.mock.calls[0][0] as { flags: number }).flags,
    ).toBe(MessageFlags.Ephemeral);
    expect(interaction.editReply).not.toHaveBeenCalled();
  });

  it("whenDeferred: edit is the default and can be asked for", async () => {
    const interaction = makeInteraction({ deferred: true });

    await replyWithError(interaction as never, {
      ...MESSAGE,
      whenDeferred: "edit",
    });

    expect(interaction.editReply).toHaveBeenCalledTimes(1);
    expect(interaction.followUp).not.toHaveBeenCalled();
  });

  it("whenDeferred does nothing on a fresh interaction", async () => {
    const interaction = makeInteraction();

    await replyWithError(interaction as never, {
      ...MESSAGE,
      whenDeferred: "followUp",
    });

    expect(interaction.reply).toHaveBeenCalledTimes(1);
    expect(interaction.followUp).not.toHaveBeenCalled();
  });

  it.each([
    ["fresh", {}, "reply"],
    ["deferred", { deferred: true }, "editReply"],
    ["replied", { replied: true }, "followUp"],
  ] as const)(
    "never throws when delivery fails (%s)",
    async (_name, state, method) => {
      const interaction = makeInteraction(state);
      interaction[method].mockRejectedValue(
        new Error("Unknown interaction") as never,
      );

      await expect(replyWithError(interaction as never, MESSAGE)).resolves.toBe(
        false,
      );
      expect(mockLoggerError).toHaveBeenCalledTimes(1);
    },
  );
});

describe("replyWithUnexpectedError", () => {
  beforeEach(() => {
    mockLoggerError.mockClear();
  });

  it("sends the one shared generic message", async () => {
    const interaction = makeInteraction();

    await replyWithUnexpectedError(interaction as never);

    const payload = interaction.reply.mock.calls[0][0] as {
      embeds: { toJSON(): { title: string; description: string } }[];
    };
    const json = payload.embeds[0].toJSON();
    expect(json.title).toBe("Something went wrong");
    expect(json.description).toBe(UNEXPECTED_ERROR.next);
    expect(json.description).toContain("tell an admin");
  });

  it("passes the component option through", async () => {
    const interaction = makeInteraction({ deferred: true });

    await replyWithUnexpectedError(interaction as never, {
      whenDeferred: "followUp",
    });

    expect(interaction.followUp).toHaveBeenCalledTimes(1);
    expect(interaction.editReply).not.toHaveBeenCalled();
  });

  it("never throws", async () => {
    const interaction = makeInteraction();
    interaction.reply.mockRejectedValue(new Error("10062") as never);

    await expect(replyWithUnexpectedError(interaction as never)).resolves.toBe(
      false,
    );
  });
});

describe("afterWrite", () => {
  const info = { done: "Your reminder was saved", check: "`/remind list`" };

  beforeEach(() => {
    mockLoggerError.mockClear();
  });

  it("runs the step and sends nothing when it succeeds", async () => {
    const interaction = makeInteraction({ deferred: true });
    const step = jest.fn<() => Promise<void>>().mockResolvedValue(undefined);

    await afterWrite(interaction as never, info, step);

    expect(step).toHaveBeenCalledTimes(1);
    expect(interaction.editReply).not.toHaveBeenCalled();
  });

  it("answers a failed step with the done title, where to check, and no retry advice", async () => {
    const interaction = makeInteraction({ deferred: true });

    await afterWrite(interaction as never, info, async () => {
      throw new Error("Unknown interaction");
    });

    const payload = interaction.editReply.mock.calls[0][0] as {
      embeds: { toJSON(): { title: string; description: string } }[];
    };
    const json = payload.embeds[0].toJSON();
    expect(json.title).toBe("Your reminder was saved");
    expect(json.description).toContain("`/remind list`");
    expect(json.description).toContain("before doing this again");
    expect(JSON.stringify(json)).not.toMatch(/try again/i);
    expect(mockLoggerError).toHaveBeenCalledTimes(1);
  });

  it("never throws, even when the error reply fails for the same reason", async () => {
    const interaction = makeInteraction({ deferred: true });
    interaction.editReply.mockRejectedValue(new Error("10062") as never);

    await expect(
      afterWrite(interaction as never, info, async () => {
        throw new Error("10062");
      }),
    ).resolves.toBeUndefined();
    // One log for the failed step, one for the failed error reply.
    expect(mockLoggerError).toHaveBeenCalledTimes(2);
  });

  it("replyAfterWriteError passes whenDeferred through", async () => {
    const interaction = makeInteraction({ deferred: true });

    await replyAfterWriteError(interaction as never, info, {
      whenDeferred: "followUp",
    });

    expect(interaction.followUp).toHaveBeenCalledTimes(1);
    expect(interaction.editReply).not.toHaveBeenCalled();
  });
});
