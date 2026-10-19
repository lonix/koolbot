/** In-memory stand-in for the Event model, shared by the group membership tests (#1191). */

export interface Group {
  key: string;
  name: string;
  kind: string;
  size: number | null;
  channelId: string | null;
  captainId: string | null;
  memberIds: string[];
}
export interface Doc {
  _id: string;
  guildId: string;
  state: string;
  groupsEnabled: boolean;
  groupsLocked: boolean;
  /** Leaders (#1195); a missing field reads as off. */
  captainsEnabled?: boolean;
  leaderLabel?: string;
  groups: Group[];
}

export const store = new Map<string, Doc>();
export const updates: Array<{
  filter: Record<string, unknown>;
  update: unknown;
}> = [];
export const fake = {
  failUpdatesFor: null as string | null,
  /** Extra event-loop turns a findOne with this filter takes (to force reordering). */
  delayFor: null as ((filter: Record<string, unknown>) => number) | null,
  /** Awaited by `findById().lean()` before it reads the store (a delayed fresh read). */
  gateFindById: null as Promise<void> | null,
};

export const clone = <T>(v: T): T => JSON.parse(JSON.stringify(v)) as T;
export const tick = async (): Promise<void> => {
  for (let i = 0; i < 3; i++) await Promise.resolve();
};

function matches(doc: Doc, filter: Record<string, unknown>): boolean {
  for (const [k, v] of Object.entries(filter)) {
    if (k === "_id") {
      if (doc._id !== v) return false;
    } else if (k === "guildId") {
      if (doc.guildId !== v) return false;
    } else if (k === "groupsEnabled") {
      if (doc.groupsEnabled !== v) return false;
    } else if (k === "state") {
      const states = (v as { $in: string[] }).$in;
      if (!states.includes(doc.state)) return false;
    } else if (k === "groups.channelId") {
      if (!doc.groups.some((g) => g.channelId === v)) return false;
    } else if (k === "groups.memberIds") {
      if (!doc.groups.some((g) => g.memberIds.includes(v as string))) {
        return false;
      }
    } else if (k === "groups.captainId") {
      if (!doc.groups.some((g) => g.captainId === v)) return false;
    } else if (k === "groupsLocked") {
      // `true`, or `{ $ne: true }` for "not locked" (a row without the field).
      const locked = doc.groupsLocked === true;
      const want = typeof v === "object" ? !(v as { $ne: boolean }).$ne : v;
      if (locked !== want) return false;
    } else if (k === "captainsEnabled") {
      if ((doc.captainsEnabled ?? false) !== v) return false;
    } else if (k === "groups") {
      const em = (v as { $elemMatch: Record<string, unknown> }).$elemMatch;
      const ok = doc.groups.some((g) =>
        Object.entries(em).every(([ek, ev]) =>
          ek === "memberIds"
            ? g.memberIds.includes(ev as string)
            : (g as unknown as Record<string, unknown>)[ek] === ev,
        ),
      );
      if (!ok) return false;
    } else {
      throw new Error(`unsupported filter ${k}`);
    }
  }
  return true;
}

export const EventMock = {
  findById: (id: string) => ({
    lean: async () => {
      await tick();
      if (fake.gateFindById) await fake.gateFindById;
      const doc = store.get(id);
      return doc ? clone(doc) : null;
    },
  }),
  findOne: (filter: Record<string, unknown>) => {
    const query = {
      select: () => query,
      lean: async () => {
        await tick();
        for (let i = 0; i < (fake.delayFor?.(filter) ?? 0); i++) {
          await Promise.resolve();
        }
        for (const doc of store.values()) {
          if (matches(doc, filter)) return clone(doc);
        }
        return null;
      },
    };
    return query;
  },
  find: (filter: Record<string, unknown>) => {
    const query = {
      select: () => query,
      lean: async () => {
        await tick();
        return [...store.values()].filter((d) => matches(d, filter)).map(clone);
      },
    };
    return query;
  },
  updateOne: async (
    filter: Record<string, unknown>,
    update: {
      $set?: Record<string, unknown>;
      $pull?: Record<string, unknown>;
    },
    options?: { arrayFilters?: Array<Record<string, string>> },
  ) => {
    updates.push({ filter, update });
    await tick();
    const doc = [...store.values()].find((d) => matches(d, filter));
    if (!doc) return { matchedCount: 0, modifiedCount: 0 };
    if (fake.failUpdatesFor && doc._id === fake.failUpdatesFor) {
      throw new Error("write conflict");
    }
    let modified = 0;
    for (const [path, value] of Object.entries(update.$set ?? {})) {
      const c = /^groups\.\$\[(g\d*)\]\.captainId$/.exec(path);
      if (c) {
        // Every condition of the array filter must hold for the element.
        const conds = options?.arrayFilters?.find((f) =>
          Object.keys(f).every((fk) => fk.startsWith(`${c[1]}.`)),
        );
        for (const g of doc.groups) {
          const holds = Object.entries(conds ?? {}).every(
            ([fk, fv]) =>
              (g as unknown as Record<string, unknown>)[
                fk.slice(c[1].length + 1)
              ] === fv,
          );
          if (conds && holds && g.captainId !== (value as string | null)) {
            g.captainId = value as string | null;
            modified = 1;
          }
        }
        continue;
      }
      if (path === "leaderLabel") {
        if (doc.leaderLabel !== value) modified = 1;
        doc.leaderLabel = value as string;
        continue;
      }
      const m = /^groups\.\$\[(g\d+)\]\.memberIds$/.exec(path);
      if (m) {
        const filterKey = options?.arrayFilters?.find(
          (f) => `${m[1]}.key` in f,
        )?.[`${m[1]}.key`];
        for (const g of doc.groups) {
          if (g.key === filterKey) {
            g.memberIds = value as string[];
            modified = 1;
          }
        }
      } else if (path === "groupsLocked") {
        doc.groupsLocked = value as boolean;
        modified = 1;
      } else {
        throw new Error(`unsupported $set ${path}`);
      }
    }
    for (const [path, value] of Object.entries(update.$pull ?? {})) {
      if (path !== "groups.$[].memberIds") throw new Error(`bad $pull ${path}`);
      for (const g of doc.groups) {
        const before = g.memberIds.length;
        g.memberIds = g.memberIds.filter((m) => m !== value);
        if (g.memberIds.length !== before) modified = 1;
      }
    }
    return { matchedCount: 1, modifiedCount: modified };
  },
};
