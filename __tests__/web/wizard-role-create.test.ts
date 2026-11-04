/**
 * The Access step's role creation, without HTTP (#1618): what the form is split
 * into, how names are resolved against the live roles, the placeholders Review
 * and Apply map, and the Review plan.
 */

import { describe, it, expect, jest } from "@jest/globals";

jest.unstable_mockModule("../../src/utils/logger.js", () => ({
  isDebugMode: () => false,
  default: {
    info: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
    debug: jest.fn(),
  },
}));
type Answer = { ok: true } | { ok: false; reason: string } | { ok: "unknown" };
let answer: Answer = { ok: true };
jest.unstable_mockModule("../../src/services/bot-create-check.js", () => ({
  canBotCreate: async (): Promise<Answer> => answer,
  toPickerCreate: jest.fn(),
}));
jest.unstable_mockModule("../../src/models/adoption-snapshot.js", () => ({
  ADOPTION_STALE_AFTER_MS: 30 * 60 * 1000,
  AdoptionSnapshot: { exists: async (): Promise<null> => null },
}));

const m = await import("../../src/web/wizard-role-create.js");
const { coerceConfigValue } =
  await import("../../src/web/routes/write/helpers.js");
const { WizardService } = await import("../../src/services/wizard-service.js");

const roles = [
  { id: "1", name: "@everyone" },
  { id: "2", name: "Moderator" },
];
const none = { admin: [], staff: [], host: [] };

describe("splitPicks", () => {
  it("takes create values out of the picks, whatever else is posted beside them", () => {
    const r = m.splitPicks({
      admin: undefined,
      staff: ["create:Crew", "2", "not-an-id"],
      host: "create:Hosts",
    });
    expect(r.ids).toEqual({ admin: [], staff: ["2"], host: [] });
    expect(r.named).toEqual([
      { scope: "staff", name: "Crew" },
      { scope: "host", name: "Hosts" },
    ]);
    expect(r.errors).toEqual([]);
  });

  it("reports a blank or over-long name once, and never turns it into a pick", () => {
    const r = m.splitPicks({
      admin: ["create:  ", "create:   "],
      staff: [`create:${"x".repeat(101)}`],
      host: [],
    });
    expect(r.named).toEqual([]);
    expect(r.ids).toEqual(none);
    expect(r.errors).toEqual([
      "The name cannot be blank.",
      "The name can be at most 100 characters.",
    ]);
  });
});

describe("resolvePicks", () => {
  const picks = (
    named: Array<{ scope: "admin" | "staff" | "host"; name: string }>,
    ids = none,
  ) => ({ ids, named, errors: [] });

  it("de-duplicates a name across scopes and cases into one role at the higher scope", () => {
    const r = m.resolvePicks(
      picks([
        { scope: "staff", name: "Crew" },
        { scope: "admin", name: "crew" },
        { scope: "host", name: "CREW " },
      ]),
      roles,
    );
    expect(r).toEqual({
      ok: true,
      selection: none,
      creations: [{ name: "Crew", scopes: ["admin"] }],
      matches: [],
    });
  });

  it("keeps staff and host both for a role typed under the two", () => {
    const r = m.resolvePicks(
      picks([
        { scope: "staff", name: "Crew" },
        { scope: "host", name: "Crew" },
      ]),
      roles,
    );
    expect(r).toMatchObject({
      ok: true,
      creations: [{ name: "Crew", scopes: ["staff", "host"] }],
    });
  });

  it("selects the existing role instead of creating one when the name matches", () => {
    const r = m.resolvePicks(
      picks([{ scope: "host", name: "moderator" }], {
        ...none,
        staff: ["2"],
      }),
      roles,
    );
    expect(r).toEqual({
      ok: true,
      selection: { admin: [], staff: ["2"], host: ["2"] },
      creations: [],
      matches: [{ id: "2", name: "Moderator", scopes: ["host"] }],
    });
  });

  it("reports a name that matched an existing role, so Review can say so, and never matches a look-alike", () => {
    const r = m.resolvePicks(
      picks([
        { scope: "admin", name: "  mODERATOR " },
        { scope: "staff", name: "M\u043Ederator" },
      ]),
      roles,
    );
    expect(r).toMatchObject({
      ok: true,
      matches: [{ id: "2", name: "Moderator", scopes: ["admin"] }],
      creations: [{ name: "M\u043Ederator", scopes: ["staff"] }],
    });
  });

  it("refuses a name two roles share", () => {
    const r = m.resolvePicks(picks([{ scope: "host", name: "Moderator" }]), [
      ...roles,
      { id: "3", name: "moderator" },
    ]);
    expect(r.ok).toBe(false);
  });
});

describe("placeholders", () => {
  const creations = [{ name: "Crew", scopes: ["staff" as const] }];

  it("stands a non-snowflake id in for a role that does not exist yet, in the picks and in the roles", () => {
    expect(m.placeholderId("Crew")).toBe("new:crew");
    expect(m.placeholderId("  CREW ")).toBe("new:crew");
    const sel = m.selectionWithNew({ ...none, staff: ["2"] }, creations);
    expect(sel.staff).toEqual(["2", "new:crew"]);
    const ctx = m.contextWithNew({ roles: [], groups: [] } as never, creations);
    expect(ctx.roles).toEqual([
      { id: "new:crew", name: "Crew", managed: false, position: 0 },
    ]);
  });

  it("lists a role at Admins only once, since Admins implies the rest", () => {
    const sel = m.selectionWithNew(none, [
      { name: "Crew", scopes: ["admin", "staff"] },
    ]);
    expect(sel).toEqual({ admin: ["new:crew"], staff: [], host: [] });
  });

  it("swaps each placeholder for the id Discord gave", () => {
    const sel = m.swapPlaceholders(
      { admin: [], staff: ["2", "new:crew"], host: [] },
      new Map([["new:crew", "900"]]),
    );
    expect(sel.staff).toEqual(["2", "900"]);
  });

  it("names the names to draw per scope", () => {
    const two = [
      { name: "A", scopes: ["admin" as const] },
      { name: "B", scopes: ["staff" as const, "host" as const] },
    ];
    expect(m.pendingNames(two)).toEqual({
      admin: ["A"],
      staff: ["B"],
      host: ["B"],
    });
  });
});

describe("reviewWizardRoles", () => {
  const ctx = {
    roles: roles.map((r) => ({ ...r, managed: false, position: 1 })),
  };
  const crew = [{ name: "Crew", scopes: ["staff" as const] }];
  const review = (c = crew) =>
    m.reviewWizardRoles({} as never, "g", ctx as never, c);

  it("shows nothing for no roles, and asks nothing of Discord", async () => {
    expect(await review([])).toEqual({ roles: [], planId: null, problems: [] });
  });

  it("plans each role and gives the plan id Apply must reproduce", async () => {
    answer = { ok: true };
    const r = await review();
    expect(r.problems).toEqual([]);
    expect(r.roles).toEqual([{ name: "Crew", scopes: ["staff"] }]);
    expect(r.planId).toMatch(/^[0-9a-f]{16}$/);
  });

  it("blocks with the reason when the bot cannot create, and when that is unreadable", async () => {
    answer = { ok: false, reason: "Needs Manage Roles." };
    expect((await review()).problems).toEqual(["Needs Manage Roles."]);
    answer = { ok: "unknown" };
    const r = await review();
    expect(r.problems[0]).toContain("could not check");
    expect(r.roles).toEqual([]);
  });

  it("blocks when a role of that name exists now", async () => {
    answer = { ok: true };
    const r = await review([{ name: "moderator", scopes: ["staff"] }]);
    expect(r.problems[0]).toContain("exists now");
    expect(r.planId).toBeNull();
  });
});

describe("a create value that nothing offers", () => {
  it("is refused by the settings coercion for a role setting, so it is never stored as a value", () => {
    expect(coerceConfigValue("birthdays.role_id", "create:Crew")).toMatchObject(
      { ok: false },
    );
  });
});

describe("WizardService.setAccess", () => {
  it("keeps the role creations beside the picks, and clears them with the picks", () => {
    const service = WizardService.getInstance();
    service.createSession("u-1618", "g-1618", ["quotes"]);
    service.setAccess("u-1618", "g-1618", none, [
      { name: "Crew", scopes: ["staff"] },
    ]);
    const state = service.getSession("u-1618", "g-1618");
    expect(state?.access).toEqual(none);
    expect(state?.roleCreations).toEqual([{ name: "Crew", scopes: ["staff"] }]);
    service.setAccess("u-1618", "g-1618", undefined, [
      { name: "Crew", scopes: ["staff"] },
    ]);
    expect(service.getSession("u-1618", "g-1618")?.roleCreations).toEqual([]);
    service.endSession("u-1618", "g-1618");
  });
});
