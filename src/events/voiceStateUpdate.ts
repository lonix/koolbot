import { VoiceState } from 'discord.js';
import { logger } from '../utils/logger';

export async function handleVoiceStateUpdate(oldState: VoiceState, newState: VoiceState) {
  try {
    // Log voice state changes
    if (process.env.DEBUG === 'true') {
      logger.debug(`Voice state update for ${newState.member?.user.tag || 'Unknown user'}`);

      if (oldState.channelId !== newState.channelId) {
        const oldChannel = oldState.channel?.name || 'None';
        const newChannel = newState.channel?.name || 'None';
        logger.debug(`User moved from ${oldChannel} to ${newChannel}`);
      }
    }
  } catch (error) {
    logger.error('Error handling voice state update:', error);
  }
}
