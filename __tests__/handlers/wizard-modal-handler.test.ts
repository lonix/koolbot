import { describe, it, expect, jest, beforeEach } from '@jest/globals';
import type { ModalSubmitInteraction, Guild } from 'discord.js';

// Mock dependencies before importing
jest.mock('../../src/services/config-service.js');
jest.mock('../../src/utils/logger.js');
jest.mock('../../src/services/wizard-service.js');

// Import after mocks
import { WizardService } from '../../src/services/wizard-service.js';
import { handleWizardModal } from '../../src/handlers/wizard-modal-handler.js';

const mockWizardService = WizardService as jest.Mocked<typeof WizardService>;

describe('WizardModalHandler', () => {
  let mockInteraction: Partial<ModalSubmitInteraction>;
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
      addConfiguration: jest.fn(),
      updateSession: jest.fn(),
    }));

    (mockWizardService.getInstance as unknown as jest.Mock) = mockGetInstance;

    mockInteraction = {
      customId: '',
      user: {
        id: 'test-user-id',
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
      } as any,
      fields: {
        getTextInputValue: jest.fn().mockReturnValue('test-value'),
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
      } as any,
      reply: jest.fn(),
      deferUpdate: jest.fn(),
      followUp: jest.fn(),
      channel: null,
      client: {
        guilds: {
          fetch: jest.fn().mockResolvedValue(mockGuild),
        },
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
      } as any,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
    } as any;
  });

  describe('module structure', () => {
    it('should export handleWizardModal function', async () => {
      const module = await import('../../src/handlers/wizard-modal-handler.js');
      expect(typeof module.handleWizardModal).toBe('function');
    });
  });

  describe('Custom ID parsing', () => {
    it('should correctly parse modal custom ID', async () => {
      mockInteraction.customId = 'wizard_modal_vc_new__test-user-id_test-guild-id';
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

      await handleWizardModal(mockInteraction as ModalSubmitInteraction);

      // Should not show "belongs to another user" error
      expect(mockInteraction.reply).not.toHaveBeenCalledWith(
        expect.objectContaining({
          content: expect.stringContaining('belongs to another user'),
        }),
      );
    });

    it('should correctly parse voice tracking modal custom ID', async () => {
      mockInteraction.customId = 'wizard_modal_vt__test-user-id_test-guild-id';
      mockGetSession.mockReturnValue({
        userId: 'test-user-id',
        guildId: 'test-guild-id',
        currentStep: 0,
        selectedFeatures: ['voicetracking'],
        configuration: {},
        detectedResources: {},
        startTime: new Date(),
        allowNavigation: true,
      });

      await handleWizardModal(mockInteraction as ModalSubmitInteraction);

      // Should not show "belongs to another user" error
      expect(mockInteraction.reply).not.toHaveBeenCalledWith(
        expect.objectContaining({
          content: expect.stringContaining('belongs to another user'),
        }),
      );
    });

    it('should reject interaction from wrong user', async () => {
      mockInteraction.customId = 'wizard_modal_vc_new__different-user-id_test-guild-id';
      mockInteraction.user!.id = 'test-user-id'; // Different from customId

      await handleWizardModal(mockInteraction as ModalSubmitInteraction);

      expect(mockInteraction.reply).toHaveBeenCalledWith({
        content: '❌ This wizard session belongs to another user.',
        ephemeral: true,
      });
    });
  });
});
