import {
  AdoptionSnapshot,
  type AdoptionSnapshotStatus,
} from "../models/adoption-snapshot.js";

/**
 * Read-only listing of saved adoption snapshots for the Web UI history view
 * (#1025). The rollback itself lives in `ServerAdoptionService`; this only
 * reads. It deliberately never selects `baseline` or `memberProgress`: the
 * first is large and the second holds member ids, and neither belongs on a
 * page. Only counts and operation summaries leave this module.
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
  status: string;
}

export interface SnapshotDetail extends SnapshotSummary {
  operations: SnapshotOperationRow[];
}

/** Statuses a rollback may claim (see `AdoptionStore.claim` in the engine). */
export const ROLLBACKABLE_STATUSES: readonly AdoptionSnapshotStatus[] = [
  "applied",
  "partial",
  "rollback_partial",
];

export const canRollback = (status: AdoptionSnapshotStatus): boolean =>
  ROLLBACKABLE_STATUSES.includes(status);

export const HISTORY_LIMIT = 50;

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
  createdRoles?: unknown[];
  plan?: { operations?: RawPlanOp[] };
}

function summarise(doc: RawSnapshot): SnapshotSummary {
  const ops = doc.operations ?? [];
  const planOps = doc.plan?.operations ?? [];
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
    createdRoles: (doc.createdRoles ?? []).length,
  };
}

const SELECT =
  "planId appliedBy status createdAt rolledBackBy rolledBackAt operations createdRoles plan.operations";

/** Newest first, capped. */
export async function listSnapshots(
  guildId: string,
  limit: number = HISTORY_LIMIT,
): Promise<SnapshotSummary[]> {
  const docs = (await AdoptionSnapshot.find({ guildId })
    .select(SELECT)
    .sort({ createdAt: -1 })
    .limit(limit)
    .lean()) as unknown as RawSnapshot[];
  return docs.map(summarise);
}

/** One snapshot of this server, or null (unknown id, or another server's). */
export async function getSnapshotDetail(
  guildId: string,
  id: string,
): Promise<SnapshotDetail | null> {
  if (!/^[0-9a-f]{24}$/i.test(id)) return null;
  const doc = (await AdoptionSnapshot.findOne({ _id: id, guildId })
    .select(SELECT)
    .lean()) as unknown as RawSnapshot | null;
  if (!doc) return null;
  const status = new Map(
    (doc.operations ?? []).map((o) => [o.opId ?? "", o.status ?? "pending"]),
  );
  return {
    ...summarise(doc),
    operations: (doc.plan?.operations ?? []).map((o) => ({
      summary: o.summary ?? o.id ?? "",
      destructive: o.class === "destructive",
      status: status.get(o.id ?? "") ?? "pending",
    })),
  };
}
