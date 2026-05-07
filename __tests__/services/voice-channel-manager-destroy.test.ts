import {
  describe,
  it,
  expect,
  jest,
  beforeEach,
  afterEach,
} from "@jest/globals";
import type { Client } from "discord.js";

// Mock dependencies before importing
jest.mock("../../src/utils/logger.js");
jest.mock("../../src/services/voice-channel-tracker.js");
jest.mock("../../src/services/config-service.js");

// Import after mocks
import { VoiceChannelManager } from "../../src/services/voice-channel-manager.js";

describe("VoiceChannelManager - destroy()", () => {
  let manager: VoiceChannelManager;
  let mockClient: Partial<Client>;

  beforeEach(() => {
    jest.clearAllMocks();
    jest.useFakeTimers();

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (VoiceChannelManager as any).instance = undefined;

    mockClient = {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      channels: { cache: { get: jest.fn() } } as any,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
    } as any;

    manager = VoiceChannelManager.getInstance(mockClient as Client);
  });

  afterEach(() => {
    jest.useRealTimers();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (VoiceChannelManager as any).instance = undefined;
  });

  it("clears the periodic cleanup and health-check intervals", () => {
    const clearIntervalSpy = jest.spyOn(globalThis, "clearInterval");

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const cleanupHandle = (manager as any).cleanupInterval;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const healthHandle = (manager as any).healthCheckInterval;
    expect(cleanupHandle).not.toBeNull();
    expect(healthHandle).not.toBeNull();

    manager.destroy();

    expect(clearIntervalSpy).toHaveBeenCalledWith(cleanupHandle);
    expect(clearIntervalSpy).toHaveBeenCalledWith(healthHandle);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    expect((manager as any).cleanupInterval).toBeNull();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    expect((manager as any).healthCheckInterval).toBeNull();

    clearIntervalSpy.mockRestore();
  });

  it("clears all pending ownership-transfer timeouts and prevents their callbacks from running", () => {
    const transferCallback = jest.fn();

    // Simulate a pending ownership transfer for two channels by populating the
    // private map directly. This mirrors what handleChannelOwnerLeave() does
    // when an owner leaves their channel.
    const timer1 = setTimeout(transferCallback, 30_000);
    const timer2 = setTimeout(transferCallback, 30_000);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const timers = (manager as any).ownershipTransferTimers as Map<
      string,
      { timer: ReturnType<typeof setTimeout>; originalOwnerId: string }
    >;
    timers.set("channel-a", { timer: timer1, originalOwnerId: "owner-a" });
    timers.set("channel-b", { timer: timer2, originalOwnerId: "owner-b" });
    expect(timers.size).toBe(2);

    manager.destroy();

    // Map is emptied.
    expect(timers.size).toBe(0);

    // Advancing past the grace period must NOT fire the callbacks — they were
    // cleared by destroy().
    jest.advanceTimersByTime(60_000);
    expect(transferCallback).not.toHaveBeenCalled();
  });

  it("clears the in-memory state maps", () => {
    manager.setCustomChannelName("channel-id", "Custom Name");
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (manager as any).liveChannels.add("channel-id");
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (manager as any).waitingRooms.set("main", "waiting");

    manager.destroy();

    expect(manager.hasCustomName("channel-id")).toBe(false);
    expect(manager.isLive("channel-id")).toBe(false);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    expect((manager as any).waitingRooms.size).toBe(0);
  });
});
