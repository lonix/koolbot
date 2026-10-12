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
 *   node scripts/check-lockfile-libc.mjs [--base-ref origin/main] [--base <file>] [--head <file>]
 *
 * Defaults: head is ./package-lock.json, base is read with `git show <ref>:package-lock.json`
 * (ref defaults to origin/main).
 */

import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
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

export function formatFailure(dropped) {
  const list = dropped.map((name) => `  - ${name}`).join("\n");
  return [
    `package-lock.json lost the "libc" constraint on ${dropped.length} package(s):`,
    list,
    "",
    "Some npm versions drop these fields when regenerating the lockfile. The Alpine (musl)",
    "image needs them to choose the right native binary. To fix: restore package-lock.json",
    "from the base branch (git checkout origin/main -- package-lock.json) and re-apply only",
    "your intended dependency changes. See CONTRIBUTING.md (Dependency changes).",
  ].join("\n");
}

function parseArgs(argv) {
  const args = { baseRef: "origin/main", base: undefined, head: undefined };
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
  let base;
  let head;
  try {
    const args = parseArgs(argv);
    base = loadBase(args);
    head = JSON.parse(
      readFileSync(
        resolve(args.head ?? `${repoRoot}/package-lock.json`),
        "utf8",
      ),
    );
  } catch (error) {
    console.error(`check-lockfile-libc: ${error.message}`);
    return 2;
  }

  const dropped = findDroppedLibc(base, head);
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
