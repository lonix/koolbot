import { describe, it, expect, jest } from '@jest/globals';

// Mock MongoDB before importing
jest.mock('mongodb', () => ({
  MongoClient: jest.fn().mockImplementation(() => ({
    connect: jest.fn().mockResolvedValue(undefined),
    db: jest.fn().mockReturnValue({ collection: jest.fn() }),
    close: jest.fn().mockResolvedValue(undefined),
  })),
}));

jest.mock('../../src/utils/logger.js', () => ({
  default: {
    info: jest.fn(),
    error: jest.fn(),
    warn: jest.fn(),
    debug: jest.fn(),
  },
}));

describe('Database Connection', () => {
  it('should have connectToDatabase function', async () => {
    const db = await import('../../src/utils/database.js');
    
    expect(typeof db.connectToDatabase).toBe('function');
  });

  it('should not throw when calling connectToDatabase', async () => {
    const { connectToDatabase } = await import('../../src/utils/database.js');
    
    await expect(connectToDatabase()).resolves.not.toThrow();
  });

  it('should have closeDatabaseConnection function', async () => {
    const { closeDatabaseConnection } = await import('../../src/utils/database.js');
    
    expect(typeof closeDatabaseConnection).toBe('function');
  });
});
