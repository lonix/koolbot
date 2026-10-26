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
import { expect, jest } from "@jest/globals";
import { TrackingOptOutService } from "../src/services/tracking-opt-out-service.js";

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

  // Like discord.js: acknowledging flips the state `safeReply` and
  // `replyWithError` read to choose between reply, editReply and followUp.
  const interaction: Record<string, unknown> = {
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
    reply: jest.fn(async () => {
      interaction.replied = true;
    }),
    deferReply: jest.fn(async () => {
      interaction.deferred = true;
    }),
    editReply: jest.fn(async () => undefined),
    followUp: jest.fn(async () => undefined),
    ...overrides,
  };
  return interaction as unknown as MockChatInputInteraction;
}

/** A stubbed button interaction with the reply surface exposed as mocks. */
export type MockButtonInteraction = ButtonInteraction & {
  reply: jest.Mock;
  update: jest.Mock;
  followUp: jest.Mock;
  deferUpdate: jest.Mock;
  deferReply: jest.Mock;
  editReply: jest.Mock;
};

/**
 * Like discord.js, acknowledging flips the state `safeReply` and
 * `replyWithError` read to choose between reply, editReply and followUp:
 * `reply` and `update` set `replied`; `deferReply` and `deferUpdate` set
 * `deferred`. (#1510: without this a handler's failure reply always looked
 * like a fresh `reply` in tests, whatever the handler had acknowledged.)
 */
export function createMockButtonInteraction(
  customId: string,
  overrides: Record<string, unknown> = {},
): MockButtonInteraction {
  const interaction: Record<string, unknown> = {
    customId,
    guildId: "guild-1",
    user: { id: "user-1", username: "alice" },
    client: createMockClient(),
    replied: false,
    deferred: false,
    reply: jest.fn(async () => {
      interaction.replied = true;
    }),
    update: jest.fn(async () => {
      interaction.replied = true;
    }),
    deferUpdate: jest.fn(async () => {
      interaction.deferred = true;
    }),
    deferReply: jest.fn(async () => {
      interaction.deferred = true;
    }),
    editReply: jest.fn(async () => undefined),
    followUp: jest.fn(async () => undefined),
    ...overrides,
  };
  return interaction as unknown as MockButtonInteraction;
}

/**
 * A member stub whose `permissions` is the raw string bitfield Discord sends
 * for a non-cached interaction member. `admin: true` sets the Administrator
 * bit (1 << 3), which is the shape `/quote` and `/config` gate on.
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

/**
 * Put the tracking opt-out cache (#918) into a loaded state holding exactly
 * these `[userId, guildId]` pairs, without touching Mongo.
 *
 * The trackers fail closed while the cache is unloaded — they record nothing
 * for anyone — so any tracker test that expects a write needs this, even
 * with no opt-outs at all.
 */
export function stubTrackingOptOuts(
  optedOut: Array<[userId: string, guildId: string]> = [],
): void {
  TrackingOptOutService.reset();
  (TrackingOptOutService.getInstance() as never as Record<string, unknown>)[
    "optedOut"
  ] = new Set(optedOut.map(([userId, guildId]) => `${guildId}:${userId}`));
}

type ModelStub = Record<string, jest.Mock>;

/**
 * Give every mongoose model its own stub for the current test file (#1089).
 *
 * The global mongoose mock (`__tests__/setup.ts`) normally hands every model
 * the SAME stub object, which forces a test that needs two collections to
 * behave differently to route on the shape of each call. After this call,
 * `Model.find`, `Model.updateOne` and friends are per model, so each
 * collection can be stubbed on its own with `mockModel("Name")`, or directly
 * on the imported model.
 *
 * Call it once at the top of the test file. It applies to the whole file
 * (the sandbox global is per test file) and does not affect other suites.
 * Do not use it in a suite that sets a method up through one model import
 * and reads it back through another.
 */
export function usePerModelStubs(): void {
  (globalThis as { __perModelStubs?: boolean }).__perModelStubs = true;
}

/**
 * The stub behind `mongoose.model(name)` once `usePerModelStubs()` is on:
 * `mockModel("ManagedVoiceChannel").find.mockResolvedValue(rows)`. `name` is
 * the first argument the model was registered with, not the variable name.
 */
export function mockModel(name: string): ModelStub {
  const stubFor = (globalThis as { __modelStubFor?: (n: string) => ModelStub })
    .__modelStubFor;
  if (!stubFor) {
    throw new Error("mockModel: the global mongoose mock is not installed");
  }
  return stubFor(name);
}

/**
 * A `ConfigService` stand-in for the `/me` pages (#1292), which read their
 * feature switches strictly. `values` maps a key to its stored boolean; an
 * absent key reads as the caller's fallback, as the real service does.
 * `getBoolean` and `getBooleanStrict` answer alike, so a test can make either
 * one throw through `extra` to exercise a failed read.
 */
export function meConfigStub(
  values: Record<string, boolean> = {},
  extra: Record<string, unknown> = {},
): Record<string, unknown> {
  const read = async (key: string, fallback = false): Promise<boolean> =>
    key in values ? values[key] : fallback;
  return {
    getBoolean: read,
    getBooleanStrict: read,
    getNumber: async (_key: string, fallback = 0): Promise<number> => fallback,
    ...extra,
  };
}

/**
 * What `replyWithError` / `replyWithUnexpectedError` (`src/utils/error-reply.ts`)
 * sends: one `embed-danger` embed. Each field is a string or an asymmetric
 * matcher (`expect.stringContaining(...)`); leave one out to ignore it.
 *
 * `expect(interaction.editReply).toHaveBeenCalledWith(errorEmbedPayload({
 *   title: "Couldn't post your LFG",
 *   description: expect.stringContaining("LFG channel"),
 * }))`
 */
export function errorEmbedPayload(fields: {
  title?: unknown;
  description?: unknown;
}): unknown {
  return expect.objectContaining({
    embeds: [
      expect.objectContaining({
        data: expect.objectContaining(fields),
      }),
    ],
  });
}

/** The generic "Something went wrong" payload every catch-all sends. */
export function unexpectedErrorPayload(): unknown {
  return errorEmbedPayload({
    title: "Something went wrong",
    description: expect.stringContaining("tell an admin"),
  });
}
