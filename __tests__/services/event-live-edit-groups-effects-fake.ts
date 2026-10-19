/**
 * A `LiveEditEffects` for the group live edit tests (#1241): the three methods
 * the names, sizes and preset rows use are supplied by the test, the leaders
 * and tags methods (#1240) do nothing.
 */

import type { LiveEditEffects } from "../../src/services/event-live-edit.js";

type Outcome = ReturnType<LiveEditEffects["syncGroupName"]>;

export function makeEffects(handlers: {
  syncGroupName: (guildId: string, eventId: string, key: string) => Outcome;
  syncGroupUserLimit: (
    guildId: string,
    eventId: string,
    key: string,
  ) => Outcome;
  retagMembers?: (guildId: string, eventId: string, ids: string[]) => void;
}): LiveEditEffects {
  return {
    syncGroupName: handlers.syncGroupName,
    syncGroupUserLimit: handlers.syncGroupUserLimit,
    retagMembers: handlers.retagMembers ?? ((): void => undefined),
    syncLeadsAccess: async (): Promise<void> => undefined,
    syncGroupControls: async (): Promise<void> => undefined,
    syncTags: async (): Promise<void> => undefined,
  };
}
