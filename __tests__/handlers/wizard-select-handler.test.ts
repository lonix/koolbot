import { describe, it, expect, jest, beforeEach } from '@jest/globals';
import type { StringSelectMenuInteraction, Guild } from 'discord.js';

// Mock dependencies before importing
jest.mock('../../src/services/config-service.js');
jest.mock('../../src/utils/logger.js');
jest.mock('../../src/services/wizard-service.js');

// Import after mocks
import { WizardService } from '../../src/services/wizard-service.js';
import { handleWizardSelectMenu } from '../../src/handlers/wizard-select-handler.js';

const mockWizardService = WizardService as jest.Mocked<typeof WizardService>;

describe('Wizard Select Handler', () => {
  let mockInteraction: Partial<StringSelectMenuInteraction>;
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
      updateSession: jest.fn(),
    }));

    (mockWizardService.getInstance as unknown as jest.Mock) = mockGetInstance;

    mockInteraction = {
      customId: '',
      user: {
        id: 'test-user-id',
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
      } as any,
      values: ['test-value'],
      reply: jest.fn(),
      deferUpdate: jest.fn(),
      followUp: jest.fn(),
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
    it('should correctly parse features select custom ID', async () => {
      mockInteraction.customId = 'wizard_features__test-user-id_test-guild-id';
      mockGetSession.mockReturnValue({
        userId: 'test-user-id',
        guildId: 'test-guild-id',
        currentStep: 0,
        selectedFeatures: [],
        configuration: {},
        detectedResources: {},
        startTime: new Date(),
        allowNavigation: true,
      });

      await handleWizardSelectMenu(mockInteraction as StringSelectMenuInteraction);

      // Should not show "belongs to another user" error
      expect(mockInteraction.reply).not.toHaveBeenCalledWith(
        expect.objectContaining({
          content: expect.stringContaining('belongs to another user'),
        }),
      );
    });

    it('should correctly parse multi-word select custom ID', async () => {
      mockInteraction.customId = 'wizard_select_vc_category__test-user-id_test-guild-id';
      mockGetSession.mockReturnValue({
        userId: 'test-user-id',
        guildId: 'test-guild-id',
        currentStep: 0,
        selectedFeatures: ['voicechannels'],
        configuration: {},
        detectedResources: {
          categories: [{ id: 'test-value', name: 'Test Category', children: { cache: new Map() } }],
        },
        startTime: new Date(),
        allowNavigation: true,
      });

      await handleWizardSelectMenu(mockInteraction as StringSelectMenuInteraction);

      // Should not show "belongs to another user" error
      expect(mockInteraction.reply).not.toHaveBeenCalledWith(
        expect.objectContaining({
          content: expect.stringContaining('belongs to another user'),
        }),
      );
    });

    it('should reject interaction from wrong user', async () => {
      mockInteraction.customId = 'wizard_features__different-user-id_test-guild-id';
      mockInteraction.user!.id = 'test-user-id'; // Different from customId

      await handleWizardSelectMenu(mockInteraction as StringSelectMenuInteraction);

      expect(mockInteraction.reply).toHaveBeenCalledWith({
        content: '❌ This wizard session belongs to another user.',
        ephemeral: true,
      });
    });
  });
});
