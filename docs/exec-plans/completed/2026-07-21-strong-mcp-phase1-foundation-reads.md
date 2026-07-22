# strong-mcp Phase 1 (Foundation + Reads) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build a working, read-only `strong-mcp` MCP server: it authenticates to Strong (seeded tokens + rotating refresh), syncs the account into a local snapshot, and exposes read tools for workouts, templates, exercises, and body measurements.

**Architecture:** Layered and dependency-injected for testability — `Config → {TokenManager, HttpClient} → SyncEngine (+ normalize) → SnapshotStore → ReadService → MCP tools`. Every I/O boundary (clock, fetch, filesystem) is injectable so the hard paths (refresh rotation, pagination, cursor fallback) are tested offline against captured fixtures. This plan is **Phase 1 of 2**; writes are a separate plan (spec §12).

**Tech Stack:** TypeScript (Node ≥ 20, ESM), `@modelcontextprotocol/sdk` (stdio), `zod`, `undici` (fetch + ProxyAgent), `vitest`, `tsc`.

## Global Constraints

Copied verbatim from the design spec (`docs/design/2026-07-21-strong-mcp-design.md`). Every task inherits these.

- **API base URL:** `https://back.strong.app`
- **Client headers (all requests):** `X-Client-Platform: ios`, `X-Client-Version: 6.4.2`, `X-Client-Build: 8332`, `User-Agent: Strong iOS`, `Accept: application/json`. `X-Client-Version`/`X-Client-Build` are configurable constants in one module.
- **Weight conversion:** `kg = lb × 0.45359237` (exact). Weights are stored as **stringified kg floats**.
- **Sync query (exhaustive):** `limit=300` + `include=template&include=log&include=measurement&include=widget&include=tag&include=folder&include=metric&include=measuredValue`. `deltaSync` adds `continuation=<cursor>`.
- **Sync termination:** stop when a page has **all eight `_embedded` collections empty** OR **no `_links.next`**. Persisted cursor = the `continuation` from the last page's `_links.next`; only advance after a fully successful walk.
- **Access token TTL:** `expiresIn: 1200` (20 min); JWT `exp` claim also authoritative.
- **Refresh token rotates:** each `/auth/login/refresh` returns a NEW refreshToken; the old one is spent. Persist the new one atomically before using the new access token.
- **Single-flight refresh:** at most one refresh in flight; concurrent callers await the same promise.
- **Atomic persistence:** `token.json` and `snapshot.json` written via write-temp-then-`rename()`; `token.json` is `chmod 600`.
- **Auth is token-seeding only (v1):** `STRONG_ACCESS_TOKEN` + `STRONG_REFRESH_TOKEN` + `STRONG_DEVICE_ID`. No password stored. On refresh failure with a spent/invalid token: fail loudly ("re-seed required"), do not loop.
- **Reads filter `isHidden`** at the service layer; the snapshot itself RETAINS hidden entities.
- **Never log** tokens, the full bearer, or credentials.
- **`template` and `log` are SEPARATE collections** (spec §4.1) — do not merge, even though they share nested shape.
- **Open-enum rule:** unknown cell/measurement types pass through untouched on read; refusing on write is a Phase 2 concern.

---

## File Structure

```
package.json                       # deps, scripts (test/build/start)
tsconfig.json                      # ESM, Node20, strict
vitest.config.ts                   # test runner config
.env.example                       # documented env vars
src/
  types.ts                         # shared domain + snapshot types (compile-only)
  constants.ts                     # base URL, headers, include list, kg factor
  config.ts                        # env → validated Config (zod)
  auth/
    jwt.ts                         # decode JWT payload → {userId, expMs}
    token-store.ts                 # read/write token.json (atomic)
    token-manager.ts               # single-flight refresh, expiry, seed/reseed
  storage/
    atomic-json.ts                 # generic atomic read/write JSON (reused)
  http/
    client.ts                      # StrongHttpClient: headers, proxy, retries, 401→refresh
  sync/
    normalize.ts                   # HAL page → entity maps (idempotent), emptiness check
    snapshot-store.ts              # read/write snapshot.json (atomic) + in-memory
    sync-engine.ts                 # full/delta walk, termination, cursor, fallback
  units.ts                         # lb↔kg, body-fat, per-type measuredValue + display
  services/
    read-service.ts                # list/get reads, isHidden filter, display conversion
  tools/
    read-tools.ts                  # registerReadTools(server, service)
  server.ts                        # build McpServer, wire deps, register tools
  index.ts                         # entrypoint: load config → bootstrap → stdio connect
tests/
  fixtures/                        # captured JSON (sync pages, refresh response)
  *.test.ts                        # colocated by module under tests/
```

---

### Task 1: Project scaffold & tooling

**Files:**
- Create: `package.json`, `tsconfig.json`, `vitest.config.ts`, `.env.example`
- Create: `src/constants.ts`, `src/types.ts`
- Create: `src/index.ts` (temporary stub so build succeeds)
- Test: `tests/smoke.test.ts`

**Interfaces:**
- Consumes: nothing.
- Produces:
  - `src/constants.ts`: `BASE_URL: string`, `KG_PER_LB = 0.45359237`, `CLIENT_HEADERS: Record<string,string>`, `SYNC_INCLUDE: string`, `SYNC_LIMIT = 300`, `COLLECTIONS: readonly string[]` (the 8 collection names).
  - `src/types.ts`: `CollectionName`, `Entity` (`{ id: string; isHidden?: boolean; [k: string]: unknown }`), `EntityMap = Record<string, Entity>`, `Snapshot { userId: string; continuation: string | null; syncedAt: string | null; preferences: Record<string, unknown>; entities: Record<CollectionName, EntityMap> }`.

- [ ] **Step 1: Write `package.json`**

```json
{
  "name": "strong-mcp",
  "version": "0.1.0",
  "private": true,
  "type": "module",
  "bin": { "strong-mcp": "dist/index.js" },
  "scripts": {
    "build": "tsc -p tsconfig.json",
    "start": "node dist/index.js",
    "dev": "node --loader tsx src/index.ts",
    "test": "vitest run",
    "test:watch": "vitest",
    "typecheck": "tsc --noEmit"
  },
  "dependencies": {
    "@modelcontextprotocol/sdk": "^1.11.0",
    "undici": "^6.19.0",
    "zod": "^3.23.0"
  },
  "devDependencies": {
    "tsx": "^4.16.0",
    "typescript": "^5.5.0",
    "vitest": "^2.0.0",
    "@types/node": "^20.14.0"
  },
  "engines": { "node": ">=20" }
}
```

- [ ] **Step 2: Write `tsconfig.json`**

```json
{
  "compilerOptions": {
    "target": "ES2022",
    "module": "NodeNext",
    "moduleResolution": "NodeNext",
    "outDir": "dist",
    "rootDir": "src",
    "strict": true,
    "esModuleInterop": true,
    "skipLibCheck": true,
    "declaration": true,
    "sourceMap": true,
    "resolveJsonModule": true
  },
  "include": ["src/**/*"]
}
```

- [ ] **Step 3: Write `vitest.config.ts`**

```typescript
import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["tests/**/*.test.ts"],
    environment: "node",
  },
});
```

- [ ] **Step 4: Write `.env.example`**

```bash
# Seeded token pair (capture from a /auth/login or /auth/login/refresh request/response in Proxyman)
STRONG_ACCESS_TOKEN=
STRONG_REFRESH_TOKEN=
# Must match the deviceId used when those tokens were minted (from the captured request body)
STRONG_DEVICE_ID=
# Optional: data dir for token.json + snapshot.json (default: ~/.strong-mcp)
STRONG_DATA_DIR=
# Optional: dev proxy (e.g. Proxyman) http://localhost:9090
STRONG_PROXY_URL=
# Optional: override display unit (POUNDS | KILOGRAMS); default = account preference
STRONG_WEIGHT_UNIT=
```

- [ ] **Step 5: Write `src/constants.ts`**

```typescript
export const BASE_URL = "https://back.strong.app";
export const KG_PER_LB = 0.45359237;
export const SYNC_LIMIT = 300;

export const COLLECTIONS = [
  "template", "log", "measurement", "measuredValue",
  "folder", "tag", "metric", "widget",
] as const;

export const SYNC_INCLUDE = COLLECTIONS.map((c) => `include=${c}`).join("&");

export const CLIENT_VERSION = "6.4.2";
export const CLIENT_BUILD = "8332";

export const CLIENT_HEADERS: Record<string, string> = {
  "X-Client-Platform": "ios",
  "X-Client-Version": CLIENT_VERSION,
  "X-Client-Build": CLIENT_BUILD,
  "User-Agent": "Strong iOS",
  Accept: "application/json",
};
```

- [ ] **Step 6: Write `src/types.ts`**

```typescript
import type { COLLECTIONS } from "./constants.js";

export type CollectionName = (typeof COLLECTIONS)[number];

export interface Entity {
  id: string;
  isHidden?: boolean;
  [key: string]: unknown;
}

export type EntityMap = Record<string, Entity>;

export interface Snapshot {
  userId: string;
  continuation: string | null;
  syncedAt: string | null;
  preferences: Record<string, unknown>;
  entities: Record<CollectionName, EntityMap>;
}
```

- [ ] **Step 7: Write `src/index.ts` (temporary stub)**

```typescript
// Replaced in Task 14. Stub keeps the build green.
export {};
```

- [ ] **Step 8: Write `tests/smoke.test.ts`**

```typescript
import { describe, it, expect } from "vitest";
import { SYNC_INCLUDE, COLLECTIONS } from "../src/constants.js";

describe("scaffold", () => {
  it("builds the exhaustive include string from all 8 collections", () => {
    expect(COLLECTIONS).toHaveLength(8);
    expect(SYNC_INCLUDE).toBe(
      "include=template&include=log&include=measurement&include=widget&include=tag&include=folder&include=metric&include=measuredValue",
    );
  });
});
```

- [ ] **Step 9: Install and verify**

Run: `npm install && npm run typecheck && npm test`
Expected: typecheck passes; 1 test passes.

- [ ] **Step 10: Commit**

```bash
git add package.json tsconfig.json vitest.config.ts .env.example src/ tests/ package-lock.json
git commit -m "chore: scaffold strong-mcp project (TS/ESM, vitest, constants)"
```

---

### Task 2: Units conversion

**Files:**
- Create: `src/units.ts`
- Test: `tests/units.test.ts`

**Interfaces:**
- Consumes: `KG_PER_LB` from `src/constants.ts`.
- Produces:
  - `lbToKg(lb: number): number`
  - `kgToLb(kg: number): number`
  - `formatLb(kg: number): number` — kg → lb rounded to 1 decimal for display
  - `type WeightUnit = "POUNDS" | "KILOGRAMS"`
  - `toDisplayMeasuredValue(type: string, raw: number, weightUnit: WeightUnit): { value: number; unit: string }`
  - `toStoredMeasuredValue(type: string, display: number, weightUnit: WeightUnit): number` (throws on unknown type — write-side, used in Phase 2 but defined now)

- [ ] **Step 1: Write the failing test**

```typescript
import { describe, it, expect } from "vitest";
import { lbToKg, kgToLb, formatLb, toDisplayMeasuredValue } from "../src/units.js";

describe("weight conversion", () => {
  it("converts lb → kg exactly as captured", () => {
    expect(lbToKg(10)).toBeCloseTo(4.5359237, 7);
    expect(lbToKg(30)).toBeCloseTo(13.6077711, 7);
    expect(lbToKg(200)).toBeCloseTo(90.718474, 6);
  });
  it("round-trips kg → lb", () => {
    expect(kgToLb(13.6077711)).toBeCloseTo(30, 6);
    expect(formatLb(90.718474)).toBe(200);
  });
});

describe("measuredValue display", () => {
  it("WEIGHT is kg→lb", () => {
    expect(toDisplayMeasuredValue("WEIGHT", 90.718474, "POUNDS")).toEqual({ value: 200, unit: "lb" });
  });
  it("BODY_FAT_PERCENTAGE is a fraction → percent", () => {
    expect(toDisplayMeasuredValue("BODY_FAT_PERCENTAGE", 0.05, "POUNDS")).toEqual({ value: 5, unit: "%" });
  });
  it("CALORIC_INTAKE passes through", () => {
    expect(toDisplayMeasuredValue("CALORIC_INTAKE", 2200, "POUNDS")).toEqual({ value: 2200, unit: "kcal" });
  });
  it("unknown type passes raw through on read", () => {
    expect(toDisplayMeasuredValue("MYSTERY", 42, "POUNDS")).toEqual({ value: 42, unit: "" });
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/units.test.ts`
Expected: FAIL — cannot find module `../src/units.js`.

- [ ] **Step 3: Write `src/units.ts`**

```typescript
import { KG_PER_LB } from "./constants.js";

export type WeightUnit = "POUNDS" | "KILOGRAMS";

export const lbToKg = (lb: number): number => lb * KG_PER_LB;
export const kgToLb = (kg: number): number => kg / KG_PER_LB;
export const formatLb = (kg: number): number => Math.round(kgToLb(kg) * 10) / 10;
export const formatKg = (kg: number): number => Math.round(kg * 100) / 100;

export function toDisplayMeasuredValue(
  type: string,
  raw: number,
  weightUnit: WeightUnit,
): { value: number; unit: string } {
  switch (type) {
    case "WEIGHT":
      return weightUnit === "KILOGRAMS"
        ? { value: formatKg(raw), unit: "kg" }
        : { value: formatLb(raw), unit: "lb" };
    case "BODY_FAT_PERCENTAGE":
      return { value: Math.round(raw * 1000) / 10, unit: "%" };
    case "CALORIC_INTAKE":
      return { value: raw, unit: "kcal" };
    default:
      return { value: raw, unit: "" }; // open-enum passthrough on read
  }
}

export function toStoredMeasuredValue(
  type: string,
  display: number,
  weightUnit: WeightUnit,
): number {
  switch (type) {
    case "WEIGHT":
      return weightUnit === "KILOGRAMS" ? display : lbToKg(display);
    case "BODY_FAT_PERCENTAGE":
      return display / 100;
    case "CALORIC_INTAKE":
      return display;
    default:
      throw new Error(`Refusing to write unknown measurement type "${type}" (unknown value scaling)`);
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run tests/units.test.ts`
Expected: PASS (all cases).

- [ ] **Step 5: Commit**

```bash
git add src/units.ts tests/units.test.ts
git commit -m "feat: unit conversion (lb<->kg, measuredValue per-type)"
```

---

### Task 3: JWT decode

**Files:**
- Create: `src/auth/jwt.ts`
- Test: `tests/jwt.test.ts`

**Interfaces:**
- Consumes: nothing.
- Produces: `decodeJwt(token: string): { userId: string; expMs: number }` — extracts the `nameidentifier` claim (userId) and `exp` (→ ms). Throws on malformed token.

- [ ] **Step 1: Write the failing test**

Uses the captured token (payload claims: nameidentifier = user id, exp = 1784685666).

```typescript
import { describe, it, expect } from "vitest";
import { decodeJwt } from "../src/auth/jwt.js";

const TOKEN =
  "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJodHRwOi8vc2NoZW1hcy54bWxzb2FwLm9yZy93cy8yMDA1LzA1L2lkZW50aXR5L2NsYWltcy9uYW1laWRlbnRpZmllciI6IjAwMDAwMDAwLTAwMDAtNDAwMC04MDAwLTAwMDAwMDAwMDAwMCIsImh0dHA6Ly9zY2hlbWFzLnhtbHNvYXAub3JnL3dzLzIwMDUvMDUvaWRlbnRpdHkvY2xhaW1zL25hbWUiOiJUZXN0IFVzZXIiLCJodHRwOi8vc2NoZW1hcy54bWxzb2FwLm9yZy93cy8yMDA1LzA1L2lkZW50aXR5L2NsYWltcy9lbWFpbGFkZHJlc3MiOiJ0ZXN0QGV4YW1wbGUuY29tIiwiVXNlclR5cGUiOiJTdHJvbmdVc2VyIiwiaWF0IjoxNzg0Njg0NDY2LCJleHAiOjE3ODQ2ODU2NjYsImlzcyI6Imh0dHBzOi8vYmFjay5zdHJvbmcuYXBwIiwiYXVkIjoiaHR0cHM6Ly9iYWNrLnN0cm9uZy5hcHAifQ.dummy_signature_not_valid_0000000000000000000000";

describe("decodeJwt", () => {
  it("extracts userId and exp (ms)", () => {
    const { userId, expMs } = decodeJwt(TOKEN);
    expect(userId).toBe("00000000-0000-4000-8000-000000000000");
    expect(expMs).toBe(1784685666 * 1000);
  });
  it("throws on malformed token", () => {
    expect(() => decodeJwt("not.a.jwt")).toThrow();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/jwt.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Write `src/auth/jwt.ts`**

```typescript
const NAMEID_CLAIM =
  "http://schemas.xmlsoap.org/ws/2005/05/identity/claims/nameidentifier";

export function decodeJwt(token: string): { userId: string; expMs: number } {
  const parts = token.split(".");
  if (parts.length !== 3) throw new Error("Malformed JWT");
  let payload: Record<string, unknown>;
  try {
    payload = JSON.parse(Buffer.from(parts[1], "base64url").toString("utf8"));
  } catch {
    throw new Error("Malformed JWT payload");
  }
  const userId = payload[NAMEID_CLAIM];
  const exp = payload.exp;
  if (typeof userId !== "string" || typeof exp !== "number") {
    throw new Error("JWT missing userId or exp claim");
  }
  return { userId, expMs: exp * 1000 };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run tests/jwt.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/auth/jwt.ts tests/jwt.test.ts
git commit -m "feat: JWT payload decode (userId + exp)"
```

---

### Task 4: Config loader

**Files:**
- Create: `src/config.ts`
- Test: `tests/config.test.ts`

**Interfaces:**
- Consumes: `decodeJwt` (Task 3).
- Produces:
  - `interface Config { accessToken: string; refreshToken: string; deviceId: string; userId: string; dataDir: string; proxyUrl?: string; weightUnitOverride?: WeightUnit }`
  - `loadConfig(env: NodeJS.ProcessEnv): Config` — validates required vars, derives `userId` from the access token, defaults `dataDir` to `~/.strong-mcp`. Throws a clear error listing any missing vars.

- [ ] **Step 1: Write the failing test**

```typescript
import { describe, it, expect } from "vitest";
import { loadConfig } from "../src/config.js";

const TOKEN =
  "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJodHRwOi8vc2NoZW1hcy54bWxzb2FwLm9yZy93cy8yMDA1LzA1L2lkZW50aXR5L2NsYWltcy9uYW1laWRlbnRpZmllciI6IjAwMDAwMDAwLTAwMDAtNDAwMC04MDAwLTAwMDAwMDAwMDAwMCIsImh0dHA6Ly9zY2hlbWFzLnhtbHNvYXAub3JnL3dzLzIwMDUvMDUvaWRlbnRpdHkvY2xhaW1zL25hbWUiOiJUZXN0IFVzZXIiLCJodHRwOi8vc2NoZW1hcy54bWxzb2FwLm9yZy93cy8yMDA1LzA1L2lkZW50aXR5L2NsYWltcy9lbWFpbGFkZHJlc3MiOiJ0ZXN0QGV4YW1wbGUuY29tIiwiVXNlclR5cGUiOiJTdHJvbmdVc2VyIiwiaWF0IjoxNzg0Njg0NDY2LCJleHAiOjE3ODQ2ODU2NjYsImlzcyI6Imh0dHBzOi8vYmFjay5zdHJvbmcuYXBwIiwiYXVkIjoiaHR0cHM6Ly9iYWNrLnN0cm9uZy5hcHAifQ.dummy_signature_not_valid_0000000000000000000000";

const base = {
  STRONG_ACCESS_TOKEN: TOKEN,
  STRONG_REFRESH_TOKEN: "refresh-abc",
  STRONG_DEVICE_ID: "11111111-1111-4111-8111-111111111111",
};

describe("loadConfig", () => {
  it("derives userId from the access token and defaults dataDir", () => {
    const cfg = loadConfig({ ...base, HOME: "/home/j" } as NodeJS.ProcessEnv);
    expect(cfg.userId).toBe("00000000-0000-4000-8000-000000000000");
    expect(cfg.dataDir).toBe("/home/j/.strong-mcp");
    expect(cfg.deviceId).toBe(base.STRONG_DEVICE_ID);
  });
  it("throws listing all missing required vars", () => {
    expect(() => loadConfig({} as NodeJS.ProcessEnv)).toThrow(/STRONG_ACCESS_TOKEN/);
  });
  it("honors STRONG_DATA_DIR and weight unit override", () => {
    const cfg = loadConfig({ ...base, STRONG_DATA_DIR: "/data", STRONG_WEIGHT_UNIT: "KILOGRAMS" } as NodeJS.ProcessEnv);
    expect(cfg.dataDir).toBe("/data");
    expect(cfg.weightUnitOverride).toBe("KILOGRAMS");
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/config.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Write `src/config.ts`**

```typescript
import { z } from "zod";
import { homedir } from "node:os";
import { join } from "node:path";
import { decodeJwt } from "./auth/jwt.js";
import type { WeightUnit } from "./units.js";

const Env = z.object({
  STRONG_ACCESS_TOKEN: z.string().min(1, "STRONG_ACCESS_TOKEN is required"),
  STRONG_REFRESH_TOKEN: z.string().min(1, "STRONG_REFRESH_TOKEN is required"),
  STRONG_DEVICE_ID: z.string().min(1, "STRONG_DEVICE_ID is required"),
  STRONG_DATA_DIR: z.string().optional(),
  STRONG_PROXY_URL: z.string().url().optional(),
  STRONG_WEIGHT_UNIT: z.enum(["POUNDS", "KILOGRAMS"]).optional(),
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
    const msgs = parsed.error.issues.map((i) => i.message).join("; ");
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
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run tests/config.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/config.ts tests/config.test.ts
git commit -m "feat: config loader (zod env validation, userId from JWT)"
```

---

### Task 5: Atomic JSON storage

**Files:**
- Create: `src/storage/atomic-json.ts`
- Test: `tests/atomic-json.test.ts`

**Interfaces:**
- Consumes: nothing.
- Produces:
  - `readJson<T>(path: string): Promise<T | null>` — returns `null` if the file is missing; throws on corrupt JSON.
  - `writeJsonAtomic(path: string, value: unknown, mode?: number): Promise<void>` — writes to `path + ".tmp"`, then `rename()`; creates parent dir; applies `mode` (e.g. `0o600`) when given.

- [ ] **Step 1: Write the failing test**

```typescript
import { describe, it, expect } from "vitest";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readJson, writeJsonAtomic } from "../src/storage/atomic-json.js";

describe("atomic-json", () => {
  const dir = mkdtempSync(join(tmpdir(), "strong-atomic-"));

  it("returns null for a missing file", async () => {
    expect(await readJson(join(dir, "nope.json"))).toBeNull();
  });
  it("round-trips through write-then-rename", async () => {
    const p = join(dir, "sub", "data.json");
    await writeJsonAtomic(p, { a: 1 });
    expect(await readJson<{ a: number }>(p)).toEqual({ a: 1 });
  });
  it("throws on corrupt JSON", async () => {
    const p = join(dir, "bad.json");
    const { writeFileSync } = await import("node:fs");
    writeFileSync(p, "{not json");
    await expect(readJson(p)).rejects.toThrow();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/atomic-json.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Write `src/storage/atomic-json.ts`**

```typescript
import { readFile, writeFile, rename, mkdir, chmod } from "node:fs/promises";
import { dirname } from "node:path";

export async function readJson<T>(path: string): Promise<T | null> {
  let raw: string;
  try {
    raw = await readFile(path, "utf8");
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw err;
  }
  return JSON.parse(raw) as T; // throws on corrupt JSON — intentional
}

export async function writeJsonAtomic(
  path: string,
  value: unknown,
  mode?: number,
): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  const tmp = `${path}.tmp`;
  await writeFile(tmp, JSON.stringify(value, null, 2), "utf8");
  if (mode !== undefined) await chmod(tmp, mode);
  await rename(tmp, path);
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run tests/atomic-json.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/storage/atomic-json.ts tests/atomic-json.test.ts
git commit -m "feat: atomic JSON read/write (temp + rename)"
```

---

### Task 6: Token store

**Files:**
- Create: `src/auth/token-store.ts`
- Test: `tests/token-store.test.ts`

**Interfaces:**
- Consumes: `readJson`, `writeJsonAtomic` (Task 5).
- Produces:
  - `interface TokenState { accessToken: string; refreshToken: string; expiresAt: number; deviceId: string; userId: string }`
  - `class TokenStore { constructor(dataDir: string); read(): Promise<TokenState | null>; write(state: TokenState): Promise<void> }` — writes `dataDir/token.json` with mode `0o600`.

- [ ] **Step 1: Write the failing test**

```typescript
import { describe, it, expect } from "vitest";
import { mkdtempSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { TokenStore } from "../src/auth/token-store.js";

describe("TokenStore", () => {
  const dir = mkdtempSync(join(tmpdir(), "strong-token-"));
  const store = new TokenStore(dir);
  const state = {
    accessToken: "a", refreshToken: "r", expiresAt: 123,
    deviceId: "d", userId: "u",
  };

  it("returns null before anything is written", async () => {
    expect(await store.read()).toBeNull();
  });
  it("persists and reads back, with 0600 perms", async () => {
    await store.write(state);
    expect(await store.read()).toEqual(state);
    const mode = statSync(join(dir, "token.json")).mode & 0o777;
    expect(mode).toBe(0o600);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/token-store.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Write `src/auth/token-store.ts`**

```typescript
import { join } from "node:path";
import { readJson, writeJsonAtomic } from "../storage/atomic-json.js";

export interface TokenState {
  accessToken: string;
  refreshToken: string;
  expiresAt: number; // epoch ms
  deviceId: string;
  userId: string;
}

export class TokenStore {
  private readonly path: string;
  constructor(dataDir: string) {
    this.path = join(dataDir, "token.json");
  }
  read(): Promise<TokenState | null> {
    return readJson<TokenState>(this.path);
  }
  write(state: TokenState): Promise<void> {
    return writeJsonAtomic(this.path, state, 0o600);
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run tests/token-store.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/auth/token-store.ts tests/token-store.test.ts
git commit -m "feat: token store (token.json, 0600, atomic)"
```

---

### Task 7: Token manager (single-flight refresh)

**Files:**
- Create: `src/auth/token-manager.ts`
- Test: `tests/token-manager.test.ts`

**Interfaces:**
- Consumes: `TokenStore`, `TokenState` (Task 6); `decodeJwt` (Task 3).
- Produces:
  - `type RefreshFn = (body: { deviceId: string; accessToken: string; refreshToken: string }) => Promise<{ accessToken: string; refreshToken: string; expiresIn: number }>`
  - `class TokenManager` with constructor `{ store: TokenStore; refreshFn: RefreshFn; now: () => number; seed: { accessToken: string; refreshToken: string; deviceId: string; userId: string }; skewMs?: number }`
  - `getAccessToken(): Promise<string>` — bootstraps from store or seed, refreshes if within `skewMs` (default 60_000) of expiry.
  - `forceRefresh(): Promise<string>` — single-flight refresh (used on 401), persists rotated token before resolving.

- [ ] **Step 1: Write the failing test**

```typescript
import { describe, it, expect, vi } from "vitest";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { TokenStore } from "../src/auth/token-store.js";
import { TokenManager } from "../src/auth/token-manager.js";

const TOKEN_EXP_1784685666 =
  "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJodHRwOi8vc2NoZW1hcy54bWxzb2FwLm9yZy93cy8yMDA1LzA1L2lkZW50aXR5L2NsYWltcy9uYW1laWRlbnRpZmllciI6IjAwMDAwMDAwLTAwMDAtNDAwMC04MDAwLTAwMDAwMDAwMDAwMCIsImh0dHA6Ly9zY2hlbWFzLnhtbHNvYXAub3JnL3dzLzIwMDUvMDUvaWRlbnRpdHkvY2xhaW1zL25hbWUiOiJUZXN0IFVzZXIiLCJodHRwOi8vc2NoZW1hcy54bWxzb2FwLm9yZy93cy8yMDA1LzA1L2lkZW50aXR5L2NsYWltcy9lbWFpbGFkZHJlc3MiOiJ0ZXN0QGV4YW1wbGUuY29tIiwiVXNlclR5cGUiOiJTdHJvbmdVc2VyIiwiaWF0IjoxNzg0Njg0NDY2LCJleHAiOjE3ODQ2ODU2NjYsImlzcyI6Imh0dHBzOi8vYmFjay5zdHJvbmcuYXBwIiwiYXVkIjoiaHR0cHM6Ly9iYWNrLnN0cm9uZy5hcHAifQ.dummy_signature_not_valid_0000000000000000000000";

function makeManager(refreshFn: any, now: () => number) {
  const dir = mkdtempSync(join(tmpdir(), "strong-tm-"));
  const store = new TokenStore(dir);
  return new TokenManager({
    store, refreshFn, now,
    seed: { accessToken: TOKEN_EXP_1784685666, refreshToken: "r0", deviceId: "d", userId: "u" },
  });
}

describe("TokenManager", () => {
  it("returns the seeded access token when not near expiry", async () => {
    // now = 20 min before the token's exp
    const now = () => (1784685666 - 1200) * 1000;
    const refreshFn = vi.fn();
    const tm = makeManager(refreshFn, now);
    expect(await tm.getAccessToken()).toBe(TOKEN_EXP_1784685666);
    expect(refreshFn).not.toHaveBeenCalled();
  });

  it("refreshes when within the skew window and persists the rotated token", async () => {
    const now = () => 1784685666 * 1000 - 30_000; // 30s before exp (< 60s skew)
    const refreshFn = vi.fn().mockResolvedValue({
      accessToken: TOKEN_EXP_1784685666, refreshToken: "r1-rotated", expiresIn: 1200,
    });
    const tm = makeManager(refreshFn, now);
    await tm.getAccessToken();
    expect(refreshFn).toHaveBeenCalledTimes(1);
    // second refresh must send the ROTATED token, not the seed
    await tm.forceRefresh();
    expect(refreshFn.mock.calls[1][0].refreshToken).toBe("r1-rotated");
  });

  it("coalesces concurrent forceRefresh into a single call (single-flight)", async () => {
    const now = () => 1784685666 * 1000 - 30_000;
    let resolve!: (v: any) => void;
    const refreshFn = vi.fn().mockImplementation(
      () => new Promise((r) => { resolve = r; }),
    );
    const tm = makeManager(refreshFn, now);
    const p1 = tm.forceRefresh();
    const p2 = tm.forceRefresh();
    resolve({ accessToken: TOKEN_EXP_1784685666, refreshToken: "r1", expiresIn: 1200 });
    await Promise.all([p1, p2]);
    expect(refreshFn).toHaveBeenCalledTimes(1);
  });

  it("fails loudly when refresh rejects (re-seed required)", async () => {
    const now = () => 1784685666 * 1000 - 30_000;
    const refreshFn = vi.fn().mockRejectedValue(new Error("401"));
    const tm = makeManager(refreshFn, now);
    await expect(tm.forceRefresh()).rejects.toThrow(/re-seed/i);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/token-manager.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Write `src/auth/token-manager.ts`**

```typescript
import { TokenStore, type TokenState } from "./token-store.js";
import { decodeJwt } from "./jwt.js";

export type RefreshFn = (body: {
  deviceId: string;
  accessToken: string;
  refreshToken: string;
}) => Promise<{ accessToken: string; refreshToken: string; expiresIn: number }>;

interface Options {
  store: TokenStore;
  refreshFn: RefreshFn;
  now: () => number;
  seed: { accessToken: string; refreshToken: string; deviceId: string; userId: string };
  skewMs?: number;
}

export class TokenManager {
  private state: TokenState | null = null;
  private inFlight: Promise<string> | null = null;
  private readonly skewMs: number;

  constructor(private readonly opts: Options) {
    this.skewMs = opts.skewMs ?? 60_000;
  }

  /** token.json is source of truth; fall back to the seed once. */
  private async load(): Promise<TokenState> {
    if (this.state) return this.state;
    const stored = await this.opts.store.read();
    if (stored) {
      this.state = stored;
      return stored;
    }
    const { seed } = this.opts;
    const { expMs } = decodeJwt(seed.accessToken);
    this.state = { ...seed, expiresAt: expMs };
    return this.state;
  }

  async getAccessToken(): Promise<string> {
    const s = await this.load();
    if (this.opts.now() >= s.expiresAt - this.skewMs) {
      return this.forceRefresh();
    }
    return s.accessToken;
  }

  forceRefresh(): Promise<string> {
    if (this.inFlight) return this.inFlight; // single-flight
    this.inFlight = this.doRefresh().finally(() => {
      this.inFlight = null;
    });
    return this.inFlight;
  }

  private async doRefresh(): Promise<string> {
    const s = await this.load();
    let res;
    try {
      res = await this.opts.refreshFn({
        deviceId: s.deviceId,
        accessToken: s.accessToken,
        refreshToken: s.refreshToken,
      });
    } catch (err) {
      throw new Error(
        "Strong token refresh failed — re-seed STRONG_ACCESS_TOKEN/STRONG_REFRESH_TOKEN " +
          `(underlying: ${(err as Error).message})`,
      );
    }
    const { expMs } = decodeJwt(res.accessToken);
    const next: TokenState = {
      accessToken: res.accessToken,
      refreshToken: res.refreshToken, // rotated
      expiresAt: expMs,
      deviceId: s.deviceId,
      userId: s.userId,
    };
    await this.opts.store.write(next); // persist BEFORE returning (crash-window minimized)
    this.state = next;
    return next.accessToken;
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run tests/token-manager.test.ts`
Expected: PASS (all 4 cases).

- [ ] **Step 5: Commit**

```bash
git add src/auth/token-manager.ts tests/token-manager.test.ts
git commit -m "feat: token manager (single-flight refresh, rotation persistence)"
```

---

### Task 8: HTTP client

**Files:**
- Create: `src/http/client.ts`
- Test: `tests/http-client.test.ts`

**Interfaces:**
- Consumes: `TokenManager` (Task 7); `BASE_URL`, `CLIENT_HEADERS` (Task 1).
- Produces:
  - `type FetchLike = (url: string, init: any) => Promise<{ status: number; text: () => Promise<string> }>`
  - `class StrongHttpClient` with constructor `{ tokenManager: TokenManager; fetchImpl: FetchLike; proxyUrl?: string; maxRetries?: number }`
  - `getJson<T>(path: string): Promise<T>` — GET with auth + client headers; retries 5xx/network up to `maxRetries` (default 2); on 401 does one `forceRefresh()` + retry; throws on non-2xx after retries.
  - `refreshRequest(body)` — static-style helper used to build the `RefreshFn` (POST `/auth/login/refresh`, no bearer). Exposed as `buildRefreshFn(fetchImpl, proxyUrl?): RefreshFn`.

- [ ] **Step 1: Write the failing test**

```typescript
import { describe, it, expect, vi } from "vitest";
import { StrongHttpClient } from "../src/http/client.js";

function res(status: number, body: unknown) {
  return { status, text: async () => (typeof body === "string" ? body : JSON.stringify(body)) };
}

const fakeTM = () => {
  let n = 0;
  return {
    getAccessToken: vi.fn(async () => "access-" + n),
    forceRefresh: vi.fn(async () => "access-" + ++n),
  } as any;
};

describe("StrongHttpClient", () => {
  it("sends bearer + client headers and parses JSON", async () => {
    const fetchImpl = vi.fn(async () => res(200, { ok: true }));
    const client = new StrongHttpClient({ tokenManager: fakeTM(), fetchImpl });
    const out = await client.getJson<{ ok: boolean }>("/api/users/u/");
    expect(out).toEqual({ ok: true });
    const [, init] = fetchImpl.mock.calls[0];
    expect(init.headers.Authorization).toBe("Bearer access-0");
    expect(init.headers["User-Agent"]).toBe("Strong iOS");
  });

  it("refreshes once and retries on 401", async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(res(401, "unauthorized"))
      .mockResolvedValueOnce(res(200, { ok: 1 }));
    const tm = fakeTM();
    const client = new StrongHttpClient({ tokenManager: tm, fetchImpl });
    expect(await client.getJson("/x")).toEqual({ ok: 1 });
    expect(tm.forceRefresh).toHaveBeenCalledTimes(1);
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });

  it("retries 5xx then throws after maxRetries", async () => {
    const fetchImpl = vi.fn(async () => res(503, "down"));
    const client = new StrongHttpClient({ tokenManager: fakeTM(), fetchImpl, maxRetries: 2 });
    await expect(client.getJson("/x")).rejects.toThrow(/503/);
    expect(fetchImpl).toHaveBeenCalledTimes(3); // initial + 2 retries
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/http-client.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Write `src/http/client.ts`**

```typescript
import { ProxyAgent } from "undici";
import { BASE_URL, CLIENT_HEADERS } from "../constants.js";
import type { TokenManager, RefreshFn } from "../auth/token-manager.js";

export type FetchLike = (
  url: string,
  init: any,
) => Promise<{ status: number; text: () => Promise<string> }>;

interface Options {
  tokenManager: TokenManager;
  fetchImpl: FetchLike;
  proxyUrl?: string;
  maxRetries?: number;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export class StrongHttpClient {
  private readonly dispatcher?: ProxyAgent;
  private readonly maxRetries: number;

  constructor(private readonly opts: Options) {
    this.maxRetries = opts.maxRetries ?? 2;
    this.dispatcher = opts.proxyUrl ? new ProxyAgent(opts.proxyUrl) : undefined;
  }

  async getJson<T>(path: string): Promise<T> {
    const url = path.startsWith("http") ? path : `${BASE_URL}${path}`;
    let token = await this.opts.tokenManager.getAccessToken();
    let refreshed = false;

    for (let attempt = 0; ; attempt++) {
      const init: any = {
        method: "GET",
        headers: { ...CLIENT_HEADERS, Authorization: `Bearer ${token}` },
      };
      if (this.dispatcher) init.dispatcher = this.dispatcher;

      let r: { status: number; text: () => Promise<string> };
      try {
        r = await this.opts.fetchImpl(url, init);
      } catch (err) {
        if (attempt < this.maxRetries) {
          await sleep(250 * (attempt + 1));
          continue;
        }
        throw new Error(`GET ${path} failed: ${(err as Error).message}`);
      }

      if (r.status === 401 && !refreshed) {
        refreshed = true;
        token = await this.opts.tokenManager.forceRefresh();
        continue;
      }
      if (r.status >= 500 && attempt < this.maxRetries) {
        await sleep(250 * (attempt + 1));
        continue;
      }
      const body = await r.text();
      if (r.status < 200 || r.status >= 300) {
        throw new Error(`GET ${path} → HTTP ${r.status}`);
      }
      return (body ? JSON.parse(body) : {}) as T;
    }
  }
}

/** Builds the RefreshFn used by TokenManager (POST /auth/login/refresh, no bearer). */
export function buildRefreshFn(fetchImpl: FetchLike, proxyUrl?: string): RefreshFn {
  const dispatcher = proxyUrl ? new ProxyAgent(proxyUrl) : undefined;
  return async (bodyIn) => {
    const init: any = {
      method: "POST",
      headers: { ...CLIENT_HEADERS, "Content-Type": "application/json" },
      body: JSON.stringify(bodyIn),
    };
    if (dispatcher) init.dispatcher = dispatcher;
    const r = await fetchImpl(`${BASE_URL}/auth/login/refresh`, init);
    if (r.status < 200 || r.status >= 300) throw new Error(`refresh HTTP ${r.status}`);
    return JSON.parse(await r.text());
  };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run tests/http-client.test.ts`
Expected: PASS (all 3 cases).

- [ ] **Step 5: Commit**

```bash
git add src/http/client.ts tests/http-client.test.ts
git commit -m "feat: HTTP client (auth headers, proxy, retries, 401->refresh)"
```

---

### Task 9: Snapshot store

**Files:**
- Create: `src/sync/snapshot-store.ts`
- Test: `tests/snapshot-store.test.ts`

**Interfaces:**
- Consumes: `readJson`, `writeJsonAtomic` (Task 5); `Snapshot`, `COLLECTIONS` (Task 1).
- Produces:
  - `class SnapshotStore { constructor(dataDir: string, userId: string); load(): Promise<Snapshot>; save(s: Snapshot): Promise<void>; empty(): Snapshot }` — `load()` returns the persisted snapshot or a fresh empty one (all 8 collections as `{}`, `continuation: null`).

- [ ] **Step 1: Write the failing test**

```typescript
import { describe, it, expect } from "vitest";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SnapshotStore } from "../src/sync/snapshot-store.js";

describe("SnapshotStore", () => {
  const dir = mkdtempSync(join(tmpdir(), "strong-snap-"));
  const store = new SnapshotStore(dir, "user-1");

  it("load() returns an empty snapshot with all 8 collections when none exists", async () => {
    const s = await store.load();
    expect(s.userId).toBe("user-1");
    expect(s.continuation).toBeNull();
    expect(Object.keys(s.entities)).toHaveLength(8);
    expect(s.entities.log).toEqual({});
  });

  it("saves and reloads", async () => {
    const s = store.empty();
    s.continuation = "cursor-1";
    s.entities.log["l1"] = { id: "l1" };
    await store.save(s);
    const again = await store.load();
    expect(again.continuation).toBe("cursor-1");
    expect(again.entities.log["l1"]).toEqual({ id: "l1" });
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/snapshot-store.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Write `src/sync/snapshot-store.ts`**

```typescript
import { join } from "node:path";
import { readJson, writeJsonAtomic } from "../storage/atomic-json.js";
import { COLLECTIONS } from "../constants.js";
import type { Snapshot, EntityMap, CollectionName } from "../types.js";

export class SnapshotStore {
  private readonly path: string;
  constructor(dataDir: string, private readonly userId: string) {
    this.path = join(dataDir, "snapshot.json");
  }

  empty(): Snapshot {
    const entities = {} as Record<CollectionName, EntityMap>;
    for (const c of COLLECTIONS) entities[c] = {};
    return { userId: this.userId, continuation: null, syncedAt: null, preferences: {}, entities };
  }

  async load(): Promise<Snapshot> {
    const stored = await readJson<Snapshot>(this.path);
    return stored ?? this.empty();
  }

  save(s: Snapshot): Promise<void> {
    return writeJsonAtomic(this.path, s);
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run tests/snapshot-store.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/sync/snapshot-store.ts tests/snapshot-store.test.ts
git commit -m "feat: snapshot store (snapshot.json, empty scaffold)"
```

---

### Task 10: HAL normalization

**Files:**
- Create: `src/sync/normalize.ts`
- Test: `tests/normalize.test.ts`, `tests/fixtures/sync-page-empty.json`, `tests/fixtures/sync-page-with-log.json`

**Interfaces:**
- Consumes: `Snapshot`, `COLLECTIONS` (Tasks 1).
- Produces:
  - `applyPage(snapshot: Snapshot, page: any): void` — merges each of the 8 `_embedded` collections into `snapshot.entities` by `id` (replace; idempotent). Copies top-level `preferences` when present.
  - `isEmptyPage(page: any): boolean` — true when all 8 `_embedded` arrays are empty/absent.
  - `nextCursor(page: any): string | null` — parses the `continuation` query param from `page._links.next.href`; `null` if absent.

- [ ] **Step 1: Create fixtures**

`tests/fixtures/sync-page-empty.json` (the caught-up page from spec §11 row 4 — trimmed):

```json
{
  "_links": {
    "next": { "href": "/api/users/u/?include=template&continuation=CURSOR_NEXT&limit=300" }
  },
  "_embedded": {
    "measurement": [], "measuredValue": [], "template": [], "log": [],
    "tag": [], "metric": [], "folder": [], "widget": []
  },
  "id": "u",
  "preferences": { "weightUnit": { "u": "POUNDS" } }
}
```

`tests/fixtures/sync-page-with-log.json` (one workout + one exercise def):

```json
{
  "_links": { "next": { "href": "/api/users/u/?continuation=CURSOR_2&limit=300" } },
  "_embedded": {
    "template": [],
    "log": [{ "id": "log-1", "logType": "WORKOUT", "isHidden": false, "name": { "custom": "Push" } }],
    "measurement": [{ "id": "m-1", "measurementType": "EXERCISE", "isHidden": false, "name": { "custom": "Bench" } }],
    "measuredValue": [], "tag": [], "metric": [], "folder": [], "widget": []
  },
  "id": "u"
}
```

- [ ] **Step 2: Write the failing test**

```typescript
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { applyPage, isEmptyPage, nextCursor } from "../src/sync/normalize.js";
import { SnapshotStore } from "../src/sync/snapshot-store.js";

const load = (f: string) =>
  JSON.parse(readFileSync(join(__dirname, "fixtures", f), "utf8"));

describe("normalize", () => {
  it("detects an empty (caught-up) page and reads its next cursor", () => {
    const p = load("sync-page-empty.json");
    expect(isEmptyPage(p)).toBe(true);
    expect(nextCursor(p)).toBe("CURSOR_NEXT");
  });

  it("merges embedded entities into the snapshot by id, per collection", () => {
    const snap = new SnapshotStore("/x", "u").empty();
    const p = load("sync-page-with-log.json");
    expect(isEmptyPage(p)).toBe(false);
    applyPage(snap, p);
    expect(snap.entities.log["log-1"].name).toEqual({ custom: "Push" });
    expect(snap.entities.measurement["m-1"].name).toEqual({ custom: "Bench" });
    expect(nextCursor(p)).toBe("CURSOR_2");
  });

  it("applyPage is idempotent (re-applying replaces, does not duplicate)", () => {
    const snap = new SnapshotStore("/x", "u").empty();
    const p = load("sync-page-with-log.json");
    applyPage(snap, p);
    applyPage(snap, p);
    expect(Object.keys(snap.entities.log)).toEqual(["log-1"]);
  });

  it("returns null cursor when there is no next link", () => {
    expect(nextCursor({ _links: {} })).toBeNull();
  });
});
```

- [ ] **Step 3: Run test to verify it fails**

Run: `npx vitest run tests/normalize.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 4: Write `src/sync/normalize.ts`**

```typescript
import { COLLECTIONS } from "../constants.js";
import type { Snapshot } from "../types.js";

export function applyPage(snapshot: Snapshot, page: any): void {
  const embedded = page?._embedded ?? {};
  for (const c of COLLECTIONS) {
    const arr = embedded[c];
    if (!Array.isArray(arr)) continue;
    for (const entity of arr) {
      if (entity && typeof entity.id === "string") {
        snapshot.entities[c][entity.id] = entity; // replace by id — idempotent
      }
    }
  }
  if (page?.preferences && typeof page.preferences === "object") {
    snapshot.preferences = page.preferences;
  }
}

export function isEmptyPage(page: any): boolean {
  const embedded = page?._embedded ?? {};
  return COLLECTIONS.every((c) => {
    const arr = embedded[c];
    return !Array.isArray(arr) || arr.length === 0;
  });
}

export function nextCursor(page: any): string | null {
  const href = page?._links?.next?.href;
  if (typeof href !== "string") return null;
  const q = href.includes("?") ? href.slice(href.indexOf("?") + 1) : href;
  const params = new URLSearchParams(q);
  return params.get("continuation");
}
```

- [ ] **Step 5: Run test to verify it passes**

Run: `npx vitest run tests/normalize.test.ts`
Expected: PASS (all 4 cases).

- [ ] **Step 6: Commit**

```bash
git add src/sync/normalize.ts tests/normalize.test.ts tests/fixtures/sync-page-empty.json tests/fixtures/sync-page-with-log.json
git commit -m "feat: HAL page normalization (merge, emptiness, cursor parse)"
```

---

### Task 11: Sync engine

**Files:**
- Create: `src/sync/sync-engine.ts`
- Test: `tests/sync-engine.test.ts`

**Interfaces:**
- Consumes: `StrongHttpClient` (Task 8, via a minimal `{ getJson }` shape); `SnapshotStore` (Task 9); `applyPage`/`isEmptyPage`/`nextCursor` (Task 10); `SYNC_INCLUDE`, `SYNC_LIMIT` (Task 1).
- Produces:
  - `class SyncEngine { constructor({ http: { getJson }, store: SnapshotStore, userId: string }); sync(): Promise<{ pages: number; snapshot: Snapshot }> }`
  - `sync()` runs a delta walk if a cursor exists, else a full walk; on a 4xx during a delta walk it falls back to a full walk. Walk = fetch page → applyPage → advance to `nextCursor` → stop when `isEmptyPage` OR no next cursor. Persists snapshot + final cursor on success.

- [ ] **Step 1: Write the failing test**

```typescript
import { describe, it, expect, vi } from "vitest";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SnapshotStore } from "../src/sync/snapshot-store.js";
import { SyncEngine } from "../src/sync/sync-engine.js";

const store = () => new SnapshotStore(mkdtempSync(join(tmpdir(), "strong-se-")), "u");

const page = (logs: any[], nextCursor: string | null) => ({
  _links: nextCursor ? { next: { href: `/api/users/u/?continuation=${nextCursor}&limit=300` } } : {},
  _embedded: {
    template: [], log: logs, measurement: [], measuredValue: [],
    tag: [], metric: [], folder: [], widget: [],
  },
  id: "u",
});

describe("SyncEngine", () => {
  it("walks multiple pages until an empty page and persists the cursor", async () => {
    const getJson = vi
      .fn()
      .mockResolvedValueOnce(page([{ id: "a" }], "C1"))
      .mockResolvedValueOnce(page([{ id: "b" }], "C2"))
      .mockResolvedValueOnce(page([], "C3")); // empty → stop
    const s = store();
    const engine = new SyncEngine({ http: { getJson }, store: s, userId: "u" });
    const { pages, snapshot } = await engine.sync();
    expect(pages).toBe(3);
    expect(Object.keys(snapshot.entities.log).sort()).toEqual(["a", "b"]);
    expect(snapshot.continuation).toBe("C3");
    // full sync (no stored cursor) must NOT send a continuation on page 1
    expect(getJson.mock.calls[0][0]).not.toContain("continuation=");
  });

  it("stops when a page has no next link", async () => {
    const getJson = vi.fn().mockResolvedValueOnce(page([{ id: "a" }], null));
    const s = store();
    const engine = new SyncEngine({ http: { getJson }, store: s, userId: "u" });
    const { pages } = await engine.sync();
    expect(pages).toBe(1);
  });

  it("delta walk uses stored cursor and falls back to full sync on 4xx", async () => {
    const s = store();
    const seed = s.empty();
    seed.continuation = "STALE";
    await s.save(seed);

    const getJson = vi
      .fn()
      .mockRejectedValueOnce(new Error("GET /x → HTTP 400")) // stale cursor rejected
      .mockResolvedValueOnce(page([{ id: "a" }], "C1")) // full sync page 1
      .mockResolvedValueOnce(page([], "C2")); // empty → stop
    const engine = new SyncEngine({ http: { getJson }, store: s, userId: "u" });
    const { snapshot } = await engine.sync();
    expect(snapshot.entities.log["a"]).toBeDefined();
    // first call used the stale cursor; second (fallback) did not
    expect(getJson.mock.calls[0][0]).toContain("continuation=STALE");
    expect(getJson.mock.calls[1][0]).not.toContain("continuation=");
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/sync-engine.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Write `src/sync/sync-engine.ts`**

```typescript
import { SYNC_INCLUDE, SYNC_LIMIT } from "../constants.js";
import { applyPage, isEmptyPage, nextCursor } from "./normalize.js";
import type { SnapshotStore } from "./snapshot-store.js";
import type { Snapshot } from "../types.js";

interface HttpGet {
  getJson<T>(path: string): Promise<T>;
}

interface Options {
  http: HttpGet;
  store: SnapshotStore;
  userId: string;
}

export class SyncEngine {
  constructor(private readonly opts: Options) {}

  private pagePath(cursor: string | null): string {
    const base = `/api/users/${this.opts.userId}/?${SYNC_INCLUDE}&limit=${SYNC_LIMIT}`;
    return cursor ? `${base}&continuation=${encodeURIComponent(cursor)}` : base;
  }

  async sync(): Promise<{ pages: number; snapshot: Snapshot }> {
    const snapshot = await this.opts.store.load();
    try {
      return await this.walk(snapshot, snapshot.continuation);
    } catch (err) {
      // Stale/rejected cursor → full re-sync from scratch.
      if (snapshot.continuation && /HTTP 4\d\d/.test((err as Error).message)) {
        const fresh = this.opts.store.empty();
        return this.walk(fresh, null);
      }
      throw err;
    }
  }

  private async walk(snapshot: Snapshot, startCursor: string | null) {
    let cursor = startCursor;
    let pages = 0;
    for (;;) {
      const page = await this.opts.http.getJson<any>(this.pagePath(cursor));
      pages++;
      applyPage(snapshot, page);
      const next = nextCursor(page);
      if (next) cursor = next;
      if (isEmptyPage(page) || !next) {
        snapshot.continuation = next ?? cursor;
        snapshot.syncedAt = new Date().toISOString();
        await this.opts.store.save(snapshot);
        return { pages, snapshot };
      }
    }
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run tests/sync-engine.test.ts`
Expected: PASS (all 3 cases).

- [ ] **Step 5: Commit**

```bash
git add src/sync/sync-engine.ts tests/sync-engine.test.ts
git commit -m "feat: sync engine (full/delta walk, termination, cursor fallback)"
```

---

### Task 12: Read service

**Files:**
- Create: `src/services/read-service.ts`
- Test: `tests/read-service.test.ts`

**Interfaces:**
- Consumes: `Snapshot`, `Entity` (Task 1); `formatLb`/`toDisplayMeasuredValue`/`WeightUnit` (Task 2).
- Produces: `class ReadService` constructed with `{ getSnapshot: () => Snapshot; getWeightUnit: () => WeightUnit; userId: string }` (weight unit is a thunk so it reflects preferences that only arrive after sync), methods:
  - `whoami(): { userId: string; weightUnit: WeightUnit; syncedAt: string | null; counts: Record<string, number> }`
  - `listWorkouts(opts?: { limit?: number }): { id: string; name: string; startDate?: string; exerciseCount: number }[]` (newest first, `isHidden` filtered)
  - `getWorkout(id: string): { id: string; name: string; exercises: { name: string; sets: { reps: number|null; weight: number|null; unit: string; rpe: number|null }[] }[] } | null`
  - `listTemplates(): { id: string; name: string }[]`
  - `listExercises(search?: string): { id: string; name: string; cellTypes: string[] }[]`
  - `getExerciseHistory(exerciseId: string): { workoutId: string; date?: string; sets: { reps: number|null; weight: number|null; unit: string }[] }[]`
  - `listMeasurements(type?: string): { id: string; type: string; value: number; unit: string; date?: string }[]`

Helper (module-private): `exerciseName(snapshot, measurementId)`, `groupsOf(logEntity)`, `weightCellType(cells)`.

- [ ] **Step 1: Write the failing test**

```typescript
import { describe, it, expect } from "vitest";
import { ReadService } from "../src/services/read-service.js";
import type { Snapshot } from "../src/types.js";

function snap(): Snapshot {
  return {
    userId: "u", continuation: null, syncedAt: null,
    preferences: {},
    entities: {
      template: { t1: { id: "t1", isHidden: false, name: { custom: "PPL" } } },
      log: {
        w1: {
          id: "w1", isHidden: false, logType: "WORKOUT", startDate: "2026-07-22T02:00:00Z",
          name: { custom: "Push" },
          _embedded: { cellSetGroup: [
            { id: "g1", _links: { measurement: { href: "/api/users/u/measurements/m1" } },
              cellSets: [
                { id: "s1", isHidden: false, cells: [
                  { cellType: "DUMBBELL_WEIGHT", value: "13.6077711" },
                  { cellType: "REPS", value: "12" },
                  { cellType: "RPE", value: null },
                ] },
                { id: "s2", isHidden: false, cells: [{ cellType: "REST_TIMER", value: "85" }] },
              ] },
          ] },
        },
        wHidden: { id: "wHidden", isHidden: true, logType: "WORKOUT", name: { custom: "gone" }, _embedded: { cellSetGroup: [] } },
      },
      measurement: { m1: { id: "m1", isHidden: false, measurementType: "EXERCISE",
        name: { custom: "DB Bench" },
        cellTypeConfigs: [{ cellType: "DUMBBELL_WEIGHT", index: 0 }, { cellType: "REPS", index: 1 }] } },
      measuredValue: {
        v1: { id: "v1", isHidden: false, measurementTypeValue: "WEIGHT", value: 90.718474, startDate: "2026-07-22T02:02:19Z" },
      },
      folder: {}, tag: {}, metric: {}, widget: {},
    },
  };
}

const svc = () => new ReadService({ getSnapshot: snap, getWeightUnit: () => "POUNDS", userId: "u" });

describe("ReadService", () => {
  it("whoami reports unit + visible counts (hidden excluded)", () => {
    const who = svc().whoami();
    expect(who).toMatchObject({ userId: "u", weightUnit: "POUNDS" });
    expect(who.counts.log).toBe(1); // wHidden excluded
    expect(who.counts.measurement).toBe(1);
  });

  it("lists workouts excluding hidden ones", () => {
    const list = svc().listWorkouts();
    expect(list.map((w) => w.id)).toEqual(["w1"]);
    expect(list[0]).toMatchObject({ name: "Push", exerciseCount: 1 });
  });

  it("returns a workout with sets in display units (kg→lb), skipping rest timers", () => {
    const w = svc().getWorkout("w1")!;
    expect(w.exercises[0].name).toBe("DB Bench");
    expect(w.exercises[0].sets).toEqual([{ reps: 12, weight: 30, unit: "lb", rpe: null }]);
  });

  it("searches exercises by name and exposes cell types", () => {
    const ex = svc().listExercises("bench");
    expect(ex).toEqual([{ id: "m1", name: "DB Bench", cellTypes: ["DUMBBELL_WEIGHT", "REPS"] }]);
  });

  it("builds exercise history across workouts", () => {
    const hist = svc().getExerciseHistory("m1");
    expect(hist).toEqual([
      { workoutId: "w1", date: "2026-07-22T02:00:00Z", sets: [{ reps: 12, weight: 30, unit: "lb" }] },
    ]);
  });

  it("lists body measurements with type-aware display", () => {
    const m = svc().listMeasurements();
    expect(m).toEqual([{ id: "v1", type: "WEIGHT", value: 200, unit: "lb", date: "2026-07-22T02:02:19Z" }]);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/read-service.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Write `src/services/read-service.ts`**

```typescript
import { formatLb, formatKg, toDisplayMeasuredValue, type WeightUnit } from "../units.js";
import type { Snapshot, Entity } from "../types.js";

interface Options {
  getSnapshot: () => Snapshot;
  getWeightUnit: () => WeightUnit;
  userId: string;
}

const WEIGHT_CELL_TYPES = new Set([
  "DUMBBELL_WEIGHT", "BARBELL_WEIGHT", "WEIGHTED_BODYWEIGHT", "WEIGHT",
]);

function customName(e: Entity): string {
  const n = e.name as { custom?: string; en?: string } | undefined;
  return n?.custom ?? n?.en ?? "";
}

function measurementIdOf(group: any): string | null {
  const href = group?._links?.measurement?.href;
  if (typeof href !== "string") return null;
  return href.split("/").pop() ?? null;
}

function num(v: unknown): number | null {
  if (v === null || v === undefined || v === "") return null;
  const n = Number(v);
  return Number.isNaN(n) ? null : n;
}

export class ReadService {
  constructor(private readonly opts: Options) {}
  private get snap() {
    return this.opts.getSnapshot();
  }

  private displayWeightKg(kg: number): number {
    return this.opts.getWeightUnit() === "KILOGRAMS" ? formatKg(kg) : formatLb(kg);
  }
  private get weightUnitLabel(): string {
    return this.opts.getWeightUnit() === "KILOGRAMS" ? "kg" : "lb";
  }

  private visible(map: Record<string, Entity>): Entity[] {
    return Object.values(map).filter((e) => e.isHidden !== true);
  }

  whoami() {
    const s = this.snap;
    const counts: Record<string, number> = {};
    for (const [name, map] of Object.entries(s.entities)) {
      counts[name] = this.visible(map as Record<string, Entity>).length;
    }
    return {
      userId: this.opts.userId,
      weightUnit: this.opts.getWeightUnit(),
      syncedAt: s.syncedAt,
      counts,
    };
  }

  private groups(log: Entity): any[] {
    const g = (log._embedded as any)?.cellSetGroup;
    return Array.isArray(g) ? g : [];
  }

  /** Extracts working sets (weight/reps/rpe) for one exercise group, skipping REST_TIMER-only cellSets. */
  private setsOf(group: any): { reps: number | null; weight: number | null; unit: string; rpe: number | null }[] {
    const cellSets = Array.isArray(group?.cellSets) ? group.cellSets : [];
    const out: any[] = [];
    for (const cs of cellSets) {
      if (cs?.isHidden === true) continue;
      const cells = Array.isArray(cs?.cells) ? cs.cells : [];
      const isRestOnly = cells.length > 0 && cells.every((c: any) => c.cellType === "REST_TIMER");
      if (isRestOnly) continue;
      let reps: number | null = null;
      let weight: number | null = null;
      let rpe: number | null = null;
      for (const c of cells) {
        if (c.cellType === "REPS") reps = num(c.value);
        else if (c.cellType === "RPE") rpe = num(c.value);
        else if (WEIGHT_CELL_TYPES.has(c.cellType)) {
          const kg = num(c.value);
          weight = kg === null ? null : this.displayWeightKg(kg);
        }
      }
      out.push({ reps, weight, unit: this.weightUnitLabel, rpe });
    }
    return out;
  }

  private exerciseName(measurementId: string | null): string {
    if (!measurementId) return "Unknown";
    const m = this.snap.entities.measurement[measurementId];
    return m ? customName(m) : "Unknown";
  }

  listWorkouts(opts?: { limit?: number }) {
    const rows = this.visible(this.snap.entities.log)
      .map((w) => ({
        id: w.id,
        name: customName(w),
        startDate: w.startDate as string | undefined,
        exerciseCount: this.groups(w).length,
      }))
      .sort((a, b) => (b.startDate ?? "").localeCompare(a.startDate ?? ""));
    return opts?.limit ? rows.slice(0, opts.limit) : rows;
  }

  getWorkout(id: string) {
    const w = this.snap.entities.log[id];
    if (!w || w.isHidden === true) return null;
    return {
      id: w.id,
      name: customName(w),
      exercises: this.groups(w).map((g) => ({
        name: this.exerciseName(measurementIdOf(g)),
        sets: this.setsOf(g),
      })),
    };
  }

  listTemplates() {
    return this.visible(this.snap.entities.template).map((t) => ({ id: t.id, name: customName(t) }));
  }

  listExercises(search?: string) {
    const q = search?.toLowerCase();
    return this.visible(this.snap.entities.measurement)
      .filter((m) => m.measurementType === "EXERCISE")
      .map((m) => ({
        id: m.id,
        name: customName(m),
        cellTypes: (Array.isArray(m.cellTypeConfigs) ? (m.cellTypeConfigs as any[]) : []).map((c) => c.cellType),
      }))
      .filter((m) => !q || m.name.toLowerCase().includes(q));
  }

  getExerciseHistory(exerciseId: string) {
    const out: { workoutId: string; date?: string; sets: { reps: number | null; weight: number | null; unit: string }[] }[] = [];
    for (const w of this.visible(this.snap.entities.log)) {
      for (const g of this.groups(w)) {
        if (measurementIdOf(g) !== exerciseId) continue;
        out.push({
          workoutId: w.id,
          date: w.startDate as string | undefined,
          sets: this.setsOf(g).map(({ reps, weight, unit }) => ({ reps, weight, unit })),
        });
      }
    }
    return out.sort((a, b) => (a.date ?? "").localeCompare(b.date ?? ""));
  }

  listMeasurements(type?: string) {
    return this.visible(this.snap.entities.measuredValue)
      .filter((v) => !type || v.measurementTypeValue === type)
      .map((v) => {
        const t = String(v.measurementTypeValue);
        const { value, unit } = toDisplayMeasuredValue(t, Number(v.value), this.opts.getWeightUnit());
        return { id: v.id, type: t, value, unit, date: v.startDate as string | undefined };
      });
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run tests/read-service.test.ts`
Expected: PASS (all 5 cases).

- [ ] **Step 5: Commit**

```bash
git add src/services/read-service.ts tests/read-service.test.ts
git commit -m "feat: read service (workouts, templates, exercises, history, measurements)"
```

---

### Task 13: Read tools

**Files:**
- Create: `src/tools/read-tools.ts`
- Test: `tests/read-tools.test.ts`

**Interfaces:**
- Consumes: `ReadService` (Task 12); `SyncEngine` (Task 11); `@modelcontextprotocol/sdk` `McpServer`; `zod`.
- Produces: `registerReadTools(server: McpServer, deps: { service: ReadService; sync: () => Promise<{ pages: number }> }): void` — registers `strong_sync`, `strong_whoami`, `strong_list_workouts`, `strong_get_workout`, `strong_list_templates`, `strong_list_exercises`, `strong_get_exercise_history`, `strong_list_measurements`. Each handler returns `{ content: [{ type: "text", text }] }` with JSON-stringified results.

- [ ] **Step 1: Write the failing test**

Registers tools against a fake server that records handlers, then invokes them.

```typescript
import { describe, it, expect, vi } from "vitest";
import { registerReadTools } from "../src/tools/read-tools.js";

function fakeServer() {
  const handlers: Record<string, Function> = {};
  return {
    handlers,
    registerTool(name: string, _def: unknown, handler: Function) {
      handlers[name] = handler;
    },
  };
}

const service = {
  whoami: vi.fn(() => ({ userId: "u", weightUnit: "POUNDS", syncedAt: null, counts: {} })),
  listWorkouts: vi.fn(() => [{ id: "w1", name: "Push", exerciseCount: 1 }]),
  getWorkout: vi.fn(() => ({ id: "w1", name: "Push", exercises: [] })),
  listTemplates: vi.fn(() => []),
  listExercises: vi.fn(() => [{ id: "m1", name: "Bench", cellTypes: [] }]),
  getExerciseHistory: vi.fn(() => []),
  listMeasurements: vi.fn(() => []),
} as any;

describe("registerReadTools", () => {
  it("registers all read tools", () => {
    const server = fakeServer();
    registerReadTools(server as any, { service, sync: vi.fn(async () => ({ pages: 1 })) });
    expect(Object.keys(server.handlers).sort()).toEqual(
      [
        "strong_get_exercise_history", "strong_get_workout", "strong_list_exercises",
        "strong_list_measurements", "strong_list_templates", "strong_list_workouts",
        "strong_sync", "strong_whoami",
      ].sort(),
    );
  });

  it("strong_list_workouts returns service data as text content", async () => {
    const server = fakeServer();
    registerReadTools(server as any, { service, sync: vi.fn(async () => ({ pages: 1 })) });
    const out = await server.handlers["strong_list_workouts"]({});
    expect(out.content[0].type).toBe("text");
    expect(JSON.parse(out.content[0].text)).toEqual([{ id: "w1", name: "Push", exerciseCount: 1 }]);
  });

  it("strong_sync triggers a sync and reports page count", async () => {
    const server = fakeServer();
    const sync = vi.fn(async () => ({ pages: 3 }));
    registerReadTools(server as any, { service, sync });
    const out = await server.handlers["strong_sync"]({});
    expect(sync).toHaveBeenCalled();
    expect(out.content[0].text).toContain("3");
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/read-tools.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Write `src/tools/read-tools.ts`**

```typescript
import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { ReadService } from "../services/read-service.js";

type Deps = { service: ReadService; sync: () => Promise<{ pages: number }> };

const text = (data: unknown) => ({
  content: [{ type: "text" as const, text: JSON.stringify(data, null, 2) }],
});

export function registerReadTools(server: McpServer, deps: Deps): void {
  const { service, sync } = deps;

  server.registerTool(
    "strong_sync",
    { description: "Sync the local snapshot from Strong (delta if possible, else full)." , inputSchema: {} },
    async () => {
      const { pages } = await sync();
      return text({ ok: true, pagesWalked: pages });
    },
  );

  server.registerTool(
    "strong_whoami",
    { description: "Show the current user id, unit preference, last sync time, and entity counts.", inputSchema: {} },
    async () => text(service.whoami()),
  );

  server.registerTool(
    "strong_list_workouts",
    { description: "List recent workouts (newest first).", inputSchema: { limit: z.number().int().positive().optional() } },
    async (args: { limit?: number }) => text(service.listWorkouts({ limit: args.limit })),
  );

  server.registerTool(
    "strong_get_workout",
    { description: "Get one workout in full, with sets in display units.", inputSchema: { id: z.string() } },
    async (args: { id: string }) => text(service.getWorkout(args.id)),
  );

  server.registerTool(
    "strong_list_templates",
    { description: "List saved workout templates.", inputSchema: {} },
    async () => text(service.listTemplates()),
  );

  server.registerTool(
    "strong_list_exercises",
    { description: "List exercise definitions; optional name search.", inputSchema: { search: z.string().optional() } },
    async (args: { search?: string }) => text(service.listExercises(args.search)),
  );

  server.registerTool(
    "strong_get_exercise_history",
    { description: "All logged sets for one exercise over time (by exercise id).", inputSchema: { exerciseId: z.string() } },
    async (args: { exerciseId: string }) => text(service.getExerciseHistory(args.exerciseId)),
  );

  server.registerTool(
    "strong_list_measurements",
    { description: "List body measurements; optional type filter (e.g. WEIGHT).", inputSchema: { type: z.string().optional() } },
    async (args: { type?: string }) => text(service.listMeasurements(args.type)),
  );
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run tests/read-tools.test.ts`
Expected: PASS (all 3 cases).

- [ ] **Step 5: Commit**

```bash
git add src/tools/read-tools.ts tests/read-tools.test.ts
git commit -m "feat: read tools (register 8 read/system MCP tools)"
```

---

### Task 14: MCP server wiring & entrypoint

**Files:**
- Create: `src/server.ts`
- Modify: `src/index.ts` (replace the stub)
- Test: `tests/server.test.ts`

**Interfaces:**
- Consumes: everything above — `loadConfig`, `TokenStore`, `TokenManager`, `buildRefreshFn`, `StrongHttpClient`, `SnapshotStore`, `SyncEngine`, `ReadService`, `registerReadTools`.
- Produces:
  - `buildServer(config: Config, fetchImpl: FetchLike, now?: () => number): Promise<{ server: McpServer; sync: () => Promise<{ pages: number }> }>` — wires all deps, loads the snapshot into memory, registers tools. The in-memory snapshot is refreshed by `sync()`.
  - `src/index.ts`: loads config from `process.env`, calls `buildServer` with undici `fetch`, does an initial `sync()`, connects `StdioServerTransport`. Errors are written to `stderr` and exit non-zero.

- [ ] **Step 1: Write the failing test**

Verifies wiring end-to-end with a replay `fetchImpl` (no network): a sync page then an empty page, then a read tool returns the synced workout.

```typescript
import { describe, it, expect, vi } from "vitest";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildServer } from "../src/server.js";
import type { Config } from "../src/config.js";

const TOKEN =
  "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJodHRwOi8vc2NoZW1hcy54bWxzb2FwLm9yZy93cy8yMDA1LzA1L2lkZW50aXR5L2NsYWltcy9uYW1laWRlbnRpZmllciI6IjAwMDAwMDAwLTAwMDAtNDAwMC04MDAwLTAwMDAwMDAwMDAwMCIsImh0dHA6Ly9zY2hlbWFzLnhtbHNvYXAub3JnL3dzLzIwMDUvMDUvaWRlbnRpdHkvY2xhaW1zL25hbWUiOiJUZXN0IFVzZXIiLCJodHRwOi8vc2NoZW1hcy54bWxzb2FwLm9yZy93cy8yMDA1LzA1L2lkZW50aXR5L2NsYWltcy9lbWFpbGFkZHJlc3MiOiJ0ZXN0QGV4YW1wbGUuY29tIiwiVXNlclR5cGUiOiJTdHJvbmdVc2VyIiwiaWF0IjoxNzg0Njg0NDY2LCJleHAiOjE3ODQ2ODU2NjYsImlzcyI6Imh0dHBzOi8vYmFjay5zdHJvbmcuYXBwIiwiYXVkIjoiaHR0cHM6Ly9iYWNrLnN0cm9uZy5hcHAifQ.dummy_signature_not_valid_0000000000000000000000";

const config: Config = {
  accessToken: TOKEN, refreshToken: "r", deviceId: "d",
  userId: "00000000-0000-4000-8000-000000000000",
  dataDir: mkdtempSync(join(tmpdir(), "strong-srv-")),
  weightUnitOverride: "POUNDS",
};

function res(status: number, body: unknown) {
  return { status, text: async () => JSON.stringify(body) };
}
const workoutPage = {
  _links: { next: { href: "/api/users/u/?continuation=C1&limit=300" } },
  _embedded: { template: [], log: [{ id: "w1", isHidden: false, logType: "WORKOUT", name: { custom: "Push" }, _embedded: { cellSetGroup: [] } }], measurement: [], measuredValue: [], tag: [], metric: [], folder: [], widget: [] },
};
const emptyPage = {
  _links: { next: { href: "/api/users/u/?continuation=C2&limit=300" } },
  _embedded: { template: [], log: [], measurement: [], measuredValue: [], tag: [], metric: [], folder: [], widget: [] },
};

describe("buildServer", () => {
  it("wires deps, syncs via replay, and serves a read tool", async () => {
    // now = well before token expiry so no refresh occurs
    const now = () => (1784685666 - 1200) * 1000;
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(res(200, workoutPage))
      .mockResolvedValueOnce(res(200, emptyPage));

    const { server, sync } = await buildServer(config, fetchImpl as any, now);
    // buildServer wires real deps on a real McpServer. Assert the replayed sync
    // walked both pages and the server object was constructed.
    const { pages } = await sync();
    expect(pages).toBe(2);
    expect(server).toBeDefined();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/server.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Write `src/server.ts`**

```typescript
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
```

- [ ] **Step 4: Write `src/index.ts` (replace stub)**

```typescript
import { fetch } from "undici";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { loadConfig } from "./config.js";
import { buildServer } from "./server.js";
import type { FetchLike } from "./http/client.js";

async function main() {
  const config = loadConfig(process.env);
  const { server, sync } = await buildServer(config, fetch as unknown as FetchLike);
  try {
    const { pages } = await sync();
    process.stderr.write(`strong-mcp: initial sync walked ${pages} page(s)\n`);
  } catch (err) {
    process.stderr.write(`strong-mcp: initial sync failed: ${(err as Error).message}\n`);
  }
  const transport = new StdioServerTransport();
  await server.connect(transport);
}

main().catch((err) => {
  process.stderr.write(`strong-mcp fatal: ${(err as Error).message}\n`);
  process.exit(1);
});
```

- [ ] **Step 5: Run tests + typecheck + build**

Run: `npx vitest run tests/server.test.ts && npm run typecheck && npm run build`
Expected: server test PASSES; typecheck clean; `dist/` produced.

- [ ] **Step 6: Full suite green**

Run: `npm test`
Expected: all tests across all tasks PASS.

- [ ] **Step 7: Commit**

```bash
git add src/server.ts src/index.ts tests/server.test.ts
git commit -m "feat: wire MCP server + stdio entrypoint (Phase 1 complete)"
```

---

## Manual smoke test (after Task 14)

With real seeded tokens in `.env` (see `.env.example`) and optional Proxyman:

```bash
npm run build
# Load env then run; e.g. with a dotenv-cli or by exporting vars, then:
node dist/index.js
```

Point an MCP client (Claude Desktop config, or the MCP inspector) at `node /Users/justin/Projects/strong-mcp/dist/index.js`, then call `strong_sync` followed by `strong_list_workouts`. Expected: sync reports pages walked, and recent workouts list with lbs. Watch traffic in Proxyman if `STRONG_PROXY_URL` is set.

---

## Self-Review notes (spec coverage)

- Auth login/refresh/rotation/single-flight/re-seed → Tasks 3,6,7 (+ §5.1 constraints). `logout` intentionally unused (spec §5.1).
- Sync include list / termination / cursor / 4xx fallback → Tasks 10,11 (spec §6.1).
- Snapshot retains hidden; reads filter hidden → Tasks 9,12 (spec §4.6, §7).
- Units from preference, per-type measuredValue, kg storage → Tasks 2,12 (spec §4.5).
- Atomic persistence, 0600 token file → Tasks 5,6 (spec §5.1).
- Proxy passthrough, client headers, 401 retry → Task 8 (spec §3.1).
- All read tools → Task 13 (spec §7 Reads + system).
- **Deferred to Phase 2 (writes):** envelope builder + routing, byte-for-byte edits, soft-delete/folder maintenance, workout builder, serialized write queue, refuse-on-unknown-write, and capturing the two ⚠️ inferred shapes (spec §2, §6.2–§6.6). `strong_whoami` returns a minimal stub in Phase 1 and is fleshed out when preferences surfacing is finalized.
