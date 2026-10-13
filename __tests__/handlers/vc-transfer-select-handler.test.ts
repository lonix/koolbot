import { describe, it, expect, jest, beforeEach } from "@jest/globals";
import {
  ChannelType,
  type StringSelectMenuInteraction,
  type Client,
} from "discord.js";

// Mock dependencies before importing
jest.mock("../../src/utils/logger.js");
jest.mock("../../src/services/voice-channel-manager.js");

// Import after mocks
import { VoiceChannelManager } from "../../src/services/voice-channel-manager.js";
import { handleVCTransferSelect } from "../../src/handlers/vc-transfer-select-handler.js";

const mockVoiceChannelManager = VoiceChannelManager as jest.Mocked<
  typeof VoiceChannelManager
>;

describe("VCTransferSelectHandler - live ownership (#1143)", () => {
  let interaction: Partial<StringSelectMenuInteraction>;
  let manager: { isRoomOwner: jest.Mock; transferOwnership: jest.Mock };

  beforeEach(() => {
    jest.clearAllMocks();

    manager = {
      isRoomOwner: jest.fn().mockReturnValue(true),
      transferOwnership: jest.fn().mockResolvedValue(undefined),
    };
    (mockVoiceChannelManager.getInstance as unknown as jest.Mock) = jest.fn(
      () => manager,
    );

    interaction = {
      customId: "vc_transfer_select_channel-id_owner-id",
      values: ["target-id"],
      user: { id: "owner-id" } as any,
      client: {} as Client,
      guild: {
        channels: {
          fetch: jest.fn().mockResolvedValue({
            id: "channel-id",
            type: ChannelType.GuildVoice,
          }),
        },
        members: {
          fetch: jest.fn().mockResolvedValue({
            displayName: "Target",
            voice: { channelId: "channel-id" },
          }),
        },
      } as any,
      reply: jest.fn().mockResolvedValue(undefined),
      deferReply: jest.fn().mockResolvedValue(undefined),
      deferUpdate: jest.fn().mockResolvedValue(undefined),
      editReply: jest.fn().mockResolvedValue(undefined),
      update: jest.fn().mockResolvedValue(undefined),
    } as any;
  });

  it("transfers when the clicker is the live owner", async () => {
    await handleVCTransferSelect(interaction as StringSelectMenuInteraction);

    expect(manager.isRoomOwner).toHaveBeenCalledWith("owner-id", "channel-id");
    expect(manager.transferOwnership).toHaveBeenCalledWith(
      "channel-id",
      "owner-id",
      "target-id",
    );
  });

  it("escapes a hostile target name in the confirmation (#1146)", async () => {
    (interaction.guild!.members.fetch as jest.Mock).mockResolvedValue({
      displayName: "<@555> @everyone [free](https://evil.example) **b**",
      voice: { channelId: "channel-id" },
    });

    await handleVCTransferSelect(interaction as StringSelectMenuInteraction);

    const sent = [
      ...(interaction.editReply as jest.Mock).mock.calls,
      ...(interaction.update as jest.Mock).mock.calls,
      ...(interaction.reply as jest.Mock).mock.calls,
    ].map((call) => (call[0] as { content: string }).content);
    const confirmation = sent.find((c) => c.includes("ownership transferred"));
    expect(confirmation).toBeDefined();
    expect(confirmation).not.toContain("<@555>");
    expect(confirmation).not.toContain("@everyone");
    expect(confirmation).not.toContain("[free](");
    expect(confirmation).toContain("\\<@555\\>");
    expect(confirmation).toContain("\\*\\*b\\*\\*");
  });

  it("acknowledges (deferUpdate) before the locked transfer is awaited", async () => {
    const order: string[] = [];
    (interaction.deferUpdate as jest.Mock).mockImplementation(async () => {
      order.push("defer");
    });
    manager.transferOwnership.mockImplementation(async () => {
      order.push("transfer");
    });

    await handleVCTransferSelect(interaction as StringSelectMenuInteraction);

    expect(order).toEqual(["defer", "transfer"]);
  });

  it("tells a stale requester (rejected by the lock) via the deferred message", async () => {
    const { NotRoomOwnerError } =
      await import("../../src/services/voice-channel-manager.js");
    // A real deferUpdate marks the interaction deferred, so replies edit it
    (interaction.deferUpdate as jest.Mock).mockImplementation(async () => {
      (interaction as any).deferred = true;
    });
    manager.transferOwnership.mockRejectedValue(new NotRoomOwnerError());

    await handleVCTransferSelect(interaction as StringSelectMenuInteraction);

    expect(interaction.editReply).toHaveBeenCalledWith(
      expect.objectContaining({
        content: expect.stringContaining("current channel owner"),
      }),
    );
  });

  it("refuses a former owner whose still-open select names them", async () => {
    manager.isRoomOwner.mockReturnValue(false);

    await handleVCTransferSelect(interaction as StringSelectMenuInteraction);

    expect(manager.transferOwnership).not.toHaveBeenCalled();
    expect(interaction.reply).toHaveBeenCalledWith(
      expect.objectContaining({
        content: expect.stringContaining("current channel owner"),
      }),
    );
  });

  it("refuses a user other than the one named in the custom ID", async () => {
    interaction.user = { id: "someone-else" } as any;

    await handleVCTransferSelect(interaction as StringSelectMenuInteraction);

    expect(manager.transferOwnership).not.toHaveBeenCalled();
  });
});
