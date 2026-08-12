import { describe, it, expect, beforeEach, jest } from "@jest/globals";
import { WizardService } from "../../src/services/wizard-service.js";

// Mock dependencies
jest.mock("../../src/services/config-service.js");
jest.mock("../../src/utils/logger.js");

describe("WizardService", () => {
  let service: WizardService;

  beforeEach(() => {
    jest.clearAllMocks();
    service = WizardService.getInstance();
  });

  describe("singleton pattern", () => {
    it("should create a singleton instance", () => {
      const instance1 = WizardService.getInstance();
      const instance2 = WizardService.getInstance();

      expect(instance1).toBe(instance2);
    });
  });

  describe("initialization", () => {
    it("should create an instance", () => {
      expect(service).toBeDefined();
      expect(service).toBeInstanceOf(WizardService);
    });
  });

  describe("public methods", () => {
    it("should have createSession method", () => {
      expect(typeof service.createSession).toBe("function");
    });

    it("should have getSession method", () => {
      expect(typeof service.getSession).toBe("function");
    });

    it("should have updateSession method", () => {
      expect(typeof service.updateSession).toBe("function");
    });

    it("should have endSession method", () => {
      expect(typeof service.endSession).toBe("function");
    });

    it("should have addConfiguration method", () => {
      expect(typeof service.addConfiguration).toBe("function");
    });

    it("should have nextStep method", () => {
      expect(typeof service.nextStep).toBe("function");
    });

    it("should have previousStep method", () => {
      expect(typeof service.previousStep).toBe("function");
    });

    it("should have shutdown method", () => {
      expect(typeof service.shutdown).toBe("function");
    });
  });

  describe("session management", () => {
    const mockUserId = "user-123";
    const mockGuildId = "guild-456";

    it("should create a new session", () => {
      const state = service.createSession(mockUserId, mockGuildId);

      expect(state).toBeDefined();
      expect(state.userId).toBe(mockUserId);
      expect(state.guildId).toBe(mockGuildId);
      expect(state.currentStep).toBe(0);
      expect(Array.isArray(state.selectedFeatures)).toBe(true);
      expect(state.startTime).toBeInstanceOf(Date);
    });

    it("should retrieve an existing session", () => {
      service.createSession(mockUserId, mockGuildId);
      const state = service.getSession(mockUserId, mockGuildId);

      expect(state).toBeDefined();
      expect(state?.userId).toBe(mockUserId);
    });

    it("should return null for non-existent session", () => {
      const state = service.getSession("non-existent", "non-existent");

      expect(state).toBeNull();
    });

    it("should update an existing session", () => {
      service.createSession(mockUserId, mockGuildId);
      const updated = service.updateSession(mockUserId, mockGuildId, {
        currentStep: 2,
      });

      expect(updated).toBe(true);
      const state = service.getSession(mockUserId, mockGuildId);
      expect(state?.currentStep).toBe(2);
    });

    it("should return false when updating non-existent session", () => {
      const updated = service.updateSession("non-existent", "non-existent", {
        currentStep: 2,
      });

      expect(updated).toBe(false);
    });

    it("should end a session", () => {
      service.createSession(mockUserId, mockGuildId);
      const result = service.endSession(mockUserId, mockGuildId);

      expect(result).toBe(true);
      const state = service.getSession(mockUserId, mockGuildId);
      expect(state).toBeNull();
    });

    it("should return false when ending non-existent session", () => {
      const result = service.endSession("non-existent", "non-existent");

      expect(result).toBe(false);
    });

    it("should add configuration to session", () => {
      service.createSession(mockUserId, mockGuildId);
      service.addConfiguration(
        mockUserId,
        mockGuildId,
        "test.key",
        "test-value",
      );
      const state = service.getSession(mockUserId, mockGuildId);

      expect(state?.configuration["test.key"]).toBe("test-value");
    });

    it("should navigate to next step", () => {
      service.createSession(mockUserId, mockGuildId);
      const result = service.nextStep(mockUserId, mockGuildId);

      expect(result).toBe(true);
      const state = service.getSession(mockUserId, mockGuildId);
      expect(state?.currentStep).toBe(1);
    });

    it("should navigate to previous step", () => {
      service.createSession(mockUserId, mockGuildId);
      service.nextStep(mockUserId, mockGuildId);
      const result = service.previousStep(mockUserId, mockGuildId);

      expect(result).toBe(true);
      const state = service.getSession(mockUserId, mockGuildId);
      expect(state?.currentStep).toBe(0);
    });

    it("should initialize channelPage to 0 when creating session", () => {
      const state = service.createSession(mockUserId, mockGuildId);

      expect(state.channelPage).toBe(0);
    });

    it("should update channelPage in session", () => {
      service.createSession(mockUserId, mockGuildId);
      const updated = service.updateSession(mockUserId, mockGuildId, {
        channelPage: 2,
      });

      expect(updated).toBe(true);
      const state = service.getSession(mockUserId, mockGuildId);
      expect(state?.channelPage).toBe(2);
    });
  });

  describe("applyConfiguration", () => {
    const mockUserId = "user-123";
    const mockGuildId = "guild-456";

    let mockConfigService: any;
    // Simulates the ConfigService cache: set/delete keep it in step, and
    // get reads it, matching how the real service behaves in-process.
    let cache: Map<string, unknown>;

    beforeEach(() => {
      cache = new Map();
      mockConfigService = {
        findDependencyIssues: jest.fn(async () => [] as any[]),
        getAll: jest.fn(async () => [] as any[]),
        get: jest.fn(async (key: string) => cache.get(key)),
        set: jest.fn(async (key: string, value: unknown) => {
          cache.set(key, value);
        }),
        delete: jest.fn(async (key: string) => {
          cache.delete(key);
        }),
        triggerReload: jest.fn(async () => undefined),
      };
      // The ConfigService module is auto-mocked, so inject a controllable
      // instance directly.
      (service as any).configService = mockConfigService;

      service.createSession(mockUserId, mockGuildId);
      service.addConfiguration(mockUserId, mockGuildId, "quotes.enabled", true);
      service.addConfiguration(
        mockUserId,
        mockGuildId,
        "quotes.channel_id",
        "123",
      );
      service.addConfiguration(
        mockUserId,
        mockGuildId,
        "quotes.delete_roles",
        "role-1",
      );
    });

    it("applies every key and reloads on success", async () => {
      const result = await service.applyConfiguration(mockUserId, mockGuildId);

      expect(result.success).toBe(true);
      expect(result.appliedKeys).toEqual([
        "quotes.enabled",
        "quotes.channel_id",
        "quotes.delete_roles",
      ]);
      expect(result.rolledBackKeys).toEqual([]);
      expect(result.revertFailedKeys).toEqual([]);
      expect(mockConfigService.set).toHaveBeenCalledTimes(3);
      expect(mockConfigService.triggerReload).toHaveBeenCalledTimes(1);
    });

    it("returns a failure result when no session exists", async () => {
      const result = await service.applyConfiguration("nobody", "nowhere");

      expect(result.success).toBe(false);
      expect(result.appliedKeys).toEqual([]);
      expect(result.errorMessage).toContain("No active wizard session");
      expect(mockConfigService.set).not.toHaveBeenCalled();
    });

    it("rolls back already-written keys when a mid-batch write fails", async () => {
      // quotes.enabled had a stored row; quotes.channel_id did not.
      mockConfigService.getAll.mockResolvedValue([
        {
          key: "quotes.enabled",
          value: false,
          description: "old description",
          category: "quotes",
        },
      ] as any);
      mockConfigService.set.mockImplementation(
        async (key: string, value: unknown) => {
          if (key === "quotes.delete_roles") {
            throw new Error("mongo write failed");
          }
          cache.set(key, value);
        },
      );

      const result = await service.applyConfiguration(mockUserId, mockGuildId);

      expect(result.success).toBe(false);
      expect(result.failedKey).toBe("quotes.delete_roles");
      expect(result.errorMessage).toBe("mongo write failed");
      expect(result.appliedKeys).toEqual([
        "quotes.enabled",
        "quotes.channel_id",
      ]);
      // Rolled back newest-first: the unsaved key is deleted, the
      // previously-stored key is restored with its prior row verbatim.
      expect(result.rolledBackKeys).toEqual([
        "quotes.channel_id",
        "quotes.enabled",
      ]);
      expect(result.revertFailedKeys).toEqual([]);
      expect(mockConfigService.delete).toHaveBeenCalledWith(
        "quotes.channel_id",
      );
      expect(mockConfigService.set).toHaveBeenCalledWith(
        "quotes.enabled",
        false,
        "old description",
        "quotes",
        { skipDependencyCheck: true },
      );
      // Full rollback → nothing changed → no reload.
      expect(mockConfigService.triggerReload).not.toHaveBeenCalled();
    });

    it("reloads and reports keys whose rollback failed", async () => {
      mockConfigService.set.mockImplementation(
        async (key: string, value: unknown) => {
          if (key === "quotes.channel_id") {
            throw new Error("write failed");
          }
          cache.set(key, value);
        },
      );
      mockConfigService.delete.mockRejectedValue(new Error("delete failed"));

      const result = await service.applyConfiguration(mockUserId, mockGuildId);

      expect(result.success).toBe(false);
      expect(result.failedKey).toBe("quotes.channel_id");
      expect(result.appliedKeys).toEqual(["quotes.enabled"]);
      expect(result.rolledBackKeys).toEqual([]);
      expect(result.revertFailedKeys).toEqual(["quotes.enabled"]);
      // A key stayed persisted, so the reload must run to keep services in
      // sync with the DB — and it succeeded here.
      expect(mockConfigService.triggerReload).toHaveBeenCalledTimes(1);
      expect(result.reloadFailed).toBeUndefined();
    });

    it("flags reloadFailed when rollback failure is followed by a reload failure", async () => {
      mockConfigService.set.mockImplementation(
        async (key: string, value: unknown) => {
          if (key === "quotes.channel_id") {
            throw new Error("write failed");
          }
          cache.set(key, value);
        },
      );
      mockConfigService.delete.mockRejectedValue(new Error("delete failed"));
      mockConfigService.triggerReload.mockRejectedValue(
        new Error("reload failed"),
      );

      const result = await service.applyConfiguration(mockUserId, mockGuildId);

      expect(result.success).toBe(false);
      expect(result.revertFailedKeys).toEqual(["quotes.enabled"]);
      // The persisted key has NOT taken effect for callback-driven services;
      // the result must say so rather than only logging it.
      expect(result.reloadFailed).toBe(true);
      expect(result.errorMessage).toBe("write failed");
    });

    it("skips rolling back a key changed concurrently after the wizard wrote it", async () => {
      mockConfigService.getAll.mockResolvedValue([
        {
          key: "quotes.enabled",
          value: false,
          description: "old description",
          category: "quotes",
        },
      ] as any);
      mockConfigService.set.mockImplementation(
        async (key: string, value: unknown) => {
          if (key === "quotes.delete_roles") {
            throw new Error("mongo write failed");
          }
          cache.set(key, value);
        },
      );
      // Simulate another writer updating quotes.enabled between this apply's
      // write and its rollback.
      mockConfigService.get.mockImplementation(async (key: string) =>
        key === "quotes.enabled" ? "someone-elses-value" : cache.get(key),
      );

      const result = await service.applyConfiguration(mockUserId, mockGuildId);

      expect(result.success).toBe(false);
      // quotes.channel_id still held our value → rolled back (deleted);
      // quotes.enabled was changed concurrently → left alone, reported.
      expect(result.rolledBackKeys).toEqual(["quotes.channel_id"]);
      expect(result.revertFailedKeys).toEqual(["quotes.enabled"]);
      expect(mockConfigService.delete).toHaveBeenCalledWith(
        "quotes.channel_id",
      );
      expect(mockConfigService.delete).not.toHaveBeenCalledWith(
        "quotes.enabled",
      );
      // The snapshot restore for quotes.enabled must NOT have run — that
      // would clobber the concurrent writer's newer value.
      expect(mockConfigService.set).not.toHaveBeenCalledWith(
        "quotes.enabled",
        false,
        "old description",
        "quotes",
        { skipDependencyCheck: true },
      );
      // A key stayed persisted → reload runs.
      expect(mockConfigService.triggerReload).toHaveBeenCalledTimes(1);
    });

    it("reports a reload failure after all keys persisted", async () => {
      mockConfigService.triggerReload.mockRejectedValue(
        new Error("reload broke"),
      );

      const result = await service.applyConfiguration(mockUserId, mockGuildId);

      expect(result.success).toBe(false);
      expect(result.failedKey).toBeUndefined();
      expect(result.appliedKeys).toHaveLength(3);
      expect(result.rolledBackKeys).toEqual([]);
      expect(result.revertFailedKeys).toEqual([]);
      expect(result.reloadFailed).toBe(true);
      expect(result.errorMessage).toContain("/config reload");
      // Nothing is rolled back — the writes themselves all succeeded.
      expect(mockConfigService.delete).not.toHaveBeenCalled();
    });

    it("throws DependencyError before writing anything when the batch is inconsistent", async () => {
      mockConfigService.findDependencyIssues.mockResolvedValue([
        {
          key: "quotes.channel_id",
          dependency: "quotes.enabled",
          kind: "missing-dependency",
          message: "quotes.channel_id requires quotes.enabled",
        },
      ] as any);

      await expect(
        service.applyConfiguration(mockUserId, mockGuildId),
      ).rejects.toThrow();
      expect(mockConfigService.set).not.toHaveBeenCalled();
      expect(mockConfigService.triggerReload).not.toHaveBeenCalled();
    });
  });

  describe("shutdown", () => {
    it("should shutdown without errors", () => {
      service.shutdown();

      // Method should execute without errors
      expect(true).toBe(true);
    });
  });
});
