import { describe, it, expect, jest, afterEach } from "@jest/globals";

/**
 * What a live-edit follow-up reaches (#1240): the leads and controls passes of
 * `EventService` and the nickname tag service, with the revoked ids handed on.
 */

const { createLiveEditEffects } =
  await import("../../src/services/event-live-edit-effects.js");
const { EventService } = await import("../../src/services/event-service.js");
const { EventNicknameTags } =
  await import("../../src/services/event-nickname-tags.js");

afterEach(() => {
  jest.restoreAllMocks();
});

describe("eventVoiceInUse (#1251)", () => {
  const clientWith = (channels: Record<string, number>): never =>
    ({
      guilds: {
        cache: {
          get: (id: string) =>
            id === "g"
              ? {
                  channels: {
                    cache: {
                      get: (cid: string) =>
                        cid in channels
                          ? {
                              isVoiceBased: () => true,
                              members: { size: channels[cid] },
                            }
                          : undefined,
                    },
                  },
                }
              : undefined,
        },
      },
    }) as never;

  it("is true when anyone is connected to any of the channels, from the gateway cache", () => {
    const fx = createLiveEditEffects(clientWith({ main: 0, a: 0, lobby: 2 }));
    expect(fx.eventVoiceInUse("g", ["main", "a", "lobby"])).toBe(true);
    expect(fx.eventVoiceInUse("g", ["main", "a"])).toBe(false);
  });

  it("is false for channels the cache does not hold, and for no channels", () => {
    const fx = createLiveEditEffects(clientWith({ main: 0 }));
    expect(fx.eventVoiceInUse("g", ["gone"])).toBe(false);
    expect(fx.eventVoiceInUse("g", [])).toBe(false);
  });

  it("is true (unknown, so ask) when the server is not in the cache", () => {
    const fx = createLiveEditEffects(clientWith({}));
    expect(fx.eventVoiceInUse("other", ["main"])).toBe(true);
  });
});

describe("createLiveEditEffects", () => {
  it("hands the revoked ids to the leads pass as the list it takes first", async () => {
    const syncLeadsAccess = jest.fn<
      (
        guildId: string,
        eventId: string,
        take?: () => readonly string[],
      ) => Promise<void>
    >(async () => undefined);
    jest
      .spyOn(EventService, "getInstance")
      .mockReturnValue({ syncLeadsAccess } as never);
    await createLiveEditEffects({} as never).syncLeadsAccess("g", "e", [
      "alice",
    ]);
    expect(syncLeadsAccess).toHaveBeenCalledTimes(1);
    const take = syncLeadsAccess.mock.calls[0][2];
    expect(take?.()).toEqual(["alice"]);
  });

  it("passes no list when nobody lost access", async () => {
    const syncLeadsAccess = jest.fn<
      (
        guildId: string,
        eventId: string,
        take?: () => readonly string[],
      ) => Promise<void>
    >(async () => undefined);
    jest
      .spyOn(EventService, "getInstance")
      .mockReturnValue({ syncLeadsAccess } as never);
    await createLiveEditEffects({} as never).syncLeadsAccess("g", "e", []);
    await createLiveEditEffects({} as never).syncLeadsAccess("g", "e");
    expect(syncLeadsAccess.mock.calls.map((c) => c[2])).toEqual([
      undefined,
      undefined,
    ]);
  });

  it("asks for the controls pass of the event", async () => {
    const syncGroupControls = jest.fn<(eventId: string) => Promise<void>>(
      async () => undefined,
    );
    jest
      .spyOn(EventService, "getInstance")
      .mockReturnValue({ syncGroupControls } as never);
    await createLiveEditEffects({} as never).syncGroupControls("e");
    expect(syncGroupControls).toHaveBeenCalledWith("e");
  });

  it("tags with syncEvent, restores with restoreEvent, and requests the sweep after each", async () => {
    const calls: string[] = [];
    jest.spyOn(EventNicknameTags, "getInstance").mockReturnValue({
      syncEvent: async (_g: string, e: string) => {
        calls.push(`sync:${e}`);
      },
      restoreEvent: async (_g: string, e: string) => {
        calls.push(`restore:${e}`);
        return { restored: 0, kept: 0, warnings: [] };
      },
      requestSweep: (g: string) => {
        calls.push(`sweep:${g}`);
      },
    } as never);
    const effects = createLiveEditEffects({} as never);
    await effects.syncTags("g", "e", "sync");
    await effects.syncTags("g", "e", "restore");
    expect(calls).toEqual(["sync:e", "sweep:g", "restore:e", "sweep:g"]);
  });

  it("never rejects: a failing nickname pass is logged", async () => {
    jest.spyOn(EventNicknameTags, "getInstance").mockReturnValue({
      syncEvent: async () => {
        throw new Error("discord down");
      },
      requestSweep: () => undefined,
    } as never);
    await expect(
      createLiveEditEffects({} as never).syncTags("g", "e", "sync"),
    ).resolves.toBeUndefined();
  });
});
