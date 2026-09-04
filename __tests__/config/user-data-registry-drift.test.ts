import { describe, it, expect } from "@jest/globals";
import { readFileSync, readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import {
  DELETABLE_COLLECTIONS,
  EXPORTABLE_COLLECTIONS,
  USER_DATA_REGISTRY,
  isUserIdFieldName,
} from "../../src/services/user-data-registry.js";
import { READER_COLLECTIONS } from "../../src/services/user-data-export-service.js";

/**
 * Guards the per-user data registry against drifting away from the schemas
 * it claims to describe (#719).
 *
 * The self-service export is only as trustworthy as its allowlist. Enumerated
 * by hand it rots in both directions: a new model carrying a Discord user id
 * either leaks into a member's download or is silently missed, and neither
 * failure shows up in a test that only exercises the routes. So this suite
 * scans every schema source for user-id-shaped fields and requires each one
 * to be classified — the same forcing function `settings-doc-drift.test.ts`
 * applies to config keys.
 *
 * Since #913 the classification has two halves, and both are forced here: a
 * new per-user model that ships with an export decision and no delete decision
 * is the same silent failure moved one column over.
 *
 * Both directions are checked: a field the scan finds must be in the
 * registry, and a field the registry names must still exist in its source.
 */

const REPO_ROOT = fileURLToPath(new URL("../../", import.meta.url));

/** Every file that declares a Mongoose schema with per-user fields. */
function schemaSources(): string[] {
  const models = readdirSync(`${REPO_ROOT}src/models`)
    .filter((name) => name.endsWith(".ts"))
    .map((name) => `src/models/${name}`);
  // Quotes live outside `src/models/` — exactly the kind of thing a
  // hand-written enumeration misses (see the note in the registry).
  return [...models, "src/database/schema.ts"].sort();
}

/**
 * Comments are stripped before scanning: the model files describe their
 * identity in prose ("one row per `(userId, guildId)`"), and a doc comment
 * must not be able to satisfy — or trip — the field scan.
 */
function stripComments(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, " ").replace(/\/\/[^\n]*/g, " ");
}

/**
 * Field names declared in a schema/interface. Matches `name:` after a line
 * start or an opening brace/comma/semicolon, so it picks up nested and inline
 * declarations (`Array<{ userId: string; seconds: number }>`) as well as
 * top-level ones.
 */
function declaredFields(source: string): Set<string> {
  const found = new Set<string>();
  for (const match of stripComments(source).matchAll(
    /(?:^|[{,;(<])\s*([A-Za-z_]\w*)\??\s*:/gm,
  )) {
    found.add(match[1]);
  }
  return found;
}

function classificationOf(
  source: string,
  field: string,
): (typeof USER_DATA_REGISTRY)[number] | undefined {
  return USER_DATA_REGISTRY.find(
    (entry) => entry.source === source && entry.field === field,
  );
}

describe("user-data registry / schema drift", () => {
  it("classifies every user-id field declared in a schema source", () => {
    const unclassified: string[] = [];
    for (const source of schemaSources()) {
      const text = readFileSync(`${REPO_ROOT}${source}`, "utf8");
      for (const field of declaredFields(text)) {
        if (!isUserIdFieldName(field)) continue;
        if (!classificationOf(source, field)) {
          unclassified.push(`${source}:${field}`);
        }
      }
    }
    // A failure here means a model carrying a Discord user id shipped without
    // anyone deciding whether a member may download it. Add an entry to
    // `USER_DATA_REGISTRY` (with a reader, if it is exportable).
    expect(unclassified.sort()).toEqual([]);
  });

  it("names no field that has since been renamed or removed", () => {
    const stale: string[] = [];
    for (const entry of USER_DATA_REGISTRY) {
      const text = readFileSync(`${REPO_ROOT}${entry.source}`, "utf8");
      if (!declaredFields(text).has(entry.field)) {
        stale.push(`${entry.source}:${entry.field}`);
      }
    }
    expect(stale.sort()).toEqual([]);
  });

  it("classifies each (source, field) pair exactly once", () => {
    const seen = new Set<string>();
    const duplicates: string[] = [];
    for (const entry of USER_DATA_REGISTRY) {
      const key = `${entry.source}:${entry.field}`;
      if (seen.has(key)) duplicates.push(key);
      seen.add(key);
    }
    expect(duplicates).toEqual([]);
  });

  it("justifies every entry", () => {
    // The note is the triage decision. An entry without one is an entry
    // nobody actually thought about.
    expect(
      USER_DATA_REGISTRY.filter((entry) => entry.note.trim().length < 20).map(
        (entry) => `${entry.source}:${entry.field}`,
      ),
    ).toEqual([]);
  });

  it("declares a delete policy on every entry", () => {
    // #913: `onDelete` says what a purge does with the rows this field
    // matches, and `subject` says whether they are the member's to erase at
    // all. TypeScript already requires both; this catches an entry that
    // reaches the registry from untyped JSON or a widened cast.
    const policies = [
      "hard-delete",
      "pull-member",
      "anonymise",
      "retain",
      "expires",
    ];
    expect(
      USER_DATA_REGISTRY.filter(
        (entry) =>
          !policies.includes(entry.onDelete) ||
          !["self", "mention"].includes(entry.subject),
      ).map((entry) => `${entry.source}:${entry.field}`),
    ).toEqual([]);
  });

  it("justifies every delete policy", () => {
    // Mirrors the export-side `note` check: the deleteNote is the triage
    // decision, and an entry without one is an entry nobody thought about.
    expect(
      USER_DATA_REGISTRY.filter(
        (entry) => entry.deleteNote.trim().length < 20,
      ).map((entry) => `${entry.source}:${entry.field}`),
    ).toEqual([]);
  });

  it("never purges a field that only mentions the member", () => {
    // A `mention` names the member inside a row that belongs to someone
    // else — the co-present ids on other members' voice sessions, the
    // moderator on another member's record. Those are not theirs to erase,
    // so no actionable policy may be paired with one.
    const wrong = USER_DATA_REGISTRY.filter(
      (entry) =>
        entry.subject === "mention" &&
        !["retain", "expires"].includes(entry.onDelete),
    );
    expect(wrong.map((entry) => `${entry.source}:${entry.field}`)).toEqual([]);
  });

  it("keeps the moderation and audit surface out of the export", () => {
    // The one classification the issue is explicit about: a warned member
    // must not be able to read their own moderation history — or the audit
    // trails — out of a self-service endpoint.
    const mustExclude = [
      "src/models/moderation-log.ts",
      "src/models/discord-command-audit-log.ts",
      "src/models/web-audit-log.ts",
      "src/models/web-session.ts",
    ];
    const leaked = USER_DATA_REGISTRY.filter(
      (entry) => entry.exportable && mustExclude.includes(entry.source),
    );
    expect(leaked).toEqual([]);
  });

  it("keeps the moderation and audit surface out of a purge", () => {
    // The delete-side mirror of the test above: a member must not be able to
    // erase their own moderation history — or the audit trails, or the
    // session infrastructure — from a self-service endpoint.
    const mustRetain = [
      "src/models/moderation-log.ts",
      "src/models/discord-command-audit-log.ts",
      "src/models/web-audit-log.ts",
      "src/models/web-session.ts",
    ];
    const purged = USER_DATA_REGISTRY.filter(
      (entry) =>
        mustRetain.includes(entry.source) && entry.onDelete !== "retain",
    );
    expect(purged.map((entry) => `${entry.source}:${entry.field}`)).toEqual([]);
    // And none of them reaches the coordinator's work list.
    expect(
      DELETABLE_COLLECTIONS.filter((collection) =>
        [
          "moderation-log",
          "discord-command-audit-log",
          "web-audit-log",
          "web-session",
        ].includes(collection),
      ),
    ).toEqual([]);
  });

  it("purges only collections a member can also export", () => {
    // Anything a purge touches is by definition the member's own data, so it
    // must already be classified as exportable. The reverse does not hold:
    // `voice-channel-ownership` is exported by nobody and expires on its own.
    expect(
      DELETABLE_COLLECTIONS.filter(
        (collection) => !EXPORTABLE_COLLECTIONS.includes(collection),
      ),
    ).toEqual([]);
  });

  it("has a reader for exactly the exportable collections", () => {
    // The registry decides what a member gets; the export service has to
    // implement precisely that, no more and no less.
    expect([...READER_COLLECTIONS].sort()).toEqual(
      [...EXPORTABLE_COLLECTIONS].sort(),
    );
  });
});

describe("isUserIdFieldName", () => {
  it("matches the naming conventions the schemas actually use", () => {
    for (const name of [
      "userId",
      "userIds",
      "discordUserId",
      "ownerId",
      "authorId",
      "addedById",
      "moderatorId",
      "voterIds",
      "createdBy",
      "invitedBy",
      "otherUsers",
    ]) {
      expect(isUserIdFieldName(name)).toBe(true);
    }
  });

  it("does not match ids that point at something other than a person", () => {
    for (const name of [
      "channelId",
      "messageId",
      "guildId",
      "roleId",
      "sessionId",
      "categoryId",
      "announcementMessageId",
      "startTime",
      "totalTime",
    ]) {
      expect(isUserIdFieldName(name)).toBe(false);
    }
  });
});
