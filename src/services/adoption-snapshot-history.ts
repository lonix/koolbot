import mongoose from "mongoose";
import {
  AdoptionSnapshot,
  type AdoptionSnapshotStatus,
} from "../models/adoption-snapshot.js";
import {
  pendingDependentRepairs,
  remainingReversibleIds,
  type BaselineChannelRefs,
} from "./adoption-rollback-selection.js";

/**
 * Read-only listing of saved adoption snapshots for the Web UI history view
 * (#1025). The rollback itself lives in `ServerAdoptionService`; this only
 * reads. The queries are aggregations with an explicit projection, so member
 * ids (`memberIds` on a planned operation, `memberProgress` grants) and the
 * stored `baseline` never leave the database. Only counts, operation summaries
 * and the names of operations holding grants are returned.
 */

export interface SnapshotSummary {
  id: string;
  planId: string;
  appliedBy: string;
  status: AdoptionSnapshotStatus;
  createdAt: Date | null;
  rolledBackBy: string | null;
  rolledBackAt: Date | null;
  applied: number;
  failed: number;
  skipped: number;
  destructive: number;
  createdRoles: number;
}

export interface SnapshotOperationRow {
  summary: string;
  destructive: boolean;
}

export interface SnapshotDetail extends SnapshotSummary {
  /** The operations a rollback will revert from the saved record, in plan order. */
  operations: SnapshotOperationRow[];
  /**
   * Steps a restore may also revert after it re-checks live Discord state:
   * writes that were started but never recorded as finished, and member grants
   * that were in flight. Not decidable from the database alone.
   */
  interrupted: number;
  /** Still-reversible `role.create` steps: what "delete created roles" can reach. */
  revertibleCreatedRoles: number;
  /**
   * Interrupted `role.create` steps: if Discord did create the role the restore
   * promotes the step, and only then can the option delete it.
   */
  uncertainCreatedRoles: number;
  /** Follow-up repairs (overwrites on recreated roles, reparenting) still pending. */
  dependentRepairs: number;
}

export interface SnapshotPage {
  snapshots: SnapshotSummary[];
  page: number;
  hasMore: boolean;
}

/** Statuses a rollback may claim (see `AdoptionStore.claim` in the engine). */
export const ROLLBACKABLE_STATUSES: readonly AdoptionSnapshotStatus[] = [
  "applied",
  "partial",
  "rollback_partial",
];

export const canRollback = (status: AdoptionSnapshotStatus): boolean =>
  ROLLBACKABLE_STATUSES.includes(status);

export const HISTORY_PAGE_SIZE = 25;

interface RawOp {
  opId?: string;
  status?: string;
  startedAt?: Date | null;
}
interface RawPlanOp {
  id?: string;
  type?: string;
  channelId?: string | null;
  summary?: string;
  class?: string;
}
interface RawSnapshot {
  _id: unknown;
  planId?: string;
  appliedBy?: string;
  status: AdoptionSnapshotStatus;
  createdAt?: Date;
  rolledBackBy?: string | null;
  rolledBackAt?: Date | null;
  operations?: RawOp[];
  createdRoles?: number;
  planOps?: RawPlanOp[];
  /** Ids of operations that have persisted grants (never the member ids). */
  grantedOps?: string[];
  /** Ids of operations with in-flight member grants (never the member ids). */
  inflightOps?: string[];
  rolledBackOps?: string[];
  restoredRoles?: { oldId?: string }[];
  restoredChannels?: { oldId?: string }[];
  baselineChannels?: {
    id?: string;
    parentId?: string | null;
    roleOverwriteIds?: string[];
  }[];
}

function summarise(doc: RawSnapshot): SnapshotSummary {
  const ops = doc.operations ?? [];
  const planOps = doc.planOps ?? [];
  const count = (s: string): number => ops.filter((o) => o.status === s).length;
  return {
    id: String(doc._id),
    planId: doc.planId ?? "",
    appliedBy: doc.appliedBy ?? "",
    status: doc.status,
    createdAt: doc.createdAt ?? null,
    rolledBackBy: doc.rolledBackBy ?? null,
    rolledBackAt: doc.rolledBackAt ?? null,
    applied: count("applied"),
    failed: count("failed"),
    skipped: count("skipped"),
    destructive: planOps.filter((o) => o.class === "destructive").length,
    createdRoles: doc.createdRoles ?? 0,
  };
}

const orEmpty = (path: string): Record<string, unknown> => ({
  $ifNull: [path, []],
});

/** Names of operations whose `memberProgress.<field>` is non-empty. */
const opsWithMembers = (field: string): Record<string, unknown> => ({
  $map: {
    input: {
      $filter: {
        input: { $objectToArray: { $ifNull: ["$memberProgress", {}] } },
        as: "p",
        cond: { $gt: [{ $size: orEmpty(`$$p.v.${field}`) }, 0] },
      },
    },
    as: "p",
    in: "$$p.k",
  },
});

/**
 * Writes the engine's `reconcileForRollback` may promote to applied after a
 * live check when they were started but not recorded as finished. Keep in step
 * with that method.
 */
const RECONCILED_TYPES = new Set([
  "role.create",
  "role.delete",
  "channel.delete",
]);

/**
 * The projection is explicit so only what the page uses leaves the database:
 * three fields per planned operation (never `memberIds`), the status of each
 * operation, and the *names* of operations that hold persisted grants (never
 * the granted ids, and never `baseline`).
 */
export function snapshotPipeline(
  match: Record<string, unknown>,
  paging: Record<string, unknown>[] = [],
): Record<string, unknown>[] {
  return [
    { $match: match },
    { $sort: { createdAt: -1 } },
    ...paging,
    {
      $project: {
        planId: 1,
        appliedBy: 1,
        status: 1,
        createdAt: 1,
        rolledBackBy: 1,
        rolledBackAt: 1,
        rolledBackOps: orEmpty("$rolledBackOps"),
        createdRoles: { $size: orEmpty("$createdRoles") },
        operations: {
          $map: {
            input: orEmpty("$operations"),
            as: "o",
            in: {
              opId: "$$o.opId",
              status: "$$o.status",
              startedAt: "$$o.startedAt",
            },
          },
        },
        planOps: {
          $map: {
            input: orEmpty("$plan.operations"),
            as: "o",
            in: {
              id: "$$o.id",
              type: "$$o.type",
              channelId: "$$o.channelId",
              summary: "$$o.summary",
              class: "$$o.class",
            },
          },
        },
        // Ids only, no member overwrites: just enough to find the repairs a
        // rollback still owes for recreated roles and categories.
        restoredRoles: {
          $map: {
            input: orEmpty("$restoredRoles"),
            as: "r",
            in: { oldId: "$$r.oldId" },
          },
        },
        restoredChannels: {
          $map: {
            input: orEmpty("$restoredChannels"),
            as: "r",
            in: { oldId: "$$r.oldId" },
          },
        },
        baselineChannels: {
          $map: {
            input: orEmpty("$baseline.channels"),
            as: "c",
            in: {
              id: "$$c.id",
              parentId: "$$c.parentId",
              roleOverwriteIds: {
                $map: {
                  input: {
                    $filter: {
                      input: orEmpty("$$c.overwrites"),
                      as: "w",
                      cond: { $eq: ["$$w.type", "role"] },
                    },
                  },
                  as: "w",
                  in: "$$w.id",
                },
              },
            },
          },
        },
        grantedOps: opsWithMembers("granted"),
        inflightOps: opsWithMembers("inflight"),
      },
    },
  ];
}

/** One page, newest first. Every retained snapshot is reachable by paging. */
export async function listSnapshots(
  guildId: string,
  page = 1,
  pageSize: number = HISTORY_PAGE_SIZE,
): Promise<SnapshotPage> {
  const p = Math.max(1, Math.floor(page) || 1);
  const docs = (await AdoptionSnapshot.aggregate(
    snapshotPipeline({ guildId }, [
      { $skip: (p - 1) * pageSize },
      { $limit: pageSize + 1 },
    ]) as never,
  )) as unknown as RawSnapshot[];
  return {
    snapshots: docs.slice(0, pageSize).map(summarise),
    page: p,
    hasMore: docs.length > pageSize,
  };
}

/** One snapshot of this server, or null (unknown id, or another server's). */
export async function getSnapshotDetail(
  guildId: string,
  id: string,
): Promise<SnapshotDetail | null> {
  if (!/^[0-9a-f]{24}$/i.test(id)) return null;
  const docs = (await AdoptionSnapshot.aggregate(
    snapshotPipeline({
      _id: new mongoose.Types.ObjectId(id),
      guildId,
    }) as never,
  )) as unknown as RawSnapshot[];
  const doc = docs[0];
  if (!doc) return null;
  const granted = new Set(doc.grantedOps ?? []);
  const records = (doc.operations ?? []).map((o) => ({
    opId: o.opId ?? "",
    status: o.status ?? "pending",
  }));
  const rolledBack = new Set(doc.rolledBackOps ?? []);
  const remaining = new Set(
    remainingReversibleIds(
      records,
      (opId) => (granted.has(opId) ? 1 : 0),
      doc.rolledBackOps ?? [],
    ),
  );
  const typeOf = new Map((doc.planOps ?? []).map((o) => [o.id ?? "", o.type]));
  // Uncertain steps: not yet counted as reversible, but the restore may promote
  // them after checking Discord. The page says so instead of under-promising.
  const uncertain = new Set<string>();
  const uncertainRoleCreates = new Set<string>();
  for (const o of doc.operations ?? []) {
    const id = o.opId ?? "";
    if (remaining.has(id) || rolledBack.has(id) || o.status === "applied")
      continue;
    if (o.startedAt && RECONCILED_TYPES.has(typeOf.get(id) ?? "")) {
      uncertain.add(id);
      if (typeOf.get(id) === "role.create") uncertainRoleCreates.add(id);
    }
  }
  for (const id of doc.inflightOps ?? []) {
    if (!remaining.has(id) && !rolledBack.has(id)) uncertain.add(id);
  }
  return {
    ...summarise(doc),
    interrupted: uncertain.size,
    uncertainCreatedRoles: uncertainRoleCreates.size,
    dependentRepairs: pendingDependentRepairs({
      restoredRoleOldIds: (doc.restoredRoles ?? []).map((r) => r.oldId ?? ""),
      restoredChannelOldIds: (doc.restoredChannels ?? []).map(
        (r) => r.oldId ?? "",
      ),
      baselineChannels: (doc.baselineChannels ?? []).map(
        (c): BaselineChannelRefs => ({
          id: c.id ?? "",
          parentId: c.parentId ?? null,
          roleOverwriteIds: c.roleOverwriteIds ?? [],
        }),
      ),
      deletedChannelIds: (doc.planOps ?? []).flatMap((o) =>
        o.type === "channel.delete" && o.channelId ? [o.channelId] : [],
      ),
      rolledBackOps: doc.rolledBackOps ?? [],
    }).length,
    revertibleCreatedRoles: [...remaining].filter(
      (id) => typeOf.get(id) === "role.create",
    ).length,
    operations: (doc.planOps ?? [])
      .filter((o) => remaining.has(o.id ?? ""))
      .map((o) => ({
        summary: o.summary ?? o.id ?? "",
        destructive: o.class === "destructive",
      })),
  };
}
