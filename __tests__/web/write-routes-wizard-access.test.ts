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
  TEST_CSRF_TOKEN,
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
const mockUpdateSession = jest.fn<(...a: unknown[]) => boolean>();
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

// Another adoption apply being active (#1618): the role creation refuses then.
let adoptionActive = false;
jest.unstable_mockModule("../../src/models/adoption-snapshot.js", () => ({
  AdoptionSnapshot: {
    exists: async (): Promise<unknown> =>
      adoptionActive ? { _id: "1" } : null,
  },
}));

// Channel creation (#1662): the permission check, the live channel list and
// the Discord write client are faked; the planner and the helper are real.
type CreateAnswer =
  { ok: true } | { ok: false; reason: string } | { ok: "unknown" };
let createAnswer: CreateAnswer = { ok: true };
const mockCanBotCreate = jest.fn<(...a: unknown[]) => Promise<CreateAnswer>>();
jest.unstable_mockModule("../../src/services/bot-create-check.js", () => ({
  canBotCreate: mockCanBotCreate,
  toPickerCreate: (
    kind: string,
    answer: { ok: boolean | "unknown"; reason?: string },
  ): unknown =>
    answer.ok === "unknown"
      ? undefined
      : {
          kind,
          ok: answer.ok,
          ...(answer.ok === false ? { reason: answer.reason } : {}),
        },
}));
const mockFetchViews = jest.fn<(...a: unknown[]) => Promise<unknown[]>>();
jest.unstable_mockModule("../../src/web/channel-manager-data.js", () => ({
  fetchChannelViews: mockFetchViews,
  maxBitrateOf: () => 96000,
  botCanManageChannels: async () => true,
}));
const mockPost = jest.fn<(...a: any[]) => Promise<any>>();
const mockDelete = jest.fn<(...a: any[]) => Promise<any>>();
jest.unstable_mockModule("../../src/web/channel-write-rest.js", () => ({
  createWriteRest: () => ({ post: mockPost, delete: mockDelete }),
  createFailFastRest: () => ({ post: mockPost, delete: mockDelete }),
  rateLimitWaitMs: () => 0,
  rateLimitMessage: () => "rate limited",
  RATE_LIMIT_FAST_FAIL_MS: 20000,
  WRITE_TIMEOUT_MS: 30000,
  cancellableCall: async (
    _m: unknown,
    fn: (s: AbortSignal) => Promise<unknown>,
  ) => fn(new AbortController().signal),
  describeWriteFailure: (e: unknown) =>
    e instanceof Error ? `Discord refused: ${e.message}` : "Discord refused.",
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
      addConfiguration: mockAddConfiguration,
      applyConfiguration: mockApplyConfiguration,
      endSession: mockEndSession,
      setAccess: mockSetAccess,
      updateSession: mockUpdateSession,
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
      getBooleanStrict: mockGetBoolean,
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
const { createWizardRouter, fitRecovery } =
  await import("../../src/web/routes/write/wizard.js");
const { reviewWizardCreations } =
  await import("../../src/web/wizard-create.js");
const { withChannelLock, CHANNEL_LOCK_BUSY_MESSAGE } =
  await import("../../src/web/channel-write-lock.js");
const { withRoleLock, ROLE_LOCK_BUSY_MESSAGE } =
  await import("../../src/web/role-write-lock.js");
const { planRoles } = await import("../../src/web/role-create.js");
const { contextWithNew, selectionWithNew } =
  await import("../../src/web/wizard-role-create.js");
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

let roles: Map<string, FakeRole>;
let rolesFetchError: Error | null;
let botCanManageRoles = true;

const client = {
  token: "bot-token",
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
  roleCreations: Array<{ name: string; scopes: string[] }> = [],
): Record<string, unknown> {
  return { selectedFeatures, configuration, access, roleCreations };
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
  adoptionActive = false;
  // The session object the route reads is the live one, as in the service.
  mockUpdateSession.mockImplementation((_u, _g, updates) => {
    Object.assign(mockGetSession() as object, updates as object);
    return true;
  });
  createAnswer = { ok: true };
  mockCanBotCreate.mockImplementation(async () => createAnswer);
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
      [],
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
      [],
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

describe("a group whose role was never created", () => {
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
  });
});

describe("roles created from the Access step's Picker (#1618)", () => {
  const none = { admin: [], staff: [], host: [] };
  const CREW = { name: "Crew", scopes: ["staff"] };
  const accessRoles = (): Array<{
    id: string;
    name: string;
    managed: boolean;
    position: number;
  }> =>
    [...roles.values()].map((r) => ({
      id: r.id,
      name: r.name,
      managed: r.managed,
      position: r.position,
    }));
  let seq = 0;
  const roleRoute = (route: unknown): boolean =>
    String(route).endsWith(`/guilds/${GUILD}/roles`);

  beforeEach(() => {
    seq = 0;
    createAnswer = { ok: true };
    mockCanBotCreate.mockImplementation(async () => createAnswer);
    mockFetchViews.mockImplementation(async () => []);
    mockPost.mockReset();
    mockDelete.mockReset();
    mockPost.mockImplementation(async (route: unknown, opts: any) => {
      if (roleRoute(route)) {
        const id = `4000000000000000${++seq}`;
        roles.set(id, role(id, opts.body.name, 1));
        return { id, name: opts.body.name, position: 1 };
      }
      return { id: "500000000000000001", name: opts.body.name };
    });
    mockDelete.mockImplementation(async (route: unknown) => {
      roles.delete(String(route).split("/").pop() as string);
      return {};
    });
    mockApplyConfiguration.mockResolvedValue(okConfig);
  });

  /** What Review would post for these picks and creations. */
  function review(
    access: AccessSelection,
    creations: Array<{ name: string; scopes: string[] }>,
  ): { accessFingerprint: string; rolePlanId: string } {
    const plan = planRoles(
      creations.map((c) => ({ name: c.name })),
      accessRoles(),
    );
    if (!plan.ok) throw new Error(plan.errors.join(" "));
    const ctx = contextWithNew(
      { roles: accessRoles(), groups: stored } as never,
      creations as never,
    );
    return {
      accessFingerprint: accessFingerprint(
        diffAccess(
          stored,
          ctx.roles,
          selectionWithNew(access, creations as never),
        ),
      ),
      rolePlanId: plan.planId,
    };
  }

  describe("the Access step", () => {
    const metaOf = (html: string, scope: string): any => {
      const card = html.split(`id="access-${scope}-title"`)[1];
      const raw = /data-picker-meta="([^"]*)"/.exec(card)?.[1] ?? "";
      return JSON.parse(raw.replace(/&quot;/g, '"').replace(/&amp;/g, "&"));
    };

    it("offers the create row on all three cards when the bot can manage roles", async () => {
      mockGetSession.mockReturnValue(wizardState(undefined));
      const html = await (await harness.get("/wizard?step=access")).text();
      for (const scope of ["admin", "staff", "host"]) {
        expect(metaOf(html, scope).create).toEqual({ kind: "role", ok: true });
      }
      expect(html).not.toContain("create_host");
      expect(html).not.toContain(">Members</h3>");
      expect(mockCanBotCreate).toHaveBeenCalledWith(client, GUILD, {
        kind: "role",
      });
    });

    it("does not offer it, and says why, when the bot lacks Manage Roles", async () => {
      createAnswer = { ok: false, reason: "The bot needs Manage Roles." };
      mockGetSession.mockReturnValue(wizardState(undefined));
      const html = await (await harness.get("/wizard?step=access")).text();
      expect(metaOf(html, "host").create).toEqual({
        kind: "role",
        ok: false,
        reason: "The bot needs Manage Roles.",
      });
      expect(html).toContain("The bot needs Manage Roles.");
      expect(html).not.toContain("To create a role");
    });

    it("draws no row and no line when the permission could not be read, yet keeps a chosen role pending", async () => {
      createAnswer = { ok: "unknown" };
      mockGetSession.mockReturnValue(
        wizardState({ ...none, staff: [] }, ["quotes"], {}, [CREW]),
      );
      const html = await (await harness.get("/wizard?step=access")).text();
      expect(metaOf(html, "staff").create).toEqual({
        kind: "role",
        ok: false,
      });
      expect(html).toContain("Crew (will be created)");
      expect(html).not.toContain("To create a role");
    });

    it("renders as before, with no flag, when it could not be read and nothing is chosen", async () => {
      createAnswer = { ok: "unknown" };
      mockGetSession.mockReturnValue(wizardState(undefined));
      const html = await (await harness.get("/wizard?step=access")).text();
      expect(html).not.toContain('data-picker-meta="{');
    });

    it("counts a role chosen to be created at Admins as someone who can host, as a picked admin role does", async () => {
      mockGetSession.mockReturnValue(
        wizardState(none, ["events"], {}, [
          { name: "Wardens", scopes: ["admin"] },
        ]),
      );
      const html = await (await harness.get("/wizard?step=access")).text();
      expect(html).not.toContain("nobody can host yet");
    });

    it("counts a role chosen to be created as someone who can host", async () => {
      mockGetSession.mockReturnValue(
        wizardState(none, ["events"], {}, [
          { name: "Hosts", scopes: ["host"] },
        ]),
      );
      const html = await (await harness.get("/wizard?step=access")).text();
      expect(html).not.toContain("nobody can host yet");
    });
  });

  describe("saving the step", () => {
    const save = (
      body: Record<string, unknown>,
    ): ReturnType<AdminHarness["post"]> => {
      mockGetSession.mockReturnValue(wizardState(undefined));
      return harness.post("/wizard/access", body);
    };

    it("keeps a typed name beside the picks, and creates nothing", async () => {
      const res = await save({ roles_staff: ["create:Crew"] });
      expect(res.headers.get("location")).toContain("step=0");
      expect(mockSetAccess).toHaveBeenCalledWith(
        session.discordUserId,
        GUILD,
        none,
        [{ name: "Crew", scopes: ["staff"] }],
      );
      expect(mockPost).not.toHaveBeenCalled();
      expect(createSpy).not.toHaveBeenCalled();
    });

    it("takes the create value out before the picks are read, so the ids beside it are kept", async () => {
      await save({ roles_staff: ["create:Crew", MOD], roles_host: HOST });
      expect(mockSetAccess).toHaveBeenCalledWith(
        session.discordUserId,
        GUILD,
        { admin: [], staff: [MOD], host: [HOST] },
        [{ name: "Crew", scopes: ["staff"] }],
      );
    });

    it("makes one role of a name typed twice, in different cases and scopes, at the higher scope", async () => {
      await save({
        roles_admin: ["create:Crew"],
        roles_staff: ["create:crew  "],
      });
      expect(mockSetAccess).toHaveBeenCalledWith(
        session.discordUserId,
        GUILD,
        none,
        [{ name: "Crew", scopes: ["admin"] }],
      );
    });

    it("selects the existing role when the name matches one, ignoring case", async () => {
      await save({ roles_staff: ["create:mODerator"] });
      expect(mockSetAccess).toHaveBeenCalledWith(
        session.discordUserId,
        GUILD,
        { admin: [], staff: [MOD], host: [] },
        [],
      );
    });

    it("applies the mapping's own refusal to a name that matches a managed role", async () => {
      const res = await save({ roles_staff: ["create:booster"] });
      const flash = parseFlashRedirect(res.headers.get("location"));
      expect(flash.msg).toContain("managed by an integration");
      expect(mockSetAccess).not.toHaveBeenCalled();
    });

    it("refuses @everyone typed as a name", async () => {
      const res = await save({ roles_staff: ["create:@everyone"] });
      expect(parseFlashRedirect(res.headers.get("location")).msg).toContain(
        "@everyone can't be mapped",
      );
      expect(mockSetAccess).not.toHaveBeenCalled();
    });

    it("refuses a blank name and one over 100 characters", async () => {
      let res = await save({ roles_staff: ["create:   "] });
      expect(parseFlashRedirect(res.headers.get("location")).msg).toContain(
        "cannot be blank",
      );
      res = await save({ roles_staff: [`create:${"x".repeat(101)}`] });
      expect(parseFlashRedirect(res.headers.get("location")).msg).toContain(
        "at most 100 characters",
      );
      expect(mockSetAccess).not.toHaveBeenCalled();
    });

    it("refuses a name two roles share", async () => {
      roles.set(
        "100000000000000009",
        role("100000000000000009", "moderator", 2),
      );
      const res = await save({ roles_staff: ["create:Moderator"] });
      expect(parseFlashRedirect(res.headers.get("location")).msg).toContain(
        "Two roles are called",
      );
    });

    it("refuses, with the reason, when the bot lacks Manage Roles, and saves nothing", async () => {
      createAnswer = { ok: false, reason: "The bot needs Manage Roles." };
      const res = await save({ roles_staff: ["create:Crew"] });
      expect(parseFlashRedirect(res.headers.get("location")).msg).toBe(
        "The bot needs Manage Roles.",
      );
      expect(mockSetAccess).not.toHaveBeenCalled();
    });

    it("refuses when the permission could not be read", async () => {
      createAnswer = { ok: "unknown" };
      const res = await save({ roles_staff: ["create:Crew"] });
      expect(parseFlashRedirect(res.headers.get("location")).msg).toContain(
        "could not check",
      );
      expect(mockSetAccess).not.toHaveBeenCalled();
    });

    describe("a refused save", () => {
      const getAccess = async (): Promise<string> =>
        (await harness.get("/wizard?step=access")).text();

      it("keeps the typed name drawn as pending, with no row and no line, when the permission could not be read", async () => {
        createAnswer = { ok: "unknown" };
        const res = await save({ roles_staff: ["create:Crew", MOD] });
        expect(mockSetAccess).not.toHaveBeenCalled();
        expect(parseFlashRedirect(res.headers.get("location")).msg).toContain(
          "could not check",
        );
        const html = await getAccess();
        expect(html).toContain("Crew (will be created)");
        expect(html).not.toContain("To create a role");
        expect(html).toMatch(
          new RegExp(`name="roles_staff"[^>]*>[^]*?value="${MOD}" selected`),
        );
        // Shown once: it was never saved.
        expect(await getAccess()).not.toContain("Crew (will be created)");
        expect(mockSetAccess).not.toHaveBeenCalled();
      });

      it("keeps the typed name and gives the reason when the bot lacks Manage Roles", async () => {
        createAnswer = { ok: false, reason: "The bot needs Manage Roles." };
        await save({ roles_host: ["create:Crew"] });
        const html = await getAccess();
        expect(html).toContain("Crew (will be created)");
        expect(html).toContain("The bot needs Manage Roles.");
        expect(html).not.toContain("To create a role");
      });

      it("keeps the other picks when a name is refused by the mapping's rules", async () => {
        const res = await save({
          roles_staff: [MOD, "create:booster"],
          roles_host: ["create:Crew"],
        });
        expect(parseFlashRedirect(res.headers.get("location")).msg).toContain(
          "managed by an integration",
        );
        const html = await getAccess();
        expect(html).toMatch(
          new RegExp(`name="roles_staff"[^>]*>[^]*?value="${MOD}" selected`),
        );
        expect(html).toContain("Crew (will be created)");
        expect(mockSetAccess).not.toHaveBeenCalled();
      });
    });

    it("does not ask for the permission when nothing is typed", async () => {
      await save({ roles_staff: [MOD] });
      expect(mockCanBotCreate).not.toHaveBeenCalled();
    });
  });

  describe("Review", () => {
    it("lists the role to create, the group that maps it, and posts both plan ids", async () => {
      mockGetSession.mockReturnValue(wizardState(none, ["quotes"], {}, [CREW]));
      const html = await (await harness.get("/wizard?step=confirm")).text();
      expect(html).toContain(
        'Create the role <span class="kb-mention">@Crew</span> (no Discord permissions, nobody added)',
      );
      expect(html).toContain('Creates the role group "Crew"');
      expect(html).toMatch(/name="rolePlanId" value="[0-9a-f]{16}"/);
      expect(html).toMatch(/name="accessFingerprint" value="[0-9a-f]{32}"/);
      expect(html).not.toMatch(/<button[^>]*disabled[^>]*>Apply/);
      expect(mockPost).not.toHaveBeenCalled();
    });

    it("blocks Apply, with the reason, when the bot lost Manage Roles", async () => {
      createAnswer = { ok: false, reason: "The bot needs Manage Roles." };
      mockGetSession.mockReturnValue(wizardState(none, ["quotes"], {}, [CREW]));
      const html = await (await harness.get("/wizard?step=confirm")).text();
      expect(html).toContain("The roles can't be created");
      expect(html).toContain("The bot needs Manage Roles.");
      expect(html).toMatch(/<button[^>]*disabled[^>]*>Apply/);
    });

    it("blocks Apply when a role of that name appeared since the step was saved", async () => {
      roles.set("100000000000000009", role("100000000000000009", "crew", 2));
      mockGetSession.mockReturnValue(wizardState(none, ["quotes"], {}, [CREW]));
      const html = await (await harness.get("/wizard?step=confirm")).text();
      expect(html).toContain("exists now");
      expect(html).toMatch(/<button[^>]*disabled[^>]*>Apply/);
    });
  });

  describe("Apply", () => {
    const access = { ...none, staff: [] as string[] };

    it("creates the role with no permissions, then maps it, then applies the settings", async () => {
      mockGetSession.mockReturnValue(
        wizardState(access, ["quotes"], {}, [CREW]),
      );
      const res = await harness.post("/wizard/apply", review(access, [CREW]));
      const flash = parseFlashRedirect(res.headers.get("location"));
      expect(flash.type).toBe("ok");
      expect(flash.msg).toContain("1 role group change");
      expect(flash.msg).toContain("created 1 role");
      const roleCalls = mockPost.mock.calls.filter((c) => roleRoute(c[0]));
      expect(roleCalls).toHaveLength(1);
      expect(roleCalls[0][1]).toMatchObject({
        body: {
          name: "Crew",
          permissions: "0",
          hoist: false,
          mentionable: false,
        },
      });
      // The group maps the role Discord made, with no permissions of its own.
      expect(createSpy).toHaveBeenCalledWith(
        GUILD,
        expect.objectContaining({
          name: "Crew",
          roleId: "40000000000000001",
          capabilities: ["staff"],
          permissions: null,
        }),
      );
      expect(mockApplyConfiguration).toHaveBeenCalled();
      expect(mockEndSession).toHaveBeenCalled();
      expect(mockDelete).not.toHaveBeenCalled();
    });

    it("maps a role created for Admins with the admin capability and still no permissions", async () => {
      const a = { ...none };
      const admin = { name: "Wardens", scopes: ["admin"] };
      mockGetSession.mockReturnValue(wizardState(a, ["quotes"], {}, [admin]));
      await harness.post("/wizard/apply", review(a, [admin]));
      expect(
        mockPost.mock.calls.find((c) => roleRoute(c[0]))?.[1],
      ).toMatchObject({
        body: { permissions: "0" },
      });
      expect(createSpy).toHaveBeenCalledWith(
        GUILD,
        expect.objectContaining({
          capabilities: ["admin", "staff"],
          permissions: null,
        }),
      );
    });

    it("creates nothing when the role plan id is missing or is not the one Review showed", async () => {
      mockGetSession.mockReturnValue(
        wizardState(access, ["quotes"], {}, [CREW]),
      );
      const shown = review(access, [CREW]);
      for (const rolePlanId of [undefined, "0000000000000000"]) {
        const res = await harness.post("/wizard/apply", {
          accessFingerprint: shown.accessFingerprint,
          ...(rolePlanId ? { rolePlanId } : {}),
        });
        const flash = parseFlashRedirect(res.headers.get("location"));
        expect(flash.msg).toContain("Nothing was applied.");
        expect(flash.msg).toContain("changed since you opened Review");
      }
      expect(mockPost).not.toHaveBeenCalled();
      expect(createSpy).not.toHaveBeenCalled();
      expect(mockApplyConfiguration).not.toHaveBeenCalled();
    });

    it("creates nothing when a role of that name appeared after Review", async () => {
      mockGetSession.mockReturnValue(
        wizardState(access, ["quotes"], {}, [CREW]),
      );
      const shown = review(access, [CREW]);
      roles.set("100000000000000009", role("100000000000000009", "crew", 2));
      const res = await harness.post("/wizard/apply", shown);
      expect(parseFlashRedirect(res.headers.get("location")).msg).toContain(
        "Nothing was applied.",
      );
      expect(mockPost).not.toHaveBeenCalled();
      expect(createSpy).not.toHaveBeenCalled();
    });

    it("refuses with nothing created when the bot lost Manage Roles", async () => {
      mockGetSession.mockReturnValue(
        wizardState(access, ["quotes"], {}, [CREW]),
      );
      const shown = review(access, [CREW]);
      createAnswer = { ok: false, reason: "The bot needs Manage Roles." };
      const res = await harness.post("/wizard/apply", shown);
      expect(parseFlashRedirect(res.headers.get("location")).msg).toContain(
        "The bot needs Manage Roles.",
      );
      expect(mockPost).not.toHaveBeenCalled();
    });

    it("refuses with nothing created while an adoption apply is running", async () => {
      mockGetSession.mockReturnValue(
        wizardState(access, ["quotes"], {}, [CREW]),
      );
      const shown = review(access, [CREW]);
      adoptionActive = true;
      const res = await harness.post("/wizard/apply", shown);
      expect(parseFlashRedirect(res.headers.get("location")).msg).toContain(
        "already running",
      );
      expect(mockPost).not.toHaveBeenCalled();
      expect(createSpy).not.toHaveBeenCalled();
    });

    it("writes nothing else, and the settings stay unapplied, when Discord refuses the role", async () => {
      mockGetSession.mockReturnValue(
        wizardState(access, ["quotes"], {}, [CREW]),
      );
      const shown = review(access, [CREW]);
      mockPost.mockRejectedValue(new Error("Missing Permissions"));
      const res = await harness.post("/wizard/apply", shown);
      const flash = parseFlashRedirect(res.headers.get("location"));
      // A create was tried, so it does not say nothing changed.
      expect(flash.msg).toContain("The settings were not applied.");
      expect(flash.msg).not.toContain("Nothing was applied");
      expect(flash.msg).toContain("Missing Permissions");
      expect(createSpy).not.toHaveBeenCalled();
      expect(mockApplyConfiguration).not.toHaveBeenCalled();
      expect(lastAuditFor("wizard.apply")).toMatchObject({
        result: "failure",
        details: { stage: "roles" },
      });
    });

    it("removes the role again when writing the role group fails, and says so", async () => {
      mockGetSession.mockReturnValue(
        wizardState(access, ["quotes"], {}, [CREW]),
      );
      const shown = review(access, [CREW]);
      createSpy.mockResolvedValueOnce({
        ok: false,
        error: "disk full",
      } as never);
      const res = await harness.post("/wizard/apply", shown);
      const flash = parseFlashRedirect(res.headers.get("location"));
      expect(flash.msg).toContain("disk full");
      expect(flash.msg).toContain("created for this apply was removed again");
      expect(flash.msg).not.toContain("Nothing was applied");
      expect(mockDelete).toHaveBeenCalledTimes(1);
      expect(String(mockDelete.mock.calls[0][0])).toContain(
        `/guilds/${GUILD}/roles/40000000000000001`,
      );
      expect(roles.has("40000000000000001")).toBe(false);
      expect(mockApplyConfiguration).not.toHaveBeenCalled();
    });

    it("removes the role, after putting the mapping back, when the settings fail to apply", async () => {
      mockGetSession.mockReturnValue(
        wizardState(access, ["quotes"], {}, [CREW]),
      );
      const shown = review(access, [CREW]);
      mockApplyConfiguration.mockResolvedValue({
        success: false,
        appliedKeys: [],
        failedKey: "quotes.enabled",
        errorMessage: "write failed",
        rolledBackKeys: [],
        revertFailedKeys: [],
      });
      const res = await harness.post("/wizard/apply", shown);
      const flash = parseFlashRedirect(res.headers.get("location"));
      expect(flash.msg).toContain("role mapping was undone");
      expect(flash.msg).toContain("created for this apply was removed again");
      expect(stored).toHaveLength(0);
      expect(roles.has("40000000000000001")).toBe(false);
      // The mapping went first, so the role was no longer referenced.
      const removeOrder = removeSpy.mock.invocationCallOrder[0];
      const deleteOrder = mockDelete.mock.invocationCallOrder[0];
      expect(removeOrder).toBeLessThan(deleteOrder);
      expect(mockEndSession).not.toHaveBeenCalled();
    });

    it("removes the role when applying the settings throws", async () => {
      mockGetSession.mockReturnValue(
        wizardState(access, ["quotes"], {}, [CREW]),
      );
      const shown = review(access, [CREW]);
      mockApplyConfiguration.mockRejectedValue(new Error("db gone"));
      const res = await harness.post("/wizard/apply", shown);
      const flash = parseFlashRedirect(res.headers.get("location"));
      expect(flash.msg).toContain("db gone");
      expect(flash.msg).toContain("removed again");
      expect(stored).toHaveLength(0);
      expect(roles.has("40000000000000001")).toBe(false);
    });

    it("keeps a role a group still points at, and says so, when the group could not be removed", async () => {
      mockGetSession.mockReturnValue(
        wizardState(access, ["quotes"], {}, [CREW]),
      );
      const shown = review(access, [CREW]);
      mockApplyConfiguration.mockResolvedValue({
        success: false,
        appliedKeys: [],
        failedKey: "quotes.enabled",
        errorMessage: "write failed",
        rolledBackKeys: [],
        revertFailedKeys: [],
      });
      removeSpy.mockResolvedValue(false);
      const res = await harness.post("/wizard/apply", shown);
      const flash = parseFlashRedirect(res.headers.get("location"));
      expect(flash.msg).toContain("could not be fully undone");
      expect(flash.msg).toContain(
        "Kept, because a role group or a saved setting points at it: 40000000000000001",
      );
      expect(flash.msg).not.toContain("No changes were applied");
      expect(flash.msg).not.toContain("Nothing was applied");
      expect(mockDelete).not.toHaveBeenCalled();
      expect(roles.has("40000000000000001")).toBe(true);
    });

    it("keeps the outcome and the recovery text whole when the cause is long", async () => {
      const A = { name: "Alpha", scopes: ["staff"] };
      const B = { name: "Beta", scopes: ["host"] };
      mockGetSession.mockReturnValue(
        wizardState(access, ["quotes"], {}, [A, B]),
      );
      const shown = review(access, [A, B]);
      let n = 0;
      mockPost.mockImplementation(async (route: unknown, opts: any) => {
        n += 1;
        if (n === 2) throw new Error("x".repeat(900));
        const id = `4000000000000000${n}`;
        roles.set(id, role(id, opts.body.name, 1));
        return { id, name: opts.body.name, position: 1 };
      });
      const res = await harness.post("/wizard/apply", shown);
      const flash = parseFlashRedirect(res.headers.get("location"));
      expect(flash.msg).toContain("The settings were not applied.");
      expect(flash.msg).toContain("…");
      expect(flash.msg).toContain("created for this apply was removed again");
      expect(flash.msg.length).toBeLessThanOrEqual(500);
      expect(createSpy).not.toHaveBeenCalled();
    });

    it("names a role it could not remove, and never says the apply left nothing", async () => {
      mockGetSession.mockReturnValue(
        wizardState(access, ["quotes"], {}, [CREW]),
      );
      const shown = review(access, [CREW]);
      createSpy.mockResolvedValueOnce({
        ok: false,
        error: "disk full",
      } as never);
      mockDelete.mockRejectedValue(new Error("Discord down"));
      const res = await harness.post("/wizard/apply", shown);
      const flash = parseFlashRedirect(res.headers.get("location"));
      expect(flash.msg).toContain(
        "May still exist (not removed or checked): 40000000000000001",
      );
      expect(flash.msg).not.toContain("removed again");
      expect(flash.msg).not.toContain("Nothing was applied");
    });

    it("does not say no changes were applied when the settings fail and a role could not be removed", async () => {
      mockGetSession.mockReturnValue(
        wizardState(access, ["quotes"], {}, [CREW]),
      );
      const shown = review(access, [CREW]);
      mockApplyConfiguration.mockResolvedValue({
        success: false,
        appliedKeys: [],
        failedKey: "quotes.enabled",
        errorMessage: "write failed",
        rolledBackKeys: [],
        revertFailedKeys: [],
      });
      mockDelete.mockRejectedValue(new Error("Discord down"));
      const res = await harness.post("/wizard/apply", shown);
      const flash = parseFlashRedirect(res.headers.get("location"));
      expect(flash.msg).toContain(
        "May still exist (not removed or checked): 40000000000000001",
      );
      expect(flash.msg).toContain("The settings were not saved.");
      expect(flash.msg).not.toContain("No changes were applied");
      expect(flash.msg).not.toContain("removed again");
    });

    it("keeps a created role that something saved a reference to while a later create was pending", async () => {
      const A = { name: "Alpha", scopes: ["staff"] };
      const B = { name: "Beta", scopes: ["host"] };
      mockGetSession.mockReturnValue(
        wizardState(access, ["quotes"], {}, [A, B]),
      );
      const shown = review(access, [A, B]);
      let n = 0;
      mockPost.mockImplementation(async (_route: unknown, opts: any) => {
        n += 1;
        if (n === 2) {
          // Another admin maps the first role while this create is pending.
          stored.push(
            group({
              id: "g-other",
              name: "Other",
              roleId: "40000000000000001",
              capabilities: ["staff"],
            }),
          );
          throw new Error("Missing Permissions");
        }
        const id = `4000000000000000${n}`;
        roles.set(id, role(id, opts.body.name, 1));
        return { id, name: opts.body.name, position: 1 };
      });
      const res = await harness.post("/wizard/apply", shown);
      const flash = parseFlashRedirect(res.headers.get("location"));
      expect(mockDelete).not.toHaveBeenCalled();
      expect(roles.has("40000000000000001")).toBe(true);
      expect(flash.msg).toContain(
        "Kept, because a role group or a saved setting points at it: 40000000000000001",
      );
      expect(flash.msg).not.toContain("removed again");
      expect(flash.msg).not.toContain("Nothing was applied");
      expect(createSpy).not.toHaveBeenCalled();
    });

    it("writes nothing and cleans the new role up when the role groups changed while it was created", async () => {
      const picks = { ...none, staff: [MOD] };
      mockGetSession.mockReturnValue(
        wizardState(picks, ["quotes"], {}, [CREW]),
      );
      const shown = review(picks, [CREW]);
      mockPost.mockImplementation(async (_route: unknown, opts: any) => {
        // Another admin maps the Moderator role during the creation.
        stored.push(
          group({
            id: "g-ext",
            name: "Mods",
            roleId: MOD,
            capabilities: ["staff"],
          }),
        );
        const id = "40000000000000001";
        roles.set(id, role(id, opts.body.name, 1));
        return { id, name: opts.body.name, position: 1 };
      });
      const res = await harness.post("/wizard/apply", shown);
      const flash = parseFlashRedirect(res.headers.get("location"));
      expect(flash.msg).toContain("changed since you opened Review");
      expect(flash.msg).toContain("created for this apply was removed again");
      expect(createSpy).not.toHaveBeenCalled();
      expect(updateSpy).not.toHaveBeenCalled();
      expect(mockApplyConfiguration).not.toHaveBeenCalled();
      expect(roles.has("40000000000000001")).toBe(false);
    });

    it("ranks the new group by the role's position in the fresh read, not the one in the create response", async () => {
      const picks = { ...none, staff: [MOD] };
      stored = [
        group({
          id: "g-mod",
          name: "Moderator",
          roleId: MOD,
          capabilities: ["staff"],
        }),
      ];
      const crew = { name: "Crew", scopes: ["host"] };
      mockGetSession.mockReturnValue(
        wizardState(picks, ["quotes"], {}, [crew]),
      );
      const shown = review(picks, [crew]);
      const reorderSpy = jest.spyOn(svc, "reorder");
      mockPost.mockImplementation(async (_route: unknown, opts: any) => {
        const id = "40000000000000001";
        // Discord answers position 1, but by the time of the re-read the role
        // sits above the Moderator role (5), still below the bot (10).
        roles.set(id, role(id, opts.body.name, 7));
        return { id, name: opts.body.name, position: 1 };
      });
      const res = await harness.post("/wizard/apply", shown);
      expect(parseFlashRedirect(res.headers.get("location")).type).toBe("ok");
      // The new group already ranks above the Moderator group (newest first):
      // with the stale position 1 it would have been moved below it.
      expect(reorderSpy).not.toHaveBeenCalled();
      expect(stored.map((g) => g.name)).toEqual(["Crew", "Moderator"]);
    });

    it("keeps created roles that a leaderboard tier or a reaction-role binding now uses, and names them", async () => {
      const A = { name: "Alpha", scopes: ["staff"] };
      const B = { name: "Beta", scopes: ["host"] };
      const C = { name: "Gamma", scopes: ["host"] };
      mockGetSession.mockReturnValue(
        wizardState(access, ["quotes"], {}, [A, B, C]),
      );
      const shown = review(access, [A, B, C]);
      let n = 0;
      mockPost.mockImplementation(async (_route: unknown, opts: any) => {
        n += 1;
        if (n === 3) {
          // Two feature saves complete while the third create is pending.
          featureUsesSpy.mockResolvedValue(
            new Map([
              ["40000000000000001", ["Leaderboard Roles"]],
              ["40000000000000002", ["Reaction Roles"]],
            ]),
          );
          throw new Error("Missing Permissions");
        }
        const id = `4000000000000000${n}`;
        roles.set(id, role(id, opts.body.name, 1));
        return { id, name: opts.body.name, position: 1 };
      });
      const res = await harness.post("/wizard/apply", shown);
      const flash = parseFlashRedirect(res.headers.get("location"));
      expect(mockDelete).not.toHaveBeenCalled();
      expect(flash.msg).toContain("Kept, because");
      expect(flash.msg).toContain("40000000000000001");
      expect(flash.msg).toContain("40000000000000002");
      expect(flash.msg).not.toContain("removed again");
    });

    it("deletes nothing and says the roles may still exist when the feature uses cannot be read", async () => {
      const A = { name: "Alpha", scopes: ["staff"] };
      const B = { name: "Beta", scopes: ["host"] };
      mockGetSession.mockReturnValue(
        wizardState(access, ["quotes"], {}, [A, B]),
      );
      const shown = review(access, [A, B]);
      let n = 0;
      mockPost.mockImplementation(async (_route: unknown, opts: any) => {
        n += 1;
        if (n === 2) {
          featureUsesSpy.mockRejectedValue(new Error("db down"));
          throw new Error("Missing Permissions");
        }
        const id = `4000000000000000${n}`;
        roles.set(id, role(id, opts.body.name, 1));
        return { id, name: opts.body.name, position: 1 };
      });
      const res = await harness.post("/wizard/apply", shown);
      const flash = parseFlashRedirect(res.headers.get("location"));
      expect(mockDelete).not.toHaveBeenCalled();
      expect(flash.msg).toContain("May still exist");
      expect(flash.msg).toContain("40000000000000001");
    });

    it.each([
      ["is deleted", "no longer exists"],
      ["moves above the bot", "at or above the bot's own role"],
    ])(
      "writes nothing and cleans up when a role created earlier %s while a later create is pending",
      async (what, message) => {
        const A = { name: "Alpha", scopes: ["staff"] };
        const B = { name: "Beta", scopes: ["host"] };
        mockGetSession.mockReturnValue(
          wizardState(access, ["quotes"], {}, [A, B]),
        );
        const shown = review(access, [A, B]);
        let n = 0;
        mockPost.mockImplementation(async (_route: unknown, opts: any) => {
          n += 1;
          const id = `4000000000000000${n}`;
          roles.set(id, role(id, opts.body.name, 1));
          if (n === 2) {
            // While the second create is pending, the first role changes.
            if (what === "is deleted") roles.delete("40000000000000001");
            else
              roles.set(
                "40000000000000001",
                role("40000000000000001", "Alpha", 11),
              );
          }
          return { id, name: opts.body.name, position: 1 };
        });
        const res = await harness.post("/wizard/apply", shown);
        const flash = parseFlashRedirect(res.headers.get("location"));
        expect(flash.type).toBe("err");
        expect(flash.msg).toContain(message);
        expect(flash.msg).toContain("The settings were not applied.");
        expect(createSpy).not.toHaveBeenCalled();
        expect(mockApplyConfiguration).not.toHaveBeenCalled();
        expect(mockEndSession).not.toHaveBeenCalled();
        // The second role is removed again; the first is gone or removed too.
        expect(roles.has("40000000000000002")).toBe(false);
        expect(flash.msg).toContain("removed again");
        expect(lastAuditFor("wizard.apply")).toMatchObject({
          result: "failure",
          details: { stage: "access", reason: "changed-during-roles" },
        });
      },
    );

    it("writes what it validated when the session's picks change during the role creation", async () => {
      const live = wizardState(access, ["quotes"], {}, [CREW]);
      mockGetSession.mockReturnValue(live);
      const shown = review(access, [CREW]);
      mockPost.mockImplementation(async (_route: unknown, opts: any) => {
        // Access saved in another tab while the role request is pending.
        live.access = { admin: [ADMIN], staff: [MOD], host: [HOST] };
        live.roleCreations = [];
        const id = "40000000000000001";
        roles.set(id, role(id, opts.body.name, 1));
        return { id, name: opts.body.name, position: 1 };
      });
      const res = await harness.post("/wizard/apply", shown);
      expect(parseFlashRedirect(res.headers.get("location")).type).toBe("ok");
      expect(createSpy).toHaveBeenCalledTimes(1);
      expect(createSpy).toHaveBeenCalledWith(
        GUILD,
        expect.objectContaining({ name: "Crew", capabilities: ["staff"] }),
      );
    });

    it("keeps ids and the recovery sentence within 500 characters when the mapping, a role and a channel are all left behind", async () => {
      const channels = { "quotes.channel_id": { name: "wall", kind: "text" } };
      const chReview = await reviewWizardCreations(client, GUILD, channels);
      mockGetSession.mockReturnValue({
        ...wizardState(access, ["quotes"], {}, [CREW]),
        creations: channels,
      });
      const shown = review(access, [CREW]);
      mockApplyConfiguration.mockResolvedValue({
        success: false,
        appliedKeys: [],
        failedKey: "quotes.enabled",
        errorMessage: "x".repeat(900),
        rolledBackKeys: [],
        revertFailedKeys: [],
      });
      removeSpy.mockResolvedValue(false); // the mapping cannot be undone
      mockDelete.mockRejectedValue(new Error("Discord down")); // channel stuck
      const res = await harness.post("/wizard/apply", {
        ...shown,
        channelPlanId: chReview.planId as string,
      });
      const flash = parseFlashRedirect(res.headers.get("location"));
      expect(flash.msg.length).toBeLessThanOrEqual(500);
      expect(flash.msg).toContain("40000000000000001"); // the kept role
      expect(flash.msg).toContain("500000000000000001"); // the channel
      expect(flash.msg).toContain("Check Role groups.");
      expect(flash.msg).toContain(
        "Check them in Discord before applying again.",
      );
      expect(flash.msg).toContain("…"); // only the cause was shortened
    });

    describe("a request that closes while queued", () => {
      /** Post Apply, close the request after `closeAfterMs`, and wait for the server to notice. */
      async function postAndClose(
        body: Record<string, string>,
        closeAfterMs: number,
      ): Promise<void> {
        const gone = new AbortController();
        const sent = fetch(`${harness.baseUrl}/admin/wizard/apply`, {
          method: "POST",
          redirect: "manual",
          signal: gone.signal,
          headers: {
            "content-type": "application/x-www-form-urlencoded",
            cookie: `koolbot_csrf=${encodeURIComponent(TEST_CSRF_TOKEN)}`,
          },
          body: new globalThis.URLSearchParams({
            _csrf: TEST_CSRF_TOKEN,
            ...body,
          }).toString(),
        }).catch(() => null);
        await new Promise((r) => setTimeout(r, closeAfterMs));
        gone.abort();
        await sent;
        await new Promise((r) => setTimeout(r, 100));
      }

      it("creates and writes nothing when it waits for the role lock", async () => {
        mockGetSession.mockReturnValue(
          wizardState(access, ["quotes"], {}, [CREW]),
        );
        const shown = review(access, [CREW]);
        let release: () => void = () => undefined;
        const holding = withRoleLock(
          GUILD,
          () => new Promise<void>((resolve) => (release = resolve)),
        );
        await postAndClose(shown, 400);
        release();
        await holding;
        await new Promise((r) => setTimeout(r, 300));
        expect(mockPost).not.toHaveBeenCalled();
        expect(createSpy).not.toHaveBeenCalled();
        expect(mockApplyConfiguration).not.toHaveBeenCalled();
        expect(lastAuditFor("wizard.apply")).toMatchObject({
          result: "failure",
          errorMessage: ROLE_LOCK_BUSY_MESSAGE,
          details: { stage: "roles" },
        });
      });

      it("puts the mapping back and removes the role when it waits for the channel lock", async () => {
        const channels = {
          "quotes.channel_id": { name: "wall", kind: "text" },
        };
        const chReview = await reviewWizardCreations(client, GUILD, channels);
        expect(chReview.problems).toEqual([]);
        mockGetSession.mockReturnValue({
          ...wizardState(access, ["quotes"], {}, [CREW]),
          creations: channels,
        });
        const shown = review(access, [CREW]);
        let release: () => void = () => undefined;
        const holding = withChannelLock(
          GUILD,
          () => new Promise<void>((resolve) => (release = resolve)),
        );
        await postAndClose(
          { ...shown, channelPlanId: chReview.planId as string },
          500,
        );
        release();
        await holding;
        await new Promise((r) => setTimeout(r, 300));
        // The role was made and mapped, then both were put back.
        expect(mockPost.mock.calls.filter((c) => roleRoute(c[0]))).toHaveLength(
          1,
        );
        expect(
          mockPost.mock.calls.filter((c) => !roleRoute(c[0])),
        ).toHaveLength(0);
        expect(createSpy).toHaveBeenCalledTimes(1);
        expect(removeSpy).toHaveBeenCalledTimes(1);
        expect(stored).toHaveLength(0);
        expect(roles.has("40000000000000001")).toBe(false);
        expect(mockApplyConfiguration).not.toHaveBeenCalled();
        expect(lastAuditFor("wizard.apply")).toMatchObject({
          result: "failure",
          errorMessage: CHANNEL_LOCK_BUSY_MESSAGE,
          details: { stage: "channels" },
        });
      });
    });

    it("puts the mapping back and removes the role when creating a channel fails", async () => {
      const channels = { "quotes.channel_id": { name: "wall", kind: "text" } };
      const chReview = await reviewWizardCreations(client, GUILD, channels);
      mockGetSession.mockReturnValue({
        ...wizardState(access, ["quotes"], {}, [CREW]),
        creations: channels,
      });
      const shown = review(access, [CREW]);
      mockPost.mockImplementation(async (route: unknown, opts: any) => {
        if (roleRoute(route)) {
          const id = "40000000000000001";
          roles.set(id, role(id, opts.body.name, 1));
          return { id, name: opts.body.name, position: 1 };
        }
        throw new Error("Missing Permissions");
      });
      const res = await harness.post("/wizard/apply", {
        ...shown,
        channelPlanId: chReview.planId as string,
      });
      const flash = parseFlashRedirect(res.headers.get("location"));
      expect(flash.msg).toContain("Missing Permissions");
      expect(flash.msg).toContain("role mapping was undone");
      expect(flash.msg).toContain("created for this apply was removed again");
      expect(stored).toHaveLength(0);
      expect(roles.has("40000000000000001")).toBe(false);
      expect(mockApplyConfiguration).not.toHaveBeenCalled();
    });
  });
});

describe("a planned channel after the role mapping (#1662)", () => {
  const picks = { admin: [], staff: [MOD], host: [HOST] };
  const creations = { "quotes.channel_id": { name: "wall", kind: "text" } };

  async function stateWithChannels(): Promise<{
    state: Record<string, unknown>;
    fingerprint: string;
    planId: string;
  }> {
    const review = await reviewWizardCreations(client, GUILD, creations);
    expect(review.problems).toEqual([]);
    return {
      state: { ...wizardState(picks), creations },
      fingerprint: accessFingerprint(
        diffAccess(stored, [...roles.values()], picks),
      ),
      planId: review.planId as string,
    };
  }

  beforeEach(() => {
    createAnswer = { ok: true };
    mockCanBotCreate.mockImplementation(async () => createAnswer);
    mockFetchViews.mockImplementation(async () => []);
    mockPost.mockReset();
    mockDelete.mockReset();
    mockDelete.mockResolvedValue({});
    mockApplyConfiguration.mockResolvedValue(okConfig);
  });

  it("undoes the role mapping and stores no setting when creating the channel fails", async () => {
    const { state, fingerprint, planId } = await stateWithChannels();
    mockGetSession.mockReturnValue(state);
    mockPost.mockRejectedValue(new Error("Missing Permissions"));
    const res = await harness.post("/wizard/apply", {
      accessFingerprint: fingerprint,
      channelPlanId: planId,
    });
    const flash = parseFlashRedirect(res.headers.get("location"));
    expect(flash.type).toBe("err");
    expect(flash.msg).toContain("The settings were not applied.");
    expect(flash.msg).toContain("Missing Permissions");
    expect(flash.msg).toContain("role mapping was undone");
    // The mapping was written first (both groups), then put back.
    expect(createSpy).toHaveBeenCalledTimes(2);
    expect(removeSpy).toHaveBeenCalledTimes(2);
    for (const call of createSpy.mock.results) {
      const made = (await call.value) as { group: { id: string } };
      expect(removeSpy).toHaveBeenCalledWith(GUILD, made.group.id);
    }
    expect(stored).toHaveLength(0);
    expect(mockApplyConfiguration).not.toHaveBeenCalled();
    expect(mockEndSession).not.toHaveBeenCalled();
    expect(lastAuditFor("wizard.apply")).toMatchObject({
      result: "failure",
      details: { stage: "channels" },
    });
  });

  it("undoes the role mapping and creates nothing when the browser leaves while the apply waits for the lock", async () => {
    const { state, fingerprint, planId } = await stateWithChannels();
    mockGetSession.mockReturnValue(state);
    let release: () => void = () => undefined;
    const holding = withChannelLock(
      GUILD,
      () => new Promise<void>((resolve) => (release = resolve)),
    );
    const gone = new AbortController();
    const sent = fetch(`${harness.baseUrl}/admin/wizard/apply`, {
      method: "POST",
      redirect: "manual",
      signal: gone.signal,
      headers: {
        "content-type": "application/x-www-form-urlencoded",
        cookie: `koolbot_csrf=${encodeURIComponent(TEST_CSRF_TOKEN)}`,
      },
      body: new globalThis.URLSearchParams({
        _csrf: TEST_CSRF_TOKEN,
        accessFingerprint: fingerprint,
        channelPlanId: planId,
      }).toString(),
    }).catch(() => null);
    // The mapping is written, then the channel apply waits for the lock.
    await new Promise((r) => setTimeout(r, 400));
    gone.abort();
    await sent;
    await new Promise((r) => setTimeout(r, 100));
    release();
    await holding;
    await new Promise((r) => setTimeout(r, 300));
    expect(createSpy).toHaveBeenCalledTimes(2);
    expect(removeSpy).toHaveBeenCalledTimes(2);
    expect(stored).toHaveLength(0);
    expect(mockPost).not.toHaveBeenCalled();
    expect(mockApplyConfiguration).not.toHaveBeenCalled();
    expect(lastAuditFor("wizard.apply")).toMatchObject({
      result: "failure",
      errorMessage: CHANNEL_LOCK_BUSY_MESSAGE,
      details: { stage: "channels" },
    });
  });
});

describe("fitRecovery (#1618)", () => {
  const ids = (n: number, p: string): string[] =>
    Array.from({ length: n }, (_, i) => `${p}${String(i).padStart(17, "0")}`);

  it("keeps the recovery sentences whole when they leave room for the cause", () => {
    const long = " The role mapping was undone too. Short.";
    expect(fitRecovery(long, { groups: [], roles: [], channels: [] })).toBe(
      long,
    );
  });

  it("replaces them with one short sentence that still names what is left, when they do not fit", () => {
    const long = " x".repeat(300);
    const out = fitRecovery(long, {
      groups: [`A very long role group name that goes on`, "g2", "g3"],
      roles: ids(5, "4"),
      channels: ids(4, "5"),
    });
    expect(out.length).toBeLessThanOrEqual(350);
    expect(out).toContain("Left behind, check before applying again");
    expect(out).toContain("and 1 more"); // role groups capped
    expect(out).toContain("and 3 more"); // roles capped
    expect(out).toContain("and 2 more"); // channels capped
    expect(out).toContain(ids(5, "4")[0]);
    expect(out).toContain("removed again");
  });
});
