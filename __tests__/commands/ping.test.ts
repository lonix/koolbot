import { describe, it, expect, jest, beforeEach } from "@jest/globals";
import { data, execute } from "../../src/commands/ping.js";
import type { ChatInputCommandInteraction, Message, Client } from "discord.js";

// Mock logger
jest.mock("../../src/utils/logger.js");

describe("Ping Command", () => {
  describe("command metadata", () => {
    it("should have correct command name", () => {
      expect(data.name).toBe("ping");
    });

    it("should have a description", () => {
      expect(data.description).toBe("Replies with Pong!");
    });

    it("should be a valid slash command", () => {
      expect(data.toJSON()).toHaveProperty("name", "ping");
      expect(data.toJSON()).toHaveProperty("description", "Replies with Pong!");
    });
  });

  describe("execute", () => {
    let mockInteraction: Partial<ChatInputCommandInteraction>;
    let mockMessage: Partial<Message>;
    let mockClient: Partial<Client>;

    beforeEach(() => {
      jest.clearAllMocks();

      mockClient = {
        ws: {
          ping: 50,
        } as any,
      };

      mockMessage = {
        createdTimestamp: 1000,
      };

      mockInteraction = {
        createdTimestamp: 900,
        client: mockClient as Client,
        replied: false,
        deferred: false,
        reply: jest.fn().mockResolvedValue(mockMessage),
        editReply: jest.fn().mockResolvedValue(undefined),
        followUp: jest.fn().mockResolvedValue(undefined),
      };
    });

    it("should reply with latency information", async () => {
      await execute(mockInteraction as ChatInputCommandInteraction);

      expect(mockInteraction.reply).toHaveBeenCalledWith({
        content: "Pinging...",
        fetchReply: true,
      });

      expect(mockInteraction.editReply).toHaveBeenCalledWith(
        expect.stringContaining("Pong! 🏓"),
      );
      expect(mockInteraction.editReply).toHaveBeenCalledWith(
        expect.stringContaining("Bot Latency: 100ms"),
      );
      expect(mockInteraction.editReply).toHaveBeenCalledWith(
        expect.stringContaining("API Latency: 50ms"),
      );
    });

    it("should calculate correct bot latency", async () => {
      mockInteraction.createdTimestamp = 500;
      (mockMessage as any).createdTimestamp = 750;

      await execute(mockInteraction as ChatInputCommandInteraction);

      expect(mockInteraction.editReply).toHaveBeenCalledWith(
        expect.stringContaining("Bot Latency: 250ms"),
      );
    });

    it("should handle API latency from WebSocket", async () => {
      mockClient.ws = { ping: 125 } as any;

      await execute(mockInteraction as ChatInputCommandInteraction);

      expect(mockInteraction.editReply).toHaveBeenCalledWith(
        expect.stringContaining("API Latency: 125ms"),
      );
    });

    it("should handle very low latency", async () => {
      mockInteraction.createdTimestamp = 999;
      (mockMessage as any).createdTimestamp = 1000;
      mockClient.ws = { ping: 1 } as any;

      await execute(mockInteraction as ChatInputCommandInteraction);

      expect(mockInteraction.editReply).toHaveBeenCalledWith(
        expect.stringContaining("Bot Latency: 1ms"),
      );
    });

    it("should follow up with an error message when editReply fails after the reply succeeded", async () => {
      (mockInteraction.reply as jest.Mock).mockImplementation(async () => {
        (mockInteraction as any).replied = true;
        return mockMessage;
      });
      (mockInteraction.editReply as jest.Mock).mockRejectedValue(
        new Error("editReply failed") as never,
      );

      await execute(mockInteraction as ChatInputCommandInteraction);

      expect(mockInteraction.followUp).toHaveBeenCalledWith({
        content: "There was an error while executing this command!",
        ephemeral: true,
      });
      expect(mockInteraction.reply).toHaveBeenCalledTimes(1);
    });

    it("should reply with an error message when the initial reply fails", async () => {
      (mockInteraction.reply as jest.Mock)
        .mockRejectedValueOnce(new Error("reply failed") as never)
        .mockResolvedValueOnce(undefined as never);

      await execute(mockInteraction as ChatInputCommandInteraction);

      expect(mockInteraction.reply).toHaveBeenCalledTimes(2);
      expect(mockInteraction.reply).toHaveBeenLastCalledWith({
        content: "There was an error while executing this command!",
        ephemeral: true,
      });
      expect(mockInteraction.followUp).not.toHaveBeenCalled();
    });
  });
});
