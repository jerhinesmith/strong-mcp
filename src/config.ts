import { homedir } from "node:os";
import { join } from "node:path";
import { z } from "zod";
import type { WeightUnit } from "./units.js";

const emptyToUndefined = (v: unknown) => (v === "" ? undefined : v);

const Env = z.object({
  // All token env vars are optional: the primary credential path is `strong-mcp
  // login`, which writes token.json. These remain as an optional bootstrap seed
  // (captured token pair) so existing setups keep working.
  STRONG_ACCESS_TOKEN: z.preprocess(emptyToUndefined, z.string().optional()),
  STRONG_REFRESH_TOKEN: z.preprocess(emptyToUndefined, z.string().optional()),
  STRONG_DEVICE_ID: z.preprocess(emptyToUndefined, z.string().optional()),
  STRONG_DATA_DIR: z.preprocess(emptyToUndefined, z.string().optional()),
  STRONG_PROXY_URL: z.preprocess(emptyToUndefined, z.string().url().optional()),
  STRONG_WEIGHT_UNIT: z.preprocess(emptyToUndefined, z.enum(["POUNDS", "KILOGRAMS"]).optional()),
  HOME: z.string().optional(),
});

/**
 * A captured token pair supplied via env, used as a one-time bootstrap when no
 * token.json exists yet. All three fields must be present together to be usable.
 */
export interface TokenSeed {
  accessToken: string;
  refreshToken: string;
  deviceId: string;
}

export interface Config {
  dataDir: string;
  proxyUrl?: string;
  weightUnitOverride?: WeightUnit;
  /** Optional env bootstrap; identity/userId is resolved at server startup. */
  seed?: TokenSeed;
}

export function loadConfig(env: NodeJS.ProcessEnv): Config {
  const parsed = Env.safeParse(env);
  if (!parsed.success) {
    const msgs = parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; ");
    throw new Error(`Invalid configuration: ${msgs}`);
  }
  const e = parsed.data;
  const dataDir = e.STRONG_DATA_DIR ?? join(e.HOME ?? homedir(), ".strong-mcp");

  // A seed is only usable if all three fields are present; a partial seed is ignored.
  const seed =
    e.STRONG_ACCESS_TOKEN && e.STRONG_REFRESH_TOKEN && e.STRONG_DEVICE_ID
      ? {
          accessToken: e.STRONG_ACCESS_TOKEN,
          refreshToken: e.STRONG_REFRESH_TOKEN,
          deviceId: e.STRONG_DEVICE_ID,
        }
      : undefined;

  return {
    dataDir,
    proxyUrl: e.STRONG_PROXY_URL,
    weightUnitOverride: e.STRONG_WEIGHT_UNIT,
    seed,
  };
}
