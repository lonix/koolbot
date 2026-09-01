import { describe, it, expect, beforeEach, jest } from "@jest/globals";

const mockLoggerError = jest.fn();
jest.unstable_mockModule("../../src/utils/logger.js", () => ({
  default: {
    info: jest.fn(),
    warn: jest.fn(),
    error: mockLoggerError,
    debug: jest.fn(),
  },
}));

const { safeReply } = await import("../../src/utils/safe-reply.js");

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

// `safeReply` is the mitigation for issue #837: an unguarded `reply` inside an
// error handler rejected on a dead interaction, and because discord.js does
// not await listener promises that rejection took the whole process down.
describe("safeReply", () => {
  beforeEach(() => {
    mockLoggerError.mockClear();
  });

  it("uses reply() on a fresh interaction", async () => {
    const interaction = makeInteraction();

    const delivered = await safeReply(interaction as never, {
      content: "boom",
      ephemeral: true,
    });

    expect(delivered).toBe(true);
    expect(interaction.reply).toHaveBeenCalledWith({
      content: "boom",
      ephemeral: true,
    });
    expect(interaction.editReply).not.toHaveBeenCalled();
    expect(interaction.followUp).not.toHaveBeenCalled();
  });

  it("uses editReply() on a deferred interaction", async () => {
    const interaction = makeInteraction({ deferred: true });

    const delivered = await safeReply(interaction as never, {
      content: "boom",
    });

    expect(delivered).toBe(true);
    expect(interaction.editReply).toHaveBeenCalledWith({ content: "boom" });
    expect(interaction.reply).not.toHaveBeenCalled();
  });

  it("strips reply-only fields that editReply rejects", async () => {
    const interaction = makeInteraction({ deferred: true });

    await safeReply(interaction as never, {
      content: "boom",
      ephemeral: true,
      tts: false,
      withResponse: true,
      fetchReply: true,
    });

    expect(interaction.editReply).toHaveBeenCalledWith({ content: "boom" });
  });

  it("uses followUp() once the interaction has been replied to", async () => {
    const interaction = makeInteraction({ replied: true });

    const delivered = await safeReply(interaction as never, {
      content: "boom",
      ephemeral: true,
    });

    expect(delivered).toBe(true);
    expect(interaction.followUp).toHaveBeenCalledWith({
      content: "boom",
      ephemeral: true,
    });
    expect(interaction.reply).not.toHaveBeenCalled();
  });

  it("prefers followUp() when an interaction is both deferred and replied", async () => {
    // `deferReply()` then `editReply()` leaves both flags set; a second
    // `editReply` would silently overwrite the response the user already saw.
    const interaction = makeInteraction({ replied: true, deferred: true });

    await safeReply(interaction as never, { content: "boom" });

    expect(interaction.followUp).toHaveBeenCalledTimes(1);
    expect(interaction.editReply).not.toHaveBeenCalled();
  });

  it("swallows a rejected reply instead of letting it escape", async () => {
    const interaction = makeInteraction();
    interaction.reply.mockRejectedValue(
      new Error("Unknown interaction") as never,
    );

    await expect(
      safeReply(interaction as never, { content: "boom" }),
    ).resolves.toBe(false);
    expect(mockLoggerError).toHaveBeenCalledTimes(1);
    expect(String(mockLoggerError.mock.calls[0][0])).toContain(
      "Unknown interaction",
    );
  });

  it("swallows a rejected editReply and followUp too", async () => {
    const deferred = makeInteraction({ deferred: true });
    deferred.editReply.mockRejectedValue(new Error("10062") as never);
    await expect(
      safeReply(deferred as never, { content: "boom" }),
    ).resolves.toBe(false);

    const replied = makeInteraction({ replied: true });
    replied.followUp.mockRejectedValue(new Error("10062") as never);
    await expect(
      safeReply(replied as never, { content: "boom" }),
    ).resolves.toBe(false);
  });

  it("swallows a non-Error rejection", async () => {
    const interaction = makeInteraction();
    interaction.reply.mockRejectedValue("string failure" as never);

    await expect(
      safeReply(interaction as never, { content: "boom" }),
    ).resolves.toBe(false);
    expect(String(mockLoggerError.mock.calls[0][0])).toContain(
      "string failure",
    );
  });
});
