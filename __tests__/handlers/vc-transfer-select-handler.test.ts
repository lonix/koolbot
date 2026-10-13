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
