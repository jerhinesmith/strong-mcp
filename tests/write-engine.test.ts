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
