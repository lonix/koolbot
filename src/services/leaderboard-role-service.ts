import {
  Client,
  Guild,
  GuildMember,
  Role,
  TextChannel,
  EmbedBuilder,
} from "discord.js";
import { CronJob, CronTime } from "cron";
import { ConfigService } from "./config-service.js";
import { VoiceChannelTracker, TimePeriod } from "./voice-channel-tracker.js";
import logger from "../utils/logger.js";

interface ParsedTier {
  topN: number;
  roleId: string;
}

export interface LeaderboardRoleRunSummary {
  ranAt: Date;
  period: TimePeriod;
  tiers: Array<{
    topN: number;
    roleId: string;
    roleName: string;
    added: string[]; // user IDs that gained the role
    removed: string[]; // user IDs that lost the role
    skippedReason?: string;
  }>;
}

export class LeaderboardRoleService {
  private static instance: LeaderboardRoleService;
  private client: Client;
  private configService: ConfigService;
  private job: CronJob | null = null;
  private isInitialized: boolean = false;

  private constructor(client: Client) {
    this.client = client;
    this.configService = ConfigService.getInstance();

    this.configService.registerReloadCallback(async () => {
      try {
        logger.info(
          "Leaderboard role rewards configuration changed, reloading...",
        );

        const enabled = await this.configService.getBoolean(
          "leaderboard_roles.enabled",
          false,
        );

        if (!enabled && this.isInitialized) {
          logger.info(
            "Leaderboard role rewards disabled, stopping cron job...",
          );
          this.destroy();
        } else if (enabled) {
          await this.reload();
        }
      } catch (error) {
        logger.error(
          "Error reloading leaderboard role rewards after configuration change:",
          error,
        );
      }
    });
  }

  public static getInstance(client: Client): LeaderboardRoleService {
    if (!LeaderboardRoleService.instance) {
      LeaderboardRoleService.instance = new LeaderboardRoleService(client);
    }
    return LeaderboardRoleService.instance;
  }

  private validateCronExpression(expression: string): boolean {
    try {
      const cleanExpression = expression.replace(/^["']|["']$/g, "");
      new CronTime(cleanExpression);
      return true;
    } catch (error) {
      logger.error(
        `Invalid cron expression for leaderboard roles: ${expression}`,
        error,
      );
      return false;
    }
  }

  /**
   * Parse the tiers config string into [{ topN, roleId }] sorted ascending by topN.
   * Format: "1:roleId1,3:roleId2,10:roleId3"
   * Invalid entries are skipped with a warning. Duplicate topNs: last one wins.
   */
  private parseTiers(raw: string): ParsedTier[] {
    if (!raw || raw.trim().length === 0) return [];

    const tiers: Map<number, string> = new Map();
    const entries = raw
      .split(",")
      .map((s) => s.trim())
      .filter((s) => s);

    for (const entry of entries) {
      const parts = entry.split(":").map((p) => p.trim());
      if (parts.length !== 2) {
        logger.warn(`Skipping malformed leaderboard tier entry: "${entry}"`);
        continue;
      }
      const topN = Number(parts[0]);
      const roleId = parts[1];
      if (!Number.isInteger(topN) || topN <= 0) {
        logger.warn(
          `Skipping tier with invalid topN (must be positive integer): "${entry}"`,
        );
        continue;
      }
      if (!roleId || !/^\d+$/.test(roleId)) {
        logger.warn(`Skipping tier with invalid Discord role ID: "${entry}"`);
        continue;
      }
      tiers.set(topN, roleId);
    }

    return Array.from(tiers.entries())
      .map(([topN, roleId]) => ({ topN, roleId }))
      .sort((a, b) => a.topN - b.topN);
  }

  private normalizePeriod(value: string): TimePeriod {
    if (value === "week" || value === "month" || value === "alltime") {
      return value;
    }
    logger.warn(
      `Invalid leaderboard_roles.period "${value}", falling back to "alltime"`,
    );
    return "alltime";
  }

  private async waitForClientReady(): Promise<void> {
    if (this.client.isReady()) return;

    return new Promise((resolve) => {
      const maxWaitMs = 30000;
      const pollIntervalMs = 500;
      let resolved = false;
      let elapsed = 0;

      const cleanup = (): void => {
        if (resolved) return;
        resolved = true;
        this.client.off("ready", onReady);
        clearInterval(intervalId);
      };

      const onReady = (): void => {
        cleanup();
        resolve();
      };

      const intervalId = setInterval((): void => {
        if (this.client.isReady()) {
          cleanup();
          resolve();
          return;
        }
        elapsed += pollIntervalMs;
        if (elapsed >= maxWaitMs) {
          logger.warn(
            "LeaderboardRoleService: client did not become ready in time; continuing anyway.",
          );
          cleanup();
          resolve();
        }
      }, pollIntervalMs);

      this.client.once("ready", onReady);
    });
  }

  /**
   * Recalculate role assignments now. Safe to call manually (e.g. from a
   * future WebUI "Run now" button) — does not depend on the cron job state.
   * Returns a per-tier summary of which users gained and lost each role.
   */
  public async runNow(): Promise<LeaderboardRoleRunSummary | null> {
    try {
      await this.waitForClientReady();

      const enabled = await this.configService.getBoolean(
        "leaderboard_roles.enabled",
        false,
      );
      if (!enabled) {
        logger.info("Leaderboard role rewards are disabled, skipping run.");
        return null;
      }

      const guildId = await this.configService.getString("GUILD_ID", "");
      if (!guildId) {
        logger.error("GUILD_ID not configured");
        return null;
      }

      const tiersRaw = await this.configService.getString(
        "leaderboard_roles.tiers",
        "",
      );
      const tiers = this.parseTiers(tiersRaw);
      if (tiers.length === 0) {
        logger.info(
          "No leaderboard role tiers configured, skipping reconciliation.",
        );
        return null;
      }

      const periodRaw = await this.configService.getString(
        "leaderboard_roles.period",
        "alltime",
      );
      const period = this.normalizePeriod(periodRaw);

      const guild = await this.client.guilds.fetch(guildId);
      if (!guild) {
        logger.error(
          `Guild ${guildId} not found while reconciling leaderboard roles`,
        );
        return null;
      }

      // The widest tier (largest topN) defines how many top users we need to fetch.
      const maxTopN = Math.max(...tiers.map((t) => t.topN));
      const tracker = VoiceChannelTracker.getInstance(this.client);
      const topUsers = await tracker.getTopUsers(maxTopN, period);
      const rankedUserIds: string[] = topUsers.map((u) => u.userId);

      // Ensure the member cache is populated so we can find current role holders.
      // For very large guilds this is unavoidable; we accept the one-time fetch.
      await guild.members.fetch();

      const summary: LeaderboardRoleRunSummary = {
        ranAt: new Date(),
        period,
        tiers: [],
      };

      for (const tier of tiers) {
        const tierResult = await this.reconcileTier(guild, tier, rankedUserIds);
        summary.tiers.push(tierResult);
      }

      await this.maybeAnnounce(guild, summary);

      logger.info(
        `Leaderboard role reconciliation complete: ${summary.tiers
          .map(
            (t) =>
              `top${t.topN}(${t.roleName}) +${t.added.length}/-${t.removed.length}`,
          )
          .join(", ")}`,
      );

      return summary;
    } catch (error) {
      logger.error("Error during leaderboard role reconciliation:", error);
      return null;
    }
  }

  private async reconcileTier(
    guild: Guild,
    tier: ParsedTier,
    rankedUserIds: string[],
  ): Promise<LeaderboardRoleRunSummary["tiers"][number]> {
    const role: Role | null = await guild.roles.fetch(tier.roleId);
    if (!role) {
      logger.warn(
        `Leaderboard tier top${tier.topN}: role ${tier.roleId} not found in guild`,
      );
      return {
        topN: tier.topN,
        roleId: tier.roleId,
        roleName: tier.roleId,
        added: [],
        removed: [],
        skippedReason: "role-not-found",
      };
    }

    const qualifyingIds = new Set(rankedUserIds.slice(0, tier.topN));
    const currentHolders = new Set<string>(
      Array.from(role.members.values()).map((m) => m.id),
    );

    const added: string[] = [];
    const removed: string[] = [];

    for (const userId of qualifyingIds) {
      if (currentHolders.has(userId)) continue;
      const member = await this.safeFetchMember(guild, userId);
      if (!member) continue;
      try {
        await member.roles.add(role, "Leaderboard role reward (auto-assign)");
        added.push(userId);
      } catch (error) {
        logger.warn(
          `Failed to add role ${role.name} to ${member.user.tag} (${userId}):`,
          error,
        );
      }
    }

    for (const userId of currentHolders) {
      if (qualifyingIds.has(userId)) continue;
      const member = await this.safeFetchMember(guild, userId);
      if (!member) continue;
      try {
        await member.roles.remove(
          role,
          "Leaderboard role reward (auto-revoke)",
        );
        removed.push(userId);
      } catch (error) {
        logger.warn(
          `Failed to remove role ${role.name} from ${member.user.tag} (${userId}):`,
          error,
        );
      }
    }

    return {
      topN: tier.topN,
      roleId: tier.roleId,
      roleName: role.name,
      added,
      removed,
    };
  }

  private async safeFetchMember(
    guild: Guild,
    userId: string,
  ): Promise<GuildMember | null> {
    try {
      return await guild.members.fetch(userId);
    } catch {
      // Member left the guild or is unreachable; not an error.
      return null;
    }
  }

  private async maybeAnnounce(
    guild: Guild,
    summary: LeaderboardRoleRunSummary,
  ): Promise<void> {
    const channelId = await this.configService.getString(
      "leaderboard_roles.announcement_channel_id",
      "",
    );
    if (!channelId) return;

    const hasChanges = summary.tiers.some(
      (t) => t.added.length > 0 || t.removed.length > 0,
    );
    if (!hasChanges) return;

    try {
      const channel = await guild.channels.fetch(channelId);
      if (!channel || !(channel instanceof TextChannel)) {
        logger.warn(
          `Leaderboard announcement channel ${channelId} not found or not a text channel`,
        );
        return;
      }

      const embed = new EmbedBuilder()
        .setTitle("🏆 Voice Leaderboard Roles Updated")
        .setDescription(
          `Period: **${summary.period}** · Recalculated <t:${Math.floor(
            summary.ranAt.getTime() / 1000,
          )}:R>`,
        )
        .setColor(0xf1c40f);

      for (const tier of summary.tiers) {
        const lines: string[] = [];
        if (tier.added.length > 0) {
          lines.push(`Added: ${tier.added.map((id) => `<@${id}>`).join(", ")}`);
        }
        if (tier.removed.length > 0) {
          lines.push(
            `Removed: ${tier.removed.map((id) => `<@${id}>`).join(", ")}`,
          );
        }
        if (lines.length === 0) continue;
        embed.addFields({
          name: `Top ${tier.topN} — ${tier.roleName}`,
          value: lines.join("\n"),
          inline: false,
        });
      }

      await channel.send({ embeds: [embed] });
    } catch (error) {
      logger.error("Failed to post leaderboard role announcement:", error);
    }
  }

  public async start(): Promise<void> {
    if (this.isInitialized) {
      logger.warn(
        "Leaderboard role service is already initialized, skipping...",
      );
      return;
    }

    try {
      const enabled = await this.configService.getBoolean(
        "leaderboard_roles.enabled",
        false,
      );

      if (!enabled) {
        logger.info("Leaderboard role rewards are disabled");
        this.isInitialized = true;
        return;
      }

      const cronExpression = await this.configService.getString(
        "leaderboard_roles.update_cron",
        "0 0 * * 1",
      );

      if (!this.validateCronExpression(cronExpression)) {
        logger.error(
          `Leaderboard role service not started: invalid cron "${cronExpression}"`,
        );
        this.isInitialized = true;
        return;
      }

      this.job = new CronJob(cronExpression, async () => {
        await this.runNow();
      });
      this.job.start();

      const nextRun = this.job.nextDate();
      logger.info(
        `Leaderboard role service started (cron: "${cronExpression}", next run: ${nextRun.toLocaleString()})`,
      );

      this.isInitialized = true;
    } catch (error) {
      logger.error("Error starting leaderboard role service:", error);
      throw error;
    }
  }

  public async reload(): Promise<void> {
    logger.info("Reloading leaderboard role service...");
    if (this.job) {
      this.job.stop();
      this.job = null;
    }
    this.isInitialized = false;
    await this.start();
  }

  public destroy(): void {
    if (this.job) {
      this.job.stop();
      this.job = null;
    }
    this.isInitialized = false;
    logger.info("Leaderboard role service destroyed");
  }
}
