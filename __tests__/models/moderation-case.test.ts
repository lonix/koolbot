import { describe, it, expect } from "@jest/globals";

/**
 * Schema guards for the moderation case row (#908).
 *
 * Service tests mock this model out, so nothing else loads the schema. The
 * unique `(guildId, caseNumber)` index is the backstop for case numbers, and
 * the queue and retention queries lean on the other three, so a regression
 * here would fail no test anywhere near it.
 */

const { ModerationCase, TERMINAL_CASE_STATUSES, LIVE_CASE_STATUSES } =
  await import("../../src/models/moderation-case.js");

type IndexEntry = [Record<string, unknown>, Record<string, unknown>];

interface RecordedSchema {
  indexes(): IndexEntry[];
  path(name: string): { options: Record<string, unknown> };
}

function schema(): RecordedSchema {
  const registry = (
    globalThis as { __mockSchemas?: Map<string, RecordedSchema> }
  ).__mockSchemas;
  const recorded = registry?.get("ModerationCase");
  if (!recorded) throw new Error("ModerationCase schema was not recorded");
  return recorded;
}

describe("ModerationCase model", () => {
  it("loads under the global mongoose mock", () => {
    expect(ModerationCase).toBeDefined();
  });

  it("makes case numbers unique per guild", () => {
    const unique = schema()
      .indexes()
      .find(
        ([fields]) => JSON.stringify(fields) === '{"guildId":1,"caseNumber":1}',
      );
    expect(unique?.[1]).toEqual({ unique: true });
  });

  it("allows one case per log entry", () => {
    const unique = schema()
      .indexes()
      .find(
        ([fields]) =>
          JSON.stringify(fields) === '{"guildId":1,"originEntryId":1}',
      );
    expect(unique?.[1]).toEqual({ unique: true });
  });

  it("indexes the review queue and the member lookup", () => {
    const keys = schema()
      .indexes()
      .map(([fields]) => JSON.stringify(fields));
    expect(keys).toContain('{"guildId":1,"status":1,"reviewAt":1}');
    expect(keys).toContain('{"guildId":1,"userId":1,"openedAt":-1}');
  });

  it("only lets a kick or a ban carry a case, and starts open", () => {
    expect(schema().path("action").options.enum).toEqual(["kick", "ban"]);
    expect(schema().path("status").options.default).toBe("open");
    expect(schema().path("reviewAt").options.default).toBeNull();
  });

  it("splits the statuses into live and terminal with no overlap", () => {
    expect([...LIVE_CASE_STATUSES].sort()).toEqual(["open", "under_review"]);
    expect([...TERMINAL_CASE_STATUSES].sort()).toEqual([
      "expired",
      "lifted",
      "upheld",
    ]);
  });
});
