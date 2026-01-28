import { describe, it, expect, jest, beforeEach } from '@jest/globals';
import { data, autocomplete } from '../../src/commands/config/index.js';
import { AutocompleteInteraction } from 'discord.js';

describe('Config Command', () => {
  describe('command metadata', () => {
    it('should have correct command name', () => {
      expect(data.name).toBe('config');
    });

    it('should have a description', () => {
      expect(data.description).toBeDefined();
      expect(typeof data.description).toBe('string');
    });

    it('should be a valid slash command', () => {
      const json = data.toJSON();
      expect(json).toHaveProperty('name', 'config');
      expect(json).toHaveProperty('description');
    });

    it('should require administrator permissions', () => {
      const json = data.toJSON();
      expect(json.default_member_permissions).toBeDefined();
    });

    it('should have subcommands', () => {
      const json = data.toJSON();
      expect(json.options).toBeDefined();
      expect(Array.isArray(json.options)).toBe(true);
      expect(json.options?.length).toBeGreaterThan(0);
    });

    it('should have list subcommand', () => {
      const json = data.toJSON();
      const listSubcommand = json.options?.find((opt: any) => opt.name === 'list');
      expect(listSubcommand).toBeDefined();
    });

    it('should have set subcommand', () => {
      const json = data.toJSON();
      const setSubcommand = json.options?.find((opt: any) => opt.name === 'set');
      expect(setSubcommand).toBeDefined();
    });

    it('should have export subcommand', () => {
      const json = data.toJSON();
      const exportSubcommand = json.options?.find((opt: any) => opt.name === 'export');
      expect(exportSubcommand).toBeDefined();
    });

    it('should have import subcommand', () => {
      const json = data.toJSON();
      const importSubcommand = json.options?.find((opt: any) => opt.name === 'import');
      expect(importSubcommand).toBeDefined();
    });

    it('should have reload subcommand', () => {
      const json = data.toJSON();
      const reloadSubcommand = json.options?.find((opt: any) => opt.name === 'reload');
      expect(reloadSubcommand).toBeDefined();
    });

    it('should have autocomplete enabled on set subcommand key option', () => {
      const json = data.toJSON();
      const setSubcommand = json.options?.find((opt: any) => opt.name === 'set');
      const keyOption = setSubcommand?.options?.find((opt: any) => opt.name === 'key');
      expect(keyOption).toBeDefined();
      expect(keyOption?.autocomplete).toBe(true);
    });

    it('should have autocomplete enabled on reset subcommand key option', () => {
      const json = data.toJSON();
      const resetSubcommand = json.options?.find((opt: any) => opt.name === 'reset');
      const keyOption = resetSubcommand?.options?.find((opt: any) => opt.name === 'key');
      expect(keyOption).toBeDefined();
      expect(keyOption?.autocomplete).toBe(true);
    });
  });

  describe('autocomplete function', () => {
    let mockInteraction: any;
    let mockRespond: jest.Mock;

    beforeEach(() => {
      mockRespond = jest.fn();
      mockInteraction = {
        options: {
          getFocused: jest.fn(),
        },
        respond: mockRespond,
      } as unknown as AutocompleteInteraction;
    });

    it('should respond with config keys when focused option is "key"', async () => {
      (mockInteraction.options.getFocused as jest.Mock).mockReturnValue({
        name: 'key',
        value: 'voice',
      });

      await autocomplete(mockInteraction);

      expect(mockRespond).toHaveBeenCalledTimes(1);
      const response = mockRespond.mock.calls[0][0];
      expect(Array.isArray(response)).toBe(true);
      expect(response.length).toBeGreaterThan(0);
      // Should include voice-related keys
      expect(response.some((choice: any) => choice.value.includes('voice'))).toBe(true);
    });

    it('should respond with empty array when focused option is not "key"', async () => {
      (mockInteraction.options.getFocused as jest.Mock).mockReturnValue({
        name: 'value',
        value: 'test',
      });

      await autocomplete(mockInteraction);

      expect(mockRespond).toHaveBeenCalledTimes(1);
      expect(mockRespond).toHaveBeenCalledWith([]);
    });

    it('should limit results to 25 choices', async () => {
      (mockInteraction.options.getFocused as jest.Mock).mockReturnValue({
        name: 'key',
        value: '', // Empty search should return all keys
      });

      await autocomplete(mockInteraction);

      expect(mockRespond).toHaveBeenCalledTimes(1);
      const response = mockRespond.mock.calls[0][0];
      expect(response.length).toBeLessThanOrEqual(25);
    });

    it('should filter keys case-insensitively', async () => {
      (mockInteraction.options.getFocused as jest.Mock).mockReturnValue({
        name: 'key',
        value: 'VOICE',
      });

      await autocomplete(mockInteraction);

      expect(mockRespond).toHaveBeenCalledTimes(1);
      const response = mockRespond.mock.calls[0][0];
      expect(response.length).toBeGreaterThan(0);
      expect(response.some((choice: any) => choice.value.includes('voice'))).toBe(true);
    });

    it('should respond with empty array on error', async () => {
      (mockInteraction.options.getFocused as jest.Mock).mockImplementation(() => {
        throw new Error('Test error');
      });

      await autocomplete(mockInteraction);

      expect(mockRespond).toHaveBeenCalledTimes(1);
      expect(mockRespond).toHaveBeenCalledWith([]);
    });

    it('should include description in choice names', async () => {
      (mockInteraction.options.getFocused as jest.Mock).mockReturnValue({
        name: 'key',
        value: 'ping.enabled',
      });

      await autocomplete(mockInteraction);

      expect(mockRespond).toHaveBeenCalledTimes(1);
      const response = mockRespond.mock.calls[0][0];
      expect(response.length).toBeGreaterThan(0);
      const pingChoice = response.find((choice: any) => choice.value === 'ping.enabled');
      expect(pingChoice).toBeDefined();
      expect(pingChoice.name).toContain('ping.enabled');
      expect(pingChoice.name).toContain(' - '); // Description separator with spaces
    });

    it('should ensure all choice names are within Discord 100 character limit', async () => {
      (mockInteraction.options.getFocused as jest.Mock).mockReturnValue({
        name: 'key',
        value: '', // Empty search to get all keys
      });

      await autocomplete(mockInteraction);

      expect(mockRespond).toHaveBeenCalledTimes(1);
      const response = mockRespond.mock.calls[0][0];
      
      // Verify all choice names are within Discord's 100 character limit
      response.forEach((choice: any) => {
        expect(choice.name.length).toBeGreaterThan(0);
        expect(choice.name.length).toBeLessThanOrEqual(100);
      });
    });

    it('should truncate descriptions for long keys to fit 100 char limit', async () => {
      (mockInteraction.options.getFocused as jest.Mock).mockReturnValue({
        name: 'key',
        value: 'voicetracking.cleanup.retention', // Long key prefix
      });

      await autocomplete(mockInteraction);

      expect(mockRespond).toHaveBeenCalledTimes(1);
      const response = mockRespond.mock.calls[0][0];
      
      // Should have results for long keys
      expect(response.length).toBeGreaterThan(0);
      
      // All names should still be within limit
      response.forEach((choice: any) => {
        expect(choice.name.length).toBeLessThanOrEqual(100);
      });
    });

    it('should handle all current config keys properly', async () => {
      // Verify that all existing config keys (even the longest ones) are handled correctly
      // The longest current key is ~57 chars, well within safe range
      (mockInteraction.options.getFocused as jest.Mock).mockReturnValue({
        name: 'key',
        value: 'voicetracking', // Get all voicetracking keys (some are long)
      });

      await autocomplete(mockInteraction);

      expect(mockRespond).toHaveBeenCalledTimes(1);
      const response = mockRespond.mock.calls[0][0];
      
      // All keys should be handled properly
      response.forEach((choice: any) => {
        expect(choice.name.length).toBeGreaterThan(0);
        expect(choice.name.length).toBeLessThanOrEqual(100);
        expect(choice.value).toBeTruthy();
      });
    });
  });
});
