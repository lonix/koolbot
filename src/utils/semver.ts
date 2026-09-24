/**
 * Minimal semantic-version helpers for the Web UI update check (#1029).
 *
 * Only what the check needs: parse `X.Y.Z` (with an optional leading `v` and
 * an optional `-prerelease` / `+build` suffix), order two versions, and name
 * the kind of jump between them. Kept dependency-free on purpose — the full
 * semver grammar is overkill for comparing two release-please tags.
 */

export interface ParsedVersion {
  major: number;
  minor: number;
  patch: number;
  /** Pre-release identifier (the part after `-`), or `null` for a release. */
  prerelease: string | null;
}

export type UpdateKind = "major" | "minor" | "patch";

// The SemVer 2.0.0 grammar: no leading zeros in numeric parts or numeric
// pre-release identifiers, and no empty dot-separated identifiers.
const NUM = "(0|[1-9]\\d*)";
const PRE_ID = "(?:0|[1-9]\\d*|\\d*[A-Za-z-][0-9A-Za-z-]*)";
const BUILD_ID = "[0-9A-Za-z-]+";
const VERSION_RE = new RegExp(
  `^v?${NUM}\\.${NUM}\\.${NUM}` +
    `(?:-(${PRE_ID}(?:\\.${PRE_ID})*))?` +
    `(?:\\+${BUILD_ID}(?:\\.${BUILD_ID})*)?$`,
);

/**
 * Parse a version string. Returns `null` for anything that is not a
 * semantic version — including `getBotVersion()`'s `"unknown"` fallback —
 * so callers can treat "can't compare" as its own state.
 */
export function parseVersion(
  raw: string | null | undefined,
): ParsedVersion | null {
  if (typeof raw !== "string") return null;
  const match = VERSION_RE.exec(raw.trim());
  if (!match) return null;
  const [, major, minor, patch, prerelease] = match;
  return {
    major: Number(major),
    minor: Number(minor),
    patch: Number(patch),
    prerelease: prerelease ?? null,
  };
}

/**
 * SemVer §11 pre-release precedence: compare dot-separated identifiers left
 * to right; numeric identifiers compare numerically and sort below
 * alphanumeric ones; a shorter list of otherwise-equal identifiers sorts
 * first (`rc.2` < `rc.10`, `alpha` < `alpha.1` < `beta`).
 */
function comparePrerelease(a: string, b: string): number {
  const pa = a.split(".");
  const pb = b.split(".");
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const x = pa[i];
    const y = pb[i];
    if (x === undefined) return -1;
    if (y === undefined) return 1;
    const xNum = /^\d+$/.test(x);
    const yNum = /^\d+$/.test(y);
    if (xNum && yNum) {
      const diff = Number(x) - Number(y);
      if (diff !== 0) return Math.sign(diff);
    } else if (xNum !== yNum) {
      return xNum ? -1 : 1;
    } else if (x !== y) {
      return x < y ? -1 : 1;
    }
  }
  return 0;
}

/**
 * Compare two versions: negative when `a < b`, `0` when equal, positive
 * when `a > b`. Returns `null` when either side does not parse. A
 * pre-release sorts below the release of the same `X.Y.Z` (`2.0.0-rc.1`
 * < `2.0.0`), and two pre-releases follow SemVer precedence.
 */
export function compareVersions(a: string, b: string): number | null {
  const pa = parseVersion(a);
  const pb = parseVersion(b);
  if (!pa || !pb) return null;
  const core =
    pa.major - pb.major || pa.minor - pb.minor || pa.patch - pb.patch;
  if (core !== 0) return Math.sign(core);
  if (pa.prerelease === pb.prerelease) return 0;
  if (pa.prerelease === null) return 1;
  if (pb.prerelease === null) return -1;
  return comparePrerelease(pa.prerelease, pb.prerelease);
}

/**
 * Which part of the version moved going from `from` to `to`, or `null` when
 * `to` is not newer (or either side does not parse). A pre-release of the
 * same `X.Y.Z` moving to its release counts as a patch.
 */
export function classifyUpdate(from: string, to: string): UpdateKind | null {
  const cmp = compareVersions(from, to);
  if (cmp === null || cmp >= 0) return null;
  const pf = parseVersion(from) as ParsedVersion;
  const pt = parseVersion(to) as ParsedVersion;
  if (pt.major !== pf.major) return "major";
  if (pt.minor !== pf.minor) return "minor";
  return "patch";
}

/** `2.1.0` / `v2.1.0` → `v2.1.0`; anything unparseable is returned as-is. */
export function formatVersion(raw: string): string {
  const trimmed = raw.trim();
  return parseVersion(trimmed) && !trimmed.startsWith("v")
    ? `v${trimmed}`
    : trimmed;
}
