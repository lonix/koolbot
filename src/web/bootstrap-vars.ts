/**
 * Single source of truth for the environment / bootstrap variables consumed
 * at process start (not via the `Config` DB collection).
 *
 * Two consumers share this list:
 *   - `read-only-routes.ts` renders the admin Bootstrap page from it.
 *   - `write-routes.ts` rejects these keys in YAML import/export (see
 *     `PROTECTED_KEYS`), since the DB row would have no effect and could
 *     mask the real value held in `process.env`.
 *
 * Adding a new env var here automatically protects it from YAML import.
 */

export interface BootstrapEnvVar {
  key: string;
  category: "Discord" | "Database" | "Process" | "WebUI";
  isSecret: boolean;
}

export const BOOTSTRAP_VARS: readonly BootstrapEnvVar[] = [
  { key: "DISCORD_TOKEN", category: "Discord", isSecret: true },
  { key: "CLIENT_ID", category: "Discord", isSecret: false },
  { key: "GUILD_ID", category: "Discord", isSecret: false },
  { key: "MONGODB_URI", category: "Database", isSecret: true },
  { key: "NODE_ENV", category: "Process", isSecret: false },
  { key: "DEBUG", category: "Process", isSecret: false },
  { key: "WEBUI_ENABLED", category: "WebUI", isSecret: false },
  { key: "WEBUI_BASE_URL", category: "WebUI", isSecret: false },
  { key: "WEBUI_SESSION_SECRET", category: "WebUI", isSecret: true },
  { key: "WEBUI_SESSION_TTL_MINUTES", category: "WebUI", isSecret: false },
  { key: "WEBUI_SESSION_LIFETIME_HOURS", category: "WebUI", isSecret: false },
  {
    key: "WEBUI_INACTIVITY_TIMEOUT_MINUTES",
    category: "WebUI",
    isSecret: false,
  },
  { key: "WEBUI_TRUST_PROXY", category: "WebUI", isSecret: false },
];

export const PROTECTED_KEYS: ReadonlySet<string> = new Set(
  BOOTSTRAP_VARS.map((v) => v.key),
);
