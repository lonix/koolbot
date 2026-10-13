import { jest } from "@jest/globals";

// Mock ConfigService globally to prevent MongoDB connections and hangs
jest.mock("../src/services/config-service.js", () => ({
  ConfigService: {
    getInstance: jest.fn(() => ({
      getString: jest.fn().mockResolvedValue("test-value"),
      getNumber: jest.fn().mockResolvedValue(123),
      getBoolean: jest.fn().mockResolvedValue(true),
      getConfig: jest.fn().mockResolvedValue(new Map()),
      triggerReload: jest.fn().mockResolvedValue(undefined),
      onReload: jest.fn(),
      registerReloadCallback: jest.fn(),
    })),
  },
}));

// Create a mock Schema class
/**
 * Stand-in for `mongoose.Schema`.
 *
 * It records enough of the definition to let a model test assert its own
 * schema — the field options and the declared indexes — without a database.
 * Schema-level guarantees are otherwise untestable here: every service test
 * mocks its model module out, so nothing loads the real schema, and a
 * regression in (say) a TTL index would fail no test at all.
 */
/**
 * Schemas by model name, populated as each model module is loaded.
 *
 * `mongoose.model` deliberately keeps returning one shared stub object —
 * several suites rely on that — so the schema cannot travel on the model.
 * A registry keeps schema-level assertions possible without changing what
 * any existing test sees.
 */
const mockSchemas = new Map<string, MockSchema>();

// Exposed globally rather than exported: `setup.ts` is a setup file, and a
// test importing it would evaluate this module a second time.
(globalThis as { __mockSchemas?: Map<string, MockSchema> }).__mockSchemas =
  mockSchemas;

class MockSchema {
  private readonly definition: Record<string, Record<string, unknown>>;
  private readonly declaredIndexes: Array<
    [Record<string, unknown>, Record<string, unknown>]
  > = [];

  constructor(definition: Record<string, Record<string, unknown>> = {}) {
    this.definition = definition;
  }

  static Types = {
    Mixed: "Mixed",
    ObjectId: "ObjectId",
    String: String,
    Number: Number,
    Boolean: Boolean,
    Date: Date,
  };

  index(
    fields: Record<string, unknown> = {},
    options: Record<string, unknown> = {},
  ): this {
    this.declaredIndexes.push([fields, options]);
    return this;
  }

  /** Mirrors `Schema.prototype.indexes()`: the declared compound indexes. */
  indexes(): Array<[Record<string, unknown>, Record<string, unknown>]> {
    return this.declaredIndexes;
  }

  /** Mirrors `Schema.prototype.path(name).options`. */
  path(name: string): { options: Record<string, unknown> } {
    return { options: this.definition[name] ?? {} };
  }
}

// Pure helper, safe to mirror the real behaviour (24 hex chars or a
// 12-char string), so id-validation guards work under the global mock.
const mockIsValidObjectId = (id: unknown): boolean =>
  typeof id === "string" && (/^[0-9a-fA-F]{24}$/.test(id) || id.length === 12);

// Mock mongoose globally to prevent DB connections
//
// By default every model resolves to one shared stub object: several suites
// set up a model's methods through one import and read them through another,
// so giving each model its own stub would break them. A suite that wants
// independent stubs opts in with `usePerModelStubs()` (see `test-utils.ts`). The schema each model was built
// with is recorded in `mockSchemas` instead, which is what lets a model test
// assert its own indexes and defaults without a database.
const createModelStub = () => ({
  find: jest.fn().mockResolvedValue([]),
  findOne: jest.fn().mockResolvedValue(null),
  findOneAndUpdate: jest.fn().mockResolvedValue(null),
  deleteMany: jest.fn().mockResolvedValue(null),
  create: jest.fn().mockResolvedValue({}),
  countDocuments: jest.fn().mockResolvedValue(0),
  aggregate: jest.fn().mockResolvedValue([]),
});

const sharedModelStub = createModelStub();

/**
 * Per-model stubs (#1089), keyed by model name and created on first use.
 *
 * A test opts in with `usePerModelStubs()` from `test-utils.ts` and then gets
 * an independent stub per `mongoose.model(name)`, so two collections can be
 * stubbed differently without routing on the shape of each call. Exposed on
 * `globalThis` for the same reason as `__mockSchemas` above.
 */
const perModelStubs = new Map<string, ReturnType<typeof createModelStub>>();
const modelStubFor = (name: string): ReturnType<typeof createModelStub> => {
  let stub = perModelStubs.get(name);
  if (!stub) {
    stub = createModelStub();
    perModelStubs.set(name, stub);
  }
  return stub;
};

const modelStubGlobals = globalThis as {
  __modelStubFor?: typeof modelStubFor;
  __perModelStubs?: boolean;
};
modelStubGlobals.__modelStubFor = modelStubFor;

/**
 * What `mongoose.model(name)` returns: a stable proxy per name that forwards
 * every property read and write to the shared stub (the default, which
 * existing suites rely on) or, once `__perModelStubs` is switched on, to that
 * model's own stub. The switch is read on each access rather than at
 * `model()` time, because model modules are imported (and so call `model()`)
 * before a test body can opt in.
 */
const modelProxies = new Map<string, typeof sharedModelStub>();
const activeStub = (name: string): typeof sharedModelStub =>
  modelStubGlobals.__perModelStubs ? modelStubFor(name) : sharedModelStub;

const proxyFor = (name: string): typeof sharedModelStub => {
  let proxy = modelProxies.get(name);
  if (!proxy) {
    proxy = new Proxy(sharedModelStub, {
      get: (_t, prop) => Reflect.get(activeStub(name), prop),
      set: (_t, prop, value) => Reflect.set(activeStub(name), prop, value),
      has: (_t, prop) => Reflect.has(activeStub(name), prop),
      deleteProperty: (_t, prop) =>
        Reflect.deleteProperty(activeStub(name), prop),
      defineProperty: (_t, prop, desc) =>
        Reflect.defineProperty(activeStub(name), prop, desc),
      getOwnPropertyDescriptor: (_t, prop) =>
        Reflect.getOwnPropertyDescriptor(activeStub(name), prop),
      ownKeys: () => Reflect.ownKeys(activeStub(name)),
    });
    modelProxies.set(name, proxy);
  }
  return proxy;
};

const mockModel = (
  name: string,
  schema?: MockSchema,
): typeof sharedModelStub => {
  if (schema) mockSchemas.set(name, schema);
  return proxyFor(name);
};

const mockConnection = {
  on: jest.fn(),
  close: jest.fn().mockResolvedValue(undefined),
  readyState: 1,
};

// Stand-in for `mongoose.Types.ObjectId`: ids that increase in creation order,
// like real ones from one process (the anti-raid log rows rely on that order).
class MockObjectId {
  private static counter = 0;
  private readonly value = String(++MockObjectId.counter).padStart(24, "0");
  toString(): string {
    return this.value;
  }
}

jest.mock("mongoose", () => ({
  Types: { ObjectId: MockObjectId },
  default: {
    Types: { ObjectId: MockObjectId },
    connect: jest.fn().mockResolvedValue(undefined),
    connection: mockConnection,
    isValidObjectId: mockIsValidObjectId,
    Schema: MockSchema,
    model: jest.fn(mockModel),
  },
  connect: jest.fn().mockResolvedValue(undefined),
  connection: mockConnection,
  isValidObjectId: mockIsValidObjectId,
  Schema: MockSchema,
  model: jest.fn(mockModel),
}));
