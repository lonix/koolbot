/**
 * GET /admin/permissions and the role Picker's create row (#1760): each
 * command's picker offers "Create new role" when the bot may create roles, and
 * is as it always was when it may not or when that cannot be read.
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
  type AdminHarness,
} from "./admin-harness.js";

jest.unstable_mockModule("../../src/utils/logger.js", () => ({
  default: {
    info: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
    debug: jest.fn(),
  },
  isDebugMode: jest.fn(() => false),
}));
jest.unstable_mockModule("../../src/services/config-service.js", () => ({
  ConfigService: {
    getInstance: (): unknown => ({
      getBoolean: jest.fn(async () => false),
      getString: jest.fn(async () => ""),
      getNumber: jest.fn(async () => 0),
      getAll: jest.fn(async () => []),
      get: jest.fn(async () => null),
      registerReloadCallback: jest.fn(),
    }),
  },
}));
jest.unstable_mockModule("../../src/services/permissions-service.js", () => ({
  PermissionCheckError: class PermissionCheckError extends Error {},
  PermissionsService: {
    getInstance: (): unknown => ({
      listAllPermissions: jest.fn(async () => []),
    }),
  },
}));

type Answer = { ok: true } | { ok: false; reason: string } | { ok: "unknown" };
let answer: Answer = { ok: true };
const mockCanBotCreate = jest.fn<(...a: unknown[]) => Promise<Answer>>();
jest.unstable_mockModule("../../src/services/bot-create-check.js", () => ({
  canBotCreate: mockCanBotCreate,
  toPickerCreate: (
    kind: string,
    a: { ok: boolean | "unknown"; reason?: string },
  ): unknown =>
    a.ok === "unknown"
      ? undefined
      : { kind, ok: a.ok, ...(a.ok === false ? { reason: a.reason } : {}) },
}));

const { createReadOnlyRouter } =
  await import("../../src/web/read-only-routes.js");

const session = createTestSession();
const roles = new Map([
  ["r1", { id: "r1", name: "Moderator" }],
  ["r2", { id: "r2", name: "Members" }],
]);
const client = {
  user: { id: "bot" },
  guilds: {
    fetch: jest.fn(async () => ({
      id: session.guildId,
      roles: { fetch: async (): Promise<void> => undefined, cache: roles },
    })),
  },
  commands: new Map([["ping", {}]]),
} as unknown as Client;

let harness: AdminHarness;

beforeEach(async () => {
  answer = { ok: true };
  mockCanBotCreate.mockImplementation(async () => answer);
  harness = await startAdminHarness([
    createReadOnlyRouter(client, stubRequireSession(session)),
  ]);
});

afterEach(async () => {
  await harness.close();
});

const page = async (): Promise<string> =>
  (await harness.get("/permissions")).text();

describe("GET /permissions create row (#1760)", () => {
  it("flags the role picker so it offers the create row", async () => {
    const html = await page();
    expect(html).toContain('data-picker-meta="{');
    expect(html).toContain(
      "&quot;create&quot;:{&quot;kind&quot;:&quot;role&quot;,&quot;ok&quot;:true}",
    );
    expect(mockCanBotCreate).toHaveBeenCalledTimes(1);
    expect(mockCanBotCreate.mock.calls[0][2]).toEqual({ kind: "role" });
  });

  it("marks the picker as unable to create when the bot lacks the permission", async () => {
    answer = { ok: false, reason: "The bot needs Manage Roles." };
    const html = await page();
    expect(html).toContain("&quot;ok&quot;:false");
  });

  it("leaves the picker exactly as it was when the permission cannot be read", async () => {
    answer = { ok: "unknown" };
    const html = await page();
    expect(html).toContain('data-picker-meta="[');
    expect(html).not.toContain("&quot;create&quot;");
  });
});
