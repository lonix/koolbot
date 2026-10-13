import mongoose from "mongoose";
import {
  AdoptionSnapshot,
  type AdoptionSnapshotStatus,
} from "../models/adoption-snapshot.js";
import { remainingReversibleIds } from "./adoption-rollback-selection.js";

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
  /** Exactly the operations a rollback would still revert, in plan order. */
  operations: SnapshotOperationRow[];
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
}
interface RawPlanOp {
  id?: string;
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
  rolledBackOps?: string[];
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
            in: { opId: "$$o.opId", status: "$$o.status" },
          },
        },
        planOps: {
          $map: {
            input: orEmpty("$plan.operations"),
            as: "o",
            in: { id: "$$o.id", summary: "$$o.summary", class: "$$o.class" },
          },
        },
        grantedOps: {
          $map: {
            input: {
              $filter: {
                input: { $objectToArray: { $ifNull: ["$memberProgress", {}] } },
                as: "p",
                cond: { $gt: [{ $size: orEmpty("$$p.v.granted") }, 0] },
              },
            },
            as: "p",
            in: "$$p.k",
          },
        },
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
  const remaining = new Set(
    remainingReversibleIds(
      (doc.operations ?? []).map((o) => ({
        opId: o.opId ?? "",
        status: o.status ?? "pending",
      })),
      (opId) => (granted.has(opId) ? 1 : 0),
      doc.rolledBackOps ?? [],
    ),
  );
  return {
    ...summarise(doc),
    operations: (doc.planOps ?? [])
      .filter((o) => remaining.has(o.id ?? ""))
      .map((o) => ({
        summary: o.summary ?? o.id ?? "",
        destructive: o.class === "destructive",
      })),
  };
}
