import { describe, it, expect } from "@jest/globals";

/**
 * Schema guards for the WebSession row (#1147).
 *
 * The service tests mock this model out, so nothing else loads the schema. A
 * regression here would bring back the unbounded collection growth (no TTL)
 * and the per-sign-in full scan of a member's own history (no compound index).
 */

const { WEB_SESSION_PURGE_GRACE_SECONDS } =
  await import("../../src/models/web-session.js");

type IndexEntry = [Record<string, unknown>, Record<string, unknown>];

interface RecordedSchema {
  indexes(): IndexEntry[];
  path(name: string): { options: Record<string, unknown> };
}

function schema(): RecordedSchema {
  const registry = (
    globalThis as { __mockSchemas?: Map<string, RecordedSchema> }
  ).__mockSchemas;
  const recorded = registry?.get("WebSession");
  if (!recorded) throw new Error("WebSession schema was not recorded");
  return recorded;
}

describe("WebSession model (#1147)", () => {
  it("has MongoDB remove a row a week after it expires", () => {
    const ttl = schema()
      .indexes()
      .find(
        ([fields, options]) =>
          Object.keys(fields).join(",") === "expiresAt" &&
          options?.expireAfterSeconds !== undefined,
      );
    expect(ttl).toBeDefined();
    expect(ttl?.[1].expireAfterSeconds).toBe(WEB_SESSION_PURGE_GRACE_SECONDS);
    expect(WEB_SESSION_PURGE_GRACE_SECONDS).toBe(7 * 24 * 60 * 60);
  });

  it("indexes the lookup revokeForUser runs on every sign-in", () => {
    const keys = schema()
      .indexes()
      .map(([fields]) => JSON.stringify(fields));
    expect(keys).toContain(JSON.stringify({ discordUserId: 1, revokedAt: 1 }));
  });

  it("does not index discordUserId a second time on its own", () => {
    // The compound index above already serves it as a prefix.
    expect(schema().path("discordUserId").options.index).toBeUndefined();
  });

  it("keeps the unique token hash index", () => {
    expect(schema().path("tokenHash").options.unique).toBe(true);
  });
});
