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
import ts from "typescript";

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

/**
 * Footers whose text is a bare identifier that cannot be followed to a
 * same-file `const`/`let` literal. Keyed `file:identifier`, each with the reason
 * it is safe. Empty on purpose: add an entry only after a human has looked at
 * the value, never to silence the guard.
 */
const FOOTER_UNRESOLVED_ALLOWED: Record<string, string> = {};

const SYSTEM_WORD = /\bSystem\b/;
const ID_LABEL = /\bID:/;
/** `${x._id}`, `${quoteId}`, `${noticeId}`, `${x.id}` inside a footer. */
const ID_INTERPOLATION = /\$\{[^}]*(\b_id\b|\.id\b|\bid\b|Id\b)[^}]*\}/;

/**
 * Every expression a name is bound to in this file: its declaration
 * initialiser plus each later `name = ...` assignment (a `let footer` that is
 * reassigned per mode). Empty when the name is not bound here (a parameter, an
 * import).
 */
function bindingsOf(sf: ts.SourceFile, name: string): ts.Expression[] {
  const found: ts.Expression[] = [];
  const visit = (n: ts.Node): void => {
    if (
      ts.isVariableDeclaration(n) &&
      ts.isIdentifier(n.name) &&
      n.name.text === name &&
      n.initializer
    ) {
      found.push(n.initializer);
    }
    if (
      ts.isBinaryExpression(n) &&
      n.operatorToken.kind === ts.SyntaxKind.EqualsToken &&
      ts.isIdentifier(n.left) &&
      n.left.text === name
    ) {
      found.push(n.right);
    }
    ts.forEachChild(n, visit);
  };
  visit(sf);
  return found;
}

interface Resolved {
  /** Text to run the forbidden-content checks on. */
  texts: string[];
  /** Bare identifiers that could not be followed to a literal. */
  unresolved: string[];
}

/**
 * Follow a footer expression to the text it can produce: string and template
 * literals, `+` concatenation, conditionals (both branches), `{ text: ... }`
 * objects, and bare identifiers through their same-file bindings. Calls and
 * property reads (`message.footer`, `closedSummary(...)`) are dynamic and
 * yield no text: the literals that feed them are checked where they are
 * written. Not a full evaluator.
 */
function resolveFooter(
  sf: ts.SourceFile,
  expr: ts.Expression,
  seen: string[] = [],
): Resolved {
  const out: Resolved = { texts: [], unresolved: [] };
  const merge = (r: Resolved): void => {
    out.texts.push(...r.texts);
    out.unresolved.push(...r.unresolved);
  };
  if (ts.isParenthesizedExpression(expr) || ts.isAsExpression(expr)) {
    merge(resolveFooter(sf, expr.expression, seen));
  } else if (ts.isStringLiteralLike(expr)) {
    out.texts.push(expr.text);
  } else if (ts.isTemplateExpression(expr)) {
    // Keep each `${...}` as written so an interpolated id is still visible;
    // also follow an identifier span to its value.
    let text = expr.head.text;
    for (const span of expr.templateSpans) {
      text += "${" + span.expression.getText(sf) + "}" + span.literal.text;
      if (ts.isIdentifier(span.expression)) {
        const r = resolveFooter(sf, span.expression, seen);
        out.texts.push(...r.texts);
      }
    }
    out.texts.push(text);
  } else if (
    ts.isBinaryExpression(expr) &&
    expr.operatorToken.kind === ts.SyntaxKind.PlusToken
  ) {
    const l = resolveFooter(sf, expr.left, seen);
    const r = resolveFooter(sf, expr.right, seen);
    merge(l);
    merge(r);
    out.texts.push(`${l.texts.join("")}${r.texts.join("")}`);
  } else if (ts.isConditionalExpression(expr)) {
    merge(resolveFooter(sf, expr.whenTrue, seen));
    merge(resolveFooter(sf, expr.whenFalse, seen));
  } else if (ts.isObjectLiteralExpression(expr)) {
    for (const prop of expr.properties) {
      if (
        ts.isPropertyAssignment(prop) &&
        ts.isIdentifier(prop.name) &&
        prop.name.text === "text"
      ) {
        merge(resolveFooter(sf, prop.initializer, seen));
      }
      if (ts.isShorthandPropertyAssignment(prop) && prop.name.text === "text") {
        merge(resolveFooter(sf, prop.name, seen));
      }
    }
  } else if (ts.isIdentifier(expr)) {
    const name = expr.text;
    const bound = seen.includes(name) ? [] : bindingsOf(sf, name);
    if (bound.length === 0) {
      out.unresolved.push(name);
    } else {
      for (const b of bound) merge(resolveFooter(sf, b, [...seen, name]));
    }
  }
  return out;
}

/** The footer expressions in a source: `.setFooter(x)` and `footer: x`. */
function footerExpressions(
  sf: ts.SourceFile,
): { line: number; expr: ts.Expression }[] {
  const out: { line: number; expr: ts.Expression }[] = [];
  const at = (n: ts.Node): number =>
    sf.getLineAndCharacterOfPosition(n.getStart(sf)).line + 1;
  const visit = (n: ts.Node): void => {
    if (
      ts.isCallExpression(n) &&
      ts.isPropertyAccessExpression(n.expression) &&
      n.expression.name.text === "setFooter" &&
      n.arguments[0]
    ) {
      out.push({ line: at(n), expr: n.arguments[0] });
    }
    if (
      ts.isPropertyAssignment(n) &&
      ts.isIdentifier(n.name) &&
      n.name.text === "footer"
    ) {
      out.push({ line: at(n), expr: n.initializer });
    }
    if (ts.isShorthandPropertyAssignment(n) && n.name.text === "footer") {
      out.push({ line: at(n), expr: n.name });
    }
    ts.forEachChild(n, visit);
  };
  visit(sf);
  return out;
}

function footerProblems(source: string, file = "source.ts"): string[] {
  const sf = ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true);
  return footerExpressions(sf).flatMap(({ line, expr }) => {
    const { texts, unresolved } = resolveFooter(sf, expr);
    const problems: string[] = [];
    for (const name of new Set(unresolved)) {
      if (`${file}:${name}` in FOOTER_UNRESOLVED_ALLOWED) continue;
      problems.push(
        `${line}: footer uses \`${name}\`, which is not a same-file const/let literal; write the footer text where it is used, or list "${file}:${name}" in FOOTER_UNRESOLVED_ALLOWED with a reason`,
      );
    }
    for (const text of texts) {
      if (SYSTEM_WORD.test(text)) problems.push(`${line}: contains "System"`);
      if (ID_LABEL.test(text)) problems.push(`${line}: contains "ID:"`);
      if (ID_INTERPOLATION.test(text)) {
        problems.push(`${line}: interpolates an id`);
      }
    }
    return [...new Set(problems)];
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
      footerProblems(fs.readFileSync(file, "utf8"), rel(file, SRC)).map(
        (p) => `${rel(file, SRC)}:${p}`,
      ),
    );
    expect(hits).toEqual([]);
  });

  it("scans the footers it is meant to scan (self-test)", () => {
    for (const bad of [
      'e.setFooter({ text: "KoolBot Notices System" })',
      "e.setFooter({ text: `ID: ${quoteId}` })",
      "e.setFooter({ text: `${label} • ID: ${notice._id}` })",
      "e.setFooter({ text: `KoolBot · Quotes · ${quote.id}` })",
      'log({ footer: "KoolBot Logger System" });',
      "log({ footer: { text: `x ${row._id}` } });",
    ]) {
      expect(footerProblems(bad)).not.toEqual([]);
    }
    for (const fine of [
      'e.setFooter({ text: "KoolBot · Notices" })',
      "e.setFooter({ text: `KoolBot · Notices · ${categoryInfo.label}` })",
      'e.setFooter({ text: "Use /modlog to view history" })',
      'log({ footer: "KoolBot · Logs · Startup" });',
      "// e.setFooter({ text: 'ID: 1' })",
      "const footer: string = '';",
    ]) {
      expect(footerProblems(fine)).toEqual([]);
    }
  });

  it("follows a footer through a constant or variable (self-test)", () => {
    for (const bad of [
      // a constant holding a forbidden value
      'const F = "KoolBot Quote System";\ne.setFooter({ text: F });',
      'const F = "KoolBot Quote System";\ne.setFooter(F);',
      'const F = "KoolBot Quote System";\nlog({ footer: F });',
      'const F = "KoolBot Quote System";\nlog({ footer: { text: F } });',
      // a variable holding an interpolated id
      "const t = `ID: ${quoteId}`;\ne.setFooter({ text: t });",
      "const t = `KoolBot · Quotes · ${quote._id}`;\ne.setFooter({ text: t });",
      // concatenation, conditionals, template spans and reassigned lets
      'const F = "KoolBot " + "System";\ne.setFooter({ text: F });',
      'const F = ok ? "KoolBot · Quotes" : "KoolBot System";\ne.setFooter({ text: F });',
      'const P = "KoolBot System";\ne.setFooter({ text: `${P} · x` });',
      'let f = "KoolBot · Quotes";\nif (x) f = "ID: 1";\ne.setFooter({ text: f });',
    ]) {
      expect(footerProblems(bad)).not.toEqual([]);
    }
    for (const fine of [
      'const F = "KoolBot · Quotes";\ne.setFooter({ text: F });',
      "const t = `KoolBot · Notices · ${label}`;\ne.setFooter({ text: t });",
      'let f = "Remove your reaction to lose access";\nif (x) f = "Removing keeps the role";\ne.setFooter({ text: f });',
      // dynamic reads and calls are checked where their literals are written
      "e.setFooter({ text: message.footer });",
      "e.setFooter({ text: closedSummary(reason) });",
    ]) {
      expect(footerProblems(fine)).toEqual([]);
    }
  });

  it("allows a legacy string that is only used for detection (self-test)", () => {
    const detectionOnly = [
      'const LEGACY_HEADER_FOOTER = "KoolBot Quote System";',
      'const QUOTES_FOOTER = "KoolBot · Quotes";',
      "const isHeader = (e) => e.footer?.text === LEGACY_HEADER_FOOTER;",
      "e.setFooter({ text: QUOTES_FOOTER });",
    ].join("\n");
    expect(footerProblems(detectionOnly)).toEqual([]);
  });

  it("fails on a footer binding it cannot resolve (self-test)", () => {
    // A parameter, an import and a destructured value all hide the text.
    for (const unresolvable of [
      "function f(text: string) { e.setFooter({ text }); }",
      "function f(text: string) { e.setFooter({ text: text }); }",
      'import { FOOTER } from "./x.js";\ne.setFooter(FOOTER);',
      "const { footer } = row;\nlog({ footer });",
    ]) {
      const problems = footerProblems(unresolvable);
      expect(problems.join("\n")).toContain(
        "not a same-file const/let literal",
      );
    }
  });

  it("has an explained reason for every unresolved-footer allow-list entry", () => {
    for (const [key, reason] of Object.entries(FOOTER_UNRESOLVED_ALLOWED)) {
      expect(key).toMatch(/^[\w/.-]+\.ts:\w+$/);
      expect(reason.length).toBeGreaterThan(10);
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
