import { it, expect, beforeEach } from "@jest/globals";
import Notice from "../../src/models/notice.js";
import { BotStatusMessage } from "../../src/models/bot-status-message.js";
import { describeWithMongo, useRealMongo } from "./mongo-harness.js";
import {
  allMatched,
  casOps,
  orderChanges,
  planMove,
} from "../../src/web/routes/write/reorder.js";

/**
 * Moving a notice or a presence entry (#1540) reads its list sorted by
 * `order` then `_id`, renumbers it with one `bulkWrite` whose filters carry
 * the ids as strings, and puts a new row after the highest `order`. The unit
 * tests mock the models, so they cannot show that these query shapes work on a
 * real server: that the `_id` tie-break is stable, that string ids are cast in
 * the bulk filters, and that only the changed rows are written.
 */
describeWithMongo("reordering against a real MongoDB (#1540)", () => {
  useRealMongo();

  async function notice(title: string, order: number): Promise<string> {
    const n = await new Notice({
      title,
      content: "x",
      category: "general",
      order,
      createdBy: "u1",
    }).save();
    return String(n._id);
  }

  const readNotices = async (): Promise<
    Array<{ id: string; order: number; title: string }>
  > =>
    (
      await Notice.find({ category: "general" })
        .sort({ order: 1, _id: 1 })
        .lean()
    ).map((n) => ({ id: String(n._id), order: n.order, title: n.title }));

  beforeEach(async () => {
    await Notice.deleteMany({});
    await BotStatusMessage.deleteMany({});
  });

  it("lists tied notices in a stable order (by _id)", async () => {
    const a = await notice("a", 5);
    const b = await notice("b", 5);
    const c = await notice("c", 5);
    expect((await readNotices()).map((n) => n.id)).toEqual([a, b, c]);
  });

  it("moves a notice, renumbers the category and writes only the rows that changed", async () => {
    const a = await notice("a", 5);
    const b = await notice("b", 5);
    const c = await notice("c", 9);
    const rows = await readNotices();
    const plan = planMove(
      rows.map((r) => r.id),
      c,
      { from: 2, to: 0, count: 3, scope: "general" },
    );
    if (plan.kind !== "moved") throw new Error("expected a move");
    const changes = orderChanges(rows, plan.ids);
    expect(changes).toHaveLength(3);
    const result = await Notice.bulkWrite(
      casOps(changes, rows, { category: "general" }),
    );
    expect(allMatched(result, changes.length)).toEqual({
      ok: true,
      matched: 3,
    });
    expect(await readNotices()).toEqual([
      { id: c, order: 0, title: "c" },
      { id: a, order: 1, title: "a" },
      { id: b, order: 2, title: "b" },
    ]);
    // A second move that changes one pair writes two rows only.
    const again = await readNotices();
    const plan2 = planMove(
      again.map((r) => r.id),
      a,
      { from: 1, to: 2, count: 3 },
    );
    if (plan2.kind !== "moved") throw new Error("expected a move");
    expect(orderChanges(again, plan2.ids)).toEqual([
      { id: b, order: 1 },
      { id: a, order: 2 },
    ]);
  });

  it("does not overwrite a row another move changed since the read (compare-and-set)", async () => {
    const a = await notice("a", 0);
    const b = await notice("b", 1);
    const c = await notice("c", 2);
    // Two admins read [a, b, c] and both pass the stale check.
    const read = await readNotices();
    const ids = read.map((r) => r.id);
    const first = planMove(ids, b, {
      from: 1,
      to: 0,
      count: 3,
      scope: "general",
    });
    const second = planMove(ids, c, {
      from: 2,
      to: 1,
      count: 3,
      scope: "general",
    });
    if (first.kind !== "moved" || second.kind !== "moved") {
      throw new Error("expected moves");
    }
    const run = (plan: string[]): Promise<unknown> => {
      const changes = orderChanges(read, plan);
      return Notice.bulkWrite(
        casOps(changes, read, { category: "general" }),
      ).then((r) => ({ r, planned: changes.length }));
    };
    const one = (await run(first.ids)) as { r: unknown; planned: number };
    expect(allMatched(one.r, one.planned).ok).toBe(true);
    // The second move's filter for b (order 1) no longer matches: b is at 0 now.
    const two = (await run(second.ids)) as { r: unknown; planned: number };
    expect(allMatched(two.r, two.planned)).toEqual({ ok: false, matched: 1 });
    const after = await readNotices();
    // b kept the place the first move gave it; nothing was overwritten.
    expect(after.find((n) => n.id === b)?.order).toBe(0);
    expect(after.find((n) => n.id === a)?.order).toBe(1);
  });

  it("does not match a notice that is stored in another category now", async () => {
    const a = await notice("a", 0);
    await Notice.updateOne({ _id: a }, { $set: { category: "rules" } });
    const result = await Notice.bulkWrite(
      casOps([{ id: a, order: 3 }], [{ id: a, order: 0 }], {
        category: "general",
      }),
    );
    expect(allMatched(result, 1)).toEqual({ ok: false, matched: 0 });
  });

  it("finds the last notice of a category for a new notice's place", async () => {
    await notice("a", 3);
    await notice("b", 7);
    const last = await Notice.findOne({ category: "general" })
      .sort({ order: -1, _id: -1 })
      .lean();
    expect(last?.order).toBe(7);
    expect(
      await Notice.findOne({ category: "rules" })
        .sort({ order: -1, _id: -1 })
        .lean(),
    ).toBeNull();
  });

  it("renumbers one presence pool of one guild and leaves the others alone", async () => {
    const make = async (
      pool: "lonely" | "single",
      text: string,
      order: number,
      guildId = "g1",
    ): Promise<string> =>
      String(
        (
          await new BotStatusMessage({
            guildId,
            pool,
            text,
            order,
            createdBy: "u1",
          }).save()
        )._id,
      );
    const a = await make("single", "a", 2);
    const b = await make("single", "b", 2);
    const other = await make("single", "elsewhere", 2, "g2");
    const lonely = await make("lonely", "l", 2);
    const rows = (
      await BotStatusMessage.find({ guildId: "g1", pool: "single" })
        .sort({ order: 1, _id: 1 })
        .lean()
    ).map((e) => ({ id: String(e._id), order: e.order }));
    expect(rows.map((r) => r.id)).toEqual([a, b]);
    const plan = planMove(
      rows.map((r) => r.id),
      b,
      { from: 1, to: 0, count: 2, scope: "single" },
    );
    if (plan.kind !== "moved") throw new Error("expected a move");
    await BotStatusMessage.bulkWrite(
      casOps(orderChanges(rows, plan.ids), rows, {
        guildId: "g1",
        pool: "single",
      }),
    );
    const order = async (id: string): Promise<number | undefined> =>
      (await BotStatusMessage.findById(id).lean())?.order;
    expect(await order(b)).toBe(0);
    expect(await order(a)).toBe(1);
    expect(await order(other)).toBe(2);
    expect(await order(lonely)).toBe(2);
  });
});
