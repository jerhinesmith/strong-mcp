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
