/**
 * jsdom test environment with Node's web globals restored (issue #856).
 *
 * The accessibility suites need a DOM for axe, so they run under jsdom — but
 * jsdom ships none of the WHATWG globals undici expects, and undici is pulled
 * in transitively by `discord.js`, which every WebUI module imports. Rather
 * than hand-polyfilling a growing list, this environment copies the real
 * implementations from the surrounding Node process into the jsdom global.
 *
 * Only names jsdom leaves undefined are copied, so jsdom's own DOM-aware
 * versions (e.g. `Blob`, `Event`) always win.
 */
const JSDOMEnvironment = require("jest-environment-jsdom").default;

const NODE_GLOBALS = [
  "TextEncoder",
  "TextDecoder",
  "ReadableStream",
  "WritableStream",
  "TransformStream",
  "ByteLengthQueuingStrategy",
  "CountQueuingStrategy",
  "MessageChannel",
  "MessagePort",
  "BroadcastChannel",
  "structuredClone",
  "fetch",
  "Headers",
  "Request",
  "Response",
  "FormData",
  "Blob",
  "File",
  "AbortController",
  "AbortSignal",
  "crypto",
  "performance",
  "setImmediate",
  "clearImmediate",
  "Buffer",
];

class JsdomNodeEnvironment extends JSDOMEnvironment {
  constructor(config, context) {
    super(config, context);
    for (const name of NODE_GLOBALS) {
      if (this.global[name] === undefined && globalThis[name] !== undefined) {
        this.global[name] = globalThis[name];
      }
    }
  }
}

module.exports = JsdomNodeEnvironment;
