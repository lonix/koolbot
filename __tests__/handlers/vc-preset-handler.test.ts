import { describe, it, expect, jest, beforeEach } from "@jest/globals";
import {
  ChannelType,
  type ButtonInteraction,
  type StringSelectMenuInteraction,
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
import {
  UserVoicePrefsService,
  VoicePrefsValidationError,
} from "../../src/services/user-voice-prefs-service.js";
import { VoiceChannelManager } from "../../src/services/voice-channel-manager.js";
import {
  handleVCPresetSelect,
  handleVCPresetButton,
  presetNameTag,
} from "../../src/handlers/vc-preset-handler.js";
import { errorEmbedPayload, unexpectedErrorPayload } from "../test-utils.js";

const mockFindOne = UserVoicePreferences.findOne as unknown as jest.Mock;

describe("VCPresetHandler - staleness guard on preset actions", () => {
  let mockInteraction: Partial<ButtonInteraction>;
  let mockGuild: Partial<Guild>;
  let mockChannel: Partial<VoiceChannel>;
  let mockIsRoomOwner: jest.Mock;
  let mockIsReserved: jest.Mock;
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

    // Live ownership: user1 owns chan1 (the customId alone is not trusted)
    mockIsRoomOwner = jest.fn(
      (userId: string, channelId: string) =>
        userId === "user1" && channelId === "chan1",
    );
    mockIsReserved = jest.fn().mockResolvedValue(false);
    jest.spyOn(VoiceChannelManager, "getInstance").mockReturnValue({
      isRoomOwner: mockIsRoomOwner,
      // Mirrors the real lock: ownership is re-checked right before `work`
      runAsRoomOwner: async (
        userId: string,
        channelId: string,
        work: () => Promise<void>,
      ) => {
        if (!mockIsRoomOwner(userId, channelId)) return false;
        await work();
        return true;
      },
      isReservedChannelName: mockIsReserved,
    } as unknown as VoiceChannelManager);

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
      // Like discord.js, acknowledging flips the state that decides whether a
      // failure is a fresh reply, an edit of the deferred panel, or a
      // follow-up (#1510).
      replied: false,
      deferred: false,
      reply: jest.fn(async () => {
        (mockInteraction as any).replied = true;
      }),
      deferReply: jest.fn(async () => {
        (mockInteraction as any).deferred = true;
      }),
      deferUpdate: jest.fn(async () => {
        (mockInteraction as any).deferred = true;
      }),
      editReply: jest.fn().mockResolvedValue(undefined),
      update: jest.fn(async () => {
        (mockInteraction as any).replied = true;
      }),
      followUp: jest.fn().mockResolvedValue(undefined),
      showModal: jest.fn().mockResolvedValue(undefined),
    } as any;
  });

  const setPresets = (presets: Array<{ name: string; isDefault: boolean }>) =>
    mockFindOne.mockResolvedValue({ presets } as never);

  describe("apply preset", () => {
    // The same object (not a spread copy), so the acknowledgement state the
    // fake tracks is the one the handler sees.
    const applyInteraction = (): StringSelectMenuInteraction =>
      Object.assign(mockInteraction, {
        customId: "vc_preset_apply_chan1_user1",
        values: ["0"],
      }) as unknown as StringSelectMenuInteraction;

    beforeEach(() => {
      Object.assign(mockChannel, {
        setName: jest.fn().mockResolvedValue(undefined),
        setUserLimit: jest.fn().mockResolvedValue(undefined),
        setBitrate: jest.fn().mockResolvedValue(undefined),
      });
    });

    it("does not report a skipped reserved name as applied", async () => {
      mockFindOne.mockResolvedValue({
        presets: [{ name: "Sneaky", channelName: "Lobby", userLimit: 4 }],
      } as never);
      mockIsReserved.mockResolvedValue(true);
      const i = applyInteraction();

      await handleVCPresetSelect(i);

      expect((mockChannel as any).setName).not.toHaveBeenCalled();
      expect((mockChannel as any).setUserLimit).toHaveBeenCalledWith(4);
      const arg = (i.editReply as jest.Mock).mock.calls[0][0] as {
        embeds: Array<{ data: { description: string } }>;
      };
      const text = arg.embeds[0].data.description;
      expect(text).not.toContain('name "Lobby"');
      expect(text).toContain("reserved");
    });

    it("refuses a former owner when a transfer lands before the locked apply", async () => {
      mockFindOne.mockResolvedValue({
        presets: [{ name: "Mine", channelName: "Cool", userLimit: 4 }],
      } as never);
      // Preflight (ensureOwnership) passes, the re-check inside the lock fails
      mockIsRoomOwner.mockReturnValueOnce(true).mockReturnValue(false);
      const i = applyInteraction();

      await handleVCPresetSelect(i);

      expect((mockChannel as any).setName).not.toHaveBeenCalled();
      expect((mockChannel as any).setUserLimit).not.toHaveBeenCalled();
      // The panel is replaced (deferUpdate on the ephemeral panel).
      expect(i.editReply).toHaveBeenCalledWith(
        errorEmbedPayload({
          title: "Only the room owner can use these controls",
        }),
      );
      expect(i.editReply).toHaveBeenCalledWith(
        expect.objectContaining({ components: [] }),
      );
    });

    it("acknowledges (deferUpdate) before the room lock is awaited", async () => {
      mockFindOne.mockResolvedValue({
        presets: [{ name: "Mine", channelName: "Cool" }],
      } as never);
      const order: string[] = [];
      const i = applyInteraction();
      (i.deferUpdate as jest.Mock).mockImplementation(async () => {
        order.push("defer");
      });
      jest.spyOn(VoiceChannelManager, "getInstance").mockReturnValue({
        isRoomOwner: mockIsRoomOwner,
        isReservedChannelName: mockIsReserved,
        runAsRoomOwner: async (
          _u: string,
          _c: string,
          work: () => Promise<void>,
        ) => {
          order.push("lock");
          await work();
          return true;
        },
      } as unknown as VoiceChannelManager);

      await handleVCPresetSelect(i);

      expect(order).toEqual(["defer", "lock"]);
    });
  });

  describe("live ownership (#1143)", () => {
    it("refuses a preset action from a user who no longer owns the room", async () => {
      setPresets([squadNight]);
      mockIsRoomOwner.mockReturnValue(false);
      mockInteraction.customId = `vc_preset_delete_0_${presetNameTag("Squad Night")}_chan1_user1`;

      await handleVCPresetButton(mockInteraction as ButtonInteraction);

      expect(mockService.deletePreset).not.toHaveBeenCalled();
      expect(mockInteraction.reply).toHaveBeenCalledWith(
        errorEmbedPayload({
          title: "Only the room owner can use these controls",
          description: expect.stringContaining("start your own room"),
        }),
      );
    });
  });

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
      expect(mockInteraction.reply).toHaveBeenCalledWith(
        errorEmbedPayload({
          title: "Your presets changed",
          description: expect.stringContaining("Reopen the presets panel"),
        }),
      );
    });

    it("refuses when the preset index no longer exists", async () => {
      setPresets([]);
      mockInteraction.customId = `vc_preset_delete_0_${presetNameTag("Squad Night")}_chan1_user1`;

      await handleVCPresetButton(mockInteraction as ButtonInteraction);

      expect(mockService.deletePreset).not.toHaveBeenCalled();
      expect(mockInteraction.reply).toHaveBeenCalledWith(
        errorEmbedPayload({ title: "Your presets changed" }),
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
        errorEmbedPayload({ title: "Your presets changed" }),
      );
    });
  });

  describe("failure replies (#1510)", () => {
    const click = (customId: string): Promise<void> => {
      mockInteraction.customId = customId;
      return handleVCPresetButton(mockInteraction as ButtonInteraction);
    };
    const sentEmbed = (
      mock: jest.Mock,
    ): { title: string; description: string } =>
      (
        mock.mock.calls[0][0] as {
          embeds: { data: { title: string; description: string } }[];
        }
      ).embeds[0].data;

    it("relays a VoicePrefsValidationError message, escaped, as the description", async () => {
      setPresets([squadNight]);
      mockService.setDefault.mockRejectedValue(
        new VoicePrefsValidationError("Preset no longer exists."),
      );

      await click(
        `vc_preset_default_0_${presetNameTag("Squad Night")}_chan1_user1`,
      );

      expect(mockInteraction.reply).toHaveBeenCalledWith(
        errorEmbedPayload({
          title: "Couldn't change the default preset",
          description: "Preset no longer exists.",
        }),
      );
    });

    it("keeps any other error's message out of the reply", async () => {
      setPresets([squadNight]);
      mockService.deletePreset.mockRejectedValue(
        new Error("MongoServerError: secret connection string"),
      );

      await click(
        `vc_preset_delete_0_${presetNameTag("Squad Night")}_chan1_user1`,
      );

      expect(mockInteraction.reply).toHaveBeenCalledWith(
        unexpectedErrorPayload(),
      );
      expect(
        JSON.stringify((mockInteraction.reply as jest.Mock).mock.calls),
      ).not.toContain("secret");
    });

    it("says the default was changed, with no retry advice, when the panel refresh fails after the write", async () => {
      setPresets([squadNight]);
      mockService.setDefault.mockResolvedValue({
        name: "Squad Night",
        isDefault: true,
      } as never);
      (mockInteraction.update as jest.Mock).mockRejectedValue(
        new Error("10062 Unknown interaction"),
      );

      await click(
        `vc_preset_default_0_${presetNameTag("Squad Night")}_chan1_user1`,
      );

      // Pressing the button again would flip the default back.
      expect(mockService.setDefault).toHaveBeenCalledTimes(1);
      const embed = sentEmbed(mockInteraction.reply as jest.Mock);
      expect(embed.title).toBe("Your default preset was changed");
      expect(embed.description).not.toMatch(/try again/i);
    });

    it("says the preset was deleted, with no retry advice, when the confirmation fails after the write", async () => {
      setPresets([squadNight, other]);
      mockService.deletePreset.mockResolvedValue({
        name: "Squad Night",
        remaining: 1,
      } as never);
      (mockInteraction.followUp as jest.Mock)
        .mockRejectedValueOnce(new Error("10062 Unknown interaction"))
        .mockResolvedValue(undefined);

      await click(
        `vc_preset_delete_0_${presetNameTag("Squad Night")}_chan1_user1`,
      );

      expect(mockService.deletePreset).toHaveBeenCalledTimes(1);
      // calls[0] is the confirmation that rejected; the error embed is the last.
      const calls = (mockInteraction.followUp as jest.Mock).mock.calls;
      const embed = (
        calls[calls.length - 1][0] as {
          embeds: { data: { title: string; description: string } }[];
        }
      ).embeds[0].data;
      expect(embed.title).toBe("Your preset was deleted");
      expect(embed.description).not.toMatch(/try again/i);
    });

    it.each([
      [
        "presets are switched off",
        "vc_preset_open_chan1_user1",
        false,
        "Presets are switched off",
      ],
      [
        "the action is unknown",
        "vc_preset_bogus_chan1_user1",
        true,
        "This control is out of date",
      ],
      [
        "the custom id cannot be read",
        "vc_preset",
        true,
        "This control is out of date",
      ],
    ])("answers when %s", async (_name, customId, enabled, title) => {
      jest
        .spyOn(ConfigService.prototype, "getBoolean")
        .mockResolvedValue(enabled);
      setPresets([squadNight]);

      await click(customId);

      expect(mockInteraction.reply).toHaveBeenCalledWith(
        errorEmbedPayload({ title }),
      );
    });

    it("tells a member with no presets what to do instead of opening Manage", async () => {
      setPresets([]);

      await click("vc_preset_manage_chan1_user1");

      expect(mockInteraction.update).not.toHaveBeenCalled();
      expect(mockInteraction.reply).toHaveBeenCalledWith(
        errorEmbedPayload({
          title: "You have no presets yet",
          description: expect.stringContaining("Save current as preset"),
        }),
      );
    });

    it("replaces the apply panel when the chosen preset is gone", async () => {
      setPresets([]);
      const i = Object.assign(mockInteraction, {
        customId: "vc_preset_apply_chan1_user1",
        values: ["0"],
      }) as unknown as StringSelectMenuInteraction;

      await handleVCPresetSelect(i);

      expect(i.editReply).toHaveBeenCalledWith(
        errorEmbedPayload({ title: "That preset no longer exists" }),
      );
      expect(i.editReply).toHaveBeenCalledWith(
        expect.objectContaining({ components: [] }),
      );
    });

    it("answers the catch-all after the panel was acknowledged with a follow-up", async () => {
      setPresets([squadNight]);
      (mockInteraction.update as jest.Mock).mockImplementation(async () => {
        (mockInteraction as any).replied = true;
        throw new Error("boom");
      });

      await click("vc_preset_back_chan1_user1");

      expect(mockInteraction.followUp).toHaveBeenCalledWith(
        unexpectedErrorPayload(),
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
        errorEmbedPayload({ title: "Your presets changed" }),
      );
    });
  });

  describe("hostile preset channel name (#1146)", () => {
    const HOSTILE = "[click](https://evil.example) <@555> @everyone **b**";
    const hostilePreset = {
      name: "Plain",
      isDefault: false,
      channelName: HOSTILE,
      userLimit: 4,
    };

    const expectEscaped = (text: string): void => {
      expect(text).not.toContain("[click](");
      expect(text).not.toContain("<@555>");
      expect(text).not.toContain("@everyone");
      expect(text).toContain("\\[click\\](https://evil.example)");
      expect(text).toContain("\\<@555\\>");
      expect(text).toContain("\\*\\*b\\*\\*");
    };

    type Panel = {
      embeds: Array<{ data: { description: string } }>;
      components: Array<{
        components: Array<{
          options?: Array<{ data: { description: string } }>;
        }>;
      }>;
    };

    // Select descriptions are plain text in Discord, so they stay unescaped.
    const expectPlainSelect = (panel: Panel): void => {
      const select = panel.components
        .flatMap((row) => row.components)
        .find((c) => c.options);
      const description = select!.options![0].data.description;
      expect(description).toContain(`name "${HOSTILE}"`);
      expect(description).not.toContain("\\[");
    };

    it("escapes it in the apply panel embed and keeps the select plain", async () => {
      setPresets([hostilePreset] as never);
      const i = {
        ...mockInteraction,
        customId: "vc_preset_open_chan1_user1",
      } as unknown as ButtonInteraction;

      await handleVCPresetButton(i);

      const panel = (i.reply as jest.Mock).mock.calls[0][0] as Panel;
      expectEscaped(panel.embeds[0].data.description);
      expectPlainSelect(panel);
    });

    it("escapes it in the manage panel embed and keeps the select plain", async () => {
      setPresets([hostilePreset] as never);
      const i = {
        ...mockInteraction,
        customId: "vc_preset_pick_chan1_user1",
        values: ["0"],
      } as unknown as StringSelectMenuInteraction;

      await handleVCPresetSelect(i);

      const panel = (i.update as jest.Mock).mock.calls[0][0] as Panel;
      expectEscaped(panel.embeds[0].data.description);
      expectPlainSelect(panel);
    });

    it("escapes it in the preset-applied embed", async () => {
      setPresets([hostilePreset] as never);
      Object.assign(mockChannel, {
        setName: jest.fn().mockResolvedValue(undefined),
        setUserLimit: jest.fn().mockResolvedValue(undefined),
        setBitrate: jest.fn().mockResolvedValue(undefined),
      });
      const i = {
        ...mockInteraction,
        customId: "vc_preset_apply_chan1_user1",
        values: ["0"],
      } as unknown as StringSelectMenuInteraction;

      await handleVCPresetSelect(i);

      const arg = (i.editReply as jest.Mock).mock.calls[0][0] as Panel;
      expectEscaped(arg.embeds[0].data.description);
    });
  });

  describe("hostile preset name (#1146)", () => {
    const HOSTILE = "[x](https://evil.example) <@555> @everyone **b**";
    const preset = { name: HOSTILE, isDefault: false, userLimit: 4 };

    const expectEscaped = (text: string): void => {
      expect(text).not.toContain("[x](");
      expect(text).not.toContain("<@555>");
      expect(text).not.toContain("@everyone");
      expect(text).toContain("\\[x\\](https://evil.example)");
      expect(text).toContain("\\<@555\\>");
      expect(text).toContain("\\*\\*b\\*\\*");
    };

    type Embedded = { embeds: Array<{ data: { description: string } }> };
    const followUpContent = (): string =>
      (
        (mockInteraction.followUp as jest.Mock).mock.calls[0][0] as {
          content: string;
        }
      ).content;

    it("escapes it in the apply panel", async () => {
      setPresets([preset]);
      const i = {
        ...mockInteraction,
        customId: "vc_preset_open_chan1_user1",
      } as unknown as ButtonInteraction;
      await handleVCPresetButton(i);
      expectEscaped(
        ((i.reply as jest.Mock).mock.calls[0][0] as Embedded).embeds[0].data
          .description,
      );
    });

    it("escapes it in the manage panel's selected line", async () => {
      setPresets([preset]);
      const i = {
        ...mockInteraction,
        customId: "vc_preset_pick_chan1_user1",
        values: ["0"],
      } as unknown as StringSelectMenuInteraction;
      await handleVCPresetSelect(i);
      expectEscaped(
        ((i.update as jest.Mock).mock.calls[0][0] as Embedded).embeds[0].data
          .description,
      );
    });

    it("escapes it in the preset-applied embed", async () => {
      setPresets([preset]);
      Object.assign(mockChannel, {
        setName: jest.fn().mockResolvedValue(undefined),
        setUserLimit: jest.fn().mockResolvedValue(undefined),
        setBitrate: jest.fn().mockResolvedValue(undefined),
      });
      const i = {
        ...mockInteraction,
        customId: "vc_preset_apply_chan1_user1",
        values: ["0"],
      } as unknown as StringSelectMenuInteraction;
      await handleVCPresetSelect(i);
      expectEscaped(
        ((i.editReply as jest.Mock).mock.calls[0][0] as Embedded).embeds[0].data
          .description,
      );
    });

    it("escapes it in the set-default confirmation", async () => {
      setPresets([preset]);
      mockService.setDefault.mockResolvedValue({
        name: HOSTILE,
        isDefault: true,
      } as never);
      mockInteraction.customId = `vc_preset_default_0_${presetNameTag(HOSTILE)}_chan1_user1`;
      await handleVCPresetButton(mockInteraction as ButtonInteraction);
      expectEscaped(followUpContent());
    });

    it("escapes it in the delete confirmation", async () => {
      setPresets([preset]);
      mockService.deletePreset.mockResolvedValue({
        name: HOSTILE,
        remaining: 1,
      } as never);
      mockInteraction.customId = `vc_preset_delete_0_${presetNameTag(HOSTILE)}_chan1_user1`;
      await handleVCPresetButton(mockInteraction as ButtonInteraction);
      expectEscaped(followUpContent());
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
