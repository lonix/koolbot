import { describe, it, expect, afterEach, jest } from "@jest/globals";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
// @ts-expect-error -- plain Node ESM tooling script, no type declarations
import * as guard from "../../scripts/check-lockfile-libc.mjs";

type Lock = { packages: Record<string, Record<string, unknown>> };

const goodLock = (): Lock => ({
  packages: {
    "": { name: "koolbot" },
    "node_modules/@parcel/watcher-linux-x64-glibc": {
      version: "2.5.0",
      optional: true,
      libc: ["glibc"],
    },
    "node_modules/@parcel/watcher-linux-x64-musl": {
      version: "2.5.0",
      optional: true,
      libc: ["musl"],
    },
    "node_modules/express": { version: "5.2.1" },
  },
});

const stripLibc = (lock: Lock): Lock => {
  const copy = JSON.parse(JSON.stringify(lock)) as Lock;
  for (const entry of Object.values(copy.packages)) delete entry.libc;
  return copy;
};

describe("check-lockfile-libc", () => {
  describe("findDroppedLibc", () => {
    it("passes an unchanged lockfile", () => {
      expect(guard.findDroppedLibc(goodLock(), goodLock())).toEqual([]);
    });

    it("fails and names packages when libc was dropped", () => {
      expect(guard.findDroppedLibc(goodLock(), stripLibc(goodLock()))).toEqual([
        "node_modules/@parcel/watcher-linux-x64-glibc",
        "node_modules/@parcel/watcher-linux-x64-musl",
      ]);
    });

    it("flags a partial drop only for the affected package", () => {
      const head = goodLock();
      delete head.packages["node_modules/@parcel/watcher-linux-x64-musl"].libc;
      expect(guard.findDroppedLibc(goodLock(), head)).toEqual([
        "node_modules/@parcel/watcher-linux-x64-musl",
      ]);
    });

    it("allows a native dependency (and its libc) to be removed", () => {
      const head = goodLock();
      delete head.packages["node_modules/@parcel/watcher-linux-x64-glibc"];
      delete head.packages["node_modules/@parcel/watcher-linux-x64-musl"];
      expect(guard.findDroppedLibc(goodLock(), head)).toEqual([]);
    });

    it("allows a new native dependency to be added", () => {
      const head = goodLock();
      head.packages["node_modules/@unrs/resolver-binding-linux-x64-musl"] = {
        version: "1.0.0",
        libc: ["musl"],
      };
      expect(guard.findDroppedLibc(goodLock(), head)).toEqual([]);
    });

    it("tolerates lockfiles without a packages map", () => {
      expect(guard.findDroppedLibc({}, {})).toEqual([]);
    });
  });

  describe("formatFailure", () => {
    it("lists packages and explains the fix", () => {
      const message = guard.formatFailure(["node_modules/a"]);
      expect(message).toContain("node_modules/a");
      expect(message).toContain("CONTRIBUTING.md");
    });
  });

  describe("main", () => {
    let dir: string | undefined;
    afterEach(() => {
      jest.restoreAllMocks();
      if (dir) rmSync(dir, { recursive: true, force: true });
      dir = undefined;
    });

    const run = (base: Lock, head: Lock): number => {
      dir = mkdtempSync(join(tmpdir(), "libc-guard-"));
      writeFileSync(join(dir, "base.json"), JSON.stringify(base));
      writeFileSync(join(dir, "head.json"), JSON.stringify(head));
      jest.spyOn(console, "log").mockImplementation(() => undefined);
      jest.spyOn(console, "error").mockImplementation(() => undefined);
      return guard.main([
        "--base",
        join(dir, "base.json"),
        "--head",
        join(dir, "head.json"),
      ]);
    };

    it("exits 0 for a good lockfile", () => {
      expect(run(goodLock(), goodLock())).toBe(0);
    });

    it("exits 1 for a lockfile that dropped the constraints", () => {
      expect(run(goodLock(), stripLibc(goodLock()))).toBe(1);
    });

    it("exits 2 on unreadable input or bad arguments", () => {
      jest.spyOn(console, "error").mockImplementation(() => undefined);
      expect(guard.main(["--base", "/nonexistent/base.json"])).toBe(2);
      expect(guard.main(["--bogus"])).toBe(2);
    });
  });
});
