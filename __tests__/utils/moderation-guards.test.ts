import { describe, it, expect } from "@jest/globals";
import {
  MAX_MESSAGE_DELETE_DAYS,
  MAX_REASON_LENGTH,
  MAX_TIMEOUT_MINUTES,
  checkHierarchy,
  formatAuditReason,
} from "../../src/utils/moderation-guards.js";

function member(
  id: string,
  position: number,
  capabilities: { bannable?: boolean; moderatable?: boolean } = {},
): never {
  return {
    id,
    user: { tag: `${id}#0001` },
    roles: { highest: { position } },
    bannable: capabilities.bannable ?? true,
    moderatable: capabilities.moderatable ?? true,
  } as never;
}

const guild = { id: "g1", ownerId: "owner" } as never;

describe("formatAuditReason", () => {
  // Bot-issued actions record KoolBot as the audit-log executor, so the
  // moderator only survives in Discord's own record via the reason.
  it("prefixes the reason with the moderator", () => {
    expect(formatAuditReason("mod#0001", "spamming")).toBe(
      "mod#0001: spamming",
    );
  });

  it("keeps the result inside Discord's audit-reason cap", () => {
    const reason = "x".repeat(MAX_REASON_LENGTH);
    const formatted = formatAuditReason("mod#0001", reason);
    expect(formatted.length).toBe(MAX_REASON_LENGTH);
    expect(formatted.startsWith("mod#0001: ")).toBe(true);
  });
});

describe("limits", () => {
  it("matches Discord's own caps", () => {
    expect(MAX_REASON_LENGTH).toBe(512);
    expect(MAX_MESSAGE_DELETE_DAYS).toBe(7);
    expect(MAX_TIMEOUT_MINUTES).toBe(40320); // 28 days
  });
});

describe("checkHierarchy", () => {
  const base = { guild, verb: "ban", capability: "bannable" } as const;

  it("allows acting on a member below the moderator", () => {
    expect(
      checkHierarchy({
        ...base,
        invoker: member("mod", 5),
        targetMember: member("target", 2),
      }),
    ).toBeNull();
  });

  // A ban may target someone who already left: there is no role to compare
  // and Discord itself accepts a ban by user id.
  it("allows a target who is not in the guild", () => {
    expect(
      checkHierarchy({
        ...base,
        invoker: member("mod", 5),
        targetMember: null,
      }),
    ).toBeNull();
  });

  it("refuses the server owner", () => {
    expect(
      checkHierarchy({
        ...base,
        invoker: member("mod", 9),
        targetMember: member("owner", 1),
      }),
    ).toBe("You can't ban the server owner.");
  });

  // Discord enforces this natively; routed through the bot the executor is
  // KoolBot, so only the bot's position would otherwise be checked.
  it.each([
    ["equal to", 5],
    ["above", 8],
  ])(
    "refuses a target whose highest role is %s the moderator's",
    (_label, position) => {
      expect(
        checkHierarchy({
          ...base,
          invoker: member("mod", 5),
          targetMember: member("target", position),
        }),
      ).toContain("their highest role is not below yours");
    },
  );

  it("lets the guild owner act on anyone below them", () => {
    expect(
      checkHierarchy({
        ...base,
        invoker: member("owner", 1),
        targetMember: member("target", 9),
      }),
    ).toBeNull();
  });

  it("explains when the bot itself cannot act on the target", () => {
    const refusal = checkHierarchy({
      ...base,
      invoker: member("mod", 9),
      targetMember: member("target", 2, { bannable: false }),
    });
    expect(refusal).toContain("my own role must be above theirs");
  });

  it("checks the moderatable capability for timeouts", () => {
    expect(
      checkHierarchy({
        guild,
        verb: "time out",
        capability: "moderatable",
        invoker: member("mod", 9),
        targetMember: member("target", 2, { moderatable: false }),
      }),
    ).toContain("I can't time out");
  });
});
