#!/usr/bin/env node
/**
 * Coverage floor drift check.
 *
 * Jest's `coverageThreshold` only catches coverage going *down*. It says nothing
 * when coverage climbs well above the floors, so the floors quietly stop meaning
 * anything -- which is exactly how they ended up ~33 points out of date (#848).
 *
 * This script compares the measured totals in `coverage/coverage-summary.json`
 * against the floors in `jest.config.js` and fails once any metric has more than
 * `--max-drift` percentage points of headroom, prompting a one-line config bump.
 *
 * Usage:
 *   node scripts/check-coverage-drift.mjs [--max-drift 10] [--warn-only]
 *
 * Run `npm run test:ci` (or `npm run test:coverage`) first so the summary exists.
 */

import { appendFileSync, readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const METRICS = ["statements", "branches", "functions", "lines"];

/** "1 point" / "10 points" */
function points(n) {
  return `${n} point${n === 1 ? "" : "s"}`;
}
const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");

function parseArgs(argv) {
  const args = { maxDrift: 10, warnOnly: false };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--warn-only") {
      args.warnOnly = true;
    } else if (arg === "--max-drift") {
      args.maxDrift = Number(argv[++i]);
    } else if (arg.startsWith("--max-drift=")) {
      args.maxDrift = Number(arg.slice("--max-drift=".length));
    } else {
      throw new Error(`Unknown argument: ${arg}`);
    }
  }
  if (!Number.isFinite(args.maxDrift) || args.maxDrift < 0) {
    throw new Error("--max-drift must be a non-negative number");
  }
  return args;
}

function readSummary() {
  const path = resolve(repoRoot, "coverage/coverage-summary.json");
  try {
    return JSON.parse(readFileSync(path, "utf8")).total;
  } catch (error) {
    if (error.code === "ENOENT") {
      throw new Error(
        "coverage/coverage-summary.json not found. Run `npm run test:coverage` first.",
        { cause: error },
      );
    }
    throw error;
  }
}

async function readThresholds() {
  const configUrl = pathToFileURL(resolve(repoRoot, "jest.config.js"));
  const config = (await import(configUrl.href)).default;
  const thresholds = config?.coverageThreshold?.global;
  if (!thresholds) {
    throw new Error("jest.config.js does not define coverageThreshold.global");
  }
  return thresholds;
}

function writeStepSummary(rows, maxDrift) {
  const file = process.env.GITHUB_STEP_SUMMARY;
  if (!file) return;
  const lines = [
    "### Coverage vs. thresholds",
    "",
    "| Metric | Actual | Floor | Headroom |",
    "|---|---:|---:|---:|",
    ...rows.map(
      (row) =>
        `| ${row.metric} | ${row.actual.toFixed(2)}% | ${row.floor}% | ` +
        `${row.headroom >= 0 ? "+" : ""}${row.headroom.toFixed(2)} pts${
          row.headroom > maxDrift ? " :warning:" : ""
        } |`,
    ),
    "",
    `Floors must stay within ${points(maxDrift)} of actual coverage.`,
    "",
  ];
  appendFileSync(file, lines.join("\n"));
}

async function main() {
  const { maxDrift, warnOnly } = parseArgs(process.argv.slice(2));
  const total = readSummary();
  const thresholds = await readThresholds();

  const rows = METRICS.map((metric) => {
    const actual = total[metric]?.pct;
    const floor = thresholds[metric];
    if (typeof actual !== "number" || typeof floor !== "number") {
      throw new Error(`Missing coverage data or threshold for "${metric}"`);
    }
    return { metric, actual, floor, headroom: actual - floor };
  });

  for (const { metric, actual, floor, headroom } of rows) {
    const sign = headroom >= 0 ? "+" : "";
    console.log(
      `${metric.padEnd(10)} actual ${actual.toFixed(2).padStart(6)}%  ` +
        `floor ${String(floor).padStart(3)}%  headroom ${sign}${headroom.toFixed(2)} pts`,
    );
  }

  writeStepSummary(rows, maxDrift);

  const drifted = rows.filter((row) => row.headroom > maxDrift);
  if (drifted.length === 0) {
    console.log(
      `\nCoverage floors are current (max drift ${points(maxDrift)}).`,
    );
    return;
  }

  console.error(
    `\nCoverage floors are more than ${points(maxDrift)} below actual coverage:`,
  );
  for (const { metric, actual, floor } of drifted) {
    const suggested = Math.max(floor + 1, Math.floor(actual) - 2);
    console.error(
      `  ${metric}: raise the floor from ${floor} toward ${suggested}`,
    );
  }
  console.error(
    "\nUpdate coverageThreshold.global in jest.config.js to just under the actuals.",
  );
  if (!warnOnly) {
    process.exitCode = 1;
  }
}

main().catch((error) => {
  console.error(error.message);
  process.exitCode = 1;
});
