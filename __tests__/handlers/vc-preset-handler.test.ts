import { describe, it, expect, jest, beforeEach } from "@jest/globals";
import {
  ChannelType,
  type ButtonInteraction,
  type Guild,
  type VoiceChannel,
} from "discord.js";

// Mock dependencies before importing
jest.mock("../../src/utils/logger.js");
jest.mock("../../src/models/user-voice-preferences.js", () => ({
  UserVoicePreferences: {
    findOne: jest.fn(),
    create: jest.fn(),
  },
}));

// Import after mocks
import { ConfigService } from "../../src/services/config-service.js";
import { UserVoicePreferences } from "../../src/models/user-voice-preferences.js";
import { UserVoicePrefsService } from "../../src/services/user-voice-prefs-service.js";
import {
  handleVCPresetButton,
  presetNameTag,
} from "../../src/handlers/vc-preset-handler.js";

const mockFindOne = UserVoicePreferences.findOne as unknown as jest.Mock;

describe("VCPresetHandler - staleness guard on preset actions", () => {
  let mockInteraction: Partial<ButtonInteraction>;
  let mockGuild: Partial<Guild>;
  let mockChannel: Partial<VoiceChannel>;
  let mockService: {
    setDefault: jest.Mock;
    deletePreset: jest.Mock;
    renamePreset: jest.Mock;
  };

  const squadNight = { name: "Squad Night", isDefault: false };
  const other = { name: "Other Preset", isDefault: false };

  beforeEach(() => {
    jest.clearAllMocks();

    // The feature gate reads real ConfigService (backed by mocked mongoose,
    // whose schema default disables presets) — force it on for these tests.
    jest.spyOn(ConfigService.prototype, "getBoolean").mockResolvedValue(true);
    jest.spyOn(ConfigService.prototype, "getNumber").mockResolvedValue(3);

    mockService = {
      setDefault: jest.fn(),
      deletePreset: jest.fn(),
      renamePreset: jest.fn(),
    };
    jest
      .spyOn(UserVoicePrefsService, "getInstance")
      .mockReturnValue(mockService as unknown as UserVoicePrefsService);

    mockChannel = {
      id: "chan1",
      name: "Test Channel",
      type: ChannelType.GuildVoice,
    } as any;

    mockGuild = {
      channels: {
        fetch: jest.fn().mockResolvedValue(mockChannel),
      } as any,
    } as any;

    mockInteraction = {
      user: { id: "user1" } as any,
      guild: mockGuild as Guild,
      reply: jest.fn().mockResolvedValue(undefined),
      update: jest.fn().mockResolvedValue(undefined),
      followUp: jest.fn().mockResolvedValue(undefined),
      showModal: jest.fn().mockResolvedValue(undefined),
    } as any;
  });

  const setPresets = (presets: Array<{ name: string; isDefault: boolean }>) =>
    mockFindOne.mockResolvedValue({ presets } as never);

  describe("delete button", () => {
    it("passes the verified preset name through as expectedName", async () => {
      setPresets([squadNight, other]);
      mockService.deletePreset.mockResolvedValue({
        name: "Squad Night",
        remaining: 1,
      } as never);
      mockInteraction.customId = `vc_preset_delete_0_${presetNameTag("Squad Night")}_chan1_user1`;

      await handleVCPresetButton(mockInteraction as ButtonInteraction);

      expect(mockService.deletePreset).toHaveBeenCalledWith(
        "user1",
        0,
        "Squad Night",
      );
      expect(mockInteraction.followUp).toHaveBeenCalledWith({
        content: "🗑️ Deleted preset **Squad Night**.",
        flags: expect.anything(),
      });
    });

    it("refuses when the preset at the index no longer matches the tag", async () => {
      // Panel rendered "Squad Night" at index 0, but the list shifted and
      // "Other Preset" now sits there.
      setPresets([other]);
      mockInteraction.customId = `vc_preset_delete_0_${presetNameTag("Squad Night")}_chan1_user1`;

      await handleVCPresetButton(mockInteraction as ButtonInteraction);

      expect(mockService.deletePreset).not.toHaveBeenCalled();
      expect(mockInteraction.reply).toHaveBeenCalledWith({
        content:
          "❌ Your presets changed since this panel was opened — reopen it and try again.",
        flags: expect.anything(),
      });
    });

    it("refuses when the preset index no longer exists", async () => {
      setPresets([]);
      mockInteraction.customId = `vc_preset_delete_0_${presetNameTag("Squad Night")}_chan1_user1`;

      await handleVCPresetButton(mockInteraction as ButtonInteraction);

      expect(mockService.deletePreset).not.toHaveBeenCalled();
      expect(mockInteraction.reply).toHaveBeenCalledWith(
        expect.objectContaining({
          content:
            "❌ Your presets changed since this panel was opened — reopen it and try again.",
        }),
      );
    });

    it("still guards legacy tag-less custom IDs with the current name", async () => {
      setPresets([squadNight]);
      mockService.deletePreset.mockResolvedValue({
        name: "Squad Night",
        remaining: 0,
      } as never);
      mockInteraction.customId = "vc_preset_delete_0_chan1_user1";

      await handleVCPresetButton(mockInteraction as ButtonInteraction);

      expect(mockService.deletePreset).toHaveBeenCalledWith(
        "user1",
        0,
        "Squad Night",
      );
    });
  });

  describe("set-default button", () => {
    it("passes the verified preset name through as expectedName", async () => {
      setPresets([squadNight, other]);
      mockService.setDefault.mockResolvedValue({
        name: "Squad Night",
        isDefault: true,
      } as never);
      mockInteraction.customId = `vc_preset_default_0_${presetNameTag("Squad Night")}_chan1_user1`;

      await handleVCPresetButton(mockInteraction as ButtonInteraction);

      expect(mockService.setDefault).toHaveBeenCalledWith(
        "user1",
        0,
        "Squad Night",
      );
    });

    it("refuses when the preset at the index no longer matches the tag", async () => {
      setPresets([other, squadNight]);
      mockInteraction.customId = `vc_preset_default_0_${presetNameTag("Squad Night")}_chan1_user1`;

      await handleVCPresetButton(mockInteraction as ButtonInteraction);

      expect(mockService.setDefault).not.toHaveBeenCalled();
      expect(mockInteraction.reply).toHaveBeenCalledWith(
        expect.objectContaining({
          content:
            "❌ Your presets changed since this panel was opened — reopen it and try again.",
        }),
      );
    });
  });

  describe("rename button", () => {
    it("embeds the name fingerprint in the rename modal custom ID", async () => {
      setPresets([squadNight]);
      mockInteraction.customId = `vc_preset_rename_0_${presetNameTag("Squad Night")}_chan1_user1`;

      await handleVCPresetButton(mockInteraction as ButtonInteraction);

      expect(mockInteraction.showModal).toHaveBeenCalledTimes(1);
      const modal = (mockInteraction.showModal as jest.Mock).mock
        .calls[0][0] as { data: { custom_id?: string } };
      expect(modal.data.custom_id).toBe(
        `vc_modal_renamepreset_0_${presetNameTag("Squad Night")}_chan1_user1`,
      );
    });

    it("refuses to open the modal from a stale rename button", async () => {
      setPresets([other]);
      mockInteraction.customId = `vc_preset_rename_0_${presetNameTag("Squad Night")}_chan1_user1`;

      await handleVCPresetButton(mockInteraction as ButtonInteraction);

      expect(mockInteraction.showModal).not.toHaveBeenCalled();
      expect(mockInteraction.reply).toHaveBeenCalledWith(
        expect.objectContaining({
          content:
            "❌ Your presets changed since this panel was opened — reopen it and try again.",
        }),
      );
    });
  });

  describe("presetNameTag", () => {
    it("is deterministic and safe for the underscore-delimited custom ID", () => {
      const tag = presetNameTag("Squad_Night with_underscores");
      expect(tag).toBe(presetNameTag("Squad_Night with_underscores"));
      expect(tag).toMatch(/^[0-9a-f]{8}$/);
      expect(presetNameTag("Other")).not.toBe(tag);
    });
  });
});
