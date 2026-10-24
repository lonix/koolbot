import { describe, it, expect } from "@jest/globals";
import { renderWizardConfirmPage } from "../../src/web/admin-views.js";
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

describe("renderAccessReview, Event host role", () => {
  it("lists the engine's operations and says what happens next", () => {
    const html = renderAccessReview([], null, [], {
      planId: "abc",
      operations: ['Create role "Event host"'],
      problems: [],
    });
    expect(html).toContain("<h2>Event host role</h2>");
    expect(html).toContain("Create role &quot;Event host&quot;");
    expect(html).toContain("background job");
    expect(html).not.toContain("No role mapping changes.");
  });

  it("blocks with the reasons, in an alert, and shows no operations", () => {
    const html = renderAccessReview([], null, [], {
      planId: null,
      operations: ['Create role "Event host"'],
      problems: [
        "The bot needs the Manage Roles permission for these changes.",
      ],
    });
    expect(html).toContain('role="alert"');
    expect(html).toContain("Manage Roles");
    expect(html).toContain("Not created.");
    expect(html).not.toContain("<li>Create role");
  });

  it("escapes what the engine reports", () => {
    const html = renderAccessReview([], null, [], {
      planId: "abc",
      operations: ["<img src=x onerror=alert(1)>"],
      problems: [],
    });
    expect(html).not.toContain("<img");
  });
});

describe("renderWizardConfirmPage, Event host role", () => {
  const props = {
    csrfToken: "tok",
    remainingMs: 60_000,
    pending: [] as Array<[string, unknown]>,
    metadata: {},
  };

  it("posts the plan id back and enables Apply when only the role is created", () => {
    const html = renderWizardConfirmPage({
      ...props,
      hostRole: {
        planId: "0123456789abcdef01234567",
        operations: ['Create role "Event host"'],
        problems: [],
      },
    });
    expect(html).toContain(
      'name="hostPlanId" value="0123456789abcdef01234567"',
    );
    expect(html).not.toMatch(/<button[^>]*disabled[^>]*>Apply/);
  });

  it("disables Apply while the role has problems", () => {
    const html = renderWizardConfirmPage({
      ...props,
      hostRole: { planId: "x", operations: [], problems: ["Not possible."] },
    });
    expect(html).toMatch(/<button[^>]*disabled[^>]*>Apply/);
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
    // The role cell is a mention, escaped (#1394).
    expect(html).toContain(
      '<td><span class="kb-mention">@&lt;img src=x onerror=alert(1)&gt;</span></td>',
    );
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

  describe("Create @Event host", () => {
    const options = [{ id: "1", name: "Mods", managed: false, position: 1 }];

    it("offers a switch when no Event host role exists", () => {
      const html = renderWizardAccessPage({
        ...base,
        options,
        hostCreate: { available: true },
      });
      expect(html).toContain("Create @Event host");
      expect(html).toMatch(
        /<input type="checkbox" role="switch" name="create_host" value="1" aria-describedby="access-host-create-help">/,
      );
      expect(html).toContain('id="access-host-create-help"');
    });

    it("shows the switch on when it was chosen", () => {
      const html = renderWizardAccessPage({
        ...base,
        options,
        hostCreate: { available: true },
        createHost: true,
      });
      expect(html).toMatch(/name="create_host"[^>]*checked/);
    });

    it("disables the switch and says why when it can't be created", () => {
      const html = renderWizardAccessPage({
        ...base,
        options,
        hostCreate: {
          available: false,
          reason: "permission",
          message:
            "The bot needs the Manage Roles permission to create a role.",
        },
        createHost: true,
      });
      expect(html).toMatch(/name="create_host"[^>]*disabled/);
      expect(html).not.toMatch(/name="create_host"[^>]*checked/);
      expect(html).toContain("The bot needs the Manage Roles permission");
    });

    it("offers nothing when the role already exists", () => {
      const html = renderWizardAccessPage({
        ...base,
        options,
        hostCreate: {
          available: false,
          reason: "exists",
          message: "An Event host role already exists. Pick it above.",
        },
      });
      expect(html).not.toContain("create_host");
    });

    it("offers nothing when the roles could not be read", () => {
      const html = renderWizardAccessPage({
        ...base,
        options: null,
        hostCreate: { available: true },
      });
      expect(html).not.toContain("create_host");
    });
  });

  it("does not promise what Discord's command permissions would block", () => {
    const html = renderWizardAccessPage({ ...base, options: [] });
    expect(html).toContain(
      "Discord only lets /config run for members with the Administrator permission",
    );
    expect(html).toContain("does not give any Discord permission");
    expect(html).not.toContain("warn members");
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

describe("renderWizardConfirmPage Apply button", () => {
  const base = {
    csrfToken: "tok",
    remainingMs: 60_000,
    metadata: {},
  };
  const applyDisabled = (html: string): boolean =>
    /<button[^>]*disabled[^>]*>Apply/.test(html);

  it("is disabled when there is nothing to apply", () => {
    expect(
      applyDisabled(
        renderWizardConfirmPage({ ...base, pending: [], accessChanges: [] }),
      ),
    ).toBe(true);
  });

  it("is enabled when a setting is pending", () => {
    expect(
      applyDisabled(
        renderWizardConfirmPage({ ...base, pending: [["a.enabled", true]] }),
      ),
    ).toBe(false);
  });
});
