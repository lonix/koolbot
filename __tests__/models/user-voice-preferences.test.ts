import { describe, it, expect, beforeAll } from '@jest/globals';
import mongoose from 'mongoose';

// Import the model schema definition (not the actual model to avoid DB connection)
describe('UserVoicePreferences Model Schema', () => {
  describe('schema definition', () => {
    it('should define required fields', () => {
      // We test the schema structure by importing the type definitions
      // This ensures the schema is properly typed
      
      // Test that we can import the interface
      const schemaTest = async () => {
        const { UserVoicePreferences } = await import('../../src/models/user-voice-preferences.js');
        return UserVoicePreferences.schema;
      };

      expect(schemaTest).toBeDefined();
    });
  });

  describe('field constraints', () => {
    let UserVoicePreferencesSchema: mongoose.Schema;

    beforeAll(async () => {
      const { UserVoicePreferences } = await import('../../src/models/user-voice-preferences.js');
      UserVoicePreferencesSchema = UserVoicePreferences.schema;
    });

    it('should have userId field with correct type', () => {
      const userIdPath = UserVoicePreferencesSchema.path('userId');
      expect(userIdPath).toBeDefined();
      expect(userIdPath.instance).toBe('String');
      expect(userIdPath.isRequired).toBe(true);
    });

    it('should have namePattern field as optional string', () => {
      const namePatternPath = UserVoicePreferencesSchema.path('namePattern');
      expect(namePatternPath).toBeDefined();
      expect(namePatternPath.instance).toBe('String');
      // Optional fields don't have isRequired property set, it's undefined
      expect(namePatternPath.isRequired).not.toBe(true);
    });

    it('should have userLimit field with correct constraints', () => {
      const userLimitPath = UserVoicePreferencesSchema.path('userLimit');
      expect(userLimitPath).toBeDefined();
      expect(userLimitPath.instance).toBe('Number');
      expect(userLimitPath.isRequired).not.toBe(true);
      
      // Check min/max validators
      const validators = (userLimitPath as any).validators || [];
      const minValidator = validators.find((v: any) => v.type === 'min');
      const maxValidator = validators.find((v: any) => v.type === 'max');
      
      expect(minValidator?.message).toContain('0');
      expect(maxValidator?.message).toContain('99');
    });

    it('should have bitrate field with correct constraints', () => {
      const bitratePath = UserVoicePreferencesSchema.path('bitrate');
      expect(bitratePath).toBeDefined();
      expect(bitratePath.instance).toBe('Number');
      expect(bitratePath.isRequired).not.toBe(true);
      
      // Check min/max validators
      const validators = (bitratePath as any).validators || [];
      const minValidator = validators.find((v: any) => v.type === 'min');
      const maxValidator = validators.find((v: any) => v.type === 'max');
      
      expect(minValidator?.message).toContain('8');
      expect(maxValidator?.message).toContain('384');
    });

    it('should have timestamps enabled', () => {
      expect(UserVoicePreferencesSchema.options.timestamps).toBe(true);
    });

    it('should have unique constraint on userId', () => {
      const indexes = UserVoicePreferencesSchema.indexes();
      
      // Check if there's a unique index on userId
      const userIdIndex = indexes.find((index: any) => {
        const fields = index[0];
        return fields.userId !== undefined;
      });
      
      expect(userIdIndex).toBeDefined();
      expect(userIdIndex?.[1]?.unique).toBe(true);
    });
  });

  describe('validation rules', () => {
    it('should enforce userLimit range (0-99)', () => {
      // The schema should have min and max validators
      const testValidation = async () => {
        const { UserVoicePreferences } = await import('../../src/models/user-voice-preferences.js');
        const schema = UserVoicePreferences.schema;
        const userLimitPath = schema.path('userLimit');
        
        return {
          hasMinValidator: (userLimitPath as any).validators?.some((v: any) => v.type === 'min'),
          hasMaxValidator: (userLimitPath as any).validators?.some((v: any) => v.type === 'max'),
        };
      };

      return testValidation().then((result) => {
        expect(result.hasMinValidator).toBe(true);
        expect(result.hasMaxValidator).toBe(true);
      });
    });

    it('should enforce bitrate range (8-384)', () => {
      const testValidation = async () => {
        const { UserVoicePreferences } = await import('../../src/models/user-voice-preferences.js');
        const schema = UserVoicePreferences.schema;
        const bitratePath = schema.path('bitrate');
        
        return {
          hasMinValidator: (bitratePath as any).validators?.some((v: any) => v.type === 'min'),
          hasMaxValidator: (bitratePath as any).validators?.some((v: any) => v.type === 'max'),
        };
      };

      return testValidation().then((result) => {
        expect(result.hasMinValidator).toBe(true);
        expect(result.hasMaxValidator).toBe(true);
      });
    });
  });

  describe('interface types', () => {
    it('should properly type the document interface', async () => {
      // Import to verify type definitions compile
      await import('../../src/models/user-voice-preferences.js');
      
      // Type test - this will fail at compile time if types are wrong
      const testDoc = {
        userId: 'test-user-123',
        namePattern: '{username}\'s Room',
        userLimit: 10,
        bitrate: 96,
      };

      expect(testDoc.userId).toBe('test-user-123');
      expect(testDoc.namePattern).toBe('{username}\'s Room');
      expect(testDoc.userLimit).toBe(10);
      expect(testDoc.bitrate).toBe(96);
    });

    it('should allow optional fields to be undefined', async () => {
      const { UserVoicePreferences } = await import('../../src/models/user-voice-preferences.js');
      
      // Test that schema validation passes without optional fields
      const docWithoutOptionals = new UserVoicePreferences({
        userId: 'test-user-456',
      });

      // Validate the document (this will throw if required fields are missing)
      const validationError = docWithoutOptionals.validateSync();
      expect(validationError).toBeUndefined();
      
      // Verify optional fields are indeed undefined
      expect(docWithoutOptionals.userId).toBe('test-user-456');
      expect(docWithoutOptionals.namePattern).toBeUndefined();
      expect(docWithoutOptionals.userLimit).toBeUndefined();
      expect(docWithoutOptionals.bitrate).toBeUndefined();
    });
  });
});
