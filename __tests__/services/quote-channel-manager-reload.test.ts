import { describe, it, expect, jest, beforeEach } from "@jest/globals";
import { Client } from "discord.js";
import { QuoteChannelManager } from "../../src/services/quote-channel-manager.js";
import { ConfigService } from "../../src/services/config-service.js";

describe("QuoteChannelManager - Configuration Reload", () => {
  let mockClient: Client;
  let configService: ConfigService;
  let quoteChannelManager: QuoteChannelManager;

  beforeEach(() => {
    // Create a minimal mock client
    mockClient = {
      isReady: jest.fn(() => true) as () => boolean,
      user: { id: "bot-id" },
      channels: {
        fetch: jest.fn(),
      },
      on: jest.fn(),
      removeListener: jest.fn(),
    } as unknown as Client;

    // Get instances
    configService = ConfigService.getInstance();
    quoteChannelManager = QuoteChannelManager.getInstance(mockClient);
  });

  describe("reload callback registration", () => {
    it("should register a reload callback with ConfigService", () => {
      // The callback should be registered during construction
      // We can verify this by checking that the reload callbacks set has items
      const callbacks =
        configService["reloadCallbacks" as keyof typeof configService];
      expect((callbacks as Set<() => Promise<void>>).size).toBeGreaterThan(0);
    });

    it("should handle config reload when quotes are enabled", async () => {
      // Mock the initialize method
      const initializeSpy = jest.spyOn(
        quoteChannelManager as unknown as {
          initialize: () => Promise<void>;
        },
        "initialize",
      );
      initializeSpy.mockResolvedValue(undefined);

      // Mock config to return enabled
      const getBooleanSpy = jest.spyOn(configService, "getBoolean");
      getBooleanSpy.mockResolvedValue(true);

      // Trigger reload
      await configService.triggerReload();

      // Verify initialize was called
      expect(initializeSpy).toHaveBeenCalled();

      // Cleanup
      initializeSpy.mockRestore();
      getBooleanSpy.mockRestore();
    });

    it("should handle config reload when quotes are disabled", async () => {
      // Mock the stop method
      const stopSpy = jest.spyOn(
        quoteChannelManager as unknown as {
          stop: () => Promise<void>;
        },
        "stop",
      );
      stopSpy.mockResolvedValue(undefined);

      // Set initialized flag
      quoteChannelManager["isInitialized" as keyof typeof quoteChannelManager] =
        true;

      // Mock config to return disabled
      const getBooleanSpy = jest.spyOn(configService, "getBoolean");
      getBooleanSpy.mockResolvedValue(false);

      // Trigger reload
      await configService.triggerReload();

      // Verify stop was called
      expect(stopSpy).toHaveBeenCalled();

      // Cleanup
      stopSpy.mockRestore();
      getBooleanSpy.mockRestore();
    });
  });
});
