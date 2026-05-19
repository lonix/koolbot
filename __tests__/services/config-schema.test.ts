import { describe, it, expect } from '@jest/globals';
import {
  defaultConfig,
  settingsMetadata,
  categoryMetadata,
} from '../../src/services/config-schema.js';

describe('Config Schema', () => {
  describe('defaultConfig', () => {
    it('should have all core features disabled by default for security', () => {
      expect(defaultConfig['voicechannels.enabled']).toBe(false);
      expect(defaultConfig['voicetracking.enabled']).toBe(false);
      expect(defaultConfig['ping.enabled']).toBe(false);
      expect(defaultConfig['quotes.enabled']).toBe(false);
    });

    it('should have core.cleanup.channel_id empty by default', () => {
      // Other core.* keys were declared but never read and have been removed.
      expect(defaultConfig['core.cleanup.channel_id']).toBe('');
    });

    it('should have reasonable default values for voice channel settings', () => {
      expect(defaultConfig['voicechannels.category.name']).toBe('Voice Channels');
      expect(defaultConfig['voicechannels.lobby.name']).toBe('Lobby');
      expect(defaultConfig['voicechannels.channel.prefix']).toBe('🎮');
    });

    it('should have reasonable default values for cleanup retention', () => {
      expect(defaultConfig['voicetracking.cleanup.retention.detailed_sessions_days']).toBeGreaterThan(0);
      expect(defaultConfig['voicetracking.cleanup.retention.monthly_summaries_months']).toBeGreaterThan(0);
      expect(defaultConfig['voicetracking.cleanup.retention.yearly_summaries_years']).toBeGreaterThan(0);
    });

    it('should have reasonable default values for quote system', () => {
      expect(defaultConfig['quotes.max_length']).toBeGreaterThan(0);
      expect(defaultConfig['quotes.cooldown']).toBeGreaterThanOrEqual(0);
    });

    it('should have valid cron schedule defaults', () => {
      // Default schedules should be strings (even if empty)
      expect(typeof defaultConfig['voicetracking.announcements.schedule']).toBe('string');
      expect(typeof defaultConfig['voicetracking.cleanup.schedule']).toBe('string');
    });

    it('should have channel_id fields as strings', () => {
      expect(typeof defaultConfig['core.cleanup.channel_id']).toBe('string');
      expect(typeof defaultConfig['quotes.channel_id']).toBe('string');
      expect(typeof defaultConfig['reactionroles.message_channel_id']).toBe('string');
    });

    it('should have string fields for comma-separated values', () => {
      expect(typeof defaultConfig['voicetracking.excluded_channels']).toBe('string');
      expect(typeof defaultConfig['quotes.delete_roles']).toBe('string');
    });

    it('should have voicetracking.excluded_channels default to empty string', () => {
      expect(defaultConfig['voicetracking.excluded_channels']).toBe('');
    });

    it('should have rate limiting disabled by default for security', () => {
      expect(defaultConfig['ratelimit.enabled']).toBe(false);
    });

    it('should have reasonable default values for rate limiting', () => {
      expect(defaultConfig['ratelimit.max_commands']).toBeGreaterThan(0);
      expect(defaultConfig['ratelimit.window_seconds']).toBeGreaterThan(0);
      expect(typeof defaultConfig['ratelimit.bypass_admin']).toBe('boolean');
    });
  });

  describe('settingsMetadata', () => {
    it('has a non-empty label, description, and category for every key in defaultConfig', () => {
      const missingLabel: string[] = [];
      const missingDescription: string[] = [];
      const missingCategory: string[] = [];
      for (const key of Object.keys(defaultConfig)) {
        const meta = settingsMetadata[key as keyof typeof settingsMetadata];
        if (!meta) {
          missingLabel.push(key);
          missingDescription.push(key);
          missingCategory.push(key);
          continue;
        }
        if (!meta.label || meta.label.trim() === '') missingLabel.push(key);
        if (!meta.description || meta.description.trim() === '')
          missingDescription.push(key);
        if (!meta.category || meta.category.trim() === '')
          missingCategory.push(key);
      }
      expect(missingLabel).toEqual([]);
      expect(missingDescription).toEqual([]);
      expect(missingCategory).toEqual([]);
    });

    it('does not have stale entries for keys that no longer exist in defaultConfig', () => {
      const orphans = Object.keys(settingsMetadata).filter(
        (k) => !(k in defaultConfig),
      );
      expect(orphans).toEqual([]);
    });
  });

  describe('categoryMetadata', () => {
    it('covers every category referenced by settingsMetadata', () => {
      const usedCategories = new Set(
        Object.values(settingsMetadata).map((m) => m.category),
      );
      const missing: string[] = [];
      for (const cat of usedCategories) {
        const meta = categoryMetadata[cat];
        if (!meta || !meta.title.trim() || !meta.description.trim()) {
          missing.push(cat);
        }
      }
      expect(missing).toEqual([]);
    });
  });
});
