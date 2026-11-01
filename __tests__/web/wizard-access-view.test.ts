import { readFileSync } from "node:fs";
import { describe, it, expect } from "@jest/globals";
import { renderWizardConfirmPage } from "../../src/web/admin-views.js";
import {
  renderAccessReview,
  renderWizardAccessPage,
  renderWizardSteps,
  renderWizardSubSteps,
} from "../../src/web/wizard-access-view.js";

describe("renderWizardSteps", () => {
  it("lists Choose features, Access, Features and Review in order (#1620)", () => {
    const html = renderWizardSteps("features");
    const labels = [...html.matchAll(/<li[^>]*>(?:<a[^>]*>)?([^<]+)/g)].map(
      (m) => m[1],
    );
    expect(labels).toEqual(["Choose features", "Access", "Features", "Review"]);
  });

  it("marks the current step and links the finished ones back", () => {
    const html = renderWizardSteps("settings");
    expect(html).toContain('<li aria-current="step">Features</li>');
    expect(html).toContain(
      '<li class="is-done"><a href="/admin/wizard?step=access">Access</a></li>',
    );
    expect(html).toContain(
      '<li class="is-done"><a href="/admin/wizard">Choose features</a></li>',
    );
    expect(html).toContain("<li>Review</li>");
  });

  it("keeps the first step's route and links the third step to the first feature page", () => {
    const html = renderWizardSteps("review");
    expect(html).toContain('<a href="/admin/wizard">Choose features</a>');
    expect(html).toContain('<a href="/admin/wizard?step=0">Features</a>');
    expect(html).toContain('<li aria-current="step">Review</li>');
  });
});

describe("renderWizardSubSteps (#1620)", () => {
  const items = (n: number) =>
    Array.from({ length: n }, (_, i) => ({ label: `Feature ${i + 1}` }));
  const names = [
    { label: "Voice Channels" },
    { label: "Name history" },
    { label: "Polls" },
  ];

  it("says where the admin is as text, once", () => {
    const html = renderWizardSubSteps(names, 1);
    expect(html).toContain(
      '<p class="kb-substeps__label">Feature 2 of 3: Name history</p>',
    );
    expect(html).not.toMatch(/Step \d/);
  });

  it("marks only the current feature with aria-current, links finished ones back, leaves the rest plain", () => {
    const html = renderWizardSubSteps(names, 1);
    expect(html.match(/aria-current="step"/g)).toHaveLength(1);
    expect(html).toContain('<li aria-current="step">');
    expect(html).toContain(
      '<li class="is-done"><a class="kb-substeps__mark" href="/admin/wizard?step=0" title="Voice Channels"><span class="kb-visually-hidden">Voice Channels, done</span></a></li>',
    );
    expect(html.match(/<a /g)).toHaveLength(1);
    expect(html).toContain('<span class="kb-visually-hidden">Polls</span>');
  });

  it.each([
    [0, "Feature 1 of 3: Voice Channels", 0],
    [1, "Feature 2 of 3: Name history", 1],
    [2, "Feature 3 of 3: Polls", 2],
  ])("position %i reads %s with %i finished", (at, text, done) => {
    const html = renderWizardSubSteps(names, at);
    expect(html).toContain(`>${text}</p>`);
    expect(html.match(/class="is-done"/g) ?? []).toHaveLength(done);
    expect(html.match(/<li/g)).toHaveLength(3);
  });

  it("draws nothing for one feature: there is nothing to count", () => {
    expect(renderWizardSubSteps(items(1), 0)).toBe("");
    expect(renderWizardSubSteps([], 0)).toBe("");
  });

  it("draws one marker per feature for 14 features, in one row that shrinks", () => {
    const html = renderWizardSubSteps(items(14), 6);
    expect(html.match(/<li/g)).toHaveLength(14);
    expect(html).toContain(">Feature 7 of 14: Feature 7</p>");
  });

  it("escapes feature names", () => {
    const html = renderWizardSubSteps(
      [{ label: "<b>x</b>" }, { label: 'a"b' }],
      0,
    );
    expect(html).not.toContain("<b>");
    expect(html).toContain("&lt;b&gt;x&lt;/b&gt;");
    expect(html).toContain("a&quot;b");
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
      '<th scope="row"><span class="kb-mention">@&lt;img src=x onerror=alert(1)&gt;</span></th>',
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

  describe("role Picker (#1547)", () => {
    const options = [
      { id: "r-admin", name: "Admins", managed: false, position: 8 },
      { id: "r-mod", name: "Moderator", managed: false, position: 5 },
    ];
    const selectOf = (html: string, scope: string): string => {
      const m = html.match(
        new RegExp(
          `<span class="kb-picker" data-picker[^>]*>(<select[^>]*name="roles_${scope}"[^>]*>[^]*?</select>)</span>`,
        ),
      );
      expect(m).not.toBeNull();
      return m![1];
    };

    it("renders each scope's roles through the multi-select Picker", () => {
      const html = renderWizardAccessPage({
        ...base,
        selection: { admin: ["r-admin"], staff: [], host: [] },
        options,
      });
      expect((html.match(/data-picker data-picker-meta=/g) ?? []).length).toBe(
        3,
      );
      const admin = selectOf(html, "admin");
      expect(admin).toContain("multiple");
      expect(admin).toContain('<optgroup label="Roles">');
      expect(admin).toContain('<option value="r-admin" selected>@Admins');
      expect(admin).toContain('<option value="r-mod">@Moderator');
      expect(selectOf(html, "staff")).not.toContain(" selected>");
    });

    it("keeps the label, the field name and the empty-state help", () => {
      const html = renderWizardAccessPage({ ...base, options });
      expect(html).toContain('<label class="kb-label" for="access-staff">');
      expect(html).toContain('id="access-staff"');
      expect(html).toContain('aria-describedby="access-staff-help"');
      expect(html).toContain("Leave it empty for none.");
    });

    it("drops the Ctrl or Cmd hint", () => {
      const html = renderWizardAccessPage({ ...base, options });
      expect(html).not.toContain("Hold Ctrl");
      expect(html).not.toContain("Cmd");
    });

    it("labels a saved role that is gone the way the Picker labels a missing one", () => {
      const html = renderWizardAccessPage({
        ...base,
        selection: { admin: [], staff: ["404"], host: [] },
        options,
      });
      expect(selectOf(html, "staff")).toContain(
        '<option value="404" selected>⚠ 404 (unavailable)</option>',
      );
      expect(html).toContain(
        "[&quot;missing&quot;,&quot;404&quot;,&quot;&quot;]",
      );
      expect(html).not.toContain("Unavailable role");
    });
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

describe("Picker inside an AccessCard (#1547)", () => {
  const css = readFileSync(
    new URL("../../docs/design/kb.css", import.meta.url),
    "utf8",
  );

  it("may shrink below its 18rem minimum, so a 16rem card does not spill", () => {
    expect(css).toMatch(/\.kb-access__card \.kb-picker \{ min-width: 0; \}/);
    // Sizing elsewhere is unchanged.
    expect(css).toMatch(/\n\.kb-picker \{[^}]*min-width: 18rem/);
  });
});
