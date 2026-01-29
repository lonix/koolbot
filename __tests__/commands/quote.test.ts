import { describe, it, expect } from '@jest/globals';
import { data } from '../../src/commands/quote.js';

describe('Quote Command', () => {
  describe('command metadata', () => {
    it('should have correct command name', () => {
      expect(data.name).toBe('quote');
    });

    it('should have a description', () => {
      expect(data.description).toBeTruthy();
      expect(data.description).toContain('quote');
    });

    it('should be a valid slash command', () => {
      const json = data.toJSON();
      expect(json).toHaveProperty('name', 'quote');
      expect(json).toHaveProperty('description');
    });

    it('should have subcommands', () => {
      const json = data.toJSON();
      expect(json.options).toBeDefined();
      expect(json.options?.length).toBeGreaterThanOrEqual(2);
      
      // Check for 'add' subcommand
      const addSubcommand = json.options?.find((opt: any) => opt.name === 'add');
      expect(addSubcommand).toBeDefined();
      expect(addSubcommand?.type).toBe(1); // SUBCOMMAND type
      
      // Check for 'edit' subcommand
      const editSubcommand = json.options?.find((opt: any) => opt.name === 'edit');
      expect(editSubcommand).toBeDefined();
      expect(editSubcommand?.type).toBe(1); // SUBCOMMAND type
    });
  });

  describe('add subcommand', () => {
    it('should have text parameter', () => {
      const json = data.toJSON();
      const addSubcommand = json.options?.find((opt: any) => opt.name === 'add');
      expect(addSubcommand).toBeDefined();
      
      const textOption = addSubcommand?.options?.find((opt: any) => opt.name === 'text');
      expect(textOption).toBeDefined();
      expect(textOption?.type).toBe(3); // STRING type
      expect(textOption?.required).toBe(true);
      expect(textOption?.description).toContain('quote text');
    });

    it('should have author parameter as user type', () => {
      const json = data.toJSON();
      const addSubcommand = json.options?.find((opt: any) => opt.name === 'add');
      expect(addSubcommand).toBeDefined();
      
      const authorOption = addSubcommand?.options?.find((opt: any) => opt.name === 'author');
      expect(authorOption).toBeDefined();
      expect(authorOption?.type).toBe(6); // USER type
      expect(authorOption?.required).toBe(true);
      expect(authorOption?.description).toContain('author');
    });

    it('should require both text and author parameters', () => {
      const json = data.toJSON();
      const addSubcommand = json.options?.find((opt: any) => opt.name === 'add');
      const textOption = addSubcommand?.options?.find((opt: any) => opt.name === 'text');
      const authorOption = addSubcommand?.options?.find((opt: any) => opt.name === 'author');
      
      expect(textOption?.required).toBe(true);
      expect(authorOption?.required).toBe(true);
    });
  });

  describe('edit subcommand', () => {
    it('should have id parameter', () => {
      const json = data.toJSON();
      const editSubcommand = json.options?.find((opt: any) => opt.name === 'edit');
      expect(editSubcommand).toBeDefined();
      
      const idOption = editSubcommand?.options?.find((opt: any) => opt.name === 'id');
      expect(idOption).toBeDefined();
      expect(idOption?.type).toBe(3); // STRING type
      expect(idOption?.required).toBe(true);
    });

    it('should have optional text parameter', () => {
      const json = data.toJSON();
      const editSubcommand = json.options?.find((opt: any) => opt.name === 'edit');
      expect(editSubcommand).toBeDefined();
      
      const textOption = editSubcommand?.options?.find((opt: any) => opt.name === 'text');
      expect(textOption).toBeDefined();
      expect(textOption?.type).toBe(3); // STRING type
      expect(textOption?.required).toBe(false);
    });

    it('should have optional author parameter as user type', () => {
      const json = data.toJSON();
      const editSubcommand = json.options?.find((opt: any) => opt.name === 'edit');
      expect(editSubcommand).toBeDefined();
      
      const authorOption = editSubcommand?.options?.find((opt: any) => opt.name === 'author');
      expect(authorOption).toBeDefined();
      expect(authorOption?.type).toBe(6); // USER type
      expect(authorOption?.required).toBe(false);
    });
  });
});
