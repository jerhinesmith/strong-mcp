import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { Config } from "./config.js";
import { TokenStore } from "./auth/token-store.js";
import { TokenManager } from "./auth/token-manager.js";
import { StrongHttpClient, buildRefreshFn, type FetchLike } from "./http/client.js";
import { SnapshotStore } from "./sync/snapshot-store.js";
import { SyncEngine } from "./sync/sync-engine.js";
import { ReadService } from "./services/read-service.js";
import { registerReadTools } from "./tools/read-tools.js";
import type { Snapshot } from "./types.js";
import type { WeightUnit } from "./units.js";

function resolveWeightUnit(config: Config, snapshot: Snapshot): WeightUnit {
  if (config.weightUnitOverride) return config.weightUnitOverride;
  const pref = (snapshot.preferences as any)?.weightUnit?.[config.userId];
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

  const server = new McpServer({ name: "strong-mcp", version: "0.1.0" });
  registerReadTools(server, { service, sync });
  return { server, sync };
}
