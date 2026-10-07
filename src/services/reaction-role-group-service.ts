import {
  Client,
  EmbedBuilder,
  Guild,
  Message,
  Role,
  TextChannel,
} from "discord.js";
import { ConfigService } from "./config-service.js";
import { CommandManager } from "./command-manager.js";
import { ReactionRoleService } from "./reaction-role-service.js";
import logger from "../utils/logger.js";
import { sanitizeForLog } from "../utils/log-sanitize.js";
import {
  ReactionRoleConfig,
  ReactionRoleMode,
  REACTION_ROLE_MODES,
} from "../models/reaction-role-config.js";
import { MAX_GROUP_ENTRIES } from "../content/reaction-role-groups.js";

/**
 * Grouped reaction-role generator (#1064).
 *
 * Creates (or reuses) a whole set of roles and posts ONE picker message that
 * maps emoji -> role, in one step. It is idempotent and non-destructive:
 *
 * - A role with the same name (case-insensitive) is reused, never recreated,
 *   and its permissions/colour are left untouched.
 * - Re-running a group (same name) only adds entries that are missing; it
 *   edits the existing picker message instead of posting a second one and
 *   never removes roles, mappings or reactions.
 * - Roles the bot creates get no permissions and are not mentionable. The
 *   colour comes from `reactionroles.group_role_colour` (optional).
 *
 * All Discord REST calls go through `CommandManager.makeDiscordApiCall`.
 */

export interface GroupProvisionEntry {
  roleName: string;
  emoji: string;
}

export interface GroupProvisionResult {
  success: boolean;
  message: string;
  groupId?: string;
  messageId?: string;
  createdRoles: string[];
  reusedRoles: string[];
  addedEntries: number;
  skippedEntries: number;
}

const fail = (message: string): GroupProvisionResult => ({
  success: false,
  message,
  createdRoles: [],
  reusedRoles: [],
  addedEntries: 0,
  skippedEntries: 0,
});

/** Parse `#RRGGBB` / `RRGGBB`; undefined when blank or invalid. */
export function parseRoleColour(raw: string): number | undefined {
  const m = raw.trim().match(/^#?([0-9a-fA-F]{6})$/);
  return m ? parseInt(m[1], 16) : undefined;
}

export class ReactionRoleGroupService {
  private static instance: ReactionRoleGroupService;
  private client: Client;

  private constructor(client: Client) {
    this.client = client;
  }

  public static getInstance(client: Client): ReactionRoleGroupService {
    if (!ReactionRoleGroupService.instance) {
      ReactionRoleGroupService.instance = new ReactionRoleGroupService(client);
    }
    return ReactionRoleGroupService.instance;
  }

  private api<T>(call: () => Promise<T>, label: string): Promise<T> {
    return CommandManager.getInstance(this.client).makeDiscordApiCall(
      call,
      label,
    );
  }

  public async provisionGroup(
    guildId: string,
    groupName: string,
    entries: GroupProvisionEntry[],
    mode: ReactionRoleMode = "unique",
  ): Promise<GroupProvisionResult> {
    const rrService = ReactionRoleService.getInstance(this.client);
    const name = groupName.trim();
    if (!name) return fail("Group name is required.");
    if (name.length > 100) {
      return fail("Group name must be 100 characters or fewer.");
    }
    if (entries.length < 1) return fail("Add at least one role option.");
    if (entries.length > MAX_GROUP_ENTRIES) {
      return fail(
        `A group can have at most ${MAX_GROUP_ENTRIES} options (Discord's reaction limit per message).`,
      );
    }
    const clean = entries.map((e) => ({
      roleName: e.roleName.trim(),
      emoji: rrService.normalizeEmoji(e.emoji.trim()),
    }));
    if (clean.some((e) => !e.roleName || !e.emoji)) {
      return fail("Every option needs both a role name and an emoji.");
    }
    if (clean.some((e) => e.roleName.length > 100)) {
      return fail("Role names must be 100 characters or fewer.");
    }
    if (
      new Set(clean.map((e) => e.roleName.toLowerCase())).size !== clean.length
    ) {
      return fail("Role names within a group must be unique.");
    }
    if (new Set(clean.map((e) => e.emoji)).size !== clean.length) {
      return fail("Emojis within a group must be unique.");
    }

    const groupKey = name.toLowerCase();
    const createdRoles: Role[] = [];
    let postedMessage: Message | null = null;

    try {
      const configService = ConfigService.getInstance();
      const channelId = await configService.getString(
        "reactionroles.message_channel_id",
        "",
      );
      if (!channelId) {
        return fail(
          "Reaction role message channel not configured. Set reactionroles.message_channel_id",
        );
      }
      const guild: Guild = await this.client.guilds.fetch(guildId);
      const channel = (await guild.channels
        .fetch(channelId)
        .catch(() => null)) as TextChannel | null;
      if (!channel || !channel.isTextBased()) {
        return fail(
          `Message channel ${channelId} not found or is not a text channel.`,
        );
      }

      // Existing live rows for this group make the run an "add what's missing".
      const existingRows = await ReactionRoleConfig.find({
        guildId,
        groupKey,
        isArchived: false,
      });
      let anchor: Message | null = null;
      const anchorId = existingRows[0]?.messageId;
      if (anchorId) {
        anchor = await channel.messages.fetch(anchorId).catch(() => null);
      }
      const liveRows = anchor ? existingRows : [];
      // Rows whose picker message is gone are archived, never deleted.
      if (!anchor && existingRows.length > 0) {
        await ReactionRoleConfig.updateMany(
          { guildId, groupKey, messageId: anchorId, isArchived: false },
          { isArchived: true, archivedAt: new Date() },
        );
      }
      const effectiveMode: ReactionRoleMode = liveRows[0]
        ? liveRows[0].mode
        : REACTION_ROLE_MODES.includes(mode)
          ? mode
          : "unique";

      const haveRoleIds = new Set(liveRows.map((r) => r.roleId));
      const haveEmojis = new Set(liveRows.map((r) => r.emoji));

      // Resolve roles by name without creating anything yet.
      const allRoles = await this.api(
        () => guild.roles.fetch(),
        "fetch guild roles",
      );
      const byName = new Map<string, Role>();
      for (const r of allRoles.values()) {
        if (r.id === guild.roles.everyone.id || r.managed) continue;
        const k = r.name.toLowerCase();
        if (!byName.has(k)) byName.set(k, r);
      }

      const todo: Array<{ roleName: string; emoji: string; role?: Role }> = [];
      let skipped = 0;
      for (const e of clean) {
        const role = byName.get(e.roleName.toLowerCase());
        if ((role && haveRoleIds.has(role.id)) || haveEmojis.has(e.emoji)) {
          skipped++;
          continue;
        }
        todo.push({ ...e, role });
      }

      if (todo.length === 0) {
        return {
          success: true,
          message: `Group **${name}** is already up to date (${skipped} option${skipped === 1 ? "" : "s"} already present). Nothing changed.`,
          groupId: liveRows[0]?.groupId,
          messageId: anchor?.id,
          createdRoles: [],
          reusedRoles: [],
          addedEntries: 0,
          skippedEntries: skipped,
        };
      }
      if (liveRows.length + todo.length > MAX_GROUP_ENTRIES) {
        return fail(
          `Adding ${todo.length} option(s) would exceed the ${MAX_GROUP_ENTRIES}-reaction limit for this group.`,
        );
      }

      // Validate reused roles are assignable before creating anything.
      for (const t of todo) {
        if (!t.role) continue;
        const ok = await rrService.validateRoleAssignable(guild, t.role);
        if (!ok.ok) return fail(ok.message);
      }

      const colour = parseRoleColour(
        await configService.getString("reactionroles.group_role_colour", ""),
      );
      const reused: string[] = [];
      const created: string[] = [];
      for (const t of todo) {
        if (t.role) {
          reused.push(t.role.id);
          continue;
        }
        const role = await this.api(
          () =>
            guild.roles.create({
              name: t.roleName,
              ...(colour !== undefined ? { colour } : {}),
              permissions: [],
              mentionable: false,
              reason: `Reaction role group generated: ${name}`,
            }),
          `create role ${t.roleName}`,
        );
        createdRoles.push(role);
        t.role = role;
        created.push(role.id);
      }

      // Picker message: edit the existing one, or post a fresh one.
      const rowsAfter = [
        ...liveRows.map((r) => ({ roleName: r.roleName, emoji: r.emoji })),
        ...todo.map((t) => ({ roleName: t.role!.name, emoji: t.emoji })),
      ];
      const embed = new EmbedBuilder()
        .setColor(0x5865f2)
        .setTitle(name)
        .setDescription(
          `React to choose your **${name}** role:\n\n${rowsAfter
            .map((r) => `${r.emoji} — **${r.roleName}**`)
            .join("\n")}`,
        )
        .setFooter({
          text:
            effectiveMode === "unique"
              ? "Pick one — reacting swaps you to that role"
              : effectiveMode === "sticky"
                ? "React to opt in — removing your reaction keeps the role"
                : "React to add a role, remove your reaction to lose it",
        });

      let target: Message;
      if (anchor) {
        const a = anchor;
        target = await this.api(
          () => a.edit({ embeds: [embed] }),
          `edit group message ${a.id}`,
        );
      } else {
        postedMessage = await this.api(
          () => channel.send({ embeds: [embed] }),
          "post group message",
        );
        target = postedMessage;
      }
      for (const t of todo) {
        await this.api(
          () => target.react(t.emoji),
          `react ${t.emoji} on group message`,
        );
      }

      const groupId = liveRows[0]?.groupId ?? target.id;
      await ReactionRoleConfig.insertMany(
        todo.map((t) => ({
          guildId,
          messageId: target.id,
          roleId: t.role!.id,
          emoji: t.emoji,
          roleName: t.role!.name,
          style: "reaction" as const,
          // Only roles the bot created are its to remove later.
          autoCreated: createdRoles.some((r) => r.id === t.role!.id),
          mode: effectiveMode,
          groupId,
          groupKey,
          isArchived: false,
        })),
      );

      logger.info(
        `Generated reaction role group ${sanitizeForLog(name)}: ${created.length} created, ${reused.length} reused, ${skipped} skipped`,
      );
      return {
        success: true,
        message: `Group **${name}**: added ${todo.length} option${todo.length === 1 ? "" : "s"} (${created.length} new role${created.length === 1 ? "" : "s"}, ${reused.length} existing reused, ${skipped} already present).`,
        groupId,
        messageId: target.id,
        createdRoles: created,
        reusedRoles: reused,
        addedEntries: todo.length,
        skippedEntries: skipped,
      };
    } catch (error) {
      logger.error(
        "Error generating reaction role group, rolling back:",
        error,
      );
      // Undo only what this run created. Existing roles/messages stay.
      if (postedMessage) {
        await postedMessage
          .delete()
          .catch((err) => logger.warn("Could not delete group message:", err));
      }
      for (const role of createdRoles) {
        await role
          .delete()
          .catch((err) => logger.warn("Could not delete group role:", err));
      }
      return fail(
        `Failed to generate role group: ${error instanceof Error ? error.message : "Unknown error"}`,
      );
    }
  }
}
