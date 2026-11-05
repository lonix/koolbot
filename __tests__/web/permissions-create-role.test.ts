/**
 * Command permissions with a `create:<Name>` role (#1760): the save creates the
 * role first and stores its id, never the literal value; a failed save removes
 * what it created. Driven over HTTP through the shared harness. The Discord
 * write client, the live role list and the bot-permission answer are faked; the
 * role plan, the role lock, the cleanup and the route are real.
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
const mockGet = jest.fn<() => Promise<unknown>>();
const mockSet = jest.fn<(...a: unknown[]) => Promise<unknown>>();
const mockClear = jest.fn<() => Promise<unknown>>();
const mockGetGroupRefs = jest.fn<() => Promise<unknown>>();
const mockGroupList = jest.fn<() => Promise<unknown>>();

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
jest.unstable_mockModule("../../src/services/permissions-service.js", () => ({
  PermissionCheckError: class PermissionCheckError extends Error {},
  PermissionsService: {
    getInstance: (): unknown => ({
      getCommandPermissions: mockGet,
      setCommandPermissions: mockSet,
      clearCommandPermissions: mockClear,
      getCommandGroupRefs: mockGetGroupRefs,
    }),
  },
}));
jest.unstable_mockModule("../../src/services/role-group-service.js", () => ({
  RoleGroupService: {
    getInstance: (): unknown => ({
      list: mockGroupList,
      featureRoleUses: async (): Promise<Map<string, string>> => new Map(),
    }),
  },
}));
jest.unstable_mockModule("../../src/services/config-service.js", () => ({
  ConfigService: {
    getInstance: (): unknown => ({
      getAll: async (): Promise<unknown[]> => [],
    }),
  },
}));
jest.unstable_mockModule("../../src/services/command-manager.js", () => ({
  CommandManager: { getInstance: (): unknown => ({}) },
}));

// What points at a role besides the settings: the per-command role lists.
let commandPermRows: Array<{ roleIds: string[] }> = [];
let referenceReadFails = false;
const chain = (rows: () => unknown[]): unknown => ({
  select: (): unknown => ({
    lean: (): unknown => ({
      exec: async (): Promise<unknown[]> => {
        if (referenceReadFails) throw new Error("db down");
        return rows();
      },
    }),
  }),
});
jest.unstable_mockModule("../../src/models/command-permissions.js", () => ({
  CommandPermission: { find: (): unknown => chain(() => commandPermRows) },
}));
jest.unstable_mockModule("../../src/models/poll-schedule.js", () => ({
  PollSchedule: { find: (): unknown => chain(() => []) },
}));
jest.unstable_mockModule("../../src/models/adoption-snapshot.js", () => ({
  ADOPTION_STALE_AFTER_MS: 30 * 60 * 1000,
  AdoptionSnapshot: { exists: async (): Promise<null> => null },
}));

type Answer = { ok: true } | { ok: false; reason: string } | { ok: "unknown" };
let answer: Answer = { ok: true };
const mockCanBotCreate = jest.fn<(...a: unknown[]) => Promise<Answer>>();
jest.unstable_mockModule("../../src/services/bot-create-check.js", () => ({
  canBotCreate: mockCanBotCreate,
  toPickerCreate: jest.fn(),
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

const { createPermissionsRouter } =
  await import("../../src/web/routes/write/permissions.js");
const { withRoleLock, ROLE_LOCK_BUSY_MESSAGE, roleWriteLock } =
  await import("../../src/web/role-write-lock.js");
const { CHANNEL_LOCK_WAIT_MS } =
  await import("../../src/web/channel-write-lock.js");
const { resolvePermissionRoles } =
  await import("../../src/web/permissions-role-create.js");
const { requireCsrf } = await import("../../src/web/csrf.js");
const { requireAdminRoleMiddleware } = await import("../../src/web/session.js");

let liveRoles: Array<{ id: string; name: string }>;
let rolesFetchFails = false;
const client = {
  token: "bot-token",
  user: { id: "bot" },
  guilds: {
    fetch: async (): Promise<unknown> => ({
      id: "guild-1",
      roles: {
        fetch: async (): Promise<Map<string, unknown>> => {
          if (rolesFetchFails) throw new Error("discord down");
          return new Map(liveRoles.map((r) => [r.id, r]));
        },
      },
    }),
  },
} as unknown as Client;

const session = createTestSession();

async function mount(): Promise<AdminHarness> {
  return startAdminHarness([
    stubRequireSession(session),
    requireAdminRoleMiddleware(),
    requireCsrf,
    createPermissionsRouter(client),
  ]);
}

function lastAudit(): { details: Record<string, any>; [k: string]: any } {
  const calls = mockRecordAudit.mock.calls;
  return calls[calls.length - 1][1] as never;
}

let harness: AdminHarness;
let nextId: number;

beforeEach(async () => {
  jest.clearAllMocks();
  nextId = 900;
  liveRoles = [
    { id: "1", name: "@everyone" },
    { id: "2", name: "Moderator" },
  ];
  rolesFetchFails = false;
  commandPermRows = [];
  referenceReadFails = false;
  answer = { ok: true };
  mockCanBotCreate.mockImplementation(async () => answer);
  mockGet.mockResolvedValue(["old"]);
  mockSet.mockResolvedValue(undefined);
  mockClear.mockResolvedValue(undefined);
  mockGetGroupRefs.mockResolvedValue([]);
  mockGroupList.mockResolvedValue([{ id: "g1", name: "Mods", rank: 2 }]);
  mockPost.mockImplementation(async (_route: string, opts: any) => ({
    id: String(++nextId),
    name: opts.body.name,
    position: 1,
  }));
  mockDelete.mockResolvedValue(undefined);
  harness = await mount();
});

afterEach(async () => {
  await harness.close();
});

const flashOf = (res: Response): ReturnType<typeof parseFlashRedirect> =>
  parseFlashRedirect(res.headers.get("location"));

describe("POST /permissions/set with a create: role (#1760)", () => {
  it("never stores the literal create: value: it creates the role and stores its id", async () => {
    const res = await harness.post("/permissions/set", {
      command: "ping",
      roleIds: ["create:Helpers"],
    });
    expect(mockSet).toHaveBeenCalledTimes(1);
    expect(mockSet).toHaveBeenCalledWith("guild-1", "ping", ["901"], []);
    for (const call of mockSet.mock.calls) {
      expect(JSON.stringify(call)).not.toContain("create:");
    }
    const flash = flashOf(res);
    expect(flash.type).toBe("ok");
    expect(flash.msg).toContain('Created role "Helpers"');
  });

  it("creates the role with no permissions, hoist off and not mentionable", async () => {
    await harness.post("/permissions/set", {
      command: "ping",
      roleIds: ["create:Helpers"],
    });
    expect(mockPost).toHaveBeenCalledTimes(1);
    expect(mockPost.mock.calls[0][0]).toBe("/guilds/guild-1/roles");
    expect(mockPost.mock.calls[0][1]).toMatchObject({
      body: {
        name: "Helpers",
        permissions: "0",
        hoist: false,
        mentionable: false,
      },
    });
  });

  it("keeps picked roles and groups beside the created role, in one save", async () => {
    const res = await harness.post("/permissions/set", {
      command: "warn",
      roleIds: ["role-a", "group:g1+", "create:Helpers"],
    });
    expect(mockSet).toHaveBeenCalledWith(
      "guild-1",
      "warn",
      ["role-a", "901"],
      ["group:g1+"],
    );
    const flash = flashOf(res);
    expect(flash.msg).toContain("2 role(s) and 1 group(s)");
  });

  it("keeps a comma in a name that is the only selection (string form)", async () => {
    await harness.post("/permissions/set", {
      command: "ping",
      roleIds: "create:Community, Support",
    });
    expect(mockPost).toHaveBeenCalledTimes(1);
    expect(mockPost.mock.calls[0][1]).toMatchObject({
      body: { name: "Community, Support" },
    });
    expect(mockSet).toHaveBeenCalledWith("guild-1", "ping", ["901"], []);
  });

  it("keeps a comma in a name among several selections (array form)", async () => {
    await harness.post("/permissions/set", {
      command: "ping",
      roleIds: ["role-a", "create:Community, Support", "group:g1"],
    });
    expect(mockPost).toHaveBeenCalledTimes(1);
    expect(mockSet).toHaveBeenCalledWith(
      "guild-1",
      "ping",
      ["role-a", "901"],
      ["group:g1"],
    );
  });

  it("treats a padded array element as a create value, never storing the literal", async () => {
    await harness.post("/permissions/set", {
      command: "ping",
      roleIds: ["123", " create:Helpers"],
    });
    expect(mockPost).toHaveBeenCalledTimes(1);
    expect(mockSet).toHaveBeenCalledWith("guild-1", "ping", ["123", "901"], []);
    expect(JSON.stringify(mockSet.mock.calls)).not.toContain("create:");
  });

  it("keeps a padded single string with a comma name whole", async () => {
    await harness.post("/permissions/set", {
      command: "ping",
      roleIds: "  create:Community, Support ",
    });
    expect(mockPost).toHaveBeenCalledTimes(1);
    expect(mockPost.mock.calls[0][1]).toMatchObject({
      body: { name: "Community, Support" },
    });
    expect(mockSet).toHaveBeenCalledWith("guild-1", "ping", ["901"], []);
  });

  it("still splits a comma-separated string of plain ids and groups", async () => {
    await harness.post("/permissions/set", {
      command: "ping",
      roleIds: "role-a, role-b,group:g1",
    });
    expect(mockPost).not.toHaveBeenCalled();
    expect(mockSet).toHaveBeenCalledWith(
      "guild-1",
      "ping",
      ["role-a", "role-b"],
      ["group:g1"],
    );
  });

  it("creates two names, and a name typed twice (any case) once", async () => {
    await harness.post("/permissions/set", {
      command: "ping",
      roleIds: ["create:Helpers", "create:helpers ", "create:Crew"],
    });
    expect(mockPost).toHaveBeenCalledTimes(2);
    expect(mockSet).toHaveBeenCalledWith("guild-1", "ping", ["901", "902"], []);
  });

  it("selects an existing role of that name (any case) instead of creating one", async () => {
    const res = await harness.post("/permissions/set", {
      command: "ping",
      roleIds: ["create:moderator"],
    });
    expect(mockPost).not.toHaveBeenCalled();
    expect(mockCanBotCreate).not.toHaveBeenCalled();
    expect(mockSet).toHaveBeenCalledWith("guild-1", "ping", ["2"], []);
    expect(flashOf(res).msg).not.toContain("Created");
    expect(lastAudit().details.created).toBeUndefined();
  });

  it("does not store a role twice when the name selects one that is also picked", async () => {
    await harness.post("/permissions/set", {
      command: "ping",
      roleIds: ["2", "create:Moderator", "create:Helpers"],
    });
    expect(mockSet).toHaveBeenCalledWith("guild-1", "ping", ["2", "901"], []);
  });

  it("refuses a name two roles share, creating and storing nothing", async () => {
    liveRoles.push({ id: "3", name: "moderator" });
    const res = await harness.post("/permissions/set", {
      command: "ping",
      roleIds: ["create:Moderator"],
    });
    const flash = flashOf(res);
    expect(flash.type).toBe("err");
    expect(flash.msg).toContain('Two roles are called "Moderator"');
    expect(mockPost).not.toHaveBeenCalled();
    expect(mockSet).not.toHaveBeenCalled();
  });

  it("refuses a blank or over-long name once, creating and storing nothing", async () => {
    const res = await harness.post("/permissions/set", {
      command: "ping",
      roleIds: ["role-a", "create:   ", `create:${"x".repeat(101)}`],
    });
    const flash = flashOf(res);
    expect(flash.type).toBe("err");
    expect(flash.msg).toContain("The name cannot be blank.");
    expect(flash.msg).toContain("at most 100 characters");
    expect(mockPost).not.toHaveBeenCalled();
    expect(mockSet).not.toHaveBeenCalled();
    expect(mockClear).not.toHaveBeenCalled();
  });

  it("refuses with the reason when the bot cannot create roles, storing nothing", async () => {
    answer = { ok: false, reason: "The bot needs Manage Roles." };
    const res = await harness.post("/permissions/set", {
      command: "ping",
      roleIds: ["create:Helpers"],
    });
    const flash = flashOf(res);
    expect(flash.type).toBe("err");
    expect(flash.msg).toContain("The bot needs Manage Roles.");
    expect(mockPost).not.toHaveBeenCalled();
    expect(mockSet).not.toHaveBeenCalled();
    expect(lastAudit()).toMatchObject({ result: "failure" });
  });

  it("refuses when the permission cannot be read", async () => {
    answer = { ok: "unknown" };
    const res = await harness.post("/permissions/set", {
      command: "ping",
      roleIds: ["create:Helpers"],
    });
    expect(flashOf(res).msg).toContain("could not check whether it may create");
    expect(mockPost).not.toHaveBeenCalled();
    expect(mockSet).not.toHaveBeenCalled();
  });

  it("stores nothing when the live roles cannot be read", async () => {
    rolesFetchFails = true;
    const res = await harness.post("/permissions/set", {
      command: "ping",
      roleIds: ["role-a", "create:Helpers"],
    });
    expect(flashOf(res).msg).toContain("couldn't read the roles");
    expect(mockPost).not.toHaveBeenCalled();
    expect(mockSet).not.toHaveBeenCalled();
  });

  it("stores nothing and says why when Discord refuses the create", async () => {
    mockPost.mockRejectedValue(new Error("Missing Permissions"));
    const res = await harness.post("/permissions/set", {
      command: "ping",
      roleIds: ["role-a", "create:Helpers"],
    });
    const flash = flashOf(res);
    expect(flash.type).toBe("err");
    expect(flash.msg).toContain("Nothing was saved for /ping");
    expect(flash.msg).toContain("Missing Permissions");
    expect(mockSet).not.toHaveBeenCalled();
    expect(mockDelete).not.toHaveBeenCalled();
    expect(lastAudit()).toMatchObject({
      result: "failure",
      details: { attempted: ["role-a"], createRoles: ["Helpers"] },
    });
  });

  it("removes the first role again when a later create fails, and stores nothing", async () => {
    mockPost
      .mockResolvedValueOnce({ id: "901", name: "Helpers", position: 1 })
      .mockRejectedValueOnce(new Error("Missing Permissions"));
    const res = await harness.post("/permissions/set", {
      command: "ping",
      roleIds: ["create:Helpers", "create:Crew"],
    });
    expect(mockDelete).toHaveBeenCalledTimes(1);
    expect(mockDelete.mock.calls[0][0]).toBe("/guilds/guild-1/roles/901");
    expect(mockSet).not.toHaveBeenCalled();
    const msg = flashOf(res).msg ?? "";
    // The account of the roles is said once, not by the helper and the route.
    expect(msg.split("removed again")).toHaveLength(2);
    expect(msg).toContain("Missing Permissions");
    expect(lastAudit().details.removed).toEqual(["901"]);
  });

  it("removes the created role when the save then fails (no orphaned role)", async () => {
    mockSet.mockRejectedValue(new Error("mongo is down"));
    const res = await harness.post("/permissions/set", {
      command: "ping",
      roleIds: ["role-a", "create:Helpers"],
    });
    expect(mockPost).toHaveBeenCalledTimes(1);
    expect(mockDelete).toHaveBeenCalledTimes(1);
    expect(mockDelete.mock.calls[0][0]).toBe("/guilds/guild-1/roles/901");
    const flash = flashOf(res);
    expect(flash.type).toBe("err");
    expect(flash.msg).toContain("mongo is down");
    expect(flash.msg).toContain("removed again");
    expect(lastAudit()).toMatchObject({
      result: "failure",
      errorMessage: "mongo is down",
      details: {
        attempted: ["role-a", "901"],
        created: [{ id: "901", name: "Helpers" }],
        removed: ["901"],
        kept: [],
        stuck: [],
      },
    });
  });

  it("never removes a role that was only selected by name", async () => {
    mockSet.mockRejectedValue(new Error("mongo is down"));
    await harness.post("/permissions/set", {
      command: "ping",
      roleIds: ["create:Moderator", "create:Helpers"],
    });
    expect(mockDelete).toHaveBeenCalledTimes(1);
    expect(mockDelete.mock.calls[0][0]).toBe("/guilds/guild-1/roles/901");
  });

  it("keeps a created role something now points at, and names it", async () => {
    mockSet.mockImplementation(async () => {
      // The write reached the database before the failure was reported.
      commandPermRows = [{ roleIds: ["901"] }];
      throw new Error("reply lost");
    });
    const res = await harness.post("/permissions/set", {
      command: "ping",
      roleIds: ["create:Helpers"],
    });
    expect(mockDelete).not.toHaveBeenCalled();
    const flash = flashOf(res);
    expect(flash.msg).toContain(
      "Kept, because something now points at it: 901",
    );
    expect(lastAudit().details.kept).toEqual(["901"]);
  });

  it("says the role may still exist when the cleanup cannot read what points at it", async () => {
    mockSet.mockImplementation(async () => {
      referenceReadFails = true;
      throw new Error("mongo is down");
    });
    const res = await harness.post("/permissions/set", {
      command: "ping",
      roleIds: ["create:Helpers"],
    });
    expect(mockDelete).not.toHaveBeenCalled();
    expect(flashOf(res).msg).toContain(
      "may still exist, check in Discord: 901",
    );
    expect(lastAudit().details.stuck).toEqual(["901"]);
  });

  it("keeps the recovery text whole when the cause is long (500-character flash)", async () => {
    mockSet.mockRejectedValue(new Error("x".repeat(900)));
    const res = await harness.post("/permissions/set", {
      command: "ping",
      roleIds: ["create:Helpers"],
    });
    const msg = flashOf(res).msg ?? "";
    expect(msg.length).toBeLessThanOrEqual(500);
    expect(msg).toContain("removed again");
  });

  it("leaves /config Administrator-only, creating nothing", async () => {
    const res = await harness.post("/permissions/set", {
      command: "config",
      roleIds: ["create:Helpers"],
    });
    expect(flashOf(res).msg).toContain("Administrator-only");
    expect(mockPost).not.toHaveBeenCalled();
    expect(mockSet).not.toHaveBeenCalled();
  });

  it("audits the created ids with before and after on success", async () => {
    mockGetGroupRefs.mockResolvedValue(["group:g1"]);
    await harness.post("/permissions/set", {
      command: "warn",
      roleIds: ["role-a", "group:g1+", "create:Helpers"],
    });
    expect(mockRecordAudit).toHaveBeenCalledTimes(1);
    expect(lastAudit()).toMatchObject({
      action: "permissions.set",
      targetId: "warn",
      result: "success",
      details: {
        before: ["old"],
        beforeGroupRefs: ["group:g1"],
        after: ["role-a", "901"],
        groupRefs: ["group:g1+"],
        created: [{ id: "901", name: "Helpers" }],
      },
    });
  });

  it("does not touch Discord for a save without a create: value", async () => {
    await harness.post("/permissions/set", {
      command: "ping",
      roleIds: ["role-a", "group:g1"],
    });
    expect(mockPost).not.toHaveBeenCalled();
    expect(mockCanBotCreate).not.toHaveBeenCalled();
  });
});

describe("resolvePermissionRoles and the role lock (#1760)", () => {
  it("gives up with the busy message after the bounded wait, creating nothing", async () => {
    jest.useFakeTimers();
    try {
      let release: () => void = () => undefined;
      const holding = withRoleLock(
        "guild-1",
        () => new Promise<void>((resolve) => (release = resolve)),
      );
      const waiting = resolvePermissionRoles(client, "guild-1", "actor-1", [
        "Helpers",
      ]);
      await jest.advanceTimersByTimeAsync(CHANNEL_LOCK_WAIT_MS + 1);
      expect(await waiting).toMatchObject({
        ok: false,
        error: ROLE_LOCK_BUSY_MESSAGE,
        removed: [],
        stuck: [],
      });
      release();
      await holding;
      await jest.advanceTimersByTimeAsync(10);
      expect(mockPost).not.toHaveBeenCalled();
      expect(roleWriteLock.size).toBe(0);
    } finally {
      jest.useRealTimers();
    }
  });

  it("refuses when a role of that name appeared between the read and the lock", async () => {
    let reads = 0;
    const racing = {
      ...(client as object),
      guilds: {
        fetch: async (): Promise<unknown> => ({
          roles: {
            fetch: async (): Promise<Map<string, unknown>> => {
              reads += 1;
              const roles =
                reads === 1
                  ? liveRoles
                  : [...liveRoles, { id: "77", name: "Helpers" }];
              return new Map(roles.map((r) => [r.id, r]));
            },
          },
        }),
      },
    } as unknown as Client;
    const out = await resolvePermissionRoles(racing, "guild-1", "actor-1", [
      "Helpers",
    ]);
    expect(out.ok).toBe(false);
    expect(mockPost).not.toHaveBeenCalled();
    if (!out.ok)
      expect(out.error).toContain("changed while this was being saved");
  });

  it("records the actor in the Discord audit-log reason", async () => {
    await resolvePermissionRoles(client, "guild-1", "actor-1", ["Helpers"]);
    expect(mockPost.mock.calls[0][1]).toMatchObject({
      reason: "KoolBot web UI, command permissions, by actor-1",
    });
  });
});
