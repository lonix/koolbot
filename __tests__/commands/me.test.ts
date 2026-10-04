import { describe, it, expect, jest, beforeEach } from "@jest/globals";
import { MessageFlags, type ChatInputCommandInteraction } from "discord.js";

const mockCreateSession = jest.fn();
const mockGetInstance = jest.fn(() => ({
  create: mockCreateSession,
}));
const mockIsWebUIEnabled = jest.fn();
const mockValidateWebUIEnvVars = jest.fn();

jest.unstable_mockModule("../../src/services/web-session-service.js", () => ({
  WebSessionService: { getInstance: mockGetInstance },
}));

jest.unstable_mockModule("../../src/web/index.js", () => ({
  isWebUIEnabled: mockIsWebUIEnabled,
  validateWebUIEnvVars: mockValidateWebUIEnvVars,
}));

jest.unstable_mockModule("../../src/utils/logger.js", () => ({
  default: {
    info: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
    debug: jest.fn(),
  },
}));

const { data, execute } = await import("../../src/commands/me.js");

describe("Me Command — metadata", () => {
  it("is named /me and is open to everyone", () => {
    expect(data.name).toBe("me");
    expect(data.toJSON().default_member_permissions ?? null).toBeNull();
  });
});

describe("Me Command — execute", () => {
  function buildInteraction(permissions: string) {
    const editReply = jest.fn().mockResolvedValue(undefined as never);
    const userSend = jest.fn().mockResolvedValue(undefined as never);
    const interaction = {
      deferred: false,
      replied: false,
      editReply,
      guildId: "g1",
      member: { permissions },
      user: { id: "u1", send: userSend },
      deferReply: jest.fn().mockImplementation(async () => {
        interaction.deferred = true;
      }),
    };
    return {
      interaction: interaction as unknown as ChatInputCommandInteraction,
      editReply,
      userSend,
      deferReply: interaction.deferReply,
    };
  }

  beforeEach(() => {
    jest.clearAllMocks();
    mockGetInstance.mockReturnValue({ create: mockCreateSession });
    mockIsWebUIEnabled.mockReturnValue(true);
    mockValidateWebUIEnvVars.mockReturnValue([]);
    mockCreateSession.mockResolvedValue({
      url: "https://example.test/admin/s/tok",
      expiresAt: new Date(Date.now() + 10 * 60_000),
      role: "user",
    });
  });

  it.each([
    ["a member", "0"],
    ["an administrator", "8"],
  ])("issues a user-role session for %s and opens /me/", async (_l, perms) => {
    const { interaction, userSend, deferReply } = buildInteraction(perms);

    await execute(interaction);

    expect(deferReply).toHaveBeenCalledWith({ flags: MessageFlags.Ephemeral });
    expect(mockCreateSession).toHaveBeenCalledWith("u1", "g1", "user");
    const dm = userSend.mock.calls[0][0] as string;
    expect(dm).toContain("/me/");
    expect(dm).not.toMatch(/admin panel/i);
  });

  it("rejects when the WebUI is disabled", async () => {
    mockIsWebUIEnabled.mockReturnValue(false);
    const { interaction, editReply } = buildInteraction("0");

    await execute(interaction);

    expect(editReply).toHaveBeenCalledWith({
      content: expect.stringContaining("web UI is disabled"),
    });
    expect(mockCreateSession).not.toHaveBeenCalled();
  });

  it("falls back to an ephemeral reply when the DM fails", async () => {
    const { interaction, editReply, userSend } = buildInteraction("0");
    userSend.mockRejectedValueOnce(new Error("DMs blocked") as never);

    await execute(interaction);

    expect(editReply).toHaveBeenCalledWith({
      content: expect.stringContaining("https://example.test/admin/s/tok"),
    });
  });
});
