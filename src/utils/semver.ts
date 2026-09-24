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

const VERSION_RE =
  /^v?(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?(?:\+[0-9A-Za-z.-]+)?$/;

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
 * Compare two versions: negative when `a < b`, `0` when equal, positive
 * when `a > b`. Returns `null` when either side does not parse. A
 * pre-release sorts below the release of the same `X.Y.Z` (`2.0.0-rc.1`
 * < `2.0.0`); two pre-releases of the same `X.Y.Z` compare lexically, which
 * is enough to spot a difference without claiming a precise ordering.
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
  return pa.prerelease < pb.prerelease ? -1 : 1;
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
