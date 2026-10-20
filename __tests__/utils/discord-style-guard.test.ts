/**
 * Guard (#1331, epic #1314): the text rules of `docs/design/discord.md`.
 *
 * 1. A footer reads `KoolBot · <Feature>`: it never contains the word
 *    "System" and never a database id (`ID: ...`, `${quote._id}`, `${noticeId}`).
 *    An id people need goes in a field, a button or the Web UI.
 * 2. Times in Discord text go through `discordTimestamp()` (or `setTimestamp()`),
 *    never `toLocaleString()` and friends, which print one fixed timezone and
 *    format for every reader.
 *
 * Plain string scan over the TypeScript sources (comments stripped); the Web UI
 * (`src/web/`) is HTML and out of scope. A file may only be listed in
 * DATE_ALLOWED with a reason: use it for a log line or a template placeholder,
 * never for text a member reads in Discord.
 */
import { describe, expect, it } from "@jest/globals";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const SRC = path.resolve(
  path.dirname(new URL(import.meta.url).pathname),
  "../../src",
);

/** Files that format a date as text for a reason other than a Discord message. */
const DATE_ALLOWED: Record<string, string> = {
  "services/scheduled-announcement-service.ts":
    "{date}/{time} placeholders of an operator-authored announcement template; the rest is a log line",
  "services/voice-channel-announcer.ts": "log line only",
  "services/poll-service.ts": "log line only",
  "services/scheduled-service.ts": "log line only",
  "services/message-activity-cleanup.ts": "log line only",
  "services/voice-channel-truncation.ts": "log line only",
};

/** Text-date helpers that Discord-facing code must not call any more. */
const DATE_TEXT = /\.(toLocaleString|toLocaleDateString|toLocaleTimeString)\(/;
/** Replaced by `discordTimestamp(date, "R")` in the slash commands. */
const COMMAND_DATE_HELPERS = /\b(formatTimeAgo|formatDateTimeInZone)\(/;

function stripComments(source: string): string {
  return source
    .replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, " "))
    .replace(/(^|[^:"'`\\])\/\/.*$/gm, "$1");
}

function walk(dir: string): string[] {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
    const full = path.join(dir, e.name);
    if (e.isDirectory()) return e.name === "web" ? [] : walk(full);
    return e.name.endsWith(".ts") ? [full] : [];
  });
}

/** The footer expressions in a source: `setFooter(...)` and `footer: ...`. */
function footerTexts(source: string): { line: number; text: string }[] {
  const out: { line: number; text: string }[] = [];
  const re = /\.setFooter\(|\bfooter:\s*(?=["'`{])/g;
  for (const m of source.matchAll(re)) {
    const start = (m.index ?? 0) + m[0].length;
    let end = start;
    if (m[0].startsWith(".setFooter")) {
      // up to the matching close parenthesis
      let depth = 1;
      while (end < source.length && depth > 0) {
        const c = source[end++];
        if (c === "(") depth++;
        else if (c === ")") depth--;
      }
    } else if (source[start] === "{") {
      let depth = 0;
      do {
        const c = source[end++];
        if (c === "{") depth++;
        else if (c === "}") depth--;
      } while (end < source.length && depth > 0);
    } else {
      // a string literal on one line
      const nl = source.indexOf("\n", start);
      end = nl === -1 ? source.length : nl;
    }
    out.push({
      line: source.slice(0, start).split("\n").length,
      text: source.slice(start, end),
    });
  }
  return out;
}

const SYSTEM_WORD = /\bSystem\b/;
const ID_LABEL = /\bID:/;
/** `${x._id}`, `${quoteId}`, `${noticeId}`, `${x.id}` inside a footer. */
const ID_INTERPOLATION = /\$\{[^}]*(\b_id\b|\.id\b|\bid\b|Id\b)[^}]*\}/;

function footerProblems(source: string): string[] {
  return footerTexts(stripComments(source)).flatMap(({ line, text }) => {
    const problems: string[] = [];
    if (SYSTEM_WORD.test(text)) problems.push(`${line}: contains "System"`);
    if (ID_LABEL.test(text)) problems.push(`${line}: contains "ID:"`);
    if (ID_INTERPOLATION.test(text)) {
      problems.push(`${line}: interpolates an id`);
    }
    return problems;
  });
}

function rel(file: string, root: string): string {
  return path.relative(root, file).split(path.sep).join("/");
}

function dateProblems(files: string[], root: string): string[] {
  const hits: string[] = [];
  for (const file of files) {
    const name = rel(file, root);
    if (name in DATE_ALLOWED) continue;
    const lines = stripComments(fs.readFileSync(file, "utf8")).split("\n");
    const inCommand = name.startsWith("commands/");
    lines.forEach((line, i) => {
      if (DATE_TEXT.test(line)) {
        hits.push(`${name}:${i + 1}: ${line.trim()}`);
      } else if (inCommand && COMMAND_DATE_HELPERS.test(line)) {
        hits.push(`${name}:${i + 1}: ${line.trim()}`);
      }
    });
  }
  return hits;
}

describe("discord footer guard", () => {
  it("finds source files to scan", () => {
    expect(walk(SRC).length).toBeGreaterThan(50);
  });

  it("has no footer with the word System or a database id", () => {
    const hits = walk(SRC).flatMap((file) =>
      footerProblems(fs.readFileSync(file, "utf8")).map(
        (p) => `${rel(file, SRC)}:${p}`,
      ),
    );
    expect(hits).toEqual([]);
  });

  it("scans the footers it is meant to scan (self-test)", () => {
    for (const bad of [
      '.setFooter({ text: "KoolBot Notices System" })',
      ".setFooter({ text: `ID: ${quoteId}` })",
      ".setFooter({ text: `${label} • ID: ${notice._id}` })",
      ".setFooter({ text: `KoolBot · Quotes · ${quote.id}` })",
      'log({ footer: "KoolBot Logger System" });',
      "log({ footer: { text: `x ${row._id}` } });",
    ]) {
      expect(footerProblems(bad)).not.toEqual([]);
    }
    for (const fine of [
      '.setFooter({ text: "KoolBot · Notices" })',
      ".setFooter({ text: `KoolBot · Notices · ${categoryInfo.label}` })",
      '.setFooter({ text: "Use /modlog to view history" })',
      'log({ footer: "KoolBot · Logs · Startup" });',
      "// .setFooter({ text: 'ID: 1' })",
      "const footer: string = '';",
    ]) {
      expect(footerProblems(fine)).toEqual([]);
    }
  });
});

describe("discord time guard", () => {
  it("has no text date format outside the allow-list", () => {
    const files = walk(SRC).filter((f) => !rel(f, SRC).startsWith("scripts/"));
    expect(dateProblems(files, SRC)).toEqual([]);
  });

  it("every allow-list entry still exists and still needs the exemption", () => {
    for (const name of Object.keys(DATE_ALLOWED)) {
      const source = stripComments(
        fs.readFileSync(path.join(SRC, name), "utf8"),
      );
      expect(DATE_TEXT.test(source)).toBe(true);
    }
  });

  it("detects the text formats it is meant to catch (self-test)", () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "discord-guard-"));
    try {
      fs.mkdirSync(path.join(tmp, "commands"));
      const f = path.join(tmp, "commands", "x.ts");
      for (const bad of [
        "const d = when.toLocaleString();",
        "const d = when.toLocaleDateString();",
        "const d = when.toLocaleTimeString();",
        "const ago = formatTimeAgo(when);",
        "const t = formatDateTimeInZone(when, tz);",
      ]) {
        fs.writeFileSync(f, bad);
        expect(dateProblems([f], tmp)).toHaveLength(1);
      }
      for (const fine of [
        'const d = discordTimestamp(when, "R");',
        "// when.toLocaleString()",
        "embed.setTimestamp();",
      ]) {
        fs.writeFileSync(f, fine);
        expect(dateProblems([f], tmp)).toHaveLength(0);
      }
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });
});
