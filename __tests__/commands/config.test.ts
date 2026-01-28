import { describe, it, expect } from '@jest/globals';
import { data } from '../../src/commands/config/index.js';

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
  });
});
