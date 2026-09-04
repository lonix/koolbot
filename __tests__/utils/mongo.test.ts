import { describe, it, expect, jest, beforeEach } from "@jest/globals";
import mongoose from "mongoose";
import { MongoConnectionGuard } from "../../src/utils/mongo.js";
import { ConfigService } from "../../src/services/config-service.js";
import { DEFAULT_MONGODB_URI } from "../../src/config/env.js";

type ConnectionHandler = (arg?: unknown) => void;

/** Capture the listeners the guard registers on the shared connection. */
function handlersFor(): Map<string, ConnectionHandler> {
  const registered = new Map<string, ConnectionHandler>();
  (mongoose.connection.on as jest.Mock).mockImplementation(
    (...args: unknown[]) => {
      registered.set(args[0] as string, args[1] as ConnectionHandler);
      return mongoose.connection;
    },
  );
  return registered;
}

describe("MongoConnectionGuard", () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it("reconnects while disconnected, using the configured URI", async () => {
    // Pin the singleton so the config lookup can be observed.
    const getString = jest.fn(async () => "mongodb://configured/koolbot");
    const getInstanceSpy = jest
      .spyOn(ConfigService, "getInstance")
      .mockReturnValue({ getString } as never);

    const guard = new MongoConnectionGuard("test service");
    await guard.ensureConnection();

    // The default is the single definition from config/env.ts — the literal
    // that used to be re-inlined in five services (#851).
    expect(getString).toHaveBeenCalledWith("MONGODB_URI", DEFAULT_MONGODB_URI);
    expect(DEFAULT_MONGODB_URI).toBe("mongodb://mongodb:27017/koolbot");
    expect(mongoose.connect).toHaveBeenCalledWith(
      "mongodb://configured/koolbot",
    );
    getInstanceSpy.mockRestore();
  });

  it("is a no-op once the connection event has been observed", async () => {
    const registered = handlersFor();
    const guard = new MongoConnectionGuard("test service");

    registered.get("connected")?.();
    expect(guard.isConnected).toBe(true);

    await guard.ensureConnection();
    expect(mongoose.connect).not.toHaveBeenCalled();
  });

  it("reconnects again after a disconnect or connection error", async () => {
    const registered = handlersFor();
    const guard = new MongoConnectionGuard("test service");

    registered.get("connected")?.();
    registered.get("disconnected")?.();
    expect(guard.isConnected).toBe(false);

    await guard.ensureConnection();
    expect(mongoose.connect).toHaveBeenCalledTimes(1);

    registered.get("connected")?.();
    registered.get("error")?.(new Error("boom"));
    expect(guard.isConnected).toBe(false);
  });

  it("rethrows a failed reconnect so the caller can abort its query", async () => {
    (mongoose.connect as jest.Mock).mockImplementationOnce(() =>
      Promise.reject(new Error("unreachable")),
    );
    const guard = new MongoConnectionGuard("test service");

    await expect(guard.ensureConnection()).rejects.toThrow("unreachable");
  });
});
