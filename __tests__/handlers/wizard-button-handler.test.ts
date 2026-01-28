import { describe, it, expect, jest, beforeEach } from '@jest/globals';
import type { ButtonInteraction, Guild } from 'discord.js';

// Mock dependencies before importing
jest.mock('../../src/services/config-service.js');
jest.mock('../../src/utils/logger.js');
jest.mock('../../src/services/wizard-service.js');

// Import after mocks
import { WizardService } from '../../src/services/wizard-service.js';
import { handleWizardButton } from '../../src/handlers/wizard-button-handler.js';

const mockWizardService = WizardService as jest.Mocked<typeof WizardService>;

describe('Wizard Button Handler', () => {
  let mockInteraction: Partial<ButtonInteraction>;
  let mockGuild: Partial<Guild>;
  let mockGetSession: jest.Mock;
  let mockGetInstance: jest.Mock;

  beforeEach(() => {
    jest.clearAllMocks();

    mockGuild = {
      id: 'test-guild-id',
      name: 'Test Guild',
    };

    mockGetSession = jest.fn();
    mockGetInstance = jest.fn(() => ({
      getSession: mockGetSession,
    }));

    (mockWizardService.getInstance as unknown as jest.Mock) = mockGetInstance;

    mockInteraction = {
      customId: '',
      user: {
        id: 'test-user-id',
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
      } as any,
      reply: jest.fn(),
      deferUpdate: jest.fn(),
      followUp: jest.fn(),
      update: jest.fn(),
      client: {
        guilds: {
          fetch: jest.fn().mockResolvedValue(mockGuild),
        },
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
      } as any,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
    } as any;
  });

  describe('Custom ID parsing', () => {
    it('should correctly parse simple action custom ID', async () => {
      mockInteraction.customId = 'wizard_continue__test-user-id_test-guild-id';
      mockGetSession.mockReturnValue({
        userId: 'test-user-id',
        guildId: 'test-guild-id',
        currentStep: 0,
        selectedFeatures: ['voicechannels'],
        configuration: {},
        detectedResources: {},
        startTime: new Date(),
        allowNavigation: true,
      });

      await handleWizardButton(mockInteraction as ButtonInteraction);

      // Should not show "belongs to another user" error
      expect(mockInteraction.reply).not.toHaveBeenCalledWith(
        expect.objectContaining({
          content: expect.stringContaining('belongs to another user'),
        }),
      );
    });

    it('should correctly parse multi-word action custom ID', async () => {
      mockInteraction.customId = 'wizard_finish_confirm__test-user-id_test-guild-id';
      mockGetSession.mockReturnValue({
        userId: 'test-user-id',
        guildId: 'test-guild-id',
        currentStep: 1,
        selectedFeatures: [],
        configuration: {},
        detectedResources: {},
        startTime: new Date(),
        allowNavigation: true,
      });

      await handleWizardButton(mockInteraction as ButtonInteraction);

      // Should not show "belongs to another user" error
      expect(mockInteraction.reply).not.toHaveBeenCalledWith(
        expect.objectContaining({
          content: expect.stringContaining('belongs to another user'),
        }),
      );
    });

    it('should correctly parse complex action custom ID with underscores', async () => {
      mockInteraction.customId = 'wizard_vc_existing__test-user-id_test-guild-id';
      mockGetSession.mockReturnValue({
        userId: 'test-user-id',
        guildId: 'test-guild-id',
        currentStep: 0,
        selectedFeatures: ['voicechannels'],
        configuration: {},
        detectedResources: { categories: [] },
        startTime: new Date(),
        allowNavigation: true,
      });

      await handleWizardButton(mockInteraction as ButtonInteraction);

      // Should not show "belongs to another user" error
      expect(mockInteraction.reply).not.toHaveBeenCalledWith(
        expect.objectContaining({
          content: expect.stringContaining('belongs to another user'),
        }),
      );
    });

    it('should reject interaction from wrong user', async () => {
      mockInteraction.customId = 'wizard_continue__different-user-id_test-guild-id';
      mockInteraction.user!.id = 'test-user-id'; // Different from customId

      await handleWizardButton(mockInteraction as ButtonInteraction);

      expect(mockInteraction.reply).toHaveBeenCalledWith({
        content: '❌ This wizard session belongs to another user.',
        ephemeral: true,
      });
    });

    it('should reject invalid custom ID format', async () => {
      mockInteraction.customId = 'wizard_invalid_format';

      await handleWizardButton(mockInteraction as ButtonInteraction);

      expect(mockInteraction.reply).toHaveBeenCalledWith(
        expect.objectContaining({
          content: expect.stringContaining('Invalid'),
        }),
      );
    });

    it('should handle expired session', async () => {
      mockInteraction.customId = 'wizard_continue__test-user-id_test-guild-id';
      mockGetSession.mockReturnValue(null); // Session expired

      await handleWizardButton(mockInteraction as ButtonInteraction);

      expect(mockInteraction.reply).toHaveBeenCalledWith({
        content: '❌ Wizard session expired. Please run `/setup wizard` again in the server.',
        ephemeral: true,
      });
    });
  });
});
