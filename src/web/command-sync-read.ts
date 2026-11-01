/**
 * Read the slash-command check for a page that must not wait on Discord (#1638).
 * The check itself is cached and read-only (`CommandManager.checkCommandSync`);
 * this adds the Dashboard's per-source time limit and turns any failure into
 * `null`, which every caller words as "Not checked", never as "in sync".
 */

import type { Client } from "discord.js";
import {
  CommandManager,
  type CommandSyncReport,
} from "../services/command-manager.js";
import { DASHBOARD_SOURCE_TIMEOUT_MS, withTimeout } from "./dashboard-data.js";

export async function readCommandSync(
  client: Client,
  ms: number = DASHBOARD_SOURCE_TIMEOUT_MS,
): Promise<CommandSyncReport | null> {
  try {
    return await withTimeout(
      CommandManager.getInstance(client).checkCommandSync(),
      ms,
    );
  } catch {
    return null;
  }
}

/** Forget the cached check, then read it again. Never throws. */
export async function rereadCommandSync(
  client: Client,
  ms: number = DASHBOARD_SOURCE_TIMEOUT_MS,
): Promise<CommandSyncReport | null> {
  try {
    CommandManager.getInstance(client).invalidateCommandSync();
  } catch {
    return null;
  }
  return readCommandSync(client, ms);
}
