import { describe, it, expect, beforeEach, jest } from '@jest/globals';
import { QuoteService } from '../../src/services/quote-service.js';

jest.mock('mongoose');
jest.mock('../../src/database/schema.js');
jest.mock('../../src/services/config-service.js');
jest.mock('../../src/services/cooldown-manager.js');
jest.mock('../../src/utils/logger.js');

const VALID_ID = '0123456789abcdef01234567';

describe('QuoteService backup & vote persistence', () => {
  let service: QuoteService;
  let model: any;

  beforeEach(() => {
    jest.clearAllMocks();
    service = new QuoteService();
    model = {
      find: jest.fn(),
      findOne: jest.fn(),
      findOneAndUpdate: jest.fn(),
      create: jest.fn(),
    };
    // Replace the (mongoose-mocked) model with a controllable stub.
    (service as any).model = model;
  });

  describe('setVoteCountsByMessageId', () => {
    it('writes the tally keyed by messageId', async () => {
      model.findOneAndUpdate.mockResolvedValue({});
      await service.setVoteCountsByMessageId('msg1', 3, 1);
      expect(model.findOneAndUpdate).toHaveBeenCalledWith(
        { messageId: 'msg1' },
        { likes: 3, dislikes: 1 },
      );
    });

    it('clamps negative counts to zero', async () => {
      model.findOneAndUpdate.mockResolvedValue({});
      await service.setVoteCountsByMessageId('msg1', -2, -5);
      expect(model.findOneAndUpdate).toHaveBeenCalledWith(
        { messageId: 'msg1' },
        { likes: 0, dislikes: 0 },
      );
    });

    it('is a no-op when messageId is empty', async () => {
      await service.setVoteCountsByMessageId('', 1, 1);
      expect(model.findOneAndUpdate).not.toHaveBeenCalled();
    });
  });

  describe('exportQuotes', () => {
    it('serialises quotes including vote tallies', async () => {
      const docs = [
        {
          _id: { toString: () => VALID_ID },
          content: 'hi',
          authorId: 'a',
          addedById: 'b',
          channelId: 'c',
          messageId: 'm',
          likes: 2,
          dislikes: 1,
          createdAt: new Date('2020-01-01T00:00:00Z'),
          addedAt: new Date('2020-01-02T00:00:00Z'),
        },
      ];
      model.find.mockReturnValue({ sort: jest.fn().mockResolvedValue(docs) });

      const out = await service.exportQuotes();

      expect(out.version).toBe(1);
      expect(out.quotes).toHaveLength(1);
      expect(out.quotes[0]).toMatchObject({
        id: VALID_ID,
        content: 'hi',
        likes: 2,
        dislikes: 1,
      });
    });
  });

  describe('importQuotes', () => {
    it('imports new entries and preserves id + votes', async () => {
      model.findOne.mockResolvedValue(null);
      model.create.mockResolvedValue({});

      const res = await service.importQuotes({
        version: 1,
        exportedAt: 'x',
        quotes: [
          {
            id: VALID_ID,
            content: 'hi',
            authorId: 'a',
            addedById: 'b',
            channelId: 'c',
            messageId: 'm',
            likes: 2,
            dislikes: 1,
          },
        ],
      });

      expect(res.imported).toBe(1);
      expect(res.skipped).toBe(0);
      expect(model.create).toHaveBeenCalledWith(
        expect.objectContaining({
          _id: VALID_ID,
          content: 'hi',
          likes: 2,
          dislikes: 1,
        }),
      );
    });

    it('round-trips an export back into an import', async () => {
      const docs = [
        {
          _id: { toString: () => VALID_ID },
          content: 'round trip',
          authorId: 'a',
          addedById: 'b',
          channelId: 'c',
          messageId: 'm',
          likes: 5,
          dislikes: 2,
          createdAt: new Date('2021-01-01T00:00:00Z'),
          addedAt: new Date('2021-01-01T00:00:00Z'),
        },
      ];
      model.find.mockReturnValue({ sort: jest.fn().mockResolvedValue(docs) });
      const exported = await service.exportQuotes();

      model.findOne.mockResolvedValue(null);
      model.create.mockResolvedValue({});
      const res = await service.importQuotes(exported);

      expect(res.imported).toBe(1);
      expect(model.create).toHaveBeenCalledWith(
        expect.objectContaining({ content: 'round trip', likes: 5, dislikes: 2 }),
      );
    });

    it('skips an entry whose original id already exists', async () => {
      model.findOne.mockResolvedValue({ _id: 'exists' });

      const res = await service.importQuotes({
        quotes: [
          { id: VALID_ID, content: 'hi', authorId: 'a', addedById: 'b' },
        ],
      });

      expect(res.imported).toBe(0);
      expect(res.skipped).toBe(1);
      expect(model.create).not.toHaveBeenCalled();
    });

    it('rejects a structurally invalid payload', async () => {
      const res = await service.importQuotes(null);
      expect(res.imported).toBe(0);
      expect(res.errors.length).toBeGreaterThan(0);
    });

    it('records an error for an entry missing content', async () => {
      const res = await service.importQuotes({
        quotes: [{ authorId: 'a', addedById: 'b' }],
      });
      expect(res.skipped).toBe(1);
      expect(res.errors[0]).toMatch(/content/i);
    });
  });
});
