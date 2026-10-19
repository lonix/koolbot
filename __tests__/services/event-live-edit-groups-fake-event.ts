/**
 * In-memory stand-in for the Event model for the group live edit (#1241) and
 * the leader writes it must stay consistent with. It understands exactly the
 * filter and update shapes those writers use, and THROWS on any other, so a
 * write that changes shape cannot pass silently:
 *
 * - filters: equality (a missing field equals null; an array field equals a
 *   scalar it contains), `$in`, `$ne`, `$elemMatch`, `$size`, `$and`, `$type`;
 * - updates: `$set` and `$unset` on top-level fields and on
 *   `groups.$[<id>].<field>` selected by `arrayFilters` (every identifier must
 *   have exactly one filter and every filter must be used, as MongoDB demands),
 *   and `$inc` of `liveEditRevision`.
 *
 * Only fields of the schema are accepted (`SETTABLE`, `GROUP_FIELDS`), so a
 * misspelt field fails here instead of being dropped by Mongoose's strict mode
 * in production. The real shapes are proven against MongoDB in
 * `__tests__/integration/event-live-edit-groups.integration.test.ts`.
 */

export type Json = Record<string, unknown>;

export const store = new Map<string, Json>();
export const writes: Array<{ filter: Json; update: Json; options: Json }> = [];
export const fake = {
  /** Runs before each write is matched (to simulate a concurrent writer). */
  beforeWrite: null as (() => void | Promise<void>) | null,
  failReads: false,
};
export const clone = <T>(v: T): T => globalThis.structuredClone(v);

function opMatch(val: unknown, cond: unknown): boolean {
  if (
    cond !== null &&
    typeof cond === "object" &&
    !Array.isArray(cond) &&
    !(cond instanceof Date)
  ) {
    return Object.entries(cond as Json).every(([op, arg]) => {
      if (op === "$in") {
        const list = arg as unknown[];
        return list.some((c) => opMatch(val, c));
      }
      if (op === "$ne") return val !== arg;
      if (op === "$size") return Array.isArray(val) && val.length === arg;
      if (op === "$type") {
        if (arg !== "string") throw new Error(`unsupported $type ${arg}`);
        return typeof val === "string";
      }
      if (op === "$elemMatch") {
        return (
          Array.isArray(val) && val.some((el) => matchDoc(el as Json, arg))
        );
      }
      throw new Error(`unsupported operator ${op}`);
    });
  }
  if (cond === null) return val === null || val === undefined;
  if (Array.isArray(val) && !Array.isArray(cond)) return val.includes(cond);
  return val === cond;
}

export function matchDoc(doc: Json, filter: unknown): boolean {
  return Object.entries(filter as Json).every(([k, v]) => {
    if (k === "$and") return (v as Json[]).every((f) => matchDoc(doc, f));
    if (k.startsWith("$")) throw new Error(`unsupported operator ${k}`);
    return opMatch(doc[k], v);
  });
}

/** Top-level fields an update may `$set` or `$unset`. */
export const SETTABLE = new Set(["presetId", "channelLeadMinutes"]);
/** Group fields an update may touch through `groups.$[id].<field>`. */
export const GROUP_FIELDS = new Set([
  "name",
  "size",
  "tag",
  "kind",
  "captainId",
  "originalName",
  "originalTag",
  "nameSyncPending",
  "sizeSyncPending",
]);

function applyUpdate(
  doc: Json,
  update: { $set?: Json; $unset?: Json; $inc?: Json },
  arrayFilters: Array<Record<string, unknown>>,
): void {
  for (const op of Object.keys(update)) {
    if (!["$set", "$unset", "$inc"].includes(op)) {
      throw new Error(`unsupported update operator ${op}`);
    }
  }
  const used = new Set<string>();
  const pathOf = (
    path: string,
  ): { group: string; field: string } | { field: string } => {
    const m = /^groups\.\$\[(\w+)\]\.(\w+)$/.exec(path);
    if (m) {
      if (!GROUP_FIELDS.has(m[2])) throw new Error(`unexpected field ${path}`);
      return { group: m[1], field: m[2] };
    }
    if (!SETTABLE.has(path)) throw new Error(`unexpected field ${path}`);
    return { field: path };
  };
  const targets = (id: string): Json[] => {
    const filters = arrayFilters.filter((f) =>
      Object.keys(f).every((k) => k.startsWith(`${id}.`)),
    );
    if (filters.length !== 1) {
      throw new Error(`no (or several) array filters for identifier ${id}`);
    }
    used.add(id);
    return (doc.groups as Json[]).filter((g) =>
      Object.entries(filters[0]).every(
        ([k, v]) => g[k.slice(id.length + 1)] === v,
      ),
    );
  };
  for (const [p, v] of Object.entries(update.$set ?? {})) {
    const t = pathOf(p);
    if ("group" in t) {
      for (const g of targets(t.group)) g[t.field] = v;
    } else {
      doc[t.field] = v;
    }
  }
  for (const p of Object.keys(update.$unset ?? {})) {
    const t = pathOf(p);
    if ("group" in t) {
      for (const g of targets(t.group)) delete g[t.field];
    } else {
      delete doc[t.field];
    }
  }
  for (const [p, v] of Object.entries(update.$inc ?? {})) {
    if (p !== "liveEditRevision") throw new Error(`unexpected $inc ${p}`);
    doc[p] = (typeof doc[p] === "number" ? (doc[p] as number) : 0) + Number(v);
  }
  for (const f of arrayFilters) {
    const id = Object.keys(f)[0].split(".")[0];
    if (!used.has(id)) throw new Error(`array filter ${id} not used`);
  }
}

export const EventMock = {
  findOne: (filter: Json) => {
    const query = {
      select: () => query,
      lean: async () => {
        await Promise.resolve();
        if (fake.failReads) throw new Error("db down");
        for (const doc of store.values()) {
          if (matchDoc(doc, filter)) return clone(doc);
        }
        return null;
      },
    };
    return query;
  },
  findById: (id: string) => ({
    lean: async () => {
      await Promise.resolve();
      if (fake.failReads) throw new Error("db down");
      const doc = store.get(id);
      return doc ? clone(doc) : null;
    },
  }),
  updateOne: async (
    filter: Json,
    update: { $set?: Json; $unset?: Json; $inc?: Json },
    options: { arrayFilters?: Array<Record<string, unknown>> } = {},
  ) => {
    await fake.beforeWrite?.();
    await Promise.resolve();
    writes.push({
      filter: clone(filter),
      update: clone(update as Json),
      options: clone(options as Json),
    });
    const doc = [...store.values()].find((d) => matchDoc(d, filter));
    if (!doc) return { matchedCount: 0, modifiedCount: 0 };
    applyUpdate(doc, update, options.arrayFilters ?? []);
    return { matchedCount: 1, modifiedCount: 1 };
  },
};
