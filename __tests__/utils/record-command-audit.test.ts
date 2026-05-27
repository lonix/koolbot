import { describe, it, expect, beforeEach, jest } from '@jest/globals';

const createMock = jest.fn<() => Promise<unknown>>();
const errorMock = jest.fn();

jest.unstable_mockModule(
  '../../src/models/discord-command-audit-log.js',
  () => ({
    DiscordCommandAuditLog: { create: createMock },
  }),
);

jest.unstable_mockModule('../../src/utils/logger.js', () => ({
  default: {
    error: errorMock,
    warn: jest.fn(),
    info: jest.fn(),
    debug: jest.fn(),
  },
}));

const { recordCommandAudit } = await import(
  '../../src/utils/record-command-audit.js'
);

describe('recordCommandAudit', () => {
  beforeEach(() => {
    createMock.mockClear();
    errorMock.mockClear();
    createMock.mockResolvedValue({});
  });

  it('persists every supplied field', async () => {
    await recordCommandAudit({
      guildId: 'g1',
      discordUserId: 'u1',
      commandName: 'quote',
      subcommand: 'add',
      channelId: 'c1',
      result: 'success',
      errorMessage: null,
      durationMs: 42,
    });
    expect(createMock).toHaveBeenCalledTimes(1);
    expect(createMock).toHaveBeenCalledWith({
      guildId: 'g1',
      discordUserId: 'u1',
      commandName: 'quote',
      subcommand: 'add',
      channelId: 'c1',
      result: 'success',
      errorMessage: null,
      durationMs: 42,
    });
  });

  it('coerces missing optional fields to null', async () => {
    await recordCommandAudit({
      guildId: 'g1',
      discordUserId: 'u1',
      commandName: 'ping',
      result: 'error',
      durationMs: 5,
    });
    const arg = createMock.mock.calls[0]?.[0] as Record<string, unknown>;
    expect(arg.subcommand).toBeNull();
    expect(arg.channelId).toBeNull();
    expect(arg.errorMessage).toBeNull();
  });

  it('swallows DB errors so the user-facing command is unaffected', async () => {
    createMock.mockRejectedValueOnce(new Error('mongo down'));
    await expect(
      recordCommandAudit({
        guildId: 'g1',
        discordUserId: 'u1',
        commandName: 'ping',
        result: 'success',
        durationMs: 1,
      }),
    ).resolves.toBeUndefined();
    expect(errorMock).toHaveBeenCalledWith(
      'Failed to record Discord command audit entry',
      expect.any(Error),
    );
  });
});
