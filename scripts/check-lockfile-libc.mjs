#!/usr/bin/env node
/**
 * Lockfile libc guard (#1087).
 *
 * Some npm versions silently drop the `"libc"` field from the platform-specific
 * optional dependencies in `package-lock.json` (e.g. `@parcel/watcher-linux-*-glibc`
 * / `-musl`). The production image is built on Alpine (musl), where npm needs that
 * field to pick the right native binary, and the loss is invisible in a diff review.
 *
 * This script compares the lockfile against the one on the base branch and fails
 * when any package that carried `libc` there still exists but no longer has it.
 * Packages that were removed or added (a legitimate dependency change) never fail.
 *
 * Usage:
 *   node scripts/check-lockfile-libc.mjs [--base-ref origin/main] [--base <file>] [--head <file>] [--fix]
 *
 * `--fix` copies the dropped `libc` fields back from the base lockfile into the head
 * lockfile (exit 0) instead of failing, so the lockfile can be regenerated with any npm.
 *
 * Defaults: head is ./package-lock.json, base is read with `git show <ref>:package-lock.json`
 * (ref defaults to origin/main).
 */

import { execFileSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");

/** Set of lockfile package paths that have a `libc` field. */
export function collectLibcPackages(lock) {
  const result = new Set();
  for (const [name, entry] of Object.entries(lock?.packages ?? {})) {
    if (entry && entry.libc !== undefined) {
      result.add(name);
    }
  }
  return result;
}

/**
 * Returns the package paths that had `libc` in `base`, still exist in `head`,
 * but lost the field there. Sorted for stable output.
 */
export function findDroppedLibc(base, head) {
  const headPackages = head?.packages ?? {};
  const dropped = [];
  for (const name of collectLibcPackages(base)) {
    const entry = headPackages[name];
    if (entry && entry.libc === undefined) {
      dropped.push(name);
    }
  }
  return dropped.sort();
}

/**
 * Copies `libc` back from `base` onto the packages in `head` that lost it,
 * keeping the base entry's key order so the lockfile diff stays minimal.
 * Mutates and returns `head`.
 */
export function restoreLibc(base, head) {
  for (const name of findDroppedLibc(base, head)) {
    const baseEntry = base.packages[name];
    const headEntry = head.packages[name];
    const merged = {};
    for (const key of Object.keys(baseEntry)) {
      if (key === "libc" || key in headEntry) {
        merged[key] = key === "libc" ? baseEntry.libc : headEntry[key];
      }
    }
    for (const key of Object.keys(headEntry)) {
      if (!(key in merged)) merged[key] = headEntry[key];
    }
    head.packages[name] = merged;
  }
  return head;
}

export function formatFailure(dropped) {
  const list = dropped.map((name) => `  - ${name}`).join("\n");
  return [
    `package-lock.json lost the "libc" constraint on ${dropped.length} package(s):`,
    list,
    "",
    "Some npm versions drop these fields when regenerating the lockfile. The Alpine (musl)",
    "image needs them to choose the right native binary. To fix, copy them back from the",
    "base branch with:",
    "  npm run check:lockfile -- --base-ref origin/main --fix",
    "then review git diff package-lock.json. See CONTRIBUTING.md (Dependency changes).",
  ].join("\n");
}

function parseArgs(argv) {
  const args = {
    baseRef: "origin/main",
    base: undefined,
    head: undefined,
    fix: false,
  };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    const next = () => {
      const value = argv[++i];
      if (value === undefined || value === "") {
        throw new Error(`${arg} requires a value`);
      }
      return value;
    };
    if (arg === "--base-ref") args.baseRef = next();
    else if (arg === "--base") args.base = next();
    else if (arg === "--head") args.head = next();
    else if (arg === "--fix") args.fix = true;
    else throw new Error(`Unknown argument: ${arg}`);
  }
  return args;
}

function loadBase(args) {
  if (args.base) {
    return JSON.parse(readFileSync(resolve(args.base), "utf8"));
  }
  const raw = execFileSync(
    "git",
    ["show", `${args.baseRef}:package-lock.json`],
    { cwd: repoRoot, encoding: "utf8", maxBuffer: 64 * 1024 * 1024 },
  );
  return JSON.parse(raw);
}

export function main(argv = process.argv.slice(2)) {
  let args;
  let base;
  let head;
  let headPath;
  try {
    args = parseArgs(argv);
    base = loadBase(args);
    headPath = resolve(args.head ?? `${repoRoot}/package-lock.json`);
    head = JSON.parse(readFileSync(headPath, "utf8"));
  } catch (error) {
    console.error(`check-lockfile-libc: ${error.message}`);
    return 2;
  }

  const dropped = findDroppedLibc(base, head);
  if (dropped.length > 0 && args.fix) {
    try {
      writeFileSync(
        headPath,
        `${JSON.stringify(restoreLibc(base, head), null, 2)}\n`,
      );
    } catch (error) {
      console.error(`check-lockfile-libc: ${error.message}`);
      return 2;
    }
    console.log(
      `Restored "libc" on ${dropped.length} package(s) in ${headPath}. Review the diff.`,
    );
    return 0;
  }
  if (dropped.length > 0) {
    console.error(formatFailure(dropped));
    return 1;
  }
  console.log(
    `package-lock.json libc check passed (${collectLibcPackages(head).size} entries with libc).`,
  );
  return 0;
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  process.exitCode = main();
}
