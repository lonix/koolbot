import { describe, it, expect } from "@jest/globals";
import { readdirSync, readFileSync } from "node:fs";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import ts from "typescript";

/**
 * Wiring scan for #1146.
 *
 * The client default is `allowedMentions: { parse: [] }`, which only protects
 * message text if two habits hold everywhere the bot talks:
 *
 *  1. A message that mentions someone on purpose names who may be pinged, in
 *     the same call (`allowedMentions`). Otherwise the mention silently stops
 *     pinging.
 *  2. A member-controlled name (display name, nickname, username, tag, or a
 *     channel name derived from one) is never interpolated into message text
 *     without `escapeDisplayText`, or a nickname such as `<@id>` or
 *     `[free nitro](https://evil)` renders as a mention or a bot-authored link.
 *
 * This walks the TypeScript source of `src/` (the Web UI renders HTML, not
 * Discord messages, and has its own escaping) and fails with the file, line
 * and text of every offender. It is a heuristic, not a proof: habit 1 sees a
 * literal `<@` in the send call or in a local variable the call sends, not a
 * mention built in another function and passed in; habit 2 sees the well-known
 * name properties and identifiers listed below, not an arbitrary variable that
 * happens to hold a name. A genuine exception goes in the allowlists below with
 * a reason; do not weaken the rules.
 */

const SRC = fileURLToPath(new URL("../../src", import.meta.url));

function sourceFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      if (full === join(SRC, "web")) continue;
      out.push(...sourceFiles(full));
    } else if (entry.name.endsWith(".ts")) {
      out.push(full);
    }
  }
  return out;
}

const SEND_METHODS = new Set([
  "send",
  "reply",
  "editReply",
  "followUp",
  "edit",
]);

/** Name-like property accessors whose value a member controls. */
const NAME_EXPR =
  /(?:\.|^)(?:displayName|username|nickname|globalName|tag|userTag)$|(?:^|\.)(?:channel|oldChannel|newChannel|mainChannel|voiceChannel|waitingRoom)\.name$|^(?:channelName|newName|oldName|savedName)$|^(?:p|selected|result|removed|preset)\.name$/;

/**
 * Template literals in these positions are not rendered as Markdown, so
 * escaping would only show backslashes: logs, errors, button labels and
 * embed titles, and the names of things the bot creates.
 */
const NON_RENDERING_METHODS = new Set([
  "setLabel",
  "setName",
  "setPlaceholder",
  "setFooter",
  "setTitle",
  "setAuthor",
  "setTopic",
  "create",
]);

function isNonRenderingCall(call: ts.CallExpression): boolean {
  const callee = call.expression;
  if (ts.isPropertyAccessExpression(callee)) {
    if (NON_RENDERING_METHODS.has(callee.name.text)) return true;
    // logger.info(...), logger.error(...)
    if (ts.isIdentifier(callee.expression)) {
      return callee.expression.text === "logger";
    }
    return false;
  }
  return ts.isIdentifier(callee) && callee.text === "sanitizeForLog";
}

/**
 * Whole files whose names go into Web UI text or operator tooling output and
 * never into a Discord message. The Web UI escapes HTML on its own.
 */
const NAME_ALLOWED_FILES: Record<string, string> = {
  "services/channel-claims.ts":
    "validation messages shown on the Web UI, escaped as HTML there",
  "services/rules-adoption.ts": "Web UI adoption plan text",
  "services/server-adoption-planner.ts": "Web UI adoption plan text",
  "services/server-adoption-service.ts": "Web UI adoption drift text",
  "scripts/seed-sample-data.ts": "operator CLI seeding fake data, no Discord",
};

/**
 * Individual template literals left unescaped on purpose, keyed by
 * `file:template source`, each with the reason it is not rendered as Markdown.
 */
const NAME_ALLOWLIST: Record<string, string> = {
  "commands/achievements.ts:`${p.emoji} ${bar} **${p.name}** — ${p.current} / ${p.target}${unit}`":
    "`p` is a built-in achievement definition, not a member-controlled name",
  "services/event-live-edit-groups.ts:` [${g.tag}]`":
    "a preset's own default tag in the host panel's confirmation text and result, escaped as HTML there; never a Discord message",
  "services/server-scan-service.ts:`missing-${p.name}`":
    "`p` is a Discord permission name, used as a Web UI issue code",
  "services/server-scan-service.ts:`KoolBot is missing the ${p.name} permission (${p.purpose}). Grant it to the KoolBot role in Server Settings → Roles.`":
    "`p` is a Discord permission name, shown on the Web UI",
  "handlers/vc-preset-handler.ts:`⭐ ${p.name}`":
    "a select-menu option label, plain text in Discord",
  "services/voice-channel-manager.ts:`${displayName}'s Channel`":
    "the name of a channel the bot creates; escaping would bake backslashes in",
  "services/voice-channel-manager.ts:`⏳ ${channel.name} Waiting`":
    "the name of a waiting room the bot creates",
  "services/voice-channel-manager.ts:`${prefix} ${member.displayName}${suffix}`":
    "the name of a channel the bot creates",
  "services/voice-channel-manager.ts:`${channelPrefix} ${member.displayName}${channelSuffix}`":
    "the name of a channel the bot creates",
  "handlers/vc-control-button-handler.ts:`Transfer ownership to ${member.displayName}`":
    "a select-menu option description, plain text in Discord",
  "handlers/vc-preset-handler.ts:`vc_preset_default_${idx}_${tag}_${channelId}_${ownerId}`":
    "a button custom id; `tag` is a hash of the preset name, not a name",
  "handlers/vc-preset-handler.ts:`vc_preset_rename_${idx}_${tag}_${channelId}_${ownerId}`":
    "a button custom id; `tag` is a hash of the preset name, not a name",
  "handlers/vc-preset-handler.ts:`vc_preset_delete_${idx}_${tag}_${channelId}_${ownerId}`":
    "a button custom id; `tag` is a hash of the preset name, not a name",
};

function rel(file: string): string {
  return relative(SRC, file).split("\\").join("/");
}

function lineOf(sf: ts.SourceFile, node: ts.Node): number {
  return sf.getLineAndCharacterOfPosition(node.getStart(sf)).line + 1;
}

/** Bare identifiers a send call passes as its message or its `content`. */
function sentIdentifiers(call: ts.CallExpression): string[] {
  const names: string[] = [];
  for (const arg of call.arguments) {
    if (ts.isIdentifier(arg)) names.push(arg.text);
    if (ts.isObjectLiteralExpression(arg)) {
      for (const prop of arg.properties) {
        if (
          ts.isShorthandPropertyAssignment(prop) &&
          prop.name.text === "content"
        )
          names.push("content");
        if (
          ts.isPropertyAssignment(prop) &&
          ts.isIdentifier(prop.name) &&
          prop.name.text === "content" &&
          ts.isIdentifier(prop.initializer)
        )
          names.push(prop.initializer.text);
      }
    }
  }
  return names;
}

/** Does the nearest enclosing function declare `name` with a `<@` mention? */
function localInitializerMentions(
  call: ts.CallExpression,
  name: string,
  sf: ts.SourceFile,
): boolean {
  let fn: ts.Node | undefined = call.parent;
  while (fn && !ts.isFunctionLike(fn)) fn = fn.parent;
  if (!fn) return false;
  let found = false;
  const look = (n: ts.Node): void => {
    if (
      ts.isVariableDeclaration(n) &&
      ts.isIdentifier(n.name) &&
      n.name.text === name &&
      n.initializer &&
      /<@/.test(n.initializer.getText(sf))
    ) {
      found = true;
    }
    ts.forEachChild(n, look);
  };
  look(fn);
  return found;
}

interface Finding {
  where: string;
  detail: string;
}

function scan(): { pings: Finding[]; names: Finding[] } {
  const pings: Finding[] = [];
  const names: Finding[] = [];

  for (const file of sourceFiles(SRC)) {
    const text = readFileSync(file, "utf8");
    const sf = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true);

    const visit = (node: ts.Node): void => {
      // Habit 1: a literal `<@...>` mention in a send must say who may be pinged.
      if (
        ts.isCallExpression(node) &&
        ts.isPropertyAccessExpression(node.expression) &&
        SEND_METHODS.has(node.expression.name.text) &&
        node.arguments.length > 0
      ) {
        const args = node.arguments.map((a) => a.getText(sf)).join(",");
        if (!/allowedMentions/.test(args)) {
          // A literal mention in the call, or in the initializer of a local
          // variable the call sends (`const message = [...]; send(message)`).
          const mentionsInline = /<@/.test(args);
          const mentionsViaLocal = sentIdentifiers(node).some((name) =>
            localInitializerMentions(node, name, sf),
          );
          if (mentionsInline || mentionsViaLocal) {
            pings.push({
              where: `${rel(file)}:${lineOf(sf, node)}`,
              detail: args.replace(/\s+/g, " ").slice(0, 120),
            });
          }
        }
      }

      // Habit 2: a member-controlled name inside a template literal.
      if (ts.isTemplateExpression(node)) {
        for (const span of node.templateSpans) {
          const expr = span.expression.getText(sf).replace(/\s+/g, "");
          if (!NAME_EXPR.test(expr)) continue;

          let rendered = true;
          for (let p: ts.Node | undefined = node.parent; p; p = p.parent) {
            if (ts.isCallExpression(p) && isNonRenderingCall(p)) {
              rendered = false;
              break;
            }
            if (ts.isNewExpression(p) || ts.isThrowStatement(p)) {
              rendered = false;
              break;
            }
          }
          if (!rendered) continue;

          if (rel(file) in NAME_ALLOWED_FILES) continue;
          const template = node.getText(sf).replace(/\s+/g, " ");
          if (`${rel(file)}:${template}` in NAME_ALLOWLIST) continue;
          names.push({
            where: `${rel(file)}:${lineOf(sf, node)}`,
            detail: "${" + expr + "} in " + template.slice(0, 100),
          });
        }
      }
      ts.forEachChild(node, visit);
    };
    visit(sf);
  }
  return { pings, names };
}

const format = (findings: Finding[]): string =>
  findings.map((f) => `  ${f.where}  ${f.detail}`).join("\n");

describe("message mention safety scan (#1146)", () => {
  const { pings, names } = scan();

  it("every send that mentions a member carries its own allowedMentions", () => {
    expect(format(pings)).toBe("");
  });

  it("no member-controlled name reaches message text unescaped", () => {
    expect(format(names)).toBe("");
  });

  it("the scan sees the source it is meant to guard", () => {
    const files = sourceFiles(SRC).map(rel);
    expect(files).toContain("services/voice-channel-manager.ts");
    expect(files).toContain("services/voice-channel-announcer.ts");
    expect(files).toContain("commands/seen.ts");
  });
});
