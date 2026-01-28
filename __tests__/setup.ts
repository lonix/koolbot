import { jest } from '@jest/globals';

// Mock ConfigService globally to prevent MongoDB connections and hangs
jest.mock('../src/services/config-service.js', () => ({
  ConfigService: {
    getInstance: jest.fn(() => ({
      getString: jest.fn().mockResolvedValue('test-value'),
      getNumber: jest.fn().mockResolvedValue(123),
      getBoolean: jest.fn().mockResolvedValue(true),
      getConfig: jest.fn().mockResolvedValue(new Map()),
      triggerReload: jest.fn().mockResolvedValue(undefined),
      onReload: jest.fn(),
    })),
  },
}));

// Create a mock Schema class
class MockSchema {
  constructor() {
    return this;
  }
  static Types = {
    Mixed: 'Mixed',
    ObjectId: 'ObjectId',
    String: String,
    Number: Number,
    Boolean: Boolean,
    Date: Date,
  };
  index(): this {
    return this;
  }
}

// Mock mongoose globally to prevent DB connections
jest.mock('mongoose', () => ({
  default: {
    connect: jest.fn().mockResolvedValue(undefined),
    connection: {
      close: jest.fn().mockResolvedValue(undefined),
      readyState: 1,
    },
    Schema: MockSchema,
    model: jest.fn().mockReturnValue({
      find: jest.fn().mockResolvedValue([]),
      findOne: jest.fn().mockResolvedValue(null),
      findOneAndUpdate: jest.fn().mockResolvedValue(null),
      create: jest.fn().mockResolvedValue({}),
    }),
  },
  connect: jest.fn().mockResolvedValue(undefined),
  connection: {
    close: jest.fn().mockResolvedValue(undefined),
    readyState: 1,
  },
  Schema: MockSchema,
  model: jest.fn().mockReturnValue({
    find: jest.fn().mockResolvedValue([]),
    findOne: jest.fn().mockResolvedValue(null),
    findOneAndUpdate: jest.fn().mockResolvedValue(null),
    create: jest.fn().mockResolvedValue({}),
  }),
}));
