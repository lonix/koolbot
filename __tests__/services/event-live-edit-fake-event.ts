/**
 * In-memory stand-in for the Event model, shared by the live edit tests
 * (#1239). It understands exactly the filter and `$set` shapes the live edit
 * rows write (`$in`, `$ne`, `$type: "string"`, `$elemMatch`, `$nor`, equality
 * with `null` matching a missing field) and THROWS on any other, so a write
 * that changes shape cannot pass silently. The real shapes are proven against
 * MongoDB in `__tests__/integration/event-live-edit.integration.test.ts`.
 */

export type Json = Record<string, unknown>;

export const store = new Map<string, Json>();
export const writes: Array<{ filter: Json; set: Json }> = [];
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
      if (op === "$in") return (arg as unknown[]).includes(val);
      if (op === "$ne") return val !== arg;
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
  return val === cond;
}

export function matchDoc(doc: Json, filter: unknown): boolean {
  return Object.entries(filter as Json).every(([k, v]) => {
    if (k === "$nor") return (v as Json[]).every((f) => !matchDoc(doc, f));
    return opMatch(doc[k], v);
  });
}

/** Fields a live edit row may `$set`. */
export const SETTABLE = new Set([
  "testPartial",
  "testOwed",
  "channelLeadMinutes",
  "groupsLocked",
  "testName",
]);

export const EventMock = {
  findOne: (filter: Json) => ({
    lean: async () => {
      await Promise.resolve();
      if (fake.failReads) throw new Error("db down");
      for (const doc of store.values()) {
        if (matchDoc(doc, filter)) return clone(doc);
      }
      return null;
    },
  }),
  updateOne: async (filter: Json, update: { $set: Json }) => {
    for (const k of Object.keys(update.$set)) {
      if (!SETTABLE.has(k)) throw new Error(`unexpected $set ${k}`);
    }
    if (Object.keys(update).some((k) => k !== "$set")) {
      throw new Error("unexpected update operator");
    }
    await fake.beforeWrite?.();
    await Promise.resolve();
    writes.push({ filter: clone(filter), set: clone(update.$set) });
    const doc = [...store.values()].find((d) => matchDoc(d, filter));
    if (!doc) return { matchedCount: 0, modifiedCount: 0 };
    Object.assign(doc, update.$set);
    return { matchedCount: 1, modifiedCount: 1 };
  },
};
