/**
 * Moving one row of an ordered list (#1540): the pure part, shared by the
 * Notices and Presence move routes.
 *
 * The page posts where the row stood (`from`), where it should go (`to`) and
 * how long the list was (`count`). The server re-reads the list and only moves
 * the row when the list still looks the way the page showed it, so a move made
 * from a page that has gone stale changes nothing.
 */

import type { AuthenticatedRequest } from "../../session.js";
import { getString, parseIntInRange } from "./helpers.js";

/** The largest list a move form can describe; far above any real list. */
const MOVE_INDEX_MAX = 100000;

/** What a move form posted: 0-based positions, and the list the row was shown in. */
export interface MoveRequest {
  from: number;
  to: number;
  count: number;
  /** The category (Notices) or pool (Presence) the page showed the row in. */
  scope: string;
}

/** The move form's four fields, or null when one is missing or not a whole number. */
export function parseMoveRequest(
  req: AuthenticatedRequest,
): MoveRequest | null {
  const from = parseIntInRange(getString(req, "from"), 0, MOVE_INDEX_MAX);
  const to = parseIntInRange(getString(req, "to"), 0, MOVE_INDEX_MAX);
  const count = parseIntInRange(getString(req, "count"), 1, MOVE_INDEX_MAX);
  const scope = getString(req, "scope");
  if (from === null || to === null || count === null || !scope) return null;
  return { from, to, count, scope };
}

export type MovePlan =
  /** The row moves: `ids` is the whole list in its new order. */
  | { kind: "moved"; ids: string[] }
  /** `to` is where the row already is. */
  | { kind: "unchanged" }
  /** The list changed since the page was drawn. Nothing moves. */
  | { kind: "stale" }
  /** `to` is outside the list. */
  | { kind: "out-of-range" };

/**
 * Plan moving `id` from position `from` to `to` in `ids` (the list as stored
 * now, in order). Positions are 0-based.
 */
export function planMove(
  ids: readonly string[],
  id: string,
  req: MoveRequest,
): MovePlan {
  if (ids.length !== req.count || ids[req.from] !== id) {
    return { kind: "stale" };
  }
  if (req.to >= ids.length) return { kind: "out-of-range" };
  if (req.to === req.from) return { kind: "unchanged" };
  const next = ids.filter((x) => x !== id);
  next.splice(req.to, 0, id);
  return { kind: "moved", ids: next };
}

/**
 * The rows whose stored `order` is not yet their position in `ids`: only
 * these are written, and writing every row's position also ends any ties the
 * old order numbers left.
 */
export function orderChanges(
  rows: ReadonlyArray<{ id: string; order: number }>,
  ids: readonly string[],
): Array<{ id: string; order: number }> {
  const stored = new Map(rows.map((r) => [r.id, r.order]));
  const changes: Array<{ id: string; order: number }> = [];
  ids.forEach((id, position) => {
    if (stored.get(id) !== position) changes.push({ id, order: position });
  });
  return changes;
}

/** 1-based wording for a flash: "position 2 of 5". */
export function positionText(index: number, count: number): string {
  return `position ${index + 1} of ${count}`;
}

/**
 * The writes for a move as compare-and-set operations: each one only matches
 * a row that still has the `order` the move read (and still sits in `scope`),
 * so a row another admin changed in between is not overwritten. `rows` is the
 * list as the move read it.
 */
export function casOps(
  changes: ReadonlyArray<{ id: string; order: number }>,
  rows: ReadonlyArray<{ id: string; order: number }>,
  scope: Record<string, string>,
): Array<{
  updateOne: {
    filter: Record<string, unknown>;
    update: { $set: { order: number } };
  };
}> {
  const read = new Map(rows.map((r) => [r.id, r.order]));
  return changes.map((c) => ({
    updateOne: {
      filter: { _id: c.id, ...scope, order: read.get(c.id) },
      update: { $set: { order: c.order } },
    },
  }));
}

/**
 * Whether a `bulkWrite` matched every planned write. When it did not, another
 * move got in first. The rows that did match are already written, so the list
 * can hold a tie until the next move renumbers it; every reader breaks ties by
 * `_id`, so the order stays the same everywhere in the meantime.
 */
export function allMatched(
  result: unknown,
  planned: number,
): { ok: boolean; matched: number } {
  const raw = (result as { matchedCount?: unknown } | null)?.matchedCount;
  const matched = typeof raw === "number" ? raw : 0;
  return { ok: matched >= planned, matched };
}
