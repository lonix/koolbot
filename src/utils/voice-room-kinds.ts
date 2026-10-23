/**
 * What kind of room a voice session happened in, stamped at join (#1420):
 * `dynamic` = a member's join-to-create room (or its waiting room), `lobby` =
 * the join-to-create lobby, `event` = an event's temporary or group channel,
 * `permanent` = a channel the bot did not create. Absent on sessions recorded
 * before this field existed: their rooms are usually gone and the records that
 * could classify them are deleted with the room, so they read as "other".
 */
export const VOICE_ROOM_KINDS = [
  "dynamic",
  "lobby",
  "event",
  "permanent",
] as const;
export type VoiceRoomKind = (typeof VOICE_ROOM_KINDS)[number];
