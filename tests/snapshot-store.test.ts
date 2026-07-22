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
