/**
 * In-memory stand-in for the Event model with just enough MongoDB semantics for
 * the leader customiser (#1196): equality (a missing field equals null), `$in`,
 * an array field containing a value, `groups` `$elemMatch`, and `$set` /
 * `$unset` on `groups.$[g].<field>` selected by `arrayFilters`. The real shapes
 * are proven against MongoDB in
 * `__tests__/integration/event-leader-customise.integration.test.ts`.
 */

export interface CGroup {
  key: string;
  name: string;
  tag?: string;
  kind: string;
  channelId?: string | null;
  captainId?: string | null;
  memberIds: string[];
  originalName?: string;
  originalTag?: string;
  nameSyncPending?: boolean;
  controlMessageId?: string | null;
  controlChannelId?: string | null;
}

export interface CDoc {
  _id: string;
  guildId: string;
  state: string;
  groupsEnabled?: boolean;
  captainsEnabled?: boolean;
  captainCustomisationEnabled?: boolean;
  tagsEnabled?: boolean;
  leaderLabel?: string;
  channelId?: string | null;
  groups: CGroup[];
}

export const cstore = new Map<string, CDoc>();
export const cupdates: Array<{
  filter: Record<string, unknown>;
  update: Record<string, unknown>;
  options?: unknown;
}> = [];
export const cfake = {
  /** Run once, right before the next updateOne reads the store (an interleaving). */
  beforeNextUpdate: null as (() => void) | null,
  failFind: false,
};

export const cclone = <T>(v: T): T => JSON.parse(JSON.stringify(v)) as T;
const tick = async (): Promise<void> => {
  for (let i = 0; i < 3; i++) await Promise.resolve();
};

function eq(actual: unknown, expected: unknown): boolean {
  if (expected === null) return actual === null || actual === undefined;
  if (
    expected &&
    typeof expected === "object" &&
    "$in" in (expected as Record<string, unknown>)
  ) {
    const list = (expected as { $in: unknown[] }).$in;
    return list.some((e) => eq(actual, e));
  }
  if (Array.isArray(actual)) return actual.includes(expected);
  return actual === expected;
}

function matchesElem(g: CGroup, cond: Record<string, unknown>): boolean {
  return Object.entries(cond).every(([k, v]) =>
    eq((g as unknown as Record<string, unknown>)[k], v),
  );
}

export function matchesDoc(
  doc: CDoc,
  filter: Record<string, unknown>,
): boolean {
  return Object.entries(filter).every(([k, v]) => {
    if (k === "groups") {
      const em = (v as { $elemMatch: Record<string, unknown> }).$elemMatch;
      return doc.groups.some((g) => matchesElem(g, em));
    }
    return eq((doc as unknown as Record<string, unknown>)[k], v);
  });
}

export const CEventMock = {
  findOne: (filter: Record<string, unknown>) => {
    const query = {
      select: () => query,
      lean: async () => {
        await tick();
        if (cfake.failFind) throw new Error("read failed");
        for (const doc of cstore.values()) {
          if (matchesDoc(doc, filter)) return cclone(doc);
        }
        return null;
      },
    };
    return query;
  },
  findById: (id: string) => ({
    lean: async () => {
      await tick();
      if (cfake.failFind) throw new Error("read failed");
      const doc = cstore.get(id);
      return doc ? cclone(doc) : null;
    },
  }),
  updateOne: async (
    filter: Record<string, unknown>,
    update: {
      $set?: Record<string, unknown>;
      $unset?: Record<string, unknown>;
    },
    options?: { arrayFilters?: Array<Record<string, unknown>> },
  ) => {
    cupdates.push({ filter, update, options });
    await tick();
    if (cfake.beforeNextUpdate) {
      const f = cfake.beforeNextUpdate;
      cfake.beforeNextUpdate = null;
      f();
    }
    const doc = [...cstore.values()].find((d) => matchesDoc(d, filter));
    if (!doc) return { matchedCount: 0, modifiedCount: 0 };
    const filters = options?.arrayFilters ?? [];
    let modified = 0;
    const apply = (path: string, value: unknown, unset: boolean): void => {
      const m = /^groups\.\$\[g\]\.(\w+)$/.exec(path);
      if (!m) throw new Error(`unsupported path ${path}`);
      const field = m[1];
      for (const g of doc.groups) {
        const holds = filters.every((f) =>
          Object.entries(f).every(
            ([fk, fv]) =>
              (g as unknown as Record<string, unknown>)[fk.slice(2)] === fv,
          ),
        );
        if (!holds) continue;
        const rec = g as unknown as Record<string, unknown>;
        if (unset) {
          if (field in rec) {
            delete rec[field];
            modified = 1;
          }
        } else if (rec[field] !== value) {
          rec[field] = value;
          modified = 1;
        }
      }
    };
    for (const [p, v] of Object.entries(update.$set ?? {})) apply(p, v, false);
    for (const p of Object.keys(update.$unset ?? {})) apply(p, null, true);
    return { matchedCount: 1, modifiedCount: modified };
  },
};
