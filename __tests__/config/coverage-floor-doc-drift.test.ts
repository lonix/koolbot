import { describe, it, expect } from "@jest/globals";
import { readFileSync, readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { join } from "node:path";

/**
 * Guards the documented coverage floors against drifting away from
 * `coverageThreshold.global` in `jest.config.js` (#920).
 *
 * The floors were raised in #848, but `CLAUDE.md` and `CONTRIBUTING.md` kept
 * quoting the pre-#848 numbers, so three docs disagreed with each other and
 * with the config. `CLAUDE.md` is the agent-guidance file, so a stale number
 * there propagates into future work. Those two files now describe only the
 * policy and point at `TESTING.md`, which carries the one table; this test
 * makes sure that table stays right and that no other doc quietly reintroduces
 * a second copy of the numbers.
 */

const REPO_ROOT = fileURLToPath(new URL("../../", import.meta.url));

const METRICS = ["statements", "branches", "functions", "lines"] as const;
type Metric = (typeof METRICS)[number];

/**
 * Reads the enforced floors out of `jest.config.js` as text rather than by
 * importing it: the config is the gate CI actually runs, and a text read keeps
 * this guard independent of how Jest resolves its own config under ESM. The
 * "every metric is present" assertion below is what stops a reformat from
 * silently turning this into a no-op test.
 */
function readEnforcedFloors(): Record<Metric, number> {
  const config = readFileSync(join(REPO_ROOT, "jest.config.js"), "utf8");
  const block = /coverageThreshold:\s*{\s*global:\s*{([^}]*)}/.exec(config);
  expect(block).not.toBeNull();

  const floors: Partial<Record<Metric, number>> = {};
  for (const metric of METRICS) {
    const match = new RegExp(`${metric}:\\s*(\\d+)`).exec(block![1]);
    expect(match).not.toBeNull();
    floors[metric] = Number(match![1]);
  }
  return floors as Record<Metric, number>;
}

/**
 * Every place a markdown file states a floor for one of the four metrics —
 * both the `TESTING.md` table row (`| Statements | 66% |`) and the prose form
 * (`statements 66%`). Percent-less forms such as "branches 60" are matched too,
 * since that is exactly how `CLAUDE.md` drifted; the trailing guard rejects
 * digits that are part of a longer number or a line range like `166-167`.
 */
const FLOOR_MENTION = new RegExp(
  `\\b(${METRICS.join("|")})\\b[\\s|:*]{0,4}(\\d{1,3})%?(?![\\d.%-])`,
  "gi",
);

const SKIPPED_DIRS = new Set(["node_modules", "dist", "coverage", ".git"]);

function markdownFiles(dir: string, acc: string[] = []): string[] {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (SKIPPED_DIRS.has(entry.name)) continue;
    const path = join(dir, entry.name);
    if (entry.isDirectory()) markdownFiles(path, acc);
    else if (entry.name.endsWith(".md")) acc.push(path);
  }
  return acc;
}

describe("coverage floor documentation", () => {
  const floors = readEnforcedFloors();

  it("TESTING.md lists the enforced floors", () => {
    const testingMd = readFileSync(join(REPO_ROOT, "TESTING.md"), "utf8");
    for (const metric of METRICS) {
      const row = new RegExp(`\\|\\s*${metric}\\s*\\|\\s*(\\d+)%\\s*\\|`, "i");
      const match = row.exec(testingMd);
      expect(match).not.toBeNull();
      expect(Number(match![1])).toBe(floors[metric]);
    }
  });

  it("no markdown file quotes a floor that disagrees with jest.config.js", () => {
    const mismatches: string[] = [];
    for (const file of markdownFiles(REPO_ROOT)) {
      const contents = readFileSync(file, "utf8");
      for (const [text, metric, value] of contents.matchAll(FLOOR_MENTION)) {
        const floor = floors[metric.toLowerCase() as Metric];
        if (Number(value) !== floor) {
          mismatches.push(
            `${file.slice(REPO_ROOT.length)}: "${text.trim()}" (enforced floor is ${floor})`,
          );
        }
      }
    }
    expect(mismatches).toEqual([]);
  });
});
