import { Client, Message } from "discord.js";
import logger from "../utils/logger.js";

/**
 * Passive friendship listener.
 * Listens for users asking about the "best ship" or "worst ship" and replies.
 */
export class FriendshipListener {
  private static instance: FriendshipListener;
  private readonly client: Client;
  private readonly channelCooldownMs = 30_000; // 30s per channel
  private lastSent: Map<string, number> = new Map();

  private constructor(client: Client) {
    this.client = client;
  }

  public static getInstance(client: Client): FriendshipListener {
    if (!FriendshipListener.instance) {
      FriendshipListener.instance = new FriendshipListener(client);
    }
    return FriendshipListener.instance;
  }

  public initialize(): void {
    this.client.on("messageCreate", (message) => this.handleMessage(message));
    logger.info("Friendship listener initialized");
  }

  private handleMessage(message: Message): void {
    if (message.author.bot) return; // ignore bots
    if (!message.content) return;
    if (!message.guild) return; // guild text only

    const content = message.content.toLowerCase();

    const bestTriggers = [
      "best ship",
      "best eve ship",
      "best eve online ship",
      "what is the best ship",
      "what's the best ship",
    ];
    const worstTriggers = [
      "worst ship",
      "worst eve ship",
      "worst eve online ship",
      "what is the worst ship",
      "what's the worst ship",
    ];

    const isBest = bestTriggers.some((t) => content.includes(t));
    const isWorst = worstTriggers.some((t) => content.includes(t));
    if (!isBest && !isWorst) return;

    // Channel cooldown logic
    const channelId = message.channel.id;
    const now = Date.now();
    const last = this.lastSent.get(channelId) || 0;
    if (now - last < this.channelCooldownMs) {
      logger.debug(
        `Friendship listener cooldown active for channel ${channelId}, suppressing reply`,
      );
      return;
    }

    const reply = isBest
      ? "<3 The best ship is friendship <3"
      : "I don't know what the worst ship is, but the best ship is friendship <3";

    message
      .reply(reply)
      .then(() => this.lastSent.set(channelId, now))
      .catch((err) => logger.error("Error sending friendship reply", err));
  }
}

export default FriendshipListener;
