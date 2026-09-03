import { describe, it, expect, beforeEach, jest } from "@jest/globals";
import { MessageFlags, type ChatInputCommandInteraction } from "discord.js";
import { CommandManager } from "../../src/services/command-manager.js";
import {
  PermissionCheckError,
  PermissionsService,
} from "../../src/services/permissions-service.js";

// The real PermissionsService is left unmocked so `PermissionCheckError`
// keeps its identity for the `instanceof` guard in executeCommand; the
// instance's check method is stubbed per test instead.
jest.mock("../../src/services/monitoring-service.js", () => ({
  MonitoringService: {
    getInstance: jest.fn(() => ({
      trackCommandStart: jest.fn(() => "tracking-id"),
      trackCommandEnd: jest.fn(),
      trackError: jest.fn(),
    })),
  },
}));
jest.mock("../../src/web/metrics.js", () => ({
  recordCommandInvocation: jest.fn(),
}));
jest.mock("../../src/utils/logger.js");

describe("CommandManager.executeCommand permission availability (#836)", () => {
  let manager: CommandManager;
  let interaction: { reply: jest.Mock } & Record<string, unknown>;
  let executeFunction: jest.Mock;
  let checkCommandPermission: jest.Mock;

  beforeEach(() => {
    jest.clearAllMocks();
    CommandManager.reset();
    PermissionsService.reset();

    manager = CommandManager.getInstance({
      user: { id: "bot" },
      application: { id: "app" },
    } as never);

    checkCommandPermission = jest.fn();
    (manager as never as Record<string, unknown>)["permissionsService"] = {
      checkCommandPermission,
    };

    executeFunction = jest.fn(async () => undefined);
    interaction = {
      guildId: "guild123",
      channelId: "channel123",
      user: { id: "user123" },
      options: { getSubcommand: jest.fn(() => null) },
      reply: jest.fn(async () => undefined),
    };
  });

  const run = (): Promise<void> =>
    manager.executeCommand(
      "warn",
      interaction as unknown as ChatInputCommandInteraction,
      executeFunction as unknown as () => Promise<void>,
    );

  it("asks for the throwing mode so an unavailable check is not a silent allow", async () => {
    checkCommandPermission.mockResolvedValue(true as never);

    await run();

    expect(checkCommandPermission).toHaveBeenCalledWith(
      "user123",
      "guild123",
      "warn",
      { onUnavailable: "throw" },
    );
    expect(executeFunction).toHaveBeenCalled();
  });

  it("refuses the command when the permission check is unavailable", async () => {
    checkCommandPermission.mockRejectedValue(
      new PermissionCheckError(
        "permissions cache failed to load",
        new Error("Mongo connection lost"),
      ) as never,
    );

    await run();

    expect(executeFunction).not.toHaveBeenCalled();
    expect(interaction.reply).toHaveBeenCalledWith(
      expect.objectContaining({
        content: expect.stringContaining("try again"),
        flags: MessageFlags.Ephemeral,
      }),
    );
  });

  it("still reports a genuine denial as a permission problem", async () => {
    checkCommandPermission.mockResolvedValue(false as never);

    await run();

    expect(executeFunction).not.toHaveBeenCalled();
    expect(interaction.reply).toHaveBeenCalledWith(
      expect.objectContaining({
        content: expect.stringContaining("don't have permission"),
      }),
    );
  });

  it("propagates non-permission errors instead of swallowing them", async () => {
    const boom = new Error("unexpected");
    checkCommandPermission.mockRejectedValue(boom as never);

    await expect(run()).rejects.toThrow("unexpected");
    expect(executeFunction).not.toHaveBeenCalled();
    expect(interaction.reply).not.toHaveBeenCalled();
  });
});
