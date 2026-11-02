/* global Document, HTMLInputElement, HTMLDetailsElement, Node */
import { describe, it, expect } from "@jest/globals";
import { JSDOM } from "jsdom";
import { PermissionFlagsBits, PermissionsBitField } from "discord.js";
import { orderToken } from "../../src/web/reorder-view.js";
import {
  renderAdminFixPage,
  renderRoleDeletePage,
  renderRoleGroupsPage,
  roleGroupEditForm,
  type RoleGroupRow,
  type RoleGroupsPageProps,
} from "../../src/web/role-groups-views.js";

const row = (over: Partial<RoleGroupRow> = {}): RoleGroupRow => ({
  id: "g1",
  name: "Mods",
  roleId: "r1",
  rank: 2,
  permissions: "0",
  capabilities: ["staff"],
  colour: null,
  hoist: false,
  createdByKoolbot: false,
  gateOnly: false,
  createdAt: new Date(),
  roleName: "Moderator",
  unlinked: false,
  lostRoleId: null,
  recreateRequestedAt: null,
  syncPolicy: null,
  driftSignature: null,
  roleMissing: false,
  memberCount: 3,
  roleLock: null,
  drift: [],
  ...over,
});

const props = (
  over: Partial<RoleGroupsPageProps> = {},
): RoleGroupsPageProps => ({
  csrfToken: "tok",
  remainingMs: 1000,
  groups: [row()],
  roleOptions: [
    { id: "r1", name: "Moderator", memberCount: 3, lock: null, taken: true },
    {
      id: "r2",
      name: "Server Booster",
      memberCount: 40,
      lock: "managed",
      taken: false,
    },
    {
      id: "r3",
      name: "Above",
      memberCount: 1,
      lock: "hierarchy",
      taken: false,
    },
  ],
  plan: null,
  extraErrors: [],
  botScanUnavailable: false,
  botsMissing: 0,
  adminReport: null,
  adminGroupLacksAdministrator: false,
  membersUnavailable: false,
  roleNames: {},
  globalPolicy: "flag",
  ...over,
});

const plan = (over = {}) =>
  ({
    id: "plan-1",
    guildId: "g",
    plannedBy: "a",
    operations: [
      {
        id: "op1",
        type: "role.create",
        class: "additive",
        summary: "Create role Admin",
        before: null,
        after: { name: "Admin", permissions: "8" },
      },
    ],
    warnings: [],
    errors: [],
    baseline: { absentRoleNames: [], roles: [], channels: [], config: {} },
    ...over,
  }) as unknown as RoleGroupsPageProps["plan"];

describe("renderRoleGroupsPage", () => {
  it("shows groups with role, members and capabilities, and a CSRF token on every form", () => {
    const html = renderRoleGroupsPage(props());
    expect(html).toContain("Mods");
    expect(html).toContain("@Moderator");
    expect(html).toContain('<span class="kb-mention">@Moderator</span>');
    expect(html).toContain(">3<");
    expect(html).toContain("staff");
    const forms = html.match(/<form /g)?.length ?? 0;
    const tokens = html.match(/name="_csrf" value="tok"/g)?.length ?? 0;
    expect(forms).toBeGreaterThan(0);
    expect(tokens).toBe(forms);
  });

  it("shows the staff capability as Moderator and host as Event host; the stored key stays staff (#1316)", () => {
    const html = renderRoleGroupsPage(
      props({ groups: [row({ capabilities: ["staff", "host"] })] }),
    );
    expect(html).toContain(
      '<span class="kb-badge kb-badge--info">Moderator</span>',
    );
    expect(html).toContain(
      '<span class="kb-badge kb-badge--info">Event host</span>',
    );
    // The tag no longer shows the raw key ...
    expect(html).not.toContain(
      '<span class="kb-badge kb-badge--info">staff</span>',
    );
    // ... but the form still posts it, so nothing stored changes.
    expect(html).toContain('name="capability" value="staff" checked');
    expect(html).toContain('name="capability" value="host" checked');
    // The row's name is the UI name (#1615: the label text moved into the SettingRow name).
    expect(html).toMatch(/class="kb-setting__name"[^>]*>Moderator<\/p>/);
    expect(html).toMatch(/class="kb-setting__name"[^>]*>Event host<\/p>/);
    expect(html).not.toMatch(/class="kb-setting__name"[^>]*>staff<\/p>/);
  });

  it("offers an Event host preset that ticks host and nothing else (#1316)", () => {
    const html = renderRoleGroupsPage(props());
    expect(html).toContain(
      '<option value="event-host" data-permissions="" data-capabilities="host">Event host</option>',
    );
  });

  it("explains that groups are optional when there are none", () => {
    const html = renderRoleGroupsPage(props({ groups: [] }));
    expect(html).toContain("No groups yet");
    expect(html).toContain("keeps its current behaviour");
  });

  it("locks @everyone/hierarchy roles and offers managed roles as gate-only", () => {
    const html = renderRoleGroupsPage(props());
    expect(html).toMatch(/value="r3" disabled/);
    expect(html).toMatch(/value="r1" disabled/);
    expect(html).toMatch(/<option value="r2">@Server Booster/);
    expect(html).toContain("gate-only");
  });

  it("marks pending new roles, missing roles and locked groups", () => {
    const html = renderRoleGroupsPage(
      props({
        groups: [
          row({ id: "a", roleId: null, roleName: null, memberCount: null }),
          row({ id: "b", roleMissing: true }),
          row({ id: "c", roleLock: "hierarchy" }),
        ],
      }),
    );
    expect(html).toContain("created on apply");
    expect(html).toContain("role not found");
    expect(html).toContain("locked: at or above the bot");
  });

  it("draws the Order column as a ReorderList: place, named buttons, disabled ends (#1616)", () => {
    const html = renderRoleGroupsPage(
      props({
        groups: [row({ id: "a", name: "A" }), row({ id: "b", name: "B" })],
      }),
    );
    expect(html).toContain("<tbody data-reorder-list");
    expect(html).toContain('data-reorder-row data-reorder-label="A"');
    expect(html).toContain('class="kb-reorder__place">1<span');
    expect(html).toContain("> of 2</span>");
    expect(html).toContain('action="/admin/role-groups/a/move"');
    expect(html).toContain('name="scope" value="role-groups"');
    expect(html).toContain(`name="order" value="${orderToken(["a", "b"])}"`);
    expect(html).toContain('id="reorder-status"');
    expect(html).toMatch(
      /value="0" class="kb-btn kb-btn--sm" disabled>Move up<span class="kb-visually-hidden">: A</,
    );
    expect(html).toMatch(
      /value="2" class="kb-btn kb-btn--sm" disabled>Move down<span class="kb-visually-hidden">: B</,
    );
    expect(html).not.toMatch(
      /value="1" class="kb-btn kb-btn--sm" disabled>Move down/,
    );
    // The old arrow buttons and their route are gone.
    expect(html).not.toContain("/admin/role-groups/reorder");
  });

  it("puts the row actions in a nowrap kb-actions cell (#1616)", () => {
    const html = renderRoleGroupsPage(
      props({ groups: [row({ id: "a" }), row({ id: "b", name: "B" })] }),
    );
    expect(html).toContain('<table class="kb-table">');
    const rows = html.match(/<td class="kb-actions">/g) ?? [];
    expect(rows).toHaveLength(2);
    // Edit is the manual's row disclosure with a chevron; no bare summary.
    expect(html).not.toMatch(/<summary>(Edit|Delete)<\/summary>/);
    const edits = html.match(
      /<details class="kb-disclosure"[^>]*><summary><svg[^>]*class="[^"]*kb-chev"[^>]*>.*?<\/svg>Edit<span class="kb-visually-hidden">: /g,
    );
    expect(edits).toHaveLength(2);
    // One summary per row: Delete is a button, not a second disclosure.
    // (The permission groups of the form are disclosures too, marked data-perm-group: #1615.)
    expect(
      html.match(
        /<details class="kb-disclosure"(?![^>]*data-perm-group)[^>]*><summary>/g,
      ) ?? [],
    ).toHaveLength(2);
  });

  it("keeps a refused edit form open (#1616)", () => {
    const html = renderRoleGroupsPage(
      props({
        groups: [row({ id: "g1" })],
        refusedForm: {
          formId: roleGroupEditForm("g1"),
          values: { name: "x" },
          errors: { name: "Too short" },
        },
      }),
    );
    expect(html).toMatch(/<details class="kb-disclosure" open>/);
  });

  it("Delete is a Dialog trigger with a consequence list and a danger button (#1616)", () => {
    const html = renderRoleGroupsPage(props());
    const form = html.match(
      /<form method="POST" action="\/admin\/role-groups\/g1\/delete"[^>]*>/,
    );
    expect(form).not.toBeNull();
    expect(form![0]).toContain('data-confirm="Delete the group Mods?"');
    expect(form![0]).toContain("data-confirm-list=");
    expect(form![0]).not.toContain("data-confirm-tone");
    expect(html).toContain(
      '<button type="submit" class="kb-btn kb-btn--sm kb-btn--danger" aria-label="Delete group, keep role: Mods">Delete group, keep role</button>',
    );
    // No explanation paragraph is left in the row.
    expect(html).not.toContain("Removes the group and keeps its Discord role.");
  });

  it("offers the Discord-role review only for a deletable role, as a link (#1616)", () => {
    const withRole = renderRoleGroupsPage(props());
    expect(withRole).toContain(
      '<a class="kb-btn kb-btn--sm" href="/admin/role-groups/g1/delete-role">Review deleting the group and its Discord role…',
    );
    for (const over of [
      { roleMissing: true },
      { gateOnly: true },
      { roleId: null, roleName: null },
    ]) {
      expect(
        renderRoleGroupsPage(props({ groups: [row(over)] })),
      ).not.toContain("/delete-role");
    }
  });

  it("keeps the actions on one line and the capability badges wrapping (#1616)", () => {
    const html = renderRoleGroupsPage(
      props({ groups: [row({ capabilities: ["admin", "staff"] })] }),
    );
    // Actions: non-wrapping, end-justified. Capabilities: the wrapping row.
    expect(html).toContain(
      '<td class="kb-actions"><div class="kb-row kb-row--nowrap">',
    );
    expect(html).toMatch(/<td><span class="kb-row"><span class="kb-badge/);
    expect(html).not.toContain('<td class="kb-actions"><div class="kb-row">');
  });

  it("lays the capability badges out as one wrapping row (#1616)", () => {
    const html = renderRoleGroupsPage(
      props({ groups: [row({ capabilities: ["admin", "staff"] })] }),
    );
    expect(html).toMatch(
      /<td><span class="kb-row"><span class="kb-badge kb-badge--info">Admin<\/span><span class="kb-badge kb-badge--info">Moderator<\/span><\/span><\/td>/,
    );
  });

  it("offers Apply only for a clean plan with operations", () => {
    expect(renderRoleGroupsPage(props({ plan: plan() }))).toContain(
      'action="/admin/role-groups/apply"',
    );
    const blocked = renderRoleGroupsPage(
      props({
        plan: plan(),
        extraErrors: [{ code: "groups-do-not-fit", message: "No room" }],
      }),
    );
    expect(blocked).not.toContain('action="/admin/role-groups/apply"');
    expect(blocked).toContain("No room");
    expect(
      renderRoleGroupsPage(props({ plan: plan({ operations: [] }) })),
    ).not.toContain('action="/admin/role-groups/apply"');
    expect(
      renderRoleGroupsPage(
        props({ plan: plan({ errors: [{ code: "x", message: "bad" }] }) }),
      ),
    ).not.toContain('action="/admin/role-groups/apply"');
  });

  it("deleting the Discord role is a link to the review, never a tick box (#1184)", () => {
    const html = renderRoleGroupsPage(props());
    expect(html).not.toContain('name="approveRoleDelete"');
    expect(html).toContain('href="/admin/role-groups/g1/delete-role"');
    // The plain delete form can only keep the role.
    expect(html).toContain(
      '<input type="hidden" name="roleAction" value="keep">',
    );
    // A gate-only or missing role offers no role deletion at all.
    const gateOnly = renderRoleGroupsPage(
      props({ groups: [row({ gateOnly: true })] }),
    );
    expect(gateOnly).not.toContain("/delete-role");
  });

  it("explains bot handling and notices when bots can't be listed", () => {
    expect(
      renderRoleGroupsPage(props({ plan: plan(), botsMissing: 2 })),
    ).toContain("2 bot(s) are not in the bot group");
    expect(
      renderRoleGroupsPage(props({ plan: plan(), botScanUnavailable: true })),
    ).toContain("Server Members intent");
  });

  it("shows a notice instead of a plan when Discord was unreachable", () => {
    const html = renderRoleGroupsPage(
      props({ planUnavailable: "Roles could not be read." }),
    );
    expect(html).toContain("Roles could not be read.");
  });

  it("escapes names and wires the job poller only for a job", () => {
    const html = renderRoleGroupsPage(
      props({ groups: [row({ name: "<img src=x onerror=1>" })] }),
    );
    expect(html).not.toContain("<img src=x");
    expect(html).not.toContain("/admin/role-groups/job/'+");
    const job = renderRoleGroupsPage(
      props({ jobId: "11111111-1111-1111-1111-111111111111" }),
    );
    expect(job).toContain('id="rg-job"');
    expect(job).toContain("11111111-1111-1111-1111-111111111111");
  });
});

describe("sync with Discord (#1021)", () => {
  it("shows drift badges per group and a summary notice", () => {
    const html = renderRoleGroupsPage(
      props({
        groups: [
          row({
            drift: [
              {
                groupId: "g1",
                groupName: "Mods",
                kind: "permissions",
                detail: "Permissions in Discord differ <b>.",
              },
            ],
          }),
        ],
      }),
    );
    expect(html).toContain("1 group(s) differ from Discord");
    expect(html).toContain("permissions");
    expect(html).toContain("differ &lt;b&gt;");
    expect(html).not.toContain("differ <b>");
  });

  it("is quiet when nothing drifted", () => {
    expect(renderRoleGroupsPage(props())).not.toContain("differ from Discord");
  });

  it("shows an unlinked group with re-link choices, and no silent recreate", () => {
    const html = renderRoleGroupsPage(
      props({
        groups: [
          row({
            roleId: null,
            roleName: null,
            unlinked: true,
            lostRoleId: "r-old",
            memberCount: null,
          }),
        ],
        roleOptions: [
          { id: "r5", name: "Free", memberCount: 1, lock: null, taken: false },
          { id: "r6", name: "Taken", memberCount: 1, lock: null, taken: true },
          {
            id: "r7",
            name: "Top",
            memberCount: 1,
            lock: "hierarchy",
            taken: false,
          },
        ],
      }),
    );
    expect(html).toContain("unlinked: role deleted");
    expect(html).toContain("r-old");
    expect(html).toContain("does not recreate it on its own");
    expect(html).toContain('name="mode" value="recreate"');
    expect(html).toContain('<option value="r5">@Free</option>');
    expect(html).not.toContain('<option value="r6">');
    expect(html).not.toContain('<option value="r7">');
    expect(html).not.toContain("created on apply");
  });

  it("leaves out roles another feature holds when linking or adding (#1023)", () => {
    const options = [
      { id: "rf", name: "Free", memberCount: 1, lock: null, taken: false },
      {
        id: "rb",
        name: "Birthday",
        memberCount: 1,
        lock: null,
        taken: false,
        usedBy: ["Birthdays", "Reaction Roles"],
      },
    ];
    const relink = renderRoleGroupsPage(
      props({
        groups: [row({ roleId: null, unlinked: true })],
        roleOptions: options,
      }),
    );
    expect(relink).toContain('<option value="rf">@Free</option>');
    expect(relink).not.toContain('<option value="rb">@Birthday</option>');
    const add = renderRoleGroupsPage(props({ roleOptions: options }));
    expect(add).toContain(
      '<option value="rb" disabled>@Birthday · 1 member(s) — used by Birthdays, Reaction Roles</option>',
    );
    expect(add).toContain('<option value="rf">@Free');
  });

  it("shows both notes for a role that backs a group and is held by a feature", () => {
    const html = renderRoleGroupsPage(
      props({
        roleOptions: [
          {
            id: "rx",
            name: "Both",
            memberCount: 2,
            lock: null,
            taken: true,
            usedBy: ["Birthdays"],
          },
        ],
      }),
    );
    expect(html).toContain(
      '<option value="rx" disabled>@Both · 2 member(s) — already a group; used by Birthdays</option>',
    );
  });

  it("offers no recreate for an unlinked gate-only group", () => {
    const html = renderRoleGroupsPage(
      props({
        groups: [row({ roleId: null, unlinked: true, gateOnly: true })],
      }),
    );
    expect(html).not.toContain('value="recreate"');
    expect(html).toContain('value="link"');
  });

  it("offers a gate-only group only managed roles, and others only editable ones", () => {
    const options = [
      {
        id: "rm",
        name: "Booster",
        memberCount: 1,
        lock: "managed" as const,
        taken: false,
      },
      { id: "re", name: "Plain", memberCount: 1, lock: null, taken: false },
    ];
    const relinkOptions = (html: string): string =>
      /name="roleId" required>(.*?)<\/select>/s.exec(html)?.[1] ?? "";
    const gate = renderRoleGroupsPage(
      props({
        groups: [row({ roleId: null, unlinked: true, gateOnly: true })],
        roleOptions: options,
      }),
    );
    expect(relinkOptions(gate)).toContain(
      '<option value="rm">@Booster</option>',
    );
    expect(relinkOptions(gate)).not.toContain('<option value="re">');
    const plain = renderRoleGroupsPage(
      props({
        groups: [row({ roleId: null, unlinked: true })],
        roleOptions: options,
      }),
    );
    expect(relinkOptions(plain)).toContain(
      '<option value="re">@Plain</option>',
    );
    expect(relinkOptions(plain)).not.toContain('<option value="rm">');
  });

  it("lets a group pick its sync policy, defaulting to the global one", () => {
    const html = renderRoleGroupsPage(
      props({
        groups: [row({ syncPolicy: "adopt" })],
        globalPolicy: "enforce",
      }),
    );
    expect(html).toContain('name="syncPolicy"');
    expect(html).toContain("Use the global setting (Enforce");
    expect(html).toMatch(/<option value="adopt" selected>/);
  });

  describe("administrators and the admin group", () => {
    const report = {
      humans: [{ id: "u1", name: "Bob <b>", viaRoleIds: ["legacy"] }],
      bots: [
        { id: "kool", name: "KoolBot", viaRoleIds: ["bots"], self: true },
        { id: "b2", name: "Music", viaRoleIds: ["bots"] },
      ],
    };

    it("skips the report without an admin group and says why", () => {
      const html = renderRoleGroupsPage(props());
      expect(html).toContain("nothing to sync");
      expect(html).not.toContain("admin-fix");
    });

    it("says so when the member list is unavailable", () => {
      const html = renderRoleGroupsPage(props({ membersUnavailable: true }));
      expect(html).toContain("Server Members intent is off");
    });

    it("lists out-of-group humans unchecked, and bots apart", () => {
      const html = renderRoleGroupsPage(
        props({
          adminReport: report,
          roleNames: { legacy: "Old admins", bots: "Bots" },
        }),
      );
      expect(html).toContain('action="/admin/role-groups/admin-fix"');
      expect(html).toContain('name="move" value="u1"');
      expect(html).toContain('name="drop" value="legacy"');
      expect(html).toContain("Bob &lt;b&gt;");
      expect(html).not.toMatch(/name="(move|drop)"[^>]*checked/);
      expect(html).toContain("Bots with Administrator (2)");
      expect(html).toContain("(KoolBot)");
      expect(html).not.toContain('name="move" value="kool"');
      expect(html).not.toContain('name="drop" value="bots"');
    });

    it("offers giving the admin group Administrator as an unticked choice", () => {
      const html = renderRoleGroupsPage(
        props({
          adminReport: { humans: [], bots: [] },
          adminGroupLacksAdministrator: true,
        }),
      );
      expect(html).toContain("doesn&#39;t carry Administrator");
      expect(html).toContain('name="grant" value="1"');
      expect(html).not.toMatch(/name="grant"[^>]*checked/);
      expect(html).toContain('action="/admin/role-groups/admin-fix"');
    });

    it("still offers the grant when the member list is unavailable", () => {
      const html = renderRoleGroupsPage(
        props({
          membersUnavailable: true,
          adminGroupLacksAdministrator: true,
        }),
      );
      expect(html).toContain("Server Members intent is off");
      expect(html).toContain('name="grant" value="1"');
    });

    it("offers re-linking for a group whose role vanished before the sync noticed", () => {
      const html = renderRoleGroupsPage(
        props({ groups: [row({ roleMissing: true })] }),
      );
      expect(html).toContain('name="mode" value="recreate"');
      expect(html).toContain("does not recreate it on its own");
    });

    it("doesn't offer dropping a role a bot also holds Administrator through", () => {
      const html = renderRoleGroupsPage(
        props({
          adminReport: {
            humans: [
              { id: "u1", name: "Bob", viaRoleIds: ["legacy", "shared"] },
            ],
            bots: [{ id: "b2", name: "Music", viaRoleIds: ["shared"] }],
          },
          roleNames: { legacy: "Old admins", shared: "Staff bots" },
        }),
      );
      expect(html).toContain('name="drop" value="legacy"');
      expect(html).not.toContain('name="drop" value="shared"');
      expect(html).toContain('name="move" value="u1"');
    });

    it("confirms when everyone is in the group", () => {
      const html = renderRoleGroupsPage(
        props({ adminReport: { humans: [], bots: [] } }),
      );
      expect(html).toContain(
        "Everyone with Administrator is in the admin group",
      );
    });
  });
});

describe("renderAdminFixPage", () => {
  const p = (over = {}) => ({
    csrfToken: "tok",
    remainingMs: 1000,
    plan: plan() as NonNullable<RoleGroupsPageProps["plan"]>,
    extraErrors: [],
    moveIds: ["u1"],
    dropIds: ["legacy"],
    grant: false,
    losing: [],
    ...over,
  });

  it("leaves <main> scrolling: this page has no save bar", () => {
    const main = renderAdminFixPage(p()).match(/<main[^>]*>/)?.[0] ?? "";
    expect(main).toContain('id="main"');
    expect(main).not.toContain("has-savebar");
  });

  it("previews the plan and offers apply with the choices carried over", () => {
    const html = renderAdminFixPage(p());
    expect(html).toContain('action="/admin/role-groups/admin-fix/apply"');
    expect(html).toContain('name="planId" value="plan-1"');
    expect(html).toContain('name="move" value="u1"');
    expect(html).toContain('name="drop" value="legacy"');
    expect(html).toContain('name="_csrf" value="tok"');
  });

  it("offers no apply when there are blocking problems", () => {
    const html = renderAdminFixPage(
      p({
        extraErrors: [{ code: "admin-lockout", message: "Your own access" }],
      }),
    );
    expect(html).toContain("Your own access");
    expect(html).not.toContain("admin-fix/apply");
  });

  it("carries the grant choice into the apply form", () => {
    const html = renderAdminFixPage(p({ grant: true }));
    expect(html).toContain('name="grant" value="1"');
    expect(renderAdminFixPage(p())).not.toContain('name="grant"');
  });

  it("names members who would lose Administrator", () => {
    const html = renderAdminFixPage(p({ losing: ["Bob <b>"] }));
    expect(html).toContain("1 member(s) lose Administrator");
    expect(html).toContain("Bob &lt;b&gt;");
  });
});

describe("renderRoleDeletePage (#1184)", () => {
  const deletePlan = () =>
    plan({
      operations: [
        {
          id: "op1",
          type: "role.delete",
          class: "destructive",
          summary: 'Delete role "Mods <b>"',
          before: { name: "Mods <b>", permissions: "0" },
          after: null,
        },
      ],
    }) as NonNullable<RoleGroupsPageProps["plan"]>;
  const p = (over: Record<string, unknown> = {}) => ({
    csrfToken: "tok",
    remainingMs: 1000,
    groupId: "g1",
    groupName: "Mods",
    plan: deletePlan(),
    extraErrors: [],
    approvedAt: "2026-10-17T10:00:00.000Z",
    reviewToken: "review-token" as string | null,
    confirmName: "Mods <b>" as string | null,
    roleId: "r1",
    validForMinutes: 15,
    ...over,
  });

  it("shows the plan with its destructive section and asks for the typed name", () => {
    const html = renderRoleDeletePage(p());
    expect(html).toContain("Destructive steps (1)");
    expect(html).toContain('action="/admin/role-groups/g1/delete-role/apply"');
    expect(html).toContain('name="planId" value="plan-1"');
    expect(html).toContain(
      'name="approvedAt" value="2026-10-17T10:00:00.000Z"',
    );
    expect(html).toContain('name="confirmName"');
    expect(html).toContain("Mods &lt;b&gt;");
    expect(html).not.toContain("Mods <b>");
  });

  it("shows the exact name, padding included, escaped and in a whitespace-preserving element", () => {
    const html = renderRoleDeletePage(p({ confirmName: "  A <i> " }));
    expect(html).toContain('<pre class="kb-mono">  A &lt;i&gt; </pre>');
    expect(html).toContain("8 characters");
  });

  it("says the role ID and member assignments can't be restored", () => {
    const html = renderRoleDeletePage(p());
    expect(html).toContain("role ID");
    expect(html).toContain("member assignments");
  });

  it("offers no apply when blocked or when there is no role to delete", () => {
    const blocked = renderRoleDeletePage(
      p({ extraErrors: [{ code: "role-in-use", message: "Used by X" }] }),
    );
    expect(blocked).toContain("Used by X");
    expect(blocked).not.toContain("delete-role/apply");
    expect(renderRoleDeletePage(p({ confirmName: null }))).not.toContain(
      "delete-role/apply",
    );
    // No token can be issued (no session secret): nothing to apply.
    expect(renderRoleDeletePage(p({ reviewToken: null }))).not.toContain(
      "delete-role/apply",
    );
  });

  it("sends the server-issued review token back with the form", () => {
    expect(renderRoleDeletePage(p())).toContain(
      'name="reviewToken" value="review-token"',
    );
  });
});

// Capabilities and Discord permissions are SettingRows with Switches (#1615).
describe("Role groups form switches (#1615)", () => {
  const forms = (html: string): { create: string; edit: string } => {
    const doc = new JSDOM(html).window.document;
    const pick = (suffix: string): string =>
      doc.querySelector(`form[action$="${suffix}"]`)?.outerHTML ?? "";
    return { create: pick("/role-groups/create"), edit: pick("/g1/edit") };
  };
  const doc = (html: string): Document => new JSDOM(html).window.document;

  it("draws no stacked checkbox in the create and edit forms", () => {
    const { create, edit } = forms(renderRoleGroupsPage(props()));
    expect(create).not.toContain('class="check"');
    expect(edit).not.toContain('class="check"');
    // The legacy form.stack rule would column-stack a label.kb-switch.
    expect(create).not.toMatch(/<form[^>]*class="stack"/);
    expect(edit).not.toMatch(/<form[^>]*class="stack"/);
  });

  it("draws each capability as a SettingRow with a Switch: name and the Access step's line left, switch right", () => {
    const d = doc(forms(renderRoleGroupsPage(props())).edit);
    const rows = [...d.querySelectorAll(".kb-setting")].filter((r) =>
      r.querySelector('input[name="capability"]'),
    );
    expect(
      rows.map((r) => r.querySelector(".kb-setting__name")?.textContent),
    ).toEqual(["Admin", "Moderator", "Event host", "Bot"]);
    expect(rows[0].querySelector(".kb-setting__desc")?.textContent).toBe(
      "Change every setting and run the setup wizard",
    );
    for (const r of rows) {
      const input = r.querySelector<HTMLInputElement>("input");
      expect(input?.getAttribute("role")).toBe("switch");
      expect(
        r.querySelector(".kb-setting__control .kb-switch__state"),
      ).not.toBeNull();
      // The row's name names the switch.
      const labelled = input?.getAttribute("aria-labelledby") ?? "";
      expect(d.getElementById(labelled)?.textContent).toBe(
        r.querySelector(".kb-setting__name")?.textContent,
      );
    }
    expect(
      d.querySelector('input[value="staff"]')?.hasAttribute("checked"),
    ).toBe(true);
    expect(
      d.querySelector('input[value="admin"]')?.hasAttribute("checked"),
    ).toBe(false);
  });

  it("disables the capability switches of a gate-only group and says why beside them", () => {
    const d = doc(
      forms(
        renderRoleGroupsPage(
          props({ groups: [row({ gateOnly: true, capabilities: [] })] }),
        ),
      ).edit,
    );
    const boxes = [
      ...d.querySelectorAll<HTMLInputElement>('input[name="capability"]'),
    ];
    expect(boxes).toHaveLength(4);
    expect(boxes.every((b) => b.disabled)).toBe(true);
    expect(d.body.textContent).toContain("gate-only");
    const help = d.querySelector(".kb-help[id$='capability-help']");
    expect(help?.textContent).toMatch(/gating/);
    for (const b of boxes) {
      expect(b.getAttribute("aria-describedby")).toContain(help?.id ?? "?");
    }
  });

  it("keeps every element id on the page unique across the create and edit forms", () => {
    const html = renderRoleGroupsPage(
      props({ groups: [row(), row({ id: "g2", name: "Other" })] }),
    );
    const ids = [...doc(html).querySelectorAll("[id]")].map((e) => e.id);
    expect(ids.filter((id, i) => ids.indexOf(id) !== i)).toEqual([]);
  });

  it("draws one switch per permission bit, once, under its group", () => {
    const d = doc(forms(renderRoleGroupsPage(props())).edit);
    const perms = [
      ...d.querySelectorAll<HTMLInputElement>('input[name="perm"]'),
    ];
    expect(perms).toHaveLength(52);
    expect(new Set(perms.map((p) => p.value)).size).toBe(52);
    // Human names, not flag names.
    const names = [...d.querySelectorAll(".kb-setting__name")].map(
      (n) => n.textContent,
    );
    expect(names).toContain("Manage Server");
    expect(names).not.toContain("ManageGuild");
    expect(perms.every((p) => p.getAttribute("role") === "switch")).toBe(true);
  });

  it("groups permissions in collapsible disclosures whose summary counts the ones on", () => {
    // ModerateMembers (Membership) and SendMessages + ManageMessages (Text channels)
    const bits = (
      PermissionFlagsBits.ModerateMembers |
      PermissionFlagsBits.SendMessages |
      PermissionFlagsBits.ManageMessages
    ).toString();
    const d = doc(
      forms(
        renderRoleGroupsPage(props({ groups: [row({ permissions: bits })] })),
      ).edit,
    );
    const groups = [
      ...d.querySelectorAll<HTMLDetailsElement>("details[data-perm-group]"),
    ];
    expect(groups.map((g) => g.dataset.permGroup)).toEqual([
      "general",
      "membership",
      "text",
      "voice",
      "stage",
      "apps",
      "events",
      "advanced",
    ]);
    const summary = (key: string): string =>
      groups.find((g) => g.dataset.permGroup === key)?.querySelector("summary")
        ?.textContent ?? "";
    expect(summary("text")).toContain("Text channels, 2 on");
    expect(summary("membership")).toContain("Membership, 1 on");
    expect(summary("voice")).toContain("Voice channels, none on");
    for (const g of groups) {
      expect(g.classList.contains("kb-disclosure")).toBe(true);
      // Without JavaScript every group is open; the page script folds the quiet ones.
      expect(g.hasAttribute("open")).toBe(true);
      expect(g.querySelector(".kb-overline, summary")).not.toBeNull();
    }
  });

  it("puts Administrator last in Advanced, under a warn Callout", () => {
    const d = doc(forms(renderRoleGroupsPage(props())).edit);
    const advanced = d.querySelector('details[data-perm-group="advanced"]');
    const inputs = [
      ...(advanced?.querySelectorAll('input[name="perm"]') ?? []),
    ];
    expect((inputs.at(-1) as HTMLInputElement).value).toBe("Administrator");
    const callout = advanced?.querySelector(".kb-callout.kb-callout--warn");
    expect(callout).not.toBeNull();
    // Above the switch, not after it; plain text, no markdown.
    const after = callout!.compareDocumentPosition(inputs.at(-1) as Node);
    expect(after & 4).toBeTruthy();
    expect(callout!.textContent).not.toMatch(/[`*]/);
  });

  it("keeps every group open in a refused form so focus can reach an invalid control", () => {
    const html = renderRoleGroupsPage(
      props({
        refusedForm: {
          formId: "role-group-edit-g1",
          errors: { name: "Taken." },
          values: { name: "Mods" },
        },
      }),
    );
    const d = doc(forms(html).edit);
    expect(d.querySelectorAll("details[data-perm-group]")).toHaveLength(8);
    expect(
      [...d.querySelectorAll("details[data-perm-group]")].every((g) =>
        g.hasAttribute("data-keep-open"),
      ),
    ).toBe(true);
  });

  it("renders the permission Switch for a refused form from what was posted", () => {
    const html = renderRoleGroupsPage(
      props({
        refusedForm: {
          formId: "role-group-create",
          errors: { name: "Taken." },
          values: { name: "x", "perm-BanMembers": "1", editPermissions: "1" },
        },
      }),
    );
    const d = doc(forms(html).create);
    expect(
      d.querySelector('input[value="BanMembers"]')?.hasAttribute("checked"),
    ).toBe(true);
    expect(
      d.querySelector('input[value="KickMembers"]')?.hasAttribute("checked"),
    ).toBe(false);
    expect(
      d.querySelector('input[name="editPermissions"]')?.getAttribute("role"),
    ).toBe("switch");
  });

  it("lets a preset tick the switches and keeps each group's count in step", () => {
    const html = renderRoleGroupsPage(props());
    expect(html).toContain("input[name=perm]");
    expect(html).toContain("input[name=capability]");
    expect(html).toContain("rg-perm-count");
  });

  it("round-trips the stored bits: the ticked switches are exactly the stored permissions", () => {
    const stored = [
      "0",
      "8",
      (
        PermissionFlagsBits.BanMembers |
        PermissionFlagsBits.ManageGuildExpressions
      ).toString(),
      (
        PermissionFlagsBits.ModerateMembers |
        PermissionFlagsBits.UseExternalApps |
        PermissionFlagsBits.BypassSlowmode
      ).toString(),
      PermissionsBitField.All.toString(),
    ];
    for (const bits of stored) {
      const d = doc(
        forms(
          renderRoleGroupsPage(props({ groups: [row({ permissions: bits })] })),
        ).edit,
      );
      const ticked = [
        ...d.querySelectorAll<HTMLInputElement>('input[name="perm"]:checked'),
      ].map(
        (i) => PermissionFlagsBits[i.value as keyof typeof PermissionFlagsBits],
      );
      expect(ticked.reduce((a, b) => a | b, 0n).toString()).toBe(bits);
    }
  });
});
