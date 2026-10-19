/**
 * An in-memory stand-in for a Mongoose preset model (equality matching only),
 * shared by the personal-preset service and route tests (#1216). A query that
 * forgets the owner returns another host's row here too, which is the point.
 */

export type Row = Record<string, unknown>;

export function makeStore(label: string) {
  let rows: Row[] = [];
  let seq = 0;
  const state = {
    failFind: false,
    duplicateOnCreate: false,
    get rows(): Row[] {
      return rows;
    },
    reset(): void {
      rows = [];
      seq = 0;
      state.failFind = false;
      state.duplicateOnCreate = false;
    },
  };
  const matches = (row: Row, q: Row): boolean =>
    Object.entries(q).every(([k, v]) => {
      if (v && typeof v === "object" && "$exists" in (v as Row)) {
        return ((row[k] !== undefined) as boolean) === (v as Row).$exists;
      }
      return String(row[k]) === String(v);
    });
  const cursor = (list: () => Row[]) => ({
    sort: () => cursor(list),
    limit: (n: number) => cursor(() => list().slice(0, n)),
    lean: async (): Promise<Row[]> => {
      if (state.failFind) throw new Error(`${label} read failed`);
      return list();
    },
  });
  const model = {
    find: (q: Row) => cursor(() => rows.filter((r) => matches(r, q))),
    findOne: (q: Row) => ({
      lean: async (): Promise<Row | null> =>
        rows.find((r) => matches(r, q)) ?? null,
    }),
    countDocuments: async (q: Row): Promise<number> =>
      rows.filter((r) => matches(r, q)).length,
    create: async (doc: Row): Promise<Row> => {
      if (state.duplicateOnCreate)
        throw Object.assign(new Error("dup"), { code: 11000 });
      const dup = rows.find(
        (r) =>
          r.guildId === doc.guildId &&
          r.ownerId === doc.ownerId &&
          r.nameKey === doc.nameKey,
      );
      if (dup) throw Object.assign(new Error("dup"), { code: 11000 });
      seq += 1;
      const row = { _id: String(seq).padStart(24, "0"), ...doc };
      rows.push(row);
      return row;
    },
    findOneAndUpdate: async (
      q: Row,
      update: { $set: Row },
    ): Promise<Row | null> => {
      const row = rows.find((r) => matches(r, q));
      if (!row) return null;
      Object.assign(row, update.$set);
      return row;
    },
    findOneAndDelete: async (q: Row): Promise<Row | null> => {
      const i = rows.findIndex((r) => matches(r, q));
      return i < 0 ? null : (rows.splice(i, 1)[0] as Row);
    },
    deleteMany: async (q: Row): Promise<{ deletedCount: number }> => {
      const before = rows.length;
      rows = rows.filter((r) => !matches(r, q));
      return { deletedCount: before - rows.length };
    },
  };
  return { state, model };
}
