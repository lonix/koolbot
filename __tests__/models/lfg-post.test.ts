import { describe, it, expect } from "@jest/globals";

/**
 * Schema guards for the LFG post row (#957).
 *
 * The service's own tests mock this model out entirely, so nothing else loads
 * the schema. That matters most for the TTL index: the per-user data registry
 * classifies `hostId` and `memberIds` as `expires` *because* Mongo removes the
 * row whether or not the feature (and its sweep) is still enabled. A schema
 * regression here would quietly invalidate that classification, with no test
 * failing anywhere near it.
 */

const { LfgPost, LFG_ROW_TTL_SECONDS } =
  await import("../../src/models/lfg-post.js");

type IndexEntry = [Record<string, unknown>, Record<string, unknown>];

interface RecordedSchema {
  indexes(): IndexEntry[];
  path(name: string): { options: Record<string, unknown> };
}

/**
 * The schema this model was built with. `mongoose.model` is stubbed to return
 * one shared object for every model — several suites depend on that — so the
 * global test setup records each schema by model name instead.
 */
function schema(): RecordedSchema {
  const registry = (
    globalThis as { __mockSchemas?: Map<string, RecordedSchema> }
  ).__mockSchemas;
  const recorded = registry?.get("LfgPost");
  if (!recorded) throw new Error("LfgPost schema was not recorded");
  return recorded;
}

function indexKeys(): string[] {
  return schema()
    .indexes()
    .map(([fields]) => Object.keys(fields).join(","));
}

describe("LfgPost model (#957)", () => {
  it("loads without throwing under the global mongoose mock", () => {
    expect(LfgPost).toBeDefined();
  });

  it("expires rows an hour past the post's expiry, via the database", () => {
    const ttl = schema()
      .indexes()
      .find(
        ([fields, options]) =>
          fields.expiresAt === 1 && options?.expireAfterSeconds !== undefined,
      );
    expect(ttl).toBeDefined();
    expect(ttl?.[1].expireAfterSeconds).toBe(LFG_ROW_TTL_SECONDS);
    expect(LFG_ROW_TTL_SECONDS).toBe(60 * 60);
  });

  it("indexes the two queries the sweep runs every minute", () => {
    // Due posts, and the messages known to be out of date.
    expect(indexKeys()).toContain("state,expiresAt");
    expect(indexKeys()).toContain("renderPending,lastRenderAttemptAt");
  });

  it("indexes the per-host cap lookup", () => {
    expect(indexKeys()).toContain("guildId,hostId,state");
  });

  it("starts a post as a reservation, not as open", () => {
    // Nothing acts on a `creating` row, which is what keeps a sweep from
    // settling a post whose message does not exist yet.
    expect(schema().path("state").options.default).toBe("creating");
    expect(schema().path("state").options.enum).toEqual([
      "creating",
      "open",
      "closed",
    ]);
  });

  it("starts with no pending render and no recorded attempt", () => {
    expect(schema().path("renderPending").options.default).toBe(false);
    expect(schema().path("lastRenderAttemptAt").options.default).toBe(null);
  });
});
