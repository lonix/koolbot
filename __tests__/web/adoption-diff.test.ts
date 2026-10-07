import { describe, it, expect } from "@jest/globals";
import { renderAdoptionDiff } from "../../src/web/adoption-diff.js";
import type { AdoptionPlan } from "../../src/services/server-adoption-planner.js";

const base: AdoptionPlan = {
  id: "abc123",
  guildId: "g1",
  operations: [],
  warnings: [],
  errors: [],
  baseline: { roles: [], channels: [], config: {} },
};

describe("renderAdoptionDiff", () => {
  it("says so when there is nothing to change", () => {
    expect(renderAdoptionDiff(base)).toContain("Nothing to change");
  });

  it("renders before → after with readable permissions", () => {
    const html = renderAdoptionDiff({
      ...base,
      operations: [
        {
          id: "op-1",
          type: "overwrite.set",
          class: "additive",
          channelId: "c",
          overwriteTargetId: "r",
          overwriteTargetType: "role",
          allow: "1024",
          deny: "0",
          summary: 'Edit overwrite on "chat"',
          targetId: "c",
          before: { allow: "0", deny: "1024" },
          after: { allow: "1024", deny: "0" },
        },
      ],
    });
    expect(html).toContain("ViewChannel");
    expect(html).toContain("tag-on");
    expect(html).toContain("op-1");
  });

  it("shows blockers and warnings and marks destructive steps", () => {
    const html = renderAdoptionDiff({
      ...base,
      errors: [{ code: "admin-access-lost", message: "No access" }],
      warnings: [{ code: "w", message: "Careful" }],
      operations: [
        {
          id: "op-1",
          type: "channel.delete",
          class: "destructive",
          channelId: "c",
          approval: {
            kind: "channel.delete",
            targetId: "c",
            approvedBy: "u1",
            approvedAt: "2026-10-01T10:00:00Z",
          },
          summary: 'Delete text "old"',
          targetId: "c",
          before: { name: "old" },
          after: null,
        },
      ],
    });
    expect(html).toContain("Blocking errors (1)");
    expect(html).toContain("Warnings (1)");
    expect(html).toContain("adoption-destructive");
    expect(html).toContain("Approved by");
    expect(html).toContain("can't be restored");
  });

  it("summarises member operations as a count with a sample", () => {
    const html = renderAdoptionDiff({
      ...base,
      operations: [
        {
          id: "op-1",
          type: "member.role.add",
          class: "additive",
          roleId: "r",
          memberCount: 4000,
          sample: ["a", "b"],
          memberIds: [],
          summary: "Grant a role to 4000 member(s)",
          targetId: "r",
          before: null,
          after: { members: 4000 },
        },
      ],
    });
    expect(html).toContain("4000 member(s); sample");
  });

  it("escapes every dynamic value", () => {
    const html = renderAdoptionDiff({
      ...base,
      errors: [{ code: "x", message: "<script>alert(1)</script>" }],
      operations: [
        {
          id: "op-1",
          type: "config.set",
          class: "additive",
          key: "k",
          value: "v",
          previous: null,
          summary: "<img src=x onerror=alert(1)>",
          targetId: "k",
          before: null,
          after: { value: "<b>" },
        },
      ],
    });
    expect(html).not.toContain("<script>");
    expect(html).not.toContain("<img");
    expect(html).toContain("&lt;b&gt;");
  });
});
