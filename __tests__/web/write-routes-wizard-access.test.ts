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
const mockAddConfiguration = jest.fn();
const mockApplyConfiguration = jest.fn<() => Promise<unknown>>();
const mockEndSession = jest.fn();
const mockGetBoolean = jest.fn<
  (key: string, fallback: boolean) => Promise<boolean>
>(async () => false);

jest.unstable_mockModule("../../src/web/audit.js", () => ({
  recordAudit: mockRecordAudit,
  recordAuditOrThrow: mockRecordAudit,
}));

const mockStartApply = jest.fn<(...a: unknown[]) => { id: string }>();
jest.unstable_mockModule(
  "../../src/services/server-adoption-service.js",
  () => ({
    ServerAdoptionService: {
      getInstance: async (): Promise<unknown> => ({
        startApply: mockStartApply,
      }),
    },
  }),
);

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
      addConfiguration: mockAddConfiguration,
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
      getBoolean: mockGetBoolean,
      getAll: jest.fn(async () => []),
      registerReloadCallback: jest.fn(),
    }),
  },
}));

const { accessFingerprint, diffAccess } =
  await import("../../src/services/wizard-access.js");
type AccessSelection =
  import("../../src/services/wizard-access.js").AccessSelection;
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
  color: number;
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
  color: 0,
});

const MOD = "100000000000000001";
const HOST = "100000000000000002";
const ADMIN = "100000000000000003";
const BOOSTER = "100000000000000004";
const ABOVE_BOT = "100000000000000005";
const BOTROLE = "100000000000000006";
const JOB = "11111111-1111-4111-8111-111111111111";

let roles: Map<string, FakeRole>;
let rolesFetchError: Error | null;
let botCanManageRoles = true;

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
        fetchMemberCounts: async (): Promise<Map<string, number>> => new Map(),
      },
      members: {
        me: {
          id: "bot",
          roles: {
            highest: { position: 10 },
            cache: new Map([[BOTROLE, {}]]),
          },
          permissions: { has: (): boolean => botCanManageRoles },
        },
        fetch: async (): Promise<unknown> => ({
          roles: { cache: new Map() },
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
let featureUsesSpy: jest.SpiedFunction<typeof svc.featureRoleUses>;
let listSpy: jest.SpiedFunction<typeof svc.list>;
let nextId = 1;

function wizardState(
  access: unknown,
  selectedFeatures: string[] = ["quotes"],
  configuration: Record<string, unknown> = {},
  createHost = false,
): Record<string, unknown> {
  return { selectedFeatures, configuration, access, createHost };
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
  mockGetBoolean.mockImplementation(async () => false);
  nextId = 1;
  rolesFetchError = null;
  roles = new Map([
    [GUILD, role(GUILD, "@everyone", 0)],
    [MOD, role(MOD, "Moderator", 5)],
    [HOST, role(HOST, "Event host", 4)],
    [ADMIN, role(ADMIN, "Admins", 8)],
    [BOOSTER, role(BOOSTER, "Booster", 3, true)],
    [ABOVE_BOT, role(ABOVE_BOT, "Owner team", 11)],
    [
      BOTROLE,
      {
        ...role(BOTROLE, "KoolBot", 10, true),
        permissions: { bitfield: 1n << 28n }, // Manage Roles
      },
    ],
  ]);
  botCanManageRoles = true;
  mockStartApply.mockReset();
  mockStartApply.mockReturnValue({ id: JOB });
  stored = [];
  mockGetSession.mockReturnValue(null);
  jest.spyOn(svc, "groupBackedRoles").mockResolvedValue([]);
  featureUsesSpy = jest
    .spyOn(svc, "featureRoleUses")
    .mockResolvedValue(new Map());
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
        rank: input.rank ?? stored.length + 1,
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

/** Apply as the Review form posts it: with the fingerprint of what Review showed. */
function postApply(fingerprint?: string): ReturnType<AdminHarness["post"]> {
  const state = mockGetSession() as { access?: AccessSelection } | null;
  const shown =
    fingerprint ??
    (state?.access
      ? accessFingerprint(diffAccess(stored, [...roles.values()], state.access))
      : "");
  return harness.post("/wizard/apply", { accessFingerprint: shown });
}

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

  it("warns for a feature being configured that is already on in the store", async () => {
    mockGetBoolean.mockImplementation(async (key) => key === "events.enabled");
    mockGetSession.mockReturnValue(
      wizardState({ admin: [], staff: [], host: [] }, ["events"]),
    );
    const html = await (await harness.get("/wizard?step=access")).text();
    expect(html).toContain("Events is on and nobody can host yet.");
  });

  it("does not warn for a stored-on feature the wizard run leaves unticked, since Apply switches it off", async () => {
    mockGetBoolean.mockImplementation(async (key) => key === "events.enabled");
    mockGetSession.mockReturnValue(
      wizardState({ admin: [], staff: [], host: [] }, ["quotes"]),
    );
    const html = await (await harness.get("/wizard?step=access")).text();
    expect(html).not.toContain("nobody can host yet");
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
      false,
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
      false,
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

  it("refuses to remove admin from a group, even for the owner", async () => {
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
      "Role groups",
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

  it("posts the fingerprint of what it shows back with Apply", async () => {
    mockGetSession.mockReturnValue(
      wizardState({ admin: [], staff: [MOD], host: [] }),
    );
    const html = await (await harness.get("/wizard?step=confirm")).text();
    const want = accessFingerprint(
      diffAccess(stored, [...roles.values()], {
        admin: [],
        staff: [MOD],
        host: [],
      }),
    );
    expect(html).toContain(`name="accessFingerprint" value="${want}"`);
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
    const res = await postApply();
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
    await postApply();
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
    await postApply();
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
    await postApply();
    expect(listSpy).not.toHaveBeenCalled();
    expect(createSpy).not.toHaveBeenCalled();
    expect(mockApplyConfiguration).toHaveBeenCalled();
  });

  it("writes nothing and applies nothing when Discord can't be read", async () => {
    rolesFetchError = new Error("discord down");
    mockGetSession.mockReturnValue(wizardState(picks));
    const res = await postApply();
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
    const res = await postApply();
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
    const res = await postApply();
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
    const res = await postApply();
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
    const res = await postApply();
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
    const res = await postApply();
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
    const res = await postApply();
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
    await postApply();
    expect(stored[0].capabilities).toEqual(["staff"]);
    expect(updateSpy).toHaveBeenCalledTimes(2);
  });

  it("refuses to remove admin from a group at Apply and writes nothing", async () => {
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
    const res = await postApply();
    expect(parseFlashRedirect(res.headers.get("location")).msg).toContain(
      "Role groups",
    );
    expect(updateSpy).not.toHaveBeenCalled();
    expect(createSpy).not.toHaveBeenCalled();
    expect(mockApplyConfiguration).not.toHaveBeenCalled();
  });

  it("applies nothing when the groups changed after Review, and says to review again", async () => {
    mockGetSession.mockReturnValue(
      wizardState({ admin: [], staff: [MOD], host: [] }),
    );
    const reviewed = accessFingerprint(
      diffAccess(stored, [...roles.values()], {
        admin: [],
        staff: [MOD],
        host: [],
      }),
    );
    // Another admin maps Event host to a group while Review is open.
    stored = [
      group({ id: "g-9", name: "Hosts", roleId: HOST, capabilities: ["host"] }),
    ];
    const res = await postApply(reviewed);
    const flash = parseFlashRedirect(res.headers.get("location"));
    expect(flash.msg).toContain("changed since you opened Review");
    expect(createSpy).not.toHaveBeenCalled();
    expect(updateSpy).not.toHaveBeenCalled();
    expect(removeSpy).not.toHaveBeenCalled();
    expect(mockApplyConfiguration).not.toHaveBeenCalled();
  });

  it("applies nothing when Review's fingerprint is missing", async () => {
    mockGetSession.mockReturnValue(
      wizardState({ admin: [], staff: [MOD], host: [] }),
    );
    const res = await harness.post("/wizard/apply");
    expect(parseFlashRedirect(res.headers.get("location")).msg).toContain(
      "Review",
    );
    expect(createSpy).not.toHaveBeenCalled();
  });
});

describe("a role used by a feature setting in the same run", () => {
  const picks = { admin: [], staff: [MOD], host: [] };

  it("is refused on the Access step when a pending setting already uses it", async () => {
    mockGetSession.mockReturnValue(
      wizardState(undefined, ["birthdays"], { "birthdays.role_id": MOD }),
    );
    const res = await harness.post("/wizard/access", { roles_staff: MOD });
    expect(res.headers.get("location")).toContain("step=access");
    expect(parseFlashRedirect(res.headers.get("location")).msg).toContain(
      "birthdays.role_id",
    );
    expect(mockSetAccess).not.toHaveBeenCalled();
  });

  it("is dropped from the birthday step when the Access step maps it", async () => {
    mockGetSession.mockReturnValue(wizardState(picks, ["birthdays"]));
    const res = await harness.post("/wizard/step/0", {
      "value_birthdays.enabled": "true",
      "value_birthdays.role_id": MOD,
    });
    expect(parseFlashRedirect(res.headers.get("location")).msg).toContain(
      "Access step",
    );
    expect(mockAddConfiguration.mock.calls.map((c) => c[2])).not.toContain(
      "birthdays.role_id",
    );
  });

  it("blocks Apply before any group is written", async () => {
    mockGetSession.mockReturnValue(
      wizardState(picks, ["birthdays"], { "birthdays.role_id": MOD }),
    );
    const res = await postApply();
    const flash = parseFlashRedirect(res.headers.get("location"));
    expect(flash.msg).toContain("Nothing was applied");
    expect(createSpy).not.toHaveBeenCalled();
    expect(mockApplyConfiguration).not.toHaveBeenCalled();
  });
});

describe("a role a feature hands out to members", () => {
  const picks = { admin: [], staff: [MOD], host: [] };

  it("can't be mapped when a saved setting hands it out (rules acceptance role)", async () => {
    featureUsesSpy.mockResolvedValue(new Map([[MOD, ["Rules"]]]));
    mockGetSession.mockReturnValue(wizardState(undefined));
    const res = await harness.post("/wizard/access", { roles_staff: MOD });
    expect(res.headers.get("location")).toContain("step=access");
    expect(parseFlashRedirect(res.headers.get("location")).msg).toContain(
      "handed out by Rules",
    );
    expect(mockSetAccess).not.toHaveBeenCalled();
  });

  it("is checked again at Apply, so a setting saved after the Access step still blocks", async () => {
    mockGetSession.mockReturnValue(wizardState(picks));
    featureUsesSpy.mockResolvedValue(new Map([[MOD, ["Rules"]]]));
    const res = await postApply();
    expect(parseFlashRedirect(res.headers.get("location")).msg).toContain(
      "handed out by Rules",
    );
    expect(createSpy).not.toHaveBeenCalled();
    expect(mockApplyConfiguration).not.toHaveBeenCalled();
  });

  it("can't be promoted from Moderators to Admins at Apply, and nothing is written", async () => {
    stored = [
      group({ id: "g-1", name: "Mods", roleId: MOD, capabilities: ["staff"] }),
    ];
    featureUsesSpy.mockResolvedValue(new Map([[MOD, ["Rules"]]]));
    mockGetSession.mockReturnValue(
      wizardState({ admin: [MOD], staff: [], host: [] }),
    );
    const res = await postApply();
    expect(parseFlashRedirect(res.headers.get("location")).msg).toContain(
      "can't gain Admin",
    );
    expect(updateSpy).not.toHaveBeenCalled();
    expect(mockApplyConfiguration).not.toHaveBeenCalled();
  });

  it("can't gain Event host on top of Moderator when a feature hands it out", async () => {
    stored = [
      group({ id: "g-1", name: "Mods", roleId: MOD, capabilities: ["staff"] }),
    ];
    featureUsesSpy.mockResolvedValue(new Map([[MOD, ["Rules"]]]));
    mockGetSession.mockReturnValue(wizardState(undefined));
    const res = await harness.post("/wizard/access", {
      roles_staff: MOD,
      roles_host: MOD,
    });
    expect(parseFlashRedirect(res.headers.get("location")).msg).toContain(
      "gain Event host",
    );
    expect(mockSetAccess).not.toHaveBeenCalled();
  });

  it("leaves a role that is already mapped alone", async () => {
    stored = [
      group({ id: "g-1", name: "Mods", roleId: MOD, capabilities: ["staff"] }),
    ];
    featureUsesSpy.mockResolvedValue(new Map([[MOD, ["Rules"]]]));
    mockGetSession.mockReturnValue(wizardState(undefined));
    const res = await harness.post("/wizard/access", { roles_staff: MOD });
    expect(res.headers.get("location")).toBe("/admin/wizard?step=0");
  });

  it.each([
    ["rules.role_id", "rules"],
    ["moderation.raid.quarantine_role_id", "moderation"],
  ])(
    "can't be mapped when %s in this run uses it, at the Access step",
    async (key, feature) => {
      mockGetSession.mockReturnValue(
        wizardState(undefined, [feature], { [key]: MOD }),
      );
      const res = await harness.post("/wizard/access", { roles_staff: MOD });
      expect(parseFlashRedirect(res.headers.get("location")).msg).toContain(
        key,
      );
      expect(mockSetAccess).not.toHaveBeenCalled();
    },
  );

  it("is dropped from the rules settings step (the wizard has no raid quarantine step)", async () => {
    mockGetSession.mockReturnValue(wizardState(picks, ["rules"]));
    const res = await harness.post("/wizard/step/0", {
      "value_rules.enabled": "true",
      "value_rules.role_id": MOD,
    });
    expect(parseFlashRedirect(res.headers.get("location")).msg).toContain(
      "Access step",
    );
    expect(mockAddConfiguration.mock.calls.map((c) => c[2])).not.toContain(
      "rules.role_id",
    );
  });

  it.each([
    ["rules.role_id", "rules"],
    ["moderation.raid.quarantine_role_id", "moderation"],
  ])("blocks Apply before any write when %s uses it", async (key, feature) => {
    mockGetSession.mockReturnValue(
      wizardState(picks, [feature], { [key]: MOD }),
    );
    const res = await postApply();
    expect(parseFlashRedirect(res.headers.get("location")).msg).toContain(
      "Nothing was applied",
    );
    expect(createSpy).not.toHaveBeenCalled();
    expect(mockApplyConfiguration).not.toHaveBeenCalled();
  });
});

describe("Create @Event host (#1365)", () => {
  const none = { admin: [], staff: [], host: [] };

  beforeEach(() => {
    roles.delete(HOST); // a server with no Event host role
  });

  /** Open Review and read the plan id it posts back with Apply. */
  async function reviewedPlanId(
    state: Record<string, unknown>,
  ): Promise<string> {
    mockGetSession.mockReturnValue(state);
    const html = await (await harness.get("/wizard?step=confirm")).text();
    const hit = /name="hostPlanId" value="([0-9a-f]{24})"/.exec(html);
    expect(hit).not.toBeNull();
    return (hit as RegExpExecArray)[1];
  }

  async function applyWith(
    state: Record<string, unknown>,
    hostPlanId: string,
  ): ReturnType<AdminHarness["post"]> {
    mockGetSession.mockReturnValue(state);
    const shown = accessFingerprint(
      diffAccess(stored, [...roles.values()], state.access as AccessSelection),
    );
    return harness.post("/wizard/apply", {
      accessFingerprint: shown,
      hostPlanId,
    });
  }

  const hostAudits = (): string[] =>
    mockRecordAudit.mock.calls
      .map((c) => (c[1] as { action: string }).action)
      .filter((a) => a.startsWith("wizard.access.host"));

  describe("the Access step", () => {
    it("offers to create the role when none exists, and says what it does", async () => {
      mockGetSession.mockReturnValue(wizardState(undefined));
      const html = await (await harness.get("/wizard?step=access")).text();
      expect(html).toMatch(/name="create_host" value="1"[^>]*>/);
      expect(html).not.toMatch(/name="create_host"[^>]*disabled/);
      expect(html).toContain("adds nobody to it");
    });

    it("shows the choice as made when it was ticked earlier", async () => {
      mockGetSession.mockReturnValue(wizardState(none, ["quotes"], {}, true));
      const html = await (await harness.get("/wizard?step=access")).text();
      expect(html).toMatch(/name="create_host"[^>]*checked/);
    });

    it("does not offer it when an Event host role exists", async () => {
      roles.set(HOST, role(HOST, "Event host", 4));
      mockGetSession.mockReturnValue(wizardState(undefined));
      const html = await (await harness.get("/wizard?step=access")).text();
      expect(html).not.toContain("create_host");
    });

    it("disables it with the reason when the bot can't manage roles", async () => {
      botCanManageRoles = false;
      mockGetSession.mockReturnValue(wizardState(undefined));
      const html = await (await harness.get("/wizard?step=access")).text();
      expect(html).toMatch(/name="create_host"[^>]*disabled/);
      expect(html).toContain("Manage Roles");
    });

    it("counts the pending create as someone to host", async () => {
      mockGetSession.mockReturnValue(
        wizardState(none, ["events"], { "events.enabled": true }, true),
      );
      const html = await (await harness.get("/wizard?step=access")).text();
      expect(html).not.toContain("nobody can host yet");
    });

    it("keeps the choice in the wizard session and writes nothing", async () => {
      mockGetSession.mockReturnValue(wizardState(undefined));
      const res = await harness.post("/wizard/access", { create_host: "1" });
      expect(res.headers.get("location")).toBe("/admin/wizard?step=0");
      expect(mockSetAccess).toHaveBeenCalledWith(
        session.discordUserId,
        session.guildId,
        none,
        true,
      );
      expect(createSpy).not.toHaveBeenCalled();
      expect(mockStartApply).not.toHaveBeenCalled();
    });

    it("refuses it when the bot lacks Manage Roles", async () => {
      botCanManageRoles = false;
      mockGetSession.mockReturnValue(wizardState(undefined));
      const res = await harness.post("/wizard/access", { create_host: "1" });
      const flash = parseFlashRedirect(res.headers.get("location"));
      expect(flash.msg).toContain("Manage Roles");
      expect(mockSetAccess).not.toHaveBeenCalled();
      expect(lastAuditFor("wizard.access")).toMatchObject({
        result: "failure",
      });
    });

    it("refuses it when an Event host role already exists", async () => {
      roles.set(HOST, role(HOST, "Event host", 4));
      mockGetSession.mockReturnValue(wizardState(undefined));
      const res = await harness.post("/wizard/access", { create_host: "1" });
      expect(parseFlashRedirect(res.headers.get("location")).msg).toContain(
        "already exists",
      );
      expect(mockSetAccess).not.toHaveBeenCalled();
    });

    it("refuses it together with picked Event host roles", async () => {
      roles.set("100000000000000007", role("100000000000000007", "Crew", 3));
      mockGetSession.mockReturnValue(wizardState(undefined));
      const res = await harness.post("/wizard/access", {
        create_host: "1",
        roles_host: "100000000000000007",
      });
      expect(parseFlashRedirect(res.headers.get("location")).msg).toContain(
        "not both",
      );
      expect(mockSetAccess).not.toHaveBeenCalled();
    });
  });

  describe("Review", () => {
    it("lists what the engine would do and posts the plan id", async () => {
      mockGetSession.mockReturnValue(wizardState(none, ["quotes"], {}, true));
      const html = await (await harness.get("/wizard?step=confirm")).text();
      expect(html).toContain("Create role &quot;Event host&quot;");
      expect(html).toMatch(/name="hostPlanId" value="[0-9a-f]{24}"/);
      expect(html).not.toMatch(/<button[^>]*disabled[^>]*>Apply/);
      expect(createSpy).not.toHaveBeenCalled();
    });

    it("blocks Apply when the bot can't manage roles", async () => {
      botCanManageRoles = false;
      mockGetSession.mockReturnValue(wizardState(none, ["quotes"], {}, true));
      const html = await (await harness.get("/wizard?step=confirm")).text();
      expect(html).toContain("Manage Roles");
      expect(html).toMatch(/<button[^>]*disabled[^>]*>Apply/);
    });

    it("blocks Apply when the plan holds changes the wizard did not cause", async () => {
      stored = [
        group({
          id: "g-1",
          name: "Moderator",
          roleId: MOD,
          permissions: String(1n << 28n),
          capabilities: ["staff"],
        }),
      ];
      mockGetSession.mockReturnValue(
        wizardState(
          { admin: [], staff: [MOD], host: [] },
          ["quotes"],
          {},
          true,
        ),
      );
      const html = await (await harness.get("/wizard?step=confirm")).text();
      expect(html).toContain("other pending role changes");
      expect(html).toMatch(/<button[^>]*disabled[^>]*>Apply/);
    });
  });

  describe("Apply", () => {
    const state = (): Record<string, unknown> =>
      wizardState(none, ["quotes"], {}, true);

    it("saves the group, starts the job and goes to it", async () => {
      mockApplyConfiguration.mockResolvedValue(okConfig);
      const id = await reviewedPlanId(state());
      const res = await applyWith(state(), id);
      const location = res.headers.get("location") ?? "";
      expect(location).toContain("/admin/role-groups?");
      expect(location).toContain(`job=${JOB}`);
      expect(parseFlashRedirect(location).msg).toContain(
        "Event host role is being created",
      );
      expect(createSpy).toHaveBeenCalledTimes(1);
      expect(createSpy).toHaveBeenCalledWith(
        GUILD,
        expect.objectContaining({
          name: "Event host",
          roleId: null,
          permissions: "0",
          capabilities: ["host"],
        }),
      );
      expect(mockStartApply).toHaveBeenCalledTimes(1);
      const plan = mockStartApply.mock.calls[0][0] as {
        id: string;
        operations: Array<{ type: string; name: string }>;
      };
      expect(plan.id).toBe(id);
      expect(plan.operations).toHaveLength(1);
      expect(plan.operations[0]).toMatchObject({
        type: "role.create",
        name: "Event host",
      });
      expect(hostAudits()).toEqual([
        "wizard.access.host-group",
        "wizard.access.host-role",
      ]);
      expect(mockApplyConfiguration).toHaveBeenCalled();
      expect(mockEndSession).toHaveBeenCalled();
    });

    it("runs the Access writes and the host plan together, and the plans agree", async () => {
      mockApplyConfiguration.mockResolvedValue(okConfig);
      const both = (): Record<string, unknown> =>
        wizardState(
          { admin: [], staff: [MOD], host: [] },
          ["quotes"],
          {},
          true,
        );
      const id = await reviewedPlanId(both());
      const res = await applyWith(both(), id);
      expect(res.headers.get("location")).toContain(`job=${JOB}`);
      expect(createSpy).toHaveBeenCalledTimes(2);
      expect(createSpy.mock.calls[0][1]).toMatchObject({ roleId: MOD });
      expect(createSpy.mock.calls[1][1]).toMatchObject({ roleId: null });
      expect(mockStartApply).toHaveBeenCalledTimes(1);
    });

    it("writes nothing when the plan id is not the one Review showed", async () => {
      const res = await applyWith(state(), "0".repeat(24));
      const flash = parseFlashRedirect(res.headers.get("location"));
      expect(flash.msg).toContain("Nothing was applied");
      expect(createSpy).not.toHaveBeenCalled();
      expect(mockApplyConfiguration).not.toHaveBeenCalled();
      expect(mockStartApply).not.toHaveBeenCalled();
    });

    it("writes nothing when no plan id was posted", async () => {
      await applyWith(state(), "");
      expect(createSpy).not.toHaveBeenCalled();
      expect(mockStartApply).not.toHaveBeenCalled();
    });

    it("refuses before any write when the bot lost Manage Roles", async () => {
      const id = await reviewedPlanId(state());
      botCanManageRoles = false;
      const res = await applyWith(state(), id);
      expect(parseFlashRedirect(res.headers.get("location")).msg).toContain(
        "Manage Roles",
      );
      expect(createSpy).not.toHaveBeenCalled();
      expect(mockApplyConfiguration).not.toHaveBeenCalled();
    });

    it("refuses before any write when an Event host role appeared meanwhile", async () => {
      const id = await reviewedPlanId(state());
      roles.set(HOST, role(HOST, "Event host", 4));
      const res = await applyWith(state(), id);
      expect(parseFlashRedirect(res.headers.get("location")).msg).toContain(
        "already exists",
      );
      expect(createSpy).not.toHaveBeenCalled();
      expect(mockApplyConfiguration).not.toHaveBeenCalled();
    });

    it("removes the group and says the role was not created when the job can't start", async () => {
      mockApplyConfiguration.mockResolvedValue(okConfig);
      mockStartApply.mockImplementation(() => {
        throw new Error("another apply is running");
      });
      const id = await reviewedPlanId(state());
      const res = await applyWith(state(), id);
      const flash = parseFlashRedirect(res.headers.get("location"));
      expect(flash.path).toBe("/admin/role-groups");
      expect(flash.type).toBe("err");
      expect(flash.msg).toContain("was not created");
      expect(flash.msg).toContain("another apply is running");
      expect(flash.msg).toContain("Wizard applied");
      expect(removeSpy).toHaveBeenCalledTimes(1);
      expect(stored).toEqual([]);
      expect(hostAudits()).toContain("wizard.access.host-group.rollback");
    });

    it("does not start the role when the settings fail to apply", async () => {
      mockApplyConfiguration.mockResolvedValue({
        success: false,
        appliedKeys: [],
        rolledBackKeys: [],
        revertFailedKeys: [],
        failedKey: "quotes.enabled",
        errorMessage: "write failed",
      });
      const id = await reviewedPlanId(state());
      await applyWith(state(), id);
      expect(createSpy).not.toHaveBeenCalled();
      expect(mockStartApply).not.toHaveBeenCalled();
      expect(mockEndSession).not.toHaveBeenCalled();
    });
  });

  it("leaves a group whose role was never created out of the mapping", async () => {
    // A job that failed in Discord leaves the group with no role. It must not
    // read as mapped, and the card says the group is waiting for its role.
    stored = [
      group({
        id: "g-1",
        name: "Event host",
        roleId: null,
        capabilities: ["host"],
      }),
    ];
    mockGetSession.mockReturnValue(wizardState(undefined));
    const html = await (await harness.get("/wizard?step=access")).text();
    expect(html).not.toMatch(/<option[^>]*selected/);
    expect(html).toContain("waiting for its role");
  });
});
