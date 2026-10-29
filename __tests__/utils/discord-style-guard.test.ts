/**
 * Guard (#1331, epic #1314): the text rules of `docs/design/discord.md`.
 *
 * 1. A footer reads `KoolBot · <Feature>` (#1522): every footer text the guard
 *    can resolve starts with `KoolBot · `, so an instruction or a status goes in
 *    the description or a field. It never contains the word
 *    "System" and never a database id (`ID: ...`, `${quote._id}`, `${noticeId}`).
 *    An id people need goes in a field, a button or the Web UI.
 * 2. Times in Discord text go through `discordTimestamp()` (or `setTimestamp()`),
 *    never `toLocaleString()` and friends, which print one fixed timezone and
 *    format for every reader.
 * 3. A failed slash command answers through `replyWithError` /
 *    `replyWithUnexpectedError` (`utils/error-reply.ts`, #1509): an ephemeral
 *    embed-danger embed that says what to do next. A reply `content` literal in
 *    `src/commands/`, `src/handlers/` (buttons, menus, forms; #1510) or
 *    `src/index.ts` that starts with `❌` or `⚠️`, or says "There was an error"
 *    or "An error occurred while processing", fails.
 *
 * 3. A command in backticks carries no option syntax (`/quote add`, not
 *    `/quote text:"..." author:@user`): Discord shows the option hints itself.
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

/**
 * Files that still print option syntax in a command, each with the reason and
 * the issue that removes the entry. Never add one to silence the guard.
 */
const OPTION_SYNTAX_ALLOWED: Record<string, string> = {
  "commands/remind.ts":
    "`/remind cancel id:…` until the ids issue (#1532) lands; remove this entry there",
};

/** `/name word:` (also after a subcommand) or `/name @user`, `<user>`, `[x]` inside backticks. */
const OPTION_SYNTAX = /`\/[\w-]+(?: [\w-]+)*? (?:[\w-]+:|[@<[])/;

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

/**
 * Footers that do not start with `KoolBot · ` yet, keyed `file:text`, each with
 * the open issue that removes the entry. Never add one to silence the guard.
 */
const FOOTER_PREFIX_ALLOWED: Record<string, string> = {
  "services/voice-channel-manager.ts:Only the channel owner can use these controls":
    "voice controls footer; #1519 removes this entry",
  "handlers/vc-preset-handler.ts:⭐ default preset auto-applies when you spawn a new channel":
    "voice presets footer; #1519 removes this entry",
  "commands/remind.ts:Cancel one with /remind cancel id:<id>":
    "`/remind list` footer; #1532 removes this entry",
  "services/digest-service.ts:${footer}":
    "digest footer; #1526 removes this entry",
};

const FOOTER_PREFIX = "KoolBot · ";
const SYSTEM_WORD = /\bSystem\b/;
const ID_LABEL = /\bID:/;
/** `${x._id}`, `${quoteId}`, `${noticeId}`, `${x.id}` inside a footer. */
const ID_INTERPOLATION = /\$\{[^}]*(\b_id\b|\.id\b|\bid\b|Id\b|Key\b)[^}]*\}/;
/** A `ref <key>` label: a bot-internal marker, never member-visible (#1513). */
const REF_LABEL = /\bref\s/;

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
  /**
   * Complete footer values the expression can produce, with each same-file
   * constant substituted into its template or concatenation and any unknown
   * part (a call, a property read, an unresolved identifier) kept as a
   * placeholder. A value whose START is unknown is left out. The `KoolBot · `
   * prefix is checked on these, never on `texts` (which also holds fragments).
   */
  values: string[];
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
  const out: Resolved = { texts: [], values: [], unresolved: [] };
  const merge = (r: Resolved): void => {
    out.texts.push(...r.texts);
    out.values.push(...r.values);
    out.unresolved.push(...r.unresolved);
  };
  if (ts.isParenthesizedExpression(expr) || ts.isAsExpression(expr)) {
    merge(resolveFooter(sf, expr.expression, seen));
  } else if (ts.isStringLiteralLike(expr)) {
    out.texts.push(expr.text);
    out.values.push(expr.text);
  } else if (ts.isTemplateExpression(expr)) {
    // Keep each `${...}` as written so an interpolated id is still visible;
    // also follow an identifier span to its value.
    let text = expr.head.text;
    let values: string[] = [expr.head.text];
    for (const span of expr.templateSpans) {
      text += "${" + span.expression.getText(sf) + "}" + span.literal.text;
      const r = resolveFooter(sf, span.expression, seen);
      if (ts.isIdentifier(span.expression)) out.texts.push(...r.texts);
      // A known span is substituted; an unknown one stays as written, so the
      // text before it is still a known start.
      const spanValues =
        r.values.length > 0
          ? r.values
          : ["${" + span.expression.getText(sf) + "}"];
      values = values.flatMap((v) =>
        spanValues.map((sv) => v + sv + span.literal.text),
      );
    }
    out.texts.push(text);
    out.values.push(...values);
  } else if (
    ts.isBinaryExpression(expr) &&
    expr.operatorToken.kind === ts.SyntaxKind.PlusToken
  ) {
    const l = resolveFooter(sf, expr.left, seen);
    const r = resolveFooter(sf, expr.right, seen);
    // Fragments feed the forbidden-content checks; the operands' own values
    // are NOT complete footers, so only the joined values are kept.
    merge({ texts: l.texts, values: [], unresolved: l.unresolved });
    merge({ texts: r.texts, values: [], unresolved: r.unresolved });
    out.texts.push(`${l.texts.join("")}${r.texts.join("")}`);
    // An unknown right side stays as a placeholder; an unknown left side makes
    // the start unknown, so there is no complete value to check.
    if (l.values.length > 0) {
      const rights = r.values.length > 0 ? r.values : ["${…}"];
      out.values.push(...l.values.flatMap((lv) => rights.map((rv) => lv + rv)));
    }
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
    const { texts, values, unresolved } = resolveFooter(sf, expr);
    const problems: string[] = [];
    for (const name of new Set(unresolved)) {
      if (`${file}:${name}` in FOOTER_UNRESOLVED_ALLOWED) continue;
      problems.push(
        `${line}: footer uses \`${name}\`, which is not a same-file const/let literal; write the footer text where it is used, or list "${file}:${name}" in FOOTER_UNRESOLVED_ALLOWED with a reason`,
      );
    }
    // The prefix is a property of a COMPLETE footer value, not of the pieces
    // `texts` also carries (`"Quotes"` in `"KoolBot · " + "Quotes"`).
    for (const value of new Set(values)) {
      if (
        !value.startsWith(FOOTER_PREFIX) &&
        !(`${file}:${value.split("\n")[0]}` in FOOTER_PREFIX_ALLOWED)
      ) {
        problems.push(
          `${line}: footer "${value}" does not start with "${FOOTER_PREFIX}"; name the feature, or list "${file}:${value.split("\n")[0]}" in FOOTER_PREFIX_ALLOWED with the issue that removes it`,
        );
      }
    }
    for (const text of texts) {
      if (SYSTEM_WORD.test(text)) problems.push(`${line}: contains "System"`);
      if (ID_LABEL.test(text)) problems.push(`${line}: contains "ID:"`);
      if (ID_INTERPOLATION.test(text)) {
        problems.push(`${line}: interpolates an id`);
      }
      if (REF_LABEL.test(text)) {
        problems.push(`${line}: contains a "ref " label`);
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

function optionSyntaxProblems(files: string[], root: string): string[] {
  const hits: string[] = [];
  for (const file of files) {
    const name = rel(file, root);
    if (name in OPTION_SYNTAX_ALLOWED) continue;
    stripComments(fs.readFileSync(file, "utf8"))
      .split("\n")
      .forEach((line, i) => {
        if (OPTION_SYNTAX.test(line)) {
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
      // an instruction or a status is not a footer (#1522)
      'e.setFooter({ text: "Use /modlog to view history" })',
      'log({ footer: "Use /modlog for the full history" });',
      "e.setFooter({ text: `Page ${page}/${n} · ${total} total entries` });",
      'const F = "Remove your reaction to lose access";\ne.setFooter({ text: F });',
      "log({ footer: { text: `x ${row._id}` } });",
    ]) {
      expect(footerProblems(bad)).not.toEqual([]);
    }
    for (const fine of [
      'e.setFooter({ text: "KoolBot · Notices" })',
      "e.setFooter({ text: `KoolBot · Notices · ${categoryInfo.label}` })",
      'e.setFooter({ text: "KoolBot · Moderation" })',
      "e.setFooter({ text: `KoolBot · Moderation · Page ${page} of ${n}` });",
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
      // an operation key and a `ref ` label (#1513)
      "e.setFooter({ text: `Remove your reaction · ref ${options.adoptionOpKey}` });",
      "e.setFooter({ text: `Remove your reaction to lose the role${SEP}${options.adoptionOpKey}` });",
      'e.setFooter({ text: "Remove your reaction · ref abc" });',
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
      'let f = "KoolBot · Reaction roles";\nif (x) f = "KoolBot · Reaction roles · Group";\ne.setFooter({ text: f });',
      // dynamic reads and calls are checked where their literals are written
      "e.setFooter({ text: message.footer });",
      "e.setFooter({ text: closedSummary(reason) });",
    ]) {
      expect(footerProblems(fine)).toEqual([]);
    }
  });

  it("checks the KoolBot prefix on the complete footer, not on its fragments (self-test)", () => {
    for (const fine of [
      'e.setFooter({ text: "KoolBot · " + "Quotes" });',
      'const F = "Quotes";\ne.setFooter({ text: `KoolBot · ${F}` });',
      'const P = "KoolBot · ";\nconst F = "Quotes";\ne.setFooter({ text: P + F });',
      'const F = "Quotes";\ne.setFooter({ text: ok ? `KoolBot · ${F}` : "KoolBot · Other" });',
    ]) {
      expect(footerProblems(fine)).toEqual([]);
    }
    for (const bad of [
      'e.setFooter({ text: "Use " + "/modlog" });',
      'const F = "Quotes";\ne.setFooter({ text: `Feature: ${F}` });',
      'const F = "Quotes";\ne.setFooter({ text: ok ? `KoolBot · ${F}` : "Quotes" });',
    ]) {
      expect(footerProblems(bad).join("\n")).toContain("does not start with");
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

  it("names the issue that removes every footer-prefix allow-list entry, and the entry is still needed", () => {
    for (const [key, reason] of Object.entries(FOOTER_PREFIX_ALLOWED)) {
      expect(reason).toMatch(/#\d+/);
      const [file, ...rest] = key.split(":");
      const source = fs.readFileSync(path.join(SRC, file), "utf8");
      expect(source).toContain(rest.join(":"));
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

describe("discord command text guard (#1511)", () => {
  it("prints no option syntax inside a command in backticks", () => {
    expect(optionSyntaxProblems(walk(SRC), SRC)).toEqual([]);
  });

  it("every allow-list entry still needs its exemption and names an issue", () => {
    for (const [name, reason] of Object.entries(OPTION_SYNTAX_ALLOWED)) {
      expect(reason).toMatch(/#\d+/);
      const source = stripComments(
        fs.readFileSync(path.join(SRC, name), "utf8"),
      );
      expect(OPTION_SYNTAX.test(source)).toBe(true);
    }
  });

  it("detects option syntax and leaves plain commands alone (self-test)", () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "discord-guard-"));
    try {
      const f = path.join(tmp, "x.ts");
      for (const bad of [
        "const a = 'Use `/quote text:\"x\" author:@user`';",
        "const a = 'See `/aka @user`';",
        "const a = `Cancel it with \\`/remind cancel id:${id}\\`.`;",
        "const a = 'Run `/warn <user> <reason>`';",
        "const a = 'Run `/modlog [page]`';",
      ]) {
        fs.writeFileSync(f, bad);
        expect(optionSyntaxProblems([f], tmp)).toHaveLength(1);
      }
      for (const fine of [
        "const a = 'Use `/quote add` to save one';",
        "const a = 'Use `/help` to see every command';",
        "const a = 'Open a ticket with `/ticket open`';",
        "// see `/quote text: x`",
        "const a = 'Name: `/quote` then more text: here';",
      ]) {
        fs.writeFileSync(f, fine);
        expect(optionSyntaxProblems([f], tmp)).toHaveLength(0);
      }
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });
});

/**
 * Every string a reply text expression can produce: string and template
 * literals, `+` concatenation, conditionals (both branches) and same-file
 * constants. Calls and property reads are dynamic and yield nothing; the
 * literals that feed them are checked where they are written.
 */
function replyTexts(
  sf: ts.SourceFile,
  expr: ts.Expression,
  seen: string[] = [],
): string[] {
  if (ts.isParenthesizedExpression(expr) || ts.isAsExpression(expr)) {
    return replyTexts(sf, expr.expression, seen);
  }
  if (ts.isStringLiteralLike(expr)) return [expr.text];
  if (ts.isTemplateExpression(expr)) {
    return [
      expr.head.text +
        expr.templateSpans.map((span) => "${}" + span.literal.text).join(""),
    ];
  }
  if (
    ts.isBinaryExpression(expr) &&
    expr.operatorToken.kind === ts.SyntaxKind.PlusToken
  ) {
    // A dynamic side (a call, a property read) contributes no text.
    const left = replyTexts(sf, expr.left, seen);
    const right = replyTexts(sf, expr.right, seen);
    return (left.length ? left : [""]).flatMap((l) =>
      (right.length ? right : [""]).map((r) => l + r),
    );
  }
  if (ts.isConditionalExpression(expr)) {
    return [
      ...replyTexts(sf, expr.whenTrue, seen),
      ...replyTexts(sf, expr.whenFalse, seen),
    ];
  }
  if (ts.isIdentifier(expr) && !seen.includes(expr.text)) {
    return bindingsOf(sf, expr.text).flatMap((b) =>
      replyTexts(sf, b, [...seen, expr.text]),
    );
  }
  return [];
}

const REPLY_METHODS = new Set(["reply", "editReply", "followUp", "send"]);
const CROSS_MARK = /^\s*❌/;
/**
 * A warning sign leading a reply is a failure too ("⚠️ The waiting room no
 * longer exists"), but only outside `commands/`: `/quote add` still opens two
 * purge-race outcomes with it (#1552 left them as they are), so widening the
 * rule there is an owner decision.
 */
const WARNING_SIGN = /^\s*⚠️?/u;
const GENERIC_FAILURE =
  /There was an error|An error occurred while processing/i;

/** The reply texts of a source: `content: x`, and `reply(x)` / `editReply(x)` with a bare string. */
function replyTextExpressions(
  sf: ts.SourceFile,
): { line: number; expr: ts.Expression }[] {
  const out: { line: number; expr: ts.Expression }[] = [];
  const at = (n: ts.Node): number =>
    sf.getLineAndCharacterOfPosition(n.getStart(sf)).line + 1;
  const visit = (n: ts.Node): void => {
    if (
      ts.isPropertyAssignment(n) &&
      ts.isIdentifier(n.name) &&
      n.name.text === "content"
    ) {
      out.push({ line: at(n), expr: n.initializer });
    }
    if (
      ts.isCallExpression(n) &&
      ts.isPropertyAccessExpression(n.expression) &&
      REPLY_METHODS.has(n.expression.name.text) &&
      n.arguments[0]
    ) {
      out.push({ line: at(n), expr: n.arguments[0] });
    }
    ts.forEachChild(n, visit);
  };
  visit(sf);
  return out;
}

function errorReplyProblems(source: string, file = "commands/x.ts"): string[] {
  const sf = ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true);
  const inCommands = file.startsWith("commands/");
  return replyTextExpressions(sf).flatMap(({ line, expr }) => {
    const problems: string[] = [];
    for (const text of replyTexts(sf, expr)) {
      if (CROSS_MARK.test(text) || (!inCommands && WARNING_SIGN.test(text))) {
        problems.push(
          `${line}: reply text starts with "❌" or "⚠️"; use replyWithError (utils/error-reply.ts)`,
        );
      }
      if (GENERIC_FAILURE.test(text)) {
        problems.push(
          `${line}: reply text is a generic error line; use replyWithUnexpectedError (utils/error-reply.ts)`,
        );
      }
    }
    return [...new Set(problems)];
  });
}

/** The sources that answer members in Discord: commands, component handlers, the dispatcher. */
function errorReplyFiles(): string[] {
  return [
    ...walk(path.join(SRC, "commands")),
    ...walk(path.join(SRC, "handlers")),
    path.join(SRC, "index.ts"),
  ];
}

describe("discord error reply guard (#1509, #1510)", () => {
  it("scans the commands, the component handlers and the dispatcher (self-test)", () => {
    const scanned = errorReplyFiles().map((f) => rel(f, SRC));
    expect(scanned).toEqual(
      expect.arrayContaining([
        "index.ts",
        "handlers/vc-control-button-handler.ts",
        "handlers/lfg-button-handler.ts",
        "commands/lfg.ts",
      ]),
    );
  });

  it("has no ❌ or generic-error reply text in src/commands, src/handlers or src/index.ts", () => {
    const hits = errorReplyFiles().flatMap((file) =>
      errorReplyProblems(fs.readFileSync(file, "utf8"), rel(file, SRC)).map(
        (p) => `${rel(file, SRC)}:${p}`,
      ),
    );
    expect(hits).toEqual([]);
  });

  it("catches the failure texts it is meant to catch (self-test)", () => {
    for (const bad of [
      'await interaction.reply({ content: "❌ Quote not found." });',
      "await interaction.editReply({ content: `❌ Failed: ${why}` });",
      'await interaction.editReply("❌ Tell me what you want to play.");',
      'await safeReply(interaction, { content: "There was an error while executing this command!" });',
      'await interaction.reply({ content: "there was an error posting your LFG." });',
      'const m = "❌ nope";\nawait interaction.reply({ content: m });',
      'await interaction.reply({ content: ok ? "Done" : "❌ nope" });',
      'await interaction.reply({ content: "❌ " + reason });',
      'await interaction.followUp("There was an error recording the warning.");',
      'await safeReply(interaction, { content: "❌ An error occurred while processing your request." });',
      'await safeReply(interaction, { content: "An error occurred while processing your request." });',
    ]) {
      expect(errorReplyProblems(bad)).not.toEqual([]);
    }
    // A warning sign leads a failure in a handler or the dispatcher.
    for (const bad of [
      'await interaction.reply({ content: "⚠️ The waiting room no longer exists.", flags });',
      'await interaction.editReply({ content: "⚠ Gone", embeds: [], components: [] });',
    ]) {
      expect(errorReplyProblems(bad, "handlers/x.ts")).not.toEqual([]);
      expect(errorReplyProblems(bad, "index.ts")).not.toEqual([]);
      // ...but is left alone in commands/ (see WARNING_SIGN).
      expect(errorReplyProblems(bad, "commands/x.ts")).toEqual([]);
    }
  });

  it("leaves the texts it must not touch alone (self-test)", () => {
    for (const fine of [
      'await replyWithError(interaction, { title: "Couldn\'t post your LFG", next: "Try again." });',
      "await replyWithUnexpectedError(interaction);",
      'await interaction.editReply({ content: "✅ Quote updated successfully!" });',
      "await interaction.reply({ content: `Posted for ${game}` });",
      "// await interaction.reply({ content: '❌ old' });",
      'logger.error("There was an error while executing this command!");',
      "await interaction.editReply({ content: result.message });",
      'await interaction.editReply({ content: "", embeds: [e], components: [] });',
      'await safeReply(interaction, { content: "You\'re in — 2 spot(s) left." });',
    ]) {
      expect(errorReplyProblems(fine)).toEqual([]);
    }
  });
});
