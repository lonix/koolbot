import type { Client, Guild, Role } from "discord.js";
import logger from "../utils/logger.js";
import { sanitizeForLog } from "../utils/log-sanitize.js";
import { AdoptionSnapshot } from "../models/adoption-snapshot.js";
import { ScheduledService } from "./scheduled-service.js";
import { DiscordLogger } from "./discord-logger.js";
import {
  RoleGroupService,
  scanGuildRoles,
  type RoleGroupView,
} from "./role-group-service.js";
import { buildDesiredState } from "./role-group-plan.js";
import {
  adoptUpdates,
  detectDrift,
  driftSignature,
  resolvePolicy,
  type DriftItem,
} from "./role-group-sync.js";
import {
  planAdoption,
  type DesiredState,
  type RoleState,
} from "./server-adoption-planner.js";
import { linkCreatedRoles } from "./role-group-adoption.js";
import {
  BUSY_MESSAGE,
  ServerAdoptionService,
} from "./server-adoption-service.js";
import type { WebSessionContext } from "../web/session.js";

/**
 * Keeps role groups and their Discord roles in sync (#1021).
 *
 * One reconcile path serves everything: a debounced run after a role is
 * edited or deleted in Discord, and a periodic job that catches changes made
 * while the bot was offline. Each pass compares the groups with the live
 * roles (`role-group-sync.ts`) and then, per group policy:
 *
 * - `flag`: report only (page + Discord log). The default.
 * - `adopt`: the group definition follows Discord. Database only.
 * - `enforce`: re-apply the definition through the adoption engine, so the
 *   change is planned, snapshotted and audited like any other. It restores
 *   what the admin defined; it never widens access on its own. If an enforce
 *   plan can't be applied the group falls back to `flag` and stays there
 *   until an admin changes it, so the bot never retries in a loop.
 *
 * A deleted role marks its group *unlinked* and alerts the admin. It is only
 * recreated under `enforce`.
 *
 * Reconciles are skipped while an adoption apply or rollback is running: the
 * engine's own edits fire the same events and must not be mistaken for drift.
 */

const DEBOUNCE_MS = 5_000;
const BUSY_RETRY_MS = 30_000;
const MAX_BUSY_RETRIES = 10;
const JOB_POLL_MS = 2_000;
const JOB_MAX_WAIT_MS = 10 * 60_000;

export interface ReconcileSummary {
  groups: number;
  drift: number;
  unlinked: number;
  adopted: number;
  enforced: number;
  skipped: boolean;
}

const EMPTY: ReconcileSummary = {
  groups: 0,
  drift: 0,
  unlinked: 0,
  adopted: 0,
  enforced: 0,
  skipped: false,
};

function toRoleState(role: Role): RoleState {
  return {
    id: role.id,
    name: role.name,
    color: role.color,
    permissions: role.permissions.bitfield.toString(),
    position: role.position,
    managed: role.managed,
  };
}

export class RoleGroupSyncService extends ScheduledService<ReconcileSummary | null> {
  private static instance: RoleGroupSyncService;
  private readonly timers = new Map<string, ReturnType<typeof setTimeout>>();
  private readonly retries = new Map<string, number>();
  /** Reconciles of one guild run one after another. */
  private chain: Promise<unknown> = Promise.resolve();

  private constructor(client: Client) {
    super(client, {
      label: "Role group sync",
      disabledMessage: "Role group sync is disabled",
      cronContext: "role group sync",
      runLabel: "Role group reconcile",
    });
  }

  public static getInstance(client: Client): RoleGroupSyncService {
    if (!RoleGroupSyncService.instance) {
      RoleGroupSyncService.instance = new RoleGroupSyncService(client);
    } else if (RoleGroupSyncService.instance.client !== client) {
      throw new Error(
        "RoleGroupSyncService already initialised with a different client",
      );
    }
    return RoleGroupSyncService.instance;
  }

  public static reset(): void {
    if (RoleGroupSyncService.instance) {
      RoleGroupSyncService.instance.destroy();
    }
    RoleGroupSyncService.instance =
      undefined as unknown as RoleGroupSyncService;
  }

  public override destroy(): void {
    for (const timer of this.timers.values()) clearTimeout(timer);
    this.timers.clear();
    this.retries.clear();
    super.destroy();
  }

  protected async isEnabled(): Promise<boolean> {
    return this.configService
      .getBoolean("adoption.role_groups.reconcile_enabled", true)
      .catch(() => true);
  }

  protected async resolveSchedule(): Promise<string> {
    return this.configService.getString(
      "adoption.role_groups.reconcile_cron",
      "*/30 * * * *",
    );
  }

  protected async runOnce(): Promise<ReconcileSummary | null> {
    const guildId = await this.configService.getString("GUILD_ID", "");
    if (!guildId) {
      logger.warn("Role group reconcile aborted: GUILD_ID not configured");
      return null;
    }
    const guild = await this.client.guilds.fetch(guildId).catch(() => null);
    if (!guild) {
      logger.warn("Role group reconcile aborted: guild not available");
      return null;
    }
    return this.reconcileGuild(guild);
  }

  // ---- Discord events ----------------------------------------------------

  /** A role was edited in Discord. Only a role behind a group matters. */
  public async handleRoleUpdate(oldRole: Role, newRole: Role): Promise<void> {
    if (
      oldRole.name === newRole.name &&
      oldRole.permissions.bitfield === newRole.permissions.bitfield &&
      oldRole.position === newRole.position
    ) {
      return;
    }
    await this.noteRoleEvent(newRole);
  }

  /** A role was deleted in Discord. */
  public async handleRoleDelete(role: Role): Promise<void> {
    await this.noteRoleEvent(role);
  }

  private async noteRoleEvent(role: Role): Promise<void> {
    if (!(await this.isEnabled())) return;
    const guildId = role.guild.id;
    try {
      const groups = await RoleGroupService.getInstance().list(guildId);
      if (!groups.some((g) => g.roleId === role.id)) return;
    } catch (error) {
      logger.warn("role group sync: could not read groups", error);
      return;
    }
    this.schedule(guildId, DEBOUNCE_MS);
  }

  /**
   * Moving one role fires an update for many; collapse the burst into one
   * reconcile a few seconds after the last event.
   */
  private schedule(guildId: string, delayMs: number): void {
    const existing = this.timers.get(guildId);
    if (existing) clearTimeout(existing);
    const timer = setTimeout(() => {
      this.timers.delete(guildId);
      void this.runForGuild(guildId);
    }, delayMs);
    timer.unref?.();
    this.timers.set(guildId, timer);
  }

  private async runForGuild(guildId: string): Promise<void> {
    try {
      const guild = await this.client.guilds.fetch(guildId);
      const summary = await this.reconcileGuild(guild);
      if (summary.skipped) {
        const n = (this.retries.get(guildId) ?? 0) + 1;
        if (n <= MAX_BUSY_RETRIES) {
          this.retries.set(guildId, n);
          this.schedule(guildId, BUSY_RETRY_MS);
        } else {
          this.retries.delete(guildId);
        }
      } else {
        this.retries.delete(guildId);
      }
    } catch (error) {
      logger.error("role group sync: event reconcile failed", error);
    }
  }

  // ---- reconcile ---------------------------------------------------------

  /** One pass for a guild. Never throws for a Discord or database failure. */
  public reconcileGuild(guild: Guild): Promise<ReconcileSummary> {
    const run = this.chain.then(() => this.reconcileNow(guild));
    this.chain = run.catch(() => undefined);
    return run.catch((error: unknown) => {
      logger.error("role group sync: reconcile failed", error);
      return { ...EMPTY };
    });
  }

  private async adoptionIsActive(guildId: string): Promise<boolean> {
    try {
      return (
        (await AdoptionSnapshot.exists({ guildId, active: true })) !== null
      );
    } catch {
      return true; // can't tell: don't risk reading a half-applied state
    }
  }

  private async reconcileNow(guild: Guild): Promise<ReconcileSummary> {
    const service = RoleGroupService.getInstance();
    let groups = await service.list(guild.id);
    if (groups.length === 0) return { ...EMPTY };
    if (await this.adoptionIsActive(guild.id)) {
      logger.debug("role group sync: adoption in progress, skipping");
      return { ...EMPTY, groups: groups.length, skipped: true };
    }
    const summary: ReconcileSummary = { ...EMPTY, groups: groups.length };
    const actions: string[] = [];

    // Link roles a finished apply created, before judging anything missing.
    await linkCreatedRoles(guild.id);
    groups = await service.list(guild.id);

    const globalPolicy = await this.configService
      .getString("adoption.role_groups.sync_policy", "flag")
      .catch(() => "flag");
    const roleStates = [
      ...(await guild.roles.fetch(undefined, { force: true })).values(),
    ].map(toRoleState);
    let items = detectDrift(groups, roleStates, guild.id);

    // 1. Deleted roles: mark unlinked (a fact), recreate only under enforce.
    const recreate = new Set<string>();
    for (const item of items.filter((i) => i.kind === "deleted")) {
      const group = groups.find((g) => g.id === item.groupId);
      if (!group?.roleId) continue;
      const done = await service.markUnlinked(guild.id, group.id, group.roleId);
      if (!done) continue;
      summary.unlinked += 1;
      actions.push(
        `**${group.name}**: its Discord role was deleted; the group is now unlinked.`,
      );
      if (!group.gateOnly && resolvePolicy(group, globalPolicy) === "enforce") {
        if (await service.requestRecreate(guild.id, group.id)) {
          recreate.add(group.id);
        }
      }
    }
    if (summary.unlinked > 0) groups = await service.list(guild.id);
    items = items.filter((i) => i.kind !== "deleted");

    // 2. Split what's left by policy.
    const policyOf = (id: string): ReturnType<typeof resolvePolicy> => {
      const g = groups.find((x) => x.id === id);
      return g ? resolvePolicy(g, globalPolicy) : "flag";
    };
    const adoptItems = items.filter(
      (i) => i.kind !== "admin-permission" && policyOf(i.groupId) === "adopt",
    );
    const enforceItems = items.filter(
      (i) => i.kind !== "admin-permission" && policyOf(i.groupId) === "enforce",
    );

    // 3. Adopt: the definitions follow Discord (database only).
    if (adoptItems.length > 0) {
      const updates = adoptUpdates(groups, roleStates, adoptItems, guild.id);
      try {
        await service.applyAdopted(guild.id, updates);
        summary.adopted = updates.length;
        for (const i of adoptItems) {
          actions.push(`**${i.groupName}**: adopted from Discord. ${i.detail}`);
        }
      } catch (error) {
        logger.error("role group sync: adopt failed", error);
        actions.push("Adopting the Discord changes failed; they stay flagged.");
      }
      items = items.filter((i) => !adoptItems.includes(i));
    }

    // 4. Enforce: re-apply through the engine.
    const enforceIds = new Set<string>([
      ...enforceItems.map((i) => i.groupId),
      ...recreate,
    ]);
    if (enforceIds.size > 0) {
      const result = await this.enforce(guild, groups, enforceIds, recreate);
      actions.push(...result.notes);
      summary.enforced = result.applied;
      if (result.fellBack.length > 0) {
        for (const id of result.fellBack) {
          await service.setSyncPolicy(guild.id, id, "flag");
        }
      } else {
        items = items.filter((i) => !enforceIds.has(i.groupId));
      }
    }

    // 5. What remains is drift to show; log it only when it changed.
    summary.drift = items.length;
    const fresh = await this.updateSignatures(guild.id, groups, items);
    if (actions.length > 0 || fresh.length > 0) {
      await this.log(guild.id, actions, fresh);
    }
    return summary;
  }

  /** Groups whose drift changed since it was last reported. */
  private async updateSignatures(
    guildId: string,
    groups: readonly RoleGroupView[],
    items: readonly DriftItem[],
  ): Promise<DriftItem[]> {
    const service = RoleGroupService.getInstance();
    const fresh: DriftItem[] = [];
    for (const g of groups) {
      const own = items.filter((i) => i.groupId === g.id);
      const sig = driftSignature(own);
      if (sig === g.driftSignature) continue;
      await service.setDriftSignature(guildId, g.id, sig);
      if (sig !== null) fresh.push(...own);
    }
    return fresh;
  }

  private async enforce(
    guild: Guild,
    groups: readonly RoleGroupView[],
    enforceIds: ReadonlySet<string>,
    recreate: ReadonlySet<string>,
  ): Promise<{ applied: number; fellBack: string[]; notes: string[] }> {
    const notes: string[] = [];
    const botId = this.client.user?.id;
    const fail = (
      reason: string,
    ): {
      applied: number;
      fellBack: string[];
      notes: string[];
    } => {
      notes.push(
        `Enforce could not be applied (${reason}). The affected group(s) are switched to flag-only; change them back on the Role Groups page once resolved.`,
      );
      return { applied: 0, fellBack: [...enforceIds], notes };
    };
    if (!botId) return fail("the bot user is not ready");

    try {
      const scan = await scanGuildRoles(guild, botId, groups, false);
      const { desired: all, issues } = buildDesiredState(groups, scan.scanned, {
        ensureAdministrator: false,
      });
      const mine = groups.filter((g) => enforceIds.has(g.id));
      const roleIds = new Set(
        mine.flatMap((g) => (g.roleId ? [g.roleId] : [])),
      );
      const newNames = new Set(
        mine.filter((g) => recreate.has(g.id)).map((g) => g.name),
      );
      const blocking = issues.filter(
        (i) =>
          i.targetId !== undefined && mine.some((g) => g.id === i.targetId),
      );
      if (blocking.length > 0) {
        return fail(blocking.map((i) => i.message).join(" "));
      }
      // Only the roles being enforced: other groups keep their own policy,
      // and bot grants stay a manual, previewed step.
      const desired: DesiredState = {
        roles: (all.roles ?? []).filter((r) =>
          r.id ? roleIds.has(r.id) : newNames.has(r.name),
        ),
      };
      const plan = planAdoption(scan.scanned, desired, { approverId: botId });
      if (plan.errors.length > 0) {
        return fail(plan.errors.map((e) => e.message).join(" "));
      }
      if (plan.operations.length === 0)
        return { applied: 0, fellBack: [], notes };

      const engine = await ServerAdoptionService.getInstance(
        this.client,
        guild,
      );
      const actor: WebSessionContext = {
        sessionId: "system:role-group-sync",
        discordUserId: botId,
        guildId: guild.id,
        role: "admin",
        scopes: [],
        lastActivityAt: Date.now(),
        expiresAt: new Date(Date.now() + JOB_MAX_WAIT_MS),
      };
      const job = engine.startApply(plan, { actor });
      const deadline = Date.now() + JOB_MAX_WAIT_MS;
      while (job.status === "running" && Date.now() < deadline) {
        await new Promise((r) => setTimeout(r, JOB_POLL_MS));
      }
      if (job.status !== "done" || (job.result?.failed.length ?? 0) > 0) {
        return fail(
          job.error ??
            job.result?.failed.map((f) => f.error).join("; ") ??
            "the apply did not finish",
        );
      }
      await linkCreatedRoles(guild.id);
      for (const op of plan.operations) notes.push(`Enforced: ${op.summary}.`);
      return { applied: plan.operations.length, fellBack: [], notes };
    } catch (error) {
      if (error instanceof Error && error.message === BUSY_MESSAGE) {
        // Another apply holds the lock: not a failure, the next pass retries.
        logger.info("role group sync: adoption busy, enforce deferred");
        return { applied: 0, fellBack: [], notes };
      }
      logger.error("role group sync: enforce failed", error);
      return fail(error instanceof Error ? error.message : "unknown error");
    }
  }

  private async log(
    guildId: string,
    actions: readonly string[],
    drift: readonly DriftItem[],
  ): Promise<void> {
    for (const line of actions) {
      logger.info(`role group sync [${guildId}]: ${sanitizeForLog(line)}`);
    }
    for (const d of drift) {
      logger.warn(
        `role group drift [${guildId}]: ${sanitizeForLog(d.groupName)}: ${sanitizeForLog(d.detail)}`,
      );
    }
    const fields = [
      ...(actions.length
        ? [
            {
              name: "What the sync did",
              value: actions.join("\n").slice(0, 1000),
            },
          ]
        : []),
      ...(drift.length
        ? [
            {
              name: "Drift to review",
              value: drift
                .map((d) => `**${d.groupName}**: ${d.detail}`)
                .join("\n")
                .slice(0, 1000),
            },
          ]
        : []),
    ];
    await DiscordLogger.getInstance(this.client).logToChannel("role_groups", {
      title: "Role groups: drift from Discord",
      description:
        "A role behind a role group changed in Discord. Review it on the Role Groups page of the web UI.",
      color: "#e67e22",
      fields,
      footer: "KoolBot role group sync",
    });
  }
}
