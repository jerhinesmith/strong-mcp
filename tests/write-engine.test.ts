import { describe, expect, it, vi } from "vitest";
import type { Snapshot } from "../src/types.js";
import { WriteEngine } from "../src/write/write-engine.js";

function snap(): Snapshot {
  return {
    userId: "u",
    continuation: null,
    syncedAt: null,
    preferences: {},
    entities: {
      template: {},
      log: {},
      measurement: {},
      measuredValue: {},
      folder: {},
      tag: {},
      metric: {},
      widget: {},
    },
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
    const summary = await engine.write((_s) => {
      expect(d.refresh).toHaveBeenCalled(); // refresh ran before build
      return {
        changes: [{ collection: "log", entity: { id: "w1", logType: "WORKOUT" } }],
        summary: { id: "w1" },
      };
    });
    expect(summary).toEqual({ id: "w1" });
    expect(d.put).toHaveBeenCalledTimes(1);
    const envelope = d.put.mock.calls[0][0];
    expect(envelope._embedded.log[0].id).toBe("w1");
    expect(d.snapshot.entities.log.w1).toEqual({ id: "w1", logType: "WORKOUT" }); // applied
    expect(d.persist).toHaveBeenCalledWith(d.snapshot);
  });

  it("does NOT mutate the snapshot or persist when the PUT fails", async () => {
    const d = deps({
      put: vi.fn(async () => {
        throw new Error("PUT /api/users/u → HTTP 500");
      }),
    });
    const engine = new WriteEngine(d);
    await expect(
      engine.write(() => ({ changes: [{ collection: "log", entity: { id: "w1" } }], summary: 1 })),
    ).rejects.toThrow(/HTTP 500/);
    expect(d.snapshot.entities.log.w1).toBeUndefined();
    expect(d.persist).not.toHaveBeenCalled();
  });

  it("serializes writes: B's build does not run until A fully settles", async () => {
    const order: string[] = [];
    let releaseA!: () => void;
    const gateA = new Promise<void>((r) => {
      releaseA = r;
    });
    let putCall = 0;
    const d = deps({
      put: vi.fn(async () => {
        const n = ++putCall;
        order.push(`put-${n}-start`);
        if (n === 1) await gateA; // A's put blocks until released
        order.push(`put-${n}-end`);
      }),
    });
    const engine = new WriteEngine(d);
    const a = engine.write(() => {
      order.push("build-a");
      return { changes: [], summary: "a" };
    });
    const b = engine.write(() => {
      order.push("build-b");
      return { changes: [], summary: "b" };
    });

    // Let microtasks flush; A should be parked in put, B must NOT have built yet.
    await new Promise((r) => setTimeout(r, 10));
    expect(order).toEqual(["build-a", "put-1-start"]);

    releaseA();
    await Promise.all([a, b]);
    expect(order).toEqual([
      "build-a",
      "put-1-start",
      "put-1-end",
      "build-b",
      "put-2-start",
      "put-2-end",
    ]);
  });

  it("a failed write rejects its caller but does not block the next write", async () => {
    let putCall = 0;
    const d = deps({
      put: vi.fn(async () => {
        if (++putCall === 1) throw new Error("PUT /api/users/u → HTTP 500");
      }),
    });
    const engine = new WriteEngine(d);
    const a = engine.write(() => ({ changes: [], summary: "a" }));
    const bBuilt = vi.fn();
    const b = engine.write(() => {
      bBuilt();
      return { changes: [], summary: "b" };
    });

    await expect(a).rejects.toThrow(/HTTP 500/); // A's caller gets the real error
    await expect(b).resolves.toBe("b"); // B still ran despite A failing
    expect(bBuilt).toHaveBeenCalled();
  });
});
