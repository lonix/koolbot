/**
 * Route tests for the Setup wizard's Access step (#1321).
 *
 * The step maps Discord roles to Admins, Moderators and Event hosts through
 * role groups. What needs pinning is what an admin would only find out by
 * being locked out or left with half a mapping: the picks are held back until
 * Apply, Apply re-checks the live server before the first write, a failed
 * write undoes the ones before it, and a failure after the mapping was
 * written puts the mapping back.
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

const mockRecordAudit = jest.fn<(s: unknown, e: unknown) => Promise<void>>(
  async () => undefined,
);
const mockGetSession = jest.fn<() => unknown>();
const mockSetAccess = jest.fn();
const mockApplyConfiguration = jest.fn<() => Promise<unknown>>();
const mockEndSession = jest.fn();

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
  isDebugMode: (): boolean => false,
}));

jest.unstable_mockModule("../../src/services/wizard-service.js", () => ({
  WizardService: {
    getInstance: (): unknown => ({
      getSession: mockGetSession,
      createSession: jest.fn(),
      addConfiguration: jest.fn(),
      applyConfiguration: mockApplyConfiguration,
      endSession: mockEndSession,
      setAccess: mockSetAccess,
      getConfiguration: (): undefined => undefined,
    }),
  },
}));

jest.unstable_mockModule("../../src/services/config-service.js", () => ({
  ConfigService: {
    getInstance: (): unknown => ({
      get: jest.fn(async () => null),
      getString: jest.fn(async () => ""),
      getNumber: jest.fn(async () => 0),
      getBoolean: jest.fn(async () => false),
      getAll: jest.fn(async () => []),
      registerReloadCallback: jest.fn(),
    }),
  },
}));

const { RoleGroupService } =
  await import("../../src/services/role-group-service.js");
const { createWizardRouter } =
  await import("../../src/web/routes/write/wizard.js");
const { requireCsrf } = await import("../../src/web/csrf.js");
const { requireAdminRoleMiddleware } = await import("../../src/web/session.js");

interface FakeRole {
  id: string;
  name: string;
  managed: boolean;
  position: number;
  permissions: { bitfield: bigint };
}
const role = (
  id: string,
  name: string,
  position: number,
  managed = false,
): FakeRole => ({
  id,
  name,
  managed,
  position,
  permissions: { bitfield: 0n },
});

const MOD = "100000000000000001";
const HOST = "100000000000000002";
const ADMIN = "100000000000000003";
const BOOSTER = "100000000000000004";
const ABOVE_BOT = "100000000000000005";

let roles: Map<string, FakeRole>;
let rolesFetchError: Error | null;
let viewerRoles: string[];
let viewerElevated: boolean;

const client = {
  user: { id: "bot" },
  guilds: {
    fetch: async (): Promise<unknown> => ({
      id: GUILD,
      ownerId: "owner-1",
      roles: {
        fetch: async (): Promise<Map<string, FakeRole>> => {
          if (rolesFetchError) throw rolesFetchError;
          return roles;
        },
        cache: roles,
      },
      members: {
        me: { id: "bot", roles: { highest: { position: 10 } } },
        fetch: async (): Promise<unknown> => ({
          id: "admin-1",
          permissions: { has: (): boolean => viewerElevated },
          roles: {
            cache: new Map(viewerRoles.map((id) => [id, { id }])),
          },
        }),
      },
    }),
  },
} as unknown as Client;

const GUILD = "300000000000000000";
const session = createTestSession({ guildId: GUILD });
let harness: AdminHarness;

type Group = Awaited<
  ReturnType<InstanceType<typeof RoleGroupService>["list"]>
>[number];
const group = (over: Partial<Group>): Group =>
  ({
    id: "g-x",
    name: "x",
    roleId: null,
    rank: 1,
    permissions: null,
    capabilities: [],
    colour: null,
    hoist: false,
    createdByKoolbot: false,
    gateOnly: false,
    roleName: null,
    unlinked: false,
    lostRoleId: null,
    recreateRequestedAt: null,
    syncPolicy: null,
    driftSignature: null,
    createdAt: new Date(0),
    ...over,
  }) as Group;

let stored: Group[];
const svc = RoleGroupService.getInstance();
let createSpy: jest.SpiedFunction<typeof svc.create>;
let updateSpy: jest.SpiedFunction<typeof svc.update>;
let removeSpy: jest.SpiedFunction<typeof svc.remove>;
let listSpy: jest.SpiedFunction<typeof svc.list>;
let nextId = 1;

function wizardState(
  access: unknown,
  selectedFeatures: string[] = ["quotes"],
  configuration: Record<string, unknown> = {},
): Record<string, unknown> {
  return { selectedFeatures, configuration, access };
}

function lastAuditFor(action: string): Record<string, unknown> {
  const hit = [...mockRecordAudit.mock.calls]
    .reverse()
    .find((c) => (c[1] as { action: string }).action === action);
  expect(hit).toBeDefined();
  return (hit as unknown[])[1] as Record<string, unknown>;
}

beforeEach(async () => {
  jest.clearAllMocks();
  nextId = 1;
  rolesFetchError = null;
  viewerElevated = true;
  viewerRoles = [];
  roles = new Map([
    [GUILD, role(GUILD, "@everyone", 0)],
    [MOD, role(MOD, "Moderator", 5)],
    [HOST, role(HOST, "Event host", 4)],
    [ADMIN, role(ADMIN, "Admins", 8)],
    [BOOSTER, role(BOOSTER, "Booster", 3, true)],
    [ABOVE_BOT, role(ABOVE_BOT, "Owner team", 11)],
  ]);
  stored = [];
  mockGetSession.mockReturnValue(null);
  listSpy = jest.spyOn(svc, "list").mockImplementation(async () => [...stored]);
  createSpy = jest
    .spyOn(svc, "create")
    .mockImplementation(async (_g, input) => {
      const created = group({
        id: `g-${nextId++}`,
        name: input.name,
        roleId: input.roleId ?? null,
        roleName: input.roleName ?? null,
        capabilities: [...(input.capabilities ?? [])] as Group["capabilities"],
        rank: stored.length + 1,
      });
      stored.unshift(created);
      return { ok: true, group: created };
    });
  updateSpy = jest
    .spyOn(svc, "update")
    .mockImplementation(async (_g, id, input) => {
      const i = stored.findIndex((g) => g.id === id);
      stored[i] = {
        ...stored[i],
        capabilities: [...(input.capabilities ?? [])] as Group["capabilities"],
      };
      return { ok: true, group: stored[i] };
    });
  removeSpy = jest.spyOn(svc, "remove").mockImplementation(async (_g, id) => {
    const before = stored.length;
    stored = stored.filter((g) => g.id !== id);
    return stored.length < before;
  });
  jest.spyOn(svc, "reorder").mockImplementation(async (_g, ids) => {
    stored = ids.map((id) => stored.find((g) => g.id === id) as Group);
    return { ok: true };
  });
  harness = await startAdminHarness([
    stubRequireSession(session),
    requireAdminRoleMiddleware(),
    requireCsrf,
    createWizardRouter(client),
  ]);
});

afterEach(async () => {
  await harness.close();
  jest.restoreAllMocks();
});

const okConfig = {
  success: true,
  appliedKeys: [],
  rolledBackKeys: [],
  revertFailedKeys: [],
};

describe("GET /wizard?step=access", () => {
  it("shows the current mapping again when the wizard is re-run", async () => {
    stored = [
      group({ id: "g-1", name: "Mods", roleId: MOD, capabilities: ["staff"] }),
      group({ id: "g-2", name: "Hosts", roleId: HOST, capabilities: ["host"] }),
    ];
    mockGetSession.mockReturnValue(wizardState(undefined));
    const html = await (await harness.get("/wizard?step=access")).text();
    expect(html).toMatch(
      new RegExp(`name="roles_staff"[^>]*>[^]*?value="${MOD}" selected`),
    );
    expect(html).toMatch(
      new RegExp(`name="roles_host"[^>]*>[^]*?value="${HOST}" selected`),
    );
    expect(html).toContain('aria-current="step"');
    expect(html).toContain("Command permissions");
  });

  it("prefers picks made earlier in this run over the saved groups", async () => {
    stored = [
      group({ id: "g-1", name: "Mods", roleId: MOD, capabilities: ["staff"] }),
    ];
    mockGetSession.mockReturnValue(
      wizardState({ admin: [], staff: [], host: [HOST] }),
    );
    const html = await (await harness.get("/wizard?step=access")).text();
    expect(html).toMatch(
      new RegExp(`name="roles_host"[^>]*>[^]*?value="${HOST}" selected`),
    );
    expect(html).not.toContain(`value="${MOD}" selected`);
  });

  it("does not offer managed roles or roles at or above the bot", async () => {
    mockGetSession.mockReturnValue(wizardState(undefined));
    const html = await (await harness.get("/wizard?step=access")).text();
    expect(html).not.toContain(`value="${BOOSTER}"`);
    expect(html).not.toContain(`value="${ABOVE_BOT}"`);
    expect(html).toContain(`value="${MOD}"`);
  });

  it("says so, and disables Save, when Discord can't be read", async () => {
    rolesFetchError = new Error("discord down");
    mockGetSession.mockReturnValue(wizardState(undefined));
    const html = await (await harness.get("/wizard?step=access")).text();
    expect(html).toContain("could not be read from Discord");
    expect(html).toMatch(/<button[^>]*disabled[^>]*>Save access/);
    expect(html).not.toContain("<select");
  });

  it("warns that Events is on with nobody to host", async () => {
    mockGetSession.mockReturnValue(
      wizardState({ admin: [], staff: [], host: [] }, ["events"], {
        "events.enabled": true,
      }),
    );
    const html = await (await harness.get("/wizard?step=access")).text();
    expect(html).toContain("Events is on and nobody can host yet.");
  });

  it("does not warn once an Event host role is picked", async () => {
    mockGetSession.mockReturnValue(
      wizardState({ admin: [], staff: [], host: [HOST] }, ["events"], {
        "events.enabled": true,
      }),
    );
    const html = await (await harness.get("/wizard?step=access")).text();
    expect(html).not.toContain("nobody can host yet");
  });
});

describe("POST /wizard/access", () => {
  it("keeps the picks in the wizard session and writes nothing", async () => {
    mockGetSession.mockReturnValue(wizardState(undefined));
    const res = await harness.post("/wizard/access", {
      roles_staff: MOD,
      roles_host: [HOST, "not-an-id"],
    });
    expect(res.headers.get("location")).toBe("/admin/wizard?step=0");
    expect(mockSetAccess).toHaveBeenCalledWith(
      session.discordUserId,
      session.guildId,
      { admin: [], staff: [MOD], host: [HOST] },
    );
    expect(createSpy).not.toHaveBeenCalled();
    expect(updateSpy).not.toHaveBeenCalled();
    expect(lastAuditFor("wizard.access")).toMatchObject({ result: "success" });
  });

  it("lists a role in its highest scope only", async () => {
    mockGetSession.mockReturnValue(wizardState(undefined));
    await harness.post("/wizard/access", {
      roles_admin: ADMIN,
      roles_staff: ADMIN,
    });
    expect(mockSetAccess).toHaveBeenCalledWith(
      session.discordUserId,
      session.guildId,
      { admin: [ADMIN], staff: [], host: [] },
    );
  });

  it.each([
    ["a managed role", BOOSTER, "managed by an integration"],
    ["a role at or above the bot", ABOVE_BOT, "at or above the bot"],
    ["a role that does not exist", "100000000000000099", "no longer exists"],
    ["@everyone", GUILD, "@everyone can't be mapped"],
  ])("refuses %s and stays on the step", async (_n, id, text) => {
    mockGetSession.mockReturnValue(wizardState(undefined));
    const res = await harness.post("/wizard/access", { roles_host: id });
    const location = res.headers.get("location") ?? "";
    expect(location).toContain("step=access");
    expect(parseFlashRedirect(location).msg).toContain(text);
    expect(mockSetAccess).not.toHaveBeenCalled();
    expect(lastAuditFor("wizard.access")).toMatchObject({ result: "failure" });
  });

  it("saves nothing when Discord can't be read", async () => {
    rolesFetchError = new Error("discord down");
    mockGetSession.mockReturnValue(wizardState(undefined));
    const res = await harness.post("/wizard/access", { roles_host: HOST });
    expect(parseFlashRedirect(res.headers.get("location")).msg).toContain(
      "nothing was saved",
    );
    expect(mockSetAccess).not.toHaveBeenCalled();
  });

  it("refuses a role that backs a bot group", async () => {
    stored = [
      group({ id: "g-1", name: "Bots", roleId: MOD, capabilities: ["bot"] }),
    ];
    mockGetSession.mockReturnValue(wizardState(undefined));
    const res = await harness.post("/wizard/access", { roles_staff: MOD });
    expect(parseFlashRedirect(res.headers.get("location")).msg).toContain(
      "bot group",
    );
    expect(mockSetAccess).not.toHaveBeenCalled();
  });

  it("refuses to remove the admin role the signed-in admin holds", async () => {
    viewerElevated = false;
    viewerRoles = [ADMIN];
    stored = [
      group({
        id: "g-1",
        name: "Admins",
        roleId: ADMIN,
        capabilities: ["admin", "staff"],
      }),
    ];
    mockGetSession.mockReturnValue(wizardState(undefined));
    const res = await harness.post("/wizard/access", { roles_staff: MOD });
    expect(parseFlashRedirect(res.headers.get("location")).msg).toContain(
      "admin role you sign in with",
    );
    expect(mockSetAccess).not.toHaveBeenCalled();
  });

  it("sends the operator back to the start when the session expired", async () => {
    const res = await harness.post("/wizard/access", { roles_host: HOST });
    expect(parseFlashRedirect(res.headers.get("location")).type).toBe("warn");
    expect(mockSetAccess).not.toHaveBeenCalled();
  });
});

describe("GET /wizard?step=confirm", () => {
  it("lists the role groups Apply will write", async () => {
    mockGetSession.mockReturnValue(
      wizardState({ admin: [], staff: [MOD], host: [] }),
    );
    const html = await (await harness.get("/wizard?step=confirm")).text();
    expect(html).toContain('Creates the role group "Moderator"');
    expect(html).toContain("@Moderator");
    expect(html).not.toMatch(/<button[^>]*disabled[^>]*>Apply/);
  });

  it("blocks Apply and says why when the mapping is no longer valid", async () => {
    roles.delete(MOD);
    mockGetSession.mockReturnValue(
      wizardState({ admin: [], staff: [MOD], host: [] }),
    );
    const html = await (await harness.get("/wizard?step=confirm")).text();
    expect(html).toContain("can&#39;t be applied");
    expect(html).toMatch(/<button[^>]*disabled[^>]*>Apply/);
  });

  it("blocks Apply when the server can't be read", async () => {
    rolesFetchError = new Error("discord down");
    mockGetSession.mockReturnValue(
      wizardState({ admin: [], staff: [MOD], host: [] }),
    );
    const html = await (await harness.get("/wizard?step=confirm")).text();
    expect(html).toContain("can&#39;t be checked");
    expect(html).toMatch(/<button[^>]*disabled[^>]*>Apply/);
  });

  it("offers Apply when only the role mapping changed", async () => {
    mockGetSession.mockReturnValue(
      wizardState({ admin: [], staff: [], host: [HOST] }, []),
    );
    const html = await (await harness.get("/wizard?step=confirm")).text();
    expect(html).not.toMatch(/<button[^>]*disabled[^>]*>Apply/);
  });
});

describe("POST /wizard/apply with a role mapping", () => {
  const picks = { admin: [], staff: [MOD], host: [HOST] };

  it("writes each group, audits each, then applies the settings", async () => {
    mockGetSession.mockReturnValue(wizardState(picks));
    mockApplyConfiguration.mockResolvedValue(okConfig);
    const res = await harness.post("/wizard/apply");
    const flash = parseFlashRedirect(res.headers.get("location"));
    expect(flash.type).toBe("ok");
    expect(flash.msg).toContain("2 role group changes");
    expect(createSpy).toHaveBeenCalledTimes(2);
    expect(createSpy).toHaveBeenCalledWith(
      GUILD,
      expect.objectContaining({
        roleId: MOD,
        capabilities: ["staff"],
        permissions: null,
      }),
    );
    expect(createSpy).toHaveBeenCalledWith(
      GUILD,
      expect.objectContaining({ roleId: HOST, capabilities: ["host"] }),
    );
    const audited = mockRecordAudit.mock.calls.filter(
      (c) => (c[1] as { action: string }).action === "wizard.access.group",
    );
    expect(audited).toHaveLength(2);
    expect(mockApplyConfiguration).toHaveBeenCalled();
    expect(mockEndSession).toHaveBeenCalled();
  });

  it("leaves a role that is already mapped alone and creates only the new group", async () => {
    stored = [
      group({
        id: "g-1",
        name: "Mods",
        roleId: MOD,
        capabilities: ["staff"],
      }),
    ];
    mockGetSession.mockReturnValue(
      wizardState({ admin: [], staff: [MOD], host: [HOST] }),
    );
    mockApplyConfiguration.mockResolvedValue(okConfig);
    await harness.post("/wizard/apply");
    expect(updateSpy).not.toHaveBeenCalled(); // Moderator is already mapped
    expect(createSpy).toHaveBeenCalledTimes(1); // only Event host is new
  });

  it("drops a scope from a role that was unpicked, keeping its group", async () => {
    stored = [
      group({ id: "g-1", name: "Hosts", roleId: HOST, capabilities: ["host"] }),
    ];
    mockGetSession.mockReturnValue(
      wizardState({ admin: [], staff: [], host: [] }),
    );
    mockApplyConfiguration.mockResolvedValue(okConfig);
    await harness.post("/wizard/apply");
    expect(updateSpy).toHaveBeenCalledWith(
      GUILD,
      "g-1",
      expect.objectContaining({ capabilities: [] }),
    );
    expect(removeSpy).not.toHaveBeenCalled();
  });

  it("does not touch role groups when the Access step was not saved", async () => {
    mockGetSession.mockReturnValue(wizardState(undefined));
    mockApplyConfiguration.mockResolvedValue(okConfig);
    await harness.post("/wizard/apply");
    expect(listSpy).not.toHaveBeenCalled();
    expect(createSpy).not.toHaveBeenCalled();
    expect(mockApplyConfiguration).toHaveBeenCalled();
  });

  it("writes nothing and applies nothing when Discord can't be read", async () => {
    rolesFetchError = new Error("discord down");
    mockGetSession.mockReturnValue(wizardState(picks));
    const res = await harness.post("/wizard/apply");
    const flash = parseFlashRedirect(res.headers.get("location"));
    expect(flash.type).toBe("err");
    expect(flash.msg).toContain("Nothing was applied");
    expect(createSpy).not.toHaveBeenCalled();
    expect(mockApplyConfiguration).not.toHaveBeenCalled();
    expect(mockEndSession).not.toHaveBeenCalled();
    expect(lastAuditFor("wizard.apply")).toMatchObject({ result: "failure" });
  });

  it("checks the roles again and writes nothing when one went away since the review", async () => {
    roles.delete(HOST);
    mockGetSession.mockReturnValue(wizardState(picks));
    const res = await harness.post("/wizard/apply");
    const flash = parseFlashRedirect(res.headers.get("location"));
    expect(flash.msg).toContain("no longer exists");
    expect(createSpy).not.toHaveBeenCalled();
    expect(mockApplyConfiguration).not.toHaveBeenCalled();
  });

  it("undoes the first group when the second write throws, and never reports success", async () => {
    mockGetSession.mockReturnValue(wizardState(picks));
    createSpy
      .mockImplementationOnce(async (_g, input) => {
        const created = group({
          id: "g-first",
          name: input.name,
          roleId: input.roleId ?? null,
          capabilities: [
            ...(input.capabilities ?? []),
          ] as Group["capabilities"],
        });
        stored.unshift(created);
        return { ok: true, group: created };
      })
      .mockRejectedValueOnce(new Error("mongo down"));
    const res = await harness.post("/wizard/apply");
    const flash = parseFlashRedirect(res.headers.get("location"));
    expect(flash.type).toBe("err");
    expect(flash.msg).toContain("mongo down");
    expect(flash.msg).toContain("undone");
    expect(removeSpy).toHaveBeenCalledWith(GUILD, "g-first");
    expect(stored).toHaveLength(0);
    expect(mockApplyConfiguration).not.toHaveBeenCalled();
    expect(mockEndSession).not.toHaveBeenCalled();
    expect(lastAuditFor("wizard.apply")).toMatchObject({ result: "failure" });
    expect(lastAuditFor("wizard.access.rollback")).toMatchObject({
      result: "success",
    });
    expect(
      mockRecordAudit.mock.calls.some(
        (c) =>
          (c[1] as { action: string; result: string }).action ===
            "wizard.access.group" &&
          (c[1] as { result: string }).result === "failure",
      ),
    ).toBe(true);
  });

  it("treats a refused group write like a thrown one", async () => {
    mockGetSession.mockReturnValue(wizardState(picks));
    createSpy.mockResolvedValueOnce({
      ok: false,
      error: "That name is already in use.",
    });
    const res = await harness.post("/wizard/apply");
    const flash = parseFlashRedirect(res.headers.get("location"));
    expect(flash.type).toBe("err");
    expect(flash.msg).toContain("already in use");
    expect(flash.msg).toContain("No role group was written");
    expect(mockApplyConfiguration).not.toHaveBeenCalled();
  });

  it("says which writes are still live when an undo fails too", async () => {
    mockGetSession.mockReturnValue(wizardState(picks));
    // First write succeeds, second throws, and the undo fails.
    createSpy
      .mockImplementationOnce(async (_g, input) => {
        const created = group({
          id: "g-first",
          name: input.name,
          roleId: input.roleId ?? null,
          capabilities: [
            ...(input.capabilities ?? []),
          ] as Group["capabilities"],
        });
        stored.unshift(created);
        return { ok: true, group: created };
      })
      .mockRejectedValueOnce(new Error("mongo down"));
    removeSpy.mockRejectedValue(new Error("still down"));
    const res = await harness.post("/wizard/apply");
    const flash = parseFlashRedirect(res.headers.get("location"));
    expect(flash.type).toBe("err");
    expect(flash.msg).toContain("could not be undone and are live");
    expect(flash.msg).toContain("Moderator");
    expect(lastAuditFor("wizard.access.rollback")).toMatchObject({
      result: "failure",
    });
  });

  it("puts the mapping back when the settings fail to apply", async () => {
    mockGetSession.mockReturnValue(wizardState(picks));
    mockApplyConfiguration.mockResolvedValue({
      success: false,
      appliedKeys: [],
      failedKey: "quotes.enabled",
      errorMessage: "write failed",
      rolledBackKeys: [],
      revertFailedKeys: [],
    });
    const res = await harness.post("/wizard/apply");
    const location = res.headers.get("location") ?? "";
    expect(location).toContain("step=confirm");
    const flash = parseFlashRedirect(location);
    expect(flash.type).toBe("err");
    expect(flash.msg).toContain("role mapping was undone");
    expect(stored).toHaveLength(0);
    expect(mockEndSession).not.toHaveBeenCalled();
  });

  it("puts the mapping back when applying the settings throws", async () => {
    mockGetSession.mockReturnValue(wizardState(picks));
    mockApplyConfiguration.mockRejectedValue(new Error("mongo down"));
    const res = await harness.post("/wizard/apply");
    const flash = parseFlashRedirect(res.headers.get("location"));
    expect(flash.type).toBe("err");
    expect(flash.msg).toContain("mongo down");
    expect(flash.msg).toContain("role mapping was undone");
    expect(stored).toHaveLength(0);
  });

  it("restores the old capabilities of a group it had changed", async () => {
    stored = [
      group({
        id: "g-1",
        name: "Mods",
        roleId: MOD,
        capabilities: ["staff"],
      }),
    ];
    mockGetSession.mockReturnValue(
      wizardState({ admin: [], staff: [MOD], host: [MOD] }),
    );
    mockApplyConfiguration.mockResolvedValue({
      success: false,
      appliedKeys: [],
      errorMessage: "write failed",
      rolledBackKeys: [],
      revertFailedKeys: [],
    });
    await harness.post("/wizard/apply");
    expect(stored[0].capabilities).toEqual(["staff"]);
    expect(updateSpy).toHaveBeenCalledTimes(2);
  });

  it("refuses to drop the admin role the applying admin signs in with", async () => {
    viewerElevated = false;
    viewerRoles = [ADMIN];
    stored = [
      group({
        id: "g-1",
        name: "Admins",
        roleId: ADMIN,
        capabilities: ["admin", "staff"],
      }),
    ];
    mockGetSession.mockReturnValue(
      wizardState({ admin: [], staff: [MOD], host: [] }),
    );
    const res = await harness.post("/wizard/apply");
    expect(parseFlashRedirect(res.headers.get("location")).msg).toContain(
      "admin role you sign in with",
    );
    expect(updateSpy).not.toHaveBeenCalled();
    expect(mockApplyConfiguration).not.toHaveBeenCalled();
  });
});
