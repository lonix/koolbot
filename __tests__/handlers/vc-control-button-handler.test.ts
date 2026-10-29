import { describe, it, expect, jest, beforeEach } from "@jest/globals";
import {
  ChannelType,
  type ButtonInteraction,
  type Guild,
  type VoiceChannel,
  type Client,
} from "discord.js";

// Mock dependencies before importing
jest.mock("../../src/utils/logger.js");
jest.mock("../../src/services/voice-channel-manager.js");

// Import after mocks
import { VoiceChannelManager } from "../../src/services/voice-channel-manager.js";
import { handleVCControlButton } from "../../src/handlers/vc-control-button-handler.js";
import { errorEmbedPayload, unexpectedErrorPayload } from "../test-utils.js";

const mockVoiceChannelManager = VoiceChannelManager as jest.Mocked<
  typeof VoiceChannelManager
>;

const HOSTILE_NAME = "<@555> @everyone [free](https://evil.example) **b**";

/** The reply names the member or room as a mention and never echoes the name. */
function expectNeutralName(text: string, mention: string): void {
  expect(text).not.toContain("<@555>");
  expect(text).not.toContain("@everyone");
  expect(text).not.toContain("[free](");
  expect(text).not.toContain("**b**");
  expect(text).toContain(mention);
}

describe("VCControlButtonHandler", () => {
  let mockInteraction: Partial<ButtonInteraction>;
  let mockGuild: Partial<Guild>;
  let mockChannel: Partial<VoiceChannel>;
  let mockManagerInstance: {
    toggleLive: jest.Mock;
    getWaitingRoom: jest.Mock;
    createWaitingRoom: jest.Mock;
    removeWaitingRoom: jest.Mock;
    rebuildControlPanel: jest.Mock;
    getUserChannel: jest.Mock;
    isRoomOwner: jest.Mock;
    runAsRoomOwner: jest.Mock;
  };

  beforeEach(() => {
    jest.clearAllMocks();

    mockManagerInstance = {
      toggleLive: jest.fn().mockResolvedValue(true),
      getWaitingRoom: jest.fn().mockReturnValue(undefined),
      createWaitingRoom: jest
        .fn()
        .mockResolvedValue({ name: "⏳ Test Waiting" }),
      removeWaitingRoom: jest.fn().mockResolvedValue(undefined),
      rebuildControlPanel: jest.fn().mockResolvedValue(undefined),
      getUserChannel: jest.fn().mockReturnValue({ id: "channel-id" }),
      // Live ownership, derived from the same registry mock as getUserChannel
      runAsRoomOwner: jest.fn(
        async (
          userId: string,
          channelId: string,
          work: () => Promise<void>,
        ) => {
          if (!mockManagerInstance.isRoomOwner(userId, channelId)) return false;
          await work();
          return true;
        },
      ),
      isRoomOwner: jest.fn(
        (userId: string, channelId: string) =>
          (
            mockManagerInstance.getUserChannel(userId) as
              { id: string } | undefined
          )?.id === channelId,
      ),
    };

    (mockVoiceChannelManager.getInstance as unknown as jest.Mock) = jest.fn(
      () => mockManagerInstance,
    );

    mockChannel = {
      id: "channel-id",
      name: "Test Channel",
      type: ChannelType.GuildVoice,
      setName: jest.fn().mockResolvedValue(undefined),
      send: jest.fn().mockResolvedValue(undefined),
      permissionOverwrites: {
        cache: { get: jest.fn().mockReturnValue(undefined) },
        delete: jest.fn().mockResolvedValue(undefined),
        create: jest.fn().mockResolvedValue(undefined),
      } as any,
      guild: {
        roles: { everyone: { id: "everyone-role-id" } },
      } as any,
      parent: null,
    } as any;

    mockGuild = {
      id: "guild-id",
      channels: {
        fetch: jest.fn().mockResolvedValue(mockChannel),
      } as any,
      members: {
        fetch: jest.fn().mockResolvedValue({
          displayName: "WaitingUser",
          id: "waiting-user-id",
          voice: {
            channelId: "waiting-room-id",
            setChannel: jest.fn().mockResolvedValue(undefined),
          },
        }),
      } as any,
    } as any;

    mockInteraction = {
      customId: "vc_control_live_channel-id_owner-id",
      user: {
        id: "owner-id",
        displayName: "OwnerUser",
      } as any,
      // Like discord.js, acknowledging flips the state that decides whether a
      // failure is a fresh reply or an edit of the deferred response (#1510).
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
      message: {
        edit: jest.fn().mockResolvedValue(undefined),
      } as any,
      client: {} as any as Client,
    } as any;
  });

  describe("Owner check", () => {
    it("should reject non-owner interaction", async () => {
      mockInteraction.user = {
        id: "other-user-id",
        displayName: "Other",
      } as any;

      await handleVCControlButton(mockInteraction as ButtonInteraction);

      expect(mockInteraction.reply).toHaveBeenCalledWith(
        errorEmbedPayload({
          title: "Only the room owner can use these controls",
          description: expect.stringContaining("start your own room"),
        }),
      );
    });
  });

  describe("Live ownership (#1143)", () => {
    it("rejects the previous owner whose customId still names them", async () => {
      // Ownership moved to someone else: the registry no longer maps this user
      // to the channel, but the (stale) button still carries their id.
      mockManagerInstance.getUserChannel.mockReturnValue(undefined);
      mockInteraction.customId = "vc_control_waitingroom_channel-id_owner-id";

      await handleVCControlButton(mockInteraction as ButtonInteraction);

      expect(mockInteraction.reply).toHaveBeenCalledWith(
        errorEmbedPayload({
          title: "Only the room owner can use these controls",
          description: expect.stringContaining("start your own room"),
        }),
      );
      expect(mockManagerInstance.createWaitingRoom).not.toHaveBeenCalled();
      expect(mockManagerInstance.toggleLive).not.toHaveBeenCalled();
    });

    it("opens the rename form with sentence-case copy (#1519)", async () => {
      mockInteraction.customId = "vc_control_name_channel-id_owner-id";
      (mockInteraction as any).showModal = jest.fn();

      await handleVCControlButton(mockInteraction as ButtonInteraction);

      const modal = (
        mockInteraction as any
      ).showModal.mock.calls[0][0].toJSON();
      expect(modal.title).toBe("Rename channel");
      expect(modal.components[0].components[0]).toMatchObject({
        label: "Channel name",
        placeholder: "New channel name",
      });
    });

    it("rejects a stale rename button before opening the modal", async () => {
      mockManagerInstance.getUserChannel.mockReturnValue({
        id: "some-other-channel",
      });
      mockInteraction.customId = "vc_control_name_channel-id_owner-id";
      (mockInteraction as any).showModal = jest.fn();

      await handleVCControlButton(mockInteraction as ButtonInteraction);

      expect((mockInteraction as any).showModal).not.toHaveBeenCalled();
    });

    it("rejects a stale privacy button without touching permissions", async () => {
      mockManagerInstance.getUserChannel.mockReturnValue(undefined);
      mockInteraction.customId = "vc_control_privacy_channel-id_owner-id";

      await handleVCControlButton(mockInteraction as ButtonInteraction);

      expect(
        (mockChannel.permissionOverwrites as any).create,
      ).not.toHaveBeenCalled();
      expect(
        (mockChannel.permissionOverwrites as any).delete,
      ).not.toHaveBeenCalled();
    });
  });

  describe("Transfer racing a mutation (#1143)", () => {
    it("refuses privacy when a transfer lands after the preflight but before the locked mutation", async () => {
      // Preflight sees the clicker as owner; by the time the room lock is
      // acquired, a transfer has moved the room.
      mockManagerInstance.isRoomOwner
        .mockReturnValueOnce(true)
        .mockReturnValue(false);
      mockInteraction.customId = "vc_control_privacy_channel-id_owner-id";

      await handleVCControlButton(mockInteraction as ButtonInteraction);

      expect(
        (mockChannel.permissionOverwrites as any).create,
      ).not.toHaveBeenCalled();
      expect(
        (mockChannel.permissionOverwrites as any).delete,
      ).not.toHaveBeenCalled();
      // privacy is a locked action: the click was deferred, so the refusal
      // edits the ephemeral reply.
      expect(mockInteraction.deferReply).toHaveBeenCalled();
      expect(mockInteraction.editReply).toHaveBeenCalledWith(
        errorEmbedPayload({
          title: "Only the room owner can use these controls",
        }),
      );
    });

    it("refuses go-live and waiting room under the same race", async () => {
      for (const action of ["live", "waitingroom"]) {
        mockManagerInstance.isRoomOwner
          .mockReturnValueOnce(true)
          .mockReturnValue(false);
        mockInteraction.customId = `vc_control_${action}_channel-id_owner-id`;
        await handleVCControlButton(mockInteraction as ButtonInteraction);
      }
      expect(mockManagerInstance.toggleLive).not.toHaveBeenCalled();
      expect(mockManagerInstance.createWaitingRoom).not.toHaveBeenCalled();
    });
  });

  describe("Deferral and let-in race (#1143)", () => {
    it("defers before the room lock is awaited for privacy/live/waitingroom/letin", async () => {
      const ids = [
        "vc_control_privacy_channel-id_owner-id",
        "vc_control_live_channel-id_owner-id",
        "vc_control_waitingroom_channel-id_owner-id",
        "vc_control_letin_channel-id_waiting-user-id_owner-id",
      ];
      for (const id of ids) {
        const order: string[] = [];
        (mockInteraction.deferReply as jest.Mock) = jest
          .fn()
          .mockImplementation(async () => {
            order.push("defer");
          });
        mockManagerInstance.runAsRoomOwner.mockImplementationOnce(async () => {
          order.push("lock");
          return true;
        });
        mockInteraction.customId = id;
        await handleVCControlButton(mockInteraction as ButtonInteraction);
        expect(order).toEqual(["defer", "lock"]);
      }
    });

    it("moves nobody when a transfer lands after the let-in preflight", async () => {
      const setChannel = jest.fn();
      (mockGuild.members!.fetch as jest.Mock).mockResolvedValue({
        displayName: "WaitingUser",
        voice: { channelId: "waiting-room-id", setChannel },
      } as never);
      mockManagerInstance.getWaitingRoom.mockReturnValue("waiting-room-id");
      // Ownership is only re-checked inside the lock
      mockManagerInstance.isRoomOwner.mockReturnValue(false);
      mockInteraction.customId =
        "vc_control_letin_channel-id_waiting-user-id_owner-id";

      await handleVCControlButton(mockInteraction as ButtonInteraction);

      expect(setChannel).not.toHaveBeenCalled();
    });
  });

  describe("Failure replies (#1510)", () => {
    it("edits the deferred reply with the generic embed when a locked action throws", async () => {
      mockManagerInstance.toggleLive.mockRejectedValue(new Error("db down"));
      mockInteraction.customId = "vc_control_live_channel-id_owner-id";

      await handleVCControlButton(mockInteraction as ButtonInteraction);

      expect(mockInteraction.editReply).toHaveBeenCalledWith(
        unexpectedErrorPayload(),
      );
      expect(mockInteraction.reply).not.toHaveBeenCalled();
    });

    it("makes no retry promise when the owner overwrite fails after the @everyone deny", async () => {
      (mockGuild as any).roles = { everyone: { id: "everyone-role-id" } };
      const create = (mockChannel.permissionOverwrites as any)
        .create as jest.Mock;
      create
        .mockResolvedValueOnce(undefined)
        .mockRejectedValueOnce(new Error("Missing Permissions"));
      mockInteraction.customId = "vc_control_privacy_channel-id_owner-id";

      await handleVCControlButton(mockInteraction as ButtonInteraction);

      expect(create).toHaveBeenCalledTimes(2);
      const sent = (mockInteraction.editReply as jest.Mock).mock.calls
        .map(
          (c) =>
            (
              c[0] as {
                embeds?: { data: { title: string; description: string } }[];
              }
            ).embeds?.[0]?.data,
        )
        .filter(Boolean);
      expect(sent).toHaveLength(1);
      expect(sent[0]!.title).toMatch(/private/i);
      expect(sent[0]!.description).toMatch(/check the room's permissions/i);
      expect(`${sent[0]!.title} ${sent[0]!.description}`).not.toMatch(
        /try again/i,
      );
    });

    it("keeps the generic reply when the first privacy write fails (nothing changed)", async () => {
      (mockGuild as any).roles = { everyone: { id: "everyone-role-id" } };
      const create = (mockChannel.permissionOverwrites as any)
        .create as jest.Mock;
      create.mockRejectedValueOnce(new Error("Missing Permissions"));
      mockInteraction.customId = "vc_control_privacy_channel-id_owner-id";

      await handleVCControlButton(mockInteraction as ButtonInteraction);

      expect(create).toHaveBeenCalledTimes(1);
      expect(mockInteraction.editReply).toHaveBeenCalledWith(
        unexpectedErrorPayload(),
      );
    });

    it("answers an unknown action as out of date, not as an internal state", async () => {
      mockInteraction.customId = "vc_control_bogus_channel-id_owner-id";

      await handleVCControlButton(mockInteraction as ButtonInteraction);

      expect(mockInteraction.reply).toHaveBeenCalledWith(
        errorEmbedPayload({
          title: "This control is out of date",
          description: "Use the newest controls in your channel.",
        }),
      );
    });

    it("answers a custom id it cannot read as out of date", async () => {
      mockInteraction.customId = "vc_control_live";

      await handleVCControlButton(mockInteraction as ButtonInteraction);

      expect(mockInteraction.reply).toHaveBeenCalledWith(
        errorEmbedPayload({ title: "This control is out of date" }),
      );
    });

    it("says the room is gone when its channel no longer exists", async () => {
      (mockGuild.channels!.fetch as jest.Mock).mockResolvedValue(null);
      mockInteraction.customId = "vc_control_live_channel-id_owner-id";

      await handleVCControlButton(mockInteraction as ButtonInteraction);

      expect(mockInteraction.editReply).toHaveBeenCalledWith(
        errorEmbedPayload({ title: "This voice channel is gone" }),
      );
    });

    it("names the member in the description, never the title, when a move fails", async () => {
      mockManagerInstance.getWaitingRoom.mockReturnValue("waiting-room-id");
      mockInteraction.customId =
        "vc_control_letin_channel-id_waiting-user-id_owner-id";
      (mockGuild.members!.fetch as jest.Mock).mockResolvedValue({
        id: "waiting-user-id",
        voice: {
          channelId: "waiting-room-id",
          setChannel: jest.fn().mockRejectedValue(new Error("Missing Access")),
        },
      });

      await handleVCControlButton(mockInteraction as ButtonInteraction);

      expect(mockInteraction.editReply).toHaveBeenCalledWith(
        errorEmbedPayload({
          title: "Couldn't move that member into your room",
          description: expect.stringContaining("<@waiting-user-id>"),
        }),
      );
    });
  });

  describe("Live toggle", () => {
    it("should delegate to manager.toggleLive and report LIVE when going live", async () => {
      mockManagerInstance.toggleLive.mockResolvedValue(true);
      mockInteraction.customId = "vc_control_live_channel-id_owner-id";

      await handleVCControlButton(mockInteraction as ButtonInteraction);

      expect(mockManagerInstance.toggleLive).toHaveBeenCalledWith(mockChannel);
      expect(mockInteraction.editReply).toHaveBeenCalledWith(
        expect.objectContaining({ content: expect.stringContaining("LIVE") }),
      );
    });

    it("should delegate to manager.toggleLive and report offline when going offline", async () => {
      mockManagerInstance.toggleLive.mockResolvedValue(false);
      mockInteraction.customId = "vc_control_live_channel-id_owner-id";

      await handleVCControlButton(mockInteraction as ButtonInteraction);

      expect(mockManagerInstance.toggleLive).toHaveBeenCalledWith(mockChannel);
      expect(mockInteraction.editReply).toHaveBeenCalledWith(
        expect.objectContaining({
          content: expect.stringContaining("offline"),
        }),
      );
    });
  });

  describe("Waiting room toggle", () => {
    it("should create waiting room when none exists", async () => {
      mockManagerInstance.getWaitingRoom.mockReturnValue(undefined);
      mockInteraction.customId = "vc_control_waitingroom_channel-id_owner-id";

      await handleVCControlButton(mockInteraction as ButtonInteraction);

      expect(mockManagerInstance.createWaitingRoom).toHaveBeenCalledWith(
        mockChannel,
        "owner-id",
      );
      expect(mockInteraction.editReply).toHaveBeenCalledWith(
        expect.objectContaining({
          content: expect.stringContaining("Waiting room"),
        }),
      );
    });

    it("should remove waiting room when one exists", async () => {
      mockManagerInstance.getWaitingRoom.mockReturnValue(
        "existing-waiting-room-id",
      );
      mockInteraction.customId = "vc_control_waitingroom_channel-id_owner-id";

      await handleVCControlButton(mockInteraction as ButtonInteraction);

      expect(mockManagerInstance.removeWaitingRoom).toHaveBeenCalledWith(
        "channel-id",
      );
      expect(mockInteraction.editReply).toHaveBeenCalledWith(
        expect.objectContaining({
          content: expect.stringContaining("removed"),
        }),
      );
    });
  });

  describe("Let In action", () => {
    it("should reject non-owner let-in attempt (stale button check)", async () => {
      mockInteraction.customId =
        "vc_control_letin_channel-id_waiting-user-id_owner-id";
      mockInteraction.user = {
        id: "someone-else",
        displayName: "Other",
      } as any;

      await handleVCControlButton(mockInteraction as ButtonInteraction);

      expect(mockInteraction.reply).toHaveBeenCalledWith(
        errorEmbedPayload({
          title: "Only the room owner can let people in",
          description: expect.stringContaining("start your own room"),
        }),
      );
    });

    it("should reject if user is no longer the current owner", async () => {
      // getUserChannel returns a different channel (ownership transferred)
      mockManagerInstance.getUserChannel.mockReturnValue({
        id: "different-channel-id",
      });
      mockManagerInstance.getWaitingRoom.mockReturnValue("waiting-room-id");
      mockInteraction.customId =
        "vc_control_letin_channel-id_waiting-user-id_owner-id";
      mockInteraction.user = { id: "owner-id", displayName: "Owner" } as any;

      await handleVCControlButton(mockInteraction as ButtonInteraction);

      expect(mockInteraction.editReply).toHaveBeenCalledWith(
        errorEmbedPayload({ title: "Only the room owner can let people in" }),
      );
    });

    it("should reject if waiting room no longer exists", async () => {
      mockManagerInstance.getUserChannel.mockReturnValue({ id: "channel-id" });
      mockManagerInstance.getWaitingRoom.mockReturnValue(undefined);
      mockInteraction.customId =
        "vc_control_letin_channel-id_waiting-user-id_owner-id";
      mockInteraction.user = { id: "owner-id", displayName: "Owner" } as any;

      await handleVCControlButton(mockInteraction as ButtonInteraction);

      expect(mockInteraction.editReply).toHaveBeenCalledWith(
        errorEmbedPayload({
          title: "The waiting room is gone",
          description: expect.stringContaining("create a new one"),
        }),
      );
    });

    it("names the waiting user as a mention in the let-in confirmation (#1146)", async () => {
      mockManagerInstance.getUserChannel.mockReturnValue({ id: "channel-id" });
      mockManagerInstance.getWaitingRoom.mockReturnValue("waiting-room-id");
      mockInteraction.customId =
        "vc_control_letin_channel-id_waiting-user-id_owner-id";
      (mockGuild.members!.fetch as jest.Mock).mockResolvedValue({
        displayName: HOSTILE_NAME,
        id: "waiting-user-id",
        voice: {
          channelId: "waiting-room-id",
          setChannel: jest.fn().mockResolvedValue(undefined),
        },
      });

      await handleVCControlButton(mockInteraction as ButtonInteraction);

      const sent = [
        ...(mockInteraction.reply as jest.Mock).mock.calls,
        ...(mockInteraction.editReply as jest.Mock).mock.calls,
      ].map((call) => (call[0] as { content: string }).content);
      const confirmation = sent.find((c) => c.includes("let into the channel"));
      expect(confirmation).toBeDefined();
      expectNeutralName(confirmation!, "<@waiting-user-id>");
    });

    it("names a new waiting room as a mention, never by name (#1146)", async () => {
      mockManagerInstance.getWaitingRoom.mockReturnValue(undefined);
      mockManagerInstance.createWaitingRoom.mockResolvedValue({
        id: "waiting-room-new",
        name: HOSTILE_NAME,
      });
      mockInteraction.customId = "vc_control_waitingroom_channel-id_owner-id";

      await handleVCControlButton(mockInteraction as ButtonInteraction);

      const sent = [
        ...(mockInteraction.reply as jest.Mock).mock.calls,
        ...(mockInteraction.editReply as jest.Mock).mock.calls,
      ].map((call) => (call[0] as { content: string }).content);
      const created = sent.find((c) => c.includes("Waiting room"));
      expect(created).toBeDefined();
      expectNeutralName(created!, "<#waiting-room-new>");
    });

    it("should move user when owner is valid and user is in waiting room", async () => {
      mockManagerInstance.getUserChannel.mockReturnValue({ id: "channel-id" });
      mockManagerInstance.getWaitingRoom.mockReturnValue("waiting-room-id");
      mockInteraction.customId =
        "vc_control_letin_channel-id_waiting-user-id_owner-id";
      mockInteraction.user = { id: "owner-id", displayName: "Owner" } as any;

      await handleVCControlButton(mockInteraction as ButtonInteraction);

      // Should fetch the main channel
      expect(mockGuild!.channels!.fetch).toHaveBeenCalledWith("channel-id");
    });
  });
});
