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
    it('has a non-empty label, description, category, and type for every key in defaultConfig', () => {
      const missingLabel: string[] = [];
      const missingDescription: string[] = [];
      const missingCategory: string[] = [];
      const missingType: string[] = [];
      for (const key of Object.keys(defaultConfig)) {
        const meta = settingsMetadata[key as keyof typeof settingsMetadata];
        if (!meta) {
          missingLabel.push(key);
          missingDescription.push(key);
          missingCategory.push(key);
          missingType.push(key);
          continue;
        }
        if (!meta.label || meta.label.trim() === '') missingLabel.push(key);
        if (!meta.description || meta.description.trim() === '')
          missingDescription.push(key);
        if (!meta.category || meta.category.trim() === '')
          missingCategory.push(key);
        if (!meta.type || (meta.type as string).trim() === '')
          missingType.push(key);
      }
      expect(missingLabel).toEqual([]);
      expect(missingDescription).toEqual([]);
      expect(missingCategory).toEqual([]);
      expect(missingType).toEqual([]);
    });

    it('declares a `type` consistent with the runtime defaultConfig value shape', () => {
      // The schema-declared type must not contradict the runtime shape:
      // a `boolean`-typed key has a boolean default, a `number`-typed key
      // has a numeric default, and every other kind ("string", "cron",
      // "channel"/"category"/"role" and their list variants) stores a
      // string. Catches accidental drift between the declared metadata and
      // the underlying default value.
      const mismatches: string[] = [];
      for (const [key, defaultValue] of Object.entries(defaultConfig)) {
        const meta = settingsMetadata[key as keyof typeof settingsMetadata];
        if (!meta) continue;
        const dv = typeof defaultValue;
        if (meta.type === 'boolean' && dv !== 'boolean') mismatches.push(key);
        else if (meta.type === 'number' && dv !== 'number') mismatches.push(key);
        else if (
          meta.type !== 'boolean' &&
          meta.type !== 'number' &&
          dv !== 'string'
        )
          mismatches.push(key);
      }
      expect(mismatches).toEqual([]);
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

  describe('enabled-default audit (#445)', () => {
    // The audit's principle (documented in defaultConfig's leading comment):
    //   1. Top-level feature gates default to false (opt-in).
    //   2. Sub-feature toggles may default to true if they're inert
    //      until the parent feature is enabled and the operator who
    //      turns the parent on almost certainly wants them.
    // These tests pin the matrix so a future contributor can't quietly
    // flip a top-level gate to true (rule 1) or add a new sub-feature
    // toggle without an explicit audit entry (rule 2).

    it('keeps every top-level feature gate `enabled: false`', () => {
      const topLevelGates = [
        'voicechannels.enabled',
        'voicetracking.enabled',
        'voicetracking.announcements.enabled',
        'voicetracking.cleanup.enabled',
        'voicetracking.stats.top.enabled',
        'voicetracking.stats.user.enabled',
        'voicetracking.seen.enabled',
        'ping.enabled',
        'quotes.enabled',
        'ratelimit.enabled',
        'announcements.enabled',
        'achievements.enabled',
        'reactionroles.enabled',
        'notices.enabled',
        'polls.enabled',
        'leaderboard_roles.enabled',
      ];
      for (const key of topLevelGates) {
        expect(defaultConfig[key as keyof typeof defaultConfig]).toBe(false);
      }
    });

    it('keeps the parent-gated sub-feature toggles `true`', () => {
      // Each is inert when its parent feature is off; defaulting on
      // matches operator expectations when the parent is enabled.
      const enabledByDefault: Record<string, string> = {
        'voicechannels.controlpanel.enabled': 'voicechannels.enabled',
        'quotes.header_enabled': 'quotes.enabled',
        'quotes.header_pin_enabled': 'quotes.enabled',
        'achievements.announcements.enabled': 'achievements.enabled',
        'achievements.dm_notifications.enabled': 'achievements.enabled',
        'notices.header_enabled': 'notices.enabled',
        'notices.header_pin_enabled': 'notices.enabled',
      };
      for (const [key, parent] of Object.entries(enabledByDefault)) {
        expect(defaultConfig[key as keyof typeof defaultConfig]).toBe(true);
        // Parent is off, so the sub-feature is inert on a fresh install.
        expect(defaultConfig[parent as keyof typeof defaultConfig]).toBe(false);
      }
    });

    it('does not declare wizard.enabled (#434 / #445 — wizard is always on)', () => {
      expect('wizard.enabled' in defaultConfig).toBe(false);
    });
  });
});
