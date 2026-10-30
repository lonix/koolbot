/* global HTMLInputElement */
/**
 * Route-handler tests for the Role Groups admin writes (#1020), driven over
 * HTTP through the shared harness with the real middleware stack. The group
 * service, the planner glue and the adoption engine are mocked.
 */

import {
  describe,
  it,
  expect,
  jest,
  beforeEach,
  afterEach,
} from "@jest/globals";
import type { Client } from "discord.js";
import { JSDOM } from "jsdom";
import {
  startAdminHarness,
  stubRequireSession,
  createTestSession,
  parseFlashRedirect,
  type AdminHarness,
} from "./admin-harness.js";

const mockRecordAudit = jest.fn(async () => undefined);
jest.unstable_mockModule("../../src/web/audit.js", () => ({
  recordAudit: mockRecordAudit,
}));
jest.unstable_mockModule("../../src/utils/logger.js", () => ({
  default: {
    info: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
    debug: jest.fn(),
  },
}));

type Svc = Record<string, jest.Mock<(...a: any[]) => any>>;
const svc: Svc = {
  create: jest.fn(),
  update: jest.fn(),
  reorder: jest.fn(),
  remove: jest.fn(),
  list: jest.fn(),
  get: jest.fn(),
  setSyncPolicy: jest.fn(),
  markUnlinked: jest.fn(),
  requestRecreate: jest.fn(),
  relinkTo: jest.fn(),
};
jest.unstable_mockModule("../../src/services/role-group-service.js", () => ({
  RoleGroupService: { getInstance: () => svc },
}));

const mockPlanRoles = jest.fn<(...a: any[]) => any>();
const mockPlanDelete = jest.fn<(...a: any[]) => any>();
const mockPlanAdminFix = jest.fn<(...a: any[]) => any>();
const mockRevalidator = jest.fn<(...a: any[]) => any>();
jest.unstable_mockModule("../../src/services/role-group-adoption.js", () => ({
  roleDeletionRevalidator: mockRevalidator,
  planRoleGroups: mockPlanRoles,
  planRoleDeletion: mockPlanDelete,
  planAdminFix: mockPlanAdminFix,
  planIsApplicable: (p: {
    plan: { errors: unknown[] };
    extraErrors: unknown[];
  }) => p.plan.errors.length === 0 && p.extraErrors.length === 0,
}));
const mockStartApply = jest.fn<(...a: any[]) => any>();
// Same refusal as the real engine (assertApplicable): a plan with a destructive
// step is not accepted unless the caller supplies a live-state check (#1097).
const mockEngineStart = (plan: any, options: any): any => {
  if (
    options &&
    !options.revalidate &&
    plan.operations?.some((op: any) => op.class === "destructive")
  ) {
    throw new Error(
      "Plans with destructive steps need a live-state check (revalidate) from a fresh scan.",
    );
  }
  return mockStartApply(plan, options);
};
jest.unstable_mockModule(
  "../../src/services/server-adoption-service.js",
  () => ({
    ServerAdoptionService: {
      getInstance: async () => ({ startApply: mockEngineStart }),
    },
  }),
);

const { createRoleGroupsRouter, permissionsFromNames } =
  await import("../../src/web/routes/write/role-groups.js");
const { requireCsrf } = await import("../../src/web/csrf.js");
const { registerFormPage } = await import("../../src/web/form-pages.js");
const { renderedFormBody, setField } = await import("./rendered-form.js");
const { renderRoleGroupsPage } =
  await import("../../src/web/role-groups-views.js");
const { signRoleDeleteReview } = await import("../../src/web/review-token.js");
const { requireAdminRoleMiddleware } = await import("../../src/web/session.js");

const session = createTestSession();

function makeClient(opts: { fetchFails?: boolean } = {}): Client {
  const roles = new Map([
    ["rOk", { id: "rOk", name: "Helpers", managed: false, position: 3 }],
    [
      "rBoost",
      { id: "rBoost", name: "Server Booster", managed: true, position: 4 },
    ],
    ["rTop", { id: "rTop", name: "Above", managed: false, position: 10 }],
    ["rUsed", { id: "rUsed", name: "Used", managed: false, position: 2 }],
    [
      "guild-1",
      { id: "guild-1", name: "@everyone", managed: false, position: 0 },
    ],
  ]);
  const me = { roles: { highest: { position: 10 } } };
  const guild = {
    id: "guild-1",
    roles: { fetch: jest.fn(async () => roles) },
    members: { me, fetchMe: jest.fn(async () => me) },
  };
  return {
    guilds: {
      fetch: jest.fn(async () => {
        if (opts.fetchFails) throw new Error("down");
        return guild;
      }),
    },
  } as unknown as Client;
}

let harness: AdminHarness;
async function mount(client: Client = makeClient()): Promise<void> {
  harness = await startAdminHarness([
    stubRequireSession(session),
    requireAdminRoleMiddleware(),
    requireCsrf,
    createRoleGroupsRouter(client),
  ]);
}
const flashOf = (res: Response) =>
  parseFlashRedirect(res.headers.get("location"));
const group = (over = {}) => ({
  id: "g1",
  name: "Mod",
  roleId: "rOk",
  createdByKoolbot: false,
  gateOnly: false,
  capabilities: [],
  ...over,
});

beforeEach(() => {
  jest.clearAllMocks();
  // No page to draw a refusal on, unless a test registers one: the flash.
  registerFormPage("/admin/role-groups", async () => {
    throw new Error("page unavailable");
  });
  mockRevalidator.mockReturnValue(async () => []);
  svc.create.mockResolvedValue({ ok: true, group: group() });
  svc.update.mockResolvedValue({ ok: true, group: group() });
  svc.reorder.mockResolvedValue({ ok: true });
  svc.remove.mockResolvedValue(true);
  svc.list.mockResolvedValue([
    group({ id: "a" }),
    group({ id: "b" }),
    group({ id: "c" }),
  ]);
  svc.get.mockResolvedValue(group());
  svc.setSyncPolicy.mockResolvedValue(undefined);
  svc.markUnlinked.mockResolvedValue(true);
  svc.requestRecreate.mockResolvedValue(true);
  svc.relinkTo.mockResolvedValue({ ok: true, group: group() });
});
afterEach(async () => {
  await harness?.close();
  harness = undefined as unknown as AdminHarness;
});

describe("permissionsFromNames", () => {
  it("combines names into a bitfield and rejects unknown ones", () => {
    expect(permissionsFromNames([])).toBe("0");
    expect(permissionsFromNames(["Administrator"])).toBe("8");
    expect(permissionsFromNames(["Nope"])).toBeNull();
  });
});

describe("POST /role-groups/create", () => {
  it("creates a group for a new role with the chosen permissions", async () => {
    await mount();
    const res = await harness.post("/role-groups/create", {
      name: "Mod",
      capability: ["staff"],
      perm: ["ModerateMembers", "ManageMessages"],
      colour: "#112233",
    });
    expect(res.status).toBe(303);
    expect(flashOf(res)).toMatchObject({
      path: "/admin/role-groups",
      type: "ok",
    });
    expect(svc.create).toHaveBeenCalledWith(
      "guild-1",
      expect.objectContaining({
        name: "Mod",
        roleId: null,
        capabilities: ["staff"],
        colour: 0x112233,
        gateOnly: false,
        permissions: permissionsFromNames([
          "ModerateMembers",
          "ManageMessages",
        ]),
      }),
    );
    expect(mockRecordAudit).toHaveBeenCalledTimes(1);
  });

  it("links an existing role without touching its permissions by default", async () => {
    await mount();
    await harness.post("/role-groups/create", {
      roleId: "rOk",
      perm: ["Administrator"],
    });
    expect(svc.create).toHaveBeenCalledWith(
      "guild-1",
      expect.objectContaining({
        name: "Helpers",
        roleId: "rOk",
        permissions: null,
      }),
    );
  });

  it("applies permissions to a linked role only when asked to", async () => {
    await mount();
    await harness.post("/role-groups/create", {
      roleId: "rOk",
      editPermissions: "1",
      perm: ["ManageMessages"],
    });
    expect(svc.create).toHaveBeenCalledWith(
      "guild-1",
      expect.objectContaining({
        permissions: permissionsFromNames(["ManageMessages"]),
      }),
    );
  });

  it("makes a managed role a gate-only group with no edits", async () => {
    await mount();
    await harness.post("/role-groups/create", {
      roleId: "rBoost",
      colour: "#ffffff",
      editPermissions: "1",
      perm: ["Administrator"],
    });
    expect(svc.create).toHaveBeenCalledWith(
      "guild-1",
      expect.objectContaining({
        gateOnly: true,
        permissions: null,
        colour: null,
      }),
    );
  });

  it.each([
    ["@everyone", "guild-1"],
    ["a role at or above the bot", "rTop"],
    ["an unknown role", "nope"],
  ])("refuses %s", async (_label, roleId) => {
    await mount();
    const res = await harness.post("/role-groups/create", { roleId });
    expect(flashOf(res).type).toBe("err");
    expect(svc.create).not.toHaveBeenCalled();
  });

  it("refuses a bad colour and surfaces service errors", async () => {
    await mount();
    expect(
      flashOf(
        await harness.post("/role-groups/create", { name: "x", colour: "red" }),
      ).type,
    ).toBe("err");
    svc.create.mockResolvedValue({
      ok: false,
      error: "A group called x already exists.",
    });
    const res = await harness.post("/role-groups/create", { name: "x" });
    expect(flashOf(res)).toMatchObject({
      type: "err",
      msg: "A group called x already exists.",
    });
    expect(mockRecordAudit).toHaveBeenLastCalledWith(
      expect.anything(),
      expect.objectContaining({ result: "failure" }),
    );
  });

  it("requires the CSRF token", async () => {
    await mount();
    const res = await harness.post(
      "/role-groups/create",
      { name: "x" },
      { csrfField: "wrong" },
    );
    expect(res.status).toBe(403);
    expect(svc.create).not.toHaveBeenCalled();
  });
});

describe("a refused Role groups form (#1523)", () => {
  // The read router registers the page's renderer in the app; here the real
  // view stands in with one stored group (g1) and two roles to pick from.
  beforeEach(() => {
    registerFormPage("/admin/role-groups", async (_req, refused) =>
      renderRoleGroupsPage({
        csrfToken: "csrf",
        remainingMs: 1000,
        groups: [
          {
            ...group(),
            rank: 1,
            permissions: "0",
            colour: null,
            hoist: false,
            unlinked: false,
            lostRoleId: null,
            recreateRequestedAt: null,
            syncPolicy: null,
            driftSignature: null,
            createdAt: new Date(),
            roleName: "Helpers",
            roleMissing: false,
            memberCount: 3,
            roleLock: null,
            drift: [],
          } as never,
        ],
        roleOptions: [
          {
            id: "rOk",
            name: "Helpers",
            memberCount: 3,
            lock: null,
            taken: false,
          },
          {
            id: "rTop",
            name: "Above",
            memberCount: 1,
            lock: "hierarchy",
            taken: false,
          },
          {
            id: "rUsed",
            name: "Used",
            memberCount: 1,
            lock: null,
            taken: true,
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
        refusedForm: refused,
      }),
    );
  });

  const lines = (html: string): Record<string, string> =>
    Object.fromEntries(
      [
        ...html.matchAll(
          /<p class="kb-field__error" id="([^"]+)">([^<]*)<\/p>/g,
        ),
      ].map((m) => [m[1], m[2].replaceAll("&#39;", "'")]),
    );

  it("marks a bad colour on the Add form and keeps the typed name, role, capabilities and permissions", async () => {
    await mount();
    const res = await harness.post("/role-groups/create", {
      roleId: "rOk",
      name: "  Helpers  ",
      colour: " red",
      capability: ["staff"],
      editPermissions: "1",
      perm: ["ManageMessages"],
    });
    expect(res.status).toBe(422);
    const html = await res.text();
    expect(lines(html)).toEqual({
      "role-group-create-colour-error": "Colour must look like #RRGGBB.",
    });
    // A colour box cannot show text that is not a colour, so the refused value
    // comes back as the empty state, with the swatch marked and linked to its error.
    const swatch = new JSDOM(html).window.document.getElementById(
      "role-group-create-colour",
    );
    expect(swatch?.getAttribute("type")).toBe("color");
    expect(swatch?.getAttribute("name")).toBe("colour");
    expect(swatch?.getAttribute("aria-invalid")).toBe("true");
    expect(swatch?.getAttribute("aria-describedby")).toBe(
      "role-group-create-colour-error",
    );
    expect(
      new JSDOM(html).window.document
        .querySelector<HTMLInputElement>("[name=use_default_colour]")
        ?.hasAttribute("checked"),
    ).toBe(true);
    expect(html).toContain('name="name" maxlength="100"');
    expect(html).toContain('value="  Helpers  "');
    expect(html).toContain('<option value="rOk" selected>');
    expect(html).toMatch(/name="capability" value="staff" checked/);
    expect(html).toMatch(/name="perm" value="ManageMessages" checked/);
    expect(html).toMatch(/name="editPermissions" value="1" checked/);
    expect(svc.create).not.toHaveBeenCalled();
  });

  // A browser without JavaScript posts what the page rendered (the box ticked, the swatch grey).
  it("creates a group with no colour from an untouched Add form, and keeps the colour of an untouched Edit form", async () => {
    await mount();
    const refused = await harness.post("/role-groups/create", {
      name: "x",
      colour: "bad",
    });
    const html = await refused.text();
    const add = renderedFormBody(html, "/role-groups/create", (f) =>
      setField(f, "name", "Helpers2"),
    );
    expect(add).toMatchObject({
      colour: "#99aab5",
      use_default_colour: "true",
    });
    await harness.post("/role-groups/create", add);
    expect(svc.create).toHaveBeenCalledWith(
      "guild-1",
      expect.objectContaining({ name: "Helpers2", colour: null }),
    );
    // The stored group has no colour, so its Edit form is drawn with the box ticked.
    const edit = renderedFormBody(html, "/role-groups/g1/edit");
    expect(edit.use_default_colour).toBe("true");
    await harness.post("/role-groups/g1/edit", edit);
    expect(svc.update).toHaveBeenCalledWith(
      "guild-1",
      "g1",
      expect.objectContaining({ colour: null }),
    );
  });

  // The swatch always posts a colour; the box ("No colour" on Add) wins over it.
  it("creates the group without a colour when the No colour box is ticked", async () => {
    await mount();
    await harness.post("/role-groups/create", {
      name: "x",
      colour: "#99aab5",
      use_default_colour: "true",
    });
    expect(svc.create).toHaveBeenCalledWith(
      "guild-1",
      expect.objectContaining({ colour: null }),
    );
  });

  it("draws a refused colour as the swatch it was sent with, box unticked", async () => {
    svc.create.mockResolvedValue({
      ok: false,
      error: "A group called x already exists.",
      field: "name",
    });
    await mount();
    const res = await harness.post("/role-groups/create", {
      name: "x",
      colour: "#aabbcc",
    });
    expect(res.status).toBe(422);
    const doc = new JSDOM(await res.text()).window.document;
    const swatch = doc.getElementById("role-group-create-colour");
    expect(swatch?.getAttribute("value")).toBe("#aabbcc");
    expect(
      doc
        .querySelector<HTMLInputElement>(
          'form[action$="/role-groups/create"] [name=use_default_colour]',
        )
        ?.hasAttribute("checked"),
    ).toBe(false);
  });

  it("draws the ticked Leave as it is box again on a refused Edit form", async () => {
    svc.update.mockResolvedValue({
      ok: false,
      error: "That name is already in use.",
      field: "name",
    });
    await mount();
    const res = await harness.post("/role-groups/g1/edit", {
      name: "Taken",
      colour: "#aabbcc",
      use_default_colour: "true",
    });
    expect(res.status).toBe(422);
    const doc = new JSDOM(await res.text()).window.document;
    const box = doc
      .getElementById("role-group-edit-g1-colour")
      ?.parentElement?.querySelector("[name=use_default_colour]");
    expect(box?.hasAttribute("checked")).toBe(true);
    expect(box?.parentElement?.textContent).toContain("Leave as it is");
    expect(svc.update).toHaveBeenCalledWith(
      "guild-1",
      "g1",
      expect.objectContaining({ colour: null }),
    );
  });

  it.each([
    ["name", "A group needs a name."],
    [
      "capability",
      "The bot capability can't be combined with other capabilities.",
    ],
    ["roleId", "That role already backs another group."],
  ])("marks the %s field the service refuses", async (field, error) => {
    svc.create.mockResolvedValue({ ok: false, error, field });
    await mount();
    const res = await harness.post("/role-groups/create", { name: "x" });
    expect(res.status).toBe(422);
    expect(lines(await res.text())).toEqual({
      [`role-group-create-${field}-error`]: error,
    });
    expect(mockRecordAudit).toHaveBeenLastCalledWith(
      expect.anything(),
      expect.objectContaining({ result: "failure", errorMessage: error }),
    );
  });

  it("refuses @everyone as a backing role on the role field", async () => {
    await mount();
    const res = await harness.post("/role-groups/create", {
      roleId: "guild-1",
    });
    // The stand-in page has no such role to keep, but the error line is there.
    expect(res.status).toBe(422);
    expect(lines(await res.text())).toEqual({
      "role-group-create-roleId-error": "@everyone can't be a group.",
    });
  });

  it.each([
    [
      "rTop",
      "That role is at or above the bot's own role, so it can't be linked.",
    ],
  ])(
    "keeps the refused backing role (%s) selectable, so a retry is refused again and never creates a role-less group",
    async (roleId, message) => {
      await mount();
      const first = await harness.post("/role-groups/create", { roleId });
      expect(first.status).toBe(422);
      const html = await first.text();
      const option = new RegExp(`<option value="${roleId}"([^>]*)>`).exec(html);
      expect(option?.[1]).toContain("selected");
      expect(option?.[1]).not.toContain("disabled");
      expect(lines(html)["role-group-create-roleId-error"]).toBe(message);
      // The browser posts the selected, enabled option again.
      const retry = await harness.post("/role-groups/create", { roleId });
      expect(retry.status).toBe(422);
      expect(lines(await retry.text())["role-group-create-roleId-error"]).toBe(
        message,
      );
      expect(svc.create).not.toHaveBeenCalled();
    },
  );

  it("keeps a refused role that the service says is taken selectable too", async () => {
    svc.create.mockResolvedValue({
      ok: false,
      error: "That role already backs another group.",
      field: "roleId",
    });
    await mount();
    const res = await harness.post("/role-groups/create", { roleId: "rUsed" });
    expect(res.status).toBe(422);
    const option = /<option value="rUsed"([^>]*)>/.exec(await res.text());
    expect(option?.[1]).toContain("selected");
    expect(option?.[1]).not.toContain("disabled");
  });

  it("keeps a refusal that is not about a field a page flash", async () => {
    svc.create.mockResolvedValue({
      ok: false,
      error: "At most 50 groups are supported.",
    });
    await mount();
    const res = await harness.post("/role-groups/create", { name: "x" });
    expect(res.status).toBe(303);
    expect(flashOf(res).msg).toBe("At most 50 groups are supported.");
  });

  it("keeps an unreadable Discord role a page flash", async () => {
    await mount(makeClient({ fetchFails: true }));
    const res = await harness.post("/role-groups/create", { roleId: "rOk" });
    expect(res.status).toBe(303);
    expect(flashOf(res).msg).toContain("couldn't be read from Discord");
  });

  it("reopens the group's Edit form with the colour marked and the typed values kept", async () => {
    await mount();
    const res = await harness.post("/role-groups/g1/edit", {
      name: " Mod2 ",
      colour: "#12",
      capability: ["admin"],
      syncPolicy: "enforce",
    });
    expect(res.status).toBe(422);
    const html = await res.text();
    expect(html).toContain("<details open><summary>Edit</summary>");
    expect(lines(html)).toEqual({
      "role-group-edit-g1-colour-error": "Colour must look like #RRGGBB.",
    });
    expect(html).toContain('value=" Mod2 "');
    expect(html).toMatch(/name="capability" value="admin" checked/);
    expect(html).toContain('<option value="enforce" selected>');
    expect(svc.update).not.toHaveBeenCalled();
  });

  it("marks the name the service refuses on the Edit form", async () => {
    svc.update.mockResolvedValue({
      ok: false,
      error: "That name is already in use.",
      field: "name",
    });
    await mount();
    const res = await harness.post("/role-groups/g1/edit", { name: "Taken" });
    expect(res.status).toBe(422);
    expect(lines(await res.text())).toEqual({
      "role-group-edit-g1-name-error": "That name is already in use.",
    });
  });

  it("says the group is gone when it was deleted before the refusal", async () => {
    svc.get.mockResolvedValue(null);
    await mount();
    const res = await harness.post("/role-groups/gone/edit", {
      name: "x",
      colour: "red",
    });
    expect(res.status).toBe(303);
    expect(flashOf(res).msg).toBe("That group no longer exists.");
  });

  it("falls back to the flash for a group the page no longer shows", async () => {
    svc.update.mockResolvedValue({
      ok: false,
      error: "That name is already in use.",
      field: "name",
    });
    await mount();
    const res = await harness.post("/role-groups/other/edit", {
      name: "Taken",
    });
    expect(res.status).toBe(303);
    expect(flashOf(res).msg).toBe("Not saved. That name is already in use.");
  });
});

describe("POST /role-groups/:id/edit", () => {
  it("leaves a linked role's permissions alone unless the switch is ticked", async () => {
    await mount();
    await harness.post("/role-groups/g1/edit", {
      name: "Mod",
      perm: ["Administrator"],
    });
    expect(svc.update).toHaveBeenCalledWith(
      "guild-1",
      "g1",
      expect.objectContaining({ permissions: null }),
    );
    await harness.post("/role-groups/g1/edit", {
      name: "Mod",
      editPermissions: "1",
      perm: ["ManageMessages"],
    });
    expect(svc.update).toHaveBeenLastCalledWith(
      "guild-1",
      "g1",
      expect.objectContaining({
        permissions: permissionsFromNames(["ManageMessages"]),
      }),
    );
  });

  it("does not send permissions for a gate-only group", async () => {
    svc.get.mockResolvedValue(group({ gateOnly: true }));
    await mount();
    await harness.post("/role-groups/g1/edit", {
      name: "Boost",
      perm: ["Administrator"],
    });
    expect(svc.update).toHaveBeenCalledWith(
      "guild-1",
      "g1",
      expect.objectContaining({ permissions: undefined, colour: undefined }),
    );
  });

  it("reports a group that is gone", async () => {
    svc.get.mockResolvedValue(null);
    await mount();
    expect(
      flashOf(await harness.post("/role-groups/g1/edit", { name: "x" })).type,
    ).toBe("err");
    expect(svc.update).not.toHaveBeenCalled();
  });
});

describe("POST /role-groups/reorder", () => {
  it("swaps a group with its neighbour", async () => {
    await mount();
    await harness.post("/role-groups/reorder", {
      groupId: "b",
      direction: "up",
    });
    expect(svc.reorder).toHaveBeenCalledWith("guild-1", ["b", "a", "c"]);
    await harness.post("/role-groups/reorder", {
      groupId: "b",
      direction: "down",
    });
    expect(svc.reorder).toHaveBeenLastCalledWith("guild-1", ["a", "c", "b"]);
  });

  it("refuses moves off the ends", async () => {
    await mount();
    const res = await harness.post("/role-groups/reorder", {
      groupId: "a",
      direction: "up",
    });
    expect(flashOf(res).type).toBe("err");
    expect(svc.reorder).not.toHaveBeenCalled();
  });
});

describe("POST /role-groups/:id/delete", () => {
  it("unlinks by default and never touches Discord", async () => {
    await mount();
    const res = await harness.post("/role-groups/g1/delete", {
      roleAction: "keep",
    });
    expect(flashOf(res)).toMatchObject({ type: "ok" });
    expect(flashOf(res).msg).toContain("kept");
    expect(svc.remove).toHaveBeenCalledWith("guild-1", "g1");
    expect(mockPlanDelete).not.toHaveBeenCalled();
    expect(mockStartApply).not.toHaveBeenCalled();
  });

  it("never deletes a role from this route: it sends the admin to the review (#1184)", async () => {
    await mount();
    const res = await harness.post("/role-groups/g1/delete", {
      roleAction: "delete",
      approveRoleDelete: "1",
    });
    expect(flashOf(res).type).toBe("warn");
    expect(flashOf(res).msg).toContain("review");
    expect(svc.remove).not.toHaveBeenCalled();
    expect(mockPlanDelete).not.toHaveBeenCalled();
    expect(mockStartApply).not.toHaveBeenCalled();
  });

  it("says when the group is already gone", async () => {
    svc.get.mockResolvedValue(null);
    await mount();
    const res = await harness.post("/role-groups/g1/delete", {
      roleAction: "keep",
    });
    expect(flashOf(res).type).toBe("err");
    expect(svc.remove).not.toHaveBeenCalled();
  });
});

describe("POST /role-groups/:id/delete-role/apply (#1184)", () => {
  const JOB = "11111111-1111-1111-1111-111111111111";
  const stamp = (offsetMs = 0): string =>
    new Date(Date.now() + offsetMs).toISOString();
  const deletePlan = (over = {}) => ({
    id: "p1",
    errors: [],
    operations: [
      {
        type: "role.delete",
        class: "destructive",
        before: { name: "Helpers", permissions: "0" },
      },
    ],
    ...over,
  });
  const body = (over: Record<string, string> = {}) => {
    const f = {
      planId: "p1",
      approvedAt: stamp(),
      confirmName: "Helpers",
      ...over,
    };
    return {
      reviewToken:
        signRoleDeleteReview(session.sessionId, "g1", f.planId, f.approvedAt) ??
        "",
      ...f,
    };
  };

  const ORIGINAL_SECRET = process.env.WEBUI_SESSION_SECRET;
  beforeEach(() => {
    process.env.WEBUI_SESSION_SECRET = "test-secret-for-role-delete-review-01";
    mockPlanDelete.mockResolvedValue({ plan: deletePlan(), extraErrors: [] });
    mockStartApply.mockReturnValue({ id: JOB });
  });
  afterEach(() => {
    if (ORIGINAL_SECRET === undefined) delete process.env.WEBUI_SESSION_SECRET;
    else process.env.WEBUI_SESSION_SECRET = ORIGINAL_SECRET;
  });

  it("deletes the role through the engine once the plan id and typed name match, then removes the group", async () => {
    const check = jest.fn(async () => []);
    mockRevalidator.mockReturnValue(check);
    await mount();
    const form = body();
    const res = await harness.post("/role-groups/g1/delete-role/apply", form);
    expect(mockPlanDelete).toHaveBeenCalledWith(
      expect.anything(),
      session.discordUserId,
      expect.objectContaining({ id: "g1" }),
      true,
      form.approvedAt,
    );
    expect(mockRevalidator).toHaveBeenCalledWith(
      expect.anything(),
      session.discordUserId,
      expect.objectContaining({ id: "g1" }),
      true,
      form.approvedAt,
    );
    expect(mockStartApply).toHaveBeenCalledWith(deletePlan(), {
      actor: session,
      revalidate: check,
    });
    expect(svc.remove).toHaveBeenCalledWith("guild-1", "g1");
    expect(res.headers.get("location")).toBe(`/admin/role-groups?job=${JOB}`);
    expect(mockRecordAudit).toHaveBeenCalledWith(
      session,
      expect.objectContaining({
        action: "role-groups.delete",
        details: expect.objectContaining({ deleteRole: true }),
        result: "success",
      }),
    );
  });

  it("refuses a refreshed timestamp on an expired review of a KoolBot-created role (no approval in the plan)", async () => {
    svc.get.mockResolvedValue(group({ createdByKoolbot: true }));
    await mount();
    // What the page issued 20 minutes ago.
    const old = body({ approvedAt: stamp(-20 * 60_000) });
    // The same form with only the timestamp moved to now.
    const res = await harness.post("/role-groups/g1/delete-role/apply", {
      ...old,
      approvedAt: stamp(),
    });
    expect(flashOf(res).type).toBe("warn");
    expect(flashOf(res).msg).toContain("can't be verified");
    expect(mockPlanDelete).not.toHaveBeenCalled();
    expect(mockStartApply).not.toHaveBeenCalled();
    expect(svc.remove).not.toHaveBeenCalled();
  });

  it("refuses a missing, tampered or foreign review token without planning", async () => {
    await mount();
    const good = body();
    const forged = [
      "",
      `${good.reviewToken}x`,
      // Issued for another group, session or plan.
      signRoleDeleteReview(session.sessionId, "g2", "p1", good.approvedAt)!,
      signRoleDeleteReview("other-session", "g1", "p1", good.approvedAt)!,
      signRoleDeleteReview(session.sessionId, "g1", "p2", good.approvedAt)!,
    ];
    for (const reviewToken of forged) {
      const res = await harness.post("/role-groups/g1/delete-role/apply", {
        ...good,
        reviewToken,
      });
      expect(flashOf(res).msg).toContain("can't be verified");
    }
    expect(mockPlanDelete).not.toHaveBeenCalled();
    expect(mockStartApply).not.toHaveBeenCalled();
  });

  it("fails closed when no session secret is configured", async () => {
    await mount();
    const form = body();
    delete process.env.WEBUI_SESSION_SECRET;
    const res = await harness.post("/role-groups/g1/delete-role/apply", form);
    expect(flashOf(res).msg).toContain("can't be verified");
    expect(mockStartApply).not.toHaveBeenCalled();
  });

  it("refuses when the typed name does not match, deleting nothing", async () => {
    await mount();
    for (const typed of ["", "helpers", "Other"]) {
      const res = await harness.post(
        "/role-groups/g1/delete-role/apply",
        body({ confirmName: typed }),
      );
      expect(flashOf(res).type).toBe("err");
      expect(flashOf(res).msg).toContain("doesn't match");
    }
    expect(mockStartApply).not.toHaveBeenCalled();
    expect(svc.remove).not.toHaveBeenCalled();
  });

  it("matches the role name exactly, so a name with leading and trailing spaces can be confirmed", async () => {
    mockPlanDelete.mockResolvedValue({
      plan: deletePlan({
        operations: [
          {
            type: "role.delete",
            class: "destructive",
            before: { name: "  Helpers ", permissions: "0" },
          },
        ],
      }),
      extraErrors: [],
    });
    await mount();
    // The trimmed name is not the role's name.
    for (const typed of ["Helpers", "  Helpers", "Helpers ", " Helpers "]) {
      const refused = await harness.post(
        "/role-groups/g1/delete-role/apply",
        body({ confirmName: typed }),
      );
      expect(flashOf(refused).msg).toContain("doesn't match");
    }
    expect(mockStartApply).not.toHaveBeenCalled();
    const ok = await harness.post(
      "/role-groups/g1/delete-role/apply",
      body({ confirmName: "  Helpers " }),
    );
    expect(ok.headers.get("location")).toContain("?job=");
    expect(mockStartApply).toHaveBeenCalledTimes(1);
    expect(svc.remove).toHaveBeenCalledTimes(1);
  });

  it("refuses a plan id the admin did not review", async () => {
    await mount();
    const res = await harness.post(
      "/role-groups/g1/delete-role/apply",
      body({ planId: "old" }),
    );
    expect(flashOf(res).type).toBe("warn");
    expect(mockStartApply).not.toHaveBeenCalled();
    expect(svc.remove).not.toHaveBeenCalled();
  });

  it("refuses an expired, future-dated or malformed review stamp without planning", async () => {
    await mount();
    for (const approvedAt of [
      stamp(-16 * 60_000),
      stamp(10 * 60_000),
      "yesterday",
      "",
    ]) {
      const res = await harness.post(
        "/role-groups/g1/delete-role/apply",
        body({ approvedAt }),
      );
      expect(flashOf(res).type).toBe("warn");
      expect(flashOf(res).msg).toContain("expired");
    }
    expect(mockPlanDelete).not.toHaveBeenCalled();
    expect(mockStartApply).not.toHaveBeenCalled();
  });

  it("keeps the group when a feature uses the role or the plan is blocked", async () => {
    mockPlanDelete.mockResolvedValue({
      plan: deletePlan(),
      extraErrors: [
        { code: "role-in-use", message: "Used by Leaderboard Roles." },
      ],
    });
    await mount();
    const res = await harness.post("/role-groups/g1/delete-role/apply", body());
    expect(flashOf(res).type).toBe("err");
    expect(flashOf(res).msg).toContain("Leaderboard Roles");
    expect(mockStartApply).not.toHaveBeenCalled();
    expect(svc.remove).not.toHaveBeenCalled();
  });

  it("keeps the group when the plan has no role delete step (role already gone)", async () => {
    mockPlanDelete.mockResolvedValue({
      plan: deletePlan({ operations: [] }),
      extraErrors: [],
    });
    await mount();
    const res = await harness.post("/role-groups/g1/delete-role/apply", body());
    expect(flashOf(res).type).toBe("err");
    expect(mockStartApply).not.toHaveBeenCalled();
    expect(svc.remove).not.toHaveBeenCalled();
  });

  it("needs no approval for a role KoolBot created, but still the typed name", async () => {
    svc.get.mockResolvedValue(group({ createdByKoolbot: true }));
    await mount();
    const wrong = await harness.post(
      "/role-groups/g1/delete-role/apply",
      body({ confirmName: "nope" }),
    );
    expect(flashOf(wrong).type).toBe("err");
    expect(mockStartApply).not.toHaveBeenCalled();
    await harness.post("/role-groups/g1/delete-role/apply", body());
    expect(mockPlanDelete).toHaveBeenCalledWith(
      expect.anything(),
      expect.anything(),
      expect.anything(),
      false,
      expect.any(String),
    );
    expect(mockStartApply).toHaveBeenCalled();
  });

  it("keeps the group and says why when the engine refuses to start", async () => {
    mockRevalidator.mockReturnValue(undefined);
    await mount();
    const res = await harness.post("/role-groups/g1/delete-role/apply", body());
    expect(flashOf(res).type).toBe("err");
    expect(flashOf(res).msg).toContain("live-state check");
    expect(svc.remove).not.toHaveBeenCalled();
    expect(mockRecordAudit).toHaveBeenCalledWith(
      session,
      expect.objectContaining({ result: "failure" }),
    );
  });

  it("deletes nothing when Discord can't be reached or the group is gone", async () => {
    await mount(makeClient({ fetchFails: true }));
    const down = await harness.post(
      "/role-groups/g1/delete-role/apply",
      body(),
    );
    expect(flashOf(down).type).toBe("err");
    expect(mockPlanDelete).not.toHaveBeenCalled();
    await harness.close();
    svc.get.mockResolvedValue(null);
    await mount();
    const gone = await harness.post(
      "/role-groups/g1/delete-role/apply",
      body(),
    );
    expect(flashOf(gone).type).toBe("err");
    expect(mockStartApply).not.toHaveBeenCalled();
  });
});

describe("POST /role-groups/apply", () => {
  const built = (over = {}) => ({
    plan: { id: "plan-1", errors: [], operations: [{ id: "op" }] },
    extraErrors: [],
    ...over,
  });

  it("starts the apply as a job when the previewed plan is still current", async () => {
    mockPlanRoles.mockResolvedValue(built());
    mockStartApply.mockReturnValue({
      id: "22222222-2222-2222-2222-222222222222",
    });
    await mount();
    const res = await harness.post("/role-groups/apply", { planId: "plan-1" });
    expect(mockStartApply).toHaveBeenCalledWith(
      expect.objectContaining({ id: "plan-1" }),
      { actor: session },
    );
    expect(res.headers.get("location")).toBe(
      "/admin/role-groups?job=22222222-2222-2222-2222-222222222222",
    );
    expect(mockRecordAudit).toHaveBeenCalledWith(
      session,
      expect.objectContaining({
        action: "role-groups.apply",
        result: "success",
      }),
    );
  });

  it("refuses a stale preview", async () => {
    mockPlanRoles.mockResolvedValue(built());
    await mount();
    const res = await harness.post("/role-groups/apply", { planId: "old" });
    expect(flashOf(res).type).toBe("warn");
    expect(mockStartApply).not.toHaveBeenCalled();
  });

  it("refuses a plan with blocking errors, and an empty one", async () => {
    mockPlanRoles.mockResolvedValue(
      built({
        plan: { id: "plan-1", errors: [{ code: "x" }], operations: [{}] },
      }),
    );
    await mount();
    expect(
      flashOf(await harness.post("/role-groups/apply", { planId: "plan-1" }))
        .type,
    ).toBe("err");
    mockPlanRoles.mockResolvedValue(
      built({ plan: { id: "plan-1", errors: [], operations: [] } }),
    );
    expect(
      flashOf(await harness.post("/role-groups/apply", { planId: "plan-1" }))
        .type,
    ).toBe("err");
    mockPlanRoles.mockResolvedValue(
      built({ extraErrors: [{ code: "groups-do-not-fit" }] }),
    );
    expect(
      flashOf(await harness.post("/role-groups/apply", { planId: "plan-1" }))
        .type,
    ).toBe("err");
    expect(mockStartApply).not.toHaveBeenCalled();
  });

  it("reports a busy engine without crashing", async () => {
    mockPlanRoles.mockResolvedValue(built());
    mockStartApply.mockImplementation(() => {
      throw new Error("Another adoption is running");
    });
    await mount();
    const res = await harness.post("/role-groups/apply", { planId: "plan-1" });
    expect(flashOf(res)).toMatchObject({
      type: "err",
      msg: "Another adoption is running",
    });
  });

  it("does nothing when Discord can't be reached", async () => {
    await mount(makeClient({ fetchFails: true }));
    const res = await harness.post("/role-groups/apply", { planId: "plan-1" });
    expect(flashOf(res).type).toBe("err");
    expect(mockPlanRoles).not.toHaveBeenCalled();
  });
});

describe("role name tracking and sync policy (#1021)", () => {
  it("remembers the linked role's name for drift detection", async () => {
    await mount();
    await harness.post("/role-groups/create", { roleId: "rOk", name: "Crew" });
    expect(svc.create).toHaveBeenCalledWith(
      "guild-1",
      expect.objectContaining({ name: "Crew", roleName: "Helpers" }),
    );
  });

  it("saves a per-group sync policy, or clears it", async () => {
    await mount();
    await harness.post("/role-groups/g1/edit", {
      name: "Mod",
      syncPolicy: "adopt",
    });
    expect(svc.setSyncPolicy).toHaveBeenLastCalledWith(
      "guild-1",
      "g1",
      "adopt",
    );
    await harness.post("/role-groups/g1/edit", { name: "Mod", syncPolicy: "" });
    expect(svc.setSyncPolicy).toHaveBeenLastCalledWith("guild-1", "g1", null);
  });

  it("rejects an unknown policy before saving anything", async () => {
    await mount();
    const res = await harness.post("/role-groups/g1/edit", {
      name: "Mod",
      syncPolicy: "destroy",
    });
    expect(flashOf(res).type).toBe("err");
    expect(svc.update).not.toHaveBeenCalled();
    expect(svc.setSyncPolicy).not.toHaveBeenCalled();
  });
});

describe("POST /role-groups/:id/relink (#1021)", () => {
  const unlinked = (over = {}) =>
    group({ unlinked: true, roleId: null, ...over });

  it("only works on an unlinked group", async () => {
    await mount();
    const res = await harness.post("/role-groups/g1/relink", {
      mode: "recreate",
    });
    expect(flashOf(res).type).toBe("err");
    expect(svc.requestRecreate).not.toHaveBeenCalled();
  });

  it("notices a role deleted while the sync was off, and offers the same choices", async () => {
    svc.get
      .mockResolvedValueOnce(group({ roleId: "gone" }))
      .mockResolvedValueOnce(unlinked({ lostRoleId: "gone" }));
    await mount();
    const res = await harness.post("/role-groups/g1/relink", {
      mode: "recreate",
    });
    expect(svc.markUnlinked).toHaveBeenCalledWith("guild-1", "g1", "gone");
    expect(flashOf(res).type).toBe("ok");
    expect(svc.requestRecreate).toHaveBeenCalledWith("guild-1", "g1");
  });

  it("leaves a group whose role still exists alone", async () => {
    await mount();
    const res = await harness.post("/role-groups/g1/relink", {
      mode: "recreate",
    });
    expect(svc.markUnlinked).not.toHaveBeenCalled();
    expect(flashOf(res).type).toBe("err");
  });

  it("asks for a new role without creating anything in Discord", async () => {
    svc.get.mockResolvedValue(unlinked());
    await mount();
    const res = await harness.post("/role-groups/g1/relink", {
      mode: "recreate",
    });
    expect(flashOf(res).type).toBe("ok");
    expect(svc.requestRecreate).toHaveBeenCalledWith("guild-1", "g1");
    expect(mockStartApply).not.toHaveBeenCalled();
    expect(mockRecordAudit).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ action: "role-groups.relink" }),
    );
  });

  it("never recreates a gate-only group", async () => {
    svc.get.mockResolvedValue(unlinked({ gateOnly: true }));
    await mount();
    const res = await harness.post("/role-groups/g1/relink", {
      mode: "recreate",
    });
    expect(flashOf(res).type).toBe("err");
    expect(svc.requestRecreate).not.toHaveBeenCalled();
  });

  it("links another editable role", async () => {
    svc.get.mockResolvedValue(unlinked());
    await mount();
    const res = await harness.post("/role-groups/g1/relink", {
      mode: "link",
      roleId: "rOk",
    });
    expect(flashOf(res).type).toBe("ok");
    expect(svc.relinkTo).toHaveBeenCalledWith(
      "guild-1",
      "g1",
      "rOk",
      "Helpers",
    );
  });

  it("refuses locked roles, and a managed role for an editable group", async () => {
    svc.get.mockResolvedValue(unlinked());
    await mount();
    for (const roleId of ["rTop", "guild-1", "rBoost", "missing"]) {
      const res = await harness.post("/role-groups/g1/relink", {
        mode: "link",
        roleId,
      });
      expect(flashOf(res).type).toBe("err");
    }
    expect(svc.relinkTo).not.toHaveBeenCalled();
  });

  it("lets a gate-only group link a managed role, and nothing else", async () => {
    svc.get.mockResolvedValue(unlinked({ gateOnly: true }));
    await mount();
    expect(
      flashOf(
        await harness.post("/role-groups/g1/relink", {
          mode: "link",
          roleId: "rOk",
        }),
      ).type,
    ).toBe("err");
    expect(
      flashOf(
        await harness.post("/role-groups/g1/relink", {
          mode: "link",
          roleId: "rBoost",
        }),
      ).type,
    ).toBe("ok");
    expect(svc.relinkTo).toHaveBeenCalledTimes(1);
  });

  it("reports a role that is already taken", async () => {
    svc.get.mockResolvedValue(unlinked());
    svc.relinkTo.mockResolvedValue({ ok: false, error: "already backs" });
    await mount();
    const res = await harness.post("/role-groups/g1/relink", {
      mode: "link",
      roleId: "rOk",
    });
    expect(flashOf(res)).toMatchObject({ type: "err", msg: "already backs" });
  });

  it("rejects an unknown mode", async () => {
    svc.get.mockResolvedValue(unlinked());
    await mount();
    const res = await harness.post("/role-groups/g1/relink", { mode: "x" });
    expect(flashOf(res).type).toBe("err");
  });
});

describe("POST /role-groups/admin-fix/apply (#1021)", () => {
  const fix = (over: Record<string, unknown> = {}) => ({
    plan: {
      id: "fix-1",
      errors: [],
      operations: [{ id: "1" }],
    },
    extraErrors: [],
    report: null,
    ...over,
  });

  it("starts the previewed fix as a job and audits it", async () => {
    mockPlanAdminFix.mockResolvedValue(fix());
    mockStartApply.mockReturnValue({
      id: "11111111-1111-1111-1111-111111111111",
    });
    await mount();
    const res = await harness.post("/role-groups/admin-fix/apply", {
      planId: "fix-1",
      move: ["u1", "u2"],
      drop: "r5",
      grant: "1",
    });
    expect(res.status).toBe(303);
    expect(res.headers.get("location")).toContain("?job=");
    expect(mockPlanAdminFix).toHaveBeenCalledWith(
      expect.anything(),
      expect.any(String),
      {
        moveMemberIds: ["u1", "u2"],
        dropRoleIds: ["r5"],
        grantAdministrator: true,
      },
    );
    expect(mockRecordAudit).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        action: "role-groups.admin-fix",
        result: "success",
      }),
    );
  });

  it("refuses a stale preview, blocking errors and an empty plan", async () => {
    await mount();
    mockPlanAdminFix.mockResolvedValue(fix());
    expect(
      flashOf(
        await harness.post("/role-groups/admin-fix/apply", { planId: "old" }),
      ).type,
    ).toBe("warn");
    mockPlanAdminFix.mockResolvedValue(
      fix({ extraErrors: [{ code: "admin-lockout", message: "x" }] }),
    );
    expect(
      flashOf(
        await harness.post("/role-groups/admin-fix/apply", { planId: "fix-1" }),
      ).type,
    ).toBe("err");
    mockPlanAdminFix.mockResolvedValue(
      fix({ plan: { id: "fix-1", errors: [], operations: [] } }),
    );
    expect(
      flashOf(
        await harness.post("/role-groups/admin-fix/apply", { planId: "fix-1" }),
      ).type,
    ).toBe("err");
    expect(mockStartApply).not.toHaveBeenCalled();
  });

  it("reports a busy engine without crashing", async () => {
    mockPlanAdminFix.mockResolvedValue(fix());
    mockStartApply.mockImplementation(() => {
      throw new Error("busy");
    });
    await mount();
    const res = await harness.post("/role-groups/admin-fix/apply", {
      planId: "fix-1",
    });
    expect(flashOf(res)).toMatchObject({ type: "err", msg: "busy" });
  });

  it("does nothing when Discord can't be reached", async () => {
    await mount(makeClient({ fetchFails: true }));
    const res = await harness.post("/role-groups/admin-fix/apply", {
      planId: "fix-1",
    });
    expect(flashOf(res).type).toBe("err");
    expect(mockPlanAdminFix).not.toHaveBeenCalled();
  });
});
