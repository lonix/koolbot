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
jest.unstable_mockModule("../../src/utils/logger.js", () => ({
  default: {
    info: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
    debug: jest.fn(),
  },
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
});
