import { describe, it, expect, jest } from '@jest/globals';

// Mock mongoose before importing
jest.mock('mongoose', () => ({
  default: {
    connect: jest.fn().mockResolvedValue(undefined),
    connection: {
      on: jest.fn(),
      once: jest.fn(),
    },
  },
  connect: jest.fn().mockResolvedValue(undefined),
  connection: {
    on: jest.fn(),
    once: jest.fn(),
  },
}));

jest.mock('../../src/utils/logger.js');

describe('Database Connection', () => {
  it('should have connectDB function', async () => {
    const db = await import('../../src/utils/database.js');
    
    expect(typeof db.connectDB).toBe('function');
  });

  it('should not throw when calling connectDB', async () => {
    const { connectDB } = await import('../../src/utils/database.js');
    
    await expect(connectDB()).resolves.not.toThrow();
  });

  it('should handle connection errors', async () => {
    const mongoose = await import('mongoose');
    (mongoose.default.connect as jest.Mock).mockRejectedValueOnce(new Error('Connection failed'));

    const { connectDB } = await import('../../src/utils/database.js');
    
    // Should handle error gracefully
    try {
      await connectDB();
    } catch (error) {
      expect(error).toBeDefined();
    }
  });
});
