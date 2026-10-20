#!/usr/bin/env node
/**
 * Build the UI preview job summary (#1327), changed pages first.
 *
 * Compares the head render with the base branch's render by the SHA-256 of
 * each page's HTML (never pixels, so it cannot flake). When the base render
 * is missing (the base could not be built or rendered) it says so and lists
 * every page. Writes Markdown to stdout.
 *
 * Usage: node scripts/ui-preview-summary.mjs --head <dir> [--base <dir>] [--artifact-url <url>]
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const flag = (name) => {
  const i = process.argv.indexOf(name);
  return i > -1 ? process.argv[i + 1] : undefined;
};

const readManifest = (dir) => {
  if (!dir) return null;
  try {
    return JSON.parse(fs.readFileSync(path.join(dir, "manifest.json"), "utf8"));
  } catch {
    return null;
  }
};

export function summarise(head, base, artifactUrl) {
  const lines = ["## UI preview", ""];
  lines.push(
    artifactUrl
      ? `Screenshots: [download the \`ui-preview\` artifact](${artifactUrl}) (kept 14 days).`
      : "Screenshots are in the `ui-preview` artifact of this run (kept 14 days).",
    "",
  );

  const row = (p) =>
    `- ${p.name}: \`${p.file.replace(/\.html$/, ".png")}\`${p.mobile ? " (+ 390px)" : ""}`;

  if (!base) {
    lines.push(
      "The base branch could not be rendered (it may predate the preview script), so changed pages cannot be told apart. All pages:",
      "",
      ...head.pages.map(row),
    );
    return lines.join("\n") + "\n";
  }

  const baseHash = new Map(base.pages.map((p) => [p.file, p.sha256]));
  const changed = head.pages.filter((p) => baseHash.get(p.file) !== p.sha256);
  const same = head.pages.filter((p) => baseHash.get(p.file) === p.sha256);
  const removed = base.pages.filter(
    (p) => !head.pages.some((h) => h.file === p.file),
  );
  const cssChanged = Object.keys({ ...head.assets, ...base.assets }).filter(
    (f) => head.assets[f] !== base.assets[f],
  );

  if (cssChanged.length) {
    lines.push(
      `The shared stylesheet changed (${cssChanged.map((f) => `\`${f}\``).join(", ")}): every page may look different even where its HTML did not.`,
      "",
    );
  }
  lines.push(`### Changed pages (${changed.length})`, "");
  lines.push(
    ...(changed.length
      ? changed.map(row)
      : ["None: the HTML of every page matches the base branch."]),
    "",
  );
  if (removed.length) {
    lines.push(
      `### Pages no longer rendered (${removed.length})`,
      "",
      ...removed.map((p) => `- ${p.name}`),
      "",
    );
  }
  lines.push(`### Unchanged pages (${same.length})`, "", ...same.map(row));
  return lines.join("\n") + "\n";
}

if (path.resolve(process.argv[1] ?? "") === fileURLToPath(import.meta.url)) {
  const head = readManifest(flag("--head"));
  if (!head) {
    console.error("No head manifest");
    process.exit(1);
  }
  process.stdout.write(
    summarise(head, readManifest(flag("--base")), flag("--artifact-url")),
  );
}
