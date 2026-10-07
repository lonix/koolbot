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
 * - Re-running a group (same name) that still has live mappings only adds
 *   entries that are missing; it edits the existing picker message instead of
 *   posting a second one and never removes roles, mappings or reactions. If
 *   that picker message was deleted in Discord the run stops and changes
 *   nothing: remove the group on the Reaction Roles page and generate it again.
 * - A group with no live mappings is generated fresh. Reused roles stay
 *   `autoCreated: false`, so deleting a group never deletes them.
 * - Roles the bot creates get no permissions and are not mentionable. The
 *   colour comes from `reactionroles.group_role_colour` (optional).
 *
 * All Discord REST calls go through `CommandManager.makeDiscordApiCall`.
 * Role creation and message posting are not idempotent, so those two run once
 * (no timeout retry), otherwise a slow first attempt could finish after a retry.
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
  /** Tail of the in-process provisioning queue, per guild. */
  private locks = new Map<string, Promise<void>>();

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

  /**
   * Run `fn` after every earlier provisioning for the same guild finished.
   * Serialised per guild (not per group) because roles are reused by name
   * across groups, so two groups can race on the same role too. The bot is a
   * single instance, so an in-process queue is sufficient.
   */
  private async withGuildLock<T>(
    guildId: string,
    fn: () => Promise<T>,
  ): Promise<T> {
    const prev = this.locks.get(guildId) ?? Promise.resolve();
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const tail = prev.then(() => gate);
    this.locks.set(guildId, tail);
    await prev;
    try {
      return await fn();
    } finally {
      release();
      if (this.locks.get(guildId) === tail) this.locks.delete(guildId);
    }
  }

  /**
   * Run a non-idempotent create/send once. A timeout is not retried because the
   * original request may still complete; the admin is told to check by hand.
   */
  private async createOnce<T>(
    call: () => Promise<T>,
    label: string,
  ): Promise<T> {
    try {
      return await CommandManager.getInstance(this.client).makeDiscordApiCall(
        call,
        label,
        30000,
        3,
        false,
      );
    } catch (error) {
      if (
        error instanceof Error &&
        error.message.toLowerCase().includes("timeout")
      ) {
        throw new Error(
          `Discord did not answer in time while trying to ${label}. It may still have been created: check the Roles list and the picker channel for a half-created role or message (and remove it) before trying again.`,
          { cause: error },
        );
      }
      throw error;
    }
  }

  /** True when a Discord REST error (or its cause chain) carries `code`. */
  private hasDiscordCode(error: unknown, code: number): boolean {
    let e: unknown = error;
    for (let i = 0; e && i < 3; i++) {
      if ((e as { code?: unknown }).code === code) return true;
      e = (e as { cause?: unknown }).cause;
    }
    return false;
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

    return this.withGuildLock(guildId, () =>
      this.provisionLocked(guildId, name, clean, mode),
    );
  }

  private async provisionLocked(
    guildId: string,
    name: string,
    clean: GroupProvisionEntry[],
    mode: ReactionRoleMode,
  ): Promise<GroupProvisionResult> {
    const rrService = ReactionRoleService.getInstance(this.client);
    const groupKey = name.toLowerCase();
    const createdRoles: Role[] = [];
    let postedMessage: Message | null = null;
    // Existing-picker top-up state, so a failure can restore the message.
    let editedAnchor: Message | null = null;
    // True once an edit or reaction is in flight on the existing picker.
    let touchedExisting = false;
    let previousEmbeds: EmbedBuilder[] = [];
    const addedReactions: string[] = [];
    // Rollback bookkeeping for the persistence step.
    let insertAttempt: { messageId: string; roleIds: string[] } | null = null;

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
      const guild: Guild = await this.api(
        () => this.client.guilds.fetch(guildId),
        "fetch guild",
      );
      // Only a confirmed Unknown Channel (10003) means "not found"; transient
      // failures propagate instead of being reported as a config error.
      const channel = (await this.api(
        () =>
          guild.channels.fetch(channelId).catch((err: unknown) => {
            if (this.hasDiscordCode(err, 10003)) return null;
            throw err;
          }),
        "fetch group channel",
      )) as TextChannel | null;
      if (!channel || !channel.isTextBased()) {
        return fail(
          `Message channel ${channelId} not found or is not a text channel.`,
        );
      }

      // Live rows make this a top-up of the existing picker; none means a
      // fresh group (archived rows of earlier pickers are ignored).
      const existingRows = await ReactionRoleConfig.find({
        guildId,
        groupKey,
        isArchived: false,
      });
      let anchor: Message | null = null;
      const anchorId = existingRows[0]?.messageId;
      if (anchorId) {
        // The picker must still exist. Only a confirmed Unknown Message
        // (10008) means it is gone; stop either way and change nothing.
        try {
          anchor = await this.api(
            () =>
              channel.messages.fetch(anchorId).catch((err: unknown) => {
                if (this.hasDiscordCode(err, 10008)) return null;
                throw err;
              }),
            `fetch group message ${anchorId}`,
          );
        } catch (err) {
          logger.warn("Could not check the group picker message:", err);
          return fail(
            `I couldn't check whether the picker message for **${name}** still exists. Nothing was changed. Please try again in a moment.`,
          );
        }
        if (!anchor) {
          return fail(
            `The picker message for **${name}** was deleted. Nothing was changed. Remove the group on the Reaction Roles page and generate it again.`,
          );
        }
      }

      // A top-up keeps the picker's original mode.
      const effectiveMode: ReactionRoleMode = existingRows[0]
        ? existingRows[0].mode
        : REACTION_ROLE_MODES.includes(mode)
          ? mode
          : "unique";

      // Resolve roles by name without creating anything yet.
      const allRoles = await this.api(
        () => guild.roles.fetch(),
        "fetch guild roles",
      );
      const keptRows = existingRows;
      const haveRoleIds = new Set(keptRows.map((r) => r.roleId));
      const haveEmojis = new Set(keptRows.map((r) => r.emoji));
      // Resolve the bot member through the retry/timeout wrapper. An explicit
      // null (fetch failed) makes the validator report it, not refetch.
      const botMember =
        guild.members.me ??
        (await this.api(
          () => guild.members.fetchMe(),
          "fetch bot member",
        ).catch(() => null));
      // Index every role by name, @everyone and managed ones included, so an
      // unassignable match is reported by the validator instead of creating a
      // duplicate. An assignable same-name role wins over an unassignable one
      // (managed, @everyone, or at/above the bot's highest role).
      const unassignable = (r: Role): boolean =>
        r.id === guild.roles.everyone.id ||
        r.managed ||
        (botMember !== null &&
          botMember.roles.highest.comparePositionTo(r) <= 0);
      const byName = new Map<string, Role>();
      for (const r of allRoles.values()) {
        const k = r.name.toLowerCase();
        const cur = byName.get(k);
        if (!cur || (unassignable(cur) && !unassignable(r))) byName.set(k, r);
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
          groupId: existingRows[0]?.groupId,
          messageId: anchor?.id,
          createdRoles: [],
          reusedRoles: [],
          addedEntries: 0,
          skippedEntries: skipped,
        };
      }
      if (keptRows.length + todo.length > MAX_GROUP_ENTRIES) {
        return fail(
          `Adding ${todo.length} option(s) would exceed the ${MAX_GROUP_ENTRIES}-reaction limit for this group.`,
        );
      }

      // Validate reused roles are assignable before creating anything.
      const toValidate = todo.flatMap((t) => (t.role ? [t.role] : []));
      for (const role of toValidate) {
        const ok = await rrService.validateRoleAssignable(
          guild,
          role,
          botMember,
        );
        if (!ok.ok) return fail(ok.message);
      }

      const rawColour = (
        await configService.getString("reactionroles.group_role_colour", "")
      ).trim();
      const colour = parseRoleColour(rawColour);
      if (rawColour && colour === undefined) {
        return fail(
          `Setting reactionroles.group_role_colour ("${rawColour}") is not a valid #RRGGBB colour. Fix it or leave it empty.`,
        );
      }
      const reused: string[] = [];
      const created: string[] = [];
      for (const t of todo) {
        if (t.role) {
          reused.push(t.role.id);
          continue;
        }
        const role = await this.createOnce(
          () =>
            guild.roles.create({
              name: t.roleName,
              ...(colour !== undefined
                ? { colors: { primaryColor: colour } }
                : {}),
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
        ...keptRows.map((r) => ({ roleName: r.roleName, emoji: r.emoji })),
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
        touchedExisting = true;
        previousEmbeds = (a.embeds ?? []).map((e) => EmbedBuilder.from(e));
        target = await this.api(
          () => a.edit({ embeds: [embed] }),
          `edit group message ${a.id}`,
        );
        editedAnchor = a;
      } else {
        postedMessage = await this.createOnce(
          () => channel.send({ embeds: [embed] }),
          "post group message",
        );
        target = postedMessage;
      }
      const reactEmojis = [...todo.map((t) => t.emoji)];
      for (const emoji of reactEmojis) {
        await this.api(
          () => target.react(emoji),
          `react ${emoji} on group message`,
        );
        addedReactions.push(emoji);
      }

      const groupId = existingRows[0]?.groupId ?? target.id;
      const newDocs = [
        ...todo.map((t) => ({
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
      ];
      // Persist. The unique index {guildId, messageId, emoji} ignores
      // isArchived, so on a top-up drop retired rows (e.g. archived when their
      // role was deleted) that still hold an emoji being added. A failure is
      // undone by the catch (it cannot tell how much was committed).
      if (anchor) {
        await ReactionRoleConfig.deleteMany({
          guildId,
          messageId: anchor.id,
          emoji: { $in: todo.map((t) => t.emoji) },
          isArchived: true,
        });
      }
      insertAttempt = {
        messageId: target.id,
        roleIds: newDocs.map((d) => d.roleId),
      };
      await ReactionRoleConfig.insertMany(newDocs);

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
      // Rows first, so no mapping ever points at a resource deleted below.
      const attempt = insertAttempt as {
        messageId: string;
        roleIds: string[];
      } | null;
      if (attempt) {
        await ReactionRoleConfig.deleteMany({
          guildId,
          messageId: attempt.messageId,
          roleId: { $in: attempt.roleIds },
          isArchived: false,
        }).catch((err) => logger.warn("Could not remove new mappings:", err));
      }
      if (editedAnchor) {
        const a = editedAnchor as Message;
        await this.api(
          () => a.edit({ embeds: previousEmbeds }),
          `restore group message ${a.id}`,
        ).catch((err) => logger.warn("Could not restore group message:", err));
        for (const emoji of addedReactions) {
          const id = emoji.match(/(\d{17,20})/)?.[1] ?? emoji;
          const reaction = a.reactions.resolve(id);
          const botId = this.client.user?.id;
          if (!reaction || !botId) continue;
          // Only the bot's own reaction: reaction.remove() would also wipe
          // reactions members added before this run.
          await this.api(
            () => reaction.users.remove(botId),
            `remove reaction ${emoji}`,
          ).catch((err) => logger.warn("Could not remove reaction:", err));
        }
      }
      if (postedMessage) {
        const posted = postedMessage as Message;
        await this.api(
          () => posted.delete(),
          `delete group message ${posted.id}`,
        ).catch((err) => logger.warn("Could not delete group message:", err));
      }
      for (const role of createdRoles) {
        await this.api(
          () => role.delete(),
          `delete group role ${role.id}`,
        ).catch((err) => logger.warn("Could not delete group role:", err));
      }
      // A timed-out edit or reaction may still land after rollback; the retry
      // wrapper cannot cancel it, so ask the admin to check by hand.
      const timedOut =
        touchedExisting &&
        error instanceof Error &&
        error.message.toLowerCase().includes("timeout");
      return fail(
        `Failed to generate role group: ${error instanceof Error ? error.message : "Unknown error"}${
          timedOut
            ? " Discord was slow to answer, so the existing picker message may have been edited or reacted to late. Check the picker message and its reactions by hand."
            : ""
        }`,
      );
    }
  }
}
