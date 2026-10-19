import { describe, it, expect, jest, beforeEach } from "@jest/globals";

/**
 * Live edit of group names, sizes and the preset (#1241): the rows of
 * `event-live-edit-groups.ts` run through the REAL core (planner, executor,
 * locks, confirmation round trip, result text) against the in-memory Event
 * stand-in of `event-live-edit-groups-fake-event.ts`, with the channel and
 * nickname effects replaced by fakes. The stand-in throws on any filter or
 * update shape the rows do not use; the real shapes are proven against MongoDB
 * in `__tests__/integration/event-live-edit-groups.integration.test.ts`.
 *
 * Expected values are literals, never computed by a copy of the logic under test.
 */

import {
  store,
  writes,
  fake,
  EventMock,
  clone,
  type Json,
} from "./event-live-edit-groups-fake-event.js";

jest.unstable_mockModule("../../src/models/event.js", () => ({
  Event: EventMock,
}));
jest.unstable_mockModule("../../src/services/config-service.js", () => ({
  ConfigService: { getInstance: () => ({}) },
}));
jest.unstable_mockModule(
  "../../src/services/tracking-opt-out-service.js",
  () => ({ TrackingOptOutService: { getInstance: () => ({}) } }),
);

process.env.WEBUI_SESSION_SECRET = "live-edit-groups-test-secret";

const {
  LIVE_EDIT_ROWS,
  runLiveEdit,
  parseSubmission,
  describeLiveEditOutcome,
  isGroupOverSize,
  signConfirmation,
  verifyConfirmation,
} = await import("../../src/services/event-live-edit.js");
type LiveEditDeps =
  import("../../src/services/event-live-edit.js").LiveEditDeps;
type LiveEditOutcome =
  import("../../src/services/event-live-edit.js").LiveEditOutcome;
const {
  configureGroupEditEffects,
  groupNameRowId,
  groupSizeRowId,
  groupPresetRow,
  readPresetValue,
  GROUP_PRESET_ROW_ID,
  GROUP_EDIT_POSITIONS,
  GROUP_EDIT_ROWS,
} = await import("../../src/services/event-live-edit-groups.js");
type NameSyncOutcome =
  import("../../src/services/event-group-channels.js").NameSyncOutcome;
const { planAssign, planRandomise, seededRandom } =
  await import("../../src/services/event-group-plan.js");
const { resetMoveGuardForTests } =
  await import("../../src/services/event-move-guard.js");
const { boundAuditEntry } = await import("../../src/web/audit.js");

const GUILD = "guild-1";
const EV = "65a000000000000000000001";
const A = "g_00000001";
const B = "g_00000002";
const C = "g_00000003";
const NAME_A = groupNameRowId(0);
const NAME_B = groupNameRowId(1);
const NAME_C = groupNameRowId(2);
const SIZE_A = groupSizeRowId(0);
const SIZE_B = groupSizeRowId(1);

function seed(over: Json = {}): Json {
  const doc: Json = {
    _id: EV,
    guildId: GUILD,
    state: "active",
    groupsEnabled: true,
    presetId: null,
    groupLabel: "Team",
    leaderLabel: "Leader",
    channelLeadMinutes: null,
    channelId: "c-main",
    tagsEnabled: false,
    groups: [
      {
        key: A,
        name: "Alpha",
        kind: "team",
        size: 3,
        tag: "A",
        marker: "",
        channelId: "c1",
        captainId: null,
        memberIds: ["u1", "u2"],
      },
      {
        key: B,
        name: "Bravo",
        kind: "team",
        size: null,
        tag: "",
        marker: "",
        channelId: "c2",
        captainId: null,
        memberIds: ["u3"],
      },
      {
        key: C,
        name: "Charlie",
        kind: "team",
        size: 2,
        tag: "",
        marker: "",
        channelId: null,
        captainId: null,
        memberIds: [],
      },
    ],
    ...over,
  };
  store.set(EV, doc);
  return doc;
}

const groupsOf = (): Json[] => store.get(EV)?.groups as Json[];
const group = (key: string): Json =>
  groupsOf().find((g) => g.key === key) as Json;
/** Row writes only: the save's revision claim is a separate update. */
const rowWrites = (): typeof writes =>
  writes.filter((w) => !("$inc" in w.update));

let enabled: boolean | null = true;
let ending = false;
/** The ending hold turns on once a row's own write has landed. */
let endAfterRowWrite = false;
const deps: LiveEditDeps = {
  isEventsEnabled: async () => enabled,
  maxGroups: async () => 15,
  isEnding: () => ending || (endAfterRowWrite && rowWrites().length > 0),
};

const calls: string[] = [];
let nameResult: (key: string) => NameSyncOutcome | null = (key) => ({
  groupKey: key,
  status: "applied",
});
let limitResult: (key: string) => NameSyncOutcome | null = (key) => ({
  groupKey: key,
  status: "applied",
});
let throwInEffects = false;
const retagCalls: Array<{ memberIds: string[] }> = [];

/** The channel pass of production clears the marker once the channel matches. */
function clearFlag(key: string, flag: string): void {
  delete group(key)[flag];
}

beforeEach(() => {
  store.clear();
  writes.length = 0;
  calls.length = 0;
  retagCalls.length = 0;
  fake.beforeWrite = null;
  fake.afterFind = null;
  fake.failReads = false;
  enabled = true;
  ending = false;
  endAfterRowWrite = false;
  throwInEffects = false;
  nameResult = (key) => ({ groupKey: key, status: "applied" });
  limitResult = (key) => ({ groupKey: key, status: "applied" });
  resetMoveGuardForTests();
  seed();
  configureGroupEditEffects({
    async syncName(_g, _e, key) {
      calls.push(`name:${key}`);
      if (throwInEffects) throw new Error("gateway down");
      const out = nameResult(key);
      if (out?.status === "applied") clearFlag(key, "nameSyncPending");
      return out;
    },
    async syncUserLimit(_g, _e, key) {
      calls.push(`limit:${key}`);
      if (throwInEffects) throw new Error("gateway down");
      const out = limitResult(key);
      if (out?.status === "applied") clearFlag(key, "sizeSyncPending");
      return out;
    },
    retag(_g, _e, memberIds) {
      retagCalls.push({ memberIds });
    },
  });
});

const entry = (rowId: string, to: unknown, base: unknown) => ({
  rowId,
  to,
  base,
});
const run = (
  entries: Array<{ rowId: string; to: unknown; base: unknown }>,
): Promise<LiveEditOutcome> =>
  runLiveEdit({
    guildId: GUILD,
    eventId: EV,
    deps,
    submission: entries as never,
  });

type Done = Extract<LiveEditOutcome, { status: "done" }>;
const done = (o: LiveEditOutcome): Done => {
  expect(o.status).toBe("done");
  return o as Done;
};
const text = (o: LiveEditOutcome): string => describeLiveEditOutcome(o).message;

describe("the rows are part of the core's registry", () => {
  it("lists one name row and one size row per position, then the preset, with letters-only ids", () => {
    expect(GROUP_EDIT_POSITIONS).toBe(25);
    expect(GROUP_EDIT_ROWS).toHaveLength(25 + 25 + 1);
    expect(NAME_A).toBe("groupNameA");
    expect(groupNameRowId(24)).toBe("groupNameY");
    expect(SIZE_B).toBe("groupSizeB");
    expect(GROUP_PRESET_ROW_ID).toBe("groupPreset");
    const ids = LIVE_EDIT_ROWS.map((r) => r.id);
    expect(new Set(ids).size).toBe(ids.length);
    for (const row of GROUP_EDIT_ROWS) {
      expect(row.id).toMatch(/^[A-Za-z]+$/);
      expect(ids).toContain(row.id);
    }
  });
});

describe("rename a group", () => {
  it("renames in place: stores the name and a pending marker in one conditional write, then renames the channel", async () => {
    const out = await run([entry(NAME_A, "Apex", "Alpha")]);
    expect(done(out).applied.map((c) => c.rowId)).toEqual([NAME_A]);
    expect(group(A)).toMatchObject({ name: "Apex" });
    // Members and assignments are kept.
    expect(group(A).memberIds).toEqual(["u1", "u2"]);
    expect(group(A).channelId).toBe("c1");
    expect(calls).toEqual([`name:${A}`]);
    const [write] = rowWrites();
    expect(write.update).toEqual({
      $set: {
        "groups.$[g].name": "Apex",
        "groups.$[g].nameSyncPending": true,
      },
    });
    expect(write.options).toEqual({ arrayFilters: [{ "g.key": A }] });
    expect(write.filter).toMatchObject({
      guildId: GUILD,
      state: { $in: ["scheduled", "active"] },
      groups: {
        $elemMatch: { key: A, name: "Alpha", originalName: { $in: [null, ""] } },
      },
    });
    expect(text(out)).toBe('Saved: Name of group 1 is now "Apex".');
  });

  it("counts the save once: the revision moves on before the row is written", async () => {
    await run([entry(NAME_A, "Apex", "Alpha")]);
    expect(store.get(EV)?.liveEditRevision).toBe(1);
  });

  it("a group with no channel yet is saved and left to the channel pass (no Discord call)", async () => {
    const out = await run([entry(NAME_C, "Cobra", "Charlie")]);
    expect(done(out).applied).toHaveLength(1);
    expect(group(C).name).toBe("Cobra");
    expect(calls).toEqual([]);
    // Its pending marker is for the pass once a channel exists: a re-save is
    // "already applied", not a reconcile that spends a save and a revision.
    expect(group(C).nameSyncPending).toBe(true);
    const again = await run([entry(NAME_C, "Cobra", "Charlie")]);
    expect(done(again).alreadyApplied).toEqual([NAME_C]);
    expect(done(again).applied).toEqual([]);
    expect(calls).toEqual([]);
    expect(store.get(EV)?.liveEditRevision).toBe(1);
  });

  describe("reserved names are refused", () => {
    it("a name another group has, whatever the case", async () => {
      const out = await run([entry(NAME_A, "bravo", "Alpha")]);
      expect(out).toMatchObject({ status: "invalid" });
      expect(text(out)).toContain('"bravo" is already used by another group');
      expect(group(A).name).toBe("Alpha");
      expect(rowWrites()).toEqual([]);
      expect(calls).toEqual([]);
    });

    it("the original name another group goes back to when its leader rename is reset", async () => {
      group(B).name = "Bravo Crew";
      group(B).originalName = "Bravo";
      const out = await run([entry(NAME_A, "BRAVO", "Alpha")]);
      expect(out).toMatchObject({ status: "invalid" });
      expect(rowWrites()).toEqual([]);
    });

    it("a name of the group itself, and its own original, are allowed", async () => {
      group(B).name = "Bravo Crew";
      group(B).originalName = "Bravo";
      const out = await run([entry(NAME_B, "Bravo", "Bravo Crew")]);
      expect(done(out).applied).toHaveLength(1);
      expect(group(B).name).toBe("Bravo");
    });

    it("two renames of one save to the same name: the second sees the first and is refused, nothing is overwritten", async () => {
      const out = await run([
        entry(NAME_A, "Zulu", "Alpha"),
        entry(NAME_B, "zulu", "Bravo"),
      ]);
      const result = done(out);
      expect(result.applied.map((c) => c.rowId)).toEqual([NAME_A]);
      expect(result.notApplied).toEqual([
        {
          rowId: NAME_B,
          label: "Name of group 2",
          reason: '"zulu" is now used by another group, so this group was not renamed',
        },
      ]);
      expect(group(A).name).toBe("Zulu");
      expect(group(B).name).toBe("Bravo");
      expect(calls).toEqual([`name:${A}`]);
      expect(describeLiveEditOutcome(out).ok).toBe(false);
    });
  });

  it("checks the form's own rules: empty, too long and control characters are refused with the group named", () => {
    for (const bad of ["", "   ", "x".repeat(51), "a\u0007b"]) {
      const parsed = parseSubmission({
        [`s_${NAME_A}`]: bad,
        [`b_${NAME_A}`]: "Alpha",
      });
      expect(parsed.entries).toEqual([]);
      expect(parsed.errors).toHaveLength(1);
      expect(parsed.errors[0]).toMatch(/^Group 1 name: /);
    }
    const ok = parseSubmission({
      [`s_${NAME_A}`]: "  Apex   Team ",
      [`b_${NAME_A}`]: "Alpha",
    });
    expect(ok.entries).toEqual([
      { rowId: NAME_A, to: "Apex Team", base: "Alpha" },
    ]);
  });

  it("a group that does not exist is refused, a stale form is a conflict", async () => {
    // The form cannot show a group that is not there: the position is refused.
    const missing = await run([entry(groupNameRowId(7), "Nova", "")]);
    expect(missing).toMatchObject({ status: "invalid" });
    expect(text(missing)).toContain("Group 8 does not exist.");
    const stale = await run([entry(NAME_A, "Apex", "Something else")]);
    expect(done(stale).notApplied[0]).toMatchObject({ rowId: NAME_A });
    expect(text(stale)).toContain("was changed by someone else");
    expect(group(A).name).toBe("Alpha");
  });

  describe("the stored original of a host-renamed group", () => {
    it("a group a leader renamed: the host's name is the new original and the original tag is kept", async () => {
      group(A).name = "Crimson";
      group(A).originalName = "Alpha";
      group(A).originalTag = "A";
      group(A).tag = "CRM";
      const out = await run([entry(NAME_A, "Apex", "Crimson")]);
      expect(done(out).applied).toHaveLength(1);
      expect(group(A)).toMatchObject({
        name: "Apex",
        originalName: "Apex",
        originalTag: "A",
        tag: "CRM",
      });
      expect(rowWrites()[0].filter).toMatchObject({
        groups: { $elemMatch: { key: A, name: "Crimson", originalName: "Alpha" } },
      });
    });

    it("a group nobody customised keeps no original (the stored name is the original)", async () => {
      await run([entry(NAME_A, "Apex", "Alpha")]);
      expect("originalName" in group(A)).toBe(false);
      expect("originalTag" in group(A)).toBe(false);
    });
  });

  describe("the rename budget and Discord failures are reported and finished by a pass", () => {
    it("a budget wait: the name is saved, the result says when the channel follows, a re-save finishes it", async () => {
      nameResult = (key) => ({
        groupKey: key,
        status: "limited",
        retryAfterMs: 7 * 60_000 - 1,
      });
      const out = await run([entry(NAME_A, "Apex", "Alpha")]);
      const result = done(out);
      expect(result.applied).toEqual([]);
      expect(result.partial).toHaveLength(1);
      expect(result.partial[0].owed).toContain("about 7 minutes");
      expect(group(A)).toMatchObject({ name: "Apex", nameSyncPending: true });
      const described = describeLiveEditOutcome(out);
      expect(described.ok).toBe(false);
      expect(described.message).toContain(
        'Saved but not finished: Name of group 1 is now "Apex" (the channel is not renamed yet',
      );
      expect(described.details).toMatchObject({
        outcome: "partial",
        stored: [{ row: NAME_A, from: "Alpha", to: "Apex" }],
      });

      // The refreshed form shows the stored name as value and base: it finishes.
      nameResult = (key) => ({ groupKey: key, status: "applied" });
      const again = await run([entry(NAME_A, "Apex", "Apex")]);
      expect(done(again).applied).toMatchObject([
        { rowId: NAME_A, reconcile: true },
      ]);
      expect(text(again)).toBe("Saved: Name of group 1 is finished.");
      expect(calls).toEqual([`name:${A}`, `name:${A}`]);
      expect("nameSyncPending" in group(A)).toBe(false);
      // Now it is settled: the same form is "already applied".
      const settled = await run([entry(NAME_A, "Apex", "Alpha")]);
      expect(done(settled).alreadyApplied).toEqual([NAME_A]);
      expect(calls).toHaveLength(2);
    });

    it("a refusal by Discord (missing permission) is partial with Discord's reason, never lost", async () => {
      nameResult = (key) => ({
        groupKey: key,
        status: "failed",
        reason: "Missing Permissions",
      });
      const out = await run([entry(NAME_A, "Apex", "Alpha")]);
      expect(done(out).partial[0].owed).toContain("(Missing Permissions)");
      expect(group(A).name).toBe("Apex");
    });

    it("an unknown outcome and a thrown error are partial, the name stays saved", async () => {
      nameResult = (key) => ({ groupKey: key, status: "unconfirmed" });
      expect(
        done(await run([entry(NAME_A, "Apex", "Alpha")])).partial,
      ).toHaveLength(1);
      throwInEffects = true;
      const out = await run([entry(NAME_B, "Bold", "Bravo")]);
      expect(done(out).partial).toHaveLength(1);
      expect(group(B).name).toBe("Bold");
    });

    it("without effects wired (no Discord) the name is saved and the channel is owed", async () => {
      configureGroupEditEffects(null);
      const out = await run([entry(NAME_A, "Apex", "Alpha")]);
      expect(done(out).partial[0].owed).toContain("could not be reached");
      expect(group(A).nameSyncPending).toBe(true);
    });

    it("asks whether the event is ending right before the outward call, and does not call Discord then", async () => {
      endAfterRowWrite = true;
      const out = await run([entry(NAME_A, "Apex", "Alpha")]);
      expect(done(out).partial[0].owed).toContain("event is being ended");
      expect(calls).toEqual([]);
      expect(group(A).name).toBe("Apex");
    });

    it("a rename lost to a concurrent change is lost, never reported as saved", async () => {
      let n = 0;
      fake.beforeWrite = () => {
        // The first update is the save's claim; the second is the row's write.
        if (++n === 2) group(A).name = "Taken meanwhile";
      };
      const out = await run([entry(NAME_A, "Apex", "Alpha")]);
      expect(done(out).applied).toEqual([]);
      expect(done(out).notApplied[0].reason).toContain(
        "changed by someone else",
      );
      expect(group(A).name).toBe("Taken meanwhile");
      expect(calls).toEqual([]);
    });
  });
});

describe("change a group's size", () => {
  it("stores the size and a pending marker, then sets the channel's user limit", async () => {
    const out = await run([entry(SIZE_A, 5, 3)]);
    expect(done(out).applied.map((c) => c.rowId)).toEqual([SIZE_A]);
    expect(group(A).size).toBe(5);
    expect(calls).toEqual([`limit:${A}`]);
    expect(rowWrites()[0].update).toEqual({
      $set: {
        "groups.$[g].size": 5,
        "groups.$[g].sizeSyncPending": true,
      },
    });
    expect("sizeSyncPending" in group(A)).toBe(false);
    expect(text(out)).toBe("Saved: Size of group 1 is now 5.");
  });

  it("a group with no size yet (null or missing) can be given one, and one can be removed", async () => {
    delete group(B).size;
    expect(done(await run([entry(SIZE_B, 4, null)])).applied).toHaveLength(1);
    expect(group(B).size).toBe(4);
    expect(done(await run([entry(SIZE_B, null, 4)])).applied).toHaveLength(1);
    expect(group(B).size).toBeNull();
    expect(text(await run([entry(SIZE_B, null, 4)]))).toContain("Nothing to");
  });

  it("checks the form's rule: 1 to 99 or empty", () => {
    for (const bad of ["0", "100", "abc", "1.5", "-2", "1000"]) {
      const parsed = parseSubmission({
        [`s_${SIZE_A}`]: bad,
        [`b_${SIZE_A}`]: "3",
      });
      expect(parsed.entries).toEqual([]);
      expect(parsed.errors[0]).toMatch(/^Group 1 size: a whole number from 1 to 99/);
    }
    expect(
      parseSubmission({ [`s_${SIZE_A}`]: "", [`b_${SIZE_A}`]: "3" }).entries,
    ).toEqual([{ rowId: SIZE_A, to: null, base: 3 }]);
    expect(
      parseSubmission({ [`s_${SIZE_A}`]: "99", [`b_${SIZE_A}`]: "" }).entries,
    ).toEqual([{ rowId: SIZE_A, to: 99, base: null }]);
  });

  describe("lowered below the member count", () => {
    it("keeps every member where they are and writes nothing about members", async () => {
      const out = await run([entry(SIZE_A, 1, 3)]);
      expect(done(out).applied).toHaveLength(1);
      expect(group(A).memberIds).toEqual(["u1", "u2"]);
      const keys = rowWrites().flatMap((w) =>
        Object.keys((w.update.$set ?? {}) as Json),
      );
      expect(keys.sort()).toEqual([
        "groups.$[g].size",
        "groups.$[g].sizeSyncPending",
      ]);
      expect(calls).toEqual([`limit:${A}`]);
    });

    it("the group is over size, derived from members and size, and no flag is stored", async () => {
      await run([entry(SIZE_A, 1, 3)]);
      const stored = group(A);
      expect(isGroupOverSize(stored as never)).toBe(true);
      expect(Object.keys(stored)).not.toContain("overSize");
      expect(Object.keys(stored).some((k) => /over/i.test(k))).toBe(false);
      // Raising it again clears the state without any write to clear it.
      await run([entry(SIZE_A, 2, 1)]);
      expect(isGroupOverSize(group(A) as never)).toBe(false);
    });

    it("stops new joins and assignments to it, and still lets members leave", async () => {
      await run([entry(SIZE_A, 1, 3)]);
      const groups = groupsOf() as never as Parameters<typeof planAssign>[0];
      // Host assign and self-join (both `planAssign`): refused as full.
      expect(planAssign(groups, "u9", A)).toEqual({
        ok: false,
        reason: "full",
      });
      expect(planAssign(groups, "u3", A)).toEqual({
        ok: false,
        reason: "full",
      });
      // Randomise deals nobody into it.
      const dealt = planRandomise(
        groups,
        ["u7", "u8"],
        "unassigned",
        seededRandom(1),
      );
      expect(dealt.ok).toBe(true);
      if (dealt.ok) {
        expect(dealt.placed.map((p) => p.groupKey)).not.toContain(A);
      }
      // Members already in it may leave, nobody is forced out.
      const leave = planAssign(groups, "u1", B);
      expect(leave).toMatchObject({ ok: true, changed: true, toKey: B });
      // And the group stays below nothing: unchanged membership is a no-op.
      expect(planAssign(groups, "u1", A)).toMatchObject({
        ok: true,
        changed: false,
      });
    });
  });

  describe("Discord failures", () => {
    it("a refused or unconfirmed limit is partial, the size stays saved, a re-save finishes it", async () => {
      limitResult = (key) => ({
        groupKey: key,
        status: "failed",
        reason: "Missing Permissions",
      });
      const out = await run([entry(SIZE_A, 5, 3)]);
      expect(done(out).partial[0].owed).toContain(
        "user limit is not changed yet",
      );
      expect(group(A)).toMatchObject({ size: 5, sizeSyncPending: true });
      limitResult = (key) => ({ groupKey: key, status: "applied" });
      const again = await run([entry(SIZE_A, 5, 5)]);
      expect(done(again).applied).toMatchObject([
        { rowId: SIZE_A, reconcile: true },
      ]);
      expect("sizeSyncPending" in group(A)).toBe(false);
    });

    it("a rate limit on the limit is reported with the time left, not slept on", async () => {
      limitResult = (key) => ({
        groupKey: key,
        status: "limited",
        retryAfterMs: 30_000,
      });
      const out = await run([entry(SIZE_A, 5, 3)]);
      expect(done(out).partial[0].owed).toContain("about 30 seconds");
    });

    it("a size lost to a concurrent change is lost", async () => {
      let n = 0;
      fake.beforeWrite = () => {
        if (++n === 2) group(A).size = 9;
      };
      const out = await run([entry(SIZE_A, 5, 3)]);
      expect(done(out).notApplied).toHaveLength(1);
      expect(group(A).size).toBe(9);
      expect(calls).toEqual([]);
    });

    it("a group with no channel is saved without a Discord call, and a re-save is already applied", async () => {
      const out = await run([entry(groupSizeRowId(2), 4, 2)]);
      expect(done(out).applied).toHaveLength(1);
      expect(calls).toEqual([]);
      expect(group(C).sizeSyncPending).toBe(true);
      const again = await run([entry(groupSizeRowId(2), 4, 2)]);
      expect(done(again).alreadyApplied).toEqual([groupSizeRowId(2)]);
      expect(store.get(EV)?.liveEditRevision).toBe(1);
    });
  });
});

const squads = (over: Array<Partial<Json>> = []): Json => ({
  id: "builtin:squads",
  groups: [
    { name: "Squad 1", kind: "team", size: 4, tag: "S1", ...over[0] },
    { name: "Squad 2", kind: "team", size: 4, tag: "S2", ...over[1] },
    { name: "Squad 3", kind: "team", size: 4, tag: "S3", ...over[2] },
  ],
});
const baseOf = (): unknown => readPresetValue(store.get(EV) as never);

/** Run the confirmation round trip: the page, then the confirmed run. */
async function confirmed(
  first: LiveEditOutcome,
  over: { revision?: number } = {},
): Promise<LiveEditOutcome> {
  if (first.status !== "needs-confirmation") {
    throw new Error(`expected a confirmation, got ${first.status}`);
  }
  return runLiveEdit({
    guildId: GUILD,
    eventId: EV,
    deps,
    confirmed: first.changes.map((c) => ({
      rowId: c.rowId,
      from: c.from,
      to: c.to,
      reconcile: c.reconcile,
    })),
    confirmedRevision: over.revision ?? first.revision,
  });
}

describe("switch preset", () => {
  it("asks for confirmation before it overwrites names, and applies nothing until confirmed", async () => {
    const out = await run([entry(GROUP_PRESET_ROW_ID, squads(), baseOf())]);
    expect(out.status).toBe("needs-confirmation");
    if (out.status === "needs-confirmation") {
      expect(out.reasons).toEqual([
        "Switching the preset replaces the names of 3 groups, whoever set them.",
      ]);
    }
    expect(writes).toEqual([]);
    expect(store.get(EV)?.liveEditRevision).toBeUndefined();
    expect(calls).toEqual([]);
  });

  it("applies names, sizes and default tags to the existing groups by position, in ONE write", async () => {
    const out = await confirmed(
      await run([entry(GROUP_PRESET_ROW_ID, squads(), baseOf())]),
    );
    expect(done(out).applied.map((c) => c.rowId)).toEqual([GROUP_PRESET_ROW_ID]);
    expect(groupsOf().map((g) => [g.key, g.name, g.size, g.tag, g.kind])).toEqual([
      [A, "Squad 1", 4, "S1", "team"],
      [B, "Squad 2", 4, "S2", "team"],
      [C, "Squad 3", 4, "S3", "team"],
    ]);
    expect(store.get(EV)?.presetId).toBe("builtin:squads");
    // Members, leaders and channels are untouched.
    expect(group(A).memberIds).toEqual(["u1", "u2"]);
    expect(group(B).channelId).toBe("c2");
    // One conditional write for all groups (atomic), after the save's claim.
    expect(rowWrites()).toHaveLength(1);
    expect(store.get(EV)?.liveEditRevision).toBe(1);
  });

  it("renames the channels that exist and sets their user limits; the group without a channel is left to the pass", async () => {
    await confirmed(await run([entry(GROUP_PRESET_ROW_ID, squads(), baseOf())]));
    expect(calls.sort()).toEqual(
      [`name:${A}`, `name:${B}`, `limit:${A}`, `limit:${B}`].sort(),
    );
    // The group without a channel keeps its pending markers for the pass.
    expect(group(C)).toMatchObject({
      nameSyncPending: true,
      sizeSyncPending: true,
    });
  });

  it("clears a leader's customisation of a switched group: the preset is the new baseline", async () => {
    group(B).name = "Bravo Crew";
    group(B).tag = "BC";
    group(B).originalName = "Bravo";
    group(B).originalTag = "";
    const first = await run([entry(GROUP_PRESET_ROW_ID, squads(), baseOf())]);
    if (first.status === "needs-confirmation") {
      expect(first.reasons[0]).toContain(
        "1 of them was changed by a leader, and that is replaced too.",
      );
    }
    await confirmed(first);
    expect(group(B)).toMatchObject({ name: "Squad 2", tag: "S2" });
    expect("originalName" in group(B)).toBe(false);
    expect("originalTag" in group(B)).toBe(false);
  });

  it("brings the members' nicknames in line when tags are on and the event is active, only for groups whose tag changed", async () => {
    store.set(EV, { ...(store.get(EV) as Json), tagsEnabled: true });
    await confirmed(
      await run([
        entry(
          GROUP_PRESET_ROW_ID,
          squads([{ tag: "A" }, { tag: "S2" }, { tag: "S3" }]),
          baseOf(),
        ),
      ]),
    );
    // Group A's tag is unchanged ("A"); B has a member and a new tag; C has no members.
    expect(retagCalls).toEqual([{ memberIds: ["u3"] }]);
  });

  it("does not touch nicknames when tags are off", async () => {
    await confirmed(await run([entry(GROUP_PRESET_ROW_ID, squads(), baseOf())]));
    expect(retagCalls).toEqual([]);
  });

  it("a switch that renames nothing (only sizes) needs no confirmation", async () => {
    const same = {
      id: "builtin:sizes",
      groups: [
        { name: "Alpha", kind: "team", size: 6, tag: "A" },
        { name: "Bravo", kind: "team", size: 6, tag: "" },
        { name: "Charlie", kind: "team", size: 6, tag: "" },
      ],
    };
    const out = await run([entry(GROUP_PRESET_ROW_ID, same, baseOf())]);
    expect(done(out).applied).toHaveLength(1);
    expect(groupsOf().map((g) => g.size)).toEqual([6, 6, 6]);
    expect(store.get(EV)?.presetId).toBe("builtin:sizes");
  });

  describe("refusals (nothing is written)", () => {
    it("a preset with another number of groups", async () => {
      const two = { id: "builtin:two", groups: (squads().groups as Json[]).slice(0, 2) };
      const out = await run([entry(GROUP_PRESET_ROW_ID, two, baseOf())]);
      expect(out).toMatchObject({ status: "invalid" });
      expect(text(out)).toContain("has 2 groups and this event has 3");
      expect(writes).toEqual([]);
    });

    it("a preset that would change a group's kind", async () => {
      const out = await run([
        entry(
          GROUP_PRESET_ROW_ID,
          squads([{}, { kind: "open" }]),
          baseOf(),
        ),
      ]);
      expect(out).toMatchObject({ status: "invalid" });
      expect(text(out)).toContain("change the kind of group 2 (team to open)");
      expect(writes).toEqual([]);
    });

    it("a preset with the same name twice", async () => {
      const out = await run([
        entry(
          GROUP_PRESET_ROW_ID,
          squads([{}, { name: "squad 1" }]),
          baseOf(),
        ),
      ]);
      expect(out).toMatchObject({ status: "invalid" });
      expect(text(out)).toContain("names must be unique");
      expect(writes).toEqual([]);
    });

    it("an event without groups", async () => {
      store.set(EV, {
        ...(store.get(EV) as Json),
        groupsEnabled: false,
        groups: [],
      });
      const out = await run([
        entry(GROUP_PRESET_ROW_ID, squads(), { id: "", groups: [] }),
      ]);
      expect(out).toMatchObject({ status: "invalid" });
      expect(text(out)).toContain("no groups to apply a preset to");
      expect(writes).toEqual([]);
    });

    it("content that is not a preset value is out of date", () => {
      const row = groupPresetRow;
      for (const bad of [
        "",
        "builtin:squads",
        "{}",
        '{"id":"x","groups":[]}',
        '{"id":"x","groups":[{"name":"","kind":"team","size":null,"tag":""}]}',
        '{"id":"x","groups":[{"name":"A","kind":"nope","size":null,"tag":""}]}',
        '{"id":"x","groups":[{"name":"A","kind":"team","size":100,"tag":""}]}',
        '{"id":"x","groups":[{"name":"A","kind":"team","size":null,"tag":"123456789"}]}',
        `{"id":"x","groups":${JSON.stringify(Array(26).fill({ name: "A", kind: "team", size: null, tag: "" }))}}`,
      ]) {
        expect(row.parse(bad)).toEqual({
          ok: false,
          error: "Switch preset: the form is out of date. Reload the page.",
        });
      }
      expect(
        row.parse(
          '{"id":"p","groups":[{"name":"  A  b ","kind":"open","size":null,"tag":" t "}]}',
        ),
      ).toEqual({
        ok: true,
        value: {
          id: "p",
          groups: [{ name: "A b", kind: "open", size: null, tag: "t" }],
        },
      });
    });
  });

  describe("the confirmation is bound to what was shown", () => {
    it("a group renamed after the page was shown makes the token stale: nothing is applied", async () => {
      const first = await run([entry(GROUP_PRESET_ROW_ID, squads(), baseOf())]);
      group(A).name = "Renamed meanwhile";
      const out = await confirmed(first);
      expect(out.status).toBe("stale");
      expect(rowWrites()).toEqual([]);
      expect(group(A).name).toBe("Renamed meanwhile");
    });

    it("the same change set after a reversal is stale because the revision moved", async () => {
      const first = await run([entry(GROUP_PRESET_ROW_ID, squads(), baseOf())]);
      // Somebody changes a name and changes it back, through a writer that
      // counts the save (the leader customiser does: `$inc` of the revision).
      (store.get(EV) as Json).liveEditRevision = 2;
      const out = await confirmed(first);
      expect(out.status).toBe("stale");
      expect(rowWrites()).toEqual([]);
    });

    it("a confirmed switch cannot be replayed", async () => {
      const first = await run([entry(GROUP_PRESET_ROW_ID, squads(), baseOf())]);
      expect(done(await confirmed(first)).applied).toHaveLength(1);
      expect((await confirmed(first)).status).toBe("stale");
    });

    it("the signed token binds the resolved content: a changed content does not verify", async () => {
      const first = await run([entry(GROUP_PRESET_ROW_ID, squads(), baseOf())]);
      if (first.status !== "needs-confirmation") throw new Error("expected");
      const token = signConfirmation({
        eventId: EV,
        guildId: GUILD,
        userId: "host",
        changes: first.changes.map((c) => ({
          rowId: c.rowId,
          from: c.from,
          to: c.to,
        })),
        revision: first.revision,
      }) as string;
      const ok = verifyConfirmation(token, {
        eventId: EV,
        guildId: GUILD,
        userId: "host",
      });
      expect(ok.ok).toBe(true);
      const [body, mac] = token.split(".");
      const payload = JSON.parse(Buffer.from(body, "base64url").toString());
      payload.c[0].t.groups[0].name = "Evil";
      const forged = `${Buffer.from(JSON.stringify(payload)).toString("base64url")}.${mac}`;
      expect(
        verifyConfirmation(forged, {
          eventId: EV,
          guildId: GUILD,
          userId: "host",
        }),
      ).toEqual({ ok: false, reason: "invalid" });
    });
  });

  describe("Discord failures are reported and finished", () => {
    it("a rename budget wait on one channel is partial for the preset; a re-save finishes only what is owed", async () => {
      nameResult = (key) =>
        key === A
          ? { groupKey: key, status: "limited", retryAfterMs: 5 * 60_000 }
          : { groupKey: key, status: "applied" };
      const first = await run([entry(GROUP_PRESET_ROW_ID, squads(), baseOf())]);
      const out = await confirmed(first);
      const result = done(out);
      expect(result.applied).toEqual([]);
      expect(result.partial).toHaveLength(1);
      expect(result.partial[0].owed).toContain("Group 1: the channel is not renamed yet");
      expect(result.partial[0].owed).toContain("about 5 minutes");
      expect(store.get(EV)?.presetId).toBe("builtin:squads");
      expect(group(A)).toMatchObject({ name: "Squad 1", nameSyncPending: true });

      calls.length = 0;
      nameResult = (key) => ({ groupKey: key, status: "applied" });
      const again = await run([
        entry(GROUP_PRESET_ROW_ID, squads(), baseOf()),
      ]);
      expect(done(again).applied).toMatchObject([
        { rowId: GROUP_PRESET_ROW_ID, reconcile: true },
      ]);
      // Only the group whose rename is still owed is renamed again.
      expect(calls).toEqual([`name:${A}`]);
    });
  });

  it("a name edit and a preset switch in the same save: the preset is lost whole, never half applied", async () => {
    const first = await run([
      entry(NAME_A, "Apex", "Alpha"),
      entry(GROUP_PRESET_ROW_ID, squads(), baseOf()),
    ]);
    const out = await confirmed(first);
    const result = done(out);
    expect(result.applied.map((c) => c.rowId)).toEqual([NAME_A]);
    expect(result.notApplied.map((n) => n.rowId)).toEqual([GROUP_PRESET_ROW_ID]);
    expect(group(B).name).toBe("Bravo");
    expect(store.get(EV)?.presetId).toBeNull();
  });
});

describe("gating and one result per save", () => {
  it("refuses everything while events are off or an end holds the event", async () => {
    enabled = false;
    expect(await run([entry(NAME_A, "Apex", "Alpha")])).toMatchObject({
      status: "refused",
      code: "events-off",
    });
    enabled = null;
    expect(await run([entry(SIZE_A, 5, 3)])).toMatchObject({
      status: "refused",
      code: "events-off",
    });
    enabled = true;
    ending = true;
    expect(await run([entry(NAME_A, "Apex", "Alpha")])).toMatchObject({
      status: "refused",
      code: "ending",
    });
    expect(writes).toEqual([]);
    expect(calls).toEqual([]);
  });

  it("an ended event cannot be edited", async () => {
    store.set(EV, { ...(store.get(EV) as Json), state: "ended" });
    expect(await run([entry(NAME_A, "Apex", "Alpha")])).toMatchObject({
      status: "refused",
      code: "not-open",
    });
  });

  it("a name and a size in one save give one result and one audit-shaped details object", async () => {
    const out = await run([
      entry(NAME_A, "Apex", "Alpha"),
      entry(SIZE_A, 5, 3),
      entry(NAME_B, "Bold", "Bravo"),
    ]);
    const described = describeLiveEditOutcome(out);
    expect(described.ok).toBe(true);
    expect(described.message).toBe(
      'Saved: Name of group 1 is now "Apex"; Name of group 2 is now "Bold"; Size of group 1 is now 5.',
    );
    expect(described.details).toMatchObject({
      outcome: "applied",
      changes: [
        { row: NAME_A, from: "Alpha", to: "Apex" },
        { row: NAME_B, from: "Bravo", to: "Bold" },
        { row: SIZE_A, from: 3, to: 5 },
      ],
    });
    // One claim for the whole save.
    expect(store.get(EV)?.liveEditRevision).toBe(1);
  });

  it("saving the same form again converges: already applied, nothing written", async () => {
    const entries = [
      entry(NAME_A, "Apex", "Alpha"),
      entry(SIZE_A, 5, 3),
    ];
    await run(entries);
    writes.length = 0;
    const again = await run(entries);
    expect(done(again).alreadyApplied.sort()).toEqual([NAME_A, SIZE_A].sort());
    expect(writes).toEqual([]);
    expect(clone(store.get(EV)?.liveEditRevision)).toBe(1);
  });
});

describe("the group limit cap and the size of a confirmation", () => {
  it("name rows and the preset validate the edited setup, so an unreadable group cap fails them closed; size rows do not need the cap", async () => {
    const unreadable: LiveEditDeps = { ...deps, maxGroups: async () => null };
    const run2 = (entries: Array<{ rowId: string; to: unknown; base: unknown }>) =>
      runLiveEdit({
        guildId: GUILD,
        eventId: EV,
        deps: unreadable,
        submission: entries as never,
      });
    const rename = await run2([entry(NAME_A, "Apex", "Alpha")]);
    expect(rename).toMatchObject({ status: "invalid" });
    expect(text(rename)).toContain("The group limit could not be read");
    const preset = await run2([
      entry(GROUP_PRESET_ROW_ID, squads(), baseOf()),
    ]);
    expect(preset).toMatchObject({ status: "invalid" });
    expect(group(A).name).toBe("Alpha");
    // A size is checked by its own rule only: it saves.
    const size = await run2([entry(SIZE_A, 5, 3)]);
    expect(done(size).applied).toHaveLength(1);
  });

  it("a signed confirmation of a preset switch of 25 groups with the longest names and tags still verifies", () => {
    // Worst case for the token: 25 groups, 50-character names and 8-character
    // tags of 3-byte characters, in both the stored (from) and chosen (to) value.
    const groups = Array.from({ length: 25 }, (_, i) => ({
      name: `${String.fromCharCode(0x4e00 + i)}`.repeat(50),
      kind: "team",
      size: 99,
      tag: "\u6f22".repeat(8),
    }));
    const other = groups.map((g, i) => ({
      ...g,
      name: `${String.fromCharCode(0x4f00 + i)}`.repeat(50),
    }));
    const token = signConfirmation({
      eventId: EV,
      guildId: GUILD,
      userId: "111111111111111111",
      changes: [
        {
          rowId: GROUP_PRESET_ROW_ID,
          from: { id: "lib:65a000000000000000000001", groups },
          to: { id: "lib:65a000000000000000000002", groups: other },
        },
      ],
      revision: 12345,
    }) as string;
    expect(token.length).toBeLessThan(16_384);
    expect(
      verifyConfirmation(token, {
        eventId: EV,
        guildId: GUILD,
        userId: "111111111111111111",
      }).ok,
    ).toBe(true);
  });
});

describe("an end or cancel that takes its hold during the rename's own read", () => {
  it("is asked again right before the write: nothing is saved and Discord is not called", async () => {
    let finds = 0;
    fake.afterFind = () => {
      // The first read is the core's; the second is the rename's own.
      if (++finds === 2) ending = true;
    };
    const out = await run([entry(NAME_A, "Apex", "Alpha")]);
    const result = done(out);
    expect(result.applied).toEqual([]);
    expect(result.notApplied).toEqual([
      {
        rowId: NAME_A,
        label: "Name of group 1",
        reason: "was not saved because the event is being ended",
      },
    ]);
    expect(group(A).name).toBe("Alpha");
    expect(rowWrites()).toEqual([]);
    expect(calls).toEqual([]);
  });
});

describe("the audit row of a preset switch keeps the names, sizes and tags", () => {
  it("survives the audit bound as flat strings, for the confirmation and for the applied save", async () => {
    const first = await run([entry(GROUP_PRESET_ROW_ID, squads(), baseOf())]);
    const asked = boundAuditEntry({
      action: "event.host.settings",
      result: "success",
      details: describeLiveEditOutcome(first).details,
    });
    const change = (
      (asked.details as { changes: Array<Record<string, unknown>> }).changes
    )[0];
    expect(change).toEqual({
      row: "groupPreset",
      from: {
        id: "",
        g1: "Alpha | team | size 3 | tag A",
        g2: "Bravo | team | no limit | no tag",
        g3: "Charlie | team | size 2 | no tag",
      },
      to: {
        id: "builtin:squads",
        g1: "Squad 1 | team | size 4 | tag S1",
        g2: "Squad 2 | team | size 4 | tag S2",
        g3: "Squad 3 | team | size 4 | tag S3",
      },
    });
    const applied = boundAuditEntry({
      action: "event.host.settings-confirm",
      result: "success",
      details: describeLiveEditOutcome(await confirmed(first)).details,
    });
    const after = (
      (applied.details as { changes: Array<{ to: Record<string, string> }> })
        .changes
    )[0];
    expect(after.to.g1).toBe("Squad 1 | team | size 4 | tag S1");
    expect(JSON.stringify(applied.details)).not.toContain("[truncated]");
  });
});

describe("a preset switch finishes and reports channel work still owed", () => {
  it("a rename the budget held back is retried by a switch that only changes sizes, and the result is partial while it stays held", async () => {
    nameResult = (key) => ({
      groupKey: key,
      status: "limited",
      retryAfterMs: 5 * 60_000,
    });
    await run([entry(NAME_A, "Apex", "Alpha")]);
    expect(group(A)).toMatchObject({ name: "Apex", nameSyncPending: true });
    calls.length = 0;
    const sizesOnly = {
      id: "builtin:sizes",
      groups: [
        { name: "Apex", kind: "team", size: 8, tag: "A" },
        { name: "Bravo", kind: "team", size: null, tag: "" },
        { name: "Charlie", kind: "team", size: 2, tag: "" },
      ],
    };
    const out = done(
      await run([entry(GROUP_PRESET_ROW_ID, sizesOnly, baseOf())]),
    );
    expect(out.applied).toEqual([]);
    expect(out.partial).toHaveLength(1);
    expect(out.partial[0].owed).toContain("Group 1: the channel is not renamed yet");
    expect(calls.sort()).toEqual([`limit:${A}`, `name:${A}`].sort());
    expect(group(A)).toMatchObject({ size: 8, nameSyncPending: true });
  });

  it("also for a group whose values the preset leaves as they are", async () => {
    nameResult = (key) => ({
      groupKey: key,
      status: "limited",
      retryAfterMs: 60_000,
    });
    await run([entry(NAME_A, "Apex", "Alpha")]);
    calls.length = 0;
    const same = {
      id: "builtin:same",
      groups: [
        { name: "Apex", kind: "team", size: 3, tag: "A" },
        { name: "Bravo", kind: "team", size: null, tag: "" },
        { name: "Charlie", kind: "team", size: 2, tag: "" },
      ],
    };
    const out = done(await run([entry(GROUP_PRESET_ROW_ID, same, baseOf())]));
    expect(out.partial).toHaveLength(1);
    expect(calls).toEqual([`name:${A}`]);
    // Once the budget is back the same switch is applied and finishes it.
    nameResult = (key) => ({ groupKey: key, status: "applied" });
    const again = done(await run([entry(GROUP_PRESET_ROW_ID, same, baseOf())]));
    expect(again.applied).toHaveLength(1);
    expect("nameSyncPending" in group(A)).toBe(false);
  });
});
