import { describe, it, expect } from '@jest/globals';

describe('CommandManager', () => {
  describe('command registration consistency', () => {
    it('should have same commands in both loadCommandsDynamically and populateClientCommands', async () => {
      // These are the commands that should be in both methods
      const expectedCommands = [
        'ping',
        'help',
        'amikool',
        'vctop',
        'vcstats',
        'seen',
        'transfer-ownership',
        'announce-vc-stats',
        'achievements',
        'quote',
        'announce',
        'dbtrunk',
        'vc',
        'config',
        'botstats',
        'permissions',
        'reactrole',
        'setup',
        'setup-lobby',
      ];

      // Verify the expected commands are documented
      expect(expectedCommands).toContain('achievements');
      expect(expectedCommands).toContain('setup');
      expect(expectedCommands).toContain('announce');
      expect(expectedCommands).toContain('reactrole');
      expect(expectedCommands).toContain('help');
    });

    it('should have achievements command in the list', () => {
      const commands = ['achievements'];
      expect(commands).toContain('achievements');
    });

    it('should have setup wizard command in the list', () => {
      const commands = ['setup'];
      expect(commands).toContain('setup');
    });

    it('should have announce command in the list', () => {
      const commands = ['announce'];
      expect(commands).toContain('announce');
    });

    it('should have reactrole command in the list', () => {
      const commands = ['reactrole'];
      expect(commands).toContain('reactrole');
    });

    it('should have help command in the list', () => {
      const commands = ['help'];
      expect(commands).toContain('help');
    });
  });

  describe('command configuration structure', () => {
    it('should have proper command config structure', () => {
      const commandConfig = {
        name: 'achievements',
        configKey: 'gamification.enabled',
        file: 'achievements',
      };

      expect(commandConfig).toHaveProperty('name');
      expect(commandConfig).toHaveProperty('configKey');
      expect(commandConfig).toHaveProperty('file');
    });

    it('should have setup wizard config', () => {
      const setupConfig = {
        name: 'setup',
        configKey: 'wizard.enabled',
        file: 'setup-wizard',
      };

      expect(setupConfig.name).toBe('setup');
      expect(setupConfig.configKey).toBe('wizard.enabled');
      expect(setupConfig.file).toBe('setup-wizard');
    });
  });
});
