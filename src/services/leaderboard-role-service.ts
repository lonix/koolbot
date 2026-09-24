import {
  Client,
  DiscordAPIError,
  Guild,
  GuildMember,
  Role,
  EmbedBuilder,
  GuildTextBasedChannel,
} from "discord.js";
import { ScheduledService } from "./scheduled-service.js";
import { VoiceChannelTracker, TimePeriod } from "./voice-channel-tracker.js";
import { LeaderboardRoleAssignment } from "../models/leaderboard-role-assignment.js";
import logger from "../utils/logger.js";
import { waitForClientReady } from "../utils/discord.js";
import { fetchMemberOrNull } from "../utils/moderation-guards.js";

/** Discord's Unknown Role error: the role was deleted. */
const UNKNOWN_ROLE = 10011;

/**
 * Fetch a role, resolving a confirmed deletion to null. Discord reports a
 * deleted role either as null or as an Unknown Role (10011) rejection; any
 * other error is rethrown, so a transient failure never reads as "deleted".
 */
async function fetchRoleOrNull(
  guild: Guild,
  roleId: string,
): Promise<Role | null> {
  try {
    return await guild.roles.fetch(roleId);
  } catch (error) {
    if (error instanceof DiscordAPIError && error.code === UNKNOWN_ROLE) {
      return null;
    }
    throw error;
  }
}

/** Discord's limit on one embed field value. */
const EMBED_FIELD_MAX = 1024;
/** Discord's limit on an embed's total text (title, description, fields). */
const EMBED_TOTAL_MAX = 6000;
/** Discord's limit on fields per embed. */
const EMBED_FIELDS_MAX = 25;

/**
 * `<label>: <@a>, <@b>, …` capped at `max` characters. A wide tier can hold
 * hundreds of members, and a field over Discord's limit makes the whole
 * announcement fail to send, so the list ends in "and N more" instead.
 */
export function formatMentionLine(
  label: string,
  userIds: readonly string[],
  max = EMBED_FIELD_MAX,
): string {
  const mentions = userIds.map((id) => `<@${id}>`);
  const full = `${label}: ${mentions.join(", ")}`;
  if (full.length <= max) return full;
  // Too long: keep as many mentions as leave room for "… and N more".
  let line = `${label}: `;
  for (let i = 0; i < mentions.length; i++) {
    const mention = `${i === 0 ? "" : ", "}${mentions[i]}`;
    const after = ` … and ${mentions.length - i - 1} more`;
    if (line.length + mention.length + after.length > max) {
      return `${line} … and ${mentions.length - i} more`;
    }
    line += mention;
  }
  return line;
}

/** Weekly, Monday 00:00 — the schedule leaderboard roles ship with. */
const DEFAULT_CRON = "0 0 * * 1";

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
  /**
   * Rosters for roles that are no longer a configured tier (#985): the tier
   * was removed or given a different role, so its old role is taken back.
   */
  retired: Array<{
    roleId: string;
    roleName: string;
    removed: string[]; // user IDs the old role was taken back from
    retained: string[]; // user IDs whose revoke failed; retried next run
  }>;
}

/**
 * Outcome of a per-member revocation (#914). Reported per assignment row
 * because a member can hold several tiers' roles at once.
 */
export interface LeaderboardRoleRevokeResult {
  /** Role ids the member was revoked from and pulled off the roster for. */
  revoked: string[];
  /**
   * Role ids the member is still listed against because the Discord revoke
   * failed. Deliberately left on the roster so the next reconcile retries.
   */
  retained: string[];
}

export class LeaderboardRoleService extends ScheduledService<LeaderboardRoleRunSummary | null> {
  private static instance: LeaderboardRoleService;
  /**
   * Members a per-user purge is holding out of reconciliation, with a count
   * so overlapping holds release cleanly (#917). See `holdOutForPurge`.
   */
  private readonly heldOut = new Map<string, number>();

  private constructor(client: Client) {
    super(client, {
      label: "Leaderboard role service",
      disabledMessage: "Leaderboard role rewards are disabled",
      cronContext: "leaderboard roles",
      runLabel: "Leaderboard role reconciliation",
    });
  }

  protected async isEnabled(): Promise<boolean> {
    return this.configService.getBoolean("leaderboard_roles.enabled", false);
  }

  protected async resolveSchedule(): Promise<string> {
    return this.configService.getString(
      "leaderboard_roles.update_cron",
      DEFAULT_CRON,
    );
  }

  public static getInstance(client: Client): LeaderboardRoleService {
    if (!LeaderboardRoleService.instance) {
      LeaderboardRoleService.instance = new LeaderboardRoleService(client);
    } else if (LeaderboardRoleService.instance.client !== client) {
      throw new Error(
        "LeaderboardRoleService already initialised with a different client",
      );
    }
    return LeaderboardRoleService.instance;
  }

  public static reset(): void {
    if (LeaderboardRoleService.instance) {
      LeaderboardRoleService.instance.destroy();
    }
    LeaderboardRoleService.instance =
      undefined as unknown as LeaderboardRoleService;
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

  /**
   * Recalculate role assignments. Reached through `runNow()`, so it runs on
   * the cron tick and from a manual trigger alike, and never concurrently
   * with itself.
   */
  protected async runOnce(): Promise<LeaderboardRoleRunSummary | null> {
    await waitForClientReady(this.client, "LeaderboardRoleService");

    try {
      // Voice tracking is a hard dependency (#659): without it there is no
      // ranking data, so reconciling roles would only churn members against
      // empty/stale data. Mirror voice-channel-announcer.ts and short-circuit.
      const trackingEnabled = await this.configService.getBoolean(
        "voicetracking.enabled",
        false,
      );
      if (!trackingEnabled) {
        logger.warn(
          "Leaderboard role reconciliation skipped: voice tracking is disabled (voicetracking.enabled=false).",
        );
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

      // Before the tiers: a removed tier's old role is taken back even when
      // no tiers are left at all.
      const retired = await this.retireRemovedTiers(
        guild,
        new Set(tiers.map((t) => t.roleId)),
      );
      if (tiers.length === 0) {
        logger.info(
          "No leaderboard role tiers configured, skipping reconciliation.",
        );
        const summary = { ranAt: new Date(), period, tiers: [], retired };
        await this.maybeAnnounce(guild, summary);
        return summary;
      }

      // Fetch the full ranking with the documented "all ranked users"
      // sentinel (0). A positive limit would be clamped to
      // voicetracking.stats.leaderboard_max_results, silently truncating
      // tiers wider than that cap; the per-tier cutoff happens in
      // reconcileTier via rankedUserIds.slice(0, tier.topN).
      const tracker = VoiceChannelTracker.getInstance(this.client);
      const topUsers = await tracker.getTopUsers(0, period);
      const rankedUserIds: string[] = topUsers.map((u) => u.userId);

      const summary: LeaderboardRoleRunSummary = {
        ranAt: new Date(),
        period,
        tiers: [],
        retired,
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
    const role = await fetchRoleOrNull(guild, tier.roleId);
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

    // A member being purged never qualifies, so this run cannot grant them
    // the role while their data is being erased (#917). Filtered before the
    // cut so the next-ranked member moves up rather than leaving a gap.
    const qualifyingIds = new Set(
      rankedUserIds
        .filter((userId) => !this.heldOut.has(userId))
        .slice(0, tier.topN),
    );

    // Source of truth for "who already has this role per our last run" is
    // our own persisted state — we cannot rely on `role.members` because
    // the bot does not request the privileged GuildMembers intent.
    const previousAssignment = await LeaderboardRoleAssignment.findOne({
      guildId: guild.id,
      roleId: tier.roleId,
    });
    const previousHolders = new Set<string>(previousAssignment?.userIds ?? []);

    const added: string[] = [];
    const removed: string[] = [];
    const finalHolders = new Set<string>();

    for (const userId of qualifyingIds) {
      const member = await this.safeFetchMember(guild, userId);
      if (!member) {
        // Couldn't reach the member (left the guild, etc.); skip.
        continue;
      }
      if (!previousHolders.has(userId)) {
        try {
          await member.roles.add(role, "Leaderboard role reward (auto-assign)");
          added.push(userId);
        } catch (error) {
          logger.warn(
            `Failed to add role ${role.name} to ${member.user.tag} (${userId}):`,
            error,
          );
          continue;
        }
      }
      finalHolders.add(userId);
    }

    for (const userId of previousHolders) {
      if (qualifyingIds.has(userId)) continue;
      const member = await this.safeFetchMember(guild, userId);
      if (!member) {
        // User left the guild; nothing to revoke. Treat as removed.
        removed.push(userId);
        continue;
      }
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
        // If we couldn't remove, keep them in the set so we try again next run.
        finalHolders.add(userId);
      }
    }

    await LeaderboardRoleAssignment.findOneAndUpdate(
      { guildId: guild.id, roleId: tier.roleId },
      {
        guildId: guild.id,
        roleId: tier.roleId,
        topN: tier.topN,
        userIds: Array.from(finalHolders),
      },
      { upsert: true },
    );

    return {
      topN: tier.topN,
      roleId: tier.roleId,
      roleName: role.name,
      added,
      removed,
    };
  }

  /**
   * Take reward roles back from every roster whose role is no longer a
   * configured tier (#985).
   *
   * `reconcileTier` only visits the roles in the current config, and the
   * roster is the only record of who holds a reward role (no GuildMembers
   * intent). So when a tier is removed, or its role replaced, nothing else
   * would ever revoke the old role: its holders would keep it permanently.
   *
   * Same ordering rule as `revokeForUser`: revoke on Discord first, and drop
   * an id only once that landed (or the member / role is gone). A failed
   * revoke keeps the id so the next run retries; the row is deleted once it
   * is empty. A deleted role (null, or an Unknown Role rejection) drops the
   * row; any other lookup error skips it this run, so a transient failure
   * never reads as "role deleted".
   */
  private async retireRemovedTiers(
    guild: Guild,
    activeRoleIds: ReadonlySet<string>,
  ): Promise<LeaderboardRoleRunSummary["retired"]> {
    const rows = await LeaderboardRoleAssignment.find({ guildId: guild.id });
    const retired: LeaderboardRoleRunSummary["retired"] = [];
    for (const row of rows) {
      if (activeRoleIds.has(row.roleId)) continue;
      let role: Role | null;
      try {
        role = await fetchRoleOrNull(guild, row.roleId);
      } catch (error) {
        logger.warn(
          `Leaderboard role ${row.roleId} is no longer a tier but could not be fetched; retrying next run:`,
          error,
        );
        continue;
      }

      const removed: string[] = [];
      const retained: string[] = [];
      for (const userId of row.userIds) {
        if (!role) {
          // The role itself is gone, so there is nothing left to take back.
          removed.push(userId);
          continue;
        }
        try {
          const member = await fetchMemberOrNull(guild, userId);
          if (member) {
            await member.roles.remove(
              role,
              "Leaderboard role reward (tier removed)",
            );
          }
          removed.push(userId);
        } catch (error) {
          logger.warn(
            `Failed to take back removed-tier role ${role.name} from ${userId}; keeping them on the roster to retry:`,
            error,
          );
          retained.push(userId);
        }
      }

      if (retained.length === 0) {
        await LeaderboardRoleAssignment.deleteOne({
          guildId: guild.id,
          roleId: row.roleId,
        });
      } else if (removed.length > 0) {
        // Server-side pull, so a concurrent per-user purge is not clobbered.
        await LeaderboardRoleAssignment.updateOne(
          { guildId: guild.id, roleId: row.roleId },
          { $pull: { userIds: { $in: removed } } },
        );
      }
      retired.push({
        roleId: row.roleId,
        roleName: role?.name ?? row.roleId,
        removed,
        retained,
      });
    }
    if (retired.length > 0) {
      logger.info(
        `Leaderboard roles: retired ${retired.length} removed tier role(s): ${retired
          .map((r) => `${r.roleName} -${r.removed.length}`)
          .join(", ")}`,
      );
    }
    return retired;
  }

  /**
   * Hold a member out of reconciliation for the length of a per-user purge
   * (#917), and return the function that releases the hold.
   *
   * Closes the race `revokeForUser` alone cannot: a reconcile that had
   * already ranked the member could re-grant the role and write them back
   * onto the roster *after* the purge revoked it, leaving the role on a
   * member who asked to be forgotten until the next cron cycle. Two parts:
   *
   * - While held, `reconcileTier` treats the member as not qualifying, so no
   *   run can grant them the role (and a run that finds them on the roster
   *   revokes it, which is what the purge wants anyway).
   * - Before returning, the hold waits out any run already in flight. That
   *   run may have granted the role before the hold existed; waiting lets it
   *   finish writing the roster, so the purge's `revokeForUser` then sees
   *   the member there and takes the role back. Filtering the roster write
   *   instead would drop them from the roster while leaving the Discord
   *   role in place — the permanent-role failure `revokeForUser` documents.
   *
   * The caller releases once the member's voice data is gone, after which
   * they no longer rank and need no hold.
   */
  public async holdOutForPurge(userId: string): Promise<() => void> {
    this.heldOut.set(userId, (this.heldOut.get(userId) ?? 0) + 1);
    await this.waitForIdle();
    let released = false;
    return () => {
      if (released) return;
      released = true;
      const remaining = (this.heldOut.get(userId) ?? 1) - 1;
      if (remaining > 0) this.heldOut.set(userId, remaining);
      else this.heldOut.delete(userId);
    };
  }

  /**
   * Revoke every leaderboard reward role a member currently holds and take
   * them off the persisted rosters (#914).
   *
   * **The ordering here is load-bearing, not stylistic.** `reconcileTier`
   * uses the persisted `userIds[]` as its *only* source of truth for who
   * already holds a role, because the bot does not request the privileged
   * `GuildMembers` intent and so cannot read `role.members`. Its revoke loop
   * walks nothing but that array. So a bare `$pull` would remove the member
   * from `previousHolders`, the next run would find they no longer qualify
   * either (their voice data having been purged too), and the revoke loop
   * would never look at them again: **the member keeps the reward role
   * permanently and nothing will ever take it back.**
   *
   * Hence: revoke on Discord first, and only pull the id once that
   * succeeded. On failure the id stays put and the next reconcile retries —
   * the same recovery `reconcileTier` already applies to its own failures
   * (`finalHolders.add(userId)` in its catch).
   *
   * Each role is handled independently: a failure on one is recorded as
   * retained and the rest still run, so a partial revoke is reported as a
   * partial revoke rather than thrown away (#916).
   *
   * The pull runs server-side as a `$pull` rather than a read-modify-write:
   * `reconcileTier` writes the whole `userIds` array in one
   * `findOneAndUpdate`, so a reconcile landing between our read and our write
   * would be clobbered by a read-modify-write purge.
   */
  public async revokeForUser(
    guildId: string,
    userId: string,
  ): Promise<LeaderboardRoleRevokeResult> {
    const result: LeaderboardRoleRevokeResult = { revoked: [], retained: [] };

    const rows = await LeaderboardRoleAssignment.find({
      guildId,
      userIds: userId,
    });
    if (rows.length === 0) return result;

    const guild = await this.client.guilds.fetch(guildId).catch(() => null);
    if (!guild) {
      // No guild, no way to revoke. Leaving every id in place is the safe
      // failure: a later run can still take the roles back.
      logger.warn(
        `Leaderboard role revoke for ${userId}: guild ${guildId} unreachable; left ${rows.length} roster row(s) intact for retry`,
      );
      result.retained.push(...rows.map((row) => row.roleId));
      return result;
    }

    for (const row of rows) {
      // Per role, so one failure cannot discard the record of the roles
      // already taken back (#916). A throw here used to reject the whole
      // method, and the purge report then said nothing had happened at all
      // — while the member really had lost roles on Discord.
      try {
        if (await this.revokeOneRole(guild, row.roleId, userId)) {
          await LeaderboardRoleAssignment.updateOne(
            { guildId, roleId: row.roleId },
            { $pull: { userIds: userId } },
          );
          result.revoked.push(row.roleId);
        } else {
          result.retained.push(row.roleId);
        }
      } catch (error) {
        // Retained is the safe classification either way: the id stays on
        // the roster, so the next reconcile retries the whole role.
        logger.error(
          `Leaderboard role revoke for ${userId}: role ${row.roleId} failed; left on the roster for retry:`,
          error,
        );
        result.retained.push(row.roleId);
      }
    }

    logger.info(
      `Leaderboard role revoke for ${userId}: removed ${result.revoked.length} role(s), ${result.retained.length} left for retry`,
    );
    return result;
  }

  /**
   * Take one reward role off a member. Returns true when it is safe to drop
   * their id from the roster — either the role is gone, or the member is, or
   * the removal landed. Returns false only when the member is reachable and
   * still holds the role, which is the case that must be retried.
   */
  private async revokeOneRole(
    guild: Guild,
    roleId: string,
    userId: string,
  ): Promise<boolean> {
    const role = await guild.roles.fetch(roleId).catch(() => null);
    if (!role) {
      // The role itself no longer exists, so there is no grant left to take
      // back and nothing for a retry to fix.
      logger.warn(
        `Leaderboard role revoke for ${userId}: role ${roleId} not found in guild; dropping the roster entry`,
      );
      return true;
    }

    // `fetchMemberOrNull`, not the service's own `safeFetchMember`: that one
    // swallows every error, so a rate limit would read as "they left" and the
    // roster entry — the only handle anything has on this grant — would be
    // dropped while the role sat on a member who is still here (#916). This
    // returns null only for a definitive 10007/10013 and rethrows the rest,
    // which the caller classifies as retained.
    const member = await fetchMemberOrNull(guild, userId);
    if (!member) {
      // Left the guild: the role went with them. Same call `reconcileTier`
      // makes when a previous holder is unreachable.
      return true;
    }

    try {
      await member.roles.remove(role, "Per-user data reset (leaderboard role)");
      return true;
    } catch (error) {
      logger.warn(
        `Failed to revoke leaderboard role ${role.name} from ${member.user.tag} (${userId}); keeping the roster entry so the next reconcile retries:`,
        error,
      );
      return false;
    }
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

    const hasChanges =
      summary.tiers.some((t) => t.added.length > 0 || t.removed.length > 0) ||
      summary.retired.some((r) => r.removed.length > 0);
    if (!hasChanges) return;

    try {
      const channel = await guild.channels.fetch(channelId);
      if (!channel || !channel.isTextBased() || !("send" in channel)) {
        logger.warn(
          `Leaderboard announcement channel ${channelId} not found or not a sendable text channel`,
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

      const fields: Array<{ name: string; value: string }> = [];
      for (const tier of summary.tiers) {
        if (tier.added.length === 0 && tier.removed.length === 0) continue;
        // Each line gets half the field when both are present, so the
        // joined value stays within the field limit.
        const both = tier.added.length > 0 && tier.removed.length > 0;
        const lineMax = both
          ? Math.floor((EMBED_FIELD_MAX - 1) / 2)
          : EMBED_FIELD_MAX;
        const lines: string[] = [];
        if (tier.added.length > 0) {
          lines.push(formatMentionLine("Added", tier.added, lineMax));
        }
        if (tier.removed.length > 0) {
          lines.push(formatMentionLine("Removed", tier.removed, lineMax));
        }
        fields.push({
          name: `Top ${tier.topN} — ${tier.roleName}`,
          value: lines.join("\n"),
        });
      }
      // Roles taken back because their tier was removed (#985).
      for (const r of summary.retired) {
        if (r.removed.length === 0) continue;
        fields.push({
          name: `Removed tier — ${r.roleName}`,
          value: formatMentionLine("Removed", r.removed),
        });
      }

      // Stay inside the embed's field-count and total-text limits; fields
      // that don't fit are summarised rather than failing the whole send.
      let total =
        (embed.data.title?.length ?? 0) + (embed.data.description?.length ?? 0);
      let added = 0;
      for (const field of fields) {
        const size = field.name.length + field.value.length;
        const remaining = fields.length - added;
        // Keep the last slot and ~100 characters for the summary field.
        const outOfSlots = remaining > 1 && added >= EMBED_FIELDS_MAX - 1;
        if (outOfSlots || total + size > EMBED_TOTAL_MAX - 100) {
          embed.addFields({
            name: "More changes",
            value: `${remaining} more tier${remaining === 1 ? "" : "s"} changed; see the Web UI for details.`,
            inline: false,
          });
          break;
        }
        embed.addFields({ ...field, inline: false });
        total += size;
        added += 1;
      }

      await (channel as GuildTextBasedChannel).send({ embeds: [embed] });
    } catch (error) {
      logger.error("Failed to post leaderboard role announcement:", error);
    }
  }
}
