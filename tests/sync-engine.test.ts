import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { SnapshotStore } from "../src/sync/snapshot-store.js";
import { SyncEngine } from "../src/sync/sync-engine.js";

const store = () => new SnapshotStore(mkdtempSync(join(tmpdir(), "strong-se-")), "u");

const page = (logs: any[], nextCursor: string | null) => ({
  _links: nextCursor
    ? { next: { href: `/api/users/u/?continuation=${nextCursor}&limit=300` } }
    : {},
  _embedded: {
    template: [],
    log: logs,
    measurement: [],
    measuredValue: [],
    tag: [],
    metric: [],
    folder: [],
    widget: [],
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
    // Verified live: omitting `continuation` entirely (even on page 1) makes
    // Strong return a flat, silently-truncated doc with NO `_links.next` at
    // all — so a fresh/full sync must still send an EMPTY continuation to
    // get real pagination, or everything past `limit` per collection is lost.
    expect(getJson.mock.calls[0][0]).toContain("continuation=");
    // Strong's API rejects anything above 200 ("Limit must be between 1 and 200.")
    expect(getJson.mock.calls[0][0]).toContain("limit=200");
  });

  it("stops when a page has no next link", async () => {
    const getJson = vi.fn().mockResolvedValueOnce(page([{ id: "a" }], null));
    const s = store();
    const engine = new SyncEngine({ http: { getJson }, store: s, userId: "u" });
    const { pages } = await engine.sync();
    expect(pages).toBe(1);
  });

  it("resync ignores the stored cursor and walks from scratch", async () => {
    const s = store();
    const seed = s.empty();
    seed.continuation = "STALE";
    seed.entities.log.old = { id: "old", isHidden: false }; // stale local entity
    await s.save(seed);

    const getJson = vi
      .fn()
      .mockResolvedValueOnce(page([{ id: "fresh" }], "C1"))
      .mockResolvedValueOnce(page([], "C2")); // empty → stop
    const engine = new SyncEngine({ http: { getJson }, store: s, userId: "u" });
    const { snapshot } = await engine.resync();
    // page 1 must carry an EMPTY continuation (to get real pagination), not the stale cursor
    expect(getJson.mock.calls[0][0]).not.toContain("continuation=STALE");
    expect(getJson.mock.calls[0][0]).toContain("continuation=");
    // pristine server truth only — the stale local entity is gone
    expect(Object.keys(snapshot.entities.log)).toEqual(["fresh"]);
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
    expect(snapshot.entities.log.a).toBeDefined();
    // first call used the stale cursor; second (fallback) sends an empty one instead
    expect(getJson.mock.calls[0][0]).toContain("continuation=STALE");
    expect(getJson.mock.calls[1][0]).not.toContain("continuation=STALE");
    expect(getJson.mock.calls[1][0]).toContain("continuation=");
  });
});
