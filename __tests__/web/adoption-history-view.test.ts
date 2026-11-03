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
    uncertainCreatedRoles: 0,
    dependentRepairs: 0,
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

  it("offers deleting an interrupted role creation, worded as conditional on finding the role", () => {
    const html = renderRestoreConfirmPage({
      ...base,
      snapshot: detail({
        createdRoles: 1,
        revertibleCreatedRoles: 0,
        uncertainCreatedRoles: 1,
        interrupted: 1,
      }),
      destructiveNote: "n",
    });
    expect(html).toContain('name="deleteCreatedRoles"');
    expect(html).toContain("delete the 1 role(s)");
    expect(html).toContain("only if the restore finds the role");
  });

  it("reports pending follow-up repairs even when no plan step remains", () => {
    const html = renderRestoreConfirmPage({
      ...base,
      snapshot: detail({
        operations: [],
        revertibleCreatedRoles: 0,
        dependentRepairs: 3,
        status: "rollback_partial",
      }),
      destructiveNote: "n",
    });
    expect(html).toContain("3 follow-up repair(s)");
    expect(html).toContain("Restore this snapshot");
    expect(
      renderRestoreConfirmPage({
        ...base,
        snapshot: detail(),
        destructiveNote: "n",
      }),
    ).not.toContain("follow-up repair");
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

/** The page's own markup, without the shared layout around it. */
const mainOf = (html: string): string =>
  html.slice(html.indexOf("<main"), html.indexOf("</main>"));

/** Every class token in the markup that is not a kb- class, and every bare table. */
const nonKbClasses = (html: string): string[] => [
  ...[...html.matchAll(/class="([^"]*)"/g)]
    .flatMap((m) => m[1].split(/\s+/))
    .filter((t) => t && !t.startsWith("kb-")),
  ...[...html.matchAll(/<table(?![^>]*class="kb-table")/g)].map((m) => m[0]),
];

describe("adoption history on the kb- components (#1733)", () => {
  const detail = (over: Record<string, unknown> = {}) => ({
    ...snap(),
    operations: [
      { summary: "Delete #old", destructive: true },
      { summary: "Make #news read-only", destructive: false },
    ],
    interrupted: 1,
    uncertainCreatedRoles: 1,
    dependentRepairs: 2,
    revertibleCreatedRoles: 1,
    ...over,
  });
  const states: Record<string, string> = {
    list: renderAdoptionHistoryPage({
      ...base,
      snapshots: [
        snap(),
        snap({ id: "d".repeat(24), status: "rolled_back", rolledBackBy: "x" }),
        snap({ id: "e".repeat(24), status: "applying" }),
      ],
      page: 2,
      hasMore: true,
      jobId: "11111111-1111-1111-1111-111111111111",
      flash: { type: "ok", text: "Done." },
    }),
    empty: renderAdoptionHistoryPage({ ...base, snapshots: [] }),
    "no older": renderAdoptionHistoryPage({
      ...base,
      snapshots: [],
      page: 3,
    }),
    unreadable: renderAdoptionHistoryPage({ ...base, snapshots: null }),
    restore: renderRestoreConfirmPage({
      ...base,
      snapshot: detail(),
      destructiveNote: "Messages cannot be restored.",
    }),
    "restore, nothing left": renderRestoreConfirmPage({
      ...base,
      snapshot: detail({ operations: [], interrupted: 0, dependentRepairs: 0 }),
      destructiveNote: "n",
    }),
    "not restorable": renderRestoreConfirmPage({
      ...base,
      snapshot: detail({ status: "rolled_back" }),
      destructiveNote: "n",
    }),
  };

  it.each(Object.keys(states))("%s renders only kb- classes", (name) => {
    expect(nonKbClasses(mainOf(states[name]))).toEqual([]);
  });

  it("leads the list with the verdict on the first page only", () => {
    const first = renderAdoptionHistoryPage({
      ...base,
      snapshots: [snap({ status: "partial" })],
    });
    expect(first).toContain("The latest apply was only partly applied");
    expect(first).toContain("kb-callout--warn");
    expect(states.list).not.toContain("The latest apply");
    expect(states.empty).not.toContain("The latest apply");
  });

  it.each([
    ["applied", "The latest apply is in place", "plain"],
    ["applying", "The latest apply is still running", "plain"],
    ["partial", "The latest apply was only partly applied", "warn"],
    ["rolling_back", "The latest apply is being restored", "plain"],
    ["rollback_partial", "The latest apply was only partly restored", "warn"],
    ["rolled_back", "The latest apply has been restored", "plain"],
  ])("states the verdict for %s", (status, title, tone) => {
    const html = mainOf(
      renderAdoptionHistoryPage({ ...base, snapshots: [snap({ status })] }),
    );
    expect(html).toContain(`<p class="kb-callout__title">${title}</p>`);
    expect(html.includes("kb-callout kb-callout--warn")).toBe(tone === "warn");
  });

  it("has one footer in the list panel, with the pager and the retention note", () => {
    const html = mainOf(states.list);
    expect(html.match(/kb-panel__foot/g)).toHaveLength(1);
    expect(html).toContain("adoption.snapshot.retention_days");
    expect(html).toContain("?page=3");
  });

  it("keeps the job line live and the restore link marked for the dialog", () => {
    expect(states.list).toMatch(/id="ah-job"/);
    expect(states.list).toContain('data-confirm-link="snapshot-restore"');
    expect(states.list).toContain("kb-table");
  });

  it("keeps every marker the dialog upgrade reads and styles the restore as danger", () => {
    const html = states.restore;
    expect(html).toContain('data-confirm-link-page="snapshot-restore"');
    expect(html).toContain("data-confirm-form");
    expect(html).toContain('data-confirm-title="Restore this snapshot?"');
    expect(html).toContain('type="hidden" name="_csrf" value="tok"');
    expect(html).toMatch(
      /<button type="submit" class="kb-btn kb-btn--danger">Restore this snapshot<\/button>/,
    );
    expect(html).toContain("kb-panel--danger");
    expect(html.match(/data-confirm-item/g)?.length).toBeGreaterThanOrEqual(5);
    // The option is a checkbox inside ONE label the dialog reads as text.
    expect(html).toMatch(
      /<label><input type="checkbox" name="deleteCreatedRoles" value="1">[\s\S]*?<\/label>/,
    );
    expect(mainOf(html)).not.toContain("kb-btn--primary");
  });

  it("has no form on a snapshot that cannot be restored", () => {
    expect(states["not restorable"]).not.toContain("data-confirm-form");
    expect(states["not restorable"]).not.toContain("data-confirm-link-page");
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
