import { randomUUID } from "node:crypto";
import {
  ChannelType,
  type Client,
  type Guild,
  type GuildBasedChannel,
  type GuildChannelCreateOptions,
  type PermissionOverwriteManager,
  type OverwriteType,
  DiscordAPIError,
  RESTJSONErrorCodes,
  SnowflakeUtil,
  Routes,
} from "discord.js";
import logger from "../utils/logger.js";
import { getErrorMessage } from "../utils/error-guards.js";
import {
  AdoptionSnapshot,
  ADOPTION_STALE_AFTER_MS,
  type AdoptionOperationStatus,
  type AdoptionSnapshotStatus,
  type IAdoptionOperationRecord,
  type IRestoreIntent,
} from "../models/adoption-snapshot.js";
import {
  recordAudit,
  recordAuditOrThrow,
  type AuditEntry,
} from "../web/audit.js";
import type { WebSessionContext } from "../web/session.js";
import { ConfigService } from "./config-service.js";
import { Config } from "../models/config.js";
import { settingsMetadata } from "./config-schema.js";
import {
  computePlanId,
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
  /** Resolves true only when the role was actually added. */
  addMemberRole(memberId: string, roleId: string): Promise<boolean>;
  removeMemberRole(memberId: string, roleId: string): Promise<void>;
  /** Live state, read just before the first write. Null when gone. */
  readRole(roleId: string): Promise<RoleState | null>;
  /** Move a channel under a (possibly recreated) category. */
  setChannelParent(channelId: string, parentId: string): Promise<void>;
  memberHasRole(memberId: string, roleId: string): Promise<boolean>;
  /** Used to reconcile a channel recreation that was never recorded. */
  findChannel(
    name: string,
    parentId: string | null,
    rawType: number | null,
    createdAfter: Date,
  ): Promise<string | null>;
  /** Used to reconcile a role.create whose result was never recorded. */
  findRoleByName(name: string, createdAfter: Date): Promise<string | null>;
  readChannel(channelId: string): Promise<ChannelState | null>;
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
  restoredRoles: Array<{ oldId: string; newId: string }>;
  restoreIntents: IRestoreIntent[];
  /** Operations whose rollback already succeeded, so a retry skips them. */
  rolledBackOps: string[];
  memberProgress: Record<
    string,
    {
      done: number;
      failed: string[];
      granted: string[];
      inflight?: string[];
    }
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
  /** Release the lock of dead (heartbeat-less) active snapshots on a server. */
  recoverStale(guildId: string, staleAfterMs: number): Promise<number>;
  /** Atomically move a snapshot between statuses; false if it was not in `from`. */
  claim(
    id: string,
    from: AdoptionSnapshotStatus[],
    to: AdoptionSnapshotStatus,
  ): Promise<boolean>;
}

export interface AdoptionConfigWriter {
  set(key: string, value: ConfigValue): Promise<void>;
  /** Remove a stored override, restoring "never set". */
  delete(key: string): Promise<void>;
  /** Dependency problems the whole batch would cause (empty = fine). */
  validate(batch: Record<string, ConfigValue>): Promise<string[]>;
  /** The stored value, or null when none is stored. */
  read(key: string): Promise<ConfigValue | null>;
  reload(): Promise<void>;
}

export interface AdoptionDeps {
  gateway: AdoptionGateway;
  store: AdoptionStore;
  config: AdoptionConfigWriter;
  /** Wraps a Discord REST call (timeout + backoff); default: CommandManager. */
  callApi: <T>(call: () => Promise<T>, name: string) => Promise<T>;
  audit: (session: WebSessionContext, entry: AuditEntry) => Promise<void>;
  /** Like `audit` but throws if the row cannot be stored. */
  auditStrict: (session: WebSessionContext, entry: AuditEntry) => Promise<void>;
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
  /**
   * Extra live-state safety check run before a resume claims its snapshot.
   * Receives the operations that are still pending; return reasons to refuse.
   * The scanner that knows feature bindings supplies this.
   */
  revalidate?: (pending: PlanOperation[]) => Promise<string[]>;
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
  /**
   * Live-state check run before the snapshot is claimed. Return reasons to
   * refuse (e.g. the admin or bot would be locked out by the restore).
   */
  revalidate?: () => Promise<string[]>;
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
  "Deleted channels and roles are recreated from their saved structure only. Messages, pins, threads, webhooks, role memberships and the original IDs can't be restored.";

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

export interface RollbackJob {
  id: string;
  status: "running" | "done" | "failed";
  result: RollbackResult | null;
  error: string | null;
}

const REVOKE_PAGE_SIZE = 50;

/** Operations whose Discord write is recorded as intended before it happens. */
const WRITE_INTENT_OPS = new Set<PlanOperation["type"]>([
  "role.create",
  "channel.delete",
  "role.delete",
]);

export class ServerAdoptionService {
  private static instance: ServerAdoptionService | undefined;
  private readonly jobs = new Map<string, AdoptionJob>();
  private readonly rollbackJobs = new Map<string, RollbackJob>();

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
        auditStrict: recordAuditOrThrow,
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

  /** Rollback of a big grant is as long as the apply; it runs as a job too. */
  public startRollback(
    snapshotId: string,
    options: RollbackOptions,
  ): RollbackJob {
    const job: RollbackJob = {
      id: randomUUID(),
      status: "running",
      result: null,
      error: null,
    };
    this.rollbackJobs.set(job.id, job);
    void this.rollback(snapshotId, options)
      .then((result) => {
        job.result = result;
        job.status = "done";
      })
      .catch((error) => {
        job.error = getErrorMessage(error);
        job.status = "failed";
        logger.error("Server adoption rollback failed:", error);
      });
    return job;
  }

  public getRollbackJob(id: string): RollbackJob | undefined {
    return this.rollbackJobs.get(id);
  }

  public async apply(
    plan: AdoptionPlan,
    options: ApplyOptions,
  ): Promise<ApplyResult> {
    this.assertApplicable(plan, options);
    if (plan.guildId !== options.actor.guildId) {
      throw new AdoptionPlanError("Plan belongs to a different server.");
    }
    if (plan.plannedBy !== options.actor.discordUserId) {
      throw new AdoptionPlanError(
        "Only the admin the plan was made for can apply it. Plan again as yourself.",
      );
    }
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
      if (existing.guildId !== options.actor.guildId)
        throw new AdoptionPlanError("Snapshot belongs to a different server.");
      await store.recoverStale(plan.guildId, ADOPTION_STALE_AFTER_MS);
      await this.assertResumeSafe(plan, existing, options);
      // Claim atomically so a rollback or a second resume cannot race us.
      if (!(await store.claim(existing.id, ["partial"], "applying"))) {
        throw new AdoptionPlanError(
          `Snapshot is ${existing.status} and cannot be resumed.`,
        );
      }
      snapshot = existing;
    } else {
      await store.recoverStale(plan.guildId, ADOPTION_STALE_AFTER_MS);
      await this.assertBaselineCurrent(plan);
      if (options.revalidate) {
        const problems = await options.revalidate(plan.operations);
        if (problems.length > 0) {
          throw new AdoptionPlanError(
            `Live check failed: ${problems.join("; ")}. Plan again.`,
          );
        }
      }
      const configBatch = Object.fromEntries(
        plan.operations.flatMap((op) =>
          op.type === "config.set" ? [[op.key, op.value] as const] : [],
        ),
      );
      if (Object.keys(configBatch).length > 0) {
        const issues = await this.deps.config.validate(configBatch);
        if (issues.length > 0) {
          throw new AdoptionPlanError(
            `Config changes break feature dependencies: ${issues.join("; ")}`,
          );
        }
      }
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
        restoredRoles: [],
        restoreIntents: [],
        rolledBackOps: [],
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
    let destructiveChecked = false;

    const persist = (): Promise<void> =>
      store.update(snapshot.id, {
        operations: [...records.values()],
        createdRoles: snapshot.createdRoles,
        memberProgress: snapshot.memberProgress,
      });

    const ops = plan.operations;
    try {
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
            if (
              isDestructive(op) &&
              options.revalidate &&
              !destructiveChecked
            ) {
              // Members were added and config written since the preview; check
              // the live guild again before anything is deleted.
              const problems = await options.revalidate(
                plan.operations.filter(
                  (o) =>
                    isDestructive(o) && records.get(o.id)?.status !== "applied",
                ),
              );
              if (problems.length > 0) {
                throw new Error(`Live check failed: ${problems.join("; ")}`);
              }
              destructiveChecked = true;
            }
            const started = !!record.startedAt;
            if (isDestructive(op)) {
              // A destructive write needs a stored trace first; if the audit
              // row cannot be written the step does not run.
              await this.deps.auditStrict(options.actor, {
                action: `adoption.${op.type}.intent`,
                targetId: op.targetId,
                details: {
                  planId: plan.id,
                  snapshotId: snapshot.id,
                  opId: op.id,
                },
                result: "success",
              });
            }
            if (WRITE_INTENT_OPS.has(op.type) && !started) {
              // Durable intent, written before the non-idempotent write.
              record.startedAt = new Date();
              await persist();
            }
            record.resultId = await this.execute(
              op,
              snapshot,
              options,
              persist,
              started,
              record.startedAt,
            );
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
            if (op.type === "config.set") {
              // Config writes skip per-key dependency checks, so a half-applied
              // batch could leave an invalid prefix. Put the prefix back.
              await this.revertConfigPrefix(plan, records);
            }
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
    } catch (error) {
      // Never leave a snapshot stuck in "applying" after an unexpected error.
      await store.update(snapshot.id, { status: "partial" });
      throw error;
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

  /**
   * Optimistic lock: the plan's baseline is the scan it was built from, and
   * another admin may have changed a touched role or channel since. Re-read
   * each one just before the first write and refuse (re-plan) on any drift,
   * so the snapshot is the true pre-apply state.
   */
  private async assertBaselineCurrent(plan: AdoptionPlan): Promise<void> {
    const { gateway, callApi } = this.deps;
    const drifted: string[] = [];
    for (const role of plan.baseline.roles) {
      const live = await callApi(
        () => gateway.readRole(role.id),
        `read role ${role.id}`,
      );
      if (
        !live ||
        live.name !== role.name ||
        live.color !== role.color ||
        live.position !== role.position ||
        BigInt(live.permissions) !== BigInt(role.permissions)
      ) {
        drifted.push(`role "${role.name}"`);
      }
    }
    for (const [key, expected] of Object.entries(plan.baseline.config)) {
      const live = await this.deps.config.read(key);
      if (
        (live === null ? null : String(live)) !==
        (expected === null ? null : String(expected))
      ) {
        drifted.push(`setting ${key}`);
      }
    }
    const overwriteKey = (o: OverwriteState): string =>
      `${o.type}:${o.id}:${BigInt(o.allow)}:${BigInt(o.deny)}`;
    for (const channel of plan.baseline.channels) {
      const live = await callApi(
        () => gateway.readChannel(channel.id),
        `read channel ${channel.id}`,
      );
      // Position is left out on purpose: it shifts whenever any other channel
      // moves, which would flag nearly every plan.
      const same =
        !!live &&
        live.name === channel.name &&
        live.parentId === channel.parentId &&
        live.kind === channel.kind &&
        (live.topic ?? null) === (channel.topic ?? null) &&
        (channel.rawType === undefined || live.rawType === channel.rawType) &&
        live.overwrites.map(overwriteKey).sort().join("|") ===
          channel.overwrites.map(overwriteKey).sort().join("|");
      if (!same) drifted.push(`channel "${channel.name}"`);
    }
    if (drifted.length > 0) {
      throw new AdoptionPlanError(
        `Changed since the plan was made (${drifted.join(", ")}). Review and plan again.`,
      );
    }
  }

  private async revertConfigPrefix(
    plan: AdoptionPlan,
    records: Map<string, IAdoptionOperationRecord>,
  ): Promise<void> {
    for (const op of [...plan.operations].reverse()) {
      const record = records.get(op.id);
      if (op.type !== "config.set" || record?.status !== "applied") continue;
      try {
        const prior = plan.baseline.config[op.key];
        if (prior === null || prior === undefined) {
          await this.deps.config.delete(op.key);
        } else {
          await this.deps.config.set(op.key, prior);
        }
        record.status = "pending";
        record.error = "Reverted: a later config change failed.";
      } catch (error) {
        logger.error(`Could not revert config ${op.key}:`, error);
      }
    }
  }

  /**
   * Things can change between a partial apply and its resume (a role turns
   * managed, a channel fills up). Re-check what is still pending against the
   * live guild before touching anything.
   */
  private async assertResumeSafe(
    plan: AdoptionPlan,
    existing: AdoptionSnapshotRecord,
    options: ApplyOptions,
  ): Promise<void> {
    const { gateway, callApi } = this.deps;
    const done = new Set(
      existing.operations
        .filter((r) => r.status === "applied")
        .map((r) => r.opId),
    );
    const pending = plan.operations.filter((op) => !done.has(op.id));
    const problems: string[] = [];
    for (const op of pending) {
      if (
        op.type !== "role.edit" &&
        op.type !== "role.delete" &&
        !(op.type === "member.role.add" && !op.roleId.startsWith("new:"))
      ) {
        continue;
      }
      const live = await callApi(
        () => gateway.readRole(op.roleId),
        `read role ${op.roleId}`,
      );
      if (live?.managed) problems.push(`role "${live.name}" is now managed`);
      if (op.type === "member.role.add") {
        // The role about to be granted must still be what was planned.
        const planned = plan.baseline.roles.find((r) => r.id === op.roleId);
        if (!live) {
          problems.push(`role ${op.roleId} no longer exists`);
        } else if (
          planned &&
          (BigInt(live.permissions) !== BigInt(planned.permissions) ||
            live.position !== planned.position)
        ) {
          problems.push(`role "${live.name}" changed since it was planned`);
        }
      }
      if (!live && op.type === "role.edit") {
        problems.push(`role ${op.roleId} no longer exists`);
      }
    }
    if (options.revalidate)
      problems.push(...(await options.revalidate(pending)));
    if (problems.length > 0) {
      throw new AdoptionPlanError(
        `Cannot resume: ${problems.join("; ")}. Plan again.`,
      );
    }
  }

  private assertApplicable(plan: AdoptionPlan, options?: ApplyOptions): void {
    if (!isApplicable(plan)) {
      throw new AdoptionPlanError(
        `Plan has ${plan.errors.length} blocking error(s) and cannot be applied.`,
      );
    }
    // The id is a content hash. A plan edited after planning no longer
    // matches it, so blockers cannot be cleared nor operations added by hand.
    if (computePlanId(plan) !== plan.id) {
      throw new AdoptionPlanError(
        "The plan does not match its id and was changed after planning.",
      );
    }
    // Destructive steps are only as safe as the live state they run against,
    // so the caller must supply a fresh scan check for them.
    if (
      options &&
      !options.revalidate &&
      plan.operations.some((op) => isDestructive(op))
    ) {
      throw new AdoptionPlanError(
        "Plans with destructive steps need a live-state check (revalidate) from a fresh scan.",
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
    started: boolean,
    startedAt?: Date | null,
  ): Promise<string | null> {
    const { gateway, callApi, config } = this.deps;
    switch (op.type) {
      case "role.create": {
        // A previous run that began this create but never recorded its result
        // may have created the role; adopt it instead of making a duplicate.
        const earlier = started
          ? await callApi(
              () =>
                gateway.findRoleByName(
                  op.name,
                  startedAt ? new Date(startedAt) : new Date(0),
                ),
              `look up role ${op.name}`,
            )
          : null;
        const roleId =
          earlier ??
          (await callApi(
            () =>
              gateway.createRole({
                name: op.name,
                color: op.color,
                permissions: op.permissions,
                position: op.position,
              }),
            `create role ${op.name}`,
          ));
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
      case "channel.delete": {
        const live = await callApi(
          () => gateway.readChannel(op.channelId),
          `read channel ${op.channelId}`,
        );
        if (!live) {
          // Gone. If an earlier attempt of ours began this delete it probably
          // went through; otherwise someone else changed the server.
          if (started) return op.channelId;
          throw new Error("Channel no longer exists (changed since planned).");
        }
        if (live.voiceMemberCount > 0) {
          throw new Error("Channel has members connected; not deleting it.");
        }
        await callApi(
          () => gateway.deleteChannel(op.channelId),
          `delete channel ${op.channelId}`,
        );
        return op.channelId;
      }
      case "role.delete": {
        const live = await callApi(
          () => gateway.readRole(op.roleId),
          `read role ${op.roleId}`,
        );
        if (!live) {
          if (started) return op.roleId;
          throw new Error("Role no longer exists (changed since planned).");
        }
        await callApi(
          () => gateway.deleteRole(op.roleId),
          `delete role ${op.roleId}`,
        );
        return op.roleId;
      }
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
    // Members whose page was in flight when a previous run died: they may
    // already hold the role because of us, so a no-op add still counts.
    const maybeOurs = new Set(state.inflight ?? []);
    const grant = async (memberId: string): Promise<void> => {
      try {
        const changed = await callApi(
          () => gateway.addMemberRole(memberId, roleId),
          `grant role to ${memberId}`,
        );
        // Only record grants that actually changed something, so a rollback
        // never removes a role the member already held.
        if (
          (changed || maybeOurs.has(memberId)) &&
          !state.granted.includes(memberId)
        ) {
          state.granted.push(memberId);
        }
      } catch {
        state.failed.push(memberId);
      }
    };
    // Retry members that failed on a previous run, then continue at the cursor.
    for (const memberId of state.failed.splice(0)) await grant(memberId);
    await persist();
    while (state.done < op.memberIds.length) {
      const page = op.memberIds.slice(state.done, state.done + pageSize);
      // Intent is recorded only for members confirmed not to hold the role
      // yet; a crash then leaves exactly the members we may have granted.
      const toGrant: string[] = [];
      for (const memberId of page) {
        const holds = await callApi(
          () => gateway.memberHasRole(memberId, roleId),
          `check role on ${memberId}`,
        ).catch(() => false);
        if (!holds) toGrant.push(memberId);
        else if (maybeOurs.has(memberId) && !state.granted.includes(memberId)) {
          // Granted by the run that died before it could record the grant.
          state.granted.push(memberId);
        }
      }
      state.inflight = toGrant;
      await persist();
      for (const memberId of toGrant) await grant(memberId);
      state.done += page.length;
      // A grant that failed (say, timed out) may still have reached Discord;
      // keep those members as "maybe ours" until a retry reconciles them.
      state.inflight = [...state.failed];
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
    if (snapshot.guildId !== options.actor.guildId)
      throw new AdoptionPlanError("Snapshot belongs to a different server.");
    await store.recoverStale(snapshot.guildId, ADOPTION_STALE_AFTER_MS);
    if (options.revalidate) {
      const problems = await options.revalidate();
      if (problems.length > 0) {
        throw new AdoptionPlanError(
          `Cannot roll back: ${problems.join("; ")}.`,
        );
      }
    }
    const priorStatus =
      (await store.get(snapshotId))?.status ?? snapshot.status;
    if (
      !(await store.claim(snapshotId, ["applied", "partial"], "rolling_back"))
    ) {
      throw new AdoptionPlanError(
        "Snapshot is still being applied or rolled back; wait for it to finish before rolling back.",
      );
    }

    const { plan, baseline } = snapshot;
    // A member operation that failed part-way still has persisted grants
    // that must be revoked, so it counts as reversible too.
    const applied = new Set(
      snapshot.operations
        .filter(
          (r) =>
            r.status === "applied" ||
            (snapshot.memberProgress[r.opId]?.granted.length ?? 0) > 0,
        )
        .map((r) => r.opId),
    );
    const done = new Set(snapshot.rolledBackOps);
    const restored: string[] = [];
    const failed: Array<{ opId: string; error: string }> = [];
    const notes: string[] = [];
    const mapId = (id: string): string =>
      snapshot.restoredChannels.find((c) => c.oldId === id)?.newId ?? id;
    const mapRole = (id: string): string =>
      snapshot.restoredRoles.find((r) => r.oldId === id)?.newId ??
      snapshot.createdRoles.find((r) => r.ref === id)?.roleId ??
      id;
    const remapOverwrite = (o: OverwriteState): OverwriteState => ({
      ...o,
      id: o.type === "role" ? mapRole(o.id) : o.id,
    });
    const priorOverwrite = (
      channelId: string,
      targetId: string,
    ): OverwriteState | undefined => {
      const found = baseline.channels
        .find((c) => c.id === channelId)
        ?.overwrites.find((o) => o.id === targetId);
      return found ? remapOverwrite(found) : undefined;
    };

    const revert = async (op: PlanOperation): Promise<void> => {
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
          const prior = priorOverwrite(op.channelId, op.overwriteTargetId);
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
          const prior = priorOverwrite(op.channelId, op.overwriteTargetId);
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
            const parentId = prior.parentId ? mapId(prior.parentId) : null;
            const earlier = snapshot.restoreIntents.find(
              (i) => i.kind === "channel" && i.oldId === prior.id,
            );
            // A previous attempt that began this recreation may have created
            // the channel before dying; adopt it rather than duplicate it.
            const found = earlier
              ? await callApi(
                  () =>
                    gateway.findChannel(
                      prior.name,
                      parentId,
                      prior.rawType ?? null,
                      new Date(earlier.startedAt),
                    ),
                  `look up channel ${prior.name}`,
                )
              : null;
            if (!earlier) {
              snapshot.restoreIntents.push({
                kind: "channel",
                oldId: prior.id,
                name: prior.name,
                startedAt: new Date().toISOString(),
                parentId,
                rawType: prior.rawType ?? null,
              });
              await persist();
            }
            const newId =
              found ??
              (await callApi(
                () =>
                  gateway.recreateChannel({
                    ...prior,
                    parentId,
                    overwrites: prior.overwrites.map(remapOverwrite),
                  }),
                `recreate channel ${prior.name}`,
              ));
            snapshot.restoredChannels.push({ oldId: prior.id, newId });
            notes.push(DESTRUCTIVE_RESTORE_NOTE);
          }
          break;
        }
        case "role.delete": {
          const prior = baseline.roles.find((r) => r.id === op.roleId);
          if (prior) {
            const earlier = snapshot.restoreIntents.find(
              (i) => i.kind === "role" && i.oldId === prior.id,
            );
            const found = earlier
              ? await callApi(
                  () =>
                    gateway.findRoleByName(
                      prior.name,
                      new Date(earlier.startedAt),
                    ),
                  `look up role ${prior.name}`,
                )
              : null;
            if (!earlier) {
              snapshot.restoreIntents.push({
                kind: "role",
                oldId: prior.id,
                name: prior.name,
                startedAt: new Date().toISOString(),
              });
              await persist();
            }
            const newId =
              found ??
              (await callApi(
                () =>
                  gateway.createRole({
                    name: prior.name,
                    color: prior.color,
                    permissions: prior.permissions,
                    position: prior.position,
                  }),
                `recreate role ${prior.name}`,
              ));
            snapshot.restoredRoles.push({ oldId: prior.id, newId });
            notes.push(DESTRUCTIVE_RESTORE_NOTE);
          }
          break;
        }
        case "member.role.add": {
          const state = snapshot.memberProgress[op.id];
          const roleId = mapRole(op.roleId);
          // Page through the grants, dropping each page once revoked and
          // persisting (which also refreshes the heartbeat), so thousands of
          // members neither block for long nor look dead, and a retry resumes.
          while (state && state.granted.length > 0) {
            const page = state.granted.slice(0, REVOKE_PAGE_SIZE);
            for (const memberId of page) {
              await callApi(
                () => gateway.removeMemberRole(memberId, roleId),
                `revoke role from ${memberId}`,
              );
            }
            state.granted.splice(0, page.length);
            await persist();
          }
          break;
        }
        case "config.set": {
          const prior = baseline.config[op.key];
          if (prior === null || prior === undefined) {
            await config.delete(op.key);
          } else {
            await config.set(op.key, prior);
          }
          break;
        }
      }
    };

    const persist = (): Promise<void> => {
      snapshot.rolledBackOps = [...done];
      return store.update(snapshotId, {
        rolledBackOps: snapshot.rolledBackOps,
        restoredChannels: snapshot.restoredChannels,
        restoredRoles: snapshot.restoredRoles,
        restoreIntents: snapshot.restoreIntents,
        memberProgress: snapshot.memberProgress,
      });
    };

    const run = async (op: PlanOperation): Promise<void> => {
      if (!applied.has(op.id) || done.has(op.id)) return;
      try {
        await revert(op);
        done.add(op.id);
        restored.push(op.id);
        await persist();
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
    };

    // Deleted roles come back first so overwrites that name them can be
    // rewritten to the new role ids; everything else unwinds in reverse.
    const reversed = [...plan.operations].reverse();
    const isCategoryDelete = (op: PlanOperation): boolean =>
      op.type === "channel.delete" &&
      baseline.channels.find((c) => c.id === op.channelId)?.kind === "category";
    for (const op of reversed) if (op.type === "role.delete") await run(op);
    // Categories before the channels that sit inside them.
    for (const op of reversed) if (isCategoryDelete(op)) await run(op);
    for (const op of reversed) {
      if (op.type !== "role.delete" && !isCategoryDelete(op)) await run(op);
    }

    // A deleted role took its overwrites on surviving channels with it.
    const deletedChannels = new Set(
      plan.operations.flatMap((o) =>
        o.type === "channel.delete" ? [o.channelId] : [],
      ),
    );
    for (const restoredRole of snapshot.restoredRoles) {
      for (const channel of baseline.channels) {
        if (deletedChannels.has(channel.id)) continue;
        const prior = channel.overwrites.find(
          (o) => o.id === restoredRole.oldId,
        );
        const key = `${channel.id}:${restoredRole.oldId}`;
        if (!prior || done.has(key)) continue;
        try {
          await callApi(
            () =>
              gateway.setOverwrite(channel.id, {
                ...prior,
                id: restoredRole.newId,
              }),
            `restore overwrite on ${channel.id}`,
          );
          done.add(key);
          await persist();
        } catch (error) {
          failed.push({ opId: key, error: getErrorMessage(error) });
        }
      }
    }

    // Deleting a category un-parents the children it did not delete; put them
    // back under the recreated category.
    for (const restoredChannel of snapshot.restoredChannels) {
      for (const child of baseline.channels) {
        if (child.parentId !== restoredChannel.oldId) continue;
        if (deletedChannels.has(child.id)) continue;
        const key = `parent:${child.id}`;
        if (done.has(key)) continue;
        try {
          await callApi(
            () => gateway.setChannelParent(child.id, restoredChannel.newId),
            `reparent channel ${child.id}`,
          );
          done.add(key);
          await persist();
        } catch (error) {
          failed.push({ opId: key, error: getErrorMessage(error) });
        }
      }
    }

    if (failed.length === 0) {
      await store.update(snapshotId, {
        status: "rolled_back",
        rolledBackBy: options.actor.discordUserId,
      });
    } else {
      // Back to its prior status so the rollback can be retried.
      await store.update(snapshotId, { status: priorStatus });
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
  public delete(key: string): Promise<void> {
    return ConfigService.getInstance().delete(key);
  }
  public async validate(batch: Record<string, ConfigValue>): Promise<string[]> {
    const issues =
      await ConfigService.getInstance().findDependencyIssues(batch);
    return issues.map((i) => i.message);
  }
  public async read(key: string): Promise<ConfigValue | null> {
    const row = await Config.findOne({ key }).lean();
    return row ? (row.value as ConfigValue) : null;
  }
  public reload(): Promise<void> {
    return ConfigService.getInstance().triggerReload();
  }
}

export const BUSY_MESSAGE =
  "Another apply or rollback is already running for this server.";

/** Statuses during which a snapshot holds the per-server lock. */
export const isActiveStatus = (status: AdoptionSnapshotStatus): boolean =>
  status === "applying" || status === "rolling_back";

export class MongoAdoptionStore implements AdoptionStore {
  public async create(
    record: Omit<AdoptionSnapshotRecord, "id" | "rolledBackBy">,
  ): Promise<AdoptionSnapshotRecord> {
    try {
      const doc = await AdoptionSnapshot.create({
        ...(record as unknown as Record<string, unknown>),
        active: isActiveStatus(record.status),
        heartbeatAt: new Date(),
      });
      return { ...record, id: String(doc._id), rolledBackBy: null };
    } catch (error) {
      if ((error as { code?: number }).code === 11000) {
        throw new AdoptionPlanError(BUSY_MESSAGE);
      }
      throw error;
    }
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
      restoredRoles: doc.restoredRoles ?? [],
      restoreIntents: doc.restoreIntents ?? [],
      rolledBackOps: doc.rolledBackOps ?? [],
      memberProgress: doc.memberProgress ?? {},
      rolledBackBy: doc.rolledBackBy ?? null,
    };
  }
  public async recoverStale(
    guildId: string,
    staleAfterMs: number,
  ): Promise<number> {
    const result = await AdoptionSnapshot.updateMany(
      {
        guildId,
        active: true,
        heartbeatAt: { $lt: new Date(Date.now() - staleAfterMs) },
      },
      { $set: { status: "partial", active: false } },
    );
    return result.modifiedCount ?? 0;
  }
  public async claim(
    id: string,
    from: AdoptionSnapshotStatus[],
    to: AdoptionSnapshotStatus,
  ): Promise<boolean> {
    try {
      const result = await AdoptionSnapshot.updateOne(
        { _id: id, status: { $in: from } },
        {
          $set: {
            status: to,
            active: isActiveStatus(to),
            heartbeatAt: new Date(),
          },
        },
      );
      return result.modifiedCount === 1;
    } catch (error) {
      // The unique "one active snapshot per server" index refused the claim.
      if ((error as { code?: number }).code === 11000) return false;
      throw error;
    }
  }
  public async update(
    id: string,
    patch: Partial<Omit<AdoptionSnapshotRecord, "id">>,
  ): Promise<void> {
    const set: Record<string, unknown> = { ...patch, heartbeatAt: new Date() };
    if (patch.status) set.active = isActiveStatus(patch.status);
    if (patch.status === "rolled_back") set.rolledBackAt = new Date();
    await AdoptionSnapshot.updateOne({ _id: id }, { $set: set });
  }
}

/** Swallow only Discord's "Unknown X" answer; every other error must surface. */
const ignoreUnknown =
  (code: number) =>
  (error: unknown): null => {
    if (error instanceof DiscordAPIError && error.code === code) return null;
    throw error;
  };

/**
 * Snowflake ids carry their creation time, so a candidate that already existed
 * before our write began cannot be the thing that write created. A minute of
 * slack covers clock skew between this host and Discord.
 */
const createdSince = (id: string, after: Date): boolean =>
  SnowflakeUtil.timestampFrom(id) >= after.getTime() - 60_000;

/** Reconcile only on an unambiguous match; two candidates need a human. */
function uniqueOrNull(ids: string[], what: string): string | null {
  if (ids.length > 1) {
    throw new Error(
      `More than one ${what} could be the one a crashed run created; check the server and retry.`,
    );
  }
  return ids[0] ?? null;
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
  /** Single-target write, so unrelated overwrites are never touched. */
  public async setOverwrite(
    channelId: string,
    o: OverwriteState,
  ): Promise<void> {
    await this.guild.client.rest.put(
      Routes.channelPermission(channelId, o.id),
      {
        body: {
          type: o.type === "role" ? 0 : 1,
          allow: BigInt(o.allow).toString(),
          deny: BigInt(o.deny).toString(),
        },
        reason: "KoolBot server adoption",
      },
    );
  }
  public async readRole(roleId: string): Promise<RoleState | null> {
    const role = await this.guild.roles
      .fetch(roleId, { force: true })
      .catch(ignoreUnknown(RESTJSONErrorCodes.UnknownRole));
    if (!role) return null;
    return {
      id: role.id,
      name: role.name,
      color: role.color,
      permissions: role.permissions.bitfield.toString(),
      position: role.position,
      managed: role.managed,
    };
  }
  public async setChannelParent(
    channelId: string,
    parentId: string,
  ): Promise<void> {
    const channel = await this.guild.channels.fetch(channelId);
    if (channel && "setParent" in channel) {
      await channel.setParent(parentId, {
        reason: "KoolBot server adoption rollback",
      });
    }
  }
  public async memberHasRole(
    memberId: string,
    roleId: string,
  ): Promise<boolean> {
    const member = await this.guild.members
      .fetch(memberId)
      .catch(ignoreUnknown(RESTJSONErrorCodes.UnknownMember));
    return !!member && member.roles.cache.has(roleId);
  }
  public async findChannel(
    name: string,
    parentId: string | null,
    rawType: number | null,
    createdAfter: Date,
  ): Promise<string | null> {
    const channels = await this.guild.channels.fetch();
    const matches = channels.filter(
      (c) =>
        !!c &&
        c.name === name &&
        c.parentId === parentId &&
        (rawType === null || c.type === rawType) &&
        createdSince(c.id, createdAfter),
    );
    return uniqueOrNull(
      matches.map((c) => c!.id),
      `channel "${name}"`,
    );
  }
  public async findRoleByName(
    name: string,
    createdAfter: Date,
  ): Promise<string | null> {
    const roles = await this.guild.roles.fetch(undefined, { force: true });
    const matches = roles.filter(
      (r) => r.name === name && createdSince(r.id, createdAfter),
    );
    return uniqueOrNull(
      matches.map((r) => r.id),
      `role "${name}"`,
    );
  }
  public async readChannel(channelId: string): Promise<ChannelState | null> {
    const channel = await this.guild.channels
      .fetch(channelId, { force: true })
      .catch(ignoreUnknown(RESTJSONErrorCodes.UnknownChannel));
    if (!channel || !("permissionOverwrites" in channel)) return null;
    return {
      id: channel.id,
      name: channel.name,
      kind: channel.isVoiceBased()
        ? "voice"
        : channel.type === ChannelType.GuildCategory
          ? "category"
          : "text",
      rawType: channel.type,
      parentId: channel.parentId,
      position: channel.position,
      topic: "topic" in channel ? (channel.topic ?? null) : null,
      voiceMemberCount: channel.isVoiceBased() ? channel.members.size : 0,
      overwrites: channel.permissionOverwrites.cache.map((o) => ({
        id: o.id,
        type: o.type === 0 ? "role" : "member",
        allow: o.allow.bitfield.toString(),
        deny: o.deny.bitfield.toString(),
      })),
    };
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
  public async addMemberRole(
    memberId: string,
    roleId: string,
  ): Promise<boolean> {
    // A member who left after the scan has nothing to grant; do not let them
    // leave the whole bulk operation permanently partial.
    const member = await this.guild.members
      .fetch(memberId)
      .catch(ignoreUnknown(RESTJSONErrorCodes.UnknownMember));
    if (!member || member.roles.cache.has(roleId)) return false;
    await member.roles.add(roleId, "KoolBot server adoption");
    return true;
  }
  public async removeMemberRole(
    memberId: string,
    roleId: string,
  ): Promise<void> {
    // A member who left has nothing to revoke; do not let them block the rest.
    const member = await this.guild.members
      .fetch(memberId)
      .catch(ignoreUnknown(RESTJSONErrorCodes.UnknownMember));
    if (!member) return;
    await member.roles.remove(roleId, "KoolBot server adoption");
  }
}
