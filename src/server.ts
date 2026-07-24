import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { decodeJwt } from "./auth/jwt.js";
import { type Seed, TokenManager } from "./auth/token-manager.js";
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

export function resolveWeightUnit(config: Config, snapshot: Snapshot, userId: string): WeightUnit {
  if (config.weightUnitOverride) return config.weightUnitOverride;
  const wu = (snapshot.preferences as any)?.weightUnit;
  const pref = typeof wu === "string" ? wu : wu?.[userId];
  return pref === "KILOGRAMS" ? "KILOGRAMS" : "POUNDS";
}

/**
 * Resolve the account identity for this run. token.json (written by
 * `strong-mcp login`, and holding the rotated refresh token) is the source of
 * truth; the env token seed is a one-time bootstrap; otherwise fail loudly.
 */
async function resolveIdentity(
  tokenStore: TokenStore,
  config: Config,
): Promise<{ userId: string; deviceId: string; seed?: Seed }> {
  const stored = await tokenStore.read();
  if (stored) {
    return { userId: stored.userId, deviceId: stored.deviceId };
  }
  if (config.seed) {
    const { userId } = decodeJwt(config.seed.accessToken);
    return {
      userId,
      deviceId: config.seed.deviceId,
      seed: { ...config.seed, userId },
    };
  }
  throw new Error(
    "No Strong credentials found. Run `strong-mcp login` to sign in, or set " +
      "STRONG_ACCESS_TOKEN / STRONG_REFRESH_TOKEN / STRONG_DEVICE_ID.",
  );
}

export async function buildServer(
  config: Config,
  fetchImpl: FetchLike,
  now: () => number = () => Date.now(),
): Promise<{ server: McpServer; sync: () => Promise<{ pages: number }> }> {
  const tokenStore = new TokenStore(config.dataDir);
  const { userId, seed } = await resolveIdentity(tokenStore, config);

  const tokenManager = new TokenManager({
    store: tokenStore,
    refreshFn: buildRefreshFn(fetchImpl, config.proxyUrl),
    now,
    seed,
  });
  const http = new StrongHttpClient({ tokenManager, fetchImpl, proxyUrl: config.proxyUrl });
  const snapshotStore = new SnapshotStore(config.dataDir, userId);
  const engine = new SyncEngine({ http, store: snapshotStore, userId });

  let snapshot = await snapshotStore.load();
  const service = new ReadService({
    getSnapshot: () => snapshot,
    getWeightUnit: () => resolveWeightUnit(config, snapshot, userId),
    userId,
  });

  const sync = async () => {
    const { pages, snapshot: fresh } = await engine.sync();
    snapshot = fresh; // swap in-memory snapshot for the service
    return { pages };
  };

  const writeEngine = new WriteEngine({
    userId,
    refresh: async () => {
      await sync(); // delta-sync; swaps the in-memory `snapshot`
      return snapshot;
    },
    put: (envelope) => http.putUserDoc(userId, envelope),
    persist: (s) => snapshotStore.save(s),
  });
  const writeService = new WriteService({
    engine: writeEngine,
    getWeightUnit: () => resolveWeightUnit(config, snapshot, userId),
    clock: makeClock(now),
    userId,
    // Read-only: returns pristine server truth for post-write verification
    // WITHOUT swapping the shared in-memory `snapshot` or persisting. Swapping
    // here would race the serialized write queue's own snapshot management
    // (the verify runs after engine.write resolves, outside the queue).
    resync: async () => {
      const { snapshot: fresh } = await engine.resync();
      return fresh;
    },
  });

  const server = new McpServer({ name: "strong-mcp", version: "0.1.0" });
  registerReadTools(server, { service, sync });
  registerWriteTools(server, writeService);
  return { server, sync };
}
