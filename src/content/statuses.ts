/**
 * Bot presence status pools used by BotStatusService.
 *
 * Picked at random based on how many users are in voice chat.
 * `multipleUsersStatuses` entries must contain the literal `{count}`
 * placeholder — it is replaced with the current user count at runtime.
 */

export const lonelyStatuses = [
  "nobody, I hate it here",
  "paint dry, I'm so bored",
  "the void, I'm contemplating existence",
  "pixels, I'm counting them",
  "solitaire, I'm playing alone",
  "nothing, I'm staring at the void",
  "the meaning of life, I'm contemplating it",
  "Rick Astley on repeat, I'm so lonely", // cspell:ignore Astley
  "Lo-fi girl, kinda goes with the vibe",
  "the whole universe was in a hot dense state",
  "Some russian kid, screaming about fucking my mom",
  "The matrix, blue or red pill, guys ?",
] as const;

export const singleUserStatuses = [
  "a lone wanderer",
  "one solitary soul",
  "a single user existing",
  "one person contemplating life",
  "a lone voice in the void",
  "just one user vibing",
] as const;

export const multipleUsersStatuses = [
  "{count} nerds",
  "{count} souls",
  "{count} humans",
  "{count} chatters",
  "{count} people",
  "{count} gamers that suck",
  "{count} conversing about nothing",
  "{count} people that need to get a life",
] as const satisfies readonly `${string}{count}${string}`[];
