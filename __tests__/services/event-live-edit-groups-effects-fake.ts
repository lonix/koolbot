/**
 * A `LiveEditEffects` for the group live edit tests (#1241, #1242): the methods
 * the names, sizes, preset and group set rows use are supplied by the test, the
 * leaders and tags methods (#1240) do nothing, and the channel methods of the
 * add and remove rows (#1242) default to "nothing to do" (a channel is made, a
 * channel is empty and removed).
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
  createGroupChannels?: LiveEditEffects["createGroupChannels"];
  emptyGroupChannel?: LiveEditEffects["emptyGroupChannel"];
  removeGroupChannel?: LiveEditEffects["removeGroupChannel"];
}): LiveEditEffects {
  return {
    syncGroupName: handlers.syncGroupName,
    syncGroupUserLimit: handlers.syncGroupUserLimit,
    retagMembers: handlers.retagMembers ?? ((): void => undefined),
    syncLeadsAccess: async (): Promise<void> => undefined,
    syncGroupControls: async (): Promise<void> => undefined,
    syncTags: async (): Promise<void> => undefined,
    createGroupChannels:
      handlers.createGroupChannels ?? (async () => ({ failures: [] })),
    emptyGroupChannel:
      handlers.emptyGroupChannel ??
      (async () => ({ status: "empty" as const, moved: [] })),
    removeGroupChannel:
      handlers.removeGroupChannel ??
      (async () => ({ status: "removed" as const })),
  };
}
