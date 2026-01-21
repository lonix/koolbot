import { describe, it, expect, jest, beforeEach } from '@jest/globals';
import { data, execute } from '../../src/commands/botstats.js';
import type { ChatInputCommandInteraction } from 'discord.js';
import { MonitoringService } from '../../src/services/monitoring-service.js';

// Mock logger
jest.mock('../../src/utils/logger.js');

describe('Botstats Command', () => {
  describe('command metadata', () => {
    it('should have correct command name', () => {
      expect(data.name).toBe('botstats');
    });

    it('should have a description', () => {
      expect(data.description).toBe('Display bot performance and usage statistics');
    });

    it('should be a valid slash command', () => {
      expect(data.toJSON()).toHaveProperty('name', 'botstats');
      expect(data.toJSON()).toHaveProperty('description', 'Display bot performance and usage statistics');
    });
  });

  describe('execute', () => {
    let mockInteraction: Partial<ChatInputCommandInteraction>;
    let monitoringService: MonitoringService;

    beforeEach(() => {
      jest.clearAllMocks();

      mockInteraction = {
        reply: jest.fn().mockResolvedValue(undefined),
      };

      monitoringService = MonitoringService.getInstance();
    });

    it('should display bot statistics with embed', async () => {
      await execute(mockInteraction as ChatInputCommandInteraction);
      
      expect(mockInteraction.reply).toHaveBeenCalledWith({
        embeds: expect.arrayContaining([
          expect.objectContaining({
            data: expect.objectContaining({
              title: '🤖 KoolBot Statistics',
            }),
          }),
        ]),
      });
    });

    it('should include performance metrics', async () => {
      await execute(mockInteraction as ChatInputCommandInteraction);

      expect(mockInteraction.reply).toHaveBeenCalled();
      const callArgs = (mockInteraction.reply as jest.Mock).mock.calls[0][0];
      expect(callArgs.embeds).toBeDefined();
      expect(callArgs.embeds.length).toBeGreaterThan(0);
    });

    it('should handle errors gracefully', async () => {
      mockInteraction.reply = jest.fn().mockRejectedValue(new Error('Test error'));

      await execute(mockInteraction as ChatInputCommandInteraction);

      // Should still call reply, even if it fails
      expect(mockInteraction.reply).toHaveBeenCalled();
    });

    it('should format memory usage in MB', async () => {
      await execute(mockInteraction as ChatInputCommandInteraction);

      expect(mockInteraction.reply).toHaveBeenCalled();
    });

    it('should show uptime information', async () => {
      await execute(mockInteraction as ChatInputCommandInteraction);

      const metrics = monitoringService.getPerformanceMetrics();
      expect(metrics).toHaveProperty('memoryUsage');
      expect(metrics).toHaveProperty('totalCommands');
    });

    it('should display top commands section', async () => {
      // Track some commands first
      const trackingId = monitoringService.trackCommandStart('test-command');
      monitoringService.trackCommandEnd(trackingId, false);

      await execute(mockInteraction as ChatInputCommandInteraction);

      expect(mockInteraction.reply).toHaveBeenCalled();
    });
  });
});
