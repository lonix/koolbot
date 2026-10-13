import { describe, it, expect, jest, beforeEach } from "@jest/globals";
import type { ChatInputCommandInteraction } from "discord.js";

const mockCreate = jest.fn();
const mockGetString = jest.fn();

jest.unstable_mockModule("../../src/services/web-session-service.js", () => ({
  WebSessionService: { getInstance: () => ({ create: mockCreate }) },
}));
jest.unstable_mockModule("../../src/services/config-service.js", () => ({
  ConfigService: { getInstance: () => ({ getString: mockGetString }) },
}));
jest.unstable_mockModule("../../src/web/index.js", () => ({
  isWebUIEnabled: () => true,
  validateWebUIEnvVars: () => [],
}));
const mockLogger = {
  info: jest.fn(),
  warn: jest.fn(),
  error: jest.fn(),
  debug: jest.fn(),
};
jest.unstable_mockModule("../../src/utils/logger.js", () => ({
  default: mockLogger,
}));

const { runWebSignin } =
  await import("../../src/services/web-signin-launcher.js");

describe("runWebSignin link delivery", () => {
  const opts = {
    commandName: "me",
    role: "user" as const,
    buildDmBody: (url: string) => `link ${url}`,
  };

  function build(sendImpl: () => Promise<unknown>) {
    const editReply = jest.fn().mockResolvedValue(undefined as never);
    const send = jest.fn(sendImpl);
    const interaction = {
      deferred: false,
      replied: false,
      guildId: "g1",
      user: { id: "u1", send },
      deferReply: jest.fn().mockImplementation(async () => {
        interaction.deferred = true;
      }),
      editReply,
    };
    return {
      interaction: interaction as unknown as ChatInputCommandInteraction,
      editReply,
      send,
    };
  }

  beforeEach(() => {
    jest.clearAllMocks();
    mockCreate.mockResolvedValue({
      url: "https://x.test/s/tok",
      expiresAt: new Date(Date.now() + 600_000),
    });
  });

  it("DMs the link in dm mode", async () => {
    mockGetString.mockResolvedValue("dm");
    const { interaction, editReply, send } = build(async () => undefined);
    await runWebSignin(interaction, opts);
    expect(send).toHaveBeenCalledWith("link https://x.test/s/tok");
    expect(editReply.mock.calls[0][0]).toEqual({
      content: expect.stringContaining("DMed"),
    });
  });

  it("replies ephemerally without a DM in ephemeral mode", async () => {
    mockGetString.mockResolvedValue("ephemeral");
    const { interaction, editReply, send } = build(async () => undefined);
    await runWebSignin(interaction, opts);
    expect(send).not.toHaveBeenCalled();
    expect(editReply).toHaveBeenCalledWith({
      content: "link https://x.test/s/tok",
    });
  });

  it("falls back to an ephemeral reply when DMs are closed", async () => {
    mockGetString.mockResolvedValue("dm");
    const { interaction, editReply } = build(async () => {
      throw new Error("Cannot send messages to this user");
    });
    await runWebSignin(interaction, opts);
    expect(editReply).toHaveBeenCalledWith({
      content: "link https://x.test/s/tok",
    });
  });

  // #1152: a DiscordAPIError carries the request body (the DM, i.e. the live
  // sign-in link) as own fields, and the logger serialises every meta key.
  function discordApiError() {
    return Object.assign(new Error("Cannot send messages to this user"), {
      name: "DiscordAPIError[50007]",
      code: 50007,
      status: 403,
      method: "POST",
      requestBody: {
        files: [],
        json: { content: "link https://x.test/s/tok" },
      },
      rawError: { message: "link https://x.test/s/tok" },
    });
  }

  function everythingLogged(): string {
    const calls = [
      ...mockLogger.info.mock.calls,
      ...mockLogger.warn.mock.calls,
      ...mockLogger.error.mock.calls,
      ...mockLogger.debug.mock.calls,
    ];
    return JSON.stringify(calls, (_k, v) =>
      v instanceof Error ? { ...v, message: v.message, stack: v.stack } : v,
    );
  }

  it("never logs the sign-in link when the DM fails", async () => {
    mockGetString.mockResolvedValue("dm");
    const { interaction, editReply } = build(async () => {
      throw discordApiError();
    });
    await runWebSignin(interaction, opts);

    // The member still gets the link ephemerally.
    expect(editReply).toHaveBeenCalledWith({
      content: "link https://x.test/s/tok",
    });
    expect(mockLogger.warn).toHaveBeenCalledTimes(1);
    expect(mockLogger.warn.mock.calls[0][0]).toContain("code=50007");
    expect(everythingLogged()).not.toContain("tok");
  });

  it("never logs the link when the ephemeral fallback also fails", async () => {
    mockGetString.mockResolvedValue("dm");
    const { interaction, editReply } = build(async () => {
      throw discordApiError();
    });
    editReply.mockRejectedValue(discordApiError() as never);
    await runWebSignin(interaction, opts);

    expect(mockLogger.error).toHaveBeenCalled();
    expect(everythingLogged()).not.toContain("tok");
  });

  it("never logs the link when ephemeral delivery fails", async () => {
    mockGetString.mockResolvedValue("ephemeral");
    const { interaction, editReply } = build(async () => undefined);
    editReply.mockRejectedValue(discordApiError() as never);
    await runWebSignin(interaction, opts);

    expect(mockLogger.error).toHaveBeenCalled();
    expect(everythingLogged()).not.toContain("tok");
  });
});
