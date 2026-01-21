import { describe, it, expect, jest, beforeEach } from '@jest/globals';
import type { ModalSubmitInteraction, Client, Guild } from 'discord.js';
import { handleWizardModal } from '../../src/handlers/wizard-modal-handler.js';
import { WizardService } from '../../src/services/wizard-service.js';

jest.mock('../../src/services/wizard-service.js');
jest.mock('../../src/utils/logger.js');

describe('WizardModalHandler', () => {
  let mockInteraction: Partial<ModalSubmitInteraction>;
  let mockWizardService: any;

  beforeEach(() => {
    jest.clearAllMocks();

    mockInteraction = {
      customId: 'wizard_modal_test_user123_guild123',
      user: {
        id: 'user123',
      } as any,
      client: {
        guilds: {
          fetch: jest.fn().mockResolvedValue({
            id: 'guild123',
          } as Guild),
        } as any,
      } as Client,
      reply: jest.fn().mockResolvedValue(undefined),
      update: jest.fn().mockResolvedValue(undefined),
      fields: {
        getTextInputValue: jest.fn().mockReturnValue('Test Value'),
      } as any,
    };

    mockWizardService = {
      getSession: jest.fn(),
      updateSession: jest.fn(),
    };

    (WizardService.getInstance as jest.Mock).mockReturnValue(mockWizardService);
  });

  describe('handleWizardModal', () => {
    it('should reject invalid custom ID', async () => {
      mockInteraction.customId = 'invalid_id';

      await handleWizardModal(mockInteraction as ModalSubmitInteraction);

      expect(mockInteraction.reply).toHaveBeenCalledWith({
        content: expect.stringContaining('Invalid modal interaction'),
        ephemeral: true,
      });
    });

    it('should reject wrong user', async () => {
      mockInteraction.customId = 'wizard_modal_test_user456_guild123';

      await handleWizardModal(mockInteraction as ModalSubmitInteraction);

      expect(mockInteraction.reply).toHaveBeenCalledWith({
        content: expect.stringContaining('belongs to another user'),
        ephemeral: true,
      });
    });

    it('should handle expired session', async () => {
      mockWizardService.getSession.mockReturnValue(null);

      await handleWizardModal(mockInteraction as ModalSubmitInteraction);

      expect(mockInteraction.reply).toHaveBeenCalledWith({
        content: expect.stringContaining('session expired'),
        ephemeral: true,
      });
    });

    it('should handle missing guild', async () => {
      mockWizardService.getSession.mockReturnValue({
        selectedFeatures: [],
        currentStep: 0,
      });

      mockInteraction.client!.guilds.fetch = jest.fn().mockResolvedValue(null);

      await handleWizardModal(mockInteraction as ModalSubmitInteraction);

      expect(mockInteraction.reply).toHaveBeenCalledWith({
        content: expect.stringContaining('Could not find the server'),
        ephemeral: true,
      });
    });
  });
});
