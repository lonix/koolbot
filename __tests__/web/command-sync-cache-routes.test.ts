/**
 * The cached slash-command check over the combined admin routers (#1638). The
 * write router is mounted ahead of the read-only pages and passes GETs
 * through, so a page view must not clear the check it just cached, while a
 * write still must.
 */
import {
  describe,
  it,
  expect,
  jest,
  beforeEach,
  afterEach,
} from "@jest/globals";
import { REST, type Client } from "discord.js";
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

const values: Record<string, string> = {
  GUILD_ID: "guild-1",
  CLIENT_ID: "client-1",
  DISCORD_TOKEN: "secret-token-value",
};
jest.unstable_mockModule("../../src/services/config-service.js", () => ({
  ConfigService: {
    getInstance: (): unknown => ({
      getBoolean: jest.fn(async (_k: string, d: boolean) => d),
      getString: jest.fn(async (k: string, d: string = "") => values[k] ?? d),
      getBooleanStrict: jest.fn(async (_k: string, d: boolean) => d),
      getStringStrict: jest.fn(async (_k: string, d: string) => d),
      getNumber: jest.fn(async () => 0),
      getAll: jest.fn(async () => []),
      get: jest.fn(async () => null),
      set: jest.fn(async () => undefined),
      delete: jest.fn(async () => undefined),
      registerReloadCallback: jest.fn(),
      addChangeListener: jest.fn(),
    }),
  },
}));

const { createReadOnlyRouter } =
  await import("../../src/web/read-only-routes.js");
const { createWriteRouter } = await import("../../src/web/write-routes.js");
const { CommandManager } =
  await import("../../src/services/command-manager.js");
const { resetSharedRest } = await import("../../src/utils/discord-rest.js");

const client = {
  user: { id: "bot" },
  isReady: () => true,
  guilds: {
    fetch: async () => {
      throw new Error("no guild in this test");
    },
  },
} as unknown as Client;

let harness: AdminHarness;
let getSpy: jest.SpiedFunction<typeof REST.prototype.get>;

beforeEach(async () => {
  CommandManager.reset();
  resetSharedRest();
  getSpy = jest
    .spyOn(REST.prototype, "get")
    .mockResolvedValue([{ id: "1", type: 1, name: "ping", description: "d" }]);
  jest
    .spyOn(
      CommandManager.prototype as unknown as {
        getEnabledCommands: () => Promise<unknown[]>;
      },
      "getEnabledCommands",
    )
    .mockResolvedValue([{ name: "ping", description: "d" }]);
  const session = stubRequireSession(createTestSession());
  harness = await startAdminHarness([
    createWriteRouter(client, session),
    createReadOnlyRouter(client, session),
  ]);
});

afterEach(async () => {
  jest.restoreAllMocks();
  await harness.close();
});

describe("the command check across the combined routers", () => {
  it("reads Discord once for two page views", async () => {
    const first = await (await harness.get("/settings")).text();
    expect(first).toContain("In sync");
    await (await harness.get("/settings")).text();
    expect(getSpy).toHaveBeenCalledTimes(1);
  });

  it("reads Discord again after a write has been answered", async () => {
    await (await harness.get("/settings")).text();
    expect(getSpy).toHaveBeenCalledTimes(1);
    // Any admin write; this one is refused, which still counts as answered.
    await harness.post("/settings/reset", { key: "made.up" });
    await (await harness.get("/settings")).text();
    expect(getSpy).toHaveBeenCalledTimes(2);
  });
});
