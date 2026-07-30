import { mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { loadConfig } from "./config.js";
import { tryAcquireRunLock } from "./lock.js";
import { ReconciliationEngine } from "./reconcile.js";
import { createSdkWorkspaces } from "./sdk-adapter.js";
import { SyncState } from "./state.js";
import { logError, logEvent } from "./log.js";

function configPathFromArgs(): string {
  const index = process.argv.indexOf("--config");
  return resolve(process.cwd(), index >= 0 ? process.argv[index + 1] : "config.toml");
}

function forceFromArgs(): boolean {
  return process.argv.includes("--force");
}

async function main(): Promise<void> {
  const configPath = configPathFromArgs();
  logEvent("sync_starting", { configPath, force: forceFromArgs() });
  const config = await loadConfig(configPath);
  logEvent("config_loaded", {
    personalWorkspace: config.personal.name,
    externalWorkspaces: config.external.map((workspace) => workspace.name),
    pollIntervalSeconds: config.pollIntervalSeconds,
  });
  mkdirSync(dirname(config.databasePath), { recursive: true });
  const lock = tryAcquireRunLock(`${config.databasePath}.lock`);
  if (!lock) {
    logEvent("sync_skipped", { reason: "run_already_active" });
    return;
  }
  logEvent("run_lock_acquired");
  const state = new SyncState(config.databasePath);
  logEvent("state_opened", { databasePath: config.databasePath });
  try {
    const initial = !state.isInitialized();
    const lastRunAt = state.lastRunAt();
    if (!forceFromArgs() && !initial && lastRunAt !== undefined
      && Date.now() - lastRunAt < config.pollIntervalSeconds * 1000) {
      logEvent("sync_skipped", { reason: "poll_interval", pollIntervalSeconds: config.pollIntervalSeconds });
      return;
    }
    logEvent("workspace_clients_starting");
    const clients = await createSdkWorkspaces(config);
    logEvent("workspace_clients_ready", {
      personalWorkspace: clients.personal.key,
      externalWorkspaces: [...clients.externals.keys()],
    });
    logEvent("reconciliation_starting", { initial });
    const result = await new ReconciliationEngine(
      config,
      clients.personal,
      clients.externals,
      state,
    ).run(initial);
    state.markRunCompleted();
    logEvent("sync_completed", { initial, ...result });
  } finally {
    logEvent("sync_shutdown");
    state.close();
    lock.release();
    logEvent("run_lock_released");
  }
}

main().catch((error: unknown) => {
  logError("sync_failed", error);
  console.error(error);
  process.exitCode = 1;
});
