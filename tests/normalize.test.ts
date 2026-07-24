import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { applyPage, isEmptyPage, nextCursor } from "../src/sync/normalize.js";
import { SnapshotStore } from "../src/sync/snapshot-store.js";

const load = (f: string) => JSON.parse(readFileSync(join(__dirname, "fixtures", f), "utf8"));

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
