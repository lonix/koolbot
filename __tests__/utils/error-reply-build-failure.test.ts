import { describe, it, expect, jest } from "@jest/globals";

const mockLoggerError = jest.fn();
jest.unstable_mockModule("../../src/utils/logger.js", () => ({
  default: {
    info: jest.fn(),
    warn: jest.fn(),
    error: mockLoggerError,
    debug: jest.fn(),
  },
}));
// Design-token loading fails (missing or malformed tokens.json).
jest.unstable_mockModule("../../src/utils/embed-style.js", () => ({
  embedColor: (): number => {
    throw new Error("tokens.json is missing");
  },
}));

const { replyWithError, replyWithUnexpectedError } =
  await import("../../src/utils/error-reply.js");

function makeInteraction(): {
  id: string;
  replied: boolean;
  deferred: boolean;
  reply: jest.Mock;
  editReply: jest.Mock;
  followUp: jest.Mock;
} {
  return {
    id: "interaction-1",
    replied: false,
    deferred: false,
    reply: jest.fn(),
    editReply: jest.fn(),
    followUp: jest.fn(),
  };
}

// The helpers promise never to throw, including when the embed cannot be built:
// the dispatcher calls them from its last catch block.
describe("error reply when the embed cannot be built", () => {
  it("replyWithError resolves false, logs and sends nothing", async () => {
    mockLoggerError.mockClear();
    const interaction = makeInteraction();

    await expect(
      replyWithError(interaction as never, { title: "t", next: "n" }),
    ).resolves.toBe(false);

    expect(mockLoggerError).toHaveBeenCalledTimes(1);
    expect(String(mockLoggerError.mock.calls[0][0])).toContain(
      "tokens.json is missing",
    );
    expect(interaction.reply).not.toHaveBeenCalled();
  });

  it("replyWithUnexpectedError resolves false and logs", async () => {
    mockLoggerError.mockClear();
    const interaction = makeInteraction();

    await expect(replyWithUnexpectedError(interaction as never)).resolves.toBe(
      false,
    );

    expect(mockLoggerError).toHaveBeenCalledTimes(1);
    expect(interaction.reply).not.toHaveBeenCalled();
  });
});
