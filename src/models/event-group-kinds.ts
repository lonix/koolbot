/**
 * What an event group is (#1188). `team`: members belong to it. `open`: an
 * extra channel anyone can join (spectators, casters). `leads`: a command
 * channel only leaders and the host can join (#1199); at most one per event.
 *
 * Its own module, free of Mongoose, so pure helpers and static content can use
 * the list without loading the event model.
 */
export type EventGroupKind = "team" | "open" | "leads";

export const EVENT_GROUP_KINDS: readonly EventGroupKind[] = [
  "team",
  "open",
  "leads",
];
