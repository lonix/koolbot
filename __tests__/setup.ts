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
// `model()` keeps returning one shared stub object: several suites set up a
// model's methods through one import and read them through another, so giving
// each model its own stub would break them. The schema each model was built
// with is recorded in `mockSchemas` instead, which is what lets a model test
// assert its own indexes and defaults without a database.
const sharedModelStub = {
  find: jest.fn().mockResolvedValue([]),
  findOne: jest.fn().mockResolvedValue(null),
  findOneAndUpdate: jest.fn().mockResolvedValue(null),
  deleteMany: jest.fn().mockResolvedValue(null),
  create: jest.fn().mockResolvedValue({}),
  countDocuments: jest.fn().mockResolvedValue(0),
  aggregate: jest.fn().mockResolvedValue([]),
};

const mockModel = (
  name: string,
  schema?: MockSchema,
): typeof sharedModelStub => {
  if (schema) mockSchemas.set(name, schema);
  return sharedModelStub;
};

const mockConnection = {
  on: jest.fn(),
  close: jest.fn().mockResolvedValue(undefined),
  readyState: 1,
};

jest.mock("mongoose", () => ({
  default: {
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
