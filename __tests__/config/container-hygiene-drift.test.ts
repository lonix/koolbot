import { describe, it, expect } from "@jest/globals";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { join } from "node:path";

/**
 * Guards the container and repo hygiene settings from #1154 so they cannot
 * regress silently: no published port bound to all interfaces in the shipped
 * compose files and setup docs, root-owned (non-writable) app code in the
 * image, a read-only compose root filesystem, and `.env.*` kept out of git.
 */

const REPO_ROOT = fileURLToPath(new URL("../../", import.meta.url));
const read = (file: string): string =>
  readFileSync(join(REPO_ROOT, file), "utf8");

describe("container and repo hygiene (#1154)", () => {
  it("docker-compose.yml publishes the bot port on loopback only", () => {
    const compose = read("docker-compose.yml");
    expect(compose).toContain('"127.0.0.1:3000:3000"');
    expect(compose).not.toMatch(/^\s*-\s*"?3000:3000"?\s*$/m);
  });

  it("docker-compose.yml uses a read-only root filesystem with tmpfs /tmp", () => {
    const compose = read("docker-compose.yml");
    expect(compose).toMatch(/^\s+read_only:\s*true\s*$/m);
    expect(compose).toMatch(/^\s+tmpfs:\s*\n\s+-\s*\/tmp\s*$/m);
  });

  it("no setup doc or script publishes MongoDB on all interfaces", () => {
    for (const file of [
      "CONTRIBUTING.md",
      "README.md",
      "TESTING.md",
      "docker-compose.yml",
      "docker-compose.dev.yml",
    ]) {
      const text = read(file);
      expect(text).not.toMatch(/-p\s+27017:27017/);
      expect(text).not.toMatch(/^\s*-\s*"?27017:27017"?\s*$/m);
    }
  });

  it("the production Dockerfile does not hand app code to the runtime user", () => {
    const dockerfile = read("Dockerfile");
    const copies = dockerfile
      .split("\n")
      .filter((line) => line.startsWith("COPY --from="));
    expect(copies.length).toBeGreaterThan(0);
    for (const line of copies) {
      expect(line).not.toContain("--chown");
    }
    expect(dockerfile).toMatch(/^USER 1000:1000$/m);
  });

  it(".gitignore covers .env.* but keeps .env.example tracked", () => {
    const lines = read(".gitignore")
      .split("\n")
      .map((l) => l.trim());
    expect(lines).toContain(".env");
    expect(lines).toContain(".env.*");
    expect(lines).toContain("!.env.example");
    expect(lines.indexOf("!.env.example")).toBeGreaterThan(
      lines.indexOf(".env.*"),
    );
  });
});
