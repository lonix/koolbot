import { randomUUID } from "node:crypto";
import {
  ChannelType,
  type Client,
  type Guild,
  type GuildBasedChannel,
  type GuildChannelCreateOptions,
  type PermissionOverwriteManager,
  type OverwriteType,
} from "discord.js";
import logger from "../utils/logger.js";
import { getErrorMessage } from "../utils/error-guards.js";
import {
  AdoptionSnapshot,
  type AdoptionOperationStatus,
  type AdoptionSnapshotStatus,
  type IAdoptionOperationRecord,
} from "../models/adoption-snapshot.js";
import { recordAudit, type AuditEntry } from "../web/audit.js";
import type { WebSessionContext } from "../web/session.js";
import { ConfigService } from "./config-service.js";
import { defaultConfig, settingsMetadata } from "./config-schema.js";
import {
  isApplicable,
  type AdoptionPlan,
  type ChannelState,
  type ConfigValue,
  type OverwriteState,
  type PlanOperation,
  type RoleState,
} from "./server-adoption-planner.js";

export {
  planAdoption,
  isApplicable,
  type AdoptionPlan,
  type DesiredState,
  type ScannedState,
} from "./server-adoption-planner.js";

/**
 * Applies, snapshots and rolls back server-adoption plans (#1018).
 *
 * Planning is pure (`server-adoption-planner.ts`). This service is the
 * executor: it writes a snapshot *before* the first Discord write, runs the
 * operations in dependency order (roles → categories → channels → members →
 * config → destructive) in rate-limit-friendly batches, records every
 * operation's outcome as it goes (so a partial failure can be resumed) and
 * audits each one to the Web UI audit log. Destructive steps run last and are
 * skipped if anything earlier failed.
 */

/** Everything the executor touches, injectable so it can be tested offline. */
export interface AdoptionGateway {
  createRole(input: {
    name: string;
    color: number;
    permissions: string;
    position: number | null;
  }): Promise<string>;
  editRole(roleId: string, changes: Partial<RoleState>): Promise<void>;
  deleteRole(roleId: string): Promise<void>;
  setOverwrite(channelId: string, overwrite: OverwriteState): Promise<void>;
  removeOverwrite(channelId: string, targetId: string): Promise<void>;
  deleteChannel(channelId: string): Promise<void>;
  recreateChannel(channel: ChannelState): Promise<string>;
  addMemberRole(memberId: string, roleId: string): Promise<void>;
  removeMemberRole(memberId: string, roleId: string): Promise<void>;
}

export interface AdoptionSnapshotRecord {
  id: string;
  planId: string;
  guildId: string;
  appliedBy: string;
  status: AdoptionSnapshotStatus;
  plan: AdoptionPlan;
  baseline: AdoptionPlan["baseline"];
  operations: IAdoptionOperationRecord[];
  createdRoles: Array<{ ref: string; roleId: string; name: string }>;
  restoredChannels: Array<{ oldId: string; newId: string }>;
  memberProgress: Record<
    string,
    { done: number; failed: string[]; granted: string[] }
  >;
  rolledBackBy: string | null;
}

export interface AdoptionStore {
  create(
    record: Omit<AdoptionSnapshotRecord, "id" | "rolledBackBy">,
  ): Promise<AdoptionSnapshotRecord>;
  get(id: string): Promise<AdoptionSnapshotRecord | null>;
  update(
    id: string,
    patch: Partial<Omit<AdoptionSnapshotRecord, "id">>,
  ): Promise<void>;
}

export interface AdoptionConfigWriter {
  set(key: string, value: ConfigValue): Promise<void>;
  reload(): Promise<void>;
}

export interface AdoptionDeps {
  gateway: AdoptionGateway;
  store: AdoptionStore;
  config: AdoptionConfigWriter;
  /** Wraps a Discord REST call (timeout + backoff); default: CommandManager. */
  callApi: <T>(call: () => Promise<T>, name: string) => Promise<T>;
  audit: (session: WebSessionContext, entry: AuditEntry) => Promise<void>;
  sleep: (ms: number) => Promise<void>;
}

export interface ApplyOptions {
  actor: WebSessionContext;
  /** Resume a previous partial apply of the same plan. */
  resumeSnapshotId?: string;
  /** Operations per batch (default 5). */
  batchSize?: number;
  /** Pause between batches in ms (default 1000). */
  batchDelayMs?: number;
  /** Members processed per page of a member operation (default 50). */
  memberPageSize?: number;
  onProgress?: (progress: ApplyProgress) => void;
}

export interface ApplyProgress {
  total: number;
  completed: number;
  failed: number;
  skipped: number;
  current: string | null;
}

export interface ApplyResult {
  snapshotId: string;
  status: AdoptionSnapshotStatus;
  applied: string[];
  failed: Array<{ opId: string; error: string }>;
  skipped: string[];
}

export interface RollbackOptions {
  actor: WebSessionContext;
  /** Also delete roles the plan created. Default false. */
  deleteCreatedRoles?: boolean;
}

export interface RollbackResult {
  snapshotId: string;
  restored: string[];
  failed: Array<{ opId: string; error: string }>;
  /** Plain-language limits the approval UI repeats to the admin. */
  notes: string[];
}

export class AdoptionPlanError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "AdoptionPlanError";
  }
}

export const DESTRUCTIVE_RESTORE_NOTE =
  "Deleted channels and roles are recreated from their saved structure only. Messages, pins, threads, webhooks and the original IDs can't be restored.";

/** Destructive operations always sit after every additive one in a plan. */
const isDestructive = (op: PlanOperation): boolean =>
  op.class === "destructive";

export interface AdoptionJob {
  id: string;
  status: "running" | "done" | "failed";
  progress: ApplyProgress;
  result: ApplyResult | null;
  error: string | null;
}

export class ServerAdoptionService {
  private static instance: ServerAdoptionService | undefined;
  private readonly jobs = new Map<string, AdoptionJob>();

  public constructor(private readonly deps: AdoptionDeps) {}

  /** Singleton wired to a live client: Discord writes go through CommandManager. */
  public static async getInstance(
    client: Client,
    guild: Guild,
  ): Promise<ServerAdoptionService> {
    if (!ServerAdoptionService.instance) {
      const { CommandManager } = await import("./command-manager.js");
      const manager = CommandManager.getInstance(client);
      ServerAdoptionService.instance = new ServerAdoptionService({
        gateway: new DiscordAdoptionGateway(guild),
        store: new MongoAdoptionStore(),
        config: new ConfigServiceWriter(),
        callApi: <T>(call: () => Promise<T>, name: string): Promise<T> =>
          manager.makeDiscordApiCall(call, name),
        audit: recordAudit,
        sleep: (ms: number): Promise<void> =>
          new Promise((resolve) => setTimeout(resolve, ms)),
      });
    }
    return ServerAdoptionService.instance;
  }

  public static reset(): void {
    ServerAdoptionService.instance = undefined;
  }

  // ---- apply ------------------------------------------------------------

  /**
   * Start an apply as a background job and return at once. Member-scoped
   * operations page through thousands of members, so they must never run
   * inside a web request; the UI polls `getJob` for progress.
   */
  public startApply(plan: AdoptionPlan, options: ApplyOptions): AdoptionJob {
    this.assertApplicable(plan);
    const job: AdoptionJob = {
      id: randomUUID(),
      status: "running",
      progress: {
        total: plan.operations.length,
        completed: 0,
        failed: 0,
        skipped: 0,
        current: null,
      },
      result: null,
      error: null,
    };
    this.jobs.set(job.id, job);
    void this.apply(plan, {
      ...options,
      onProgress: (progress) => {
        job.progress = progress;
        options.onProgress?.(progress);
      },
    })
      .then((result) => {
        job.result = result;
        job.status = "done";
      })
      .catch((error) => {
        job.error = getErrorMessage(error);
        job.status = "failed";
        logger.error("Server adoption apply failed:", error);
      });
    return job;
  }

  public getJob(id: string): AdoptionJob | undefined {
    return this.jobs.get(id);
  }

  public async apply(
    plan: AdoptionPlan,
    options: ApplyOptions,
  ): Promise<ApplyResult> {
    this.assertApplicable(plan);
    const { store } = this.deps;
    const batchSize = Math.max(1, options.batchSize ?? 5);
    const batchDelayMs = options.batchDelayMs ?? 1000;

    let snapshot: AdoptionSnapshotRecord;
    if (options.resumeSnapshotId) {
      const existing = await store.get(options.resumeSnapshotId);
      if (!existing)
        throw new AdoptionPlanError("Snapshot to resume not found.");
      if (existing.planId !== plan.id)
        throw new AdoptionPlanError("Snapshot belongs to a different plan.");
      if (existing.status === "rolled_back")
        throw new AdoptionPlanError("Snapshot was already rolled back.");
      snapshot = existing;
    } else {
      // The snapshot is saved before the first Discord write.
      snapshot = await store.create({
        planId: plan.id,
        guildId: plan.guildId,
        appliedBy: options.actor.discordUserId,
        status: "applying",
        plan,
        baseline: plan.baseline,
        operations: plan.operations.map((op) => ({
          opId: op.id,
          status: "pending" as AdoptionOperationStatus,
        })),
        createdRoles: [],
        restoredChannels: [],
        memberProgress: {},
      });
    }

    const records = new Map(snapshot.operations.map((r) => [r.opId, r]));
    const progress: ApplyProgress = {
      total: plan.operations.length,
      completed: 0,
      failed: 0,
      skipped: 0,
      current: null,
    };
    let earlierFailure = false;

    const persist = (): Promise<void> =>
      store.update(snapshot.id, {
        operations: [...records.values()],
        createdRoles: snapshot.createdRoles,
        memberProgress: snapshot.memberProgress,
      });

    const ops = plan.operations;
    for (let start = 0; start < ops.length; start += batchSize) {
      const batch = ops.slice(start, start + batchSize);
      for (const op of batch) {
        const record = records.get(op.id)!;
        if (record.status === "applied") {
          progress.completed++;
          continue;
        }
        progress.current = op.summary;
        // Destructive steps only run when every earlier step succeeded.
        if (isDestructive(op) && earlierFailure) {
          record.status = "skipped";
          record.error = "Skipped: an earlier operation failed.";
          progress.skipped++;
          await this.auditOp(
            options.actor,
            plan,
            snapshot.id,
            op,
            "failure",
            record.error,
          );
          await persist();
          options.onProgress?.({ ...progress });
          continue;
        }
        try {
          record.resultId = await this.execute(op, snapshot, options, persist);
          record.status = "applied";
          record.error = null;
          record.at = new Date();
          progress.completed++;
          await this.auditOp(options.actor, plan, snapshot.id, op, "success");
        } catch (error) {
          earlierFailure = true;
          record.status = "failed";
          record.error = getErrorMessage(error);
          record.at = new Date();
          progress.failed++;
          logger.error(`Adoption operation ${op.id} failed:`, error);
          await this.auditOp(
            options.actor,
            plan,
            snapshot.id,
            op,
            "failure",
            record.error,
          );
        }
        await persist();
        options.onProgress?.({ ...progress });
      }
      if (batchDelayMs > 0 && start + batchSize < ops.length) {
        await this.deps.sleep(batchDelayMs);
      }
    }

    const all = [...records.values()];
    const status: AdoptionSnapshotStatus = all.every(
      (r) => r.status === "applied",
    )
      ? "applied"
      : "partial";
    await store.update(snapshot.id, { status });

    try {
      await this.deps.config.reload();
    } catch (error) {
      logger.error("Config reload after adoption apply failed:", error);
    }

    return {
      snapshotId: snapshot.id,
      status,
      applied: all.filter((r) => r.status === "applied").map((r) => r.opId),
      failed: all
        .filter((r) => r.status === "failed")
        .map((r) => ({ opId: r.opId, error: r.error ?? "unknown error" })),
      skipped: all.filter((r) => r.status === "skipped").map((r) => r.opId),
    };
  }

  private assertApplicable(plan: AdoptionPlan): void {
    if (!isApplicable(plan)) {
      throw new AdoptionPlanError(
        `Plan has ${plan.errors.length} blocking error(s) and cannot be applied.`,
      );
    }
  }

  private resolveRef(snapshot: AdoptionSnapshotRecord, id: string): string {
    if (!id.startsWith("new:")) return id;
    const created = snapshot.createdRoles.find((r) => r.ref === id);
    if (!created) {
      throw new Error(
        `Role ${id} has not been created (an earlier step failed).`,
      );
    }
    return created.roleId;
  }

  private async execute(
    op: PlanOperation,
    snapshot: AdoptionSnapshotRecord,
    options: ApplyOptions,
    persist: () => Promise<void>,
  ): Promise<string | null> {
    const { gateway, callApi, config } = this.deps;
    switch (op.type) {
      case "role.create": {
        const roleId = await callApi(
          () =>
            gateway.createRole({
              name: op.name,
              color: op.color,
              permissions: op.permissions,
              position: op.position,
            }),
          `create role ${op.name}`,
        );
        snapshot.createdRoles.push({ ref: op.ref, roleId, name: op.name });
        return roleId;
      }
      case "role.edit":
        await callApi(
          () => gateway.editRole(op.roleId, op.changes),
          `edit role ${op.roleId}`,
        );
        return op.roleId;
      case "overwrite.set":
        await callApi(
          () =>
            gateway.setOverwrite(op.channelId, {
              id: this.resolveRef(snapshot, op.overwriteTargetId),
              type: op.overwriteTargetType,
              allow: op.allow,
              deny: op.deny,
            }),
          `set overwrite on ${op.channelId}`,
        );
        return op.channelId;
      case "overwrite.remove":
        await callApi(
          () => gateway.removeOverwrite(op.channelId, op.overwriteTargetId),
          `remove overwrite on ${op.channelId}`,
        );
        return op.channelId;
      case "channel.delete":
        await callApi(
          () => gateway.deleteChannel(op.channelId),
          `delete channel ${op.channelId}`,
        );
        return op.channelId;
      case "role.delete":
        await callApi(
          () => gateway.deleteRole(op.roleId),
          `delete role ${op.roleId}`,
        );
        return op.roleId;
      case "config.set":
        await config.set(op.key, op.value);
        return op.key;
      case "member.role.add":
        return this.applyMembers(op, snapshot, options, persist);
    }
  }

  /** Paged, resumable: progress is persisted after every page. */
  private async applyMembers(
    op: Extract<PlanOperation, { type: "member.role.add" }>,
    snapshot: AdoptionSnapshotRecord,
    options: ApplyOptions,
    persist: () => Promise<void>,
  ): Promise<string> {
    const { gateway, callApi } = this.deps;
    const roleId = this.resolveRef(snapshot, op.roleId);
    const pageSize = Math.max(1, options.memberPageSize ?? 50);
    const state = (snapshot.memberProgress[op.id] ??= {
      done: 0,
      failed: [],
      granted: [],
    });
    const grant = async (memberId: string): Promise<void> => {
      try {
        await callApi(
          () => gateway.addMemberRole(memberId, roleId),
          `grant role to ${memberId}`,
        );
        state.granted.push(memberId);
      } catch {
        state.failed.push(memberId);
      }
    };
    // Retry members that failed on a previous run, then continue at the cursor.
    for (const memberId of state.failed.splice(0)) await grant(memberId);
    await persist();
    while (state.done < op.memberIds.length) {
      const page = op.memberIds.slice(state.done, state.done + pageSize);
      for (const memberId of page) await grant(memberId);
      state.done += page.length;
      await persist();
    }
    if (state.failed.length > 0) {
      throw new Error(`${state.failed.length} member(s) could not be updated.`);
    }
    return roleId;
  }

  private auditOp(
    actor: WebSessionContext,
    plan: AdoptionPlan,
    snapshotId: string,
    op: PlanOperation,
    result: "success" | "failure",
    errorMessage?: string,
  ): Promise<void> {
    return this.deps.audit(actor, {
      action: `adoption.${op.type}`,
      targetId: op.targetId,
      details: {
        planId: plan.id,
        snapshotId,
        opId: op.id,
        summary: op.summary,
        ...(op.type === "member.role.add"
          ? { memberCount: op.memberCount, sample: op.sample }
          : {}),
        ...("approval" in op && op.approval ? { approval: op.approval } : {}),
      },
      result,
      errorMessage: errorMessage ?? null,
    });
  }

  // ---- rollback ---------------------------------------------------------

  /**
   * Restore the prior state recorded in a snapshot. Only operations that were
   * applied are reverted, in reverse order. Roles the plan created are left
   * alone unless `deleteCreatedRoles` is set.
   */
  public async rollback(
    snapshotId: string,
    options: RollbackOptions,
  ): Promise<RollbackResult> {
    const { store, gateway, callApi, config } = this.deps;
    const snapshot = await store.get(snapshotId);
    if (!snapshot) throw new AdoptionPlanError("Snapshot not found.");
    if (snapshot.status === "rolled_back")
      throw new AdoptionPlanError("Snapshot was already rolled back.");

    const { plan, baseline } = snapshot;
    const applied = new Set(
      snapshot.operations
        .filter((r) => r.status === "applied")
        .map((r) => r.opId),
    );
    const restored: string[] = [];
    const failed: Array<{ opId: string; error: string }> = [];
    const notes: string[] = [];
    const mapId = (id: string): string =>
      snapshot.restoredChannels.find((c) => c.oldId === id)?.newId ?? id;
    const roleRestored = new Map<string, string>();
    const mapRole = (id: string): string =>
      roleRestored.get(id) ??
      snapshot.createdRoles.find((r) => r.ref === id)?.roleId ??
      id;

    for (const op of [...plan.operations].reverse()) {
      if (!applied.has(op.id)) continue;
      try {
        switch (op.type) {
          case "role.create": {
            const created = snapshot.createdRoles.find((r) => r.ref === op.ref);
            if (created && options.deleteCreatedRoles) {
              await callApi(
                () => gateway.deleteRole(created.roleId),
                `delete created role ${created.roleId}`,
              );
            }
            break;
          }
          case "role.edit": {
            const prior = baseline.roles.find((r) => r.id === op.roleId);
            if (prior) {
              const back: Partial<RoleState> = {};
              for (const key of Object.keys(op.changes) as Array<
                keyof RoleState
              >) {
                (back as Record<string, unknown>)[key] = prior[key];
              }
              await callApi(
                () => gateway.editRole(mapRole(op.roleId), back),
                `restore role ${op.roleId}`,
              );
            }
            break;
          }
          case "overwrite.set": {
            const prior = baseline.channels
              .find((c) => c.id === op.channelId)
              ?.overwrites.find((o) => o.id === op.overwriteTargetId);
            const channelId = mapId(op.channelId);
            if (prior) {
              await callApi(
                () => gateway.setOverwrite(channelId, prior),
                `restore overwrite on ${channelId}`,
              );
            } else {
              await callApi(
                () =>
                  gateway.removeOverwrite(
                    channelId,
                    mapRole(op.overwriteTargetId),
                  ),
                `remove added overwrite on ${channelId}`,
              );
            }
            break;
          }
          case "overwrite.remove": {
            const prior = baseline.channels
              .find((c) => c.id === op.channelId)
              ?.overwrites.find((o) => o.id === op.overwriteTargetId);
            if (prior) {
              const channelId = mapId(op.channelId);
              await callApi(
                () => gateway.setOverwrite(channelId, prior),
                `restore overwrite on ${channelId}`,
              );
            }
            break;
          }
          case "channel.delete": {
            const prior = baseline.channels.find((c) => c.id === op.channelId);
            if (prior) {
              const parent = prior.parentId ? mapId(prior.parentId) : null;
              const newId = await callApi(
                () => gateway.recreateChannel({ ...prior, parentId: parent }),
                `recreate channel ${prior.name}`,
              );
              snapshot.restoredChannels.push({ oldId: prior.id, newId });
              notes.push(DESTRUCTIVE_RESTORE_NOTE);
            }
            break;
          }
          case "role.delete": {
            const prior = baseline.roles.find((r) => r.id === op.roleId);
            if (prior) {
              const newId = await callApi(
                () =>
                  gateway.createRole({
                    name: prior.name,
                    color: prior.color,
                    permissions: prior.permissions,
                    position: prior.position,
                  }),
                `recreate role ${prior.name}`,
              );
              roleRestored.set(prior.id, newId);
              notes.push(DESTRUCTIVE_RESTORE_NOTE);
            }
            break;
          }
          case "member.role.add": {
            const granted = snapshot.memberProgress[op.id]?.granted ?? [];
            const roleId = mapRole(op.roleId);
            for (const memberId of granted) {
              await callApi(
                () => gateway.removeMemberRole(memberId, roleId),
                `revoke role from ${memberId}`,
              );
            }
            break;
          }
          case "config.set": {
            const prior = baseline.config[op.key];
            const value =
              prior ??
              (defaultConfig as unknown as Record<string, ConfigValue>)[op.key];
            if (value !== undefined) await config.set(op.key, value);
            break;
          }
        }
        restored.push(op.id);
        await this.deps.audit(options.actor, {
          action: `adoption.rollback.${op.type}`,
          targetId: op.targetId,
          details: { planId: plan.id, snapshotId, opId: op.id },
          result: "success",
        });
      } catch (error) {
        const message = getErrorMessage(error);
        failed.push({ opId: op.id, error: message });
        await this.deps.audit(options.actor, {
          action: `adoption.rollback.${op.type}`,
          targetId: op.targetId,
          details: { planId: plan.id, snapshotId, opId: op.id },
          result: "failure",
          errorMessage: message,
        });
      }
    }

    if (failed.length === 0) {
      await store.update(snapshotId, {
        status: "rolled_back",
        rolledBackBy: options.actor.discordUserId,
        restoredChannels: snapshot.restoredChannels,
      });
    } else {
      await store.update(snapshotId, {
        restoredChannels: snapshot.restoredChannels,
      });
    }
    try {
      await this.deps.config.reload();
    } catch (error) {
      logger.error("Config reload after adoption rollback failed:", error);
    }
    return { snapshotId, restored, failed, notes: [...new Set(notes)] };
  }
}

// ---- default dependencies ---------------------------------------------------

class ConfigServiceWriter implements AdoptionConfigWriter {
  public async set(key: string, value: ConfigValue): Promise<void> {
    const meta = (
      settingsMetadata as Record<
        string,
        { description: string; category: string }
      >
    )[key];
    await ConfigService.getInstance().set(
      key,
      value,
      meta?.description ?? "",
      meta?.category ?? key.split(".")[0],
      { skipDependencyCheck: true },
    );
  }
  public reload(): Promise<void> {
    return ConfigService.getInstance().triggerReload();
  }
}

export class MongoAdoptionStore implements AdoptionStore {
  public async create(
    record: Omit<AdoptionSnapshotRecord, "id" | "rolledBackBy">,
  ): Promise<AdoptionSnapshotRecord> {
    const doc = await AdoptionSnapshot.create(
      record as unknown as Record<string, unknown>,
    );
    return { ...record, id: String(doc._id), rolledBackBy: null };
  }
  public async get(id: string): Promise<AdoptionSnapshotRecord | null> {
    const doc = await AdoptionSnapshot.findById(id).lean();
    if (!doc) return null;
    return {
      id: String(doc._id),
      planId: doc.planId,
      guildId: doc.guildId,
      appliedBy: doc.appliedBy,
      status: doc.status,
      plan: doc.plan as unknown as AdoptionPlan,
      baseline: doc.baseline as unknown as AdoptionPlan["baseline"],
      operations: doc.operations ?? [],
      createdRoles: doc.createdRoles ?? [],
      restoredChannels: doc.restoredChannels ?? [],
      memberProgress: doc.memberProgress ?? {},
      rolledBackBy: doc.rolledBackBy ?? null,
    };
  }
  public async update(
    id: string,
    patch: Partial<Omit<AdoptionSnapshotRecord, "id">>,
  ): Promise<void> {
    const set: Record<string, unknown> = { ...patch };
    if (patch.status === "rolled_back") set.rolledBackAt = new Date();
    await AdoptionSnapshot.updateOne({ _id: id }, { $set: set });
  }
}

const CHANNEL_TYPE: Record<ChannelState["kind"], ChannelType | null> = {
  category: ChannelType.GuildCategory,
  text: ChannelType.GuildText,
  voice: ChannelType.GuildVoice,
  other: null,
};

/** discord.js implementation of the gateway. */
export class DiscordAdoptionGateway implements AdoptionGateway {
  public constructor(private readonly guild: Guild) {}

  public async createRole(input: {
    name: string;
    color: number;
    permissions: string;
    position: number | null;
  }): Promise<string> {
    const role = await this.guild.roles.create({
      name: input.name,
      color: input.color,
      permissions: BigInt(input.permissions),
      ...(input.position !== null ? { position: input.position } : {}),
      reason: "KoolBot server adoption",
    });
    return role.id;
  }
  public async editRole(
    roleId: string,
    changes: Partial<RoleState>,
  ): Promise<void> {
    await this.guild.roles.edit(roleId, {
      ...(changes.name !== undefined ? { name: changes.name } : {}),
      ...(changes.color !== undefined ? { color: changes.color } : {}),
      ...(changes.permissions !== undefined
        ? { permissions: BigInt(changes.permissions) }
        : {}),
      ...(changes.position !== undefined ? { position: changes.position } : {}),
      reason: "KoolBot server adoption",
    });
  }
  public async deleteRole(roleId: string): Promise<void> {
    await this.guild.roles.delete(roleId, "KoolBot server adoption");
  }
  private async channel(
    channelId: string,
  ): Promise<
    GuildBasedChannel & { permissionOverwrites: PermissionOverwriteManager }
  > {
    const channel = await this.guild.channels.fetch(channelId);
    if (!channel || !("permissionOverwrites" in channel)) {
      throw new Error(`Channel ${channelId} not found.`);
    }
    return channel;
  }
  public async setOverwrite(
    channelId: string,
    o: OverwriteState,
  ): Promise<void> {
    const channel = await this.channel(channelId);
    await channel.permissionOverwrites.set(
      [
        ...channel.permissionOverwrites.cache
          .filter((existing) => existing.id !== o.id)
          .map((existing) => ({
            id: existing.id,
            type: existing.type,
            allow: existing.allow.bitfield,
            deny: existing.deny.bitfield,
          })),
        {
          id: o.id,
          type: (o.type === "role" ? 0 : 1) as OverwriteType,
          allow: BigInt(o.allow),
          deny: BigInt(o.deny),
        },
      ],
      "KoolBot server adoption",
    );
  }
  public async removeOverwrite(
    channelId: string,
    targetId: string,
  ): Promise<void> {
    const channel = await this.channel(channelId);
    await channel.permissionOverwrites.delete(
      targetId,
      "KoolBot server adoption",
    );
  }
  public async deleteChannel(channelId: string): Promise<void> {
    const channel = await this.guild.channels.fetch(channelId);
    if (channel) await channel.delete("KoolBot server adoption");
  }
  public async recreateChannel(channel: ChannelState): Promise<string> {
    const type = channel.rawType ?? CHANNEL_TYPE[channel.kind];
    if (type === null || type === undefined) {
      throw new Error(
        `Cannot recreate channel "${channel.name}" of unknown type.`,
      );
    }
    const created = await this.guild.channels.create({
      name: channel.name,
      type,
      parent: channel.parentId,
      topic: channel.topic ?? undefined,
      position: channel.position,
      permissionOverwrites: channel.overwrites.map((o) => ({
        id: o.id,
        type: (o.type === "role" ? 0 : 1) as OverwriteType,
        allow: BigInt(o.allow),
        deny: BigInt(o.deny),
      })),
      reason: "KoolBot server adoption rollback",
    } as GuildChannelCreateOptions);
    return created.id;
  }
  public async addMemberRole(memberId: string, roleId: string): Promise<void> {
    const member = await this.guild.members.fetch(memberId);
    await member.roles.add(roleId, "KoolBot server adoption");
  }
  public async removeMemberRole(
    memberId: string,
    roleId: string,
  ): Promise<void> {
    const member = await this.guild.members.fetch(memberId);
    await member.roles.remove(roleId, "KoolBot server adoption");
  }
}
