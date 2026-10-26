/**
 * The shared stylesheets (#1315): generation from tokens.json, the public
 * cacheable route on both surfaces, the CSP that admits them, and the links
 * every page carries.
 */
import { describe, it, expect, beforeAll, afterAll } from "@jest/globals";
import express from "express";
import type { AddressInfo } from "net";
import { createServer, type Server } from "http";
import { createUserWebRouter, createWebRouter } from "../../src/web/index.js";
import {
  buildTokensCss,
  designStylesheetLinks,
  loadDesignAssets,
  type DesignTokens,
} from "../../src/web/design-assets.js";
import { buildCsp } from "../../src/web/security-headers.js";
import { renderErrorPage } from "../../src/web/views.js";

const TOKENS: DesignTokens = {
  color: {
    tokens: [
      { name: "warn", value: "#f59e0b" },
      { name: "embed-warn", value: "{warn}" },
    ],
  },
  type: {
    families: { sans: "system-ui, sans-serif" },
    groups: [
      {
        name: "Text",
        styles: [
          { name: "body", fontSize: "1rem", lineHeight: 1.5, fontWeight: 400 },
          {
            name: "overline",
            fontSize: "0.7rem",
            lineHeight: 1.4,
            fontWeight: 600,
            letterSpacing: "0.06em",
          },
        ],
      },
    ],
  },
  spacing: { tokens: [{ name: "space-1", value: "0.25rem" }] },
  radius: { tokens: [{ name: "radius-sm", value: "4px" }] },
  shadow: { tokens: [{ name: "shadow-pop", value: "0 1px 2px black" }] },
  layout: { tokens: [{ name: "content-max", value: "72rem" }] },
};

describe("buildTokensCss", () => {
  it("emits every group on :root, with type styles as properties", () => {
    const css = buildTokensCss(TOKENS);
    expect(css).toContain(":root {");
    expect(css).toContain("--warn: #f59e0b;");
    expect(css).toContain("--embed-warn: var(--warn);");
    expect(css).toContain("--shadow-pop: 0 1px 2px black;");
    expect(css).toContain("--space-1: 0.25rem;");
    expect(css).toContain("--radius-sm: 4px;");
    expect(css).toContain("--content-max: 72rem;");
    expect(css).toContain("--font-sans: system-ui, sans-serif;");
    expect(css).toContain("--type-body-size: 1rem;");
    expect(css).toContain("--type-body-line-height: 1.5;");
    expect(css).toContain("--type-body-weight: 400;");
    expect(css).toContain("--type-overline-letter-spacing: 0.06em;");
    expect(css).not.toContain("--type-body-letter-spacing");
  });
});

describe("design asset links and CSP", () => {
  it("links both files with the content-hash version on every page shell", () => {
    const { version } = loadDesignAssets();
    for (const [surface, product] of [
      ["/admin", "KoolBot Admin"],
      ["/me", "KoolBot"],
    ] as const) {
      expect(designStylesheetLinks(surface)).toBe(
        `<link rel="stylesheet" href="${surface}/_assets/tokens.css?v=${version}">` +
          `<link rel="stylesheet" href="${surface}/_assets/kb.css?v=${version}">`,
      );
      const page = renderErrorPage({
        title: "T",
        heading: "H",
        bodyHtml: "<p>x</p>",
        product,
      });
      expect(page).toContain(`href="${surface}/_assets/tokens.css?v=`);
      expect(page).toContain(`href="${surface}/_assets/kb.css?v=`);
    }
  });

  it("allows same-origin stylesheets and still no script unsafe-inline", () => {
    const csp = buildCsp("n");
    expect(csp).toContain("style-src 'self' 'unsafe-inline'");
    expect(csp).toContain("default-src 'none'");
    expect(csp).not.toMatch(/script-src[^;]*unsafe-inline/);
  });
});

describe("GET /admin|/me/_assets/:file", () => {
  let server: Server;
  let baseUrl: string;
  const ORIGINAL_ENV = { ...process.env };

  beforeAll(async () => {
    process.env.WEBUI_SESSION_SECRET =
      "test-secret-for-design-assets-0123456789";
    process.env.WEBUI_BASE_URL = "http://localhost:3000";
    const app = express();
    app.use("/admin", createWebRouter({} as never));
    app.use("/me", createUserWebRouter({} as never));
    await new Promise<void>((resolve) => {
      server = createServer(app);
      server.listen(0, "127.0.0.1", () => {
        baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
        resolve();
      });
    });
  });

  afterAll(async () => {
    process.env = { ...ORIGINAL_ENV };
    await new Promise((resolve) => server.close(resolve));
  });

  it.each(["/admin", "/me"])(
    "serves tokens.css without a session and without no-store on %s",
    async (surface) => {
      const { version } = loadDesignAssets();
      const res = await fetch(
        `${baseUrl}${surface}/_assets/tokens.css?v=${version}`,
      );
      expect(res.status).toBe(200);
      expect(res.headers.get("content-type")).toContain("text/css");
      expect(res.headers.get("cache-control")).toBe(
        "public, max-age=31536000, immutable",
      );
      expect(res.headers.get("x-content-type-options")).toBe("nosniff");
      expect(res.headers.get("set-cookie")).toBeNull();
      const body = await res.text();
      expect(body).toContain("--bg: #0f1115;");
      expect(body).toContain("--type-page-title-size: 1.5rem;");
    },
  );

  it("serves kb.css and revalidates when the version is missing or stale", async () => {
    const res = await fetch(`${baseUrl}/admin/_assets/kb.css?v=stale`);
    expect(res.status).toBe(200);
    expect(res.headers.get("cache-control")).toBe("no-cache");
    expect(await res.text()).toContain(".kb-btn");
  });

  it.each([
    "/admin/_assets/tokens.json",
    "/admin/_assets/..%2f..%2fpackage.json",
    "/admin/_assets/%2e%2e%2fCLAUDE.md",
    "/admin/_assets/__proto__",
    "/admin/_assets/constructor",
    "/me/_assets/kb.css/extra",
  ])("never serves anything outside the two known files: %s", async (p) => {
    const res = await fetch(`${baseUrl}${p}`, { redirect: "manual" });
    expect(res.status).not.toBe(200);
  });
});
