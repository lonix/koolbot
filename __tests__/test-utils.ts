/**
 * Creates a mock Discord.js Collection with common methods
 */
export function createMockCollection<K, V>(entries: [K, V][] = []): any {
  const map = new Map(entries);

  return {
    get: (key: K): V | undefined => map.get(key),
    set: (key: K, value: V): Map<K, V> => map.set(key, value),
    has: (key: K): boolean => map.has(key),
    delete: (key: K): boolean => map.delete(key),
    clear: (): void => map.clear(),
    forEach: (fn: (value: V, key: K) => void): void => map.forEach(fn),
    map: <T>(fn: (value: V, key: K) => T): T[] =>
      Array.from(map.values()).map((v, i) => fn(v, Array.from(map.keys())[i])),
    filter: (
      fn: (value: V, key: K) => boolean,
    ): ReturnType<typeof createMockCollection<K, V>> => {
      const filtered = Array.from(map.entries()).filter(([k, v]) => fn(v, k));
      return createMockCollection(filtered);
    },
    find: (fn: (value: V, key: K) => boolean): V | undefined => {
      for (const [k, v] of map.entries()) {
        if (fn(v, k)) return v;
      }
      return undefined;
    },
    some: (fn: (value: V, key: K) => boolean): boolean => {
      for (const [k, v] of map.entries()) {
        if (fn(v, k)) return true;
      }
      return false;
    },
    every: (fn: (value: V, key: K) => boolean): boolean => {
      for (const [k, v] of map.entries()) {
        if (!fn(v, k)) return false;
      }
      return true;
    },
    reduce: <T>(fn: (acc: T, value: V, key: K) => T, initial: T): T => {
      let acc = initial;
      for (const [k, v] of map.entries()) {
        acc = fn(acc, v, k);
      }
      return acc;
    },
    size: map.size,
    first: () => map.values().next().value,
    last: () => Array.from(map.values()).pop(),
    random: (): V | undefined => {
      const values = Array.from(map.values());
      return values[Math.floor(Math.random() * values.length)];
    },
    array: (): V[] => Array.from(map.values()),
    keyArray: (): K[] => Array.from(map.keys()),
    values: (): IterableIterator<V> => map.values(),
    keys: (): IterableIterator<K> => map.keys(),
    entries: (): IterableIterator<[K, V]> => map.entries(),
    [Symbol.iterator]: (): IterableIterator<[K, V]> => map[Symbol.iterator](),
  };
}

// ===========================================================================
// Shared Discord mocks
//
// Every suite used to hand-roll its own client/interaction stubs, which is a
// large part of why so many test files duplicate setup (issue #849). Prefer
// these builders for new tests; they cover the surface the command handlers
// actually touch and accept overrides for the rest.
// ===========================================================================

import type {
  ButtonInteraction,
  ChatInputCommandInteraction,
  Client,
} from "discord.js";
import { jest } from "@jest/globals";

/** Option values a command handler can read off `interaction.options`. */
export interface MockCommandOptions {
  subcommand?: string;
  strings?: Record<string, string | null>;
  integers?: Record<string, number | null>;
  booleans?: Record<string, boolean | null>;
  users?: Record<string, { id: string; username?: string } | null>;
  attachments?: Record<
    string,
    { url: string; size: number; name?: string } | null
  >;
}

/** A stubbed interaction with the reply surface exposed as jest mocks. */
export type MockChatInputInteraction = ChatInputCommandInteraction & {
  reply: jest.Mock;
  deferReply: jest.Mock;
  editReply: jest.Mock;
  followUp: jest.Mock;
};

/**
 * Minimal Discord `Client` stub: an id-bearing `user`, an empty channel
 * cache and a `guilds.fetch` mock. Pass `overrides` for whatever else the
 * code under test reaches for.
 */
export function createMockClient(
  overrides: Record<string, unknown> = {},
): Client {
  return {
    user: { id: "bot-user-id" },
    channels: { cache: new Map(), fetch: jest.fn() },
    guilds: { cache: new Map(), fetch: jest.fn() },
    ...overrides,
  } as unknown as Client;
}

/**
 * Build a `ChatInputCommandInteraction` stub whose `options` getters read
 * from the supplied maps. Getters mirror discord.js semantics closely
 * enough for handler tests: a `required` lookup of a missing option throws,
 * an optional one returns null.
 */
export function createMockChatInputInteraction(
  options: MockCommandOptions = {},
  overrides: Record<string, unknown> = {},
): MockChatInputInteraction {
  const lookup =
    <T>(bag: Record<string, T | null> | undefined, kind: string) =>
    (name: string, required?: boolean): T | null => {
      const value = bag?.[name] ?? null;
      if (value === null && required) {
        throw new Error(`Required ${kind} option "${name}" not found`);
      }
      return value;
    };

  return {
    id: "interaction-id",
    commandName: "test",
    guildId: "guild-1",
    channelId: "channel-1",
    user: { id: "user-1", username: "alice" },
    member: null,
    client: createMockClient(),
    replied: false,
    deferred: false,
    isChatInputCommand: (): boolean => true,
    options: {
      getSubcommand: (): string => {
        if (!options.subcommand) throw new Error("No subcommand specified");
        return options.subcommand;
      },
      getString: lookup(options.strings, "string"),
      getInteger: lookup(options.integers, "integer"),
      getBoolean: lookup(options.booleans, "boolean"),
      getUser: lookup(options.users, "user"),
      getAttachment: lookup(options.attachments, "attachment"),
    },
    reply: jest.fn(async () => undefined),
    deferReply: jest.fn(async () => undefined),
    editReply: jest.fn(async () => undefined),
    followUp: jest.fn(async () => undefined),
    ...overrides,
  } as unknown as MockChatInputInteraction;
}

/** A stubbed button interaction with the reply surface exposed as mocks. */
export type MockButtonInteraction = ButtonInteraction & {
  reply: jest.Mock;
  update: jest.Mock;
  followUp: jest.Mock;
};

export function createMockButtonInteraction(
  customId: string,
  overrides: Record<string, unknown> = {},
): MockButtonInteraction {
  return {
    customId,
    guildId: "guild-1",
    user: { id: "user-1", username: "alice" },
    client: createMockClient(),
    replied: false,
    deferred: false,
    reply: jest.fn(async () => undefined),
    update: jest.fn(async () => undefined),
    followUp: jest.fn(async () => undefined),
    ...overrides,
  } as unknown as MockButtonInteraction;
}

/**
 * A member stub whose `permissions` is the raw string bitfield Discord sends
 * for a non-cached interaction member. `admin: true` sets the Administrator
 * bit (1 << 3), which is the shape `/quote`, `/event` and `/config` gate on.
 */
export function createRawMember(admin: boolean): { permissions: string } {
  return { permissions: admin ? String(1n << 3n) : "0" };
}

/**
 * Stub out a service's `MongoConnectionGuard` so `ensureConnection()` is a
 * no-op and the test never reaches a real `mongoose.connect`.
 *
 * Replaces the older `(service as never)["isConnected"] = true` poke: the
 * connection flag now lives inside the guard (`src/utils/mongo.ts`), not on
 * the service.
 */
export function stubMongoGuard(service: unknown): void {
  (service as Record<string, unknown>)["mongo"] = {
    isConnected: true,
    ensureConnection: jest.fn(async () => undefined),
  };
}
