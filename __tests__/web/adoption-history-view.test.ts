import { describe, it, expect } from "@jest/globals";
import {
  renderAdoptionHistoryPage,
  renderRestoreConfirmPage,
} from "../../src/web/adoption-history-view.js";
import { renderWizardPage } from "../../src/web/admin-views.js";

const base = { csrfToken: "tok", remainingMs: 1000 };
const snap = (over: Record<string, unknown> = {}) => ({
  id: "c".repeat(24),
  planId: "p",
  appliedBy: "<admin>",
  status: "applied" as const,
  createdAt: new Date("2026-10-01T10:00:00Z"),
  rolledBackBy: null,
  rolledBackAt: null,
  applied: 2,
  failed: 1,
  skipped: 0,
  destructive: 1,
  createdRoles: 2,
  ...over,
});

describe("adoption history page", () => {
  it("escapes values and offers Restore only where a rollback can run", () => {
    const html = renderAdoptionHistoryPage({
      ...base,
      snapshots: [
        snap(),
        snap({ id: "d".repeat(24), status: "rolled_back", rolledBackBy: "x" }),
        snap({ id: "e".repeat(24), status: "applying" }),
      ],
    });
    expect(html).not.toContain("<admin>");
    expect(html).toContain("&lt;admin&gt;");
    expect(html).toContain(`/admin/adopt/history/${"c".repeat(24)}/restore`);
    expect(html).not.toContain(`/${"d".repeat(24)}/restore`);
    expect(html).not.toContain(`/${"e".repeat(24)}/restore`);
    expect(html).toContain("Already restored");
    expect(html).toContain("In progress");
  });

  it("links to older and newer pages so no retained snapshot is unreachable", () => {
    const html = renderAdoptionHistoryPage({
      ...base,
      snapshots: [snap()],
      page: 2,
      hasMore: true,
    });
    expect(html).toContain("/admin/adopt/history?page=1");
    expect(html).toContain("/admin/adopt/history?page=3");
    expect(
      renderAdoptionHistoryPage({ ...base, snapshots: [snap()] }),
    ).not.toContain("?page=");
  });

  it("explains an empty history and a failed read", () => {
    expect(renderAdoptionHistoryPage({ ...base, snapshots: [] })).toContain(
      "Nothing has been applied yet",
    );
    expect(renderAdoptionHistoryPage({ ...base, snapshots: null })).toContain(
      "couldn't be read",
    );
  });

  it("polls a started restore", () => {
    const html = renderAdoptionHistoryPage({
      ...base,
      snapshots: [],
      jobId: "11111111-1111-1111-1111-111111111111",
    });
    expect(html).toContain("ah-job");
    expect(html).toContain("/admin/adopt/history/job/");
  });
});

describe("restore confirm page", () => {
  const detail = (over: Record<string, unknown> = {}) => ({
    ...snap(),
    operations: [{ summary: "Delete #old", destructive: true }],
    interrupted: 0,
    revertibleCreatedRoles: 2,
    ...over,
  });

  it("lists applied steps, states the destructive limits and leaves role deletion unticked", () => {
    const html = renderRestoreConfirmPage({
      ...base,
      snapshot: detail(),
      destructiveNote: "Messages cannot be restored.",
    });
    expect(html).toContain("Delete #old");
    expect(html).toContain("Messages cannot be restored.");
    expect(html).toContain('name="deleteCreatedRoles"');
    expect(html).not.toMatch(/deleteCreatedRoles"[^>]*checked/);
    expect(html).toContain('name="_csrf" value="tok"');
  });

  it("hides the role option when an earlier restore already spent every role creation", () => {
    const html = renderRestoreConfirmPage({
      ...base,
      snapshot: detail({ createdRoles: 2, revertibleCreatedRoles: 0 }),
      destructiveNote: "n",
    });
    expect(html).not.toContain("deleteCreatedRoles");
  });

  it("counts only reachable roles in the option and tells the admin about interrupted steps", () => {
    const html = renderRestoreConfirmPage({
      ...base,
      snapshot: detail({
        createdRoles: 5,
        revertibleCreatedRoles: 1,
        interrupted: 3,
      }),
      destructiveNote: "n",
    });
    expect(html).toContain("delete the 1 role(s)");
    expect(html).toContain("3 more step(s) were interrupted");
    expect(
      renderRestoreConfirmPage({
        ...base,
        snapshot: detail(),
        destructiveNote: "n",
      }),
    ).not.toContain("interrupted");
  });

  it("omits the note and the role option when they don't apply, and blocks a finished snapshot", () => {
    const html = renderRestoreConfirmPage({
      ...base,
      snapshot: detail({
        destructive: 0,
        createdRoles: 0,
        revertibleCreatedRoles: 0,
        status: "rolled_back",
      }),
      destructiveNote: "NOTE",
    });
    expect(html).not.toContain("NOTE");
    expect(html).not.toContain("deleteCreatedRoles");
    expect(html).not.toContain("Restore this snapshot");
  });
});

describe("wizard adoption entry", () => {
  it("links the adoption flow and tells a fresh server it can skip it", () => {
    const html = renderWizardPage({
      ...base,
      featureOrder: ["quotes"],
      featureStatus: {},
    } as never);
    expect(html).toContain("Adopting an existing server?");
    for (const href of [
      "/admin/adopt",
      "/admin/role-groups",
      "/admin/rules",
      "/admin/adopt/claims",
      "/admin/adopt/history",
    ]) {
      expect(html).toContain(`href="${href}"`);
    }
    expect(html).toContain("fresh server");
  });
});
