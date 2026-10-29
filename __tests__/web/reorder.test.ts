/**
 * The pure part of moving one row of an ordered list (#1540).
 */

import { describe, it, expect } from "@jest/globals";
import {
  orderChanges,
  parseMoveRequest,
  planMove,
  positionText,
} from "../../src/web/routes/write/reorder.js";
import type { AuthenticatedRequest } from "../../src/web/session.js";

const IDS = ["a", "b", "c", "d"];

describe("planMove", () => {
  it.each([
    ["up one", "b", 1, 0, ["b", "a", "c", "d"]],
    ["down one", "b", 1, 2, ["a", "c", "b", "d"]],
    ["the first row to the last place", "a", 0, 3, ["b", "c", "d", "a"]],
    ["the last row to the first place", "d", 3, 0, ["d", "a", "b", "c"]],
    ["several places down", "a", 0, 2, ["b", "c", "a", "d"]],
  ])("moves %s", (_name, id, from, to, expected) => {
    expect(planMove(IDS, id, { from, to, count: 4 })).toEqual({
      kind: "moved",
      ids: expected,
    });
  });

  it("does not change the list it was given", () => {
    const ids = [...IDS];
    planMove(ids, "a", { from: 0, to: 3, count: 4 });
    expect(ids).toEqual(IDS);
  });

  it("reports a row that is already there", () => {
    expect(planMove(IDS, "b", { from: 1, to: 1, count: 4 })).toEqual({
      kind: "unchanged",
    });
  });

  it.each([
    ["the list has grown", "b", { from: 1, to: 0, count: 3 }],
    ["the list has shrunk", "b", { from: 1, to: 0, count: 5 }],
    ["another row holds the place", "b", { from: 2, to: 0, count: 4 }],
    ["the row is gone", "x", { from: 1, to: 0, count: 4 }],
    [
      "the place the page showed is past the end",
      "b",
      { from: 9, to: 0, count: 4 },
    ],
  ])("is stale when %s", (_name, id, req) => {
    expect(planMove(IDS, id, req)).toEqual({ kind: "stale" });
  });

  it("refuses a place past the end of the list", () => {
    expect(planMove(IDS, "b", { from: 1, to: 4, count: 4 })).toEqual({
      kind: "out-of-range",
    });
  });
});

describe("orderChanges", () => {
  const rows = (orders: number[]): Array<{ id: string; order: number }> =>
    IDS.map((id, i) => ({ id, order: orders[i] }));

  it("writes nothing when the numbers are already the places", () => {
    expect(orderChanges(rows([0, 1, 2, 3]), IDS)).toEqual([]);
  });

  it("writes only the rows whose number is not their new place", () => {
    expect(orderChanges(rows([0, 1, 2, 3]), ["b", "a", "c", "d"])).toEqual([
      { id: "b", order: 0 },
      { id: "a", order: 1 },
    ]);
  });

  it("gives tied and gapped numbers a place each", () => {
    expect(orderChanges(rows([5, 5, 5, 40]), IDS)).toEqual([
      { id: "a", order: 0 },
      { id: "b", order: 1 },
      { id: "c", order: 2 },
      { id: "d", order: 3 },
    ]);
  });

  it("renumbers negative numbers too", () => {
    expect(orderChanges(rows([-1000, 0, 1, 2]), IDS)[0]).toEqual({
      id: "a",
      order: 0,
    });
  });
});

describe("parseMoveRequest", () => {
  const req = (body: Record<string, unknown>): AuthenticatedRequest =>
    ({ body }) as unknown as AuthenticatedRequest;

  it("reads the three fields", () => {
    expect(parseMoveRequest(req({ from: "1", to: "0", count: "4" }))).toEqual({
      from: 1,
      to: 0,
      count: 4,
    });
  });

  it.each([
    ["nothing", {}],
    ["a word", { from: "1", to: "up", count: "4" }],
    ["a negative place", { from: "1", to: "-1", count: "4" }],
    ["no list", { from: "0", to: "0", count: "0" }],
    ["a place far past any list", { from: "1", to: "99999999", count: "4" }],
    ["non-string values", { from: 1, to: 0, count: 4 }],
  ])("refuses %s", (_name, body) => {
    expect(parseMoveRequest(req(body))).toBeNull();
  });
});

describe("positionText", () => {
  it("counts from one", () => {
    expect(positionText(0, 5)).toBe("position 1 of 5");
    expect(positionText(4, 5)).toBe("position 5 of 5");
  });
});
