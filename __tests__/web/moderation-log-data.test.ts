/**
 * `resolveMemberLabels` asks Discord for at most 100 members per request, and
 * a failed request costs only its own names.
 */
import { describe, it, expect, jest } from "@jest/globals";

jest.unstable_mockModule("../../src/utils/logger.js", () => ({
  default: {
    info: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
    debug: jest.fn(),
  },
}));

const { resolveMemberLabels } =
  await import("../../src/web/moderation-log-data.js");

const idsOf = (n: number): string[] =>
  Array.from({ length: n }, (_, i) => `u${String(i).padStart(3, "0")}`);

function clientWith(
  fetchMembers: (opts: { user: string[] }) => Promise<Map<string, unknown>>,
): never {
  return {
    guilds: {
      fetch: async () => ({
        members: { cache: { get: () => undefined }, fetch: fetchMembers },
      }),
    },
  } as never;
}

const named = (ids: string[]): Map<string, unknown> =>
  new Map(
    ids.map((id) => [
      id,
      { displayName: `name-${id}`, user: { username: id } },
    ]),
  );

describe("resolveMemberLabels", () => {
  it("splits 250 uncached ids into requests of 100, 100 and 50", async () => {
    const calls: number[] = [];
    const fetchMembers = jest.fn(async (o: { user: string[] }) => {
      calls.push(o.user.length);
      return named(o.user);
    });
    const labels = await resolveMemberLabels(
      clientWith(fetchMembers),
      "g1",
      new Set(idsOf(250)),
    );
    expect(calls).toEqual([100, 100, 50]);
    expect(labels.size).toBe(250);
    expect(labels.get("u249")).toBe("name-u249");
  });

  it("keeps the names from the batches that worked when one batch fails", async () => {
    let n = 0;
    const fetchMembers = jest.fn(async (o: { user: string[] }) => {
      n += 1;
      if (n === 2) throw new Error("discord 400");
      return named(o.user);
    });
    const all = idsOf(250);
    const labels = await resolveMemberLabels(
      clientWith(fetchMembers),
      "g1",
      new Set(all),
    );
    expect(fetchMembers).toHaveBeenCalledTimes(3);
    expect(labels.size).toBe(150);
    expect(labels.has(all[0])).toBe(true);
    expect(labels.has(all[100])).toBe(false); // the failed batch falls back to ids
    expect(labels.has(all[200])).toBe(true);
  });
});
