/**
 * Phrase triggers for the passive FriendshipListener.
 *
 * Matched as case-insensitive substrings against incoming messages
 * (the listener lowercases the message before checking). Keep all
 * entries lowercase.
 */

export const bestTriggers = [
  "best ship",
  "best eve ship",
  "best eve online ship",
  "what is the best ship",
  "what's the best ship",
] as const;

export const worstTriggers = [
  "worst ship",
  "worst eve ship",
  "worst eve online ship",
  "what is the worst ship",
  "what's the worst ship",
] as const;
