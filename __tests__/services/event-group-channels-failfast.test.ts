import {
  describe,
  it,
  expect,
  jest,
  beforeEach,
  afterEach,
} from "@jest/globals";
import { DiscordAPIError, RateLimitError } from "discord.js";

// The PRODUCTION call wrapper of a channel rename (#1196): no `call` override,
// the real CommandManager. A rate-limit rejection must come back at once, never
// after a sleep, because the rename holds the event's channel lock.

jest.unstable_mockModule("../../src/utils/logger.js", () => ({
  default: {
    info: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
    debug: jest.fn(),
  },
  isDebugMode: () => false,
}));

import { cstore, cfake, CEventMock } from "./event-customise-fake-event.js";

jest.unstable_mockModule("../../src/models/event.js", () => ({
  Event: CEventMock,
}));

const { EventGroupChannels } =
  await import("../../src/services/event-group-channels.js");
await import("../../src/services/command-manager.js");
const { getRenameQueue } =
  await import("../../src/services/event-rename-queue.js");

// One client for the file: the real CommandManager is a singleton bound to it.
const SHARED_CLIENT = { user: { id: "9" }, token: "t" };
const GUILD = "111111111111111111";
const EV = "65a000000000000000000001";
const CH = "200000000000000001";

function rateLimited(ms = 120_000): RateLimitError {
  return new RateLimitError({
    timeToReset: ms,
    limit: 2,
    method: "PATCH",
    hash: "h",
    url: "u",
    route: "/channels/:id",
    majorParameter: CH,
    global: false,
    retryAfter: ms,
    sublimitTimeout: 0,
    scope: "user",
  } as never);
}

function make(patch: () => Promise<unknown>) {
  const channels = new EventGroupChannels(
    SHARED_CLIENT as never,
    {
      getPrefix: async () => "📅",
      getGraceMs: async () => 0,
      isEnabled: async () => true,
    },
    {
      rest: { patch } as never,
      paceMs: 0,
    },
  );
  const guild = {
    id: GUILD,
    channels: {
      fetch: jest.fn(async (id: string) => ({
        id,
        name: "📅 Old",
        guildId: GUILD,
      })),
    },
  } as never;
  return { channels, guild };
}

beforeEach(() => {
  cstore.clear();
  cfake.failFind = false;
  getRenameQueue().forget(CH);
  cstore.set(EV, {
    _id: EV,
    guildId: GUILD,
    state: "active",
    groupsEnabled: true,
    groups: [
      {
        key: "g_00000001",
        name: "New",
        kind: "team",
        channelId: CH,
        memberIds: [],
        nameSyncPending: true,
      },
    ],
  });
});
afterEach(() => {
  jest.useRealTimers();
});

describe("a rename through the production wrapper never waits on a rate limit (#1196)", () => {
  it("a rate-limit rejection is reported at once, with no timer waited for", async () => {
    jest.useFakeTimers();
    const { channels, guild } = make(async () => {
      throw rateLimited(120_000);
    });
    // Under fake timers any sleep would never finish: this resolves only if
    // nothing was waited for.
    const out = await channels.syncNames(EV, guild);
    expect(out[0]).toMatchObject({ status: "limited", retryAfterMs: 120_000 });
  });

  it("a 429 answered by Discord itself is limited at once too", async () => {
    jest.useFakeTimers();
    const err = new DiscordAPIError(
      {
        code: 0,
        message: "You are being rate limited.",
        retry_after: 30,
      } as never,
      0,
      429,
      "PATCH",
      "/",
      {},
    );
    const { channels, guild } = make(async () => {
      throw err;
    });
    const out = await channels.syncNames(EV, guild);
    expect(out[0]).toMatchObject({ status: "limited", retryAfterMs: 30_000 });
    // The channel stays blocked for what Discord said, not for a default.
    expect(getRenameQueue().check(CH)).toMatchObject({ ok: false });
  });

  it("a plain failure is still an unconfirmed rename, not a rate limit", async () => {
    jest.useFakeTimers();
    const { channels, guild } = make(async () => {
      throw new Error("socket hang up");
    });
    const out = await channels.syncNames(EV, guild);
    expect(out[0].status).toBe("unconfirmed");
  });

  it("a success goes through the wrapper once", async () => {
    const patch = jest.fn(async () => ({}));
    const { channels, guild } = make(patch);
    const out = await channels.syncNames(EV, guild);
    expect(out[0]).toMatchObject({ status: "applied" });
    expect(patch).toHaveBeenCalledTimes(1);
  });
});
