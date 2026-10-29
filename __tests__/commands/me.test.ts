import { describe, it, expect, jest, beforeEach } from "@jest/globals";
import { MessageFlags, type ChatInputCommandInteraction } from "discord.js";
import { errorEmbedPayload } from "../test-utils.js";

const mockCreateSession = jest.fn();
const mockGetInstance = jest.fn(() => ({
  create: mockCreateSession,
}));
const mockIsWebUIEnabled = jest.fn();
const mockValidateWebUIEnvVars = jest.fn();

jest.unstable_mockModule("../../src/services/web-session-service.js", () => ({
  WebSessionService: { getInstance: mockGetInstance },
}));

jest.unstable_mockModule("../../src/services/config-service.js", () => ({
  ConfigService: {
    getInstance: () => ({
      getString: jest.fn().mockResolvedValue("dm"),
      getNumber: jest.fn().mockResolvedValue(0),
    }),
  },
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
    expect(dm).toContain("expires in about 10 minutes. ");
    expect(dm).not.toMatch(/\(s\)/);
  });

  it("says 'minute' for a link that lasts one minute (#1529)", async () => {
    mockCreateSession.mockResolvedValue({
      url: "https://example.test/admin/s/tok",
      expiresAt: new Date(Date.now() + 60_000),
      role: "user",
    });
    const { interaction, userSend } = buildInteraction("0");

    await execute(interaction);

    expect(userSend.mock.calls[0][0] as string).toContain(
      "expires in about 1 minute. ",
    );
  });

  it("rejects when the WebUI is disabled", async () => {
    mockIsWebUIEnabled.mockReturnValue(false);
    const { interaction, editReply } = buildInteraction("0");

    await execute(interaction);

    expect(editReply).toHaveBeenCalledWith(
      errorEmbedPayload({
        title: "The Web UI is off",
        description: expect.stringContaining("WEBUI_ENABLED=true"),
      }),
    );
    expect(mockCreateSession).not.toHaveBeenCalled();
  });

  it("keeps the configuration detail out of a member's reply", async () => {
    mockValidateWebUIEnvVars.mockReturnValue([
      "WEBUI_SESSION_SECRET is missing",
    ]);
    const { interaction, editReply } = buildInteraction("0");

    await execute(interaction);

    expect(editReply).toHaveBeenCalledWith(
      errorEmbedPayload({
        title: "The Web UI isn't set up correctly",
        description: "Ask an admin to check the Web UI settings.",
      }),
    );
    expect(JSON.stringify(editReply.mock.calls)).not.toContain(
      "WEBUI_SESSION_SECRET",
    );
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
