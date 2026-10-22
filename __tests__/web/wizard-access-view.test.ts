import { describe, it, expect } from "@jest/globals";
import {
  renderAccessReview,
  renderWizardAccessPage,
  renderWizardSteps,
} from "../../src/web/wizard-access-view.js";

describe("renderWizardSteps", () => {
  it("lists Features, Access, Channels and Review in order", () => {
    const html = renderWizardSteps("features");
    const labels = [...html.matchAll(/<li[^>]*>(?:<a[^>]*>)?([A-Za-z]+)/g)].map(
      (m) => m[1],
    );
    expect(labels).toEqual(["Features", "Access", "Channels", "Review"]);
  });

  it("marks the current step and links the finished ones back", () => {
    const html = renderWizardSteps("channels");
    expect(html).toContain('<li aria-current="step">Channels</li>');
    expect(html).toContain(
      '<li class="is-done"><a href="/admin/wizard?step=access">Access</a></li>',
    );
    expect(html).toContain('<li class="is-done"><a href="/admin/wizard">');
    expect(html).toContain("<li>Review</li>");
  });
});

describe("renderAccessReview", () => {
  it("escapes a role name", () => {
    const html = renderAccessReview(
      [
        {
          kind: "create",
          roleId: "1",
          roleName: "<img src=x onerror=alert(1)>",
          groupId: null,
          groupName: "<img src=x onerror=alert(1)>",
          scopesBefore: [],
          scopesAfter: ["host"],
          capabilitiesBefore: [],
          capabilitiesAfter: ["host"],
        },
      ],
      null,
      [],
    );
    expect(html).not.toContain("<img");
    expect(html).toContain("Event host");
  });

  it("says nothing changes when the mapping already matches", () => {
    expect(renderAccessReview([], null, [])).toContain(
      "No role mapping changes.",
    );
  });
});

describe("renderWizardAccessPage", () => {
  const base = {
    csrfToken: "tok",
    remainingMs: 60_000,
    selection: { admin: [], staff: [], host: [] },
    gaps: [],
  };

  it("has a card per scope, plus Members pointing at Command permissions", () => {
    const html = renderWizardAccessPage({ ...base, options: [] });
    for (const title of ["Admins", "Moderators", "Event hosts", "Members"]) {
      expect(html).toContain(`>${title}</h3>`);
    }
    expect(html).toContain('href="/admin/permissions"');
    expect(html).toContain('name="_csrf" value="tok"');
  });

  it("offers a pointer to Role groups while no Event host role exists", () => {
    const none = renderWizardAccessPage({
      ...base,
      options: [{ id: "1", name: "Mods", managed: false, position: 1 }],
    });
    expect(none).toContain("no Event host role yet");
    const has = renderWizardAccessPage({
      ...base,
      options: [{ id: "2", name: "Event host", managed: false, position: 1 }],
    });
    expect(has).not.toContain("no Event host role yet");
  });

  it("keeps a saved role that can no longer be picked, selected", () => {
    const html = renderWizardAccessPage({
      ...base,
      selection: { admin: [], staff: ["404"], host: [] },
      options: [],
    });
    expect(html).toContain('<option value="404" selected>');
  });
});
