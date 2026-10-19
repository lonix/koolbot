/**
 * In-memory stand-in for the Event model for the leaders and tags rows of the
 * live edit (#1240). It understands exactly the shapes those rows (and the
 * leader customiser's writer, which the in-flight-modal tests drive) write:
 * equality (a missing field equals null), `$in` (null also matches a missing
 * field), `$ne`, `$exists`, `$and`, `groups` `$elemMatch`, top-level `$set`,
 * `groups.$[gN].<field>` selected by `arrayFilters`, `$unset` of such a path and
 * the `$inc` of the save claim. Anything else THROWS, so a write that changes
 * shape cannot pass silently. The real shapes are proven against MongoDB in
 * `__tests__/integration/event-live-edit-leaders-tags.integration.test.ts`.
 */

export type Doc = Record<string, unknown>;

export const lstore = new Map<string, Doc>();
export const lwrites: Array<{
  filter: Doc;
  update: Doc;
  options?: { arrayFilters?: Doc[] };
}> = [];
export const lfake = {
  /** Runs once, right before the next row write matches (an interleaving). */
  beforeWrite: null as (() => void | Promise<void>) | null,
};
export const lclone = <T>(v: T): T => globalThis.structuredClone(v);

const tick = async (): Promise<void> => {
  for (let i = 0; i < 3; i++) await Promise.resolve();
};

function opMatch(val: unknown, cond: unknown): boolean {
  if (cond !== null && typeof cond === "object" && !Array.isArray(cond)) {
    return Object.entries(cond as Doc).every(([op, arg]) => {
      if (op === "$in") {
        const list = arg as unknown[];
        return list.includes(val) || (val === undefined && list.includes(null));
      }
      if (op === "$ne") return val !== arg;
      if (op === "$exists") return (val !== undefined) === arg;
      if (op === "$elemMatch") {
        return Array.isArray(val) && val.some((el) => matchDoc(el as Doc, arg));
      }
      throw new Error(`unsupported operator ${op}`);
    });
  }
  if (cond === null) return val === null || val === undefined;
  // An array field holding the value (`memberIds: "u1"`), as in MongoDB.
  if (Array.isArray(val)) return val.includes(cond);
  return val === cond;
}

export function matchDoc(doc: Doc, filter: unknown): boolean {
  return Object.entries(filter as Doc).every(([k, v]) => {
    if (k === "$and") return (v as Doc[]).every((f) => matchDoc(doc, f));
    if (k.startsWith("$")) throw new Error(`unsupported operator ${k}`);
    return opMatch(doc[k], v);
  });
}

const PATH_RE = /^groups\.\$\[(\w+)\]\.(\w+)$/;

export const LEventMock = {
  findOne: (filter: Doc) => {
    const query = {
      select: () => query,
      lean: async () => {
        await tick();
        for (const doc of lstore.values()) {
          if (matchDoc(doc, filter)) return lclone(doc);
        }
        return null;
      },
    };
    return query;
  },
  updateOne: async (
    filter: Doc,
    update: { $set?: Doc; $unset?: Doc; $inc?: Doc },
    options?: { arrayFilters?: Doc[] },
  ) => {
    const isClaim = update.$inc !== undefined;
    if (!isClaim) {
      lwrites.push({ filter: lclone(filter), update: lclone(update), options });
    }
    await tick();
    if (!isClaim && lfake.beforeWrite) {
      const f = lfake.beforeWrite;
      lfake.beforeWrite = null;
      await f();
    }
    const doc = [...lstore.values()].find((d) => matchDoc(d, filter));
    if (!doc) return { matchedCount: 0, modifiedCount: 0 };
    if (isClaim) {
      if (
        Object.keys(update.$inc ?? {}).some((k) => k !== "liveEditRevision")
      ) {
        throw new Error("unexpected $inc");
      }
      doc.liveEditRevision =
        (typeof doc.liveEditRevision === "number" ? doc.liveEditRevision : 0) +
        1;
      return { matchedCount: 1, modifiedCount: 1 };
    }
    const filters = options?.arrayFilters ?? [];
    let modified = 0;
    const groups = (doc.groups ?? []) as Doc[];
    const touch = (path: string, value: unknown, unset: boolean): void => {
      const m = PATH_RE.exec(path);
      if (!m) {
        if (path.includes("$") || path.includes(".")) {
          throw new Error(`unsupported path ${path}`);
        }
        if (unset) {
          if (path in doc) {
            delete doc[path];
            modified = 1;
          }
        } else if (doc[path] !== value) {
          doc[path] = value;
          modified = 1;
        }
        return;
      }
      const [, ident, field] = m;
      const selector = filters.find((f) =>
        Object.keys(f).every((k) => k.startsWith(`${ident}.`)),
      );
      if (!selector) throw new Error(`no arrayFilter for ${ident}`);
      for (const g of groups) {
        const holds = Object.entries(selector).every(
          ([k, v]) => g[k.slice(ident.length + 1)] === v,
        );
        if (!holds) continue;
        if (unset) {
          if (field in g) {
            delete g[field];
            modified = 1;
          }
        } else if (g[field] !== value) {
          g[field] = value;
          modified = 1;
        }
      }
    };
    for (const [p, v] of Object.entries(update.$set ?? {})) touch(p, v, false);
    for (const p of Object.keys(update.$unset ?? {})) touch(p, null, true);
    return { matchedCount: 1, modifiedCount: modified };
  },
};
