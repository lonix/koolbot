import { describe, it, expect, jest, beforeEach } from '@jest/globals';
import { data, execute } from '../../src/commands/help.js';
import type { ChatInputCommandInteraction, CommandInteractionOptionResolver } from 'discord.js';

// Mock logger
jest.mock('../../src/utils/logger.js');

describe('Help Command', () => {
  describe('command metadata', () => {
    it('should have correct command name', () => {
      expect(data.name).toBe('help');
    });

    it('should have a description', () => {
      expect(data.description).toBeTruthy();
      expect(data.description).toBe('Get help with KoolBot commands');
    });

    it('should be a valid slash command', () => {
      const json = data.toJSON();
      expect(json).toHaveProperty('name', 'help');
      expect(json).toHaveProperty('description');
    });

    it('should have optional command parameter', () => {
      const json = data.toJSON();
      expect(json.options).toBeDefined();
      expect(json.options?.length).toBe(1);
      
      const commandOption = json.options?.[0];
      expect(commandOption?.name).toBe('command');
      expect(commandOption?.type).toBe(3); // STRING type
      expect(commandOption?.required).toBe(false);
    });

    it('should have description for command parameter', () => {
      const json = data.toJSON();
      const commandOption = json.options?.[0];
      expect(commandOption?.description).toBeTruthy();
      expect(commandOption?.description).toContain('specific command');
    });
  });

  describe('execute', () => {
    let mockInteraction: Partial<ChatInputCommandInteraction>;

    beforeEach(() => {
      jest.clearAllMocks();

      mockInteraction = {
        options: {
          getString: jest.fn().mockReturnValue(null),
        } as any,
        reply: jest.fn().mockResolvedValue(undefined),
      };
    });

    it('should show general help when no command is specified', async () => {
      await execute(mockInteraction as ChatInputCommandInteraction);

      expect(mockInteraction.reply).toHaveBeenCalledWith({
        embeds: expect.arrayContaining([
          expect.objectContaining({
            data: expect.objectContaining({
              title: '📚 KoolBot Help',
            }),
          }),
        ]),
        ephemeral: true,
      });
    });

    it('should show specific command help when valid command is specified', async () => {
      (mockInteraction.options!.getString as jest.Mock).mockReturnValue('ping');

      await execute(mockInteraction as ChatInputCommandInteraction);

      expect(mockInteraction.reply).toHaveBeenCalledWith({
        embeds: expect.arrayContaining([
          expect.objectContaining({
            data: expect.objectContaining({
              title: '📖 Help: /ping',
            }),
          }),
        ]),
        ephemeral: true,
      });
    });

    it('should show error for non-existent command', async () => {
      (mockInteraction.options!.getString as jest.Mock).mockReturnValue('nonexistent');

      await execute(mockInteraction as ChatInputCommandInteraction);

      expect(mockInteraction.reply).toHaveBeenCalledWith({
        content: expect.stringContaining('Command `/nonexistent` not found'),
        ephemeral: true,
      });
    });

    it('should handle commands without config keys', async () => {
      (mockInteraction.options!.getString as jest.Mock).mockReturnValue('config');

      await execute(mockInteraction as ChatInputCommandInteraction);

      expect(mockInteraction.reply).toHaveBeenCalled();
    });

    it('should include usage information in specific command help', async () => {
      (mockInteraction.options!.getString as jest.Mock).mockReturnValue('vctop');

      await execute(mockInteraction as ChatInputCommandInteraction);

      expect(mockInteraction.reply).toHaveBeenCalledWith({
        embeds: expect.arrayContaining([
          expect.objectContaining({
            data: expect.objectContaining({
              fields: expect.arrayContaining([
                expect.objectContaining({
                  name: 'Usage',
                }),
              ]),
            }),
          }),
        ]),
        ephemeral: true,
      });
    });

    it('should handle multiple known commands', async () => {
      const commands = ['ping', 'help', 'quote', 'botstats'];
      
      for (const cmd of commands) {
        mockInteraction.reply = jest.fn().mockResolvedValue(undefined);
        (mockInteraction.options!.getString as jest.Mock).mockReturnValue(cmd);
        
        await execute(mockInteraction as ChatInputCommandInteraction);
        
        expect(mockInteraction.reply).toHaveBeenCalled();
      }
    });
  });
});
