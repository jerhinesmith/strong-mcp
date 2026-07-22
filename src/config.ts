import { z } from "zod";
import { homedir } from "node:os";
import { join } from "node:path";
import { decodeJwt } from "./auth/jwt.js";
import type { WeightUnit } from "./units.js";

const Env = z.object({
  STRONG_ACCESS_TOKEN: z.string().min(1, "STRONG_ACCESS_TOKEN is required"),
  STRONG_REFRESH_TOKEN: z.string().min(1, "STRONG_REFRESH_TOKEN is required"),
  STRONG_DEVICE_ID: z.string().min(1, "STRONG_DEVICE_ID is required"),
  STRONG_DATA_DIR: z.preprocess((v) => (v === "" ? undefined : v), z.string().optional()),
  STRONG_PROXY_URL: z.preprocess((v) => (v === "" ? undefined : v), z.string().url().optional()),
  STRONG_WEIGHT_UNIT: z.preprocess((v) => (v === "" ? undefined : v), z.enum(["POUNDS", "KILOGRAMS"]).optional()),
  HOME: z.string().optional(),
});

export interface Config {
  accessToken: string;
  refreshToken: string;
  deviceId: string;
  userId: string;
  dataDir: string;
  proxyUrl?: string;
  weightUnitOverride?: WeightUnit;
}

export function loadConfig(env: NodeJS.ProcessEnv): Config {
  const parsed = Env.safeParse(env);
  if (!parsed.success) {
    const msgs = parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; ");
    throw new Error(`Invalid configuration: ${msgs}`);
  }
  const e = parsed.data;
  const { userId } = decodeJwt(e.STRONG_ACCESS_TOKEN);
  const dataDir = e.STRONG_DATA_DIR ?? join(e.HOME ?? homedir(), ".strong-mcp");
  return {
    accessToken: e.STRONG_ACCESS_TOKEN,
    refreshToken: e.STRONG_REFRESH_TOKEN,
    deviceId: e.STRONG_DEVICE_ID,
    userId,
    dataDir,
    proxyUrl: e.STRONG_PROXY_URL,
    weightUnitOverride: e.STRONG_WEIGHT_UNIT,
  };
}
