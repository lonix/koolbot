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
jest.unstable_mockModule("../../src/services/role-group-adoption.js", () => ({
  planRoleGroups: mockPlanRoles,
  planRoleDeletion: mockPlanDelete,
  planAdminFix: mockPlanAdminFix,
  planIsApplicable: (p: {
    plan: { errors: unknown[] };
    extraErrors: unknown[];
  }) => p.plan.errors.length === 0 && p.extraErrors.length === 0,
}));
const mockStartApply = jest.fn<(...a: any[]) => any>();
jest.unstable_mockModule(
  "../../src/services/server-adoption-service.js",
  () => ({
    ServerAdoptionService: {
      getInstance: async () => ({ startApply: mockStartApply }),
    },
  }),
);

const { createRoleGroupsRouter, permissionsFromNames } =
  await import("../../src/web/routes/write/role-groups.js");
const { requireCsrf } = await import("../../src/web/csrf.js");
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

  it("needs an explicit approval to delete a pre-existing role", async () => {
    await mount();
    const res = await harness.post("/role-groups/g1/delete", {
      roleAction: "delete",
    });
    expect(flashOf(res).type).toBe("err");
    expect(svc.remove).not.toHaveBeenCalled();
    expect(mockStartApply).not.toHaveBeenCalled();
  });

  it("deletes an approved role through the engine and then removes the group", async () => {
    const plan = { id: "p", errors: [], operations: [{}] };
    mockPlanDelete.mockResolvedValue({ plan, extraErrors: [] });
    mockStartApply.mockReturnValue({
      id: "11111111-1111-1111-1111-111111111111",
    });
    await mount();
    const res = await harness.post("/role-groups/g1/delete", {
      roleAction: "delete",
      approveRoleDelete: "1",
    });
    expect(mockPlanDelete).toHaveBeenCalledWith(
      expect.anything(),
      session.discordUserId,
      expect.objectContaining({ id: "g1" }),
      true,
    );
    expect(mockStartApply).toHaveBeenCalledWith(plan, { actor: session });
    expect(svc.remove).toHaveBeenCalled();
    expect(res.headers.get("location")).toBe(
      "/admin/role-groups?job=11111111-1111-1111-1111-111111111111",
    );
  });

  it("lets a role KoolBot created go without approval", async () => {
    svc.get.mockResolvedValue(group({ createdByKoolbot: true }));
    mockPlanDelete.mockResolvedValue({ plan: { errors: [] }, extraErrors: [] });
    mockStartApply.mockReturnValue({
      id: "11111111-1111-1111-1111-111111111111",
    });
    await mount();
    await harness.post("/role-groups/g1/delete", { roleAction: "delete" });
    expect(mockPlanDelete).toHaveBeenCalledWith(
      expect.anything(),
      expect.anything(),
      expect.anything(),
      false,
    );
    expect(mockStartApply).toHaveBeenCalled();
  });

  it("keeps the group when the role can't be deleted (e.g. a feature uses it)", async () => {
    mockPlanDelete.mockResolvedValue({
      plan: { errors: [] },
      extraErrors: [
        { code: "role-in-use", message: "Used by Leaderboard Roles." },
      ],
    });
    await mount();
    const res = await harness.post("/role-groups/g1/delete", {
      roleAction: "delete",
      approveRoleDelete: "1",
    });
    expect(flashOf(res).type).toBe("err");
    expect(flashOf(res).msg).toContain("Leaderboard Roles");
    expect(svc.remove).not.toHaveBeenCalled();
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
