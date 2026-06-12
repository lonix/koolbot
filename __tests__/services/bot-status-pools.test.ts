import { describe, it, expect, beforeEach, jest } from "@jest/globals";

// The model is mocked so the service's DB reads can be controlled without
// a live Mongo. ConfigService is auto-mocked; we point its getInstance at a
// controllable fake so refreshStatusPools() sees a bound GUILD_ID.
jest.mock("../../src/utils/logger.js");
jest.mock("../../src/services/config-service.js", () => {
  // Plain stable singleton; its methods are installed as jest mocks in the
  // test scope below (factory-scope jest.fn() is brittle under ESM hoisting).
  const instance = {};
  return { ConfigService: { getInstance: () => instance } };
});
jest.mock("../../src/models/bot-status-message.js", () => ({
  BotStatusMessage: {
    find: jest.fn(),
  },
}));

import { BotStatusService } from "../../src/services/bot-status-service.js";
import { ConfigService } from "../../src/services/config-service.js";
import { BotStatusMessage } from "../../src/models/bot-status-message.js";
import {
  STATUS_POOL_DEFAULTS,
  type BotStatusPool,
} from "../../src/content/statuses.js";

interface StoredRow {
  pool: BotStatusPool;
  text: string;
  order: number;
}

const configInstance = ConfigService.getInstance() as unknown as {
  getString: jest.Mock;
  getBoolean: jest.Mock;
  registerReloadCallback: jest.Mock;
};
configInstance.getString = jest.fn();
configInstance.getBoolean = jest.fn();
configInstance.registerReloadCallback = jest.fn();

/** Wire `BotStatusMessage.find().sort().lean()` to resolve to `rows`. */
function setStoredRows(rows: StoredRow[]): void {
  (BotStatusMessage.find as jest.Mock).mockReturnValue({
    sort: () => ({
      lean: () => Promise.resolve(rows),
    }),
  });
}

// The service is a singleton that captures its client on first construction,
// so the presence spy must be stable across tests — recreating it per test
// would leave it unwired from the already-built singleton.
const setPresence: jest.Mock = jest.fn();
const service = BotStatusService.getInstance({
  user: { setPresence },
} as never);

describe("BotStatusService status pools", () => {
  const presenceName = (): string | undefined => {
    const calls = setPresence.mock.calls;
    const last = calls[calls.length - 1]?.[0] as
      | { activities?: Array<{ name?: string }> }
      | undefined;
    return last?.activities?.[0]?.name;
  };

  beforeEach(async () => {
    configInstance.getString.mockResolvedValue("guild-1");
    setStoredRows([]);
    // Mark the service operational (the only path that flips isInitialized),
    // then flush its background refresh so later assertions are deterministic.
    service.setOperationalStatus();
    await Promise.resolve();
    await Promise.resolve();
    setPresence.mockClear();
  });

  it("falls back to the built-in defaults when the store is empty", async () => {
    setStoredRows([]);
    await service.refreshStatusPools();

    // count 0 → lonely pool; with an empty store this is the default list.
    service.updateVcUserCount(7);
    service.updateVcUserCount(0);
    expect(STATUS_POOL_DEFAULTS.lonely).toContain(presenceName());
  });

  it("uses stored entries in place of the defaults for a populated pool", async () => {
    setStoredRows([{ pool: "single", text: "CUSTOM SOLO STATUS", order: 0 }]);
    await service.refreshStatusPools();

    service.updateVcUserCount(0);
    service.updateVcUserCount(1);
    expect(presenceName()).toBe("CUSTOM SOLO STATUS");
  });

  it("substitutes {count} for the live user count in the multiple pool", async () => {
    setStoredRows([{ pool: "multiple", text: "{count} folks online", order: 0 }]);
    await service.refreshStatusPools();

    service.updateVcUserCount(0);
    service.updateVcUserCount(4);
    expect(presenceName()).toBe("4 folks online");
  });

  it("keeps defaults for pools with no stored rows while overriding others", async () => {
    // Only the single pool is customised; lonely should stay on defaults.
    setStoredRows([{ pool: "single", text: "ONLY SINGLE", order: 0 }]);
    await service.refreshStatusPools();

    service.updateVcUserCount(1);
    expect(presenceName()).toBe("ONLY SINGLE");

    service.updateVcUserCount(0);
    expect(STATUS_POOL_DEFAULTS.lonely).toContain(presenceName());
  });

  it("keeps the previous cache when GUILD_ID is unbound", async () => {
    // Populate the cache from a real guild first.
    setStoredRows([{ pool: "single", text: "BOUND STATUS", order: 0 }]);
    await service.refreshStatusPools();

    // Now simulate an unbound guild: refresh resets to defaults rather than
    // querying the store.
    configInstance.getString.mockResolvedValueOnce("");
    await service.refreshStatusPools();

    service.updateVcUserCount(0);
    service.updateVcUserCount(1);
    expect(STATUS_POOL_DEFAULTS.single).toContain(presenceName());
  });
});
