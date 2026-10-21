#!/usr/bin/env node
/**
 * Build the UI preview PR comment and job summary (#1341).
 *
 * Runs in the read-only screenshots job: it only turns the plan (plan.json
 * from ui-preview-plan.mjs) and a few values from the environment into
 * Markdown. A separate job with `pull-requests: write` posts the result
 * without running any repository code. Every value is data: page names come
 * from fixture names and are always rendered inside code spans, so Markdown,
 * HTML and @mentions in a name stay inert.
 *
 * Environment (all optional; the text degrades without them):
 *   ARTIFACT_URL  steps.<upload>.outputs.artifact-url
 *   HEAD_SHA      the PR head commit
 *   REPO_URL      https://github.com/<owner>/<repo>
 *   RUN_URL       the workflow run, the fallback when there is no artifact URL
 *
 * Usage: node scripts/ui-preview-comment.mjs --plan <plan.json> --out <file> [--summary]
 *   --summary  write the job-summary variant (no marker, no "updated" footer) to --out
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

export const MARKER = "<!-- ui-preview -->";
/**
 * The pages listed in the comment before it points at plan.json for the rest.
 * 40 lines of at most ~0.6 KB stay far below GitHub's 65536 character limit.
 */
export const MAX_LISTED = 40;
/** Hard ceiling for the whole comment; the footer is dropped past it. */
export const MAX_COMMENT_CHARS = 60000;
const MORE = (n, what) =>
  `- and ${n} more ${what}; the full list is in ${code("plan.json")} in the artifact`;

/** A Markdown code span that survives backticks, newlines and very long names. */
export function code(text) {
  const clean = String(text).replace(/\s+/g, " ").trim().slice(0, 120);
  let longest = 0;
  let run = 0;
  for (const ch of clean) {
    run = ch === "`" ? run + 1 : 0;
    longest = Math.max(longest, run);
  }
  const fence = "`".repeat(longest + 1);
  const pad = clean.startsWith("`") || clean.endsWith("`") ? " " : "";
  return `${fence}${pad}${clean}${pad}${fence}`;
}

const isHttps = (url) => typeof url === "string" && url.startsWith("https://");
const isSha = (sha) => typeof sha === "string" && /^[0-9a-f]{7,40}$/i.test(sha);

/** `2026-10-20 18:02 UTC` */
export const utc = (date) =>
  `${date.toISOString().slice(0, 16).replace("T", " ")} UTC`;

const slug = (page) => page.file.replace(/\.html$/, "");

function pageLine(page, { base }) {
  const shots = [`${slug(page)}.png`];
  if (base) shots.unshift(`${slug(page)}.base.png`);
  if (page.mobile) {
    shots.push(`${slug(page)}@390.png`);
    if (base) shots.push(`${slug(page)}@390.base.png`);
  }
  return `- ${code(page.name)}: ${shots.map(code).join(", ")}`;
}

function list(pages, opts) {
  const lines = pages.slice(0, MAX_LISTED).map((p) => pageLine(p, opts));
  if (pages.length > MAX_LISTED) {
    lines.push(MORE(pages.length - MAX_LISTED, "pages"));
  }
  return lines;
}

export function buildComment(
  plan,
  { artifactUrl, sha, repoUrl, runUrl, now = new Date(), summary = false } = {},
) {
  const lines = summary
    ? ["## UI preview", ""]
    : [MARKER, "### UI preview", ""];

  const facts = [];
  if (isSha(sha)) {
    const short = sha.slice(0, 7);
    facts.push(
      isHttps(repoUrl)
        ? `Commit [${code(short)}](${repoUrl}/commit/${sha})`
        : `Commit ${code(short)}`,
    );
  }
  facts.push(utc(now));
  if (isHttps(artifactUrl)) {
    facts.push(
      `[download the ${code("ui-preview")} artifact](${artifactUrl}) (kept 14 days)`,
    );
  } else if (isHttps(runUrl)) {
    facts.push(
      `the ${code("ui-preview")} artifact is attached to [this run](${runUrl}) (kept 14 days)`,
    );
  } else {
    facts.push(`the ${code("ui-preview")} artifact is attached to this run`);
  }
  lines.push(facts.join(" · "), "");

  const sampleLines = (withBase) => {
    // A page the PR adds has no base render, so it has no before shot.
    const added = new Set(withBase ? plan.added.map((p) => p.file) : []);
    const shown = new Set(plan.sample.map((p) => p.file));
    const unshown = plan.added.filter((p) => !shown.has(p.file)).length;
    return [
      `Highlighted sample, in ${code("sample/")}${withBase ? " (before and after)" : ""}:`,
      "",
      ...list(
        plan.sample.filter((p) => !added.has(p.file)),
        { base: withBase },
      ),
      ...list(
        plan.sample.filter((p) => added.has(p.file)),
        { base: false },
      ).map((l) => `${l} (new page, no before)`),
      ...(unshown > 0 && plan.reason === "shared"
        ? [
            `- and ${unshown} more new page${unshown === 1 ? "" : "s"} (no before), listed in ${code("plan.json")}`,
          ]
        : []),
      "",
      `Every page is in ${code("all-pages/")} (after only).`,
    ];
  };

  if (plan.mode === "none") {
    lines.push(
      "No rendered page differs from the base branch, so no screenshots were taken.",
      `The artifact holds only ${code("manifest.json")} and ${code("plan.json")}.`,
    );
  } else if (plan.mode === "no-base") {
    lines.push(
      "The base branch could not be rendered (it may predate the preview script), so changed pages cannot be told apart and there are no before screenshots.",
      "",
      ...sampleLines(false),
    );
  } else if (plan.mode === "all") {
    if (plan.reason === "shared") {
      const addedFiles = new Set(plan.added.map((p) => p.file));
      const n = plan.changed.filter((p) => !addedFiles.has(p.file)).length;
      lines.push(
        `${n} of ${plan.total} pages changed through a shared change (not the stylesheet), more than ${plan.maxListed ?? "the limit of"} pages, so a sample is shown.`,
      );
    } else {
      const why = plan.cssChanged.length
        ? `the shared stylesheet changed (${plan.cssChanged.map(code).join(", ")})`
        : "the HTML of every page differs";
      lines.push(`All ${plan.total} pages changed: ${why}.`);
    }
    lines.push("", ...sampleLines(true));
  } else {
    const n = plan.changed.length;
    if (n > 0) {
      const added = new Set(plan.added.map((p) => p.file));
      lines.push(
        `Changed pages only: ${n} of ${plan.total} pages changed, in ${code("changed/")} (before ${code(".base.png")}, after ${code(".png")}):`,
        "",
        ...list(
          plan.changed.filter((p) => !added.has(p.file)),
          { base: true },
        ),
        ...list(
          plan.changed.filter((p) => added.has(p.file)),
          { base: false },
        ).map((l) => `${l} (new page, no before)`),
      );
    }
  }

  if (plan.removed.length) {
    lines.push(
      "",
      `${plan.removed.length} page${plan.removed.length === 1 ? "" : "s"} no longer rendered:`,
      "",
      ...plan.removed.slice(0, MAX_LISTED).map((p) => `- ${code(p.name)}`),
      ...(plan.removed.length > MAX_LISTED
        ? [MORE(plan.removed.length - MAX_LISTED, "pages")]
        : []),
    );
  }

  if (!summary) {
    lines.push(
      "",
      "> Updated on pushes that touch UI files. Rendered from this PR merged with the current base branch, built for the commit above. Screenshots are rendered from fixtures, so no bot, database or secrets are involved.",
    );
  }
  const body = lines.join("\n") + "\n";
  return body.length <= MAX_COMMENT_CHARS
    ? body
    : body.slice(0, MAX_COMMENT_CHARS) +
        `\n\n(cut to fit GitHub's comment limit; see ${code("plan.json")} in the artifact)\n`;
}

if (path.resolve(process.argv[1] ?? "") === fileURLToPath(import.meta.url)) {
  const flag = (name) => {
    const i = process.argv.indexOf(name);
    return i > -1 ? process.argv[i + 1] : undefined;
  };
  const planFile = flag("--plan");
  const outFile = flag("--out");
  if (!planFile || !outFile) {
    console.error("Usage: --plan <plan.json> --out <file> [--summary]");
    process.exit(1);
  }
  const body = buildComment(JSON.parse(fs.readFileSync(planFile, "utf8")), {
    artifactUrl: process.env.ARTIFACT_URL,
    sha: process.env.HEAD_SHA,
    repoUrl: process.env.REPO_URL,
    runUrl: process.env.RUN_URL,
    summary: process.argv.includes("--summary"),
  });
  fs.writeFileSync(outFile, body);
}
