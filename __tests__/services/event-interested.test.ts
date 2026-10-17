import { describe, it, expect, jest, beforeEach } from "@jest/globals";
import { Collection, DiscordAPIError } from "discord.js";

jest.unstable_mockModule("../../src/utils/logger.js", () => ({
  default: {
    info: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
    debug: jest.fn(),
  },
}));

const { loadInterested, PAGE_SIZE, MAX_PAGES, MAX_NAMES } =
  await import("../../src/services/event-interested.js");

type Sub = {
  user: { id: string; username: string; globalName?: string | null };
  member?: { displayName: string } | null;
};

function sub(id: number, extra: Partial<Sub> = {}): Sub {
  return { user: { id: String(id), username: `user${id}` }, ...extra };
}

function page(subs: Sub[]): Collection<string, Sub> {
  return new Collection(subs.map((s) => [s.user.id, s]));
}

function makeClient(fetchSubscribers: jest.Mock): {
  client: never;
  fetchEvent: jest.Mock;
} {
  const fetchEvent = jest.fn(async () => ({ fetchSubscribers }));
  const guild = { scheduledEvents: { fetch: fetchEvent } };
  const client = {
    guilds: { cache: new Map([["guild-1", guild]]), fetch: jest.fn() },
  } as never;
  return { client, fetchEvent };
}

// Pass-through: the real wrapper (timeout, retries) is covered by its own tests.
const direct = async <T>(call: () => Promise<T>): Promise<T> => call();

describe("loadInterested", () => {
  beforeEach(() => jest.clearAllMocks());

  it("lists display names (member, then global name, then username)", async () => {
    const fetchSubscribers = jest.fn(async () =>
      page([
        sub(1, { member: { displayName: "Nick" } }),
        sub(2, { user: { id: "2", username: "bob", globalName: "Bobby" } }),
        sub(3),
      ]),
    );
    const { client, fetchEvent } = makeClient(fetchSubscribers);
    const result = await loadInterested(client, "guild-1", "n1", direct);
    expect(fetchEvent).toHaveBeenCalledWith("n1");
    expect(result).toEqual({
      kind: "ok",
      count: 3,
      names: ["Nick", "Bobby", "user3"],
      truncated: false,
    });
    expect(fetchSubscribers).toHaveBeenCalledWith({
      limit: PAGE_SIZE,
      withMember: true,
    });
  });

  it("paginates with an after cursor, is bounded, and flags truncation", async () => {
    let next = 1;
    const fetchSubscribers = jest.fn(async () => {
      const subs = Array.from({ length: PAGE_SIZE }, () => sub(next++));
      return page(subs);
    });
    const { client } = makeClient(fetchSubscribers);
    const result = await loadInterested(client, "guild-1", "n1", direct);
    expect(fetchSubscribers).toHaveBeenCalledTimes(MAX_PAGES);
    expect(fetchSubscribers).toHaveBeenLastCalledWith({
      limit: PAGE_SIZE,
      withMember: true,
      after: String(PAGE_SIZE * (MAX_PAGES - 1)),
    });
    expect(result).toMatchObject({
      kind: "ok",
      count: PAGE_SIZE * MAX_PAGES,
      truncated: true,
    });
    if (result.kind === "ok") expect(result.names).toHaveLength(MAX_NAMES);
  });

  it("stops when a page adds nobody new (no endless loop)", async () => {
    const fetchSubscribers = jest.fn(async () =>
      page(Array.from({ length: PAGE_SIZE }, (_, i) => sub(i + 1))),
    );
    const { client } = makeClient(fetchSubscribers);
    const result = await loadInterested(client, "guild-1", "n1", direct);
    expect(fetchSubscribers).toHaveBeenCalledTimes(2);
    expect(result).toMatchObject({ kind: "ok", count: PAGE_SIZE });
  });

  it("degrades to a message when Discord cannot be read, never throwing", async () => {
    const fetchSubscribers = jest.fn(async () => {
      throw new Error("boom");
    });
    const { client } = makeClient(fetchSubscribers);
    const result = await loadInterested(client, "guild-1", "n1", direct);
    expect(result).toEqual({
      kind: "unavailable",
      message: expect.stringContaining("Could not read"),
    });
  });

  it("reports an event deleted in Discord", async () => {
    const { client, fetchEvent } = makeClient(jest.fn());
    fetchEvent.mockRejectedValue(
      new DiscordAPIError(
        { message: "Unknown Guild Scheduled Event", code: 10070 },
        10070,
        404,
        "GET",
        "url",
        {},
      ),
    );
    const result = await loadInterested(client, "guild-1", "n1", direct);
    expect(result).toEqual({
      kind: "unavailable",
      message: expect.stringContaining("no longer exists"),
    });
  });
});
