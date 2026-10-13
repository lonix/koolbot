import { describe, it, expect, jest } from "@jest/globals";
import winston from "winston";
import logger from "../../src/utils/logger.js";

describe("Logger Error Handling", () => {
  describe("Logger Configuration", () => {
    it("should create logger with error serialization format", () => {
      const testLogger = winston.createLogger({
        level: "info",
        format: winston.format.combine(
          winston.format.timestamp(),
          winston.format.errors({ stack: true }),
          winston.format.printf(
            ({ timestamp, level, message, stack, ...meta }) => {
              let log = `${timestamp} [${level.toUpperCase()}]: ${message}`;

              if (stack) {
                log += `\n${stack}`;
              }

              const metaKeys = Object.keys(meta).filter(
                (key) =>
                  !["timestamp", "level", "message", "stack"].includes(key),
              );
              if (metaKeys.length > 0) {
                log += `\n${JSON.stringify(meta, null, 2)}`;
              }

              return log;
            },
          ),
        ),
        transports: [
          new winston.transports.Console({
            silent: true, // Silent mode for testing
          }),
        ],
      });

      expect(testLogger).toBeDefined();
      expect(testLogger.level).toBe("info");
    });

    it("should handle Error objects without crashing", () => {
      const testLogger = winston.createLogger({
        level: "info",
        format: winston.format.combine(
          winston.format.timestamp(),
          winston.format.errors({ stack: true }),
          winston.format.printf(({ timestamp, level, message, stack }) => {
            let log = `${timestamp} [${level.toUpperCase()}]: ${message}`;
            if (stack) {
              log += `\n${stack}`;
            }
            return log;
          }),
        ),
        transports: [
          new winston.transports.Console({
            silent: true,
          }),
        ],
      });

      const testError = new Error("Test error message");

      // Should not throw when logging error objects
      expect(() => {
        testLogger.error("Uncaught exception:", testError);
      }).not.toThrow();
    });

    it("should handle TypeError objects without crashing", () => {
      const testLogger = winston.createLogger({
        level: "info",
        format: winston.format.combine(
          winston.format.timestamp(),
          winston.format.errors({ stack: true }),
          winston.format.printf(({ timestamp, level, message, stack }) => {
            let log = `${timestamp} [${level.toUpperCase()}]: ${message}`;
            if (stack) {
              log += `\n${stack}`;
            }
            return log;
          }),
        ),
        transports: [
          new winston.transports.Console({
            silent: true,
          }),
        ],
      });

      const typeError = new TypeError("Invalid type");

      expect(() => {
        testLogger.error("Type error occurred:", typeError);
      }).not.toThrow();
    });

    it("should handle ReferenceError objects without crashing", () => {
      const testLogger = winston.createLogger({
        level: "info",
        format: winston.format.combine(
          winston.format.timestamp(),
          winston.format.errors({ stack: true }),
          winston.format.printf(({ timestamp, level, message, stack }) => {
            let log = `${timestamp} [${level.toUpperCase()}]: ${message}`;
            if (stack) {
              log += `\n${stack}`;
            }
            return log;
          }),
        ),
        transports: [
          new winston.transports.Console({
            silent: true,
          }),
        ],
      });

      const refError = new ReferenceError("Variable not defined");

      expect(() => {
        testLogger.error("Reference error:", refError);
      }).not.toThrow();
    });

    it("should handle custom error objects without crashing", () => {
      const testLogger = winston.createLogger({
        level: "info",
        format: winston.format.combine(
          winston.format.timestamp(),
          winston.format.errors({ stack: true }),
          winston.format.printf(({ timestamp, level, message, stack }) => {
            let log = `${timestamp} [${level.toUpperCase()}]: ${message}`;
            if (stack) {
              log += `\n${stack}`;
            }
            return log;
          }),
        ),
        transports: [
          new winston.transports.Console({
            silent: true,
          }),
        ],
      });

      const customError = { message: "Custom error object" };

      expect(() => {
        testLogger.error("Custom error:", customError);
      }).not.toThrow();
    });

    it("should handle metadata without crashing", () => {
      const testLogger = winston.createLogger({
        level: "info",
        format: winston.format.combine(
          winston.format.timestamp(),
          winston.format.errors({ stack: true }),
          winston.format.printf(
            ({ timestamp, level, message, stack, ...meta }) => {
              let log = `${timestamp} [${level.toUpperCase()}]: ${message}`;
              if (stack) {
                log += `\n${stack}`;
              }
              const metaKeys = Object.keys(meta).filter(
                (key) =>
                  !["timestamp", "level", "message", "stack"].includes(key),
              );
              if (metaKeys.length > 0) {
                log += `\n${JSON.stringify(meta, null, 2)}`;
              }
              return log;
            },
          ),
        ),
        transports: [
          new winston.transports.Console({
            silent: true,
          }),
        ],
      });

      expect(() => {
        testLogger.error("Error with metadata", {
          userId: "123",
          action: "login",
        });
      }).not.toThrow();
    });
  });

  describe("Actual Logger Instance", () => {
    it("should export a valid logger instance", () => {
      expect(logger).toBeDefined();
      expect(typeof logger.info).toBe("function");
      expect(typeof logger.error).toBe("function");
      expect(typeof logger.debug).toBe("function");
      expect(typeof logger.warn).toBe("function");
    });

    it("should log info messages", () => {
      expect(() => {
        logger.info("Test info message");
      }).not.toThrow();
    });

    it("should log error messages", () => {
      expect(() => {
        logger.error("Test error message");
      }).not.toThrow();
    });

    it("should log with metadata", () => {
      expect(() => {
        logger.info("Test with metadata", { key: "value" });
      }).not.toThrow();
    });

    it("should log errors with stack traces", () => {
      const error = new Error("Test error");
      expect(() => {
        logger.error("Error occurred:", error);
      }).not.toThrow();
    });
  });
});

describe("Logger request-payload redaction (#1152)", () => {
  it("never writes requestBody or rawError from an error passed as meta", () => {
    const lines: string[] = [];
    const spy = jest.spyOn(console, "log").mockImplementation((line) => {
      lines.push(String(line));
    });
    const stdout = (
      console as unknown as { _stdout?: { write: (s: string) => boolean } }
    )._stdout;
    const write = stdout
      ? jest.spyOn(stdout, "write").mockImplementation((s: string) => {
          lines.push(String(s));
          return true;
        })
      : undefined;

    const err = Object.assign(new Error("Cannot send messages to this user"), {
      code: 50007,
      requestBody: { json: { content: "https://x.test/admin/s/SECRETTOKEN" } },
      rawError: { message: "https://x.test/admin/s/SECRETTOKEN" },
    });
    logger.warn("DM failed", err);

    spy.mockRestore();
    write?.mockRestore();

    const output = lines.join("\n");
    expect(output).toContain("DM failed");
    expect(output).toContain("50007");
    expect(output).not.toContain("SECRETTOKEN");
  });
});
