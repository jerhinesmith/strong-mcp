# strong-mcp Phase 2 (Writes) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add write support to `strong-mcp` — log/edit/delete workouts, create/edit/delete templates, log/delete body measurements, and create/edit/archive custom exercises — all via Strong's single `PUT /api/users/{id}` sync-document mechanism, with serialized writes, byte-for-byte preservation of untouched values, and generic soft-delete.

**Architecture:** A new `write/` layer sits beside the existing read layer. Pure builders (envelope, soft-delete, log/template, entity, edit) transform snapshot entities + tool inputs into changed-entity sets; a serialized `WriteEngine` runs the mutation protocol (delta-sync → build → PUT → apply-to-snapshot → persist); a `WriteService` exposes domain methods; `write-tools` registers the MCP tools. Everything composes with Phase 1's `StrongHttpClient`, `SyncEngine`, `SnapshotStore`, and the closure-held in-memory snapshot in `buildServer`.

**Tech Stack:** TypeScript (Node ≥ 20, ESM), `@modelcontextprotocol/sdk`, `zod`, `undici`, `vitest`, `tsc`. (Unchanged from Phase 1.)

**Prerequisite reading:** the design spec `docs/design/2026-07-21-strong-mcp-design.md`, especially §4 (data model), §6.2–§6.6 (write flow, cellTypeConfigs, soft-delete, edits, folder maintenance), and §8.1 (known limitations). Phase 1 is merged; this plan builds on the current `src/` tree.

## Global Constraints

Copied verbatim from the design spec. Every task inherits these.

- **Write endpoint:** `PUT /api/users/{userId}`. **Success is by HTTP status code; the response body is empty.** On non-2xx, the local snapshot is left unchanged and the error is surfaced.
- **Write envelope:** `{ "id": userId, "strongAnalytics": false, "_embedded": { template:[], log:[], measurement:[], measuredValue:[], folder:[], tag:[], metric:[], widget:[] } }` — only changed collections populated, the rest sent as empty arrays. All eight collections are always present as keys.
- **Envelope routing (by entity kind, NOT by `logType` alone):** saved routine → `_embedded.template`; performed workout → `_embedded.log`; exercise definition → `_embedded.measurement`; body value → `_embedded.measuredValue`; folder → `_embedded.folder`. `template` and `log` are SEPARATE collections that share nested shape.
- **Write flow (all mutations, serialized — no two writes interleave):** (1) delta-sync first so cross-links aren't stale; (2) mutate a working copy — client-generated UUID v4 for new entities, bumped `lastChanged`, ISO timestamps; edits start from the entity's exact snapshot object; (3) build envelope; (4) PUT; (5) on 2xx apply the same mutation to the in-memory snapshot and persist (atomic). Apply is idempotent (replace by id).
- **Weights:** stored as **stringified kg floats**; `kg = lb × 0.45359237`. Tool inputs/outputs are in the account's display unit (lb for this account); convert display→kg on write.
- **Byte-for-byte preservation (§6.5):** on a full-entity-replace edit, only the cells the user explicitly changed are rewritten (display→kg at that point); every other cell keeps its **original raw string verbatim** — never round-trip kg→display→kg on a cell you aren't editing.
- **Soft-delete (§6.4):** "delete" is never a hard delete — it's a PUT flipping `isHidden: true`. Nested entities (templates & workouts) cascade `isHidden:true` to the entity AND every cellSetGroup/cellSet/cell. Flat entities (exercises, measuredValues) flip the single entity. Template deletion additionally removes the template's `_link` from its folder and re-sends that folder.
- **Workout building (§6.3):** for each exercise, look up that exercise definition's `cellTypeConfigs` to decide which cell types a set emits and in what order. Do NOT hardcode a weight cell type. Exercises are referenced by definition **id**; if the id isn't in the snapshot after delta-sync, error (never fabricate a definition).
- **Set/rest-timer structure (§4.4):** within a cellSetGroup, working sets and rest timers alternate: `set, rest, set, rest, …` — each working set followed by its own single-`REST_TIMER`-cell cellSet, including a trailing rest timer. Rest seconds come from `preferences.restTimer` (map of exercise-definition-id → seconds; fall back to the user-id-keyed default; stored as a stringified integer). Workout sets are `isCompleted: true`.
- **Open-enum refuse-on-write:** unknown cell/measurement types pass through on read, but a user-supplied write value for an unknown-typed field must be REFUSED (throw), never written with a guessed scale.
- **Every write requires an explicit target** and returns a summary of what changed — no silent guessing about which entity to mutate.
- **Never log** tokens, the full bearer, or credentials.
- **Two write shapes are GATED (⚠️ inferred, uncaptured):** `strong_update_workout` and `strong_delete_measurement`. Their tasks (Task 11) must NOT be implemented until the real PUT is captured from Proxyman and turned into a golden fixture. Every other write is fully captured and proven.

---

## File Structure

New files (Phase 2), plus two Phase-1 files modified:

```
src/
  write/
    ids.ts                 # newId() (crypto.randomUUID), makeClock() → () => ISO string
    envelope.ts            # buildEnvelope(userId, changes) — routing + all-8-collections
    soft-delete.ts         # softDelete(entity) — cascade (nested) / flat flip
    log-builder.ts         # buildWorkoutLog / buildTemplate from cellTypeConfigs + inputs
    entity-builders.ts     # buildMeasuredValue (flat) + buildExerciseDefinition (flat)
    edit.ts                # applyCellEdits — byte-for-byte preserve untouched cells
    folders.ts             # addTemplateToFolder / removeTemplateFromFolder helpers
    write-engine.ts        # serialized queue; deltaSync→build→PUT→apply→persist
  http/client.ts           # (modify) add putUserDoc()
  services/write-service.ts# domain methods (captured writes); gated methods in Task 11
  tools/write-tools.ts     # registerWriteTools(server, writeService)
  server.ts                # (modify) wire WriteEngine + WriteService + write tools
tests/
  fixtures/
    exercise-def-barbell.json   # a measurement (EXERCISE) with cellTypeConfigs
    snapshot-with-template.json # a snapshot holding one template + folder + exercise def
  ids.test.ts
  envelope.test.ts
  soft-delete.test.ts
  log-builder.test.ts
  entity-builders.test.ts
  edit.test.ts
  folders.test.ts
  write-engine.test.ts
  write-service.test.ts
  write-tools.test.ts
```

---

### Task 1: ID and clock helpers

**Files:**
- Create: `src/write/ids.ts`
- Test: `tests/ids.test.ts`

**Interfaces:**
- Consumes: nothing (`node:crypto`).
- Produces:
  - `newId(): string` — a UUID v4 via `crypto.randomUUID()`.
  - `type Clock = () => string` — returns an ISO-8601 timestamp.
  - `makeClock(now: () => number = Date.now): Clock` — builds a clock from a millisecond source (injectable for tests).

- [ ] **Step 1: Write the failing test**

```typescript
import { describe, it, expect } from "vitest";
import { newId, makeClock } from "../src/write/ids.js";

describe("ids", () => {
  it("newId returns a v4 UUID", () => {
    const id = newId();
    expect(id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
    expect(newId()).not.toBe(id);
  });
  it("makeClock formats the injected millis as ISO-8601", () => {
    const clock = makeClock(() => 1784685666000);
    expect(clock()).toBe("2026-07-22T02:01:06.000Z");
  });
  it("makeClock defaults to Date.now", () => {
    expect(makeClock()()).toMatch(/^\d{4}-\d{2}-\d{2}T/);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/ids.test.ts`
Expected: FAIL — cannot find module `../src/write/ids.js`.

- [ ] **Step 3: Write `src/write/ids.ts`**

```typescript
import { randomUUID } from "node:crypto";

export const newId = (): string => randomUUID();

export type Clock = () => string;

export function makeClock(now: () => number = Date.now): Clock {
  return () => new Date(now()).toISOString();
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run tests/ids.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/write/ids.ts tests/ids.test.ts
git commit -m "feat: write ID + clock helpers"
```

---

### Task 2: HTTP client PUT method

**Files:**
- Modify: `src/http/client.ts`
- Test: `tests/http-client.test.ts` (append cases)

**Interfaces:**
- Consumes: existing `StrongHttpClient` (Task from Phase 1), `BASE_URL`, `CLIENT_HEADERS`.
- Produces: `StrongHttpClient.putUserDoc(userId: string, body: unknown): Promise<void>` — PUTs `/api/users/{userId}` with client headers + `Content-Type: application/json` + bearer; success is 2xx (empty body ignored); on `401` does exactly one `forceRefresh()` + retry; **does NOT retry 5xx or network errors** (a write may have landed — surfacing avoids duplicate mutations); throws `PUT /api/users/{userId} → HTTP <status>` on non-2xx.

- [ ] **Step 1: Write the failing test (append to `tests/http-client.test.ts`)**

```typescript
describe("StrongHttpClient.putUserDoc", () => {
  it("PUTs with bearer + content-type and resolves on 2xx empty body", async () => {
    const fetchImpl = vi.fn(async () => ({ status: 200, text: async () => "" }));
    const client = new StrongHttpClient({ tokenManager: fakeTM(), fetchImpl });
    await expect(client.putUserDoc("u", { id: "u" })).resolves.toBeUndefined();
    const [url, init] = fetchImpl.mock.calls[0];
    expect(url).toContain("/api/users/u");
    expect(init.method).toBe("PUT");
    expect(init.headers["Content-Type"]).toBe("application/json");
    expect(init.headers.Authorization).toMatch(/^Bearer /);
    expect(JSON.parse(init.body)).toEqual({ id: "u" });
  });

  it("refreshes once and retries on 401", async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce({ status: 401, text: async () => "" })
      .mockResolvedValueOnce({ status: 204, text: async () => "" });
    const tm = fakeTM();
    const client = new StrongHttpClient({ tokenManager: tm, fetchImpl });
    await client.putUserDoc("u", {});
    expect(tm.forceRefresh).toHaveBeenCalledTimes(1);
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });

  it("does NOT retry a 500 (write may have landed) and throws with the status", async () => {
    const fetchImpl = vi.fn(async () => ({ status: 500, text: async () => "err" }));
    const client = new StrongHttpClient({ tokenManager: fakeTM(), fetchImpl });
    await expect(client.putUserDoc("u", {})).rejects.toThrow(/HTTP 500/);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });
});
```

(`fakeTM` already exists in this test file from Phase 1; reuse it.)

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/http-client.test.ts`
Expected: FAIL — `putUserDoc` is not a function.

- [ ] **Step 3: Add `putUserDoc` to `src/http/client.ts`**

Insert this method into the `StrongHttpClient` class, immediately after `getJson`:

```typescript
  async putUserDoc(userId: string, body: unknown): Promise<void> {
    const url = `${BASE_URL}/api/users/${userId}`;
    const payload = JSON.stringify(body);
    let token = await this.opts.tokenManager.getAccessToken();
    let refreshed = false;

    for (;;) {
      const init: any = {
        method: "PUT",
        headers: {
          ...CLIENT_HEADERS,
          "Content-Type": "application/json",
          Authorization: `Bearer ${token}`,
        },
        body: payload,
      };
      if (this.dispatcher) init.dispatcher = this.dispatcher;

      const r = await this.opts.fetchImpl(url, init); // network errors propagate (no retry — write may have landed)

      if (r.status === 401 && !refreshed) {
        refreshed = true;
        token = await this.opts.tokenManager.forceRefresh();
        continue;
      }
      if (r.status < 200 || r.status >= 300) {
        throw new Error(`PUT /api/users/${userId} → HTTP ${r.status}`);
      }
      return; // success — body is empty
    }
  }
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run tests/http-client.test.ts`
Expected: PASS (all existing + 3 new cases).

- [ ] **Step 5: Commit**

```bash
git add src/http/client.ts tests/http-client.test.ts
git commit -m "feat: HTTP client putUserDoc (status-code success, no 5xx retry)"
```

---

### Task 3: Envelope builder + routing

**Files:**
- Create: `src/write/envelope.ts`
- Test: `tests/envelope.test.ts`

**Interfaces:**
- Consumes: `COLLECTIONS` (`src/constants.ts`), `CollectionName`/`Entity` (`src/types.ts`).
- Produces:
  - `interface Change { collection: CollectionName; entity: Entity }`
  - `buildEnvelope(userId: string, changes: Change[]): { id: string; strongAnalytics: false; _embedded: Record<CollectionName, Entity[]> }` — every one of the 8 collections is present as an array; changed entities are grouped into their collection; unlisted collections are `[]`.

- [ ] **Step 1: Write the failing test**

```typescript
import { describe, it, expect } from "vitest";
import { buildEnvelope } from "../src/write/envelope.js";

describe("buildEnvelope", () => {
  it("routes each change into its collection; others empty; envelope shape correct", () => {
    const env = buildEnvelope("u", [
      { collection: "log", entity: { id: "w1", logType: "WORKOUT" } },
      { collection: "template", entity: { id: "t1", logType: "TEMPLATE" } },
      { collection: "folder", entity: { id: "f1" } },
    ]);
    expect(env.id).toBe("u");
    expect(env.strongAnalytics).toBe(false);
    expect(env._embedded.log).toEqual([{ id: "w1", logType: "WORKOUT" }]);
    expect(env._embedded.template).toEqual([{ id: "t1", logType: "TEMPLATE" }]);
    expect(env._embedded.folder).toEqual([{ id: "f1" }]);
    // all 8 collections present; the untouched ones are empty arrays
    expect(Object.keys(env._embedded).sort()).toEqual(
      ["folder", "log", "measuredValue", "measurement", "metric", "tag", "template", "widget"].sort(),
    );
    expect(env._embedded.measurement).toEqual([]);
    expect(env._embedded.widget).toEqual([]);
  });

  it("supports multiple entities in one collection", () => {
    const env = buildEnvelope("u", [
      { collection: "measuredValue", entity: { id: "v1" } },
      { collection: "measuredValue", entity: { id: "v2" } },
    ]);
    expect(env._embedded.measuredValue.map((e) => e.id)).toEqual(["v1", "v2"]);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/envelope.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Write `src/write/envelope.ts`**

```typescript
import { COLLECTIONS } from "../constants.js";
import type { CollectionName, Entity } from "../types.js";

export interface Change {
  collection: CollectionName;
  entity: Entity;
}

export function buildEnvelope(
  userId: string,
  changes: Change[],
): { id: string; strongAnalytics: false; _embedded: Record<CollectionName, Entity[]> } {
  const embedded = {} as Record<CollectionName, Entity[]>;
  for (const c of COLLECTIONS) embedded[c] = [];
  for (const { collection, entity } of changes) embedded[collection].push(entity);
  return { id: userId, strongAnalytics: false, _embedded: embedded };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run tests/envelope.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/write/envelope.ts tests/envelope.test.ts
git commit -m "feat: write envelope builder + collection routing"
```

---

### Task 4: Generic soft-delete

**Files:**
- Create: `src/write/soft-delete.ts`
- Test: `tests/soft-delete.test.ts`

**Interfaces:**
- Consumes: `Entity` (`src/types.ts`), `Clock` (`src/write/ids.ts`).
- Produces: `softDelete(entity: Entity, clock: Clock): Entity` — returns a **deep clone** with `isHidden: true` and bumped `lastChanged`. If the clone has `_embedded.cellSetGroup`, cascade `isHidden: true` into every cellSetGroup, every `cellSets[]`, and every `cells[]` (nested case). Flat entities (no cellSetGroup) just get the top-level flip. Does NOT mutate the input.

- [ ] **Step 1: Write the failing test**

```typescript
import { describe, it, expect } from "vitest";
import { softDelete } from "../src/write/soft-delete.js";
import { makeClock } from "../src/write/ids.js";

const clock = makeClock(() => 1784685666000);

describe("softDelete", () => {
  it("flat entity: flips isHidden and bumps lastChanged without mutating input", () => {
    const input = { id: "v1", isHidden: false, value: 90, lastChanged: "2020-01-01T00:00:00.000Z" };
    const out = softDelete(input, clock);
    expect(out.isHidden).toBe(true);
    expect(out.lastChanged).toBe("2026-07-22T02:01:06.000Z");
    expect(out.value).toBe(90); // untouched fields preserved
    expect(input.isHidden).toBe(false); // input not mutated
  });

  it("nested entity: cascades isHidden to log, groups, cellSets, and cells", () => {
    const log = {
      id: "w1", isHidden: false, logType: "WORKOUT",
      _embedded: {
        cellSetGroup: [
          {
            id: "g1", isHidden: false,
            cellSets: [
              { id: "s1", isHidden: false, cells: [{ id: "c1", cellType: "REPS", value: "12", isHidden: false }] },
              { id: "s2", isHidden: false, cells: [{ id: "c2", cellType: "REST_TIMER", value: "85", isHidden: false }] },
            ],
          },
        ],
      },
    };
    const out = softDelete(log, clock);
    expect(out.isHidden).toBe(true);
    const g = (out._embedded as any).cellSetGroup[0];
    expect(g.isHidden).toBe(true);
    expect(g.cellSets[0].isHidden).toBe(true);
    expect(g.cellSets[0].cells[0].isHidden).toBe(true);
    expect(g.cellSets[1].cells[0].isHidden).toBe(true);
    // input untouched
    expect((log._embedded as any).cellSetGroup[0].cellSets[0].cells[0].isHidden).toBe(false);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/soft-delete.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Write `src/write/soft-delete.ts`**

```typescript
import type { Entity } from "../types.js";
import type { Clock } from "./ids.js";

export function softDelete(entity: Entity, clock: Clock): Entity {
  const clone = structuredClone(entity) as any;
  clone.isHidden = true;
  clone.lastChanged = clock();

  const groups = clone._embedded?.cellSetGroup;
  if (Array.isArray(groups)) {
    for (const group of groups) {
      group.isHidden = true;
      const cellSets = Array.isArray(group.cellSets) ? group.cellSets : [];
      for (const cs of cellSets) {
        cs.isHidden = true;
        const cells = Array.isArray(cs.cells) ? cs.cells : [];
        for (const cell of cells) cell.isHidden = true;
      }
    }
  }
  return clone as Entity;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run tests/soft-delete.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/write/soft-delete.ts tests/soft-delete.test.ts
git commit -m "feat: generic soft-delete (nested cascade + flat flip)"
```

---

### Task 5: Log / template builder

**Files:**
- Create: `src/write/log-builder.ts`
- Test: `tests/log-builder.test.ts`, `tests/fixtures/exercise-def-barbell.json`

**Interfaces:**
- Consumes: `newId`/`Clock` (`src/write/ids.ts`), `lbToKg` (`src/units.ts`), `Entity`/`Snapshot` (`src/types.ts`).
- Produces:
  - `interface SetInput { reps: number; weight: number; rpe?: number }` (weight in display units = lb)
  - `interface ExerciseInput { exerciseId: string; sets: SetInput[] }`
  - `interface BuildLogInput { name: string; templateId?: string; exercises: ExerciseInput[] }`
  - `buildLog(kind: "WORKOUT" | "TEMPLATE", input: BuildLogInput, snapshot: Snapshot, deps: { clock: Clock; weightUnit: WeightUnit }): Entity`
    - Emits a `log`/`template` entity: `{ id, logType: kind, name:{custom}, isHidden:false, isArchived:false, access:"PRIVATE", created, lastChanged, _links, _embedded:{cellSetGroup:[…]} }`.
    - `WORKOUT` also gets `startDate`/`endDate` (both = clock()) and, if `templateId` given, `_links.template.href`.
    - For each exercise: look up `snapshot.entities.measurement[exerciseId]`; **throw** if missing. Read its `cellTypeConfigs` (ordered `{cellType,index}`). For each set, emit a working cellSet whose `cells` follow the config order, mapping `REPS`→reps, `RPE`→rpe (null if absent), and the config's weight-type cell → `lbToKg(weight)` stringified; **throw** if the config's weight cell type is unknown (per §4.5 refuse rule — use the weight-type set below). Working cellSets are `isCompleted: (kind==="WORKOUT")`. After each working cellSet, emit a rest-timer cellSet (single `REST_TIMER` cell) using `restSeconds(snapshot, exerciseId)`.
  - Helper (exported for testing): `restSeconds(snapshot: Snapshot, exerciseId: string): string` — `preferences.restTimer[exerciseId] ?? preferences.restTimer[snapshot.userId] ?? 85`, stringified.
- Known weight cell types (module const): `WEIGHT_CELL_TYPES = new Set(["DUMBBELL_WEIGHT","BARBELL_WEIGHT","WEIGHTED_BODYWEIGHT","WEIGHT"])`.

- [ ] **Step 1: Create fixture `tests/fixtures/exercise-def-barbell.json`**

```json
{
  "id": "ex-barbell",
  "isHidden": false,
  "measurementType": "EXERCISE",
  "name": { "custom": "Barbell Bench" },
  "cellTypeConfigs": [
    { "cellType": "BARBELL_WEIGHT", "mandatory": true, "index": 0, "isExponent": false },
    { "cellType": "REPS", "mandatory": true, "index": 1, "isExponent": false },
    { "cellType": "RPE", "mandatory": false, "index": 2, "isExponent": true }
  ]
}
```

- [ ] **Step 2: Write the failing test**

```typescript
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { buildLog, restSeconds } from "../src/write/log-builder.js";
import { makeClock } from "../src/write/ids.js";
import type { Snapshot } from "../src/types.js";

const here = dirname(fileURLToPath(import.meta.url));
const exDef = JSON.parse(readFileSync(join(here, "fixtures", "exercise-def-barbell.json"), "utf8"));

function snap(): Snapshot {
  return {
    userId: "u", continuation: null, syncedAt: null,
    preferences: { restTimer: { u: 90, "ex-barbell": 120 } },
    entities: {
      template: {}, log: {}, measurement: { "ex-barbell": exDef },
      measuredValue: {}, folder: {}, tag: {}, metric: {}, widget: {},
    },
  };
}
const deps = { clock: makeClock(() => 1784685666000), weightUnit: "POUNDS" as const };

describe("buildLog (WORKOUT)", () => {
  it("emits a workout with cellTypeConfig-ordered cells and alternating rest timers", () => {
    const log = buildLog("WORKOUT",
      { name: "Push", templateId: "t1", exercises: [{ exerciseId: "ex-barbell", sets: [{ reps: 5, weight: 135 }, { reps: 5, weight: 135, rpe: 8 }] }] },
      snap(), deps) as any;

    expect(log.logType).toBe("WORKOUT");
    expect(log.name).toEqual({ custom: "Push" });
    expect(log.startDate).toBe("2026-07-22T02:01:06.000Z");
    expect(log.endDate).toBe("2026-07-22T02:01:06.000Z");
    expect(log._links.template.href).toContain("/templates/t1");

    const group = log._embedded.cellSetGroup[0];
    expect(group._links.measurement.href).toContain("/measurements/ex-barbell");
    // 2 working sets + 2 rest timers, strictly alternating
    expect(group.cellSets).toHaveLength(4);
    const [set1, rest1, set2, rest2] = group.cellSets;

    // cells follow config order: BARBELL_WEIGHT, REPS, RPE
    expect(set1.cells.map((c: any) => c.cellType)).toEqual(["BARBELL_WEIGHT", "REPS", "RPE"]);
    expect(set1.isCompleted).toBe(true);
    // 135 lb → kg
    expect(Number(set1.cells[0].value)).toBeCloseTo(135 * 0.45359237, 6);
    expect(set1.cells[1].value).toBe("5");
    expect(set1.cells[2].value).toBeNull(); // rpe omitted → null

    expect(set2.cells[2].value).toBe("8"); // rpe provided

    // rest timers: single REST_TIMER cell, exercise-specific 120s
    expect(rest1.cells).toHaveLength(1);
    expect(rest1.cells[0].cellType).toBe("REST_TIMER");
    expect(rest1.cells[0].value).toBe("120");
    expect(rest2.cells[0].value).toBe("120");
  });

  it("throws when the referenced exercise id is not in the snapshot", () => {
    expect(() =>
      buildLog("WORKOUT", { name: "x", exercises: [{ exerciseId: "missing", sets: [{ reps: 1, weight: 1 }] }] }, snap(), deps),
    ).toThrow(/missing/);
  });
});

describe("buildLog (TEMPLATE)", () => {
  it("has no start/end date and sets are not completed", () => {
    const t = buildLog("TEMPLATE", { name: "PPL", exercises: [{ exerciseId: "ex-barbell", sets: [{ reps: 5, weight: 135 }] }] }, snap(), deps) as any;
    expect(t.logType).toBe("TEMPLATE");
    expect(t.startDate).toBeUndefined();
    expect(t._embedded.cellSetGroup[0].cellSets[0].isCompleted).toBe(false);
  });
});

describe("restSeconds", () => {
  it("prefers exercise-specific, then user default, then 85", () => {
    expect(restSeconds(snap(), "ex-barbell")).toBe("120");
    expect(restSeconds(snap(), "other")).toBe("90");
    const s = snap(); s.preferences = {};
    expect(restSeconds(s, "x")).toBe("85");
  });
});
```

- [ ] **Step 3: Run test to verify it fails**

Run: `npx vitest run tests/log-builder.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 4: Write `src/write/log-builder.ts`**

```typescript
import { newId, type Clock } from "./ids.js";
import { lbToKg, type WeightUnit } from "../units.js";
import type { Entity, Snapshot } from "../types.js";

const WEIGHT_CELL_TYPES = new Set([
  "DUMBBELL_WEIGHT", "BARBELL_WEIGHT", "WEIGHTED_BODYWEIGHT", "WEIGHT",
]);

export interface SetInput { reps: number; weight: number; rpe?: number }
export interface ExerciseInput { exerciseId: string; sets: SetInput[] }
export interface BuildLogInput { name: string; templateId?: string; exercises: ExerciseInput[] }

export function restSeconds(snapshot: Snapshot, exerciseId: string): string {
  const rt = (snapshot.preferences as any)?.restTimer ?? {};
  const secs = rt[exerciseId] ?? rt[snapshot.userId] ?? 85;
  return String(secs);
}

function toKgString(weightDisplay: number, weightUnit: WeightUnit): string {
  return String(weightUnit === "KILOGRAMS" ? weightDisplay : lbToKg(weightDisplay));
}

function cell(cellType: string, value: string | null): Entity {
  return { id: newId(), cellType, value, isHidden: false } as unknown as Entity;
}

export function buildLog(
  kind: "WORKOUT" | "TEMPLATE",
  input: BuildLogInput,
  snapshot: Snapshot,
  deps: { clock: Clock; weightUnit: WeightUnit },
): Entity {
  const { clock, weightUnit } = deps;
  const ts = clock();
  const userId = snapshot.userId;
  const completed = kind === "WORKOUT";

  const cellSetGroup = input.exercises.map((ex) => {
    const def = snapshot.entities.measurement[ex.exerciseId];
    if (!def) throw new Error(`Unknown exercise id "${ex.exerciseId}" (not in snapshot; sync or create it first)`);
    const configs = (Array.isArray(def.cellTypeConfigs) ? (def.cellTypeConfigs as any[]) : [])
      .slice()
      .sort((a, b) => (a.index ?? 0) - (b.index ?? 0));

    const cellSets: Entity[] = [];
    for (const set of ex.sets) {
      const cells = configs.map((cfg) => {
        if (cfg.cellType === "REPS") return cell("REPS", String(set.reps));
        if (cfg.cellType === "RPE") return cell("RPE", set.rpe === undefined ? null : String(set.rpe));
        if (WEIGHT_CELL_TYPES.has(cfg.cellType)) return cell(cfg.cellType, toKgString(set.weight, weightUnit));
        throw new Error(`Refusing to write unknown cell type "${cfg.cellType}" for exercise ${ex.exerciseId}`);
      });
      cellSets.push({ id: newId(), cellSetTag: null, isCompleted: completed, isHidden: false, cells } as unknown as Entity);
      // trailing rest timer for this working set
      cellSets.push({
        id: newId(), cellSetTag: null, isCompleted: completed, isHidden: false,
        cells: [cell("REST_TIMER", restSeconds(snapshot, ex.exerciseId))],
      } as unknown as Entity);
    }

    return {
      id: newId(),
      isHidden: false,
      groupIndex: null,
      _links: { measurement: { href: `/api/users/${userId}/measurements/${ex.exerciseId}` } },
      cellSets,
    } as unknown as Entity;
  });

  const base: any = {
    id: newId(),
    logType: kind,
    name: { custom: input.name },
    isHidden: false,
    isArchived: false,
    access: "PRIVATE",
    isGlobal: false,
    created: ts,
    lastChanged: ts,
    _links: { user: { href: `/api/users/${userId}` } },
    _embedded: { cellSetGroup },
  };
  if (kind === "WORKOUT") {
    base.startDate = ts;
    base.endDate = ts;
    if (input.templateId) {
      base._links.template = { href: `/api/users/${userId}/templates/${input.templateId}` };
    }
  }
  return base as Entity;
}
```

- [ ] **Step 5: Run test to verify it passes**

Run: `npx vitest run tests/log-builder.test.ts`
Expected: PASS (all cases).

- [ ] **Step 6: Commit**

```bash
git add src/write/log-builder.ts tests/log-builder.test.ts tests/fixtures/exercise-def-barbell.json
git commit -m "feat: workout/template log builder (cellTypeConfigs, alternating rest timers)"
```

---

### Task 6: measuredValue + exercise-definition builders

**Files:**
- Create: `src/write/entity-builders.ts`
- Test: `tests/entity-builders.test.ts`

**Interfaces:**
- Consumes: `newId`/`Clock` (`src/write/ids.ts`), `toStoredMeasuredValue`/`WeightUnit` (`src/units.ts`), `Entity` (`src/types.ts`).
- Produces:
  - `buildMeasuredValue(input: { type: string; value: number }, deps: { clock: Clock; weightUnit: WeightUnit }): Entity` — flat `{ id, measurementTypeValue: type, value: <stored>, startDate, created, lastChanged, isHidden:false }`. Uses `toStoredMeasuredValue` (throws on unknown type — the refuse rule).
  - `buildExerciseDefinition(input: { name: string; cellTypeConfigs: { cellType: string; mandatory?: boolean; isExponent?: boolean }[]; notes?: string; tagIds?: string[] }, userId: string, deps: { clock: Clock }): Entity` — flat `measurement` with `measurementType:"EXERCISE"`, `name:{custom}`, `instructions:{custom:notes??""}`, `cellTypeConfigs` re-indexed by array order, `tools:[]`, `_links.tag` from tagIds (`/api/users/{userId}/tags/{tagId}`), `isGlobal:false`, `isHidden:false`, `created`/`lastChanged`.

- [ ] **Step 1: Write the failing test**

```typescript
import { describe, it, expect } from "vitest";
import { buildMeasuredValue, buildExerciseDefinition } from "../src/write/entity-builders.js";
import { makeClock } from "../src/write/ids.js";

const deps = { clock: makeClock(() => 1784685666000), weightUnit: "POUNDS" as const };

describe("buildMeasuredValue", () => {
  it("builds a flat WEIGHT value in kg", () => {
    const v = buildMeasuredValue({ type: "WEIGHT", value: 200 }, deps) as any;
    expect(v.measurementTypeValue).toBe("WEIGHT");
    expect(v.value).toBeCloseTo(90.718474, 6); // 200 lb → kg
    expect(v.isHidden).toBe(false);
    expect(v.startDate).toBe("2026-07-22T02:01:06.000Z");
    expect(v._embedded).toBeUndefined(); // flat, no nesting
  });
  it("BODY_FAT_PERCENTAGE stored as fraction", () => {
    expect((buildMeasuredValue({ type: "BODY_FAT_PERCENTAGE", value: 5 }, deps) as any).value).toBe(0.05);
  });
  it("throws on an unknown measurement type (refuse-on-write)", () => {
    expect(() => buildMeasuredValue({ type: "MYSTERY", value: 1 }, deps)).toThrow(/unknown measurement type/i);
  });
});

describe("buildExerciseDefinition", () => {
  it("builds a flat EXERCISE measurement with re-indexed configs and tag links", () => {
    const m = buildExerciseDefinition(
      { name: "Zercher Squat", cellTypeConfigs: [{ cellType: "BARBELL_WEIGHT", mandatory: true }, { cellType: "REPS", mandatory: true }], notes: "hard", tagIds: ["legs"] },
      "u", deps,
    ) as any;
    expect(m.measurementType).toBe("EXERCISE");
    expect(m.name).toEqual({ custom: "Zercher Squat" });
    expect(m.instructions).toEqual({ custom: "hard" });
    expect(m.cellTypeConfigs.map((c: any) => [c.cellType, c.index])).toEqual([["BARBELL_WEIGHT", 0], ["REPS", 1]]);
    expect(m._links.tag).toEqual([{ href: "/api/users/u/tags/legs" }]);
    expect(m.isHidden).toBe(false);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/entity-builders.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Write `src/write/entity-builders.ts`**

```typescript
import { newId, type Clock } from "./ids.js";
import { toStoredMeasuredValue, type WeightUnit } from "../units.js";
import type { Entity } from "../types.js";

export function buildMeasuredValue(
  input: { type: string; value: number },
  deps: { clock: Clock; weightUnit: WeightUnit },
): Entity {
  const ts = deps.clock();
  return {
    id: newId(),
    measurementTypeValue: input.type,
    value: toStoredMeasuredValue(input.type, input.value, deps.weightUnit),
    startDate: ts,
    created: ts,
    lastChanged: ts,
    isHidden: false,
  } as unknown as Entity;
}

export function buildExerciseDefinition(
  input: {
    name: string;
    cellTypeConfigs: { cellType: string; mandatory?: boolean; isExponent?: boolean }[];
    notes?: string;
    tagIds?: string[];
  },
  userId: string,
  deps: { clock: Clock },
): Entity {
  const ts = deps.clock();
  return {
    id: newId(),
    measurementType: "EXERCISE",
    name: { custom: input.name },
    instructions: { custom: input.notes ?? "" },
    notes: null,
    isGlobal: false,
    isHidden: false,
    tools: [],
    cellTypeConfigs: input.cellTypeConfigs.map((c, index) => ({
      cellType: c.cellType,
      mandatory: c.mandatory ?? false,
      isExponent: c.isExponent ?? false,
      index,
    })),
    _links: { tag: (input.tagIds ?? []).map((t) => ({ href: `/api/users/${userId}/tags/${t}` })) },
    created: ts,
    lastChanged: ts,
  } as unknown as Entity;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run tests/entity-builders.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/write/entity-builders.ts tests/entity-builders.test.ts
git commit -m "feat: measuredValue + exercise-definition builders (flat entities)"
```

---

### Task 7: Full-entity edit helper (byte-for-byte preservation)

**Files:**
- Create: `src/write/edit.ts`
- Test: `tests/edit.test.ts`

**Interfaces:**
- Consumes: `Clock` (`src/write/ids.ts`), `lbToKg`/`WeightUnit` (`src/units.ts`), `Entity` (`src/types.ts`).
- Produces:
  - `editEntityName(entity: Entity, name: string, clock: Clock): Entity` — deep clone, set `name.custom`, bump `lastChanged`; everything else preserved verbatim. (Used by template/exercise rename.)
  - `editSetCells(entity: Entity, edits: { groupIndex: number; setIndex: number; reps?: number; weight?: number; rpe?: number }[], deps: { clock: Clock; weightUnit: WeightUnit }): Entity` — deep clone of a nested log/template; for each edit, locate the working cellSet at `[groupIndex]`'s Nth **working** set (skipping REST_TIMER-only cellSets) and rewrite ONLY the named cell types (`reps`→REPS, `weight`→weight-type cell as kg, `rpe`→RPE); **every other cell keeps its original raw string verbatim**; bump `lastChanged`. Throws if a target group/set index is out of range.

- [ ] **Step 1: Write the failing test**

```typescript
import { describe, it, expect } from "vitest";
import { editEntityName, editSetCells } from "../src/write/edit.js";
import { makeClock } from "../src/write/ids.js";

const clock = makeClock(() => 1784685666000);
const deps = { clock, weightUnit: "POUNDS" as const };

describe("editEntityName", () => {
  it("changes name.custom and bumps lastChanged; preserves the rest", () => {
    const e = { id: "t1", name: { custom: "Old" }, isHidden: false, extra: 1, lastChanged: "2020-01-01T00:00:00.000Z" };
    const out = editEntityName(e, "New", clock) as any;
    expect(out.name.custom).toBe("New");
    expect(out.lastChanged).toBe("2026-07-22T02:01:06.000Z");
    expect(out.extra).toBe(1);
    expect(e.name.custom).toBe("Old"); // input untouched
  });
});

describe("editSetCells", () => {
  const log = () => ({
    id: "w1", logType: "WORKOUT", isHidden: false, lastChanged: "2020-01-01T00:00:00.000Z",
    _embedded: { cellSetGroup: [{
      id: "g1",
      cellSets: [
        { id: "s1", cells: [
          { id: "c1", cellType: "BARBELL_WEIGHT", value: "13.6077711", isHidden: false }, // 30 lb, raw
          { id: "c2", cellType: "REPS", value: "12", isHidden: false },
          { id: "c3", cellType: "RPE", value: null, isHidden: false },
        ] },
        { id: "r1", cells: [{ id: "c4", cellType: "REST_TIMER", value: "85", isHidden: false }] },
        { id: "s2", cells: [
          { id: "c5", cellType: "BARBELL_WEIGHT", value: "18.143694800000002", isHidden: false }, // 40 lb, raw
          { id: "c6", cellType: "REPS", value: "10", isHidden: false },
          { id: "c7", cellType: "RPE", value: null, isHidden: false },
        ] },
      ],
    }] },
  });

  it("rewrites only the edited cells; untouched cells keep their raw strings verbatim", () => {
    const out = editSetCells(log(), [{ groupIndex: 0, setIndex: 0, reps: 8 }], deps) as any;
    const cells = out._embedded.cellSetGroup[0].cellSets[0].cells;
    expect(cells[1].value).toBe("8"); // reps edited
    expect(cells[0].value).toBe("13.6077711"); // weight NOT round-tripped — byte-for-byte
    expect(cells[2].value).toBeNull();
    // second working set entirely untouched, including its raw FP weight
    const set2 = out._embedded.cellSetGroup[0].cellSets[2].cells;
    expect(set2[0].value).toBe("18.143694800000002");
    expect(out.lastChanged).toBe("2026-07-22T02:01:06.000Z");
  });

  it("edits weight of the SECOND working set (skipping the rest-timer cellSet) and converts lb→kg", () => {
    const out = editSetCells(log(), [{ groupIndex: 0, setIndex: 1, weight: 135 }], deps) as any;
    const set2 = out._embedded.cellSetGroup[0].cellSets[2].cells;
    expect(Number(set2[0].value)).toBeCloseTo(135 * 0.45359237, 6);
    expect(set2[1].value).toBe("10"); // reps untouched
  });

  it("throws on an out-of-range set index", () => {
    expect(() => editSetCells(log(), [{ groupIndex: 0, setIndex: 5, reps: 1 }], deps)).toThrow(/range/i);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/edit.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Write `src/write/edit.ts`**

```typescript
import type { Clock } from "./ids.js";
import { lbToKg, type WeightUnit } from "../units.js";
import type { Entity } from "../types.js";

const WEIGHT_CELL_TYPES = new Set([
  "DUMBBELL_WEIGHT", "BARBELL_WEIGHT", "WEIGHTED_BODYWEIGHT", "WEIGHT",
]);

export function editEntityName(entity: Entity, name: string, clock: Clock): Entity {
  const clone = structuredClone(entity) as any;
  clone.name = { ...(clone.name ?? {}), custom: name };
  clone.lastChanged = clock();
  return clone as Entity;
}

interface SetEdit { groupIndex: number; setIndex: number; reps?: number; weight?: number; rpe?: number }

function isRestOnly(cellSet: any): boolean {
  const cells = Array.isArray(cellSet?.cells) ? cellSet.cells : [];
  return cells.length > 0 && cells.every((c: any) => c.cellType === "REST_TIMER");
}

export function editSetCells(
  entity: Entity,
  edits: SetEdit[],
  deps: { clock: Clock; weightUnit: WeightUnit },
): Entity {
  const clone = structuredClone(entity) as any;
  const groups = clone._embedded?.cellSetGroup ?? [];

  for (const edit of edits) {
    const group = groups[edit.groupIndex];
    if (!group) throw new Error(`group index ${edit.groupIndex} out of range`);
    const workingSets = (group.cellSets ?? []).filter((cs: any) => !isRestOnly(cs));
    const target = workingSets[edit.setIndex];
    if (!target) throw new Error(`working set index ${edit.setIndex} out of range`);

    for (const cell of target.cells ?? []) {
      if (edit.reps !== undefined && cell.cellType === "REPS") cell.value = String(edit.reps);
      else if (edit.rpe !== undefined && cell.cellType === "RPE") cell.value = String(edit.rpe);
      else if (edit.weight !== undefined && WEIGHT_CELL_TYPES.has(cell.cellType)) {
        cell.value = String(deps.weightUnit === "KILOGRAMS" ? edit.weight : lbToKg(edit.weight));
      }
      // any cell not matched above keeps its original raw value verbatim
    }
  }
  clone.lastChanged = deps.clock();
  return clone as Entity;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run tests/edit.test.ts`
Expected: PASS (all cases).

- [ ] **Step 5: Commit**

```bash
git add src/write/edit.ts tests/edit.test.ts
git commit -m "feat: full-entity edit helpers (byte-for-byte cell preservation)"
```

---

### Task 8: Folder membership helpers

**Files:**
- Create: `src/write/folders.ts`
- Test: `tests/folders.test.ts`

**Interfaces:**
- Consumes: `Clock` (`src/write/ids.ts`), `Entity`/`Snapshot` (`src/types.ts`).
- Produces:
  - `defaultFolder(snapshot: Snapshot): Entity | undefined` — the folder whose id ends with `-my-templates`, else the first visible folder.
  - `templateHref(userId: string, templateId: string): string` → `/api/users/{userId}/templates/{templateId}`.
  - `addTemplateToFolder(folder: Entity, userId: string, templateId: string, clock: Clock): Entity` — deep clone; append `{href}` to `_links.template` (create the array if absent); bump `lastChanged`. Idempotent (no duplicate href).
  - `removeTemplateFromFolder(folder: Entity, userId: string, templateId: string, clock: Clock): Entity` — deep clone; drop the matching href; bump `lastChanged`.
  - `findFolderContaining(snapshot: Snapshot, userId: string, templateId: string): Entity | undefined`.

- [ ] **Step 1: Write the failing test**

```typescript
import { describe, it, expect } from "vitest";
import { defaultFolder, addTemplateToFolder, removeTemplateFromFolder, findFolderContaining } from "../src/write/folders.js";
import { makeClock } from "../src/write/ids.js";
import type { Snapshot } from "../src/types.js";

const clock = makeClock(() => 1784685666000);

function snap(): Snapshot {
  return {
    userId: "u", continuation: null, syncedAt: null, preferences: {},
    entities: {
      template: {}, log: {}, measurement: {}, measuredValue: {},
      folder: {
        "u-my-templates": { id: "u-my-templates", isHidden: false, name: { en: "My Templates" }, _links: { template: [{ href: "/api/users/u/templates/t0" }] } },
      },
      tag: {}, metric: {}, widget: {},
    },
  };
}

describe("folders", () => {
  it("defaultFolder picks the -my-templates folder", () => {
    expect(defaultFolder(snap())!.id).toBe("u-my-templates");
  });
  it("addTemplateToFolder appends the href without duplicating", () => {
    const f = snap().entities.folder["u-my-templates"];
    const out = addTemplateToFolder(f, "u", "t1", clock) as any;
    expect(out._links.template.map((l: any) => l.href)).toEqual([
      "/api/users/u/templates/t0", "/api/users/u/templates/t1",
    ]);
    // idempotent
    const again = addTemplateToFolder(out, "u", "t1", clock) as any;
    expect(again._links.template).toHaveLength(2);
    expect(f._links.template).toHaveLength(1); // input untouched
  });
  it("removeTemplateFromFolder drops the href", () => {
    const f = snap().entities.folder["u-my-templates"];
    const out = removeTemplateFromFolder(f, "u", "t0", clock) as any;
    expect(out._links.template).toEqual([]);
  });
  it("findFolderContaining locates the folder holding a template link", () => {
    expect(findFolderContaining(snap(), "u", "t0")!.id).toBe("u-my-templates");
    expect(findFolderContaining(snap(), "u", "nope")).toBeUndefined();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/folders.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Write `src/write/folders.ts`**

```typescript
import type { Clock } from "./ids.js";
import type { Entity, Snapshot } from "../types.js";

export const templateHref = (userId: string, templateId: string): string =>
  `/api/users/${userId}/templates/${templateId}`;

function visibleFolders(snapshot: Snapshot): Entity[] {
  return Object.values(snapshot.entities.folder).filter((f) => f.isHidden !== true);
}

export function defaultFolder(snapshot: Snapshot): Entity | undefined {
  const folders = visibleFolders(snapshot);
  return folders.find((f) => f.id.endsWith("-my-templates")) ?? folders[0];
}

function links(folder: any): { href: string }[] {
  const l = folder._links?.template;
  return Array.isArray(l) ? l : [];
}

export function addTemplateToFolder(folder: Entity, userId: string, templateId: string, clock: Clock): Entity {
  const clone = structuredClone(folder) as any;
  const href = templateHref(userId, templateId);
  const current = links(clone);
  if (!current.some((l) => l.href === href)) current.push({ href });
  clone._links = { ...(clone._links ?? {}), template: current };
  clone.lastChanged = clock();
  return clone as Entity;
}

export function removeTemplateFromFolder(folder: Entity, userId: string, templateId: string, clock: Clock): Entity {
  const clone = structuredClone(folder) as any;
  const href = templateHref(userId, templateId);
  clone._links = { ...(clone._links ?? {}), template: links(clone).filter((l) => l.href !== href) };
  clone.lastChanged = clock();
  return clone as Entity;
}

export function findFolderContaining(snapshot: Snapshot, userId: string, templateId: string): Entity | undefined {
  const href = templateHref(userId, templateId);
  return visibleFolders(snapshot).find((f) => links(f).some((l) => l.href === href));
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run tests/folders.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/write/folders.ts tests/folders.test.ts
git commit -m "feat: folder membership helpers (add/remove template links)"
```

---

### Task 9: Write engine (serialized mutation protocol)

**Files:**
- Create: `src/write/write-engine.ts`
- Test: `tests/write-engine.test.ts`

**Interfaces:**
- Consumes: `buildEnvelope`/`Change` (`src/write/envelope.ts`), `Snapshot` (`src/types.ts`).
- Produces:
  - `interface WriteDeps { userId: string; refresh: () => Promise<Snapshot>; put: (envelope: unknown) => Promise<void>; persist: (snapshot: Snapshot) => Promise<void> }`
  - `interface BuildResult<T> { changes: Change[]; summary: T }`
  - `class WriteEngine { constructor(deps: WriteDeps); write<T>(build: (snapshot: Snapshot) => BuildResult<T>): Promise<T> }`
    - **Serialized:** all `write()` calls run one at a time via an internal promise queue; a failed write does not block the next.
    - Per call: `refresh()` (delta-sync, returns current in-memory snapshot) → `build(snapshot)` → `buildEnvelope(userId, changes)` → `put(envelope)` → on success apply each change into `snapshot.entities[collection][entity.id]` and `persist(snapshot)` → return `summary`. If `put` throws, the snapshot is NOT mutated and the error propagates.

- [ ] **Step 1: Write the failing test**

```typescript
import { describe, it, expect, vi } from "vitest";
import { WriteEngine } from "../src/write/write-engine.js";
import type { Snapshot } from "../src/types.js";

function snap(): Snapshot {
  return {
    userId: "u", continuation: null, syncedAt: null, preferences: {},
    entities: { template: {}, log: {}, measurement: {}, measuredValue: {}, folder: {}, tag: {}, metric: {}, widget: {} },
  };
}

function deps(overrides: Partial<any> = {}) {
  const snapshot = snap();
  return {
    snapshot,
    userId: "u",
    refresh: vi.fn(async () => snapshot),
    put: vi.fn(async () => {}),
    persist: vi.fn(async () => {}),
    ...overrides,
  };
}

describe("WriteEngine", () => {
  it("refreshes, PUTs the envelope, applies changes to the snapshot, and persists", async () => {
    const d = deps();
    const engine = new WriteEngine(d);
    const summary = await engine.write((s) => {
      expect(d.refresh).toHaveBeenCalled(); // refresh ran before build
      return { changes: [{ collection: "log", entity: { id: "w1", logType: "WORKOUT" } }], summary: { id: "w1" } };
    });
    expect(summary).toEqual({ id: "w1" });
    expect(d.put).toHaveBeenCalledTimes(1);
    const envelope = d.put.mock.calls[0][0];
    expect(envelope._embedded.log[0].id).toBe("w1");
    expect(d.snapshot.entities.log["w1"]).toEqual({ id: "w1", logType: "WORKOUT" }); // applied
    expect(d.persist).toHaveBeenCalledWith(d.snapshot);
  });

  it("does NOT mutate the snapshot or persist when the PUT fails", async () => {
    const d = deps({ put: vi.fn(async () => { throw new Error("PUT /api/users/u → HTTP 500"); }) });
    const engine = new WriteEngine(d);
    await expect(engine.write(() => ({ changes: [{ collection: "log", entity: { id: "w1" } }], summary: 1 }))).rejects.toThrow(/HTTP 500/);
    expect(d.snapshot.entities.log["w1"]).toBeUndefined();
    expect(d.persist).not.toHaveBeenCalled();
  });

  it("serializes concurrent writes (no interleave) and a failure doesn't block the next", async () => {
    const order: string[] = [];
    const d = deps({ put: vi.fn(async () => { order.push("put"); }) });
    const engine = new WriteEngine(d);
    const a = engine.write(() => { order.push("build-a"); return { changes: [], summary: "a" }; });
    const b = engine.write(() => { order.push("build-b"); return { changes: [], summary: "b" }; });
    await Promise.all([a, b]);
    // a fully completes (build then put) before b builds
    expect(order).toEqual(["build-a", "put", "build-b", "put"]);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/write-engine.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Write `src/write/write-engine.ts`**

```typescript
import { buildEnvelope, type Change } from "./envelope.js";
import type { Snapshot } from "../types.js";

export interface WriteDeps {
  userId: string;
  refresh: () => Promise<Snapshot>;
  put: (envelope: unknown) => Promise<void>;
  persist: (snapshot: Snapshot) => Promise<void>;
}

export interface BuildResult<T> {
  changes: Change[];
  summary: T;
}

export class WriteEngine {
  private tail: Promise<unknown> = Promise.resolve();
  constructor(private readonly deps: WriteDeps) {}

  write<T>(build: (snapshot: Snapshot) => BuildResult<T>): Promise<T> {
    const run = this.tail.then(
      () => this.runOne(build),
      () => this.runOne(build), // prior failure must not block this write
    );
    this.tail = run.then(() => {}, () => {}); // swallow so the queue keeps moving
    return run;
  }

  private async runOne<T>(build: (snapshot: Snapshot) => BuildResult<T>): Promise<T> {
    const snapshot = await this.deps.refresh(); // delta-sync; cross-links fresh
    const { changes, summary } = build(snapshot);
    const envelope = buildEnvelope(this.deps.userId, changes);
    await this.deps.put(envelope); // throws on non-2xx → snapshot untouched below
    for (const { collection, entity } of changes) {
      snapshot.entities[collection][entity.id] = entity; // idempotent replace by id
    }
    await this.deps.persist(snapshot);
    return summary;
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run tests/write-engine.test.ts`
Expected: PASS (all 3 cases).

- [ ] **Step 5: Commit**

```bash
git add src/write/write-engine.ts tests/write-engine.test.ts
git commit -m "feat: serialized write engine (refresh -> build -> PUT -> apply -> persist)"
```

---

### Task 10: Write service + tools + server wiring

**Files:**
- Create: `src/services/write-service.ts`, `src/tools/write-tools.ts`
- Modify: `src/server.ts`
- Test: `tests/write-service.test.ts`, `tests/write-tools.test.ts`

**Interfaces:**
- Consumes: `WriteEngine`/`BuildResult` (Task 9); `buildLog` (Task 5); `softDelete` (Task 4); `buildMeasuredValue`/`buildExerciseDefinition` (Task 6); `editEntityName`/`editSetCells` (Task 7); folder helpers (Task 8); `newId`/`Clock` (Task 1); `Change` (Task 3); `Snapshot`/`Entity` (types); `WeightUnit` (units); MCP `McpServer` + `zod`.
- Produces:
  - `class WriteService` — constructed with `{ engine: WriteEngine; getWeightUnit: () => WeightUnit; clock: Clock; userId: string }`. Methods (each returns a small summary object; each uses `engine.write`):
    - `logWorkout(input: BuildLogInput): Promise<{ id: string; name: string; exercises: number }>`
    - `deleteWorkout(id: string): Promise<{ id: string; deleted: true }>` — snapshot lookup in `log`; throw if missing/hidden; `softDelete`.
    - `createTemplate(input: BuildLogInput & { folderId?: string }): Promise<{ id: string; name: string }>` — build template; resolve folder (`folderId` or `defaultFolder`); `addTemplateToFolder`; changes = [template, folder?].
    - `updateTemplateName(id: string, name: string): Promise<{ id: string }>` — `editEntityName` on the `template` entity.
    - `deleteTemplate(id: string): Promise<{ id: string; deleted: true }>` — `softDelete` the template; `findFolderContaining` → `removeTemplateFromFolder`; changes = [template, folder?].
    - `logMeasurement(input: { type: string; value: number }): Promise<{ id: string; type: string }>` — `buildMeasuredValue`.
    - `createExercise(input): Promise<{ id: string; name: string }>` — `buildExerciseDefinition`.
    - `updateExerciseName(id: string, name: string): Promise<{ id: string }>` — `editEntityName` on the `measurement` entity.
    - `archiveExercise(id: string): Promise<{ id: string; archived: true }>` — `softDelete` (flat) the `measurement` entity.
  - `registerWriteTools(server: McpServer, service: WriteService): void` — registers: `strong_log_workout`, `strong_delete_workout`, `strong_create_template`, `strong_update_template`, `strong_delete_template`, `strong_log_measurement`, `strong_create_exercise`, `strong_update_exercise`, `strong_archive_exercise`. Each handler validates a zod schema, calls the service, returns `{ content: [{ type:"text", text: JSON.stringify(result) }] }`.
  - `buildServer` (modified): construct a `WriteEngine` whose `refresh` runs `engine.sync()` and returns the swapped in-memory snapshot, `put` = `http.putUserDoc(userId, …)`, `persist` = `snapshotStore.save`; construct `WriteService`; call `registerWriteTools`.

- [ ] **Step 1: Write the failing service test**

```typescript
import { describe, it, expect, vi } from "vitest";
import { WriteService } from "../src/services/write-service.js";
import { WriteEngine } from "../src/write/write-engine.js";
import { makeClock } from "../src/write/ids.js";
import type { Snapshot } from "../src/types.js";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));
const exDef = JSON.parse(readFileSync(join(here, "fixtures", "exercise-def-barbell.json"), "utf8"));

function makeSnap(): Snapshot {
  return {
    userId: "u", continuation: null, syncedAt: null,
    preferences: { restTimer: { u: 85 } },
    entities: {
      template: {}, log: {}, measurement: { "ex-barbell": exDef }, measuredValue: {},
      folder: { "u-my-templates": { id: "u-my-templates", isHidden: false, _links: { template: [] } } },
      tag: {}, metric: {}, widget: {},
    },
  };
}

function makeService() {
  const snapshot = makeSnap();
  const put = vi.fn(async () => {});
  const engine = new WriteEngine({
    userId: "u",
    refresh: async () => snapshot,
    put,
    persist: async () => {},
  });
  const service = new WriteService({ engine, getWeightUnit: () => "POUNDS", clock: makeClock(() => 1784685666000), userId: "u" });
  return { service, snapshot, put };
}

describe("WriteService.logWorkout", () => {
  it("logs a workout into _embedded.log and applies it to the snapshot", async () => {
    const { service, snapshot, put } = makeService();
    const res = await service.logWorkout({ name: "Push", exercises: [{ exerciseId: "ex-barbell", sets: [{ reps: 5, weight: 135 }] }] });
    expect(res.name).toBe("Push");
    const env = put.mock.calls[0][0];
    expect(env._embedded.log).toHaveLength(1);
    expect(env._embedded.log[0].logType).toBe("WORKOUT");
    expect(Object.keys(snapshot.entities.log)).toContain(res.id);
  });
});

describe("WriteService.createTemplate + deleteTemplate", () => {
  it("createTemplate writes template + updated folder link", async () => {
    const { service, put } = makeService();
    const res = await service.createTemplate({ name: "PPL", exercises: [{ exerciseId: "ex-barbell", sets: [{ reps: 5, weight: 135 }] }] });
    const env = put.mock.calls[0][0];
    expect(env._embedded.template[0].id).toBe(res.id);
    expect(env._embedded.folder[0]._links.template.some((l: any) => l.href.endsWith(`/templates/${res.id}`))).toBe(true);
  });

  it("deleteTemplate soft-deletes and unlinks from its folder", async () => {
    const { service, snapshot, put } = makeService();
    // seed a template + folder link
    snapshot.entities.template["t1"] = { id: "t1", logType: "TEMPLATE", isHidden: false, _embedded: { cellSetGroup: [] } };
    snapshot.entities.folder["u-my-templates"]._links = { template: [{ href: "/api/users/u/templates/t1" }] };
    const res = await service.deleteTemplate("t1");
    expect(res.deleted).toBe(true);
    const env = put.mock.calls[0][0];
    expect(env._embedded.template[0].isHidden).toBe(true);
    expect(env._embedded.folder[0]._links.template).toEqual([]);
  });
});

describe("WriteService.logMeasurement / archiveExercise", () => {
  it("logs a body measurement", async () => {
    const { service, put } = makeService();
    await service.logMeasurement({ type: "WEIGHT", value: 200 });
    expect(put.mock.calls[0][0]._embedded.measuredValue[0].measurementTypeValue).toBe("WEIGHT");
  });
  it("refuses an unknown measurement type", async () => {
    const { service } = makeService();
    await expect(service.logMeasurement({ type: "MYSTERY", value: 1 })).rejects.toThrow(/unknown measurement type/i);
  });
  it("archiveExercise flips isHidden on the measurement", async () => {
    const { service, snapshot, put } = makeService();
    const res = await service.archiveExercise("ex-barbell");
    expect(res.archived).toBe(true);
    expect(put.mock.calls[0][0]._embedded.measurement[0].isHidden).toBe(true);
    void snapshot;
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/write-service.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Write `src/services/write-service.ts`**

```typescript
import { WriteEngine } from "../write/write-engine.js";
import type { Change } from "../write/envelope.js";
import { buildLog, type BuildLogInput } from "../write/log-builder.js";
import { softDelete } from "../write/soft-delete.js";
import { buildMeasuredValue, buildExerciseDefinition } from "../write/entity-builders.js";
import { editEntityName } from "../write/edit.js";
import { defaultFolder, addTemplateToFolder, removeTemplateFromFolder, findFolderContaining } from "../write/folders.js";
import type { Clock } from "../write/ids.js";
import type { WeightUnit } from "../units.js";
import type { Entity, Snapshot } from "../types.js";

interface Options {
  engine: WriteEngine;
  getWeightUnit: () => WeightUnit;
  clock: Clock;
  userId: string;
}

export interface CreateExerciseInput {
  name: string;
  cellTypeConfigs: { cellType: string; mandatory?: boolean; isExponent?: boolean }[];
  notes?: string;
  tagIds?: string[];
}

function requireVisible(snapshot: Snapshot, collection: "log" | "template" | "measurement", id: string): Entity {
  const e = snapshot.entities[collection][id];
  if (!e || e.isHidden === true) throw new Error(`No ${collection} with id "${id}" in the current snapshot`);
  return e;
}

export class WriteService {
  constructor(private readonly opts: Options) {}
  private get deps() {
    return { clock: this.opts.clock, weightUnit: this.opts.getWeightUnit() };
  }

  logWorkout(input: BuildLogInput) {
    return this.opts.engine.write((snapshot) => {
      const log = buildLog("WORKOUT", input, snapshot, this.deps);
      return { changes: [{ collection: "log", entity: log }], summary: { id: log.id, name: input.name, exercises: input.exercises.length } };
    });
  }

  deleteWorkout(id: string) {
    return this.opts.engine.write((snapshot) => {
      const log = requireVisible(snapshot, "log", id);
      return { changes: [{ collection: "log", entity: softDelete(log, this.opts.clock) }], summary: { id, deleted: true as const } };
    });
  }

  createTemplate(input: BuildLogInput & { folderId?: string }) {
    return this.opts.engine.write((snapshot) => {
      const template = buildLog("TEMPLATE", input, snapshot, this.deps);
      const changes: Change[] = [{ collection: "template", entity: template }];
      const folder = input.folderId ? snapshot.entities.folder[input.folderId] : defaultFolder(snapshot);
      if (folder) changes.push({ collection: "folder", entity: addTemplateToFolder(folder, this.opts.userId, template.id, this.opts.clock) });
      return { changes, summary: { id: template.id, name: input.name } };
    });
  }

  updateTemplateName(id: string, name: string) {
    return this.opts.engine.write((snapshot) => {
      const t = requireVisible(snapshot, "template", id);
      return { changes: [{ collection: "template", entity: editEntityName(t, name, this.opts.clock) }], summary: { id } };
    });
  }

  deleteTemplate(id: string) {
    return this.opts.engine.write((snapshot) => {
      const t = requireVisible(snapshot, "template", id);
      const changes: Change[] = [{ collection: "template", entity: softDelete(t, this.opts.clock) }];
      const folder = findFolderContaining(snapshot, this.opts.userId, id);
      if (folder) changes.push({ collection: "folder", entity: removeTemplateFromFolder(folder, this.opts.userId, id, this.opts.clock) });
      return { changes, summary: { id, deleted: true as const } };
    });
  }

  logMeasurement(input: { type: string; value: number }) {
    return this.opts.engine.write(() => {
      const v = buildMeasuredValue(input, this.deps); // throws on unknown type
      return { changes: [{ collection: "measuredValue", entity: v }], summary: { id: v.id, type: input.type } };
    });
  }

  createExercise(input: CreateExerciseInput) {
    return this.opts.engine.write(() => {
      const m = buildExerciseDefinition(input, this.opts.userId, { clock: this.opts.clock });
      return { changes: [{ collection: "measurement", entity: m }], summary: { id: m.id, name: input.name } };
    });
  }

  updateExerciseName(id: string, name: string) {
    return this.opts.engine.write((snapshot) => {
      const m = requireVisible(snapshot, "measurement", id);
      return { changes: [{ collection: "measurement", entity: editEntityName(m, name, this.opts.clock) }], summary: { id } };
    });
  }

  archiveExercise(id: string) {
    return this.opts.engine.write((snapshot) => {
      const m = requireVisible(snapshot, "measurement", id);
      return { changes: [{ collection: "measurement", entity: softDelete(m, this.opts.clock) }], summary: { id, archived: true as const } };
    });
  }
}
```

- [ ] **Step 4: Run the service test**

Run: `npx vitest run tests/write-service.test.ts`
Expected: PASS.

- [ ] **Step 5: Write the failing tools test `tests/write-tools.test.ts`**

```typescript
import { describe, it, expect, vi } from "vitest";
import { registerWriteTools } from "../src/tools/write-tools.js";

function fakeServer() {
  const handlers: Record<string, Function> = {};
  return { handlers, registerTool(name: string, _def: unknown, handler: Function) { handlers[name] = handler; } };
}

const service = {
  logWorkout: vi.fn(async () => ({ id: "w1", name: "Push", exercises: 1 })),
  deleteWorkout: vi.fn(async () => ({ id: "w1", deleted: true })),
  createTemplate: vi.fn(async () => ({ id: "t1", name: "PPL" })),
  updateTemplateName: vi.fn(async () => ({ id: "t1" })),
  deleteTemplate: vi.fn(async () => ({ id: "t1", deleted: true })),
  logMeasurement: vi.fn(async () => ({ id: "v1", type: "WEIGHT" })),
  createExercise: vi.fn(async () => ({ id: "m1", name: "X" })),
  updateExerciseName: vi.fn(async () => ({ id: "m1" })),
  archiveExercise: vi.fn(async () => ({ id: "m1", archived: true })),
} as any;

describe("registerWriteTools", () => {
  it("registers all 9 captured write tools", () => {
    const s = fakeServer();
    registerWriteTools(s as any, service);
    expect(Object.keys(s.handlers).sort()).toEqual([
      "strong_archive_exercise", "strong_create_exercise", "strong_create_template",
      "strong_delete_template", "strong_delete_workout", "strong_log_measurement",
      "strong_log_workout", "strong_update_exercise", "strong_update_template",
    ].sort());
  });

  it("strong_log_workout forwards args and returns text content", async () => {
    const s = fakeServer();
    registerWriteTools(s as any, service);
    const out = await s.handlers["strong_log_workout"]({ name: "Push", exercises: [{ exerciseId: "ex", sets: [{ reps: 5, weight: 135 }] }] });
    expect(service.logWorkout).toHaveBeenCalled();
    expect(JSON.parse(out.content[0].text)).toEqual({ id: "w1", name: "Push", exercises: 1 });
  });
});
```

- [ ] **Step 6: Run tools test to verify it fails**

Run: `npx vitest run tests/write-tools.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 7: Write `src/tools/write-tools.ts`**

```typescript
import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { WriteService } from "../services/write-service.js";

const text = (data: unknown) => ({ content: [{ type: "text" as const, text: JSON.stringify(data, null, 2) }] });

const setSchema = { reps: z.number().int().positive(), weight: z.number().nonnegative(), rpe: z.number().optional() };
const exerciseSchema = { exerciseId: z.string(), sets: z.array(z.object(setSchema)).min(1) };
const cellConfigSchema = { cellType: z.string(), mandatory: z.boolean().optional(), isExponent: z.boolean().optional() };

export function registerWriteTools(server: McpServer, service: WriteService): void {
  server.registerTool("strong_log_workout",
    { description: "Log a completed workout. Exercises referenced by definition id (use strong_list_exercises). Weights in your display unit.",
      inputSchema: { name: z.string(), templateId: z.string().optional(), exercises: z.array(z.object(exerciseSchema)).min(1) } },
    async (a: any) => text(await service.logWorkout(a)));

  server.registerTool("strong_delete_workout",
    { description: "Soft-delete a logged workout by id.", inputSchema: { id: z.string() } },
    async (a: any) => text(await service.deleteWorkout(a.id)));

  server.registerTool("strong_create_template",
    { description: "Create a workout template. Optional folderId (defaults to My Templates).",
      inputSchema: { name: z.string(), folderId: z.string().optional(), exercises: z.array(z.object(exerciseSchema)).min(1) } },
    async (a: any) => text(await service.createTemplate(a)));

  server.registerTool("strong_update_template",
    { description: "Rename a template by id.", inputSchema: { id: z.string(), name: z.string() } },
    async (a: any) => text(await service.updateTemplateName(a.id, a.name)));

  server.registerTool("strong_delete_template",
    { description: "Soft-delete a template by id (also unlinks it from its folder).", inputSchema: { id: z.string() } },
    async (a: any) => text(await service.deleteTemplate(a.id)));

  server.registerTool("strong_log_measurement",
    { description: "Log a body measurement. type e.g. WEIGHT (display unit), BODY_FAT_PERCENTAGE (whole %), CALORIC_INTAKE (kcal).",
      inputSchema: { type: z.string(), value: z.number() } },
    async (a: any) => text(await service.logMeasurement(a)));

  server.registerTool("strong_create_exercise",
    { description: "Create a custom exercise definition.",
      inputSchema: { name: z.string(), cellTypeConfigs: z.array(z.object(cellConfigSchema)).min(1), notes: z.string().optional(), tagIds: z.array(z.string()).optional() } },
    async (a: any) => text(await service.createExercise(a)));

  server.registerTool("strong_update_exercise",
    { description: "Rename a custom exercise by id.", inputSchema: { id: z.string(), name: z.string() } },
    async (a: any) => text(await service.updateExerciseName(a.id, a.name)));

  server.registerTool("strong_archive_exercise",
    { description: "Archive (soft-delete) a custom exercise by id.", inputSchema: { id: z.string() } },
    async (a: any) => text(await service.archiveExercise(a.id)));
}
```

- [ ] **Step 8: Wire into `src/server.ts`**

Add imports near the existing ones:

```typescript
import { WriteEngine } from "./write/write-engine.js";
import { WriteService } from "./services/write-service.js";
import { registerWriteTools } from "./tools/write-tools.js";
import { makeClock } from "./write/ids.js";
```

Then, inside `buildServer`, after the `sync` closure and before creating the `McpServer`, add:

```typescript
  const writeEngine = new WriteEngine({
    userId: config.userId,
    refresh: async () => {
      await sync();      // delta-sync; swaps the in-memory `snapshot`
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
```

And after `registerReadTools(server, { service, sync });` add:

```typescript
  registerWriteTools(server, writeService);
```

(No change to `buildServer`'s return type.)

- [ ] **Step 9: Run tools test + full suite + typecheck + build**

Run: `npx vitest run tests/write-tools.test.ts && npm test && npm run typecheck && npm run build`
Expected: write-tools PASS; full suite PASS; typecheck clean; `dist/` built.

- [ ] **Step 10: Commit**

```bash
git add src/services/write-service.ts src/tools/write-tools.ts src/server.ts tests/write-service.test.ts tests/write-tools.test.ts
git commit -m "feat: write service + tools + server wiring (captured writes)"
```

---

### Task 11 (GATED): workout update + measuredValue delete

> ⚠️ **DO NOT IMPLEMENT until the two PUTs are captured.** These are the only two write shapes not observed in Proxyman (spec §2). Capture each real PUT from the Strong app, save it as a golden fixture, and confirm the shape matches the assumptions below **before** writing code. If a capture contradicts an assumption, update the assumption and the code to match the capture — the capture is authoritative.

**Prerequisite (human, before this task):**
1. In the Strong app with Proxyman running: edit a set in an existing **logged workout** (change a weight/reps) → capture the `PUT /api/users/{id}` → save as `tests/fixtures/workout-update.json`.
2. Delete a **body measurement** (bodyweight entry) → capture the PUT → save as `tests/fixtures/measured-value-delete.json`.

**Files:**
- Modify: `src/services/write-service.ts` (add `updateWorkoutSets`, `deleteMeasurement`)
- Modify: `src/tools/write-tools.ts` (add `strong_update_workout`, `strong_delete_measurement`)
- Test: `tests/write-service.test.ts` (append), plus the two new fixtures.

**Interfaces:**
- Consumes: `editSetCells` (Task 7 — already built and tested), `softDelete` (Task 4).
- Produces:
  - `WriteService.updateWorkoutSets(id: string, edits: { groupIndex: number; setIndex: number; reps?: number; weight?: number; rpe?: number }[]): Promise<{ id: string }>` — `editSetCells` on the `log` entity; changes = [{collection:"log", entity}].
  - `WriteService.deleteMeasurement(id: string): Promise<{ id: string; deleted: true }>` — `softDelete` (flat) the `measuredValue` entity; changes = [{collection:"measuredValue", entity}].
  - Tools `strong_update_workout` (`{ id, edits: [{ groupIndex, setIndex, reps?, weight?, rpe? }] }`) and `strong_delete_measurement` (`{ id }`).

- [ ] **Step 1: Confirm both fixtures exist and match assumptions**

Run: `ls tests/fixtures/workout-update.json tests/fixtures/measured-value-delete.json`
Verify by reading each: workout-update is a full `_embedded.log[0]` re-send with edited cell values and a bumped `lastChanged` (per §6.5 assumption); measured-value-delete is a flat `_embedded.measuredValue[0]` with `isHidden:true` (per §6.4 assumption). **If either differs, STOP and reconcile the code below with the capture before proceeding.**

- [ ] **Step 2: Write the failing tests (append to `tests/write-service.test.ts`)**

```typescript
describe("GATED: updateWorkoutSets + deleteMeasurement", () => {
  it("updateWorkoutSets edits a set in a logged workout, preserving untouched cells", async () => {
    const { service, snapshot, put } = makeService();
    snapshot.entities.log["w1"] = {
      id: "w1", logType: "WORKOUT", isHidden: false,
      _embedded: { cellSetGroup: [{ id: "g1", cellSets: [
        { id: "s1", cells: [
          { id: "c1", cellType: "BARBELL_WEIGHT", value: "13.6077711", isHidden: false },
          { id: "c2", cellType: "REPS", value: "12", isHidden: false },
        ] },
      ] }] },
    };
    const res = await service.updateWorkoutSets("w1", [{ groupIndex: 0, setIndex: 0, reps: 8 }]);
    expect(res.id).toBe("w1");
    const cells = put.mock.calls[0][0]._embedded.log[0]._embedded.cellSetGroup[0].cellSets[0].cells;
    expect(cells[1].value).toBe("8");
    expect(cells[0].value).toBe("13.6077711"); // untouched weight preserved verbatim
  });

  it("deleteMeasurement flips isHidden on the measuredValue", async () => {
    const { service, snapshot, put } = makeService();
    snapshot.entities.measuredValue["v1"] = { id: "v1", isHidden: false, measurementTypeValue: "WEIGHT", value: 90.7 };
    const res = await service.deleteMeasurement("v1");
    expect(res.deleted).toBe(true);
    expect(put.mock.calls[0][0]._embedded.measuredValue[0].isHidden).toBe(true);
  });
});
```

- [ ] **Step 3: Run to verify it fails**

Run: `npx vitest run tests/write-service.test.ts`
Expected: FAIL — `updateWorkoutSets`/`deleteMeasurement` are not functions.

- [ ] **Step 4: Add the two methods to `WriteService`**

```typescript
  updateWorkoutSets(id: string, edits: { groupIndex: number; setIndex: number; reps?: number; weight?: number; rpe?: number }[]) {
    return this.opts.engine.write((snapshot) => {
      const log = requireVisible(snapshot, "log", id);
      return { changes: [{ collection: "log", entity: editSetCells(log, edits, this.deps) }], summary: { id } };
    });
  }

  deleteMeasurement(id: string) {
    return this.opts.engine.write((snapshot) => {
      const v = snapshot.entities.measuredValue[id];
      if (!v || v.isHidden === true) throw new Error(`No measuredValue with id "${id}" in the current snapshot`);
      return { changes: [{ collection: "measuredValue", entity: softDelete(v, this.opts.clock) }], summary: { id, deleted: true as const } };
    });
  }
```

Add `editSetCells` to the existing import from `../write/edit.js`.

- [ ] **Step 5: Add the two tools to `registerWriteTools`**

```typescript
  server.registerTool("strong_update_workout",
    { description: "Edit sets in a logged workout by id. Each edit targets a working set: {groupIndex, setIndex, reps?, weight?, rpe?}.",
      inputSchema: { id: z.string(), edits: z.array(z.object({
        groupIndex: z.number().int().nonnegative(), setIndex: z.number().int().nonnegative(),
        reps: z.number().int().positive().optional(), weight: z.number().nonnegative().optional(), rpe: z.number().optional(),
      })).min(1) } },
    async (a: any) => text(await service.updateWorkoutSets(a.id, a.edits)));

  server.registerTool("strong_delete_measurement",
    { description: "Soft-delete a body measurement by id.", inputSchema: { id: z.string() } },
    async (a: any) => text(await service.deleteMeasurement(a.id)));
```

Update `tests/write-tools.test.ts`'s "registers all …" assertion to expect **11** tools (add `strong_update_workout`, `strong_delete_measurement`), and add a `updateWorkoutSets`/`deleteMeasurement` stub to that test's `service` mock.

- [ ] **Step 6: Run full suite + typecheck + build**

Run: `npm test && npm run typecheck && npm run build`
Expected: all PASS; the golden fixtures from Step 1 confirm the builders reproduce the captured PUT bodies (modulo generated ids/timestamps).

- [ ] **Step 7: Commit**

```bash
git add src/services/write-service.ts src/tools/write-tools.ts tests/write-service.test.ts tests/write-tools.test.ts tests/fixtures/workout-update.json tests/fixtures/measured-value-delete.json
git commit -m "feat: workout update + measurement delete (previously-gated, now captured)"
```

---

## Manual smoke test (after Task 10; Task 11 after capture)

With real seeded tokens in `.env` and Proxyman running (`STRONG_PROXY_URL=http://localhost:9090`):

```bash
npm run build && node dist/index.js
```

Via an MCP client: `strong_sync` → `strong_list_exercises` (grab an exercise id) → `strong_log_workout` with that id and one set. Then open the Strong app and confirm the workout appears. Watch the PUT in Proxyman and compare against the captured reference. Repeat for `strong_create_template` and `strong_log_measurement`. **Use the throwaway test account, not your primary one** — deletes are soft (they accumulate hidden entities; spec §9).

---

## Self-Review notes (spec coverage)

- Write envelope + routing (§6.2) → Task 3.
- Serialized write flow, apply-on-success, no-mutate-on-failure (§6.2, §8.1 idempotency) → Task 9.
- cellTypeConfigs-driven workout building, alternating rest timers, rest source, exercise-by-id + not-found (§6.3, §4.4) → Task 5.
- Generic soft-delete cascade/flat (§6.4) → Task 4; template folder-unlink (§6.6) → Tasks 8+10.
- Byte-for-byte edit preservation (§6.5) → Task 7.
- Folder membership on create/delete (§6.6) → Tasks 8+10.
- Unit conversion display→kg + refuse-on-write unknown types (§4.5) → Tasks 5,6 (reuse Phase 1 `units.ts`).
- Status-code success, no 5xx retry on writes (§3.1, §6.2, §8) → Task 2.
- Tool surface writes (§7) → Task 10 (captured) + Task 11 (gated).
- Golden fixtures for the two inferred shapes (§9, §2) → Task 11 prerequisite.
- **Deferred / out of scope for Phase 2:** `strong_update_template` is name-only (full structural template editing — re-sequencing exercises/sets — is not in the captured scope and is not built; note for a possible Phase 3). `strong_update_exercise` is name-only for the same reason. The sync-engine repeating-cursor guard and other Phase-1 deferred Minors (see `.superpowers/sdd/progress.md`) are not Phase-2 scope.
