import {
  describe,
  it,
  expect,
  jest,
  beforeEach,
  afterEach,
} from "@jest/globals";
import { runWithTimeout } from "../../src/utils/run-with-timeout.js";
import logger from "../../src/utils/logger.js";

// #1294: shutdown steps must not leave timers behind, and a timeout is a
// warning (shutdown carries on), not an error with a stack.
describe("runWithTimeout", () => {
  let warnSpy: ReturnType<typeof jest.spyOn>;
  let errorSpy: ReturnType<typeof jest.spyOn>;

  beforeEach(() => {
    jest.useFakeTimers();
    jest.spyOn(logger, "info").mockImplementation((() => logger) as never);
    warnSpy = jest
      .spyOn(logger, "warn")
      .mockImplementation((() => logger) as never);
    errorSpy = jest
      .spyOn(logger, "error")
      .mockImplementation((() => logger) as never);
  });

  afterEach(() => {
    jest.useRealTimers();
    jest.restoreAllMocks();
  });

  it("clears its timer when the operation wins", async () => {
    const result = await runWithTimeout(async () => "ok", 5000, "Step");
    expect(result).toBe("ok");
    expect(jest.getTimerCount()).toBe(0);
    expect(warnSpy).not.toHaveBeenCalled();
    expect(errorSpy).not.toHaveBeenCalled();
  });

  it("clears its timer when the operation throws, and logs at error", async () => {
    const result = await runWithTimeout(
      async () => {
        throw new Error("boom");
      },
      5000,
      "Step",
    );
    expect(result).toBeNull();
    expect(jest.getTimerCount()).toBe(0);
    expect(errorSpy).toHaveBeenCalledTimes(1);
  });

  it("returns null and logs a warn without a stack when the timeout wins", async () => {
    const pending = runWithTimeout(
      () => new Promise<string>(() => undefined),
      5000,
      "Slow step",
    );
    await jest.advanceTimersByTimeAsync(5000);
    expect(await pending).toBeNull();

    expect(errorSpy).not.toHaveBeenCalled();
    expect(warnSpy).toHaveBeenCalledTimes(1);
    const args = warnSpy.mock.calls[0] as unknown[];
    expect(args).toHaveLength(1);
    expect(String(args[0])).toContain("Slow step");
    expect(String(args[0])).toContain("5000ms");
    expect(jest.getTimerCount()).toBe(0);
  });
});
