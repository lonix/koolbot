import {
  buildEventAdoptionPlan,
  classifyScheduledEvent,
  type EventAdoptionPlan,
} from "../../src/services/event-adoption.js";
import type { ScheduledEventInfo } from "../../src/services/server-scan-service.js";

const NOW = new Date("2026-10-17T12:00:00Z");

export const info = (
  over: Partial<ScheduledEventInfo> = {},
): ScheduledEventInfo => ({
  id: "100",
  name: "Movie night",
  startsAt: "2026-10-20T19:00:00.000Z",
  endsAt: "2026-10-20T21:30:00.000Z",
  status: "1",
  channelId: null,
  description: "Popcorn",
  creatorId: "member1",
  creatorIsBot: false,
  entityType: "external",
  recurring: false,
  ...over,
});

export function planned(
  over: Partial<EventAdoptionPlan> = {},
  infos: ScheduledEventInfo[] = [
    info(),
    info({ id: "200", name: "Made by <b>KoolBot</b>", creatorId: "bot1" }),
    info({ id: "300", name: "Voice", channelId: "v1", entityType: "voice" }),
  ],
  selected: string[] = ["100"],
): EventAdoptionPlan {
  const ctx = {
    eventsEnabled: true,
    botUserId: "bot1",
    canManageEvents: true,
    linkedNativeIds: new Set<string>(),
    openEvents: [],
    now: NOW,
  };
  const candidates = infos.map((i) => classifyScheduledEvent(i, ctx));
  return {
    plan: buildEventAdoptionPlan({
      guildId: "g1",
      adminUserId: "admin",
      candidates,
      selectedIds: selected,
      eventsEnabled: true,
      announcementConfigured: true,
    }),
    candidates,
    selectedIds: selected,
    eventsEnabled: true,
    announcementConfigured: true,
    canManageEvents: true,
    ...over,
  };
}
