import {
  describe,
  it,
  expect,
  jest,
  beforeEach,
  afterEach,
} from "@jest/globals";
import type { ChatInputCommandInteraction } from "discord.js";

const mockCreateSession = jest.fn();
const mockGetInstance = jest.fn(() => ({
  create: mockCreateSession,
}));
const mockIsWebUIEnabled = jest.fn();
const mockGetMissingWebUIEnvVars = jest.fn();

jest.unstable_mockModule("../../src/services/web-session-service.js", () => ({
  WebSessionService: { getInstance: mockGetInstance },
}));

jest.unstable_mockModule("../../src/web/index.js", () => ({
  isWebUIEnabled: mockIsWebUIEnabled,
  getMissingWebUIEnvVars: mockGetMissingWebUIEnvVars,
}));

jest.unstable_mockModule("../../src/utils/logger.js", () => ({
  default: {
    info: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
    debug: jest.fn(),
  },
}));

const { data, execute } = await import("../../src/commands/config.js");

const ORIGINAL_ENV = { ...process.env };

describe("Config Command — metadata", () => {
  it("has correct command name", () => {
    expect(data.name).toBe("config");
  });

  it("has a description", () => {
    expect(data.description).toBeDefined();
    expect(typeof data.description).toBe("string");
  });

  it("is a valid slash command", () => {
    const json = data.toJSON();
    expect(json).toHaveProperty("name", "config");
    expect(json).toHaveProperty("description");
  });

  it("requires administrator permissions", () => {
    const json = data.toJSON();
    expect(json.default_member_permissions).toBeDefined();
  });

  it("exposes no subcommands (bare /config launches the WebUI)", () => {
    const json = data.toJSON();
    const subcommands = (json.options ?? []).filter(
      (opt: { type?: number }) => opt.type === 1,
    );
    expect(subcommands.length).toBe(0);
  });

  it("does not register any legacy subcommands", () => {
    const json = data.toJSON();
    const removed = [
      "list",
      "set",
      "import",
      "export",
      "reset",
      "reload",
      "web",
    ];
    const names = (json.options ?? []).map((opt: { name: string }) => opt.name);
    for (const name of removed) {
      expect(names).not.toContain(name);
    }
  });
});

describe("Config Command — execute", () => {
  let deferReply: jest.Mock;
  let editReply: jest.Mock;
  let userSend: jest.Mock;

  function buildInteraction(
    overrides: { guildId?: string | null; userId?: string } = {},
  ): ChatInputCommandInteraction {
    deferReply = jest.fn().mockResolvedValue(undefined as never);
    editReply = jest.fn().mockResolvedValue(undefined as never);
    userSend = jest.fn().mockResolvedValue(undefined as never);

    return {
      deferReply,
      editReply,
      guildId: overrides.guildId === undefined ? "g1" : overrides.guildId,
      user: {
        id: overrides.userId ?? "u1",
        send: userSend,
      },
    } as unknown as ChatInputCommandInteraction;
  }

  beforeEach(() => {
    jest.clearAllMocks();
    process.env = { ...ORIGINAL_ENV };
    mockGetInstance.mockReturnValue({ create: mockCreateSession });
    mockIsWebUIEnabled.mockReturnValue(true);
    mockGetMissingWebUIEnvVars.mockReturnValue([]);
  });

  afterEach(() => {
    process.env = { ...ORIGINAL_ENV };
  });

  it("defers the reply before doing any work", async () => {
    mockCreateSession.mockResolvedValue({
      url: "https://example.test/admin/s/tok",
      expiresAt: new Date(Date.now() + 10 * 60_000),
    });
    const interaction = buildInteraction();

    await execute(interaction);

    expect(deferReply).toHaveBeenCalledWith({ ephemeral: true });
  });

  it("rejects when the WebUI is disabled", async () => {
    mockIsWebUIEnabled.mockReturnValue(false);
    const interaction = buildInteraction();

    await execute(interaction);

    expect(editReply).toHaveBeenCalledWith({
      content: expect.stringContaining("web UI is disabled"),
    });
    expect(mockCreateSession).not.toHaveBeenCalled();
  });

  it("rejects when required env vars are missing", async () => {
    mockGetMissingWebUIEnvVars.mockReturnValue([
      "WEBUI_BASE_URL",
      "WEBUI_SESSION_SECRET",
    ]);
    const interaction = buildInteraction();

    await execute(interaction);

    expect(editReply).toHaveBeenCalledWith({
      content: expect.stringContaining("WEBUI_BASE_URL"),
    });
    expect(mockCreateSession).not.toHaveBeenCalled();
  });

  it("rejects when invoked outside a guild", async () => {
    const interaction = buildInteraction({ guildId: null });

    await execute(interaction);

    expect(editReply).toHaveBeenCalledWith({
      content: expect.stringContaining("must be run inside a guild"),
    });
    expect(mockCreateSession).not.toHaveBeenCalled();
  });

  it("DMs the sign-in link when WebUI is enabled and DM succeeds", async () => {
    mockCreateSession.mockResolvedValue({
      url: "https://example.test/admin/s/tok",
      expiresAt: new Date(Date.now() + 10 * 60_000),
    });
    const interaction = buildInteraction();

    await execute(interaction);

    expect(mockCreateSession).toHaveBeenCalledWith("u1", "g1");
    expect(userSend).toHaveBeenCalledWith(
      expect.stringContaining("https://example.test/admin/s/tok"),
    );
    expect(editReply).toHaveBeenCalledWith({
      content: expect.stringContaining("DMed you"),
    });
  });

  it("falls back to ephemeral reply when DM fails", async () => {
    mockCreateSession.mockResolvedValue({
      url: "https://example.test/admin/s/tok",
      expiresAt: new Date(Date.now() + 10 * 60_000),
    });
    const interaction = buildInteraction();
    userSend.mockRejectedValueOnce(new Error("DMs blocked") as never);

    await execute(interaction);

    expect(userSend).toHaveBeenCalled();
    expect(editReply).toHaveBeenCalledWith({
      content: expect.stringContaining("https://example.test/admin/s/tok"),
    });
  });

  it("reports an error when session creation throws", async () => {
    mockCreateSession.mockRejectedValue(new Error("mongo down") as never);
    const interaction = buildInteraction();

    await execute(interaction);

    expect(editReply).toHaveBeenCalledWith({
      content: expect.stringContaining("An error occurred"),
    });
    expect(userSend).not.toHaveBeenCalled();
  });
});
