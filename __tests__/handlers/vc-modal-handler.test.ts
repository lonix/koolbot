import { describe, it, expect, jest, beforeEach } from "@jest/globals";
import {
  ChannelType,
  type ModalSubmitInteraction,
  type Guild,
  type VoiceChannel,
  type Client,
} from "discord.js";

// Mock dependencies before importing
jest.mock("../../src/utils/logger.js");
jest.mock("../../src/services/voice-channel-manager.js");

// Import after mocks
import { VoiceChannelManager } from "../../src/services/voice-channel-manager.js";
import { ConfigService } from "../../src/services/config-service.js";
import {
  UserVoicePrefsService,
  VoicePrefsValidationError,
} from "../../src/services/user-voice-prefs-service.js";
import { presetNameTag } from "../../src/handlers/vc-preset-handler.js";
import { handleVCModal } from "../../src/handlers/vc-modal-handler.js";
import { errorEmbedPayload, unexpectedErrorPayload } from "../test-utils.js";

const mockVoiceChannelManager = VoiceChannelManager as jest.Mocked<
  typeof VoiceChannelManager
>;

describe("VCModalHandler - Custom Name Tracking", () => {
  let mockInteraction: Partial<ModalSubmitInteraction>;
  let mockGuild: Partial<Guild>;
  let mockChannel: Partial<VoiceChannel>;
  let mockSetCustomChannelName: jest.Mock;
  let mockGetInstance: jest.Mock;
  let mockIsRoomOwner: jest.Mock;
  let mockIsReservedChannelName: jest.Mock;

  beforeEach(() => {
    jest.clearAllMocks();

    mockSetCustomChannelName = jest.fn();

    mockIsRoomOwner = jest.fn().mockReturnValue(true);
    mockIsReservedChannelName = jest.fn().mockResolvedValue(false);

    mockGetInstance = jest.fn(() => ({
      setCustomChannelName: mockSetCustomChannelName,
      isRoomOwner: mockIsRoomOwner,
      runAsRoomOwner: jest.fn(
        async (
          userId: string,
          channelId: string,
          work: () => Promise<void>,
        ) => {
          if (!mockIsRoomOwner(userId, channelId)) return false;
          await work();
          return true;
        },
      ),
      isReservedChannelName: mockIsReservedChannelName,
    }));

    (mockVoiceChannelManager.getInstance as unknown as jest.Mock) =
      mockGetInstance;

    mockChannel = {
      id: "test-channel-id",
      name: "Old Channel Name",
      type: ChannelType.GuildVoice,
      setName: jest.fn().mockResolvedValue(undefined),
    } as any;

    mockGuild = {
      id: "test-guild-id",
      name: "Test Guild",
      channels: {
        fetch: jest.fn().mockResolvedValue(mockChannel),
      } as any,
    } as any;

    mockInteraction = {
      customId: "vc_modal_name_test-channel-id_test-user-id",
      user: {
        id: "test-user-id",
        displayName: "TestUser",
      } as any,
      fields: {
        getTextInputValue: jest.fn().mockReturnValue("New Custom Name"),
      } as any,
      // Like discord.js, acknowledging flips the state that decides whether a
      // reply is a fresh message or an edit of the deferred one (#1510). The
      // modal defers before any slow work, so its answers are edits.
      replied: false,
      deferred: false,
      reply: jest.fn(async () => {
        (mockInteraction as any).replied = true;
      }),
      deferReply: jest.fn(async () => {
        (mockInteraction as any).deferred = true;
      }),
      deferUpdate: jest.fn().mockResolvedValue(undefined),
      editReply: jest.fn().mockResolvedValue(undefined),
      followUp: jest.fn().mockResolvedValue(undefined),
      guild: mockGuild as Guild,
      client: {} as any as Client,
    } as any;
  });

  describe("Ownership and reserved names (#1143, #1148)", () => {
    it("refuses a rename from a user who no longer owns the room", async () => {
      mockIsRoomOwner.mockReturnValue(false);

      await handleVCModal(mockInteraction as ModalSubmitInteraction);

      expect(mockIsRoomOwner).toHaveBeenCalledWith(
        "test-user-id",
        "test-channel-id",
      );
      expect(mockChannel.setName).not.toHaveBeenCalled();
      expect(mockSetCustomChannelName).not.toHaveBeenCalled();
      expect(mockInteraction.editReply).toHaveBeenCalledWith(
        errorEmbedPayload({
          title: "Only the room owner can do this",
          description: expect.stringContaining("start your own room"),
        }),
      );
    });

    it("refuses the rename when a transfer lands between the click and the locked rename", async () => {
      // Ownership is re-checked inside runAsRoomOwner, not just up front
      mockIsRoomOwner.mockReturnValue(false);
      mockChannel.setName = jest.fn();

      await handleVCModal(mockInteraction as ModalSubmitInteraction);

      expect(mockChannel.setName).not.toHaveBeenCalled();
    });

    it("acknowledges (deferReply) before the room lock is awaited", async () => {
      const order: string[] = [];
      (mockInteraction.deferReply as jest.Mock).mockImplementation(async () => {
        order.push("defer");
      });
      mockGetInstance.mockImplementation(() => ({
        setCustomChannelName: mockSetCustomChannelName,
        isReservedChannelName: mockIsReservedChannelName,
        runAsRoomOwner: async (
          _u: string,
          _c: string,
          work: () => Promise<void>,
        ) => {
          order.push("lock");
          await work();
          return true;
        },
      }));

      await handleVCModal(mockInteraction as ModalSubmitInteraction);

      expect(order).toEqual(["defer", "lock"]);
    });

    it("rejects a rename to a reserved (lobby) name", async () => {
      mockIsReservedChannelName.mockResolvedValue(true);
      (mockInteraction.fields!.getTextInputValue as jest.Mock).mockReturnValue(
        "Lobby",
      );

      await handleVCModal(mockInteraction as ModalSubmitInteraction);

      expect(mockIsReservedChannelName).toHaveBeenCalledWith("Lobby");
      expect(mockChannel.setName).not.toHaveBeenCalled();
      expect(mockSetCustomChannelName).not.toHaveBeenCalled();
      expect(mockInteraction.editReply).toHaveBeenCalledWith(
        errorEmbedPayload({
          title: "That channel name is reserved",
          description: expect.stringContaining("different name"),
        }),
      );
    });
  });

  describe("Custom name tracking on rename", () => {
    it("should mark channel as having custom name after successful rename", async () => {
      await handleVCModal(mockInteraction as ModalSubmitInteraction);

      expect(mockChannel.setName).toHaveBeenCalledWith("New Custom Name");
      expect(mockSetCustomChannelName).toHaveBeenCalledWith(
        "test-channel-id",
        "New Custom Name",
      );
      expect(mockInteraction.editReply).toHaveBeenCalledWith({
        content: "✅ Channel renamed to: **New Custom Name**",
      });
    });

    it("should not mark channel as custom if rename fails", async () => {
      mockChannel.setName = jest
        .fn()
        .mockRejectedValue(new Error("Rename failed"));

      await handleVCModal(mockInteraction as ModalSubmitInteraction);

      expect(mockSetCustomChannelName).not.toHaveBeenCalled();
      expect(mockInteraction.editReply).toHaveBeenCalledWith(
        unexpectedErrorPayload(),
      );
    });

    it("should reject names longer than 100 characters", async () => {
      const longName = "a".repeat(101);
      mockInteraction.fields = {
        getTextInputValue: jest.fn().mockReturnValue(longName),
      } as any;

      await handleVCModal(mockInteraction as ModalSubmitInteraction);

      expect(mockChannel.setName).not.toHaveBeenCalled();
      expect(mockSetCustomChannelName).not.toHaveBeenCalled();
      expect(mockInteraction.editReply).toHaveBeenCalledWith(
        errorEmbedPayload({
          title: "That channel name is too long",
          description: expect.stringContaining("100 characters"),
        }),
      );
    });

    it("should reject empty names", async () => {
      mockInteraction.fields = {
        getTextInputValue: jest.fn().mockReturnValue(""),
      } as any;

      await handleVCModal(mockInteraction as ModalSubmitInteraction);

      expect(mockChannel.setName).not.toHaveBeenCalled();
      expect(mockSetCustomChannelName).not.toHaveBeenCalled();
      expect(mockInteraction.editReply).toHaveBeenCalledWith(
        errorEmbedPayload({
          title: "The channel name is empty",
          description: expect.stringContaining("Type a name"),
        }),
      );
    });
  });

  describe("Rename preset staleness guard", () => {
    let mockService: {
      getPrefs: jest.Mock;
      renamePreset: jest.Mock;
      savePreset?: jest.Mock;
    };

    beforeEach(() => {
      // The feature gate reads real ConfigService (backed by mocked mongoose,
      // whose schema default disables presets) — force it on for these tests.
      jest.spyOn(ConfigService.prototype, "getBoolean").mockResolvedValue(true);
      mockService = {
        getPrefs: jest.fn(),
        renamePreset: jest.fn(),
      };
      jest
        .spyOn(UserVoicePrefsService, "getInstance")
        .mockReturnValue(mockService as unknown as UserVoicePrefsService);
      mockInteraction.fields = {
        getTextInputValue: jest.fn().mockReturnValue("Renamed Preset"),
      } as any;
    });

    it("renames and passes the verified name as expectedName when the tag matches", async () => {
      mockService.getPrefs.mockResolvedValue({
        presets: [{ name: "Squad Night", isDefault: false }],
      } as never);
      mockService.renamePreset.mockResolvedValue({
        oldName: "Squad Night",
        newName: "Renamed Preset",
      } as never);
      mockInteraction.customId = `vc_modal_renamepreset_0_${presetNameTag("Squad Night")}_test-channel-id_test-user-id`;

      await handleVCModal(mockInteraction as ModalSubmitInteraction);

      expect(mockService.renamePreset).toHaveBeenCalledWith(
        "test-user-id",
        0,
        "Renamed Preset",
        "Squad Night",
      );
      expect(mockInteraction.editReply).toHaveBeenCalledWith({
        content: "✏️ Preset **Squad Night** renamed to **Renamed Preset**.",
      });
    });

    it("escapes hostile preset names in the rename confirmation (#1146)", async () => {
      const hostile = "[x](https://evil.example) <@555> @everyone **b**";
      mockService.getPrefs.mockResolvedValue({
        presets: [{ name: hostile, isDefault: false }],
      } as never);
      mockService.renamePreset.mockResolvedValue({
        oldName: hostile,
        newName: hostile,
      } as never);
      mockInteraction.customId = `vc_modal_renamepreset_0_${presetNameTag(hostile)}_test-channel-id_test-user-id`;

      await handleVCModal(mockInteraction as ModalSubmitInteraction);

      const text = (
        (mockInteraction.editReply as jest.Mock).mock.calls[0][0] as {
          content: string;
        }
      ).content;
      expect(text).not.toContain("[x](");
      expect(text).not.toContain("<@555>");
      expect(text).not.toContain("@everyone");
      expect(text.match(/\\<@555\\>/g)).toHaveLength(2);
    });

    it("escapes a hostile preset name in the save confirmation (#1146)", async () => {
      const hostile = "[x](https://evil.example) <@555> @everyone **b**";
      Object.assign(mockChannel, { userLimit: 4, bitrate: 64000 });
      mockService.savePreset = jest
        .fn()
        .mockResolvedValue({ updated: false, name: hostile } as never);
      mockInteraction.customId =
        "vc_modal_savepreset_test-channel-id_test-user-id";
      mockInteraction.fields = {
        getTextInputValue: jest.fn().mockReturnValue(hostile),
      } as any;

      await handleVCModal(mockInteraction as ModalSubmitInteraction);

      const text = (
        (mockInteraction.editReply as jest.Mock).mock.calls[0][0] as {
          content: string;
        }
      ).content;
      expect(text).toContain("saved");
      expect(text).not.toContain("[x](");
      expect(text).not.toContain("<@555>");
      expect(text).not.toContain("@everyone");
      expect(text).toContain("\\<@555\\>");
    });

    it("refuses when the preset at the index changed since the modal opened", async () => {
      mockService.getPrefs.mockResolvedValue({
        presets: [{ name: "Other Preset", isDefault: false }],
      } as never);
      mockInteraction.customId = `vc_modal_renamepreset_0_${presetNameTag("Squad Night")}_test-channel-id_test-user-id`;

      await handleVCModal(mockInteraction as ModalSubmitInteraction);

      expect(mockService.renamePreset).not.toHaveBeenCalled();
      expect(mockInteraction.editReply).toHaveBeenCalledWith(
        errorEmbedPayload({
          title: "Your presets changed",
          description: expect.stringContaining("Reopen the presets panel"),
        }),
      );
    });

    it("refuses when the preset index no longer exists", async () => {
      mockService.getPrefs.mockResolvedValue({ presets: [] } as never);
      mockInteraction.customId = `vc_modal_renamepreset_0_${presetNameTag("Squad Night")}_test-channel-id_test-user-id`;

      await handleVCModal(mockInteraction as ModalSubmitInteraction);

      expect(mockService.renamePreset).not.toHaveBeenCalled();
      expect(mockInteraction.editReply).toHaveBeenCalledWith(
        errorEmbedPayload({ title: "Your presets changed" }),
      );
    });

    it("still renames via legacy tag-less modal IDs, guarded by the current name", async () => {
      mockService.getPrefs.mockResolvedValue({
        presets: [{ name: "Squad Night", isDefault: false }],
      } as never);
      mockService.renamePreset.mockResolvedValue({
        oldName: "Squad Night",
        newName: "Renamed Preset",
      } as never);
      mockInteraction.customId =
        "vc_modal_renamepreset_0_test-channel-id_test-user-id";

      await handleVCModal(mockInteraction as ModalSubmitInteraction);

      expect(mockService.renamePreset).toHaveBeenCalledWith(
        "test-user-id",
        0,
        "Renamed Preset",
        "Squad Night",
      );
    });
  });
});

describe("VCModalHandler - failure replies (#1510)", () => {
  // Only a VoicePrefsValidationError is written for members; any other error,
  // whatever its message, stays in the log and the member gets the generic
  // embed. The same split guards vc-preset-handler.ts.
  let interaction: any;
  let service: {
    savePreset: jest.Mock;
    getPrefs: jest.Mock;
    renamePreset: jest.Mock;
  };

  beforeEach(() => {
    jest.clearAllMocks();
    (mockVoiceChannelManager.getInstance as unknown as jest.Mock) = jest.fn(
      () => ({
        isReservedChannelName: jest.fn().mockResolvedValue(false),
        runAsRoomOwner: async (
          _u: string,
          _c: string,
          work: () => Promise<void>,
        ) => {
          await work();
          return true;
        },
      }),
    );
    jest.spyOn(ConfigService.prototype, "getBoolean").mockResolvedValue(true);
    jest.spyOn(ConfigService.prototype, "getNumber").mockResolvedValue(3);
    service = {
      savePreset: jest.fn(),
      getPrefs: jest.fn(),
      renamePreset: jest.fn(),
    };
    jest
      .spyOn(UserVoicePrefsService, "getInstance")
      .mockReturnValue(service as unknown as UserVoicePrefsService);
    interaction = {
      customId: "vc_modal_savepreset_test-channel-id_test-user-id",
      user: { id: "test-user-id" },
      fields: { getTextInputValue: jest.fn().mockReturnValue("Squad") },
      replied: false,
      deferred: false,
      reply: jest.fn(async () => {
        interaction.replied = true;
      }),
      deferReply: jest.fn(async () => {
        interaction.deferred = true;
      }),
      editReply: jest.fn().mockResolvedValue(undefined),
      followUp: jest.fn().mockResolvedValue(undefined),
      guild: {
        channels: {
          fetch: jest.fn().mockResolvedValue({
            id: "test-channel-id",
            name: "Room",
            type: ChannelType.GuildVoice,
            userLimit: 0,
            bitrate: 64000,
          }),
        },
      },
      client: {} as Client,
    };
  });

  it("shows a VoicePrefsValidationError message as the description", async () => {
    service.savePreset.mockRejectedValue(
      new VoicePrefsValidationError("Preset name must be 1–50 characters."),
    );

    await handleVCModal(interaction as ModalSubmitInteraction);

    expect(interaction.editReply).toHaveBeenCalledWith(
      errorEmbedPayload({
        title: "Couldn't save the preset",
        description: "Preset name must be 1–50 characters.",
      }),
    );
  });

  it("escapes a member-typed name inside a validation message", async () => {
    service.savePreset.mockRejectedValue(
      new VoicePrefsValidationError(
        'You already have a preset named "<@555> @everyone".',
      ),
    );

    await handleVCModal(interaction as ModalSubmitInteraction);

    const sent = interaction.editReply.mock.calls[0][0] as {
      embeds: { data: { description: string } }[];
    };
    expect(sent.embeds[0].data.description).not.toContain("<@555>");
    expect(sent.embeds[0].data.description).not.toContain("@everyone");
  });

  it("keeps any other error's message out of the reply", async () => {
    service.savePreset.mockRejectedValue(
      new Error("MongoServerError: secret connection string"),
    );

    await handleVCModal(interaction as ModalSubmitInteraction);

    expect(interaction.editReply).toHaveBeenCalledWith(
      unexpectedErrorPayload(),
    );
    expect(JSON.stringify(interaction.editReply.mock.calls)).not.toContain(
      "secret",
    );
  });

  it("answers an unreadable modal id as out of date, before acknowledging", async () => {
    interaction.customId = "vc_modal_name";

    await handleVCModal(interaction as ModalSubmitInteraction);

    expect(interaction.reply).toHaveBeenCalledWith(
      errorEmbedPayload({ title: "This control is out of date" }),
    );
    expect(interaction.deferReply).not.toHaveBeenCalled();
  });

  it("refuses a modal opened by someone else, before acknowledging", async () => {
    interaction.user = { id: "someone-else" };

    await handleVCModal(interaction as ModalSubmitInteraction);

    expect(interaction.reply).toHaveBeenCalledWith(
      errorEmbedPayload({ title: "This form belongs to someone else" }),
    );
    expect(service.savePreset).not.toHaveBeenCalled();
  });

  it("says presets are switched off when the feature is off", async () => {
    jest.spyOn(ConfigService.prototype, "getBoolean").mockResolvedValue(false);

    await handleVCModal(interaction as ModalSubmitInteraction);

    expect(interaction.editReply).toHaveBeenCalledWith(
      errorEmbedPayload({
        title: "Presets are switched off",
        description: expect.stringContaining("admin"),
      }),
    );
  });
});
