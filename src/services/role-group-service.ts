import { PermissionsBitField, type Guild, type GuildMember } from "discord.js";
import logger from "../utils/logger.js";
import {
  RoleGroup,
  type IRoleGroup,
  type RoleGroupCapability,
  type RoleGroupSyncPolicy,
} from "../models/role-group.js";
import { ReactionRoleConfig } from "../models/reaction-role-config.js";
import { ConfigService } from "./config-service.js";
import { parseTierConfig, TIERS_KEY } from "../web/leaderboard-tiers.js";
import {
  validateGroupInput,
  type GroupInput,
  type GroupSpec,
} from "./role-group-plan.js";
import type { ScannedState } from "./server-adoption-planner.js";
import type { ScannedMember } from "./role-group-sync.js";

/**
 * Role groups (#1020): admin-defined, ranked handles on Discord roles, plus
 * the query API features use so they never read role ids themselves.
 *
 * ## For feature authors (#1021, #1022, #1023)
 *
 * ```ts
 * const groups = RoleGroupService.getInstance();
 * await groups.memberHasCapability(member, "staff"); // mod-or-above check
 * await groups.getGroupsWith(guildId, "staff");      // every staff group
 * await groups.memberIsAtOrAbove(member, groupId);   // "this group and above"
 * ```
 *
 * - Groups are optional. With none defined every query answers "no group",
 *   and the caller keeps its existing behaviour.
 * - The guild owner and anyone holding Discord's `Administrator` permission
 *   always count as `admin` (and therefore `staff`), with or without a group.
 * - `staff` is held by any member of a `staff` group *or* an `admin` one.
 * - A `bot` group only ever matches bot accounts; human-facing features
 *   (leaderboards, digest, achievements, welcome) should skip members for
 *   whom `isBotAccount(member)` is true.
 * - Queries read through a short per-guild cache that every write here
 *   invalidates, so a Web UI edit takes effect immediately.
 */

export interface RoleGroupView extends GroupSpec {
  hoist: boolean;
  roleName: string | null;
  unlinked: boolean;
  lostRoleId: string | null;
  recreateRequestedAt: Date | null;
  syncPolicy: RoleGroupSyncPolicy | null;
  driftSignature: string | null;
  createdAt: Date;
}

const CACHE_TTL_MS = 15_000;

function toView(doc: IRoleGroup): RoleGroupView {
  return {
    id: String(doc._id),
    name: doc.name,
    roleId: doc.roleId ?? null,
    rank: doc.rank,
    permissions: doc.permissions ?? null,
    capabilities: [...doc.capabilities],
    colour: doc.colour ?? null,
    hoist: doc.hoist === true,
    createdByKoolbot: doc.createdByKoolbot === true,
    gateOnly: doc.gateOnly === true,
    roleName: doc.roleName ?? null,
    unlinked: doc.unlinked === true,
    lostRoleId: doc.lostRoleId ?? null,
    recreateRequestedAt: doc.recreateRequestedAt ?? null,
    syncPolicy: doc.syncPolicy ?? null,
    driftSignature: doc.driftSignature ?? null,
    createdAt: doc.createdAt,
  };
}

export type GroupResult =
  { ok: true; group: RoleGroupView } | { ok: false; error: string };

export class RoleGroupService {
  private static instance: RoleGroupService | undefined;
  private readonly cache = new Map<
    string,
    { at: number; groups: RoleGroupView[] }
  >();

  public static getInstance(): RoleGroupService {
    RoleGroupService.instance ??= new RoleGroupService();
    return RoleGroupService.instance;
  }

  /** Test seam. */
  public static reset(): void {
    RoleGroupService.instance = undefined;
  }

  private invalidate(guildId: string): void {
    this.cache.delete(guildId);
  }

  // ---- reads ------------------------------------------------------------

  /** All groups of a guild, highest rank first. */
  public async list(guildId: string): Promise<RoleGroupView[]> {
    const hit = this.cache.get(guildId);
    if (hit && Date.now() - hit.at < CACHE_TTL_MS) return hit.groups;
    const docs = await RoleGroup.find({ guildId }).sort({ rank: -1, name: 1 });
    const groups = docs.map(toView);
    this.cache.set(guildId, { at: Date.now(), groups });
    return groups;
  }

  public async get(
    guildId: string,
    groupId: string,
  ): Promise<RoleGroupView | null> {
    return (await this.list(guildId)).find((g) => g.id === groupId) ?? null;
  }

  /** Groups carrying a capability, highest rank first. */
  public async getGroupsWith(
    guildId: string,
    capability: RoleGroupCapability,
  ): Promise<RoleGroupView[]> {
    return (await this.list(guildId)).filter((g) =>
      g.capabilities.includes(capability),
    );
  }

  /** The group with this id plus every group ranked above it. */
  public async getGroupsAtOrAbove(
    guildId: string,
    groupId: string,
  ): Promise<RoleGroupView[]> {
    const all = await this.list(guildId);
    const base = all.find((g) => g.id === groupId);
    return base ? all.filter((g) => g.rank >= base.rank) : [];
  }

  /** Role ids backing the groups with a capability (for permission checks). */
  public async getRoleIdsWith(
    guildId: string,
    capability: RoleGroupCapability,
  ): Promise<string[]> {
    return (await this.getGroupsWith(guildId, capability)).flatMap((g) =>
      g.roleId ? [g.roleId] : [],
    );
  }

  public isBotAccount(member: GuildMember): boolean {
    return member.user.bot === true;
  }

  /**
   * Does the member hold a capability? Fails closed: if the groups can't be
   * read, only the owner / `Administrator` shortcut for `admin` and `staff`
   * still answers yes.
   */
  public async memberHasCapability(
    member: GuildMember,
    capability: RoleGroupCapability,
  ): Promise<boolean> {
    if (capability !== "bot") {
      if (member.guild.ownerId === member.id) return true;
      if (member.permissions?.has(PermissionsBitField.Flags.Administrator)) {
        return true;
      }
    }
    let groups: RoleGroupView[];
    try {
      groups = await this.list(member.guild.id);
    } catch (error) {
      logger.warn("role groups: could not read groups", error);
      return false;
    }
    if (capability === "bot" && !this.isBotAccount(member)) return false;
    const wanted: RoleGroupCapability[] =
      capability === "staff" ? ["staff", "admin"] : [capability];
    return groups.some(
      (g) =>
        g.roleId !== null &&
        g.capabilities.some((c) => wanted.includes(c)) &&
        member.roles.cache.has(g.roleId),
    );
  }

  /** Does the member hold the group's role, or one of any higher group? */
  public async memberIsAtOrAbove(
    member: GuildMember,
    groupId: string,
  ): Promise<boolean> {
    if (member.guild.ownerId === member.id) return true;
    let groups: RoleGroupView[];
    try {
      groups = await this.getGroupsAtOrAbove(member.guild.id, groupId);
    } catch (error) {
      logger.warn("role groups: could not read groups", error);
      return false;
    }
    return groups.some(
      (g) => g.roleId !== null && member.roles.cache.has(g.roleId),
    );
  }

  // ---- writes -----------------------------------------------------------

  public async create(
    guildId: string,
    input: GroupInput & {
      roleId?: string | null;
      /** Name the linked role carries now; tracked for drift (#1021). */
      roleName?: string | null;
      createdByKoolbot?: boolean;
    },
  ): Promise<GroupResult> {
    const existing = await this.list(guildId);
    const problem = validateGroupInput(input, existing);
    if (problem) return { ok: false, error: problem };
    if (input.roleId && existing.some((g) => g.roleId === input.roleId)) {
      return { ok: false, error: "That role already backs another group." };
    }
    // New groups go on top unless a rank is given.
    const rank = input.rank ?? (existing.length ? existing[0].rank + 1 : 1);
    try {
      const doc = await RoleGroup.create({
        guildId,
        name: input.name.trim(),
        roleId: input.roleId ?? null,
        roleName: input.roleId ? (input.roleName ?? null) : null,
        rank,
        permissions: input.permissions ?? null,
        capabilities: [
          ...new Set(input.capabilities ?? []),
        ] as RoleGroupCapability[],
        colour: input.colour ?? null,
        hoist: input.hoist ?? false,
        gateOnly: input.gateOnly ?? false,
        createdByKoolbot: input.createdByKoolbot ?? false,
      });
      return { ok: true, group: toView(doc) };
    } catch (error) {
      if ((error as { code?: number }).code === 11000) {
        return { ok: false, error: "That name or role is already in use." };
      }
      throw error;
    } finally {
      this.invalidate(guildId);
    }
  }

  public async update(
    guildId: string,
    groupId: string,
    input: GroupInput,
  ): Promise<GroupResult> {
    const all = await this.list(guildId);
    const current = all.find((g) => g.id === groupId);
    if (!current) return { ok: false, error: "That group no longer exists." };
    const problem = validateGroupInput(
      input,
      all.filter((g) => g.id !== groupId),
    );
    if (problem) return { ok: false, error: problem };
    if (current.gateOnly && (input.capabilities ?? []).length > 0) {
      return {
        ok: false,
        error: "A gate-only group can't carry capabilities.",
      };
    }
    const set: Record<string, unknown> = {
      name: input.name.trim(),
      capabilities: [...new Set(input.capabilities ?? [])],
    };
    // A managed role is never edited, so its desired values stay unset.
    if (!current.gateOnly) {
      if (input.permissions !== undefined) set.permissions = input.permissions;
      if (input.colour !== undefined) set.colour = input.colour;
      if (input.hoist !== undefined) set.hoist = input.hoist;
    }
    if (input.rank !== undefined) set.rank = input.rank;
    try {
      const doc = await RoleGroup.findOneAndUpdate(
        { _id: groupId, guildId },
        { $set: set },
        { new: true },
      );
      if (!doc) return { ok: false, error: "That group no longer exists." };
      return { ok: true, group: toView(doc) };
    } catch (error) {
      if ((error as { code?: number }).code === 11000) {
        return { ok: false, error: "That name is already in use." };
      }
      throw error;
    } finally {
      this.invalidate(guildId);
    }
  }

  /**
   * Set the order from the top: `orderedIds[0]` becomes the highest rank.
   * Ids must be exactly the guild's groups.
   */
  public async reorder(
    guildId: string,
    orderedIds: readonly string[],
  ): Promise<{ ok: true } | { ok: false; error: string }> {
    const all = await this.list(guildId);
    const same =
      orderedIds.length === all.length &&
      new Set(orderedIds).size === all.length &&
      all.every((g) => orderedIds.includes(g.id));
    if (!same) {
      return {
        ok: false,
        error: "The order is out of date. Reload the page and try again.",
      };
    }
    try {
      await RoleGroup.bulkWrite(
        orderedIds.map((id, i) => ({
          updateOne: {
            filter: { _id: id, guildId },
            update: { $set: { rank: orderedIds.length - i } },
          },
        })),
      );
    } finally {
      this.invalidate(guildId);
    }
    return { ok: true };
  }

  /** Back a group with a role once the engine has created it. */
  public async linkRole(
    guildId: string,
    groupId: string,
    roleId: string,
    createdByKoolbot: boolean,
    roleName?: string,
  ): Promise<void> {
    try {
      await RoleGroup.updateOne(
        { _id: groupId, guildId, roleId: null },
        {
          $set: {
            roleId,
            createdByKoolbot,
            unlinked: false,
            lostRoleId: null,
            recreateRequestedAt: null,
            ...(roleName !== undefined ? { roleName } : {}),
          },
        },
      );
    } finally {
      this.invalidate(guildId);
    }
  }

  // ---- sync with Discord (#1021) -----------------------------------------

  /**
   * The role behind a group was deleted in Discord. The group keeps its
   * definition but loses its role link; it is never recreated on its own
   * (an admin re-links it, or the enforce policy asks for a new role).
   * Returns false when the group no longer pointed at that role.
   */
  public async markUnlinked(
    guildId: string,
    groupId: string,
    lostRoleId: string,
  ): Promise<boolean> {
    try {
      const res = await RoleGroup.updateOne(
        { _id: groupId, guildId, roleId: lostRoleId },
        {
          $set: {
            roleId: null,
            unlinked: true,
            lostRoleId,
            driftSignature: null,
            recreateRequestedAt: null,
          },
        },
      );
      return res.modifiedCount > 0;
    } finally {
      this.invalidate(guildId);
    }
  }

  /**
   * Ask for a new role for an unlinked group: the next plan creates one named
   * after the group, and only roles created from now on may link back to it.
   */
  public async requestRecreate(
    guildId: string,
    groupId: string,
  ): Promise<boolean> {
    try {
      const res = await RoleGroup.updateOne(
        { _id: groupId, guildId, unlinked: true, gateOnly: false },
        { $set: { unlinked: false, recreateRequestedAt: new Date() } },
      );
      return res.modifiedCount > 0;
    } finally {
      this.invalidate(guildId);
    }
  }

  /** Point an unlinked group at another existing role. */
  public async relinkTo(
    guildId: string,
    groupId: string,
    roleId: string,
    roleName: string,
  ): Promise<GroupResult> {
    const all = await this.list(guildId);
    if (all.some((g) => g.roleId === roleId)) {
      return { ok: false, error: "That role already backs another group." };
    }
    try {
      const doc = await RoleGroup.findOneAndUpdate(
        { _id: groupId, guildId, unlinked: true },
        {
          $set: {
            roleId,
            roleName,
            unlinked: false,
            lostRoleId: null,
            recreateRequestedAt: null,
            createdByKoolbot: false,
            driftSignature: null,
          },
        },
        { new: true },
      );
      if (!doc) return { ok: false, error: "That group isn't unlinked." };
      return { ok: true, group: toView(doc) };
    } catch (error) {
      if ((error as { code?: number }).code === 11000) {
        return { ok: false, error: "That role already backs another group." };
      }
      throw error;
    } finally {
      this.invalidate(guildId);
    }
  }

  /** *Adopt*: make group definitions follow what Discord holds. */
  public async applyAdopted(
    guildId: string,
    updates: ReadonlyArray<{
      groupId: string;
      set: { permissions?: string; roleName?: string; rank?: number };
    }>,
  ): Promise<void> {
    if (updates.length === 0) return;
    try {
      await RoleGroup.bulkWrite(
        updates.map((u) => ({
          updateOne: {
            filter: { _id: u.groupId, guildId },
            update: { $set: u.set },
          },
        })),
      );
    } finally {
      this.invalidate(guildId);
    }
  }

  /** Start tracking role names recorded for the first time (never overwrites). */
  public async trackRoleNames(
    guildId: string,
    entries: ReadonlyArray<{ groupId: string; roleName: string }>,
  ): Promise<void> {
    if (entries.length === 0) return;
    try {
      await RoleGroup.bulkWrite(
        entries.map((e) => ({
          updateOne: {
            filter: { _id: e.groupId, guildId, roleName: null },
            update: { $set: { roleName: e.roleName } },
          },
        })),
      );
    } finally {
      this.invalidate(guildId);
    }
  }

  public async setSyncPolicy(
    guildId: string,
    groupId: string,
    policy: RoleGroupSyncPolicy | null,
  ): Promise<void> {
    try {
      await RoleGroup.updateOne(
        { _id: groupId, guildId },
        { $set: { syncPolicy: policy } },
      );
    } finally {
      this.invalidate(guildId);
    }
  }

  public async setDriftSignature(
    guildId: string,
    groupId: string,
    signature: string | null,
  ): Promise<void> {
    try {
      await RoleGroup.updateOne(
        { _id: groupId, guildId },
        { $set: { driftSignature: signature } },
      );
    } finally {
      this.invalidate(guildId);
    }
  }

  /** Delete the group only. The Discord role is never touched here. */
  public async remove(guildId: string, groupId: string): Promise<boolean> {
    try {
      const res = await RoleGroup.deleteOne({ _id: groupId, guildId });
      return res.deletedCount > 0;
    } finally {
      this.invalidate(guildId);
    }
  }

  // ---- adoption support -------------------------------------------------

  /**
   * Features that still use a role, so it can't be deleted from under them.
   * Best effort: a feature whose settings can't be read blocks deletion.
   */
  public async featureUsesOfRole(
    guildId: string,
    roleId: string,
  ): Promise<string[]> {
    const uses: string[] = [];
    try {
      const tiers = parseTierConfig(
        await ConfigService.getInstance().getString(TIERS_KEY, ""),
      ).tiers;
      if (tiers.some((t) => t.roleId === roleId))
        uses.push("Leaderboard Roles");
      if (await ReactionRoleConfig.exists({ guildId, roleId })) {
        uses.push("Reaction Roles");
      }
    } catch (error) {
      logger.warn("role groups: feature usage check failed", error);
      uses.push("a feature whose settings could not be read");
    }
    return uses;
  }
}

/**
 * Role ids a plan may delete without approval: the ones KoolBot created for a
 * group. Fed to the planner as `koolbotCreatedIds`.
 */
export function koolbotCreatedRoleIds(groups: readonly GroupSpec[]): string[] {
  return groups.flatMap((g) =>
    g.createdByKoolbot && g.roleId ? [g.roleId] : [],
  );
}

export interface GuildScan {
  scanned: ScannedState;
  /** Holder count per role, from Discord, without loading members. */
  memberCounts: Map<string, number>;
  /** Bots known in the guild; `null` when the member list was unavailable. */
  botIds: string[] | null;
  /**
   * Every member's roles, only when requested and the list was available
   * (`null` otherwise). Feeds the out-of-group administrator report (#1021).
   */
  members: ScannedMember[] | null;
}

/**
 * Read the guild into the planner's `ScannedState` (roles only: role groups
 * don't touch channels). `adminUserId` is the admin applying the plan.
 *
 * Bots are only enumerated when `needBots` is set (a bot group exists), and
 * all members when `needMembers` is (an admin group exists, #1021). Both need
 * the privileged `GuildMembers` intent; without it `botIds` / `members` are
 * `null` and the UI says so rather than planning against a partial list.
 */
export async function scanGuildRoles(
  guild: Guild,
  adminUserId: string,
  groups: readonly GroupSpec[],
  needBots: boolean,
  needMembers = false,
): Promise<GuildScan> {
  const roles = await guild.roles.fetch();
  const me = guild.members.me ?? (await guild.members.fetchMe());
  const admin = await guild.members.fetch(adminUserId);
  const memberCounts = new Map<string, number>(
    await guild.roles
      .fetchMemberCounts()
      .then((c) => [...c.entries()])
      .catch((error: unknown) => {
        logger.debug("role groups: member counts unavailable", error);
        return [] as Array<[string, number]>;
      }),
  );

  let botIds: string[] | null = null;
  let memberList: ScannedMember[] | null = null;
  const memberRoles: Record<string, string[]> = {};
  if (needBots || needMembers) {
    try {
      const members = await guild.members.fetch();
      const bots: string[] = [];
      const list: ScannedMember[] = [];
      for (const m of members.values()) {
        const roleIds = [...m.roles.cache.keys()];
        list.push({
          id: m.id,
          name: m.displayName,
          bot: m.user.bot === true,
          roleIds,
        });
        if (needMembers) memberRoles[m.id] = roleIds;
        if (m.user.bot && m.id !== me.id) {
          bots.push(m.id);
          memberRoles[m.id] = roleIds;
        }
      }
      botIds = bots;
      memberList = list;
    } catch (error) {
      logger.warn("role groups: could not list members", error);
    }
  }

  const scanned: ScannedState = {
    guildId: guild.id,
    ownerId: guild.ownerId,
    botUserId: me.id,
    botRoleIds: [...me.roles.cache.keys()],
    botHighestRolePosition: me.roles.highest.position,
    adminUserId,
    adminRoleIds: [...admin.roles.cache.keys()],
    otherBotIds: botIds ?? [],
    roles: [...roles.values()].map((r) => ({
      id: r.id,
      name: r.name,
      color: r.color,
      permissions: r.permissions.bitfield.toString(),
      position: r.position,
      managed: r.managed,
    })),
    channels: [],
    config: {},
    boundChannelIds: [],
    koolbotCreatedIds: koolbotCreatedRoleIds(groups),
    memberRoles,
  };
  return { scanned, memberCounts, botIds, members: memberList };
}
