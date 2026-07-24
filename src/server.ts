import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { TokenManager } from "./auth/token-manager.js";
import { TokenStore } from "./auth/token-store.js";
import type { Config } from "./config.js";
import { buildRefreshFn, type FetchLike, StrongHttpClient } from "./http/client.js";
import { ReadService } from "./services/read-service.js";
import { WriteService } from "./services/write-service.js";
import { SnapshotStore } from "./sync/snapshot-store.js";
import { SyncEngine } from "./sync/sync-engine.js";
import { registerReadTools } from "./tools/read-tools.js";
import { registerWriteTools } from "./tools/write-tools.js";
import type { Snapshot } from "./types.js";
import type { WeightUnit } from "./units.js";
import { makeClock } from "./write/ids.js";
import { WriteEngine } from "./write/write-engine.js";

export function resolveWeightUnit(config: Config, snapshot: Snapshot): WeightUnit {
  if (config.weightUnitOverride) return config.weightUnitOverride;
  const wu = (snapshot.preferences as any)?.weightUnit;
  const pref = typeof wu === "string" ? wu : wu?.[config.userId];
  return pref === "KILOGRAMS" ? "KILOGRAMS" : "POUNDS";
}

export async function buildServer(
  config: Config,
  fetchImpl: FetchLike,
  now: () => number = () => Date.now(),
): Promise<{ server: McpServer; sync: () => Promise<{ pages: number }> }> {
  const tokenStore = new TokenStore(config.dataDir);
  const tokenManager = new TokenManager({
    store: tokenStore,
    refreshFn: buildRefreshFn(fetchImpl, config.proxyUrl),
    now,
    seed: {
      accessToken: config.accessToken,
      refreshToken: config.refreshToken,
      deviceId: config.deviceId,
      userId: config.userId,
    },
  });
  const http = new StrongHttpClient({ tokenManager, fetchImpl, proxyUrl: config.proxyUrl });
  const snapshotStore = new SnapshotStore(config.dataDir, config.userId);
  const engine = new SyncEngine({ http, store: snapshotStore, userId: config.userId });

  let snapshot = await snapshotStore.load();
  const service = new ReadService({
    getSnapshot: () => snapshot,
    getWeightUnit: () => resolveWeightUnit(config, snapshot),
    userId: config.userId,
  });

  const sync = async () => {
    const { pages, snapshot: fresh } = await engine.sync();
    snapshot = fresh; // swap in-memory snapshot for the service
    return { pages };
  };

  const writeEngine = new WriteEngine({
    userId: config.userId,
    refresh: async () => {
      await sync(); // delta-sync; swaps the in-memory `snapshot`
      return snapshot;
    },
    put: (envelope) => http.putUserDoc(config.userId, envelope),
    persist: (s) => snapshotStore.save(s),
  });
  const writeService = new WriteService({
    engine: writeEngine,
    getWeightUnit: () => resolveWeightUnit(config, snapshot),
    clock: makeClock(now),
    userId: config.userId,
  });

  const server = new McpServer({ name: "strong-mcp", version: "0.1.0" });
  registerReadTools(server, { service, sync });
  registerWriteTools(server, writeService);
  return { server, sync };
}
